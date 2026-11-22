// Stage channels. When Blizzbeat is summoned to a Stage it:
// - starts the Stage if it isn't live yet, WITHOUT the "Stage started" notification to everyone,
// - makes itself a speaker (or raises its hand if it isn't allowed to),
// - keeps the Stage topic set to the song that's playing,
// - ends the Stage when it leaves, but only if Blizzbeat started it.
// All of it needs Blizzbeat to be a Stage moderator in that channel (Manage Channels, Mute Members and
// Move Members there); without that it falls back to asking to speak.
import { ChannelType, PermissionFlagsBits, StageInstancePrivacyLevel } from 'discord.js';
import { client, lavalink } from './client.js';
import { getSettings, updateSettings } from './db.js';
import { log } from './logger.js';
import { truncate } from './util/format.js';

const MODERATOR = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.MoveMembers];
const topics = new Map(); // stage channel id -> topic last set
const queues = new Map(); // guildId -> promise chain (one Stage change at a time)
let notify = () => {};

/** Runs Stage changes for a server one after another (Discord rate-limits them). */
function serial(guildId, fn) {
  const next = (queues.get(guildId) ?? Promise.resolve()).then(fn).catch((err) => log.debug(`[${guildId}] stage: ${err?.message ?? err}`));
  queues.set(guildId, next);
  return next;
}

function stageChannel(guildId, channelId) {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  return channel?.type === ChannelType.GuildStageVoice ? channel : null;
}

const isModerator = (channel) => Boolean(channel?.permissionsFor(channel.guild.members.me)?.has(MODERATOR));

function idleTopic(guildId) {
  const id = getSettings(guildId).channelId;
  const name = id ? client.channels.cache.get(id)?.name : null;
  return name ? `🎵 Blizzbeat · request a song in #${name}` : '🎵 Blizzbeat · use /play to request a song';
}

const songTopic = (track) => truncate(`🎵 ${track.info.title} · ${track.info.author}`, 120);

/** Starts the Stage (no notification) or changes its topic. */
async function applyTopic(channel, topic) {
  const guild = channel.guild;
  const instance = channel.stageInstance ?? (await guild.stageInstances.fetch(channel.id).catch(() => null));
  if (!instance) {
    if (!isModerator(channel)) return;
    await guild.stageInstances.create(channel, {
      topic,
      privacyLevel: StageInstancePrivacyLevel.GuildOnly,
      sendStartNotification: false, // never ping @everyone that the Stage started
    });
    updateSettings(guild.id, { stageStartedBy: channel.id }); // kept across restarts
    topics.set(channel.id, topic);
    log.info(`[${guild.id}] started the Stage in #${channel.name} (no notification)`);
    return;
  }
  if (topics.get(channel.id) === topic && instance.topic === topic) return;
  if (!isModerator(channel)) return;
  try {
    await guild.stageInstances.edit(channel, { topic });
  } catch (err) {
    // A song title AutoMod (or Discord) won't allow as a topic: use a plain one instead.
    if (topic === idleTopic(guild.id)) throw err;
    log.debug(`[${guild.id}] stage topic "${topic}" refused (${err?.message ?? err}); using a plain one`);
    topic = '🎵 Music by Blizzbeat';
    await guild.stageInstances.edit(channel, { topic });
  }
  topics.set(channel.id, topic);
}

const handRaised = new Set(); // guildId: already asked a moderator, don't repeat every song

/**
 * Makes Blizzbeat a speaker on the Stage it's in. Runs on its own, so a problem starting the Stage or
 * setting the topic can't stop it from speaking. Without moderator rights it raises its hand once.
 */
async function ensureSpeaker(channel) {
  const guildId = channel.guild.id;
  const me = channel.guild.members.me;
  const state = me?.voice;
  if (!state || state.channelId !== channel.id || !state.suppress) return;
  const perms = channel.permissionsFor(me);
  if (perms?.has(PermissionFlagsBits.MuteMembers)) {
    try {
      await state.setSuppressed(false);
      handRaised.delete(guildId);
      log.info(`[${guildId}] speaking on the Stage in #${channel.name}`);
      return;
    } catch (err) {
      log.warn(`[${guildId}] couldn't become a speaker in #${channel.name}: ${err?.message ?? err}`);
    }
  } else {
    log.info(`[${guildId}] can't become a speaker in #${channel.name} by itself (no Mute Members there); raising hand`);
  }
  if (handRaised.has(guildId)) return;
  handRaised.add(guildId);
  await state.setRequestToSpeak(true).catch((err) => log.debug(`[${guildId}] request to speak failed: ${err?.message ?? err}`));
  notify(
    guildId,
    `🎙️ I've raised my hand in <#${channel.id}>: a Stage moderator needs to invite me to speak. To skip this next time, give Blizzbeat **Manage Channels**, **Mute Members** and **Move Members** in that Stage.`,
  );
}

/** Blizzbeat's own voice state changed: on joining a Stage, go live and become a speaker. */
export function onBotVoiceState(oldState, newState) {
  const guildId = newState.guild.id;
  const channel = stageChannel(guildId, newState.channelId);
  const joined = newState.channelId && newState.channelId !== oldState.channelId;
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    handRaised.delete(guildId);
    endStage(guildId, oldState.channelId);
  }
  if (!channel || !joined) return;
  log.info(`[${guildId}] joined the Stage #${channel.name} (moderator rights: ${isModerator(channel) ? 'yes' : 'no'})`);
  serial(guildId, async () => {
    const track = lavalink.getPlayer(guildId)?.queue.current;
    // Speaker first, then the Stage/topic; each on its own so one failing doesn't block the other.
    await ensureSpeaker(channel);
    try {
      await applyTopic(channel, track ? songTopic(track) : idleTopic(guildId));
    } catch (err) {
      log.warn(`[${guildId}] couldn't start the Stage or set its topic: ${err?.message ?? err}`);
    }
    await ensureSpeaker(channel); // in case speaking is only allowed once the Stage is live
  });
}

/** A song started: put it in the Stage topic. */
export function setStageTopic(player) {
  const channel = stageChannel(player?.guildId, player?.voiceChannelId);
  const track = player?.queue.current;
  if (!channel || !track) return;
  serial(player.guildId, async () => {
    try {
      await applyTopic(channel, songTopic(track));
    } catch (err) {
      log.warn(`[${player.guildId}] couldn't update the Stage topic: ${err?.message ?? err}`);
    }
  });
}

/** Queue ran out: show how to request a song. */
export function idleStageTopic(player) {
  const channel = stageChannel(player?.guildId, player?.voiceChannelId);
  if (!channel) return;
  serial(player.guildId, () => applyTopic(channel, idleTopic(player.guildId)));
}

/** Blizzbeat left a Stage: end it if Blizzbeat started it (someone else's Stage is left alone). */
export function endStage(guildId, channelId) {
  topics.delete(channelId);
  if (!channelId || getSettings(guildId).stageStartedBy !== channelId) return;
  updateSettings(guildId, { stageStartedBy: null });
  const channel = stageChannel(guildId, channelId);
  if (!channel) return;
  serial(guildId, async () => {
    const instance = channel.stageInstance ?? (await channel.guild.stageInstances.fetch(channel.id).catch(() => null));
    if (instance && isModerator(channel)) {
      await channel.guild.stageInstances.delete(channel);
      log.info(`[${guildId}] ended the Stage in #${channel.name}`);
    }
  });
}

export function attachStage({ onNotice } = {}) {
  if (onNotice) notify = onNotice;
}
