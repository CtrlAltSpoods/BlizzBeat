// Lavalink + Discord event wiring.
import { Events } from 'discord.js';
import { client, lavalink, playerHooks, queueHooks } from './client.js';
import { config } from './config.js';
import { flash, isControllerChannel, isControllerMessage, requestUpdate } from './controller.js';
import { getSettings } from './db.js';
import { log } from './logger.js';
import { autoplayNext, checkVotes, clearVotes, evaluateIdle, forgetGuild, requestSongs, UserError } from './music.js';
import { dropSession, scheduleSave } from './persistence.js';
import { clearVoiceStatus, setVoiceStatus, updatePresence } from './status.js';
import { escapeMd, truncate } from './util/format.js';

export function registerLavalinkEvents() {
  playerHooks.autoplay = autoplayNext;
  queueHooks.onChange = (guildId) => {
    requestUpdate(guildId);
    scheduleSave(guildId);
  };

  lavalink.on('trackStart', (player, track) => {
    log.info(`[${player.guildId}] ▶ ${track?.info?.title ?? 'unknown'} (${track?.info?.sourceName ?? '?'})`);
    clearVotes(player.guildId);
    evaluateIdle(player.guildId);
    requestUpdate(player.guildId);
    scheduleSave(player.guildId);
    setVoiceStatus(player);
    updatePresence();
  });
  lavalink.on('trackEnd', (player) => requestUpdate(player.guildId));
  lavalink.on('queueEnd', (player) => {
    requestUpdate(player.guildId);
    evaluateIdle(player.guildId);
    scheduleSave(player.guildId);
    clearVoiceStatus(player.guildId, player.voiceChannelId);
    updatePresence();
  });
  lavalink.on('playerCreate', (player) => requestUpdate(player.guildId));
  const onPauseChange = (player) => {
    requestUpdate(player.guildId);
    scheduleSave(player.guildId);
    updatePresence();
  };
  lavalink.on('playerPaused', onPauseChange);
  lavalink.on('playerResumed', onPauseChange);
  lavalink.on('playerMove', (player, oldChannelId) => {
    clearVoiceStatus(player.guildId, oldChannelId);
    requestUpdate(player.guildId);
    evaluateIdle(player.guildId);
    scheduleSave(player.guildId);
  });
  lavalink.on('playerDestroy', (player, reason) => {
    log.info(`[${player.guildId}] player destroyed (${reason ?? 'no reason'})`);
    forgetGuild(player.guildId);
    clearVotes(player.guildId);
    dropSession(player.guildId);
    clearVoiceStatus(player.guildId, player.voiceChannelId);
    requestUpdate(player.guildId);
    updatePresence();
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

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const guildId = newState.guild.id;
    if (!lavalink.getPlayer(guildId)) return;
    evaluateIdle(guildId);
    // Fewer listeners can mean a pending skip vote now passes.
    const passed = await checkVotes(guildId).catch(() => null);
    if (passed) flash(guildId, passed, 6000);
    requestUpdate(guildId);
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
