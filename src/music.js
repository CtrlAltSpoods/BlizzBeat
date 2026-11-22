// Song requests, playback controls, permission checks and idle handling.
import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { client, commandMention, lavalink, playerHooks, toRequester } from './client.js';
import { config } from './config.js';
import {
  addFavourite,
  getSettings,
  hasFavourite,
  listFavourites,
  MAX_FAVOURITES,
  removeFavourite,
  updateSettings,
} from './db.js';
import { log } from './logger.js';
import { clearVoiceStatus } from './status.js';
import { assertPublicUrl, isNativeLink, lastMediaError, mediaUrl, resolveLink, searchYoutube, warmMedia } from './media.js';
import { forgetLive, liveResumePending } from './live.js';
import { saveAttachment, UPLOAD_PREFIX, UploadError, uploadNameOf } from './uploads.js';
import { resolveSearchSource, youtubeBackend } from './youtube.js';
import { displayUri, escapeMd, formatDuration, isUrl, mediaInfo, trackDuration, trackLength, truncate } from './util/format.js';

/** An error whose message is safe and friendly to show to the user. */
export class UserError extends Error {}

export const SEARCH_SOURCES = {
  ytmsearch: 'YouTube Music',
  ytsearch: 'YouTube',
  scsearch: 'SoundCloud',
  spsearch: 'Spotify',
};

const SPOTIFY_LINK = /^https?:\/\/(open\.spotify\.com|spotify\.link|play\.spotify\.com)\//i;
const SOUNDCLOUD_LINK = /^https?:\/\/((www|m|on)\.)?soundcloud\.(com|app\.goo\.gl)\//i;

/**
 * Title + artist of a SoundCloud link via SoundCloud's public oEmbed endpoint (works for on.soundcloud.com
 * share links too, after following the redirect). Returns null when it can't tell.
 */
async function soundcloudInfo(url) {
  try {
    let target = url;
    if (/^https?:\/\/on\.soundcloud\.com\//i.test(url)) {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
      target = r.url || url;
    }
    const res = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(target.split('?')[0])}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const author = String(data.author_name ?? '').trim();
    let title = String(data.title ?? '').trim();
    if (author && title.toLowerCase().endsWith(` by ${author.toLowerCase()}`)) title = title.slice(0, -(author.length + 4)).trim();
    const isSet = /\/sets\//i.test(target);
    return title ? { title, author, isSet } : null;
  } catch {
    return null;
  }
}

export function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

export function humansIn(channel) {
  if (!channel?.members) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

/* ------------------------------ Cooldowns ------------------------------ */

const cooldowns = new Map(); // `${guildId}:${userId}:${kind}` -> timestamp of last use

/** Throws if the member used `kind` ('request' | 'control') too recently. Admins are exempt. */
export function checkCooldown(member, kind) {
  if (isAdmin(member)) return;
  const settings = getSettings(member.guild.id);
  const seconds = kind === 'request' ? settings.requestCooldown : settings.controlCooldown;
  if (!seconds) return;
  const last = cooldowns.get(`${member.guild.id}:${member.id}:${kind}`) ?? 0;
  const left = Math.ceil((last + seconds * 1000 - Date.now()) / 1000);
  if (left > 0) {
    const what = kind === 'request' ? 'request another song' : 'use the controls again';
    throw new UserError(`Slow down! You can ${what} in ${left}s.`);
  }
}

export function touchCooldown(member, kind) {
  if (isAdmin(member)) return;
  cooldowns.set(`${member.guild.id}:${member.id}:${kind}`, Date.now());
  if (cooldowns.size > 5000) {
    const cutoff = Date.now() - 600_000;
    for (const [key, ts] of cooldowns) if (ts < cutoff) cooldowns.delete(key);
  }
}

/** Leaves voice, clearing the voice channel status first. */
export async function destroyPlayer(player, reason) {
  forgetLive(player.guildId);
  await clearVoiceStatus(player.guildId, player.voiceChannelId).catch(() => null);
  await player.destroy(reason);
}

function playerChannel(player) {
  return player ? client.guilds.cache.get(player.guildId)?.channels.cache.get(player.voiceChannelId) : null;
}

/** DJ check: admins, DJ-role holders, or whoever is alone with the bot. No DJ role set = everyone. */
export function hasDjPower(member, player) {
  const settings = getSettings(member.guild.id);
  if (isAdmin(member) || !settings.djRoleId) return true;
  if (member.roles.cache.has(settings.djRoleId)) return true;
  const vc = playerChannel(player);
  return Boolean(vc?.members.has(member.id) && humansIn(vc) === 1);
}

/**
 * Returns the guild's player if `member` may run `action` on it, otherwise throws a UserError.
 * Actions: pause, skip, stop, previous, shuffle, loop, volume, seek, remove, move, clear, leave.
 */
export function assertCanControl(member, action) {
  const settings = getSettings(member.guild.id);
  const player = lavalink.getPlayer(member.guild.id);
  if (!player) throw new UserError("I'm not playing anything right now.");
  if (settings.blockedUsers.includes(member.id)) throw new UserError("You're blocked from using Blizzbeat on this server.");
  if (!isAdmin(member) && member.voice?.channelId !== player.voiceChannelId) {
    throw new UserError(`Join <#${player.voiceChannelId}> to control the music.`);
  }
  const allowed =
    hasDjPower(member, player) ||
    (action === 'skip' && player.queue.current?.requester?.id === member.id) ||
    action === 'remove'; // own-song check happens in removeTrack
  if (!allowed) throw new UserError(`You need the <@&${settings.djRoleId}> role to do that.`);
  checkCooldown(member, 'control');
  touchCooldown(member, 'control');
  return player;
}

function trackLink(track) {
  const title = escapeMd(truncate(track.info.title, 80));
  const uri = displayUri(track);
  return isUrl(uri) ? `[${title}](<${uri}>)` : title;
}

/** Finds or creates the player for a member's voice channel, enforcing server rules. */
async function playerFor(guild, member, textChannelId) {
  const settings = getSettings(guild.id);
  const vc = member.voice?.channel;
  if (!vc) throw new UserError('Join a voice channel first, then ask again.');
  if (!lavalink.useable) {
    throw new UserError("The music engine (Lavalink) isn't connected yet. If this lasts more than a couple of minutes, check the container logs.");
  }

  let player = lavalink.getPlayer(guild.id);
  if (player && player.voiceChannelId && player.voiceChannelId !== vc.id) {
    const current = playerChannel(player);
    const busy = player.queue.current || player.queue.tracks.length || humansIn(current) > 0;
    if (busy || settings.stay247) throw new UserError(`I'm already playing in <#${player.voiceChannelId}>. Join me there!`);
    await destroyPlayer(player, 'MovingChannels');
    player = null;
  }

  if (!player) {
    if (settings.allowedVoiceChannels.length && !settings.allowedVoiceChannels.includes(vc.id)) {
      const list = settings.allowedVoiceChannels.map((id) => `<#${id}>`).join(', ');
      throw new UserError(`I'm only allowed to join: ${list}`);
    }
    const perms = vc.permissionsFor(guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new UserError(`I need permission to join and speak in <#${vc.id}>.`);
    }
    if (vc.full && !perms.has(PermissionFlagsBits.MoveMembers)) throw new UserError(`<#${vc.id}> is full.`);

    player = lavalink.createPlayer({
      guildId: guild.id,
      voiceChannelId: vc.id,
      textChannelId: settings.channelId ?? textChannelId,
      selfDeaf: true,
      volume: Math.min(settings.defaultVolume, settings.maxVolume),
    });
  }

  if (!player.connected) {
    await player.connect();
    if (vc.type === ChannelType.GuildStageVoice) {
      await guild.members.me.voice.setSuppressed(false).catch(() => null);
    }
  }
  return player;
}

/** A yt-dlp item as a queueable track that Lavalink plays through the bot's media server. */
function toUnresolved(it, requester) {
  return lavalink.utils.buildUnresolvedTrack(
    {
      title: it.title,
      author: it.author,
      duration: it.durationMs,
      uri: mediaUrl(it.page, it.durationMs, it.isLive),
      artworkUrl: it.artworkUrl,
      // Not a searchable source on purpose: if the media server can't serve the song, lavalink-client would
      // otherwise quietly swap in a search result for the same title from another source.
      sourceName: 'blizzbeat',
      identifier: it.page,
      isStream: it.isLive,
      isSeekable: false,
    },
    requester,
  );
}

/** The YouTube video id behind a track (plain YouTube tracks and ones played through the media server). */
export function youtubeIdOf(track) {
  try {
    const u = new URL(displayUri(track));
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (/(^|\.)youtube\.com$/.test(host)) return u.searchParams.get('v') || null;
  } catch {
    /* not a URL */
  }
  const { sourceName, identifier } = track?.info ?? {};
  return ['youtube', 'youtubemusic', 'ytdlp'].includes(sourceName) && /^[\w-]{11}$/.test(identifier ?? '') ? identifier : null;
}

/**
 * YouTube songs that play through the bot's media server, where yt-dlp downloads the audio itself:
 * - yt-dlp mode: all of them (Lavalink fetching yt-dlp's stream URL itself gets "403" from YouTube).
 * - plugin mode: live streams only. youtube-source plays a live from one link that YouTube stops
 *   accepting after ~30 s, so lives end early (youtube-source#242); yt-dlp plays them from YouTube's
 *   HLS stream, which hands out fresh links as it goes.
 * Other tracks are returned unchanged.
 */
function viaMediaServer(track) {
  if (!track?.info || mediaInfo(track.info.uri)) return track;
  if (youtubeBackend() !== 'ytdlp' && !track.info.isStream) return track;
  const id = youtubeIdOf(track);
  if (!id) return track;
  const { info } = track;
  return toUnresolved(
    {
      page: `https://www.youtube.com/watch?v=${id}`,
      title: info.title,
      author: info.author,
      durationMs: info.isStream ? 0 : info.duration,
      isLive: Boolean(info.isStream),
      artworkUrl: info.artworkUrl ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      source: 'youtube',
    },
    track.requester,
  );
}

/** Fetch stream details for a media-server track ahead of time so it starts without a pause. */
export function warmTrack(track) {
  const page = mediaInfo(track?.info?.uri)?.page;
  if (page) warmMedia(page);
}

/** Reads a link with yt-dlp and turns it into queueable tracks that Lavalink plays via the media server. */
async function resolveWithYtdlp(url, settings, requester) {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    throw new UserError(err.message);
  }
  try {
    const { playlist, items } = await resolveLink(url, { maxItems: settings.allowPlaylists ? settings.maxQueue : 1 });
    const tracks = items.map((it) => toUnresolved(it, requester));
    if (!tracks.length) return { loadType: 'empty', tracks: [] };
    return playlist ? { loadType: 'playlist', playlist: { name: playlist }, tracks } : { loadType: 'track', tracks };
  } catch (err) {
    log.info(`yt-dlp couldn't read ${url}: ${err.message}`);
    return { loadType: 'error', exception: { message: err.message }, tracks: [] };
  }
}

/**
 * Handles a song request from /play or from typing in the Blizzbeat channel.
 * Returns a short, user-facing summary.
 */
function assertCanRequest(settings, member) {
  if (settings.blockedUsers.includes(member.id)) throw new UserError("You're blocked from requesting songs on this server.");
  if (settings.requestRoleId && !isAdmin(member) && !member.roles.cache.has(settings.requestRoleId)) {
    throw new UserError(`Only members with <@&${settings.requestRoleId}> can request songs.`);
  }
  checkCooldown(member, 'request');
}

export async function requestSongs({ guild, member, query, next = false, textChannelId }) {
  const settings = getSettings(guild.id);
  const text = String(query ?? '').trim();
  if (!text) throw new UserError('Tell me what to play: a song name or a link.');
  assertCanRequest(settings, member);

  const link = isUrl(text);
  if (link && SPOTIFY_LINK.test(text) && !config.spotifyEnabled) {
    throw new UserError("Spotify links aren't enabled on this Blizzbeat yet (the bot owner needs to add Spotify credentials).");
  }

  const player = await playerFor(guild, member, textChannelId);
  const requester = toRequester(member);

  let source = settings.searchSource;
  if (source === 'spsearch' && !config.spotifyEnabled) source = 'ytmsearch';
  source = resolveSearchSource(source);
  const fallbackSource = resolveSearchSource('ytmsearch');

  let res;
  if (link && !isNativeLink(text)) {
    // Not a site Lavalink plays itself: let yt-dlp handle it (SoundCloud, Mixcloud, TikTok, direct audio, ...).
    res = await resolveWithYtdlp(text, settings, requester);
  } else {
    try {
      res = await player.search(link ? { query: text } : { query: text, source }, requester);
    } catch (err) {
      log.warn('Search failed', err?.message ?? err);
      // In yt-dlp mode the yt-dlp search fallback below gets a chance first.
      if (link || youtubeBackend() !== 'ytdlp') {
        throw new UserError(`I couldn't search for that: ${truncate(err?.message ?? 'unknown error', 150)}`);
      }
      res = { loadType: 'error', exception: { message: err?.message ?? 'search failed' }, tracks: [] };
    }
  }

  // yt-dlp mode: LavaSrc's search occasionally chokes on an odd YouTube result. Search with yt-dlp
  // directly and play through the bot's media server instead.
  const failed = (r) => !r?.loadType || r.loadType === 'error' || r.loadType === 'empty' || !r.tracks?.length;
  if (!link && youtubeBackend() === 'ytdlp' && source === 'ytsearch' && failed(res)) {
    try {
      const items = (await searchYoutube(text, 3)).slice(0, 1);
      if (items.length) {
        log.info(`[${guild.id}] Lavalink yt-dlp search failed; using yt-dlp search directly for "${text}"`);
        res = { loadType: 'search', tracks: items.map((it) => toUnresolved(it, requester)) };
      }
    } catch (err) {
      log.debug('yt-dlp search fallback failed:', err.message);
    }
  }

  // If a non-default search source fails (e.g. SoundCloud is down), try YouTube Music instead.
  if (!link && source !== fallbackSource && (res.loadType === 'error' || res.loadType === 'empty' || !res.tracks?.length)) {
    log.info(`[${guild.id}] ${source} search failed (${res.exception?.message ?? res.loadType}), falling back to ${fallbackSource}`);
    res = await player.search({ query: text, source: fallbackSource }, requester).catch(() => res);
  }

  // SoundCloud links currently fail in Lavalink (SoundCloud's new stream format, lavaplayer #204).
  // Play the same song from YouTube instead, like Spotify links. Only kicks in when SoundCloud fails.
  let mirroredFrom = null;
  if (link && SOUNDCLOUD_LINK.test(text) && (res.loadType === 'error' || !res.tracks?.length)) {
    const sc = await soundcloudInfo(text);
    if (sc?.isSet) {
      throw new UserError("SoundCloud playlists can't be played right now (SoundCloud changed its streaming format and Lavalink hasn't caught up). Single tracks still work.");
    }
    if (sc) {
      const mirror = await player
        .search({ query: `${sc.title} ${sc.author}`.trim(), source: resolveSearchSource('ytmsearch') }, requester)
        .catch(() => null);
      if (mirror?.tracks?.length) {
        res = { ...mirror, loadType: 'track', tracks: [mirror.tracks[0]] };
        mirroredFrom = sc;
        log.info(`[${guild.id}] SoundCloud link failed; playing YouTube match for "${sc.title}" by ${sc.author}`);
      }
    }
  }

  if (res.loadType === 'error') {
    throw new UserError(`I couldn't load that: ${truncate(String(res.exception?.message ?? 'unknown error').split('\n')[0], 200)}`);
  }
  if (res.loadType === 'empty' || !res.tracks?.length) {
    throw new UserError(`No results for **${escapeMd(truncate(text, 80))}**.`);
  }

  const isPlaylist = res.loadType === 'playlist';
  if (isPlaylist && !settings.allowPlaylists) throw new UserError('Playlists are turned off on this server.');
  const notes = [];
  if (mirroredFrom) notes.push("SoundCloud can't stream right now, so this is the same song from YouTube");
  return enqueue({
    guild,
    member,
    player,
    settings,
    next,
    tracks: isPlaylist ? [...res.tracks] : [res.tracks[0]],
    groupName: isPlaylist ? res.playlist?.name ?? 'playlist' : null,
    notes,
  });
}

/** Applies the server's limits, adds the tracks and returns the user-facing summary. */
async function enqueue({ guild, member, player, settings, next, tracks, groupName, notes = [] }) {
  tracks = tracks.map(viaMediaServer);
  let tooLong = 0;
  if (settings.maxSongMinutes > 0) {
    const max = settings.maxSongMinutes * 60_000;
    const before = tracks.length;
    tracks = tracks.filter((t) => !t.info.isStream && trackLength(t) <= max);
    tooLong = before - tracks.length;
    if (!tracks.length) {
      throw new UserError(`That's longer than this server's ${settings.maxSongMinutes}-minute song limit.`);
    }
  }

  const queueSpace = settings.maxQueue - player.queue.tracks.length;
  if (queueSpace <= 0) throw new UserError(`The queue is full (${settings.maxQueue} songs).`);

  let userSpace = Infinity;
  if (settings.maxPerUser > 0 && !isAdmin(member)) {
    const mine = player.queue.tracks.filter((t) => t.requester?.id === member.id).length;
    userSpace = settings.maxPerUser - mine;
    if (userSpace <= 0) throw new UserError(`You already have ${settings.maxPerUser} songs queued. Let some play first!`);
  }

  const allowed = Math.min(queueSpace, userSpace);
  const dropped = Math.max(0, tracks.length - allowed);
  tracks = tracks.slice(0, allowed);

  const startNow = !player.queue.current;
  if (startNow) forgetLive(guild.id); // a new request wins over a live stream waiting to reconnect
  if (startNow || next || player.queue.tracks.length === 0) warmTrack(tracks[0]);
  await player.queue.add(tracks, next && !startNow ? 0 : undefined);
  if (startNow) {
    try {
      await player.play({ paused: false });
    } catch (err) {
      // The first song couldn't be loaded at all (e.g. the media server couldn't fetch it).
      const page = mediaInfo(tracks[0]?.info?.uri)?.page;
      const why = (page && lastMediaError(page)) || 'the audio could not be loaded';
      log.info(`[${guild.id}] couldn't start "${tracks[0]?.info?.title}": ${err?.message ?? err}`);
      if (player.queue.tracks.length) await player.play({ paused: false }).catch(() => null);
      throw new UserError(`I couldn't play **${escapeMd(truncate(tracks[0]?.info?.title ?? 'that', 80))}**: ${truncate(why, 200)}`);
    }
  }
  touchCooldown(member, 'request');
  evaluateIdle(guild.id);

  if (tooLong) notes.push(`${tooLong} skipped for being too long`);
  if (dropped) notes.push(`${dropped} skipped because of queue limits`);
  const noteText = notes.length ? `\n-# ${notes.join(' · ')}` : '';

  if (groupName && tracks.length > 1) {
    const total = tracks.reduce((sum, t) => sum + trackLength(t), 0);
    const name = escapeMd(truncate(groupName, 80));
    return `📃 Added **${tracks.length}** songs from **${name}** (${formatDuration(total)})${noteText}`;
  }
  const track = tracks[0];
  if (startNow) return `▶️ Now playing ${trackLink(track)} \`${trackDuration(track)}\`${noteText}`;
  const position = next ? 1 : player.queue.tracks.length;
  return `🎶 Queued ${trackLink(track)} \`${trackDuration(track)}\` at **#${position}**${noteText}`;
}

/** An uploaded file as a queueable track (played from DATA_DIR/uploads through the media server). */
function uploadTrack(file, requester) {
  const page = `${UPLOAD_PREFIX}${file.name}`;
  return lavalink.utils.buildUnresolvedTrack(
    {
      title: file.title,
      author: file.author,
      duration: file.durationMs,
      uri: mediaUrl(page, file.durationMs),
      artworkUrl: null,
      sourceName: 'upload',
      identifier: page,
      isStream: false,
      isSeekable: true,
    },
    requester,
  );
}

/**
 * Audio files dropped into the Blizzbeat channel. Each file is copied before the message is deleted.
 * Returns a short, user-facing summary; files that couldn't be used are listed underneath.
 */
export async function requestUploads({ guild, member, attachments, textChannelId }) {
  const settings = getSettings(guild.id);
  if (!settings.uploadsEnabled) throw new UserError('Playing uploaded files is turned off on this server.');
  assertCanRequest(settings, member);
  if (!member.voice?.channel) throw new UserError('Join a voice channel first, then drop the file again.');
  if (!lavalink.useable) {
    throw new UserError("The music engine (Lavalink) isn't connected yet. If this lasts more than a couple of minutes, check the container logs.");
  }

  const requester = toRequester(member);
  const maxBytes = settings.uploadMaxMb * 1024 * 1024;
  const tracks = [];
  const problems = [];
  for (const attachment of attachments) {
    try {
      tracks.push(uploadTrack(await saveAttachment(attachment, { maxBytes }), requester));
    } catch (err) {
      if (!(err instanceof UploadError)) log.warn(`[${guild.id}] couldn't save upload ${attachment.name}:`, err?.message ?? err);
      problems.push(err instanceof UploadError ? err.message : `I couldn't save **${escapeMd(truncate(attachment.name, 60))}**.`);
    }
  }
  if (!tracks.length) throw new UserError(problems.join('\n') || "That file doesn't have any audio I can play.");

  const player = await playerFor(guild, member, textChannelId);
  return enqueue({ guild, member, player, settings, next: false, tracks, groupName: 'your files', notes: problems });
}

/* ----------------------------- Favourites ----------------------------- */

/** What gets stored for a favourite: enough to queue the song again later, on any server. */
export function favouriteFromTrack(track) {
  if (!track?.info) throw new UserError('Nothing is playing right now.');
  if (uploadNameOf(track)) {
    throw new UserError("Uploaded files can't be saved to favourites, because they're deleted after they've played.");
  }
  const ytId = youtubeIdOf(track);
  const link = ytId ? `https://www.youtube.com/watch?v=${ytId}` : displayUri(track);
  if (!isUrl(link)) throw new UserError("This song doesn't have a link, so it can't be saved.");
  // Songs from the media server always look like streams to Lavalink; their real length is in the link.
  const media = mediaInfo(track.info.uri);
  const live = media ? media.live || !(media.durationMs > 0) : Boolean(track.info.isStream);
  return {
    key: ytId ? `yt:${ytId}` : `u:${createHash('sha1').update(link).digest('hex').slice(0, 32)}`,
    data: {
      title: String(track.info.title ?? 'Unknown title').slice(0, 250),
      author: String(track.info.author ?? 'Unknown').slice(0, 120),
      link,
      durationMs: live ? 0 : trackLength(track),
      artworkUrl: track.info.artworkUrl ?? null,
      // YouTube links replay through whichever YouTube backend is active; other yt-dlp sites need the media server.
      media: !ytId && Boolean(media),
      source: ytId ? 'youtube' : track.info.sourceName,
      live,
    },
  };
}

function trackFromFavourite(fav, requester) {
  if (fav.media) {
    return toUnresolved(
      { page: fav.link, title: fav.title, author: fav.author, durationMs: fav.durationMs, isLive: fav.live, artworkUrl: fav.artworkUrl },
      requester,
    );
  }
  return lavalink.utils.buildUnresolvedTrack(
    {
      title: fav.title,
      author: fav.author,
      duration: fav.durationMs,
      uri: fav.link,
      artworkUrl: fav.artworkUrl,
      sourceName: fav.source || 'youtube',
      identifier: fav.key.startsWith('yt:') ? fav.key.slice(3) : fav.link,
      isStream: Boolean(fav.live),
      isSeekable: !fav.live,
    },
    requester,
  );
}

/** The ❤️ button: saves the playing song to the member's favourites, or removes it if it's already there. */
export function toggleFavourite(member, guildId) {
  const track = lavalink.getPlayer(guildId)?.queue.current;
  const { key, data } = favouriteFromTrack(track);
  const name = `[${escapeMd(truncate(data.title, 80))}](<${data.link}>)`;
  if (hasFavourite(member.id, key)) {
    removeFavourite(member.id, key);
    return `💔 Removed ${name} from your favourites.`;
  }
  if (addFavourite(member.id, key, data) === 'full') {
    throw new UserError(`You already have ${MAX_FAVOURITES} favourites. Remove some with ${commandMention('favourites', 'remove')} first.`);
  }
  return `❤️ Saved ${name} to your favourites. Play them any time with ${commandMention('favourites', 'play')}.`;
}

/** /favourites play: one saved song (by key) or all of them. */
export async function requestFavourites({ guild, member, key = null, shuffleThem = false, next = false, textChannelId }) {
  const settings = getSettings(guild.id);
  assertCanRequest(settings, member);
  let favs = listFavourites(member.id);
  if (!favs.length) throw new UserError("You haven't saved any favourites yet. Press ❤️ on the player while a song is playing.");
  if (key) {
    favs = favs.filter((f) => f.key === key);
    if (!favs.length) throw new UserError("That song isn't in your favourites. Pick one from the list as you type.");
  } else {
    favs.reverse(); // oldest first, in the order they were saved
    if (shuffleThem) {
      for (let i = favs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [favs[i], favs[j]] = [favs[j], favs[i]];
      }
    }
  }
  const player = await playerFor(guild, member, textChannelId);
  const requester = toRequester(member);
  return enqueue({
    guild,
    member,
    player,
    settings,
    next,
    tracks: favs.map((f) => trackFromFavourite(f, requester)),
    groupName: `${member.displayName}'s favourites`,
  });
}

/* ----------------------------- Controls ----------------------------- */

export async function togglePause(player) {
  if (!player.queue.current) throw new UserError('Nothing is playing.');
  if (player.paused) {
    await player.resume();
    return '▶️ Resumed.';
  }
  await player.pause();
  return '⏸️ Paused.';
}

export async function pause(player) {
  if (!player.queue.current) throw new UserError('Nothing is playing.');
  if (player.paused) return '⏸️ Already paused.';
  await player.pause();
  return '⏸️ Paused.';
}

export async function resume(player) {
  if (!player.queue.current) throw new UserError('Nothing is playing.');
  if (!player.paused) return '▶️ Already playing.';
  await player.resume();
  return '▶️ Resumed.';
}

export async function skip(player, count = 1) {
  const current = player.queue.current;
  if (!current) throw new UserError('Nothing is playing.');
  forgetLive(player.guildId);
  if (!player.queue.tracks.length) {
    const autoplay = getSettings(player.guildId).autoplay;
    if (player.repeatMode === 'queue' || autoplay) {
      // Ends the song normally so loop-queue / autoplay can pick what's next.
      await player.skip(0, false);
      return `⏭️ Skipped ${trackLink(current)}.`;
    }
    await player.stopPlaying(true, false);
    return `⏭️ Skipped ${trackLink(current)}. That was the last song.`;
  }
  const n = Math.min(Math.max(1, count), player.queue.tracks.length);
  await player.skip(n > 1 ? n : 0);
  return n > 1 ? `⏭️ Skipped ${n} songs.` : `⏭️ Skipped ${trackLink(current)}.`;
}

export async function stop(player) {
  forgetLive(player.guildId);
  await player.setRepeatMode('off');
  await player.stopPlaying(true, false);
  evaluateIdle(player.guildId);
  return '⏹️ Stopped and cleared the queue.';
}

export async function previous(player) {
  forgetLive(player.guildId);
  const prev = await player.queue.shiftPrevious();
  if (!prev) throw new UserError('There is no previous song.');
  if (player.queue.current) await player.queue.add(player.queue.current, 0);
  await player.play({ clientTrack: prev, paused: false });
  return `⏮️ Back to ${trackLink(prev)}.`;
}

export async function shuffle(player) {
  if (player.queue.tracks.length < 2) throw new UserError('Need at least 2 songs in the queue to shuffle.');
  await player.queue.shuffle();
  return `🔀 Shuffled ${player.queue.tracks.length} songs.`;
}

const LOOP_ORDER = ['off', 'track', 'queue'];
export const LOOP_LABEL = { off: 'Off', track: 'Song', queue: 'Queue' };

export async function setLoop(player, mode) {
  const next = mode ?? LOOP_ORDER[(LOOP_ORDER.indexOf(player.repeatMode) + 1) % LOOP_ORDER.length];
  await player.setRepeatMode(next);
  return next === 'off' ? '➡️ Loop is off.' : next === 'track' ? '🔂 Looping this song.' : '🔁 Looping the queue.';
}

/**
 * True when Lavalink can send the source's Opus audio to Discord untouched (no decode / re-encode):
 * volume exactly 100% and no effect. Any other volume or effect means re-encoding.
 */
export function isOriginalQuality(player) {
  return player?.volume === 100 && currentEffect(player) === 'off';
}

const QUALITY_TIP = '\n-# Tip: at **100%** Blizzbeat sends the original audio with no re-encoding. To change loudness without losing quality, use Discord\'s own slider (right-click Blizzbeat → User Volume).';

export async function setVolume(player, volume) {
  const settings = getSettings(player.guildId);
  const v = Math.round(Math.min(Math.max(volume, 0), settings.maxVolume));
  await player.setVolume(v);
  return `${v === 0 ? '🔇' : v < 50 ? '🔉' : '🔊'} Volume set to **${v}%**.${v === 100 ? ' 🎧 Original quality.' : QUALITY_TIP}`;
}

export async function seek(player, ms) {
  const track = player.queue.current;
  if (!track) throw new UserError('Nothing is playing.');
  if (!track.info.isSeekable || track.info.isStream) throw new UserError("This song can't be seeked.");
  const target = Math.min(Math.max(ms, 0), trackLength(track) - 1000);
  await player.seek(target);
  return `⏩ Jumped to \`${formatDuration(target)}\`.`;
}

export async function removeTrack(player, member, position) {
  const index = position - 1;
  const track = player.queue.tracks[index];
  if (!track) throw new UserError(`There's no song at position ${position}.`);
  if (!hasDjPower(member, player) && track.requester?.id !== member.id) {
    throw new UserError('You can only remove songs you requested.');
  }
  await player.queue.splice(index, 1);
  return `🗑️ Removed ${trackLink(track)} from the queue.`;
}

export async function moveTrack(player, from, to) {
  const tracks = player.queue.tracks;
  if (from < 1 || from > tracks.length) throw new UserError(`There's no song at position ${from}.`);
  const target = Math.min(Math.max(to, 1), tracks.length);
  const removed = await player.queue.splice(from - 1, 1);
  const track = Array.isArray(removed) ? removed[0] : removed;
  if (!track) throw new UserError('Could not move that song.');
  await player.queue.add(track, target - 1);
  return `↕️ Moved ${trackLink(track)} to **#${target}**.`;
}

export async function clearQueue(player) {
  const n = player.queue.tracks.length;
  if (!n) throw new UserError('The queue is already empty.');
  await player.queue.splice(0, n);
  return `🧹 Cleared ${n} songs from the queue.`;
}

export async function leave(player) {
  await destroyPlayer(player, 'LeaveCommand');
  return '👋 Left the voice channel.';
}

/* --------------------------- Idle handling --------------------------- */

const leaveTimers = new Map();

function clearLeaveTimer(guildId) {
  const t = leaveTimers.get(guildId);
  if (t) clearTimeout(t);
  leaveTimers.delete(guildId);
}

/** Starts or cancels the auto-leave timer depending on whether anyone is listening / anything is queued. */
export function evaluateIdle(guildId) {
  const player = lavalink.getPlayer(guildId);
  const settings = getSettings(guildId);
  if (!player || settings.stay247) return clearLeaveTimer(guildId);

  const vc = playerChannel(player);
  const nobodyListening = humansIn(vc) === 0;
  const nothingQueued = !player.queue.current && player.queue.tracks.length === 0;
  if (!nobodyListening && !nothingQueued) return clearLeaveTimer(guildId);
  if (leaveTimers.has(guildId)) return;

  const minutes = settings.autoLeaveMinutes;
  const ms = nobodyListening ? Math.max(minutes * 60_000, 15_000) : minutes * 60_000;
  leaveTimers.set(
    guildId,
    setTimeout(async () => {
      leaveTimers.delete(guildId);
      const p = lavalink.getPlayer(guildId);
      if (!p) return;
      log.info(`Auto-leaving voice in guild ${guildId} (${nobodyListening ? 'empty channel' : 'queue finished'})`);
      await destroyPlayer(p, 'AutoLeave').catch((err) => log.warn('Auto-leave failed', err));
    }, ms),
  );
}

export function forgetGuild(guildId) {
  clearLeaveTimer(guildId);
  failures.delete(guildId);
}

/* ------------------------------ Vote-skip ------------------------------ */

const votes = new Map(); // guildId -> { key, voters: Set<userId> }

function trackKey(track) {
  return track ? track.encoded ?? `${track.info.identifier}:${track.info.title}` : null;
}

export function clearVotes(guildId) {
  votes.delete(guildId);
}

/** Current vote state for the playing song, or null when there are no votes. */
export function voteStatus(player) {
  const entry = votes.get(player.guildId);
  if (!entry || entry.key !== trackKey(player.queue.current)) return null;
  const vc = playerChannel(player);
  const listeners = humansIn(vc);
  const pct = getSettings(player.guildId).voteSkipPercent;
  const needed = Math.max(1, Math.ceil((listeners * pct) / 100));
  const count = [...entry.voters].filter((id) => vc?.members.has(id)).length;
  return { count, needed };
}

/**
 * Skips straight away for admins, DJs, the song's requester, or someone alone with the bot.
 * With vote-skip on, anyone else adds a vote and the song is skipped once enough listeners agree.
 * Returns { message, voted } where `voted` is true when only a vote was recorded.
 */
export async function skipOrVote(member, count = 1) {
  const settings = getSettings(member.guild.id);
  const player = lavalink.getPlayer(member.guild.id);
  if (!player?.queue.current) throw new UserError('Nothing is playing.');
  if (settings.blockedUsers.includes(member.id)) throw new UserError("You're blocked from using Blizzbeat on this server.");
  if (!isAdmin(member) && member.voice?.channelId !== player.voiceChannelId) {
    throw new UserError(`Join <#${player.voiceChannelId}> to skip.`);
  }

  const vc = playerChannel(player);
  const hasRole = Boolean(settings.djRoleId && member.roles.cache.has(settings.djRoleId));
  const alone = Boolean(vc?.members.has(member.id) && humansIn(vc) === 1);
  const isRequester = player.queue.current.requester?.id === member.id;
  const openControls = !settings.voteSkip && !settings.djRoleId;
  const direct = isAdmin(member) || hasRole || alone || isRequester || openControls;

  checkCooldown(member, 'control');
  touchCooldown(member, 'control');

  if (direct) return { message: await skip(player, count), voted: false };
  if (!settings.voteSkip) throw new UserError(`You need the <@&${settings.djRoleId}> role to skip other people's songs.`);

  const key = trackKey(player.queue.current);
  let entry = votes.get(player.guildId);
  if (!entry || entry.key !== key) {
    entry = { key, voters: new Set() };
    votes.set(player.guildId, entry);
  }
  if (entry.voters.has(member.id)) {
    const st = voteStatus(player);
    return { message: `🗳️ You already voted. **${st.count}/${st.needed}** votes to skip.`, voted: true };
  }
  entry.voters.add(member.id);
  const passed = await checkVotes(player.guildId);
  if (passed) return { message: passed, voted: false };
  const st = voteStatus(player);
  return { message: `🗳️ Vote counted: **${st.count}/${st.needed}** to skip.`, voted: true };
}

/** Skips if the vote threshold is met (also called when people leave the channel). */
export async function checkVotes(guildId) {
  const player = lavalink.getPlayer(guildId);
  if (!player?.queue.current) return null;
  const st = voteStatus(player);
  if (!st || st.count < st.needed) return null;
  const title = trackLink(player.queue.current);
  clearVotes(guildId);
  await skip(player);
  return `⏭️ Vote passed (${st.count}/${st.needed}). Skipped ${title}.`;
}

/* ---------------------------- Audio effects ---------------------------- */

export const EFFECTS = {
  off: { label: 'Off', emoji: '🎚️', description: 'Normal sound' },
  bassboost: { label: 'Bass boost', emoji: '💥', description: 'More low end', apply: (fm) => fm.setEQPreset('BassboostMedium') },
  nightcore: { label: 'Nightcore', emoji: '⚡', description: 'Faster and higher', apply: (fm) => fm.toggleNightcore() },
  vaporwave: { label: 'Slowed', emoji: '🌊', description: 'Slower and deeper', apply: (fm) => fm.toggleVaporwave() },
  eightd: { label: '8D', emoji: '🎧', description: 'Sound circles your head', apply: (fm) => fm.toggleRotation(0.2) },
  karaoke: { label: 'Karaoke', emoji: '🎤', description: 'Tries to remove vocals', apply: (fm) => fm.toggleKaraoke() },
  soft: { label: 'Soft', emoji: '🌙', description: 'Muffled, late-night sound', apply: (fm) => fm.toggleLowPass(20) },
  pop: { label: 'Pop EQ', emoji: '✨', description: 'Brighter mids and highs', apply: (fm) => fm.setEQPreset('Pop') },
};

export function currentEffect(player) {
  return player?.getData('blizzbeat_effect') ?? 'off';
}

export async function applyEffect(player, key) {
  const effect = EFFECTS[key];
  if (!effect) throw new UserError('Unknown effect.');
  const fm = player.filterManager;
  try {
    await fm.resetFilters();
    if (fm.equalizerBands?.length) await fm.clearEQ();
    if (effect.apply) await effect.apply(fm);
  } catch (err) {
    log.warn('Applying effect failed:', err?.message ?? err);
    throw new UserError(`Couldn't apply that effect: ${truncate(err?.message ?? 'unknown error', 120)}`);
  }
  player.setData('blizzbeat_effect', key);
  return key === 'off' ? '🎚️ Effects off.' : `${effect.emoji} **${effect.label}** effect on.`;
}

/* ------------------------------- Autoplay ------------------------------- */

export const AUTOPLAY_REQUESTER = { id: null, username: 'Autoplay', displayName: 'Autoplay', avatar: null, autoplay: true };

export function setAutoplay(guildId, enabled) {
  updateSettings(guildId, { autoplay: enabled });
  return enabled
    ? '📻 Autoplay on: when the queue runs out I\'ll keep playing similar songs.'
    : '📻 Autoplay off.';
}

/**
 * YouTube mixes are mostly music videos (intros, skits, outros). Look for the same song on
 * YouTube Music, which returns the official audio upload, and use it if the length matches.
 */
async function officialAudioFor(player, track, usable) {
  if (track.info.sourceName === 'youtubemusic' || youtubeBackend() === 'ytdlp') return null;
  try {
    const res = await player.search(
      { query: `${track.info.title} ${track.info.author}`, source: 'ytmsearch' },
      AUTOPLAY_REQUESTER,
    );
    const target = track.info.duration;
    return (
      (res?.tracks ?? [])
        .slice(0, 5)
        .find((t) => usable(t) && Math.abs(t.info.duration - target) <= Math.max(20_000, target * 0.12)) ?? null
    );
  } catch {
    return null;
  }
}

// Songs that failed to play, per server (timestamps). Autoplay stops picking when they pile up, so a
// YouTube block doesn't turn into an endless chain of failing songs.
const failures = new Map();
const FAILURE_WINDOW_MS = 3 * 60_000;

export function noteTrackFailure(guildId) {
  const now = Date.now();
  const list = (failures.get(guildId) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  list.push(now);
  failures.set(guildId, list);
}

/** A song played properly for a while: forget earlier failures. */
export function noteTrackSuccess(guildId) {
  failures.delete(guildId);
}

function failingTooOften(guildId) {
  const now = Date.now();
  return (failures.get(guildId) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS).length >= 3;
}

/** lavalink-client calls this when the queue runs dry. Adds one related song if autoplay is on. */
export async function autoplayNext(player, lastTrack) {
  const settings = getSettings(player.guildId);
  if (!settings.autoplay || !lastTrack?.info) return;
  if (humansIn(playerChannel(player)) === 0) return; // nobody is listening

  // A live stream that dropped is about to reconnect: don't pick something else.
  if (liveResumePending(player.guildId)) return;
  if (failingTooOften(player.guildId)) {
    log.info(`[${player.guildId}] autoplay paused: the last few songs all failed to play`);
    playerHooks.onAutoplayPaused?.(player.guildId);
    return;
  }

  const keyOf = (t) => youtubeIdOf(t) ?? t?.info?.identifier;
  const recentIds = new Set([lastTrack, ...player.queue.previous].slice(0, 50).map(keyOf).filter(Boolean));
  const recentTitles = new Set(
    [lastTrack, ...player.queue.previous].slice(0, 50).map((t) => t?.info?.title?.toLowerCase()).filter(Boolean),
  );
  const maxMs = settings.maxSongMinutes > 0 ? settings.maxSongMinutes * 60_000 : 12 * 60_000;
  const usable = (t) =>
    !recentIds.has(keyOf(t)) &&
    !recentTitles.has(t.info.title?.toLowerCase()) &&
    !t.info.isStream &&
    t.info.duration >= 60_000 &&
    t.info.duration <= maxMs;

  const attempts = [];
  // Uploaded files without an artist tag show "Uploaded file" as the artist; don't search for that.
  const author = uploadNameOf(lastTrack) && lastTrack.info.author === 'Uploaded file' ? null : lastTrack.info.author;
  const ytId = youtubeIdOf(lastTrack);
  if (ytId) {
    // YouTube's own "mix" for this video.
    attempts.push({ query: `https://www.youtube.com/watch?v=${ytId}&list=RD${ytId}` });
  }
  const musicSearch = resolveSearchSource('ytmsearch');
  if (author) attempts.push({ query: author, source: musicSearch });
  attempts.push({ query: `${lastTrack.info.title} ${author ?? ''}`.trim(), source: musicSearch });

  for (const q of attempts) {
    try {
      const res = await player.search(q, AUTOPLAY_REQUESTER);
      const pool = (res?.tracks ?? []).filter(usable).slice(0, 8);
      if (!pool.length) continue;
      let pick = pool[Math.floor(Math.random() * pool.length)];
      pick = viaMediaServer((await officialAudioFor(player, pick, usable)) ?? pick);
      warmTrack(pick);
      await player.queue.add(pick);
      log.info(`[${player.guildId}] autoplay picked: ${pick.info.title}`);
      return;
    } catch (err) {
      log.debug('Autoplay search failed:', err?.message ?? err);
    }
  }
  log.info(`[${player.guildId}] autoplay found nothing new after "${lastTrack.info.title}"`);
}
