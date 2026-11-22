// Voice-only access to the Blizzbeat channel (/config voice-access). When on, @everyone can't see the
// channel; everyone in a voice channel (except the AFK channel) gets their own "can see" entry, which is
// removed entirely 30 seconds after they leave voice. Admins always see every channel, so they get no entry.
// Only entries Blizzbeat created are ever removed: an entry someone set by hand is left alone.
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { getSettings, updateSettings } from './db.js';
import { log } from './logger.js';

export const GRACE_MS = 30_000;
const ALLOW = { ViewChannel: true, ReadMessageHistory: true };
const timers = new Map(); // `${guildId}:${userId}` -> timeout

function playerChannel(guild) {
  const id = getSettings(guild.id).channelId;
  return id ? guild.channels.cache.get(id) ?? null : null;
}

const tracked = (guildId) => new Set(getSettings(guildId).voiceAccessUsers ?? []);

function setTracked(guildId, set) {
  updateSettings(guildId, { voiceAccessUsers: [...set] });
}

/** In a real voice channel right now (the AFK channel doesn't count). */
function inVoice(guild, userId) {
  const vs = guild.voiceStates.cache.get(userId);
  return Boolean(vs?.channelId && vs.channelId !== guild.afkChannelId);
}

/** Why Blizzbeat can't manage the channel's permissions, or null if it can. */
export function voiceAccessProblem(guild) {
  const channel = playerChannel(guild);
  if (!channel) return 'There is no Blizzbeat channel yet. Run /setup create first.';
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(PermissionFlagsBits.ManageRoles)) {
    return `I need the **Manage Permissions** permission in ${channel} (or **Manage Roles** on the server) to hide it and let people in.`;
  }
  return null;
}

async function grant(guild, member) {
  if (!member || member.user?.bot || member.permissions?.has(PermissionFlagsBits.Administrator)) return;
  const channel = playerChannel(guild);
  if (!channel) return;
  const mine = tracked(guild.id);
  const existing = channel.permissionOverwrites.cache.get(member.id);
  if (existing && !mine.has(member.id)) return; // set by hand: not ours to change
  if (existing && existing.allow.has(PermissionFlagsBits.ViewChannel)) return;
  await channel.permissionOverwrites.edit(member.id, ALLOW, {
    type: OverwriteType.Member,
    reason: 'Blizzbeat: joined a voice channel',
  });
  const now = tracked(guild.id);
  now.add(member.id);
  setTracked(guild.id, now);
}

async function revoke(guild, userId) {
  timers.delete(`${guild.id}:${userId}`);
  if (!getSettings(guild.id).voiceAccess || inVoice(guild, userId)) return;
  const mine = tracked(guild.id);
  if (!mine.has(userId)) return;
  const channel = playerChannel(guild);
  if (channel?.permissionOverwrites.cache.has(userId)) {
    await channel.permissionOverwrites.delete(userId, 'Blizzbeat: left voice').catch((err) => {
      if (err?.code !== 10009) throw err; // already gone
    });
  }
  const now = tracked(guild.id);
  now.delete(userId);
  setTracked(guild.id, now);
}

function scheduleRevoke(guild, userId) {
  const key = `${guild.id}:${userId}`;
  if (timers.has(key)) return;
  timers.set(
    key,
    setTimeout(() => {
      revoke(guild, userId).catch((err) => log.warn(`[${guild.id}] couldn't remove channel access for ${userId}: ${err?.message ?? err}`));
    }, GRACE_MS),
  );
}

function cancelRevoke(guildId, userId) {
  const key = `${guildId}:${userId}`;
  clearTimeout(timers.get(key));
  timers.delete(key);
}

/** Someone joined, left or moved voice channels. */
export function onVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild;
  if (!getSettings(guild.id).voiceAccess) return;
  const member = newState.member ?? oldState.member;
  if (!member || member.user?.bot) return;
  const nowInVoice = Boolean(newState.channelId && newState.channelId !== guild.afkChannelId);
  if (nowInVoice) {
    cancelRevoke(guild.id, member.id);
    grant(guild, member).catch((err) => log.warn(`[${guild.id}] couldn't give ${member.user?.tag ?? member.id} channel access: ${err?.message ?? err}`));
  } else {
    scheduleRevoke(guild, member.id);
  }
}

/** Brings the channel in line with who is in voice right now (on startup and when turned on). */
export async function syncVoiceAccess(guild) {
  const channel = playerChannel(guild);
  if (!channel || !getSettings(guild.id).voiceAccess) return;
  // Hidden from everyone by default (kept in place even if someone undid it).
  const everyone = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  if (!everyone?.deny.has(PermissionFlagsBits.ViewChannel)) {
    await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }, { reason: 'Blizzbeat: voice-only access' });
  }
  for (const vs of guild.voiceStates.cache.values()) {
    if (!vs.channelId || vs.channelId === guild.afkChannelId || vs.member?.user?.bot) continue;
    cancelRevoke(guild.id, vs.id);
    await grant(guild, vs.member ?? (await guild.members.fetch(vs.id).catch(() => null))).catch((err) =>
      log.warn(`[${guild.id}] couldn't give ${vs.id} channel access: ${err?.message ?? err}`),
    );
  }
  for (const userId of tracked(guild.id)) {
    if (!inVoice(guild, userId)) scheduleRevoke(guild, userId);
  }
}

export async function enableVoiceAccess(guild) {
  const problem = voiceAccessProblem(guild);
  if (problem) return problem;
  updateSettings(guild.id, { voiceAccess: true });
  await syncVoiceAccess(guild);
  return null;
}

/** Turns it off: every entry Blizzbeat added is removed and the channel is visible to everyone again. */
export async function disableVoiceAccess(guild, { keepSetting = false } = {}) {
  for (const key of timers.keys()) {
    if (key.startsWith(`${guild.id}:`)) {
      clearTimeout(timers.get(key));
      timers.delete(key);
    }
  }
  const channel = playerChannel(guild);
  if (channel) {
    for (const userId of tracked(guild.id)) {
      if (channel.permissionOverwrites.cache.has(userId)) {
        await channel.permissionOverwrites.delete(userId, 'Blizzbeat: voice-only access turned off').catch(() => null);
      }
    }
    const everyone = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    if (everyone?.deny.has(PermissionFlagsBits.ViewChannel)) {
      const reason = 'Blizzbeat: voice-only access turned off';
      const onlyHidden = everyone.allow.bitfield === 0n && everyone.deny.bitfield === PermissionFlagsBits.ViewChannel;
      // Nothing else in @everyone's entry: remove it, like it was before. Otherwise just un-hide.
      if (onlyHidden) await channel.permissionOverwrites.delete(guild.roles.everyone, reason);
      else await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null }, { reason });
    }
  }
  updateSettings(guild.id, { voiceAccessUsers: [], ...(keepSetting ? {} : { voiceAccess: false }) });
}

export async function syncAllVoiceAccess(client) {
  for (const guild of client.guilds.cache.values()) {
    if (!getSettings(guild.id).voiceAccess) continue;
    await syncVoiceAccess(guild).catch((err) => log.warn(`[${guild.id}] voice-only access sync failed: ${err?.message ?? err}`));
  }
}
