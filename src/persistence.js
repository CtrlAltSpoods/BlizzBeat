// Survive restarts: snapshot each player (queue, song, position, settings) to SQLite and restore on boot.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { client, lavalink } from './client.js';
import { config } from './config.js';
import { flash, requestUpdate } from './controller.js';
import { deleteSession, getSettings, loadSessions, saveSession } from './db.js';
import { log } from './logger.js';
import { pruneUploads, uploadNameOf } from './uploads.js';
import { applyEffect, currentEffect, evaluateIdle, humansIn } from './music.js';

let shuttingDown = false;
const timers = new Map();

export function markShuttingDown() {
  shuttingDown = true;
}

function plainTrack(t) {
  if (!t?.info) return null;
  // Not-yet-resolved tracks (yt-dlp links, uploaded files) are kept by their URI and resolved again on restore.
  if (!t.encoded && !t.info.uri) return null;
  return {
    encoded: t.encoded ?? null,
    info: t.info,
    pluginInfo: t.pluginInfo ?? {},
    userData: t.userData ?? {},
    requester: t.requester ?? null,
  };
}

/** Saved track -> something the queue accepts (unresolved tracks are rebuilt from their info). */
function restoredTrack(t) {
  if (t.encoded) return t;
  const info = { ...t.info };
  delete info.resolve;
  return lavalink.utils.buildUnresolvedTrack({ info }, t.requester);
}

/** Uploaded files still referenced by a player or a saved session; everything else in DATA_DIR/uploads can go. */
export function sweepUploads() {
  const inUse = new Set();
  const add = (t) => {
    const name = uploadNameOf(t);
    if (name) inUse.add(name);
  };
  for (const player of lavalink.players.values()) {
    add(player.queue.current);
    player.queue.tracks.forEach(add);
    player.queue.previous.forEach(add);
  }
  for (const { data } of loadSessions()) {
    add(data.current);
    (data.tracks ?? []).forEach(add);
    (data.previous ?? []).forEach(add);
  }
  return pruneUploads(inUse);
}

export function startUploadSweeper() {
  setInterval(() => {
    try {
      sweepUploads();
    } catch (err) {
      log.warn('Upload cleanup failed:', err?.message ?? err);
    }
  }, 10 * 60_000).unref();
}

/** Writes a snapshot of the guild's player right now. */
export function saveNow(guildId) {
  const t = timers.get(guildId);
  if (t) clearTimeout(t);
  timers.delete(guildId);

  const player = lavalink.getPlayer(guildId);
  if (!player?.voiceChannelId) return;
  try {
    const current = plainTrack(player.queue.current);
    saveSession(guildId, {
      voiceChannelId: player.voiceChannelId,
      textChannelId: player.textChannelId ?? null,
      volume: player.volume,
      paused: Boolean(player.paused),
      repeatMode: player.repeatMode ?? 'off',
      effect: currentEffect(player),
      position: current && !current.info.isStream ? Math.max(0, Math.floor(player.position ?? 0)) : 0,
      current,
      tracks: player.queue.tracks.map(plainTrack).filter(Boolean),
      previous: player.queue.previous.slice(0, 10).map(plainTrack).filter(Boolean),
    });
  } catch (err) {
    log.warn(`Could not save session for guild ${guildId}:`, err?.message ?? err);
  }
}

/** Debounced snapshot; call on any change. */
export function scheduleSave(guildId) {
  if (!guildId || shuttingDown || timers.has(guildId)) return;
  timers.set(
    guildId,
    setTimeout(() => saveNow(guildId), 2000),
  );
}

export function saveAll() {
  for (const player of lavalink.players.values()) saveNow(player.guildId);
}

/** Called when a player is destroyed on purpose (leave, auto-leave, kicked). Not during shutdown. */
export function dropSession(guildId) {
  if (shuttingDown) return;
  const t = timers.get(guildId);
  if (t) clearTimeout(t);
  timers.delete(guildId);
  deleteSession(guildId);
}

/** Keeps positions fresh so a crash loses at most a few seconds. */
export function startAutosave() {
  setInterval(() => {
    for (const player of lavalink.players.values()) {
      if (player.queue.current && !player.paused) saveNow(player.guildId);
    }
  }, 15_000).unref();
}

let restored = false;

/** Rejoins voice channels and resumes playback from the saved snapshots. Runs once per boot. */
export async function restoreSessions() {
  if (restored) return;
  restored = true;

  const sessions = loadSessions();
  if (!sessions.length) return;
  log.info(`Restoring ${sessions.length} saved player session(s)...`);
  const maxAge = config.restoreMaxAgeMinutes * 60_000;

  for (const { guildId, updatedAt, data } of sessions) {
    try {
      const guild = client.guilds.cache.get(guildId);
      const vc = guild?.channels.cache.get(data.voiceChannelId);
      const settings = getSettings(guildId);
      const hasMusic = Boolean(data.current || data.tracks?.length);

      if (!guild || !vc) {
        deleteSession(guildId);
        continue;
      }
      if (maxAge && Date.now() - updatedAt > maxAge && !settings.stay247) {
        log.info(`[${guildId}] saved session is too old, skipping.`);
        deleteSession(guildId);
        continue;
      }
      if ((!hasMusic || humansIn(vc) === 0) && !settings.stay247) {
        deleteSession(guildId);
        continue;
      }
      const perms = vc.permissionsFor(guild.members.me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        deleteSession(guildId);
        continue;
      }
      if (lavalink.getPlayer(guildId)) continue;

      const player = lavalink.createPlayer({
        guildId,
        voiceChannelId: vc.id,
        textChannelId: settings.channelId ?? data.textChannelId ?? undefined,
        selfDeaf: vc.type !== ChannelType.GuildStageVoice, // not deafened on a Stage (see music.js)
        volume: Math.min(data.volume ?? settings.defaultVolume, settings.maxVolume),
      });
      await player.connect();

      if (data.tracks?.length) await player.queue.add(data.tracks.map(restoredTrack));
      if (data.previous?.length) player.queue.previous.push(...data.previous.map(restoredTrack));
      if (data.repeatMode && data.repeatMode !== 'off') await player.setRepeatMode(data.repeatMode);

      if (data.current && !data.current.encoded) {
        // The song that was playing hadn't been resolved yet: start it from the top.
        await player.queue.add(restoredTrack(data.current), 0);
        await player.play({ paused: Boolean(data.paused) });
      } else if (data.current) {
        await player.play({
          clientTrack: data.current,
          position: data.position || undefined,
          paused: Boolean(data.paused),
        });
      } else if (player.queue.tracks.length) {
        await player.play({ paused: false });
      }
      if (data.effect && data.effect !== 'off') await applyEffect(player, data.effect).catch(() => null);

      evaluateIdle(guildId);
      requestUpdate(guildId);
      if (hasMusic) flash(guildId, "♻️ I was restarted. Picked up right where we left off.", 8000);
      log.info(`[${guildId}] session restored (${player.queue.tracks.length} queued).`);
    } catch (err) {
      log.warn(`Could not restore session for guild ${guildId}:`, err?.message ?? err);
      deleteSession(guildId);
    }
  }
}
