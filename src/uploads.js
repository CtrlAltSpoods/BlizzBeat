// Audio files dropped into the Blizzbeat channel. Discord removes a message's attachments when the message
// is deleted (and the channel is kept clean), so each file is copied into DATA_DIR/uploads first, checked
// with ffprobe, and served to Lavalink through the bot's media server. Formats Lavalink plays natively are
// kept byte-for-byte (seekable, no quality loss); anything else is remuxed or converted losslessly to FLAC.
// Copies are deleted once no player queue (or saved session) refers to them.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { log } from './logger.js';
import { mediaInfo } from './util/format.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export const UPLOAD_DIR = join(config.dataDir, 'uploads');
export const UPLOAD_PREFIX = 'upload:';
const NAME_RE = /^[a-f0-9]{24}\.(mp3|flac|wav|ogg|m4a)$/;

export const CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
};

export class UploadError extends Error {}

/** Path of an uploaded file from its media-server name, or null if the name isn't one of ours. */
export function uploadPath(name) {
  return NAME_RE.test(String(name ?? '')) ? join(UPLOAD_DIR, name) : null;
}

/** Name of the uploaded file a track plays from (or null). */
export function uploadNameOf(track) {
  const page = mediaInfo(track?.info?.uri)?.page;
  return page?.startsWith(UPLOAD_PREFIX) ? page.slice(UPLOAD_PREFIX.length) : null;
}

/** Quick filter before downloading anything: audio/video MIME type or a known extension. */
export function looksLikeMedia(attachment) {
  const type = String(attachment?.contentType ?? '').toLowerCase();
  if (type.startsWith('audio/') || type.startsWith('video/')) return true;
  return /\.(mp3|flac|wav|wave|ogg|oga|opus|m4a|mp4|m4b|aac|wma|aif|aiff|aifc|alac|ape|wv|mka|mkv|webm|mov|avi|3gp|amr|ac3|dts)$/i.test(
    String(attachment?.name ?? ''),
  );
}

function run(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 300)));
      else resolve(stdout);
    });
  });
}

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 30_000);
  return JSON.parse(out);
}

/** Case-insensitive tag lookup across the container and the audio stream (Ogg/FLAC keep tags on the stream). */
function tag(info, audio, ...keys) {
  for (const tags of [info.format?.tags, audio?.tags]) {
    if (!tags) continue;
    for (const [k, v] of Object.entries(tags)) {
      if (keys.includes(k.toLowerCase()) && String(v).trim()) return String(v).trim();
    }
  }
  return null;
}

/**
 * Works out how to store the file so Lavalink can play it.
 * Returns { ext, args } where args is null when the original can be kept as-is.
 */
function plan(info, audio) {
  const fmt = String(info.format?.format_name ?? '');
  const codec = String(audio.codec_name ?? '');
  const hasVideo = (info.streams ?? []).some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const formats = fmt.split(',');
  const audioOnly = !hasVideo && (info.streams ?? []).filter((s) => s.codec_type === 'audio').length === 1;

  if (audioOnly) {
    if (codec === 'mp3' && formats.includes('mp3')) return { ext: 'mp3', args: null };
    if (codec === 'flac' && formats.includes('flac')) return { ext: 'flac', args: null };
    if (codec === 'pcm_s16le' && formats.includes('wav')) return { ext: 'wav', args: null };
    if ((codec === 'opus' || codec === 'vorbis') && formats.includes('ogg')) return { ext: 'ogg', args: null };
    if (codec === 'aac' && formats.includes('mp4')) return { ext: 'm4a', args: null };
  }
  // Same audio, new container (no re-encoding).
  const pick = ['-vn', '-sn', '-dn', '-map', `0:${audio.index}`, '-map_metadata', '0'];
  if (codec === 'aac') return { ext: 'm4a', args: [...pick, '-c:a', 'copy', '-movflags', '+faststart', '-f', 'ipod'] };
  if (codec === 'mp3') return { ext: 'mp3', args: [...pick, '-c:a', 'copy', '-f', 'mp3'] };
  if (codec === 'opus' || codec === 'vorbis') return { ext: 'ogg', args: [...pick, '-c:a', 'copy', '-f', 'ogg'] };
  // Anything else (ALAC, WMA, AIFF, 24-bit WAV, AC-3, ...): decode and store losslessly as FLAC.
  return { ext: 'flac', args: null, convert: true };
}

const flacArgs = (audio) => {
  const bits = Number(audio.bits_per_raw_sample || audio.bits_per_sample || 16);
  return [
    '-vn', '-sn', '-dn', '-map', `0:${audio.index}`, '-map_metadata', '0',
    '-c:a', 'flac', '-sample_fmt', bits > 16 ? 's32' : 's16', '-compression_level', '5', '-f', 'flac',
  ];
};

function cleanName(fileName) {
  const base = String(fileName ?? 'Uploaded file').replace(/\.[^.]{1,6}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || 'Uploaded file';
}

async function download(url, file, maxBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new UploadError(`Discord wouldn't give me the file (HTTP ${res.status}).`);
  let bytes = 0;
  const limiter = async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new UploadError('That file is bigger than this server allows.');
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body), limiter, createWriteStream(file));
}

/**
 * Copies a Discord attachment into the upload folder and prepares it for playback.
 * Returns { name, title, author, durationMs }.
 */
export async function saveAttachment(attachment, { maxBytes }) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  if (attachment.size > maxBytes) {
    throw new UploadError(`**${cleanName(attachment.name)}** is ${(attachment.size / 1048576).toFixed(1)} MB; this server's limit is ${Math.round(maxBytes / 1048576)} MB.`);
  }
  const id = randomBytes(12).toString('hex');
  const raw = join(UPLOAD_DIR, `${id}.part`);
  const tmpOut = (ext) => join(UPLOAD_DIR, `${id}.tmp.${ext}`);
  const cleanup = [raw];
  try {
    await download(attachment.url, raw, maxBytes);

    let info;
    try {
      info = await probe(raw);
    } catch {
      throw new UploadError(`**${cleanName(attachment.name)}** isn't an audio file I can read.`);
    }
    const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
    if (!audio) throw new UploadError(`**${cleanName(attachment.name)}** has no audio in it.`);

    const durationMs = Math.round(Number(info.format?.duration || audio.duration || 0) * 1000);
    if (!durationMs) throw new UploadError(`**${cleanName(attachment.name)}** has no playable audio.`);

    const p = plan(info, audio);
    let ext = null;
    if (!p.args && !p.convert) {
      renameSync(raw, join(UPLOAD_DIR, `${id}.${p.ext}`));
      ext = p.ext;
    }
    if (!ext && p.args) {
      const out = tmpOut(p.ext);
      cleanup.push(out);
      try {
        await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', raw, ...p.args, out]);
        renameSync(out, join(UPLOAD_DIR, `${id}.${p.ext}`));
        ext = p.ext;
      } catch (err) {
        log.debug(`[upload] remux to ${p.ext} failed (${err.message}); converting to FLAC`);
      }
    }
    if (!ext) {
      const out = tmpOut('flac');
      cleanup.push(out);
      try {
        await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', raw, ...flacArgs(audio), out], 600_000);
      } catch (err) {
        log.info(`[upload] couldn't convert ${attachment.name}: ${err.message}`);
        throw new UploadError(`I couldn't read the audio in **${cleanName(attachment.name)}**.`);
      }
      renameSync(out, join(UPLOAD_DIR, `${id}.flac`));
      ext = 'flac';
    }

    const name = `${id}.${ext}`;
    const title = tag(info, audio, 'title') ?? cleanName(attachment.name);
    const author = tag(info, audio, 'artist', 'album_artist', 'albumartist', 'author') ?? 'Uploaded file';
    log.info(`[upload] saved ${attachment.name} as ${name} (${(statSync(join(UPLOAD_DIR, name)).size / 1048576).toFixed(1)} MB)`);
    return { name, title: title.slice(0, 250), author: author.slice(0, 120), durationMs };
  } finally {
    for (const f of cleanup) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Deletes uploaded files nothing refers to any more. `inUse` is a Set of file names still queued, playing,
 * in history or in a saved session. Files younger than `graceMs` are kept (they may be mid-request).
 */
export function pruneUploads(inUse, graceMs = 10 * 60_000) {
  let entries;
  try {
    entries = readdirSync(UPLOAD_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (inUse.has(name)) continue;
    const path = join(UPLOAD_DIR, name);
    try {
      if (Date.now() - statSync(path).mtimeMs < graceMs) continue;
      unlinkSync(path);
      removed++;
    } catch {
      /* ignore */
    }
  }
  if (removed) log.info(`[upload] removed ${removed} file(s) no longer in any queue`);
  return removed;
}
