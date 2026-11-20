// Everyday music commands anyone can use.
import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { commandMention, lavalink, toRequester } from '../client.js';
import { config } from '../config.js';
import { getSettings } from '../db.js';
import { nowPlayingEmbed } from '../controller.js';
import * as music from '../music.js';
import { UserError } from '../music.js';
import { escapeMd, formatDuration, isUrl, parseTime, trackDuration, truncate } from '../util/format.js';
import { resolveSearchSource } from '../youtube.js';

const guildOnly = (b) => b.setContexts(InteractionContextType.Guild);

export const userCommands = [
  guildOnly(
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a song or add it to the queue')
      .addStringOption((o) =>
        o
          .setName('song')
          .setDescription('Song name or URL (YouTube, SoundCloud, Spotify...)')
          .setRequired(true)
          .setMaxLength(500)
          .setAutocomplete(true),
      )
      .addBooleanOption((o) => o.setName('next').setDescription('Put it at the front of the queue')),
  ),
  guildOnly(new SlashCommandBuilder().setName('pause').setDescription('Pause the music')),
  guildOnly(new SlashCommandBuilder().setName('resume').setDescription('Resume the music')),
  guildOnly(
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Skip the current song')
      .addIntegerOption((o) => o.setName('count').setDescription('How many songs to skip').setMinValue(1)),
  ),
  guildOnly(new SlashCommandBuilder().setName('previous').setDescription('Play the previous song again')),
  guildOnly(new SlashCommandBuilder().setName('stop').setDescription('Stop the music and clear the queue')),
  guildOnly(
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Show the queue')
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  ),
  guildOnly(new SlashCommandBuilder().setName('nowplaying').setDescription("Show what's playing")),
  guildOnly(
    new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Show or change the volume')
      .addIntegerOption((o) => o.setName('level').setDescription('Volume (0-200)').setMinValue(0).setMaxValue(200)),
  ),
  guildOnly(new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue')),
  guildOnly(
    new SlashCommandBuilder()
      .setName('loop')
      .setDescription('Loop the song or queue')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('Loop mode (leave empty to cycle)')
          .addChoices({ name: 'Off', value: 'off' }, { name: 'Song', value: 'track' }, { name: 'Queue', value: 'queue' }),
      ),
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('seek')
      .setDescription('Jump to a time in the song')
      .addStringOption((o) => o.setName('time').setDescription('e.g. 1:30, 90, 2m15s').setRequired(true)),
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('remove')
      .setDescription('Remove a song from the queue')
      .addIntegerOption((o) => o.setName('position').setDescription('Queue position').setRequired(true).setMinValue(1)),
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('move')
      .setDescription('Move a song to another place in the queue')
      .addIntegerOption((o) => o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
      .addIntegerOption((o) => o.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  ),
  guildOnly(new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (keeps the current song)')),
  guildOnly(new SlashCommandBuilder().setName('leave').setDescription('Disconnect Blizzbeat from voice')),
  guildOnly(
    new SlashCommandBuilder()
      .setName('autoplay')
      .setDescription('Keep playing similar songs when the queue runs out')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Turn autoplay on or off (leave empty to toggle)')),
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('effect')
      .setDescription('Apply an audio effect')
      .addStringOption((o) =>
        o
          .setName('name')
          .setDescription('Effect')
          .setRequired(true)
          .addChoices(...Object.entries(music.EFFECTS).map(([value, e]) => ({ name: `${e.emoji} ${e.label}`, value }))),
      ),
  ),
  guildOnly(new SlashCommandBuilder().setName('help').setDescription('How to use Blizzbeat')),
];

function queueEmbed(guildId, page) {
  const player = lavalink.getPlayer(guildId);
  const settings = getSettings(guildId);
  const current = player?.queue.current;
  const tracks = player?.queue.tracks ?? [];
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(tracks.length / perPage));
  const p = Math.min(Math.max(page, 1), pages);
  const slice = tracks.slice((p - 1) * perPage, p * perPage);
  const total = tracks.reduce((s, t) => s + (t.info.isStream ? 0 : t.info.duration ?? 0), 0);

  const lines = slice.map((t, i) => {
    const n = (p - 1) * perPage + i + 1;
    const who = t.requester?.id ? ` · <@${t.requester.id}>` : '';
    return `\`${n}.\` ${escapeMd(truncate(t.info.title, 70))} \`${trackDuration(t)}\`${who}`;
  });

  return new EmbedBuilder()
    .setColor(settings.embedColor)
    .setTitle('Queue')
    .setDescription(
      [
        current ? `**Now:** ${escapeMd(truncate(current.info.title, 90))} \`${trackDuration(current)}\`` : '**Now:** nothing',
        '',
        lines.length ? lines.join('\n') : '_The queue is empty._',
      ].join('\n'),
    )
    .setFooter({ text: `Page ${p}/${pages} · ${tracks.length} songs · ${formatDuration(total)}` });
}

/** Returns the reply text/embeds for a user command. Throws UserError for friendly failures. */
export async function runUserCommand(interaction, flags) {
  const { guild, member, options } = interaction;
  const name = interaction.commandName;

  switch (name) {
    case 'play': {
      if (!interaction.deferred) await interaction.deferReply({ flags });
      const content = await music.requestSongs({
        guild,
        member,
        query: options.getString('song', true),
        next: options.getBoolean('next') ?? false,
        textChannelId: interaction.channelId,
      });
      return { content };
    }
    case 'pause':
      return { content: await music.pause(music.assertCanControl(member, 'pause')) };
    case 'resume':
      return { content: await music.resume(music.assertCanControl(member, 'pause')) };
    case 'skip':
      return { content: (await music.skipOrVote(member, options.getInteger('count') ?? 1)).message };
    case 'autoplay': {
      const player = music.assertCanControl(member, 'autoplay');
      const wanted = options.getBoolean('enabled');
      const on = wanted ?? !getSettings(guild.id).autoplay;
      const content = music.setAutoplay(guild.id, on);
      if (on && !player.queue.current && !player.queue.tracks.length && player.queue.previous[0]) {
        await music.autoplayNext(player, player.queue.previous[0]);
        if (player.queue.tracks.length) await player.play({ paused: false });
      }
      return { content };
    }
    case 'effect':
      return { content: await music.applyEffect(music.assertCanControl(member, 'effect'), options.getString('name', true)) };
    case 'previous':
      return { content: await music.previous(music.assertCanControl(member, 'previous')) };
    case 'stop':
      return { content: await music.stop(music.assertCanControl(member, 'stop')) };
    case 'shuffle':
      return { content: await music.shuffle(music.assertCanControl(member, 'shuffle')) };
    case 'loop':
      return { content: await music.setLoop(music.assertCanControl(member, 'loop'), options.getString('mode') ?? undefined) };
    case 'clear':
      return { content: await music.clearQueue(music.assertCanControl(member, 'clear')) };
    case 'leave':
      return { content: await music.leave(music.assertCanControl(member, 'leave')) };
    case 'seek': {
      const ms = parseTime(options.getString('time', true));
      if (ms === null) throw new UserError('I didn\'t understand that time. Try `1:30`, `90` or `2m15s`.');
      return { content: await music.seek(music.assertCanControl(member, 'seek'), ms) };
    }
    case 'remove':
      return {
        content: await music.removeTrack(music.assertCanControl(member, 'remove'), member, options.getInteger('position', true)),
      };
    case 'move':
      return {
        content: await music.moveTrack(
          music.assertCanControl(member, 'move'),
          options.getInteger('from', true),
          options.getInteger('to', true),
        ),
      };
    case 'volume': {
      const level = options.getInteger('level');
      if (level === null) {
        const player = lavalink.getPlayer(guild.id);
        const settings = getSettings(guild.id);
        return {
          content: player
            ? `🔊 Volume is **${player.volume}%** (max ${settings.maxVolume}%).`
            : `🔊 Default volume is **${settings.defaultVolume}%**.`,
        };
      }
      return { content: await music.setVolume(music.assertCanControl(member, 'volume'), level) };
    }
    case 'queue':
      return { embeds: [queueEmbed(guild.id, options.getInteger('page') ?? 1)] };
    case 'nowplaying': {
      const embed = nowPlayingEmbed(guild.id);
      if (!embed) throw new UserError('Nothing is playing right now.');
      return { embeds: [embed] };
    }
    case 'help':
      return { embeds: [helpEmbed(guild.id)] };
    default:
      return null;
  }
}

function helpEmbed(guildId) {
  const settings = getSettings(guildId);
  const where = settings.channelId
    ? `Type a song name or link in <#${settings.channelId}> and it gets queued. The player there updates live.`
    : `An admin can create a Blizzbeat channel with ${commandMention('setup', 'create')}.`;
  return new EmbedBuilder()
    .setColor(settings.embedColor)
    .setTitle('Blizzbeat')
    .setDescription(where)
    .addFields(
      {
        name: 'Playing music',
        value: [
          `${commandMention('play')} song name or URL`,
          `${commandMention('pause')} ${commandMention('resume')} ${commandMention('skip')} ${commandMention('previous')} ${commandMention('stop')}`,
          `${commandMention('volume')} ${commandMention('seek')} ${commandMention('loop')} ${commandMention('leave')}`,
          `${commandMention('autoplay')} ${commandMention('effect')}`,
        ].join('\n'),
      },
      {
        name: 'Queue',
        value: `${commandMention('queue')} ${commandMention('nowplaying')} ${commandMention('shuffle')} ${commandMention('remove')} ${commandMention('move')} ${commandMention('clear')}`,
      },
      {
        name: 'Best sound',
        value: "Keep Blizzbeat at **100%** with no effect: it then sends the original audio with no re-encoding. Use Discord's own slider (right-click Blizzbeat → User Volume) to make it quieter for you.",
      },
      {
        name: 'Admins',
        value: `${commandMention('setup', 'create')} to make the player channel, ${commandMention('config', 'view')} to see every setting.`,
      },
    )
    .setFooter({
      text: `Music engine: ${lavalink.useable ? 'connected ✅' : 'starting or offline ⏳'} · Sources: YouTube${config.spotifyEnabled ? ', Spotify' : ''}, SoundCloud`,
    });
}

/** Live search suggestions while typing in /play. */
export async function autocompletePlay(interaction) {
  const focused = String(interaction.options.getFocused() ?? '').trim();
  if (focused.length < 2 || isUrl(focused) || !lavalink.useable) return interaction.respond([]);

  const node = lavalink.nodeManager.leastUsedNodes()[0];
  if (!node) return interaction.respond([]);

  const settings = getSettings(interaction.guildId);
  let source = settings.searchSource;
  if (source === 'spsearch' && !config.spotifyEnabled) source = 'ytmsearch';
  source = resolveSearchSource(source);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2200));
  const res = await Promise.race([
    node.search({ query: focused, source }, toRequester(interaction.member)).catch(() => null),
    timeout,
  ]);
  const tracks = res?.tracks ?? [];
  const choices = tracks.slice(0, 10).map((t) => {
    const name = truncate(`${t.info.title} · ${t.info.author} (${trackDuration(t)})`, 100);
    const value = t.info.uri && t.info.uri.length <= 100 ? t.info.uri : truncate(`${t.info.title} ${t.info.author}`, 100);
    return { name, value };
  });
  return interaction.respond(choices);
}
