// Play anything yt-dlp supports (SoundCloud, Mixcloud, Bandcamp pages, TikTok, X, Reddit, archive.org,
// direct audio links, ~1800 sites). yt-dlp reads the link, ffmpeg turns the audio into Ogg Opus, and a
// small local HTTP server hands that to Lavalink's standard HTTP source. Only URLs signed by the bot are
// served, and only on 127.0.0.1, so Lavalink can't be used to fetch arbitrary addresses.
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { CONTENT_TYPES, UPLOAD_PREFIX, uploadPath } from './uploads.js';

const YTDLP = process.env.YTDLP_PATH || '/usr/local/bin/blizzbeat-yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const MEDIA_PORT = Number(process.env.MEDIA_PROXY_PORT || 2334);
const OPUS_BITRATE = process.env.MEDIA_OPUS_BITRATE || '192k';

/* ------------------------------ signing ------------------------------ */

let secret = null;
function getSecret() {
  if (secret) return secret;
  const file = join(config.dataDir, 'media-secret');
  try {
    if (existsSync(file)) secret = readFileSync(file, 'utf8').trim();
  } catch {
    /* regenerate */
  }
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    try {
      writeFileSync(file, secret, { mode: 0o600 });
    } catch {
      /* in-memory only */
    }
  }
  return secret;
}

const sign = (page) => createHmac('sha256', getSecret()).update(page).digest('base64url');

/** Lavalink-facing URL for a page. Signed (so only the bot can create them) and stateless (survives restarts). */
export function mediaUrl(page, durationMs = 0) {
  const u = Buffer.from(page).toString('base64url');
  return `http://127.0.0.1:${MEDIA_PORT}/media?u=${u}&d=${Math.max(0, Math.round(durationMs || 0))}&s=${sign(page)}`;
}

function verify(page, sig) {
  const a = Buffer.from(sign(page));
  const b = Buffer.from(String(sig ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------ link rules ------------------------------ */

// Sites Lavalink plays natively (and well): these keep using Lavalink's own sources.
const NATIVE_HOSTS = [/(^|\.)youtube\.com$/, /^youtu\.be$/, /(^|\.)spotify\.com$/, /^spotify\.link$/, /(^|\.)bandcamp\.com$/, /(^|\.)twitch\.tv$/, /(^|\.)vimeo\.com$/];

export function isNativeLink(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return NATIVE_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** Refuses links that point into private networks (your LAN, the container itself). */
export async function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid link.");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) links are supported.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('That link points to a private network.');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("I couldn't find that website.");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That link points to a private network.');
}

/* ------------------------------ yt-dlp ------------------------------ */

function ytdlpJson(args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).split('\n').find((l) => l.includes('ERROR')) ?? String(stderr || err.message);
        reject(new Error(msg.replace(/^.*ERROR:\s*/, '').trim().slice(0, 300)));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('yt-dlp returned something unexpected'));
      }
    });
  });
}

const cache = new Map(); // page url -> { media, expires }
const CACHE_MS = 20 * 60_000;

function remember(page, info) {
  if (!info?.url) return;
  cache.set(page, {
    media: { url: info.url, headers: info.http_headers ?? {}, protocol: info.protocol ?? '' },
    expires: Date.now() + CACHE_MS,
  });
  if (cache.size > 500) for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
}

function toItem(info, fallbackUrl) {
  const page = info.webpage_url || info.original_url || info.url || fallbackUrl;
  const thumb = info.thumbnail || info.thumbnails?.at?.(-1)?.url || null;
  return {
    page,
    title: String(info.track || info.title || 'Unknown title').slice(0, 250),
    author: String(info.artist || info.uploader || info.channel || info.creator || info.extractor_key || 'Unknown').slice(0, 120),
    durationMs: info.duration ? Math.round(info.duration * 1000) : 0,
    isLive: Boolean(info.is_live),
    artworkUrl: thumb && /^https?:\/\//.test(thumb) ? thumb : null,
    source: String(info.extractor_key || info.ie_key || info.extractor || 'yt-dlp').toLowerCase().replace(/[^a-z0-9]/g, ''),
  };
}

/**
 * Reads a link with yt-dlp. Returns { playlist: name|null, items: [...] }.
 * Single items also warm the stream cache so playback starts quickly.
 */
export async function resolveLink(url, { maxItems = 500 } = {}) {
  const info = await ytdlpJson(['-J', '--flat-playlist', '--no-warnings', '-f', 'bestaudio/best', '--playlist-end', String(maxItems), url]);
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const items = (info.entries ?? [])
      .filter((e) => e && (e.url || e.webpage_url))
      .map((e) => toItem({ ...e, webpage_url: e.webpage_url || e.url, extractor_key: e.ie_key || info.extractor_key }, e.url));
    return { playlist: info.title || 'Playlist', items };
  }
  const item = toItem(info, url);
  remember(item.page, info);
  if (item.page !== url) remember(url, info);
  return { playlist: null, items: [item] };
}

/** Plain YouTube search through yt-dlp (backup for when Lavalink's yt-dlp search trips over a result). */
export async function searchYoutube(query, limit = 5) {
  const info = await ytdlpJson(['-J', '--flat-playlist', '--no-warnings', `ytsearch${limit}:${query}`]);
  return (info.entries ?? [])
    .filter((e) => e && (e.url || e.id))
    .map((e) =>
      toItem(
        { ...e, webpage_url: e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`, extractor_key: 'youtube' },
        e.url,
      ),
    );
}

async function mediaFor(page) {
  const hit = cache.get(page);
  if (hit && hit.expires > Date.now()) return hit.media;
  const info = await ytdlpJson(['-J', '--no-playlist', '--no-warnings', '-f', 'bestaudio/best', page]);
  remember(page, info);
  return cache.get(page)?.media ?? null;
}

/* ------------------------------ streaming server ------------------------------ */

const DIRECT_PROTOCOLS = new Set(['http', 'https', 'm3u8', 'm3u8_native']);

function ffmpegArgs(input, headers) {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  const h = Object.entries(headers ?? {})
    .filter(([k]) => !/^(accept-encoding|host)$/i.test(k))
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  if (input !== 'pipe:0') {
    if (h) args.push('-headers', h);
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push('-i', input, '-vn', '-map', '0:a:0', '-c:a', 'libopus', '-b:a', OPUS_BITRATE, '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1');
  return args;
}

/** Starts ffmpeg (directly from the media URL, or fed by yt-dlp for protocols ffmpeg can't open). */
function startPipeline(page, media) {
  const procs = [];
  let ffmpeg;
  if (media && DIRECT_PROTOCOLS.has(media.protocol)) {
    ffmpeg = spawn(FFMPEG, ffmpegArgs(media.url, media.headers), { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const dl = spawn(YTDLP, ['-q', '--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-o', '-', page], { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpeg = spawn(FFMPEG, ffmpegArgs('pipe:0'), { stdio: ['pipe', 'pipe', 'pipe'] });
    dl.stdout.pipe(ffmpeg.stdin).on('error', () => null);
    dl.stderr.on('data', (d) => log.debug('[media] yt-dlp:', String(d).trim()));
    procs.push(dl);
  }
  procs.push(ffmpeg);
  let errText = '';
  ffmpeg.stderr.on('data', (d) => {
    errText += String(d);
  });
  return { ffmpeg, kill: () => procs.forEach((p) => p.kill('SIGKILL')), errors: () => errText.trim() };
}

/** Uploaded files are served as-is with Range support, so Lavalink knows the length and can seek. */
function serveUpload(req, res, name) {
  const path = uploadPath(name);
  let size;
  try {
    size = path ? statSync(path).size : -1;
  } catch {
    size = -1;
  }
  if (size < 0) {
    res.writeHead(404).end();
    return;
  }
  const type = CONTENT_TYPES[name.split('.').pop()] ?? 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/media') {
    res.writeHead(404).end();
    return;
  }
  let page;
  try {
    page = Buffer.from(url.searchParams.get('u') ?? '', 'base64url').toString();
  } catch {
    page = '';
  }
  if (!page || !verify(page, url.searchParams.get('s'))) {
    res.writeHead(403).end();
    return;
  }
  if (page.startsWith(UPLOAD_PREFIX)) {
    serveUpload(req, res, page.slice(UPLOAD_PREFIX.length));
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'audio/ogg' }).end();
    return;
  }

  let media = null;
  try {
    media = await mediaFor(page);
  } catch (err) {
    log.warn(`[media] yt-dlp couldn't read ${page}: ${err.message}`);
  }

  const attempt = (m, isRetry) => {
    const pipe = startPipeline(page, m);
    let sent = 0;
    pipe.ffmpeg.stdout.on('data', (chunk) => {
      if (!sent) res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store' });
      sent += chunk.length;
      if (!res.write(chunk)) {
        pipe.ffmpeg.stdout.pause();
        res.once('drain', () => pipe.ffmpeg.stdout.resume());
      }
    });
    pipe.ffmpeg.on('close', (code) => {
      if (sent) {
        res.end();
        return;
      }
      // Nothing produced: a cached direct URL may have expired / been refused. Retry through yt-dlp once.
      if (!isRetry) {
        cache.delete(page);
        log.debug(`[media] direct stream failed (${pipe.errors() || code}); retrying through yt-dlp`);
        attempt(null, true);
        return;
      }
      log.warn(`[media] couldn't stream ${page}: ${pipe.errors() || `ffmpeg exit ${code}`}`);
      if (!res.headersSent) res.writeHead(502).end();
      else res.end();
    });
    req.on('close', () => pipe.kill());
    res.on('error', () => pipe.kill());
  };
  attempt(media, false);
}

let server = null;
export function startMediaServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn('[media] request failed:', err.message);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.on('error', (err) => log.error(`[media] server error: ${err.message}`));
  server.listen(MEDIA_PORT, '127.0.0.1', () => log.info(`[media] yt-dlp media server on 127.0.0.1:${MEDIA_PORT}`));
}
