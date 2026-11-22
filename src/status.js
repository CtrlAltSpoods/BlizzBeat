// Live status: the bot's "Listening to ..." activity and the voice channel status line.
import { ActivityType, ChannelType } from 'discord.js';
import { client, lavalink } from './client.js';
import { getSettings } from './db.js';
import { log } from './logger.js';
import { truncate } from './util/format.js';

/** Discord's "Set Voice Channel Status" permission bit. */
export const SET_VOICE_STATUS = 1n << 48n;

/* ------------------------------ Presence ------------------------------ */

let presenceTimer = null;

/** Debounced: shows the current song when one server is playing, a count when several are. */
export function updatePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    if (!client.isReady()) return;
    const playing = [...lavalink.players.values()].filter((p) => p.queue.current && !p.paused);
    let name;
    if (playing.length === 1) {
      const info = playing[0].queue.current.info;
      name = truncate(`${info.title} · ${info.author}`, 120);
    } else if (playing.length > 1) {
      name = `music in ${playing.length} servers`;
    } else {
      name = '/play · type a song in #blizzbeat';
    }
    try {
      client.user.setPresence({ activities: [{ name, type: ActivityType.Listening }], status: 'online' });
    } catch (err) {
      log.debug('Presence update failed', err?.message ?? err);
    }
  }, 3000);
}

/* ------------------------- Voice channel status ------------------------- */

const lastStatus = new Map(); // voiceChannelId -> status text

function canSetStatus(guildId, channelId) {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(channelId);
  const me = guild?.members.me;
  return Boolean(channel && me && channel.permissionsFor(me)?.has(SET_VOICE_STATUS));
}

async function putStatus(channelId, status) {
  await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status } });
}

/** Sets the voice channel's status line to the current song (if enabled for the server). */
export async function setVoiceStatus(player) {
  const channelId = player?.voiceChannelId;
  const track = player?.queue.current;
  if (!channelId || !track) return;
  if (!getSettings(player.guildId).voiceStatus || !canSetStatus(player.guildId, channelId)) return;
  if (client.channels.cache.get(channelId)?.type === ChannelType.GuildStageVoice) return; // Stages use the topic instead
  const status = truncate(`🎵 ${track.info.title} · ${track.info.author}`, 500);
  if (lastStatus.get(channelId) === status) return;
  try {
    await putStatus(channelId, status);
    lastStatus.set(channelId, status);
  } catch (err) {
    log.debug(`Could not set voice status in ${channelId}:`, err?.message ?? err);
  }
}

/** Clears the status line Blizzbeat set. Safe to call any time. */
export async function clearVoiceStatus(guildId, channelId) {
  if (!channelId || !lastStatus.has(channelId)) return;
  lastStatus.delete(channelId);
  if (!canSetStatus(guildId, channelId)) return;
  try {
    await putStatus(channelId, null);
  } catch (err) {
    log.debug(`Could not clear voice status in ${channelId}:`, err?.message ?? err);
  }
}
