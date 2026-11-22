// Routes slash commands, autocomplete and player buttons.
import { MessageFlags, OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { SET_VOICE_STATUS } from './status.js';
import { adminCommands, runAdminCommand } from './commands/admin.js';
import { autocompleteFavourites, autocompletePlay, runUserCommand, userCommands } from './commands/user.js';
import { isControllerChannel, requestUpdate } from './controller.js';
import { getSettings } from './db.js';
import { deliveryDelayMs } from './diagnostics.js';
import { log } from './logger.js';
import * as music from './music.js';
import { UserError } from './music.js';

export const allCommands = [...userCommands, ...adminCommands];

export const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles, // voice-only access: per-member entries on the Blizzbeat channel
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  SET_VOICE_STATUS,
]);
const adminNames = new Set(['setup', 'config']);

const BUTTON_ACTIONS = {
  previous: 'previous',
  pause: 'pause',
  skip: 'skip',
  stop: 'stop',
  voldown: 'volume',
  volup: 'volume',
  shuffle: 'shuffle',
  loop: 'loop',
  autoplay: 'autoplay',
};

function friendly(err) {
  if (err instanceof UserError) return `❌ ${err.message}`;
  log.error('Unexpected error:', err);
  return '❌ Something went wrong. Please try again.';
}

async function handleButton(interaction) {
  const action = interaction.customId.slice(3);
  if (action === 'favourite') {
    // Personal, so anyone can press it (no DJ or voice check) and only they see the reply.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
    let content;
    try {
      content = music.toggleFavourite(interaction.member ?? interaction.user, interaction.guildId);
    } catch (err) {
      content = friendly(err);
    }
    await interaction.editReply({ content }).catch(() => null);
    return;
  }
  if (action.startsWith('mood:')) {
    await interaction.deferUpdate().catch(() => null);
    try {
      const player = music.assertCanControl(interaction.member, 'autoplay');
      const message = music.setMood(interaction.guildId, action.slice(5));
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
      // Nothing left to play: start a mood pick straight away.
      if (getSettings(interaction.guildId).autoplay && !player.queue.current && !player.queue.tracks.length) {
        const last = player.queue.previous[0];
        if (last) {
          await music.autoplayNext(player, last);
          if (player.queue.tracks.length) await player.play({ paused: false });
        }
      }
    } catch (err) {
      await interaction.followUp({ content: friendly(err), flags: MessageFlags.Ephemeral }).catch(() => null);
    } finally {
      requestUpdate(interaction.guildId);
    }
    return;
  }
  const kind = BUTTON_ACTIONS[action];
  if (!kind) return;
  await interaction.deferUpdate().catch(() => null);
  try {
    if (action === 'skip') {
      // Skip goes through vote-skip rules instead of the DJ check.
      const { message, voted } = await music.skipOrVote(interaction.member);
      if (voted) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    const player = music.assertCanControl(interaction.member, kind);
    switch (action) {
      case 'previous':
        await music.previous(player);
        break;
      case 'pause':
        await music.togglePause(player);
        break;
      case 'stop':
        await music.stop(player);
        break;
      case 'voldown':
        await music.setVolume(player, player.volume - 10);
        break;
      case 'volup':
        await music.setVolume(player, player.volume + 10);
        break;
      case 'shuffle':
        await music.shuffle(player);
        break;
      case 'loop':
        await music.setLoop(player);
        break;
      case 'autoplay': {
        const on = !getSettings(interaction.guildId).autoplay;
        const message = music.setAutoplay(interaction.guildId, on);
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
        if (on && !player.queue.current && !player.queue.tracks.length) {
          const last = player.queue.previous[0];
          if (last) {
            await music.autoplayNext(player, last);
            if (player.queue.tracks.length) await player.play({ paused: false });
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    await interaction.followUp({ content: friendly(err), flags: MessageFlags.Ephemeral }).catch(() => null);
  } finally {
    requestUpdate(interaction.guildId);
  }
}

async function handleEffectMenu(interaction) {
  await interaction.deferUpdate().catch(() => null);
  try {
    const player = music.assertCanControl(interaction.member, 'effect');
    await music.applyEffect(player, interaction.values[0]);
  } catch (err) {
    await interaction.followUp({ content: friendly(err), flags: MessageFlags.Ephemeral }).catch(() => null);
  } finally {
    requestUpdate(interaction.guildId);
  }
}

async function handleCommand(interaction) {
  const isAdminCmd = adminNames.has(interaction.commandName);
  // Favourites lists are personal: only the person asking sees them.
  const personal = interaction.commandName === 'favourites' && interaction.options.getSubcommand(false) !== 'play';
  const quiet = isAdminCmd || personal || isControllerChannel(interaction.guildId, interaction.channelId);
  const flags = quiet ? MessageFlags.Ephemeral : undefined;

  // Acknowledge first: Discord only waits 3 seconds. Everything else happens after.
  const received = Date.now();
  const lag = deliveryDelayMs(interaction);
  try {
    await interaction.deferReply({ flags });
  } catch (err) {
    log.warn(
      `Couldn't acknowledge /${interaction.commandName} in time: it reached the bot ${lag}ms after it was sent ` +
        `and the acknowledgement took ${Date.now() - received}ms (Discord's limit is 3000ms total). ${err.message}`,
    );
    return;
  }
  const ackMs = Date.now() - received;
  if (ackMs + Math.max(lag, 0) > 1500) {
    log.warn(`/${interaction.commandName} was slow to acknowledge: delivery ${lag}ms + acknowledgement ${ackMs}ms (limit 3000ms).`);
  }

  try {
    const result = isAdminCmd ? await runAdminCommand(interaction) : await runUserCommand(interaction, flags);
    if (!result) return;
    const data = { ...result, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(data);
    else await interaction.reply({ ...data, flags });
  } catch (err) {
    const content = friendly(err);
    try {
      if (interaction.deferred || interaction.replied) {
        if (!quiet) {
          // Don't leave a public "thinking..." or error in someone else's channel.
          await interaction.deleteReply().catch(() => null);
          await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        } else {
          await interaction.editReply({ content, embeds: [], allowedMentions: { parse: [] } });
        }
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
    } catch (replyErr) {
      log.warn('Could not send error reply:', replyErr?.message ?? replyErr);
    }
  } finally {
    if (!isAdminCmd) requestUpdate(interaction.guildId);
  }
}

export async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    log.info(`/${interaction.commandName} from ${interaction.user?.username ?? '?'} in ${interaction.guild?.name ?? interaction.guildId ?? 'DM'}`);
  }
  if (!interaction.inCachedGuild()) {
    // Happens when the app's commands are in a server but the bot user itself isn't (invited without the "bot" scope).
    log.warn(`Got an interaction from server ${interaction.guildId ?? 'DM'} that the bot isn't a member of.`);
    if (interaction.isRepliable()) {
      const invite = interaction.client.generateInvite({
        scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
        permissions: INVITE_PERMISSIONS,
      });
      await interaction
        .reply({
          content: `⚠️ Blizzbeat's commands are here, but the bot itself isn't in this server. Re-invite it with this link: ${invite}`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => null);
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play') {
      await autocompletePlay(interaction).catch(() => interaction.respond([]).catch(() => null));
    } else if (interaction.commandName === 'favourites') {
      await autocompleteFavourites(interaction).catch(() => interaction.respond([]).catch(() => null));
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('bb:')) return handleButton(interaction);
  if (interaction.isStringSelectMenu() && interaction.customId === 'bb:effect') return handleEffectMenu(interaction);
  if (interaction.isChatInputCommand()) return handleCommand(interaction);
}
