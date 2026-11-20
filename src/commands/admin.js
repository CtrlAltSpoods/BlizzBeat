// Server admin commands: /setup and /config. Require "Manage Server" by default.
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { commandMention, lavalink } from '../client.js';
import { config } from '../config.js';
import { bannerDir, getSettings, resetSettings, updateSettings } from '../db.js';
import { missingChannelPerms, refreshBanner, removeSetup, repost, requestUpdate, setupChannel } from '../controller.js';
import { evaluateIdle, isAdmin, SEARCH_SOURCES, UserError } from '../music.js';
import { clearVoiceStatus, setVoiceStatus } from '../status.js';
import { bufferMs, setBufferMs } from '../engine.js';
import { restartLavalinkWhenIdle, versionSummary, ytdlpVersion } from '../updater.js';
import {
  forgetYoutubeLogin,
  hasCookies,
  setYoutubeBackend,
  startYoutubeLogin,
  youtubeBackend,
  youtubeStatus,
} from '../youtube.js';
import { parseHexColor } from '../util/format.js';

const admin = (b) => b.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild);

const sourceChoices = Object.entries(SEARCH_SOURCES).map(([value, name]) => ({ name, value }));

export const adminCommands = [
  admin(
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Set up the Blizzbeat player channel')
      .addSubcommand((s) =>
        s
          .setName('create')
          .setDescription('Create (or pick) the Blizzbeat channel and post the player')
          .addChannelOption((o) =>
            o
              .setName('channel')
              .setDescription('Use an existing text channel (leave empty to create #blizzbeat)')
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((s) => s.setName('refresh').setDescription('Re-post the banner and player at the bottom of the channel'))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove the Blizzbeat player from its channel')),
  ),
  admin(
    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Blizzbeat server settings')
      .addSubcommand((s) => s.setName('view').setDescription('Show all settings'))
      .addSubcommand((s) =>
        s
          .setName('default-volume')
          .setDescription('Volume Blizzbeat starts at when it joins')
          .addIntegerOption((o) => o.setName('volume').setDescription('1-200').setRequired(true).setMinValue(1).setMaxValue(200)),
      )
      .addSubcommand((s) =>
        s
          .setName('max-volume')
          .setDescription('Highest volume users can set')
          .addIntegerOption((o) => o.setName('volume').setDescription('1-200').setRequired(true).setMinValue(1).setMaxValue(200)),
      )
      .addSubcommandGroup((g) =>
        g
          .setName('voice-channels')
          .setDescription('Limit which voice channels Blizzbeat can join')
          .addSubcommand((s) =>
            s
              .setName('allow')
              .setDescription('Allow a voice channel (once any are allowed, only those can be used)')
              .addChannelOption((o) =>
                o
                  .setName('channel')
                  .setDescription('Voice channel')
                  .setRequired(true)
                  .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
              ),
          )
          .addSubcommand((s) =>
            s
              .setName('disallow')
              .setDescription('Remove a voice channel from the allowed list')
              .addChannelOption((o) =>
                o
                  .setName('channel')
                  .setDescription('Voice channel')
                  .setRequired(true)
                  .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
              ),
          )
          .addSubcommand((s) => s.setName('list').setDescription('Show the allowed voice channels'))
          .addSubcommand((s) => s.setName('clear').setDescription('Allow every voice channel again')),
      )
      .addSubcommand((s) =>
        s
          .setName('dj-role')
          .setDescription('Only this role can skip/stop/etc. (leave empty to let everyone)')
          .addRoleOption((o) => o.setName('role').setDescription('DJ role')),
      )
      .addSubcommand((s) =>
        s
          .setName('request-role')
          .setDescription('Only this role can add songs (leave empty to let everyone)')
          .addRoleOption((o) => o.setName('role').setDescription('Role allowed to request')),
      )
      .addSubcommand((s) =>
        s
          .setName('queue-limit')
          .setDescription('Maximum songs in the queue')
          .addIntegerOption((o) => o.setName('songs').setDescription('1-5000').setRequired(true).setMinValue(1).setMaxValue(5000)),
      )
      .addSubcommand((s) =>
        s
          .setName('user-limit')
          .setDescription('Maximum queued songs per person (0 = no limit)')
          .addIntegerOption((o) => o.setName('songs').setDescription('0-5000').setRequired(true).setMinValue(0).setMaxValue(5000)),
      )
      .addSubcommand((s) =>
        s
          .setName('song-length')
          .setDescription('Longest song allowed, in minutes (0 = no limit)')
          .addIntegerOption((o) => o.setName('minutes').setDescription('0-1440').setRequired(true).setMinValue(0).setMaxValue(1440)),
      )
      .addSubcommand((s) =>
        s
          .setName('playlists')
          .setDescription('Allow or block whole playlists/albums')
          .addBooleanOption((o) => o.setName('enabled').setDescription('Allow playlists').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('auto-leave')
          .setDescription('Minutes to wait before leaving when idle or alone (0 = right away)')
          .addIntegerOption((o) => o.setName('minutes').setDescription('0-1440').setRequired(true).setMinValue(0).setMaxValue(1440)),
      )
      .addSubcommand((s) =>
        s
          .setName('stay-247')
          .setDescription('Stay in voice even when nothing is playing')
          .addBooleanOption((o) => o.setName('enabled').setDescription('24/7 mode').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('vote-skip')
          .setDescription('Let listeners vote to skip songs instead of needing the DJ role')
          .addBooleanOption((o) => o.setName('enabled').setDescription('Vote-skip on/off').setRequired(true))
          .addIntegerOption((o) =>
            o.setName('percent').setDescription('Share of listeners needed to skip (default 50)').setMinValue(1).setMaxValue(100),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('cooldowns')
          .setDescription('Per-person cooldowns in seconds (0 = off, admins are exempt)')
          .addIntegerOption((o) =>
            o.setName('requests').setDescription('Seconds between song requests').setMinValue(0).setMaxValue(600),
          )
          .addIntegerOption((o) =>
            o.setName('controls').setDescription('Seconds between button/command controls').setMinValue(0).setMaxValue(600),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('youtube')
          .setDescription('Sign Blizzbeat in to YouTube (fixes "Sign in to confirm you\'re not a bot")')
          .addStringOption((o) =>
            o
              .setName('action')
              .setDescription('What to do')
              .setRequired(true)
              .addChoices(
                { name: 'Sign in (use a spare Google account)', value: 'login' },
                { name: 'Status', value: 'status' },
                { name: 'Sign out', value: 'logout' },
                { name: 'Play YouTube through yt-dlp', value: 'use-ytdlp' },
                { name: 'Play YouTube through the Lavalink plugin (default)', value: 'use-plugin' },
              ),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('buffer')
          .setDescription('Audio buffer in seconds (all servers; default 1). Bigger = fewer stutters, slower to react')
          .addNumberOption((o) =>
            o.setName('seconds').setDescription('0.2 to 30 (leave empty to see the current value)').setMinValue(0.2).setMaxValue(30),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('voice-status')
          .setDescription("Show the current song as the voice channel's status")
          .addBooleanOption((o) => o.setName('enabled').setDescription('Voice channel status on/off').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('search-source')
          .setDescription('Where song names are searched')
          .addStringOption((o) => o.setName('source').setDescription('Search source').setRequired(true).addChoices(...sourceChoices)),
      )
      .addSubcommand((s) =>
        s
          .setName('banner')
          .setDescription('Change the banner image (leave empty to restore the default)')
          .addAttachmentOption((o) => o.setName('image').setDescription('PNG, JPG, GIF or WebP, up to 8 MB')),
      )
      .addSubcommand((s) =>
        s
          .setName('color')
          .setDescription('Embed accent colour')
          .addStringOption((o) => o.setName('hex').setDescription('e.g. #5BC0F8').setRequired(true).setMaxLength(7)),
      )
      .addSubcommandGroup((g) =>
        g
          .setName('blocklist')
          .setDescription('Stop people from using Blizzbeat')
          .addSubcommand((s) =>
            s
              .setName('add')
              .setDescription('Block a user')
              .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName('remove')
              .setDescription('Unblock a user')
              .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
          )
          .addSubcommand((s) => s.setName('list').setDescription('Show blocked users')),
      )
      .addSubcommand((s) => s.setName('reset').setDescription('Reset all settings to defaults (keeps the channel)')),
  ),
];

/* ------------------------------ Handlers ------------------------------ */

async function runSetup(interaction) {
  const { guild } = interaction;
  const sub = interaction.options.getSubcommand();

  if (sub === 'remove') {
    await removeSetup(guild);
    return { content: '🧹 Removed the Blizzbeat player. The channel itself was left alone.' };
  }

  if (sub === 'refresh') {
    const ok = await repost(guild.id);
    if (!ok) throw new UserError(`There's no Blizzbeat channel yet. Use ${commandMention('setup', 'create')}.`);
    return { content: '🔄 Re-posted the banner and player.' };
  }

  // create
  let channel = interaction.options.getChannel('channel');
  if (!channel) {
    const me = guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError('I need the **Manage Channels** permission to create a channel, or pick an existing one with the `channel` option.');
    }
    channel = await guild.channels.create({
      name: 'blizzbeat',
      type: ChannelType.GuildText,
      topic: '🎵 Type a song name or link here to play it. Use the buttons on the player to control the music.',
      parent: interaction.channel?.parentId ?? undefined,
      permissionOverwrites: [
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ],
      reason: `Blizzbeat setup by ${interaction.user.tag}`,
    });
  }

  const missing = missingChannelPerms(channel);
  if (missing.length) {
    throw new UserError(`I'm missing these permissions in ${channel}: **${missing.join(', ')}**.`);
  }

  await setupChannel(guild, channel);
  const notes = [];
  if (!config.messageContent) {
    notes.push('⚠️ Typing song names in the channel is disabled (`ENABLE_MESSAGE_CONTENT=false`). Members can still use `/play`.');
  }
  return {
    content: [`✅ Blizzbeat is ready in ${channel}! Type a song name there to start.`, ...notes].join('\n'),
  };
}

function settingsEmbed(guildId) {
  const s = getSettings(guildId);
  const list = (ids, fmt) => (ids.length ? ids.map(fmt).join(', ') : 'Any');
  return new EmbedBuilder()
    .setColor(s.embedColor)
    .setTitle('Blizzbeat settings')
    .addFields(
      { name: 'Player channel', value: s.channelId ? `<#${s.channelId}>` : 'Not set up', inline: true },
      { name: 'Default volume', value: `${s.defaultVolume}%`, inline: true },
      { name: 'Max volume', value: `${s.maxVolume}%`, inline: true },
      { name: 'Voice channels', value: list(s.allowedVoiceChannels, (id) => `<#${id}>`), inline: false },
      { name: 'DJ role', value: s.djRoleId ? `<@&${s.djRoleId}>` : 'Everyone', inline: true },
      { name: 'Request role', value: s.requestRoleId ? `<@&${s.requestRoleId}>` : 'Everyone', inline: true },
      { name: 'Search source', value: SEARCH_SOURCES[s.searchSource] ?? s.searchSource, inline: true },
      { name: 'Queue limit', value: String(s.maxQueue), inline: true },
      { name: 'Per-user limit', value: s.maxPerUser ? String(s.maxPerUser) : 'None', inline: true },
      { name: 'Max song length', value: s.maxSongMinutes ? `${s.maxSongMinutes} min` : 'None', inline: true },
      { name: 'Playlists', value: s.allowPlaylists ? 'Allowed' : 'Blocked', inline: true },
      { name: 'Auto-leave', value: s.stay247 ? 'Off (24/7)' : `${s.autoLeaveMinutes} min`, inline: true },
      { name: 'Banner', value: s.customBanner ? 'Custom' : 'Default', inline: true },
      { name: 'Autoplay', value: s.autoplay ? 'On' : 'Off', inline: true },
      { name: 'Vote-skip', value: s.voteSkip ? `On (${s.voteSkipPercent}%)` : 'Off', inline: true },
      { name: 'Voice status', value: s.voiceStatus ? 'On' : 'Off', inline: true },
      {
        name: 'Cooldowns',
        value: `Requests: ${s.requestCooldown ? `${s.requestCooldown}s` : 'off'} · Controls: ${s.controlCooldown ? `${s.controlCooldown}s` : 'off'}`,
        inline: true,
      },
      { name: 'Blocked users', value: s.blockedUsers.length ? s.blockedUsers.map((id) => `<@${id}>`).join(', ') : 'None' },
      { name: 'Audio buffer', value: `${(bufferMs() / 1000).toFixed(1)} s (all servers)`, inline: true },
      { name: 'Versions', value: versionSummary().slice(0, 1024) },
    );
}

const BANNER_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

async function setBanner(guildId, attachment) {
  const current = getSettings(guildId).customBanner;
  const removeOld = () => {
    if (current && existsSync(join(bannerDir(), current))) unlinkSync(join(bannerDir(), current));
  };

  if (!attachment) {
    removeOld();
    updateSettings(guildId, { customBanner: null });
    await refreshBanner(guildId);
    return '🖼️ Banner reset to the Blizzbeat default.';
  }

  const type = (attachment.contentType ?? '').split(';')[0].trim();
  const ext = BANNER_TYPES[type];
  if (!ext) throw new UserError('The banner must be a PNG, JPG, GIF or WebP image.');
  if (attachment.size > 8 * 1024 * 1024) throw new UserError('That image is over 8 MB.');

  const res = await fetch(attachment.url);
  if (!res.ok) throw new UserError("I couldn't download that image. Try uploading it again.");
  const bytes = Buffer.from(await res.arrayBuffer());

  removeOld();
  const fileName = `${guildId}${ext}`;
  writeFileSync(join(bannerDir(), fileName), bytes);
  updateSettings(guildId, { customBanner: fileName });
  const shown = await refreshBanner(guildId);
  return shown ? '🖼️ Banner updated.' : `🖼️ Banner saved. It will show once you run ${commandMention('setup', 'create')}.`;
}

const COOKIE_HELP = [
  '**Giving yt-dlp a YouTube login (cookies):**',
  '1. In a **private/incognito** browser window, sign in to YouTube with a **spare** Google account.',
  '2. Export the cookies for youtube.com in Netscape format, e.g. with the "Get cookies.txt LOCALLY" extension, then close that window without signing out.',
  '3. Save the file as `youtube-cookies.txt` in Blizzbeat\'s data folder (Unraid: `/mnt/user/appdata/blizzbeat/data/`). It\'s picked up on the next song, no restart needed.',
].join('\n');

async function runYoutube(interaction) {
  const action = interaction.options.getString('action', true);
  const backend = youtubeBackend();
  const isBusy = () => [...lavalink.players.values()].some((p) => p.queue.current);

  if (action === 'use-ytdlp' || action === 'use-plugin') {
    const wanted = action === 'use-ytdlp' ? 'ytdlp' : 'plugin';
    if (wanted === backend) {
      return { content: `YouTube is already playing through **${wanted === 'ytdlp' ? 'yt-dlp' : 'the Lavalink plugin'}**.` };
    }
    setYoutubeBackend(wanted);
    const now = restartLavalinkWhenIdle(isBusy);
    const name = wanted === 'ytdlp' ? 'yt-dlp' : 'the Lavalink YouTube plugin';
    const when = now
      ? 'Switching now; the music engine restarts, which takes about 20 seconds.'
      : 'It switches as soon as nothing is playing (the music engine restarts for about 20 seconds).';
    const extra =
      wanted === 'ytdlp'
        ? hasCookies()
          ? '\n✅ Found `youtube-cookies.txt`; yt-dlp will use it.'
          : `\n\nIf YouTube says "confirm you're not a bot", yt-dlp needs cookies:\n${COOKIE_HELP}`
        : '\nThe plugin uses the account from **Sign in** (if you signed in before, it still is).';
    return { content: `🔁 YouTube will play through **${name}**. ${when}${extra}` };
  }

  if (action === 'status') {
    if (backend === 'ytdlp') {
      return {
        content: [
          `▶️ YouTube plays through **yt-dlp ${ytdlpVersion() ?? '(not found!)'}**.`,
          hasCookies()
            ? '🍪 Using `youtube-cookies.txt`.'
            : `🍪 No \`youtube-cookies.txt\`. Fine until YouTube asks to "confirm you're not a bot".\n\n${COOKIE_HELP}`,
          `-# Switch back with ${commandMention('config', 'youtube')} → Lavalink plugin.`,
        ].join('\n'),
      };
    }
    const st = await youtubeStatus();
    if (!st.available) return { content: "⚠️ I can't reach Lavalink's YouTube source right now." };
    return {
      content: [
        '▶️ YouTube plays through the **Lavalink plugin**.',
        st.signedIn
          ? '✅ Signed in to YouTube.'
          : `❌ Not signed in. If songs fail with "Sign in to confirm you're not a bot", run ${commandMention('config', 'youtube')} → Sign in.`,
      ].join('\n'),
    };
  }
  if (action === 'logout') {
    forgetYoutubeLogin();
    return { content: '👋 Removed the saved YouTube sign-in. Restart the container to fully sign out.' };
  }
  if (backend === 'ytdlp') {
    return { content: `ℹ️ YouTube is playing through yt-dlp, which uses a cookies file instead of this sign-in.\n\n${COOKIE_HELP}` };
  }

  const flow = await startYoutubeLogin().catch((err) => {
    throw new UserError(`Couldn't start the YouTube sign-in: ${err.message}`);
  });
  const { userCode, verificationUrl } = flow.code;
  flow.done
    .then(() => interaction.editReply({ content: '✅ **Signed in to YouTube.** Songs should play now, and this survives restarts.' }))
    .catch((err) => interaction.editReply({ content: `❌ YouTube sign-in didn't finish: ${err.message}` }))
    .catch(() => null);
  return {
    content: [
      '**Sign Blizzbeat in to YouTube**',
      `1. Open <${verificationUrl}> (any device).`,
      `2. Enter the code **\`${userCode}\`**`,
      '3. Pick a **spare/burner Google account**, not your main one, and allow access.',
      '',
      "⏳ Waiting for you to finish... this message updates when it's done.",
    ].join('\n'),
  };
}

async function runConfig(interaction) {
  const { guild, options } = interaction;
  const group = options.getSubcommandGroup(false);
  const sub = options.getSubcommand();
  const gid = guild.id;
  const s = getSettings(gid);
  let reply;

  if (group === 'voice-channels') {
    const ch = options.getChannel('channel');
    if (sub === 'allow') {
      updateSettings(gid, { allowedVoiceChannels: [...new Set([...s.allowedVoiceChannels, ch.id])] });
      reply = `✅ ${ch} added. Blizzbeat can now only join: ${getSettings(gid).allowedVoiceChannels.map((id) => `<#${id}>`).join(', ')}`;
    } else if (sub === 'disallow') {
      const next = s.allowedVoiceChannels.filter((id) => id !== ch.id);
      updateSettings(gid, { allowedVoiceChannels: next });
      reply = next.length ? `✅ ${ch} removed. Allowed: ${next.map((id) => `<#${id}>`).join(', ')}` : `✅ ${ch} removed. Blizzbeat can join any voice channel again.`;
    } else if (sub === 'clear') {
      updateSettings(gid, { allowedVoiceChannels: [] });
      reply = '✅ Blizzbeat can join any voice channel.';
    } else {
      reply = s.allowedVoiceChannels.length
        ? `🎧 Allowed voice channels: ${s.allowedVoiceChannels.map((id) => `<#${id}>`).join(', ')}`
        : '🎧 Blizzbeat can join any voice channel.';
    }
    return { content: reply };
  }

  if (group === 'blocklist') {
    if (sub === 'list') {
      return { content: s.blockedUsers.length ? `🚫 Blocked: ${s.blockedUsers.map((id) => `<@${id}>`).join(', ')}` : '🚫 Nobody is blocked.' };
    }
    const user = options.getUser('user', true);
    if (sub === 'add') {
      if (user.bot) throw new UserError("Bots can't use Blizzbeat anyway.");
      updateSettings(gid, { blockedUsers: [...new Set([...s.blockedUsers, user.id])] });
      return { content: `🚫 ${user} can no longer use Blizzbeat here.` };
    }
    updateSettings(gid, { blockedUsers: s.blockedUsers.filter((id) => id !== user.id) });
    return { content: `✅ ${user} can use Blizzbeat again.` };
  }

  switch (sub) {
    case 'view':
      return { embeds: [settingsEmbed(gid)] };
    case 'default-volume': {
      const v = options.getInteger('volume', true);
      if (v > s.maxVolume) throw new UserError(`That's above the max volume (${s.maxVolume}%). Raise it with ${commandMention('config', 'max-volume')} first.`);
      updateSettings(gid, { defaultVolume: v });
      reply = `🔊 Default volume set to **${v}%** (used next time Blizzbeat joins).${v === 100 ? '' : '\n-# Note: only 100% sends the original audio untouched; other levels re-encode it.'}`;
      break;
    }
    case 'max-volume': {
      const v = options.getInteger('volume', true);
      updateSettings(gid, { maxVolume: v, defaultVolume: Math.min(s.defaultVolume, v) });
      const player = lavalink.getPlayer(gid);
      if (player && player.volume > v) await player.setVolume(v);
      reply = `🔊 Max volume set to **${v}%**.`;
      break;
    }
    case 'dj-role': {
      const role = options.getRole('role');
      updateSettings(gid, { djRoleId: role?.id ?? null });
      reply = role
        ? `🎛️ Only ${role} (and admins, or someone alone with the bot) can control playback. Everyone can still request songs and skip their own.`
        : '🎛️ Everyone in the voice channel can control playback.';
      break;
    }
    case 'request-role': {
      const role = options.getRole('role');
      updateSettings(gid, { requestRoleId: role?.id ?? null });
      reply = role ? `🎟️ Only ${role} (and admins) can add songs.` : '🎟️ Everyone can add songs.';
      break;
    }
    case 'queue-limit':
      updateSettings(gid, { maxQueue: options.getInteger('songs', true) });
      reply = `📜 Queue limit set to **${getSettings(gid).maxQueue}** songs.`;
      break;
    case 'user-limit': {
      const n = options.getInteger('songs', true);
      updateSettings(gid, { maxPerUser: n });
      reply = n ? `👤 Each person can queue up to **${n}** songs at a time.` : '👤 No per-person limit.';
      break;
    }
    case 'song-length': {
      const n = options.getInteger('minutes', true);
      updateSettings(gid, { maxSongMinutes: n });
      reply = n ? `⏱️ Songs longer than **${n} min** will be refused (live streams too).` : '⏱️ No song length limit.';
      break;
    }
    case 'playlists': {
      const on = options.getBoolean('enabled', true);
      updateSettings(gid, { allowPlaylists: on });
      reply = on ? '📃 Playlists and albums are allowed.' : '📃 Playlists and albums are blocked; only single songs can be added.';
      break;
    }
    case 'auto-leave': {
      const n = options.getInteger('minutes', true);
      updateSettings(gid, { autoLeaveMinutes: n });
      evaluateIdle(gid);
      reply = n ? `⏳ I'll leave after **${n} min** when the queue ends or everyone leaves.` : "⏳ I'll leave as soon as the queue ends (or 15 s after everyone leaves).";
      if (s.stay247) reply += '\n-# 24/7 mode is on, so this only applies once you turn it off.';
      break;
    }
    case 'stay-247': {
      const on = options.getBoolean('enabled', true);
      updateSettings(gid, { stay247: on });
      evaluateIdle(gid);
      reply = on ? '🌙 24/7 mode on: I stay in voice even when nothing is playing.' : '🌙 24/7 mode off: I leave when idle.';
      break;
    }
    case 'vote-skip': {
      const on = options.getBoolean('enabled', true);
      const pct = options.getInteger('percent') ?? s.voteSkipPercent;
      updateSettings(gid, { voteSkip: on, voteSkipPercent: pct });
      reply = on
        ? `🗳️ Vote-skip on: skipping someone else's song needs **${pct}%** of listeners. Admins${s.djRoleId ? ', DJs' : ''} and the requester skip instantly.`
        : `🗳️ Vote-skip off.${s.djRoleId ? ' Only DJs (and requesters) can skip.' : ' Anyone in the voice channel can skip.'}`;
      break;
    }
    case 'cooldowns': {
      const requests = options.getInteger('requests');
      const controls = options.getInteger('controls');
      const patch = {};
      if (requests !== null) patch.requestCooldown = requests;
      if (controls !== null) patch.controlCooldown = controls;
      const next = updateSettings(gid, patch);
      const fmt = (n) => (n ? `**${n}s**` : '**off**');
      reply = `⏱️ Cooldowns: song requests ${fmt(next.requestCooldown)}, controls ${fmt(next.controlCooldown)}. Admins are never limited.`;
      break;
    }
    case 'voice-status': {
      const on = options.getBoolean('enabled', true);
      updateSettings(gid, { voiceStatus: on });
      const player = lavalink.getPlayer(gid);
      if (player) {
        if (on) await setVoiceStatus(player);
        else await clearVoiceStatus(gid, player.voiceChannelId);
      }
      reply = on
        ? '📢 The voice channel status will show the current song. (Needs the **Set Voice Channel Status** permission.)'
        : '📢 Voice channel status off.';
      break;
    }
    case 'youtube':
      return runYoutube(interaction);
    case 'buffer': {
      const seconds = options.getNumber('seconds');
      const current = bufferMs();
      if (seconds === null) {
        return {
          content: `🎚️ The audio buffer is **${(current / 1000).toFixed(1)} s**. Larger rides out network hiccups; smaller makes volume, effects and skips react faster.`,
        };
      }
      const ms = setBufferMs(seconds * 1000);
      if (ms === current) return { content: `🎚️ The audio buffer is already **${(ms / 1000).toFixed(1)} s**.` };
      const isBusy = () => [...lavalink.players.values()].some((p) => p.queue.current);
      const now = restartLavalinkWhenIdle(isBusy);
      return {
        content:
          `🎚️ Audio buffer set to **${(ms / 1000).toFixed(1)} s** (applies to every server). ` +
          (now
            ? 'Applying now; the music engine restarts for about 20 seconds.'
            : 'It applies as soon as nothing is playing (the music engine restarts for about 20 seconds).'),
      };
    }
    case 'search-source': {
      const src = options.getString('source', true);
      if (src === 'scsearch') {
        updateSettings(gid, { searchSource: src });
        reply = '🔎 Song names will be searched on **SoundCloud**.\n-# Heads-up: SoundCloud changed its streaming format in Nov 2026 and Lavalink can\'t play it yet. Searches fall back to YouTube Music until that\'s fixed upstream.';
        break;
      }
      if (src === 'spsearch' && !config.spotifyEnabled) {
        throw new UserError("Spotify search isn't enabled on this Blizzbeat (the bot owner needs to add Spotify credentials).");
      }
      updateSettings(gid, { searchSource: src });
      reply = `🔎 Song names will be searched on **${SEARCH_SOURCES[src]}**.`;
      break;
    }
    case 'banner':
      reply = await setBanner(gid, options.getAttachment('image'));
      break;
    case 'color': {
      const hex = parseHexColor(options.getString('hex', true));
      if (!hex) throw new UserError('Use a hex colour like `#5BC0F8`.');
      updateSettings(gid, { embedColor: hex });
      reply = `🎨 Embed colour set to **${hex}**.`;
      break;
    }
    case 'reset': {
      const hadBanner = s.customBanner;
      if (hadBanner && existsSync(join(bannerDir(), hadBanner))) unlinkSync(join(bannerDir(), hadBanner));
      resetSettings(gid);
      if (hadBanner) await refreshBanner(gid).catch(() => null);
      evaluateIdle(gid);
      reply = '♻️ All settings are back to defaults. Your Blizzbeat channel was kept.';
      break;
    }
    default:
      return null;
  }

  requestUpdate(gid);
  return { content: reply };
}

export async function runAdminCommand(interaction) {
  if (!isAdmin(interaction.member)) throw new UserError('You need the **Manage Server** permission for this.');
  if (interaction.commandName === 'setup') {
    if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return runSetup(interaction);
  }
  if (interaction.commandName === 'config') {
    if (!interaction.deferred && ['banner', 'youtube'].includes(interaction.options.getSubcommand())) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    return runConfig(interaction);
  }
  return null;
}
