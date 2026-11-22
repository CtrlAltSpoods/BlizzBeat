// Stage channels. When Blizzbeat is summoned to a Stage it:
// - starts the Stage if it isn't live yet, WITHOUT the "Stage started" notification to everyone,
// - makes itself a speaker (or raises its hand if it isn't allowed to),
// - keeps the Stage topic set to the song that's playing,
// - ends the Stage when it leaves, but only if Blizzbeat started it.
// All of it needs Blizzbeat to be a Stage moderator in that channel (Manage Channels, Mute Members and
// Move Members there); without that it falls back to asking to speak.
import { ChannelType, PermissionFlagsBits, Routes, StageInstancePrivacyLevel } from 'discord.js';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => `${err?.message ?? err}${err?.code ? ` (code ${err.code})` : ''}`;

/** One attempt to unsuppress Blizzbeat: Discord's "@me" route first, then the same change by user id. */
async function unsuppress(channel) {
  const guild = channel.guild;
  const body = { channel_id: channel.id, suppress: false };
  try {
    await client.rest.patch(Routes.guildVoiceState(guild.id, '@me'), { body });
    return null;
  } catch (err) {
    const first = errText(err);
    try {
      await client.rest.patch(Routes.guildVoiceState(guild.id, guild.members.me.id), { body });
      return null;
    } catch (err2) {
      return `${first}; by user id: ${errText(err2)}`;
    }
  }
}

/**
 * Makes Blizzbeat a speaker on the Stage it's in. Runs on its own, so a problem starting the Stage or
 * setting the topic can't stop it from speaking. Discord can refuse it for a few seconds right after
 * joining (or right after the Stage goes live), so it retries a few times before raising its hand.
 */
async function ensureSpeaker(channel) {
  const guildId = channel.guild.id;
  const me = channel.guild.members.me;
  const current = () => channel.guild.voiceStates.cache.get(me?.id);
  if (!me || current()?.channelId !== channel.id || !current()?.suppress) return;
  const perms = channel.permissionsFor(me);
  if (perms?.has(PermissionFlagsBits.MuteMembers)) {
    let last = null;
    for (const wait of [0, 1500, 4000, 8000]) {
      if (wait) await sleep(wait);
      const state = current();
      if (state?.channelId !== channel.id) return; // left meanwhile
      if (!state.suppress) return; // a moderator (or an earlier try) already did it
      last = await unsuppress(channel);
      if (!last) {
        handRaised.delete(guildId);
        log.info(`[${guildId}] speaking on the Stage in #${channel.name}`);
        return;
      }
      log.debug(`[${guildId}] couldn't become a speaker yet: ${last}`);
    }
    log.warn(`[${guildId}] couldn't become a speaker in #${channel.name}: ${last}`);
  } else {
    log.info(`[${guildId}] can't become a speaker in #${channel.name} by itself (no Mute Members there); raising hand`);
  }
  if (handRaised.has(guildId) || current()?.channelId !== channel.id) return;
  handRaised.add(guildId);
  await current()
    ?.setRequestToSpeak(true)
    .catch((err) => log.warn(`[${guildId}] couldn't raise my hand either: ${errText(err)}`));
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
