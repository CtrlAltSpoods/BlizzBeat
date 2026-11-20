export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Parses "90", "1:30", "1:02:03", "1m30s", "2h" into milliseconds. Returns null when invalid. */
export function parseTime(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
    return text.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) * 1000;
  }
  const re = /(\d+)\s*(h|m|s)/g;
  let match;
  let ms = 0;
  let consumed = '';
  while ((match = re.exec(text))) {
    const n = Number(match[1]);
    ms += match[2] === 'h' ? n * 3_600_000 : match[2] === 'm' ? n * 60_000 : n * 1000;
    consumed += match[0];
  }
  return consumed.replace(/\s/g, '') === text.replace(/\s/g, '') && consumed ? ms : null;
}

export function progressBar(position, length, size = 18) {
  if (!length || length <= 0) return '🔴 LIVE';
  const ratio = Math.min(Math.max(position / length, 0), 1);
  const knob = Math.min(Math.round(ratio * size), size - 1);
  return `${'━'.repeat(knob)}●${'─'.repeat(size - knob - 1)}`;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** Removes markdown control characters so titles can't break formatting. */
export function escapeMd(text) {
  return String(text ?? '').replace(/([\\*_`~|[\]()>#-])/g, '\\$1');
}

/** For tracks played through the bot's yt-dlp media server: the original page URL and length. */
export function mediaInfo(uri) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/media\?/.test(String(uri ?? ''))) return null;
  try {
    const u = new URL(uri);
    return { page: Buffer.from(u.searchParams.get('u') ?? '', 'base64url').toString(), durationMs: Number(u.searchParams.get('d')) || 0 };
  } catch {
    return null;
  }
}

/** The link to show people (never the internal media-server address). */
export function displayUri(track) {
  return mediaInfo(track?.info?.uri)?.page ?? track?.info?.uri;
}

/** Length in ms, or 0 for live/unknown. Media-server streams report as live to Lavalink, so use the known length. */
export function trackLength(track) {
  const m = mediaInfo(track?.info?.uri);
  if (m) return m.durationMs;
  return track?.info?.isStream ? 0 : track?.info?.duration ?? 0;
}

export function trackDuration(track) {
  const len = trackLength(track);
  return len ? formatDuration(len) : 'LIVE';
}

export function isUrl(text) {
  return /^https?:\/\/\S+$/i.test(String(text ?? '').trim());
}

export function sourceLabel(sourceName) {
  const map = {
    youtube: 'YouTube',
    youtubemusic: 'YouTube Music',
    soundcloud: 'SoundCloud',
    spotify: 'Spotify',
    bandcamp: 'Bandcamp',
    twitch: 'Twitch',
    vimeo: 'Vimeo',
  };
  return map[sourceName] ?? (sourceName ? sourceName[0].toUpperCase() + sourceName.slice(1) : 'Unknown');
}

export function parseHexColor(input) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(input ?? '').trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}
