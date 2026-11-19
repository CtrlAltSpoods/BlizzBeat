// The Blizzbeat channel: a banner message plus one player message that is edited in place.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} from 'discord.js';
import { client, commandMention, lavalink, queueHooks } from './client.js';
import { config } from './config.js';
import { bannerDir, getSettings, updateSettings } from './db.js';
import { log } from './logger.js';
import { LOOP_LABEL, SEARCH_SOURCES } from './music.js';
import {
  escapeMd,
  formatDuration,
  isUrl,
  progressBar,
  sourceLabel,
  trackDuration,
  truncate,
} from './util/format.js';

export const REQUIRED_CHANNEL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];

const PERM_NAMES = {
  [PermissionFlagsBits.ViewChannel]: 'View Channel',
  [PermissionFlagsBits.SendMessages]: 'Send Messages',
  [PermissionFlagsBits.EmbedLinks]: 'Embed Links',
  [PermissionFlagsBits.AttachFiles]: 'Attach Files',
  [PermissionFlagsBits.ReadMessageHistory]: 'Read Message History',
  [PermissionFlagsBits.ManageMessages]: 'Manage Messages',
};

export function missingChannelPerms(channel) {
  const perms = channel.permissionsFor(channel.guild.members.me);
  return REQUIRED_CHANNEL_PERMS.filter((p) => !perms?.has(p)).map((p) => PERM_NAMES[p]);
}

/* ------------------------------ Banner ------------------------------ */

export function bannerFile(guildId) {
  const custom = getSettings(guildId).customBanner;
  if (custom) {
    const p = join(bannerDir(), custom);
    if (existsSync(p)) return { path: p, name: `blizzbeat-banner${custom.slice(custom.lastIndexOf('.'))}` };
  }
  return { path: join(config.assetsDir, 'banner.png'), name: 'blizzbeat-banner.png' };
}

function bannerPayload(guildId) {
  const { path, name } = bannerFile(guildId);
  return { files: [new AttachmentBuilder(path, { name })] };
}

/* ------------------------------ Render ------------------------------ */

function button(id, emoji, style = ButtonStyle.Secondary, disabled = false, label) {
  const b = new ButtonBuilder().setCustomId(`bb:${id}`).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(label);
  return b;
}

function buildComponents(player) {
  const track = player?.queue.current;
  const idle = !track;
  const paused = Boolean(player?.paused);
  const loop = player?.repeatMode ?? 'off';
  const hasPrev = Boolean(player?.queue.previous.length);
  const queued = player?.queue.tracks.length ?? 0;

  const row1 = new ActionRowBuilder().addComponents(
    button('previous', '⏮️', ButtonStyle.Secondary, !player || !hasPrev),
    button('pause', paused ? '▶️' : '⏸️', paused ? ButtonStyle.Success : ButtonStyle.Primary, idle),
    button('skip', '⏭️', ButtonStyle.Secondary, idle),
    button('stop', '⏹️', ButtonStyle.Danger, idle),
  );
  const row2 = new ActionRowBuilder().addComponents(
    button('voldown', '🔉', ButtonStyle.Secondary, !player),
    button('volup', '🔊', ButtonStyle.Secondary, !player),
    button('shuffle', '🔀', ButtonStyle.Secondary, queued < 2),
    button('loop', loop === 'track' ? '🔂' : '🔁', loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success, !player),
  );
  return [row1, row2];
}

function queueContent(player) {
  const header = '**__Up next__**';
  const tracks = player?.queue.tracks ?? [];
  if (!tracks.length) {
    return `${header}\n-# The queue is empty. Type a song name or link in this channel to add one.`;
  }
  const lines = [];
  let length = header.length;
  const maxLines = 15;
  for (let i = 0; i < tracks.length && lines.length < maxLines; i++) {
    const t = tracks[i];
    const line = `\`${String(i + 1).padStart(2, ' ')}.\` ${escapeMd(truncate(t.info.title, 60))} · ${escapeMd(truncate(t.info.author, 30))} \`${trackDuration(t)}\``;
    if (length + line.length + 60 > 1900) break;
    lines.push(line);
    length += line.length + 1;
  }
  const rest = tracks.length - lines.length;
  const total = tracks.reduce((s, t) => s + (t.info.isStream ? 0 : t.info.duration ?? 0), 0);
  const footer = `-# ${tracks.length} song${tracks.length === 1 ? '' : 's'} · ${formatDuration(total)} total${rest > 0 ? ` · and ${rest} more` : ''}`;
  return [header, ...lines, footer].join('\n');
}

function idleEmbed(guildId, player, settings) {
  const embed = new EmbedBuilder()
    .setColor(settings.embedColor)
    .setTitle('No song playing')
    .setDescription(
      [
        `Join a voice channel and **type a song name or link** in this channel, or use ${commandMention('play')}.`,
        '',
        `🔎 Searches use **${SEARCH_SOURCES[settings.searchSource] ?? settings.searchSource}**. Links from YouTube, SoundCloud${config.spotifyEnabled ? ', Spotify' : ''} and more work too.`,
      ].join('\n'),
    )
    .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
    .setFooter({ text: 'Blizzbeat' });

  if (player?.voiceChannelId) {
    const leave = settings.stay247
      ? 'Staying connected (24/7 mode).'
      : `I'll leave after ${settings.autoLeaveMinutes} minute${settings.autoLeaveMinutes === 1 ? '' : 's'} of silence.`;
    embed.addFields({ name: 'Waiting in', value: `<#${player.voiceChannelId}>\n-# ${leave}` });
  }
  return embed;
}

function playingEmbed(player, settings) {
  const track = player.queue.current;
  const info = track.info;
  const position = Math.min(player.position ?? 0, info.duration || Infinity);
  const status = player.paused ? '⏸️ Paused' : '▶️ Now playing';
  const requester = track.requester;

  const embed = new EmbedBuilder()
    .setColor(settings.embedColor)
    .setAuthor({ name: `${status}`, iconURL: client.user?.displayAvatarURL({ size: 64 }) })
    .setTitle(truncate(info.title, 256))
    .setDescription(
      [
        `by **${escapeMd(truncate(info.author, 100))}**`,
        '',
        info.isStream
          ? `${progressBar(0, 0)} \`${formatDuration(position)}\``
          : `\`${formatDuration(position)}\` ${progressBar(position, info.duration)} \`${trackDuration(track)}\``,
      ].join('\n'),
    )
    .addFields(
      { name: 'Requested by', value: requester?.id ? `<@${requester.id}>` : 'Autoplay', inline: true },
      { name: 'Volume', value: `${player.volume}%`, inline: true },
      { name: 'Loop', value: LOOP_LABEL[player.repeatMode] ?? 'Off', inline: true },
    )
    .setFooter({ text: `${sourceLabel(info.sourceName)} · in ${player.voiceChannelId ? (client.channels.cache.get(player.voiceChannelId)?.name ?? 'voice') : 'voice'}` });

  if (isUrl(info.uri)) embed.setURL(info.uri);
  const art = info.artworkUrl ?? track.pluginInfo?.artworkUrl;
  if (art && isUrl(art)) embed.setImage(art);
  return embed;
}

export function nowPlayingEmbed(guildId) {
  const player = lavalink.getPlayer(guildId);
  if (!player?.queue.current) return null;
  return playingEmbed(player, getSettings(guildId));
}

function controllerPayload(guildId) {
  const settings = getSettings(guildId);
  const player = lavalink.getPlayer(guildId);
  const embed = player?.queue.current ? playingEmbed(player, settings) : idleEmbed(guildId, player, settings);
  return {
    content: queueContent(player),
    embeds: [embed],
    components: buildComponents(player),
    allowedMentions: { parse: [] },
  };
}

/* ------------------------- Message management ------------------------- */

async function fetchChannel(channelId) {
  try {
    return await client.channels.fetch(channelId);
  } catch (err) {
    if (err?.code === RESTJSONErrorCodes.UnknownChannel || err?.code === RESTJSONErrorCodes.MissingAccess) return null;
    throw err;
  }
}

async function fetchMessage(channel, messageId) {
  if (!messageId) return null;
  try {
    return await channel.messages.fetch(messageId);
  } catch (err) {
    if (err?.code === RESTJSONErrorCodes.UnknownMessage) return null;
    throw err;
  }
}

/**
 * Makes sure the channel has the banner followed by the player message, re-posting only what's missing.
 * Returns the player message.
 */
async function ensureLayout(guildId, channel) {
  const settings = getSettings(guildId);
  let banner = await fetchMessage(channel, settings.bannerMessageId);
  let controller = await fetchMessage(channel, settings.controllerMessageId);

  if (!banner) {
    // The banner has to sit above the player, so both get re-posted.
    if (controller) await controller.delete().catch(() => null);
    banner = await channel.send(bannerPayload(guildId));
    controller = null;
  }
  if (!controller) {
    controller = await channel.send(controllerPayload(guildId));
  }
  updateSettings(guildId, { bannerMessageId: banner.id, controllerMessageId: controller.id });
  return controller;
}

async function render(guildId) {
  const settings = getSettings(guildId);
  if (!settings.channelId) return;
  if (!client.guilds.cache.has(guildId)) return;

  const channel = await fetchChannel(settings.channelId);
  if (!channel) {
    log.warn(`Blizzbeat channel for guild ${guildId} is gone; clearing setup.`);
    updateSettings(guildId, { channelId: null, bannerMessageId: null, controllerMessageId: null });
    return;
  }

  const existing = await fetchMessage(channel, settings.controllerMessageId);
  const bannerOk = existing ? await fetchMessage(channel, settings.bannerMessageId) : null;
  if (existing && bannerOk) {
    await existing.edit(controllerPayload(guildId));
  } else {
    await ensureLayout(guildId, channel);
  }
}

/* ---------------------------- Update queue ---------------------------- */

const MIN_GAP_MS = 1500;
const timers = new Map();
const lastRun = new Map();
const chains = new Map();

/** Runs channel/message work for a guild one job at a time, so nothing gets posted twice. */
function serialize(guildId, job) {
  const prev = chains.get(guildId) ?? Promise.resolve();
  const next = prev.catch(() => null).then(job);
  chains.set(guildId, next);
  next
    .finally(() => {
      if (chains.get(guildId) === next) chains.delete(guildId);
    })
    .catch(() => null);
  return next;
}

/** Schedules a (debounced, rate-limited) edit of the player message. Safe to call often. */
export function requestUpdate(guildId) {
  if (!guildId || timers.has(guildId)) return;
  const since = Date.now() - (lastRun.get(guildId) ?? 0);
  const delay = Math.max(350, MIN_GAP_MS - since);
  timers.set(
    guildId,
    setTimeout(() => {
      timers.delete(guildId);
      lastRun.set(guildId, Date.now());
      serialize(guildId, () => render(guildId)).catch((err) =>
        log.warn(`Could not update player message in guild ${guildId}:`, err?.message ?? err),
      );
    }, delay),
  );
}

queueHooks.onChange = (guildId) => requestUpdate(guildId);

/** Refreshes the progress bar of every playing server. */
export function startProgressTicker() {
  setInterval(() => {
    for (const player of lavalink.players.values()) {
      if (player.queue.current && !player.paused) requestUpdate(player.guildId);
    }
  }, config.progressInterval * 1000).unref();
}

/* ----------------------------- Public API ----------------------------- */

async function deleteMessages(channel, ids) {
  for (const id of ids) {
    const m = await fetchMessage(channel, id).catch(() => null);
    await m?.delete().catch(() => null);
  }
}

/** Points Blizzbeat at a channel and posts the banner + player. Cleans up the old channel's messages. */
export function setupChannel(guild, channel) {
  return serialize(guild.id, async () => {
    const settings = getSettings(guild.id);
    const oldIds = [settings.bannerMessageId, settings.controllerMessageId];
    if (settings.channelId && settings.channelId !== channel.id) {
      updateSettings(guild.id, { bannerMessageId: null, controllerMessageId: null });
      const old = await fetchChannel(settings.channelId).catch(() => null);
      if (old) await deleteMessages(old, oldIds);
    }
    updateSettings(guild.id, { channelId: channel.id });
    await ensureLayout(guild.id, channel);
  });
}

export function removeSetup(guild) {
  return serialize(guild.id, async () => {
    const settings = getSettings(guild.id);
    updateSettings(guild.id, { channelId: null, bannerMessageId: null, controllerMessageId: null });
    if (!settings.channelId) return;
    const channel = await fetchChannel(settings.channelId).catch(() => null);
    if (channel) await deleteMessages(channel, [settings.bannerMessageId, settings.controllerMessageId]);
  });
}

/** Swaps the banner image by editing the existing banner message. */
export function refreshBanner(guildId) {
  return serialize(guildId, async () => {
    const settings = getSettings(guildId);
    if (!settings.channelId) return false;
    const channel = await fetchChannel(settings.channelId);
    if (!channel) return false;
    const banner = await fetchMessage(channel, settings.bannerMessageId);
    if (!banner) {
      await ensureLayout(guildId, channel);
      return true;
    }
    await banner.edit({ ...bannerPayload(guildId), attachments: [] });
    return true;
  });
}

/** Re-posts the banner and player at the bottom of the channel (used by /setup refresh). */
export function repost(guildId) {
  return serialize(guildId, async () => {
    const settings = getSettings(guildId);
    if (!settings.channelId) return false;
    const channel = await fetchChannel(settings.channelId);
    if (!channel) return false;
    updateSettings(guildId, { bannerMessageId: null, controllerMessageId: null });
    await deleteMessages(channel, [settings.bannerMessageId, settings.controllerMessageId]);
    await ensureLayout(guildId, channel);
    return true;
  });
}

/** Posts a short message in the Blizzbeat channel that deletes itself. */
export async function flash(guildId, content, ms = 6000) {
  const settings = getSettings(guildId);
  if (!settings.channelId) return;
  const channel = client.channels.cache.get(settings.channelId);
  if (!channel?.isTextBased()) return;
  const msg = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
  if (msg) setTimeout(() => msg.delete().catch(() => null), ms).unref();
}

export function isControllerChannel(guildId, channelId) {
  return getSettings(guildId).channelId === channelId;
}

export function isControllerMessage(guildId, messageId) {
  const s = getSettings(guildId);
  return messageId === s.controllerMessageId || messageId === s.bannerMessageId;
}
