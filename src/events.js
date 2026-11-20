// Lavalink + Discord event wiring.
import { Events } from 'discord.js';
import { client, commandMention, lavalink, playerHooks, queueHooks } from './client.js';
import { config } from './config.js';
import { flash, isControllerChannel, isControllerMessage, requestUpdate } from './controller.js';
import { getSettings } from './db.js';
import { log } from './logger.js';
import { autoplayNext, checkVotes, clearVotes, evaluateIdle, forgetGuild, requestSongs, requestUploads, UserError } from './music.js';
import { dropSession, scheduleSave } from './persistence.js';
import { hasCookies, isYoutubeBlock, youtubeBackend } from './youtube.js';
import { clearVoiceStatus, setVoiceStatus, updatePresence } from './status.js';
import { looksLikeMedia } from './uploads.js';
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

  const lastBlockHint = new Map();
  lavalink.on('trackError', (player, track, payload) => {
    const reason = String(payload?.exception?.message ?? payload?.message ?? 'unknown error');
    const cause = String(payload?.exception?.cause ?? '');
    log.warn(`[${player.guildId}] track error: ${track?.info?.title} :: ${reason.replace(/\n+/g, ' | ')} ${cause}`);
    const title = escapeMd(truncate(track?.info?.title ?? 'that song', 80));

    // youtube-source lists why each client failed: "Client [TVHTML5] failed: This video requires login."
    const perClient = [...reason.matchAll(/Client \[([A-Z_0-9]+)\] failed: ([^\n]+)/g)].map(
      ([, client, why]) => `${client}: ${truncate(why.trim(), 60)}`,
    );
    const details = perClient.length ? `\n-# ${perClient.slice(0, 5).join(' · ')}` : '';

    if (isYoutubeBlock(`${reason} ${cause}`)) {
      const last = lastBlockHint.get(player.guildId) ?? 0;
      const longHint = Date.now() - last > 10 * 60_000;
      if (longHint) lastBlockHint.set(player.guildId, Date.now());
      if (youtubeBackend() === 'ytdlp') {
        flash(
          player.guildId,
          `⚠️ YouTube blocked **${title}** through yt-dlp ("confirm you're not a bot").\n` +
            (hasCookies()
              ? 'The `youtube-cookies.txt` file may have expired. Export fresh cookies from a spare account.'
              : `yt-dlp needs a YouTube login: see ${commandMention('config', 'youtube')} → **Status** for how to add \`youtube-cookies.txt\`.`),
          longHint ? 60_000 : 15_000,
        );
        return;
      }
      flash(
        player.guildId,
        `⚠️ YouTube blocked **${title}** (it wants a signed-in account).${details}\n` +
          (longHint
            ? `An admin can fix this once with ${commandMention('config', 'youtube')} → **Sign in** (use a spare Google account). Check it with **Status**.`
            : `Fix: ${commandMention('config', 'youtube')} → **Sign in**.`),
        longHint ? 60_000 : 15_000,
      );
      return;
    }
    const cipherHint = /sig(nature)? function|cipher|decipher|n function|throttl/i.test(reason)
      ? '\n-# YouTube changed its player code. Set YOUTUBE_PLUGIN_VERSION to the newest youtube-source release and restart.'
      : '';
    flash(player.guildId, `⚠️ Couldn't play **${title}**: ${truncate(reason.split('\n')[0], 150)}${details}${cipherHint}`, 20_000);
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

    const isPerson = !(message.author.bot || message.webhookId || message.system);
    // Dropped audio files: copy them before the message (and with it the attachment) is deleted.
    const files = isPerson && config.messageContent ? [...message.attachments.values()].filter(looksLikeMedia) : [];
    if (!files.length) await message.delete().catch(() => null);
    if (!isPerson || !config.messageContent) return;

    const query = message.content?.trim();
    if (!query && !files.length) {
      if (message.attachments.size) flash(message.guildId, `<@${message.author.id}> ❌ Only audio and video files can be played here.`, 6000);
      return;
    }

    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) {
      if (files.length) await message.delete().catch(() => null);
      return;
    }

    try {
      let result;
      if (files.length) {
        // Any text with the files is treated as a caption.
        await message.react('⏳').catch(() => null);
        try {
          result = await requestUploads({ guild: message.guild, member, attachments: files.slice(0, 10), textChannelId: message.channelId });
        } finally {
          await message.delete().catch(() => null);
        }
      } else {
        result = await requestSongs({ guild: message.guild, member, query, textChannelId: message.channelId });
      }
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
