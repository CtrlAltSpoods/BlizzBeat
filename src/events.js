// Lavalink + Discord event wiring.
import { Events } from 'discord.js';
import { client, lavalink } from './client.js';
import { config } from './config.js';
import { flash, isControllerChannel, isControllerMessage, requestUpdate } from './controller.js';
import { getSettings } from './db.js';
import { log } from './logger.js';
import { evaluateIdle, forgetGuild, requestSongs, UserError } from './music.js';
import { escapeMd, truncate } from './util/format.js';

export function registerLavalinkEvents() {
  lavalink.on('trackStart', (player, track) => {
    log.info(`[${player.guildId}] ▶ ${track?.info?.title ?? 'unknown'} (${track?.info?.sourceName ?? '?'})`);
    evaluateIdle(player.guildId);
    requestUpdate(player.guildId);
  });
  lavalink.on('trackEnd', (player) => requestUpdate(player.guildId));
  lavalink.on('queueEnd', (player) => {
    requestUpdate(player.guildId);
    evaluateIdle(player.guildId);
  });
  lavalink.on('playerCreate', (player) => requestUpdate(player.guildId));
  lavalink.on('playerPaused', (player) => requestUpdate(player.guildId));
  lavalink.on('playerResumed', (player) => requestUpdate(player.guildId));
  lavalink.on('playerMove', (player) => {
    requestUpdate(player.guildId);
    evaluateIdle(player.guildId);
  });
  lavalink.on('playerDestroy', (player, reason) => {
    log.info(`[${player.guildId}] player destroyed (${reason ?? 'no reason'})`);
    forgetGuild(player.guildId);
    requestUpdate(player.guildId);
  });

  lavalink.on('trackError', (player, track, payload) => {
    const reason = payload?.exception?.message ?? payload?.message ?? 'unknown error';
    log.warn(`[${player.guildId}] track error: ${track?.info?.title} :: ${reason}`);
    flash(
      player.guildId,
      `⚠️ Couldn't play **${escapeMd(truncate(track?.info?.title ?? 'that song', 80))}**: ${truncate(reason, 150)}`,
      10_000,
    );
  });
  lavalink.on('trackStuck', (player, track) => {
    log.warn(`[${player.guildId}] track stuck: ${track?.info?.title}`);
    flash(player.guildId, `⚠️ **${escapeMd(truncate(track?.info?.title ?? 'That song', 80))}** got stuck, skipping.`, 8000);
  });

  lavalink.nodeManager.on('connect', (node) => log.info(`Lavalink node "${node.id}" connected.`));
  lavalink.nodeManager.on('reconnecting', (node) => log.warn(`Lavalink node "${node.id}" reconnecting...`));
  lavalink.nodeManager.on('disconnect', (node, reason) =>
    log.warn(`Lavalink node "${node.id}" disconnected:`, reason?.reason ?? reason ?? ''),
  );
  lavalink.nodeManager.on('error', (node, error) => log.error(`Lavalink node "${node.id}" error:`, error?.message ?? error));
}

export function registerDiscordEvents() {
  client.on(Events.Raw, (packet) => lavalink.sendRawData(packet));

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = newState.guild.id;
    if (lavalink.getPlayer(guildId)) evaluateIdle(guildId);
  });

  // Type-to-queue: every message in the Blizzbeat channel is treated as a request, then removed.
  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || !isControllerChannel(message.guildId, message.channelId)) return;
    if (message.author.id === client.user.id) return;

    await message.delete().catch(() => null);
    if (message.author.bot || message.webhookId || message.system) return;
    if (!config.messageContent) return;

    const query = message.content?.trim();
    if (!query) return;

    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    try {
      const result = await requestSongs({ guild: message.guild, member, query, textChannelId: message.channelId });
      flash(message.guildId, `<@${member.id}> ${result}`, 5000);
    } catch (err) {
      if (!(err instanceof UserError)) log.error('Request from channel failed:', err);
      const text = err instanceof UserError ? err.message : 'Something went wrong. Please try again.';
      flash(message.guildId, `<@${member.id}> ❌ ${text}`, 8000);
    } finally {
      requestUpdate(message.guildId);
    }
  });

  // Someone deleted the banner or player message: put it back.
  client.on(Events.MessageDelete, (message) => {
    if (message.guildId && isControllerMessage(message.guildId, message.id)) requestUpdate(message.guildId);
  });

  client.on(Events.ChannelDelete, (channel) => {
    if (!channel.guildId) return;
    if (getSettings(channel.guildId).channelId === channel.id) requestUpdate(channel.guildId);
  });
}
