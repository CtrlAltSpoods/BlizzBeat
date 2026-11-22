// Keeps live streams playing. A live stream has no natural end, so when one stops on its own (the stream
// connection dropped, YouTube rotated its stream URL, Lavalink reported it stuck, yt-dlp exited), it is
// started again after a short pause, instead of the player moving on or going quiet. A person skipping or
// stopping it is respected. Repeated drops back off (1 s, 2 s, 4 s ... 15 s) and give up after too many.
import { log } from './logger.js';
import { mediaInfo } from './util/format.js';

const state = new Map(); // guildId -> { key, track, title, startedAt, stuck, pending, resumes: [] }
const MAX_RESUMES = 8; // within RESUME_WINDOW_MS
const RESUME_WINDOW_MS = 10 * 60_000;
const HEALTHY_MS = 20_000; // played at least this long before dropping

const keyOf = (t) => t?.info?.uri ?? t?.encoded ?? null;

let lavalinkRef = null;
let hooks = {};

/** True for live streams (YouTube lives, radio streams, live links played through the media server). */
export function isLiveTrack(track) {
  const media = mediaInfo(track?.info?.uri);
  if (media) return media.live;
  return Boolean(track?.info?.isStream);
}

/** A person skipped, stopped or replaced the song: don't bring the stream back. */
export function forgetLive(guildId) {
  state.delete(guildId);
}

/** A live stream is playing (or reconnecting) in this server, and drops will be handled here. */
export function liveWatched(guildId, track) {
  const s = state.get(guildId);
  return Boolean(s && (!track || keyOf(track) === s.key));
}

export function liveResumePending(guildId) {
  return Boolean(state.get(guildId)?.pending);
}

function onTrackStart(player, track) {
  const gid = player.guildId;
  const s = state.get(gid);
  if (s?.pending) return; // another song filled in while we wait to bring the stream back
  if (!isLiveTrack(track)) {
    state.delete(gid);
    return;
  }
  if (s && s.key === keyOf(track)) {
    s.startedAt = Date.now();
    s.stuck = false;
    s.track = track;
    return;
  }
  state.set(gid, { key: keyOf(track), track, title: track.info?.title, startedAt: Date.now(), stuck: false, pending: false, resumes: [] });
}

/** Lavalink's raw events arrive before lavalink-client moves the queue on, so this decides first. */
function onRaw(payload) {
  if (payload?.op !== 'event' || !payload.guildId) return;
  const gid = payload.guildId;
  const s = state.get(gid);
  if (!s || s.pending) return;
  const ended = payload.track;
  if (ended && keyOf(ended) !== s.key) return;

  if (payload.type === 'TrackStuckEvent') {
    s.stuck = true;
    log.info(`[${gid}] live stream stalled: ${s.title}`);
    return;
  }
  if (payload.type === 'TrackExceptionEvent') {
    s.stuck = true; // ends with "loadFailed" next
    log.info(`[${gid}] live stream dropped: ${s.title} :: ${payload.exception?.message ?? ''} ${payload.exception?.cause ?? ''}`);
    return;
  }
  if (payload.type !== 'TrackEndEvent') return;

  const reason = payload.reason;
  if (reason === 'cleanup') {
    state.delete(gid);
    return;
  }
  // A plain stop or replace is a person's doing, unless the stream had just stalled or failed.
  const unexpected = s.stuck || reason === 'finished' || reason === 'loadFailed';
  if (!unexpected) {
    state.delete(gid);
    return;
  }

  const now = Date.now();
  // A drop after the stream played fine for a while (YouTube cuts some lives every ~30 s, see
  // youtube-source #242) is reconnected right away and never counts towards giving up. Only drops soon
  // after (re)connecting count, and those back off.
  const healthy = now - s.startedAt >= HEALTHY_MS;
  if (healthy) s.resumes = [];
  s.resumes = s.resumes.filter((t) => now - t < RESUME_WINDOW_MS);
  if (s.resumes.length >= MAX_RESUMES) {
    log.info(`[${gid}] live stream keeps failing to reconnect, giving up: ${s.title}`);
    state.delete(gid);
    hooks.onGiveUp?.(gid, s.title);
    return;
  }
  if (!healthy) s.resumes.push(now);
  s.pending = true;
  const delay = healthy ? 500 : Math.min(15_000, 1000 * 2 ** (s.resumes.length - 1));
  log.info(`[${gid}] live stream ended (${reason}${s.stuck ? ', stalled' : ''}); reconnecting in ${delay / 1000}s: ${s.title}`);
  setTimeout(() => resume(gid, s), delay).unref?.();
}

async function resume(gid, s) {
  const player = lavalinkRef?.getPlayer(gid);
  if (!player || state.get(gid) !== s) return;
  s.pending = false;
  s.stuck = false;
  s.startedAt = Date.now();
  try {
    // Whatever started in the meantime (the next song, an autoplay pick) goes back to the front of the queue.
    const current = player.queue.current;
    if (current && keyOf(current) !== s.key) await player.queue.add(current, 0);
    await player.play({ clientTrack: s.track, noReplace: false, paused: false });
    hooks.onResumed?.(gid, s.title);
  } catch (err) {
    log.warn(`[${gid}] couldn't reconnect the live stream: ${err?.message ?? err}`);
    state.delete(gid);
    hooks.onGiveUp?.(gid, s.title);
  }
}

export function attachLiveKeeper(lavalink, { onGiveUp, onResumed } = {}) {
  lavalinkRef = lavalink;
  hooks = { onGiveUp, onResumed };
  lavalink.nodeManager.on('raw', (_node, payload) => {
    try {
      onRaw(payload);
    } catch (err) {
      log.warn('Live stream keeper error:', err?.message ?? err);
    }
  });
  lavalink.on('trackStart', onTrackStart);
  lavalink.on('playerDestroy', (player) => state.delete(player.guildId));
}
