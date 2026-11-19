// Routes slash commands, autocomplete and player buttons.
import { MessageFlags } from 'discord.js';
import { adminCommands, runAdminCommand } from './commands/admin.js';
import { autocompletePlay, runUserCommand, userCommands } from './commands/user.js';
import { isControllerChannel, requestUpdate } from './controller.js';
import { log } from './logger.js';
import * as music from './music.js';
import { UserError } from './music.js';

export const allCommands = [...userCommands, ...adminCommands];
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
};

function friendly(err) {
  if (err instanceof UserError) return `❌ ${err.message}`;
  log.error('Unexpected error:', err);
  return '❌ Something went wrong. Please try again.';
}

async function handleButton(interaction) {
  const action = interaction.customId.slice(3);
  const kind = BUTTON_ACTIONS[action];
  if (!kind) return;
  await interaction.deferUpdate().catch(() => null);
  try {
    const player = music.assertCanControl(interaction.member, kind);
    switch (action) {
      case 'previous':
        await music.previous(player);
        break;
      case 'pause':
        await music.togglePause(player);
        break;
      case 'skip':
        await music.skip(player);
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
      default:
        break;
    }
  } catch (err) {
    await interaction.followUp({ content: friendly(err), flags: MessageFlags.Ephemeral }).catch(() => null);
  } finally {
    requestUpdate(interaction.guildId);
  }
}

async function handleCommand(interaction) {
  const isAdminCmd = adminNames.has(interaction.commandName);
  const quiet = isAdminCmd || isControllerChannel(interaction.guildId, interaction.channelId);
  const flags = quiet ? MessageFlags.Ephemeral : undefined;

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
  if (!interaction.inCachedGuild()) return;

  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play') {
      await autocompletePlay(interaction).catch(() => interaction.respond([]).catch(() => null));
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('bb:')) return handleButton(interaction);
  if (interaction.isChatInputCommand()) return handleCommand(interaction);
}
