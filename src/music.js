// Song requests, playback controls, permission checks and idle handling.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { client, lavalink, toRequester } from './client.js';
import { config } from './config.js';
import { getSettings, updateSettings } from './db.js';
import { log } from './logger.js';
import { clearVoiceStatus } from './status.js';
import { escapeMd, formatDuration, isUrl, trackDuration, truncate } from './util/format.js';

/** An error whose message is safe and friendly to show to the user. */
export class UserError extends Error {}

export const SEARCH_SOURCES = {
  ytmsearch: 'YouTube Music',
  ytsearch: 'YouTube',
  scsearch: 'SoundCloud',
  spsearch: 'Spotify',
};

const SPOTIFY_LINK = /^https?:\/\/(open\.spotify\.com|spotify\.link|play\.spotify\.com)\//i;

export function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

export function humansIn(channel) {
  if (!channel?.members) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

/* ------------------------------ Cooldowns ------------------------------ */

const cooldowns = new Map(); // `${guildId}:${userId}:${kind}` -> timestamp of last use

/** Throws if the member used `kind` ('request' | 'control') too recently. Admins are exempt. */
export function checkCooldown(member, kind) {
  if (isAdmin(member)) return;
  const settings = getSettings(member.guild.id);
  const seconds = kind === 'request' ? settings.requestCooldown : settings.controlCooldown;
  if (!seconds) return;
  const last = cooldowns.get(`${member.guild.id}:${member.id}:${kind}`) ?? 0;
  const left = Math.ceil((last + seconds * 1000 - Date.now()) / 1000);
  if (left > 0) {
    const what = kind === 'request' ? 'request another song' : 'use the controls again';
    throw new UserError(`Slow down! You can ${what} in ${left}s.`);
  }
}

export function touchCooldown(member, kind) {
  if (isAdmin(member)) return;
  cooldowns.set(`${member.guild.id}:${member.id}:${kind}`, Date.now());
  if (cooldowns.size > 5000) {
    const cutoff = Date.now() - 600_000;
    for (const [key, ts] of cooldowns) if (ts < cutoff) cooldowns.delete(key);
  }
}

/** Leaves voice, clearing the voice channel status first. */
export async function destroyPlayer(player, reason) {
  await clearVoiceStatus(player.guildId, player.voiceChannelId).catch(() => null);
  await player.destroy(reason);
}

function playerChannel(player) {
  return player ? client.guilds.cache.get(player.guildId)?.channels.cache.get(player.voiceChannelId) : null;
}

/** DJ check: admins, DJ-role holders, or whoever is alone with the bot. No DJ role set = everyone. */
export function hasDjPower(member, player) {
  const settings = getSettings(member.guild.id);
  if (isAdmin(member) || !settings.djRoleId) return true;
  if (member.roles.cache.has(settings.djRoleId)) return true;
  const vc = playerChannel(player);
  return Boolean(vc?.members.has(member.id) && humansIn(vc) === 1);
}

/**
 * Returns the guild's player if `member` may run `action` on it, otherwise throws a UserError.
 * Actions: pause, skip, stop, previous, shuffle, loop, volume, seek, remove, move, clear, leave.
 */
export function assertCanControl(member, action) {
  const settings = getSettings(member.guild.id);
  const player = lavalink.getPlayer(member.guild.id);
  if (!player) throw new UserError("I'm not playing anything right now.");
  if (settings.blockedUsers.includes(member.id)) throw new UserError("You're blocked from using Blizzbeat on this server.");
  if (!isAdmin(member) && member.voice?.channelId !== player.voiceChannelId) {
    throw new UserError(`Join <#${player.voiceChannelId}> to control the music.`);
  }
  const allowed =
    hasDjPower(member, player) ||
    (action === 'skip' && player.queue.current?.requester?.id === member.id) ||
    action === 'remove'; // own-song check happens in removeTrack
  if (!allowed) throw new UserError(`You need the <@&${settings.djRoleId}> role to do that.`);
  checkCooldown(member, 'control');
  touchCooldown(member, 'control');
  return player;
}

function trackLink(track) {
  const title = escapeMd(truncate(track.info.title, 80));
  return isUrl(track.info.uri) ? `[${title}](<${track.info.uri}>)` : title;
}

/** Finds or creates the player for a member's voice channel, enforcing server rules. */
async function playerFor(guild, member, textChannelId) {
  const settings = getSettings(guild.id);
  const vc = member.voice?.channel;
  if (!vc) throw new UserError('Join a voice channel first, then ask again.');
  if (!lavalink.useable) {
    throw new UserError("The music engine (Lavalink) isn't connected yet. If this lasts more than a couple of minutes, check the container logs.");
  }

  let player = lavalink.getPlayer(guild.id);
  if (player && player.voiceChannelId && player.voiceChannelId !== vc.id) {
    const current = playerChannel(player);
    const busy = player.queue.current || player.queue.tracks.length || humansIn(current) > 0;
    if (busy || settings.stay247) throw new UserError(`I'm already playing in <#${player.voiceChannelId}>. Join me there!`);
    await destroyPlayer(player, 'MovingChannels');
    player = null;
  }

  if (!player) {
    if (settings.allowedVoiceChannels.length && !settings.allowedVoiceChannels.includes(vc.id)) {
      const list = settings.allowedVoiceChannels.map((id) => `<#${id}>`).join(', ');
      throw new UserError(`I'm only allowed to join: ${list}`);
    }
    const perms = vc.permissionsFor(guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new UserError(`I need permission to join and speak in <#${vc.id}>.`);
    }
    if (vc.full && !perms.has(PermissionFlagsBits.MoveMembers)) throw new UserError(`<#${vc.id}> is full.`);

    player = lavalink.createPlayer({
      guildId: guild.id,
      voiceChannelId: vc.id,
      textChannelId: settings.channelId ?? textChannelId,
      selfDeaf: true,
      volume: Math.min(settings.defaultVolume, settings.maxVolume),
    });
  }

  if (!player.connected) {
    await player.connect();
    if (vc.type === ChannelType.GuildStageVoice) {
      await guild.members.me.voice.setSuppressed(false).catch(() => null);
    }
  }
  return player;
}

/**
 * Handles a song request from /play or from typing in the Blizzbeat channel.
 * Returns a short, user-facing summary.
 */
export async function requestSongs({ guild, member, query, next = false, textChannelId }) {
  const settings = getSettings(guild.id);
  const text = String(query ?? '').trim();
  if (!text) throw new UserError('Tell me what to play: a song name or a link.');
  if (settings.blockedUsers.includes(member.id)) throw new UserError("You're blocked from requesting songs on this server.");
  if (settings.requestRoleId && !isAdmin(member) && !member.roles.cache.has(settings.requestRoleId)) {
    throw new UserError(`Only members with <@&${settings.requestRoleId}> can request songs.`);
  }
  checkCooldown(member, 'request');

  const link = isUrl(text);
  if (link && SPOTIFY_LINK.test(text) && !config.spotifyEnabled) {
    throw new UserError("Spotify links aren't enabled on this Blizzbeat yet (the bot owner needs to add Spotify credentials).");
  }

  const player = await playerFor(guild, member, textChannelId);
  const requester = toRequester(member);

  let source = settings.searchSource;
  if (source === 'spsearch' && !config.spotifyEnabled) source = 'ytmsearch';

  let res;
  try {
    res = await player.search(link ? { query: text } : { query: text, source }, requester);
  } catch (err) {
    log.warn('Search failed', err);
    throw new UserError(`I couldn't search for that: ${truncate(err?.message ?? 'unknown error', 150)}`);
  }

  // If a non-default search source fails (e.g. SoundCloud is down), try YouTube Music instead.
  if (!link && source !== 'ytmsearch' && (res.loadType === 'error' || res.loadType === 'empty' || !res.tracks?.length)) {
    log.info(`[${guild.id}] ${source} search failed (${res.exception?.message ?? res.loadType}), falling back to ytmsearch`);
    res = await player.search({ query: text, source: 'ytmsearch' }, requester).catch(() => res);
  }

  if (res.loadType === 'error') {
    throw new UserError(`I couldn't load that: ${truncate(res.exception?.message ?? 'unknown error', 150)}`);
  }
  if (res.loadType === 'empty' || !res.tracks?.length) {
    throw new UserError(`No results for **${escapeMd(truncate(text, 80))}**.`);
  }

  const isPlaylist = res.loadType === 'playlist';
  if (isPlaylist && !settings.allowPlaylists) throw new UserError('Playlists are turned off on this server.');
  let tracks = isPlaylist ? [...res.tracks] : [res.tracks[0]];

  let tooLong = 0;
  if (settings.maxSongMinutes > 0) {
    const max = settings.maxSongMinutes * 60_000;
    const before = tracks.length;
    tracks = tracks.filter((t) => !t.info.isStream && t.info.duration <= max);
    tooLong = before - tracks.length;
    if (!tracks.length) {
      throw new UserError(`That's longer than this server's ${settings.maxSongMinutes}-minute song limit.`);
    }
  }

  const queueSpace = settings.maxQueue - player.queue.tracks.length;
  if (queueSpace <= 0) throw new UserError(`The queue is full (${settings.maxQueue} songs).`);

  let userSpace = Infinity;
  if (settings.maxPerUser > 0 && !isAdmin(member)) {
    const mine = player.queue.tracks.filter((t) => t.requester?.id === member.id).length;
    userSpace = settings.maxPerUser - mine;
    if (userSpace <= 0) throw new UserError(`You already have ${settings.maxPerUser} songs queued. Let some play first!`);
  }

  const allowed = Math.min(queueSpace, userSpace);
  const dropped = Math.max(0, tracks.length - allowed);
  tracks = tracks.slice(0, allowed);

  const startNow = !player.queue.current;
  await player.queue.add(tracks, next && !startNow ? 0 : undefined);
  if (startNow) await player.play({ paused: false });
  touchCooldown(member, 'request');
  evaluateIdle(guild.id);

  const notes = [];
  if (tooLong) notes.push(`${tooLong} skipped for being too long`);
  if (dropped) notes.push(`${dropped} skipped because of queue limits`);
  const noteText = notes.length ? `\n-# ${notes.join(' · ')}` : '';

  if (isPlaylist) {
    const total = tracks.reduce((sum, t) => sum + (t.info.isStream ? 0 : t.info.duration), 0);
    const name = escapeMd(truncate(res.playlist?.name ?? 'playlist', 80));
    return `📃 Added **${tracks.length}** songs from **${name}** (${formatDuration(total)})${noteText}`;
  }
  const track = tracks[0];
  if (startNow) return `▶️ Now playing ${trackLink(track)} \`${trackDuration(track)}\``;
  const position = next ? 1 : player.queue.tracks.length;
  return `🎶 Queued ${trackLink(track)} \`${trackDuration(track)}\` at **#${position}**${noteText}`;
}

/* ----------------------------- Controls ----------------------------- */

export async function togglePause(player) {
  if (!player.queue.current) throw new UserError('Nothing is playing.');
  if (player.paused) {
    await player.resume();
    return '▶️ Resumed.';
  }
  await player.pause();
  return '⏸️ Paused.';
}

export async function pause(player) {
  if (!player.queue.current) throw new UserError('Nothing is playing.');
  if (player.paused) return '⏸️ Already paused.';
  await player.pause();
  return '⏸️ Paused.';
}

export async function resume(player) {
  if (!player.queue.current) throw new UserError('Nothing is playing.');
  if (!player.paused) return '▶️ Already playing.';
  await player.resume();
  return '▶️ Resumed.';
}

export async function skip(player, count = 1) {
  const current = player.queue.current;
  if (!current) throw new UserError('Nothing is playing.');
  if (!player.queue.tracks.length) {
    const autoplay = getSettings(player.guildId).autoplay;
    if (player.repeatMode === 'queue' || autoplay) {
      // Ends the song normally so loop-queue / autoplay can pick what's next.
      await player.skip(0, false);
      return `⏭️ Skipped ${trackLink(current)}.`;
    }
    await player.stopPlaying(true, false);
    return `⏭️ Skipped ${trackLink(current)}. That was the last song.`;
  }
  const n = Math.min(Math.max(1, count), player.queue.tracks.length);
  await player.skip(n > 1 ? n : 0);
  return n > 1 ? `⏭️ Skipped ${n} songs.` : `⏭️ Skipped ${trackLink(current)}.`;
}

export async function stop(player) {
  await player.setRepeatMode('off');
  await player.stopPlaying(true, false);
  evaluateIdle(player.guildId);
  return '⏹️ Stopped and cleared the queue.';
}

export async function previous(player) {
  const prev = await player.queue.shiftPrevious();
  if (!prev) throw new UserError('There is no previous song.');
  if (player.queue.current) await player.queue.add(player.queue.current, 0);
  await player.play({ clientTrack: prev, paused: false });
  return `⏮️ Back to ${trackLink(prev)}.`;
}

export async function shuffle(player) {
  if (player.queue.tracks.length < 2) throw new UserError('Need at least 2 songs in the queue to shuffle.');
  await player.queue.shuffle();
  return `🔀 Shuffled ${player.queue.tracks.length} songs.`;
}

const LOOP_ORDER = ['off', 'track', 'queue'];
export const LOOP_LABEL = { off: 'Off', track: 'Song', queue: 'Queue' };

export async function setLoop(player, mode) {
  const next = mode ?? LOOP_ORDER[(LOOP_ORDER.indexOf(player.repeatMode) + 1) % LOOP_ORDER.length];
  await player.setRepeatMode(next);
  return next === 'off' ? '➡️ Loop is off.' : next === 'track' ? '🔂 Looping this song.' : '🔁 Looping the queue.';
}

/**
 * True when Lavalink can send the source's Opus audio to Discord untouched (no decode / re-encode):
 * volume exactly 100% and no effect. Any other volume or effect means re-encoding.
 */
export function isOriginalQuality(player) {
  return player?.volume === 100 && currentEffect(player) === 'off';
}

const QUALITY_TIP = '\n-# Tip: at **100%** Blizzbeat sends the original audio with no re-encoding. To change loudness without losing quality, use Discord\'s own slider (right-click Blizzbeat → User Volume).';

export async function setVolume(player, volume) {
  const settings = getSettings(player.guildId);
  const v = Math.round(Math.min(Math.max(volume, 0), settings.maxVolume));
  await player.setVolume(v);
  return `${v === 0 ? '🔇' : v < 50 ? '🔉' : '🔊'} Volume set to **${v}%**.${v === 100 ? ' 🎧 Original quality.' : QUALITY_TIP}`;
}

export async function seek(player, ms) {
  const track = player.queue.current;
  if (!track) throw new UserError('Nothing is playing.');
  if (!track.info.isSeekable || track.info.isStream) throw new UserError("This song can't be seeked.");
  const target = Math.min(Math.max(ms, 0), track.info.duration - 1000);
  await player.seek(target);
  return `⏩ Jumped to \`${formatDuration(target)}\`.`;
}

export async function removeTrack(player, member, position) {
  const index = position - 1;
  const track = player.queue.tracks[index];
  if (!track) throw new UserError(`There's no song at position ${position}.`);
  if (!hasDjPower(member, player) && track.requester?.id !== member.id) {
    throw new UserError('You can only remove songs you requested.');
  }
  await player.queue.splice(index, 1);
  return `🗑️ Removed ${trackLink(track)} from the queue.`;
}

export async function moveTrack(player, from, to) {
  const tracks = player.queue.tracks;
  if (from < 1 || from > tracks.length) throw new UserError(`There's no song at position ${from}.`);
  const target = Math.min(Math.max(to, 1), tracks.length);
  const removed = await player.queue.splice(from - 1, 1);
  const track = Array.isArray(removed) ? removed[0] : removed;
  if (!track) throw new UserError('Could not move that song.');
  await player.queue.add(track, target - 1);
  return `↕️ Moved ${trackLink(track)} to **#${target}**.`;
}

export async function clearQueue(player) {
  const n = player.queue.tracks.length;
  if (!n) throw new UserError('The queue is already empty.');
  await player.queue.splice(0, n);
  return `🧹 Cleared ${n} songs from the queue.`;
}

export async function leave(player) {
  await destroyPlayer(player, 'LeaveCommand');
  return '👋 Left the voice channel.';
}

/* --------------------------- Idle handling --------------------------- */

const leaveTimers = new Map();

function clearLeaveTimer(guildId) {
  const t = leaveTimers.get(guildId);
  if (t) clearTimeout(t);
  leaveTimers.delete(guildId);
}

/** Starts or cancels the auto-leave timer depending on whether anyone is listening / anything is queued. */
export function evaluateIdle(guildId) {
  const player = lavalink.getPlayer(guildId);
  const settings = getSettings(guildId);
  if (!player || settings.stay247) return clearLeaveTimer(guildId);

  const vc = playerChannel(player);
  const nobodyListening = humansIn(vc) === 0;
  const nothingQueued = !player.queue.current && player.queue.tracks.length === 0;
  if (!nobodyListening && !nothingQueued) return clearLeaveTimer(guildId);
  if (leaveTimers.has(guildId)) return;

  const minutes = settings.autoLeaveMinutes;
  const ms = nobodyListening ? Math.max(minutes * 60_000, 15_000) : minutes * 60_000;
  leaveTimers.set(
    guildId,
    setTimeout(async () => {
      leaveTimers.delete(guildId);
      const p = lavalink.getPlayer(guildId);
      if (!p) return;
      log.info(`Auto-leaving voice in guild ${guildId} (${nobodyListening ? 'empty channel' : 'queue finished'})`);
      await destroyPlayer(p, 'AutoLeave').catch((err) => log.warn('Auto-leave failed', err));
    }, ms),
  );
}

export function forgetGuild(guildId) {
  clearLeaveTimer(guildId);
}

/* ------------------------------ Vote-skip ------------------------------ */

const votes = new Map(); // guildId -> { key, voters: Set<userId> }

function trackKey(track) {
  return track ? track.encoded ?? `${track.info.identifier}:${track.info.title}` : null;
}

export function clearVotes(guildId) {
  votes.delete(guildId);
}

/** Current vote state for the playing song, or null when there are no votes. */
export function voteStatus(player) {
  const entry = votes.get(player.guildId);
  if (!entry || entry.key !== trackKey(player.queue.current)) return null;
  const vc = playerChannel(player);
  const listeners = humansIn(vc);
  const pct = getSettings(player.guildId).voteSkipPercent;
  const needed = Math.max(1, Math.ceil((listeners * pct) / 100));
  const count = [...entry.voters].filter((id) => vc?.members.has(id)).length;
  return { count, needed };
}

/**
 * Skips straight away for admins, DJs, the song's requester, or someone alone with the bot.
 * With vote-skip on, anyone else adds a vote and the song is skipped once enough listeners agree.
 * Returns { message, voted } where `voted` is true when only a vote was recorded.
 */
export async function skipOrVote(member, count = 1) {
  const settings = getSettings(member.guild.id);
  const player = lavalink.getPlayer(member.guild.id);
  if (!player?.queue.current) throw new UserError('Nothing is playing.');
  if (settings.blockedUsers.includes(member.id)) throw new UserError("You're blocked from using Blizzbeat on this server.");
  if (!isAdmin(member) && member.voice?.channelId !== player.voiceChannelId) {
    throw new UserError(`Join <#${player.voiceChannelId}> to skip.`);
  }

  const vc = playerChannel(player);
  const hasRole = Boolean(settings.djRoleId && member.roles.cache.has(settings.djRoleId));
  const alone = Boolean(vc?.members.has(member.id) && humansIn(vc) === 1);
  const isRequester = player.queue.current.requester?.id === member.id;
  const openControls = !settings.voteSkip && !settings.djRoleId;
  const direct = isAdmin(member) || hasRole || alone || isRequester || openControls;

  checkCooldown(member, 'control');
  touchCooldown(member, 'control');

  if (direct) return { message: await skip(player, count), voted: false };
  if (!settings.voteSkip) throw new UserError(`You need the <@&${settings.djRoleId}> role to skip other people's songs.`);

  const key = trackKey(player.queue.current);
  let entry = votes.get(player.guildId);
  if (!entry || entry.key !== key) {
    entry = { key, voters: new Set() };
    votes.set(player.guildId, entry);
  }
  if (entry.voters.has(member.id)) {
    const st = voteStatus(player);
    return { message: `🗳️ You already voted. **${st.count}/${st.needed}** votes to skip.`, voted: true };
  }
  entry.voters.add(member.id);
  const passed = await checkVotes(player.guildId);
  if (passed) return { message: passed, voted: false };
  const st = voteStatus(player);
  return { message: `🗳️ Vote counted: **${st.count}/${st.needed}** to skip.`, voted: true };
}

/** Skips if the vote threshold is met (also called when people leave the channel). */
export async function checkVotes(guildId) {
  const player = lavalink.getPlayer(guildId);
  if (!player?.queue.current) return null;
  const st = voteStatus(player);
  if (!st || st.count < st.needed) return null;
  const title = trackLink(player.queue.current);
  clearVotes(guildId);
  await skip(player);
  return `⏭️ Vote passed (${st.count}/${st.needed}). Skipped ${title}.`;
}

/* ---------------------------- Audio effects ---------------------------- */

export const EFFECTS = {
  off: { label: 'Off', emoji: '🎚️', description: 'Normal sound' },
  bassboost: { label: 'Bass boost', emoji: '💥', description: 'More low end', apply: (fm) => fm.setEQPreset('BassboostMedium') },
  nightcore: { label: 'Nightcore', emoji: '⚡', description: 'Faster and higher', apply: (fm) => fm.toggleNightcore() },
  vaporwave: { label: 'Slowed', emoji: '🌊', description: 'Slower and deeper', apply: (fm) => fm.toggleVaporwave() },
  eightd: { label: '8D', emoji: '🎧', description: 'Sound circles your head', apply: (fm) => fm.toggleRotation(0.2) },
  karaoke: { label: 'Karaoke', emoji: '🎤', description: 'Tries to remove vocals', apply: (fm) => fm.toggleKaraoke() },
  soft: { label: 'Soft', emoji: '🌙', description: 'Muffled, late-night sound', apply: (fm) => fm.toggleLowPass(20) },
  pop: { label: 'Pop EQ', emoji: '✨', description: 'Brighter mids and highs', apply: (fm) => fm.setEQPreset('Pop') },
};

export function currentEffect(player) {
  return player?.getData('blizzbeat_effect') ?? 'off';
}

export async function applyEffect(player, key) {
  const effect = EFFECTS[key];
  if (!effect) throw new UserError('Unknown effect.');
  const fm = player.filterManager;
  try {
    await fm.resetFilters();
    if (fm.equalizerBands?.length) await fm.clearEQ();
    if (effect.apply) await effect.apply(fm);
  } catch (err) {
    log.warn('Applying effect failed:', err?.message ?? err);
    throw new UserError(`Couldn't apply that effect: ${truncate(err?.message ?? 'unknown error', 120)}`);
  }
  player.setData('blizzbeat_effect', key);
  return key === 'off' ? '🎚️ Effects off.' : `${effect.emoji} **${effect.label}** effect on.`;
}

/* ------------------------------- Autoplay ------------------------------- */

export const AUTOPLAY_REQUESTER = { id: null, username: 'Autoplay', displayName: 'Autoplay', avatar: null, autoplay: true };

export function setAutoplay(guildId, enabled) {
  updateSettings(guildId, { autoplay: enabled });
  return enabled
    ? '📻 Autoplay on: when the queue runs out I\'ll keep playing similar songs.'
    : '📻 Autoplay off.';
}

/**
 * YouTube mixes are mostly music videos (intros, skits, outros). Look for the same song on
 * YouTube Music, which returns the official audio upload, and use it if the length matches.
 */
async function officialAudioFor(player, track, usable) {
  if (track.info.sourceName === 'youtubemusic') return null;
  try {
    const res = await player.search(
      { query: `${track.info.title} ${track.info.author}`, source: 'ytmsearch' },
      AUTOPLAY_REQUESTER,
    );
    const target = track.info.duration;
    return (
      (res?.tracks ?? [])
        .slice(0, 5)
        .find((t) => usable(t) && Math.abs(t.info.duration - target) <= Math.max(20_000, target * 0.12)) ?? null
    );
  } catch {
    return null;
  }
}

/** lavalink-client calls this when the queue runs dry. Adds one related song if autoplay is on. */
export async function autoplayNext(player, lastTrack) {
  const settings = getSettings(player.guildId);
  if (!settings.autoplay || !lastTrack?.info) return;
  if (humansIn(playerChannel(player)) === 0) return; // nobody is listening

  const recentIds = new Set(
    [lastTrack, ...player.queue.previous].slice(0, 50).map((t) => t?.info?.identifier).filter(Boolean),
  );
  const recentTitles = new Set(
    [lastTrack, ...player.queue.previous].slice(0, 50).map((t) => t?.info?.title?.toLowerCase()).filter(Boolean),
  );
  const maxMs = settings.maxSongMinutes > 0 ? settings.maxSongMinutes * 60_000 : 12 * 60_000;
  const usable = (t) =>
    !recentIds.has(t.info.identifier) &&
    !recentTitles.has(t.info.title?.toLowerCase()) &&
    !t.info.isStream &&
    t.info.duration >= 60_000 &&
    t.info.duration <= maxMs;

  const attempts = [];
  const { sourceName, identifier, author } = lastTrack.info;
  if ((sourceName === 'youtube' || sourceName === 'youtubemusic') && identifier) {
    // YouTube's own "mix" for this video.
    attempts.push({ query: `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}` });
  }
  if (author) attempts.push({ query: author, source: 'ytmsearch' });
  attempts.push({ query: `${lastTrack.info.title} ${author ?? ''}`.trim(), source: 'ytmsearch' });

  for (const q of attempts) {
    try {
      const res = await player.search(q, AUTOPLAY_REQUESTER);
      const pool = (res?.tracks ?? []).filter(usable).slice(0, 8);
      if (!pool.length) continue;
      let pick = pool[Math.floor(Math.random() * pool.length)];
      pick = (await officialAudioFor(player, pick, usable)) ?? pick;
      await player.queue.add(pick);
      log.info(`[${player.guildId}] autoplay picked: ${pick.info.title}`);
      return;
    } catch (err) {
      log.debug('Autoplay search failed:', err?.message ?? err);
    }
  }
  log.info(`[${player.guildId}] autoplay found nothing new after "${lastTrack.info.title}"`);
}
