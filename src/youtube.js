// YouTube sign-in (OAuth device flow) so YouTube stops blocking playback with "Sign in to confirm you're not a bot".
// Mirrors what the youtube-source plugin does, but driven from Discord with /config youtube, and the
// refresh token is saved in /data and pushed to Lavalink on every start.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

// Public client of YouTube's TV app, same as youtube-source uses.
const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';
const SCOPES = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube';

const tokenFile = () => join(config.dataDir, 'youtube-oauth.json');

function lavalinkUrl(path) {
  const { host, port, secure } = config.lavalink;
  return `${secure ? 'https' : 'http'}://${host}:${port}${path}`;
}

async function lavalinkRequest(method, path, body) {
  const res = await fetch(lavalinkUrl(path), {
    method,
    headers: { Authorization: config.lavalink.password, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Lavalink ${method} ${path} -> HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function savedRefreshToken() {
  if (process.env.YOUTUBE_OAUTH_REFRESH_TOKEN) return process.env.YOUTUBE_OAUTH_REFRESH_TOKEN;
  try {
    if (existsSync(tokenFile())) return JSON.parse(readFileSync(tokenFile(), 'utf8')).refreshToken ?? null;
  } catch (err) {
    log.warn('Could not read saved YouTube token:', err.message);
  }
  return null;
}

/** Hands a refresh token to Lavalink's YouTube source (takes effect immediately). */
export async function applyRefreshToken(refreshToken) {
  await lavalinkRequest('POST', '/youtube', { refreshToken, skipInitialization: true });
}

/** Called once Lavalink is up: re-apply the saved token so sign-in survives restarts. */
export async function restoreYoutubeLogin() {
  const token = savedRefreshToken();
  if (!token) return false;
  try {
    await applyRefreshToken(token);
    log.info('YouTube sign-in restored.');
    return true;
  } catch (err) {
    log.warn('Could not restore YouTube sign-in:', err.message);
    return false;
  }
}

export async function youtubeStatus() {
  try {
    const data = await lavalinkRequest('GET', '/youtube');
    return { available: true, signedIn: Boolean(data?.refreshToken) };
  } catch {
    return { available: false, signedIn: false };
  }
}

export function forgetYoutubeLogin() {
  if (existsSync(tokenFile())) unlinkSync(tokenFile());
}

let activeFlow = null;

/** Step 1: ask Google for a code the admin types in at google.com/device. */
export async function requestDeviceCode() {
  const res = await fetch('https://www.youtube.com/o/oauth2/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPES,
      device_id: randomUUID().replace(/-/g, ''),
      device_model: 'ytlr::',
    }),
  });
  if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.user_code || !data.device_code) throw new Error('Google did not return a sign-in code');
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url ?? 'https://www.google.com/device',
    intervalMs: Math.max(5, data.interval ?? 5) * 1000,
    expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
  };
}

async function pollOnce(deviceCode) {
  const res = await fetch('https://www.youtube.com/o/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: deviceCode,
      grant_type: 'http://oauth.net/grant_type/device/1.0',
    }),
  });
  return res.json();
}

/**
 * Starts sign-in. Returns the code to show the admin right away; `done` resolves when the
 * account is linked (or rejects if it's denied / expires).
 */
export async function startYoutubeLogin() {
  if (activeFlow && Date.now() < activeFlow.code.expiresAt) return activeFlow;
  const code = await requestDeviceCode();
  const done = (async () => {
    while (Date.now() < code.expiresAt) {
      await new Promise((r) => setTimeout(r, code.intervalMs));
      let data;
      try {
        data = await pollOnce(code.deviceCode);
      } catch (err) {
        log.debug('YouTube token poll failed:', err.message);
        continue;
      }
      if (data.error === 'authorization_pending' || data.error === 'slow_down') continue;
      if (data.error === 'access_denied') throw new Error('The sign-in was denied.');
      if (data.error === 'expired_token') break;
      if (data.error) throw new Error(`Google said: ${data.error}`);
      if (!data.refresh_token) throw new Error('Google did not return a refresh token.');
      writeFileSync(tokenFile(), JSON.stringify({ refreshToken: data.refresh_token, savedAt: new Date().toISOString() }), {
        mode: 0o600,
      });
      await applyRefreshToken(data.refresh_token);
      log.info('YouTube sign-in completed and saved.');
      return true;
    }
    throw new Error('The sign-in code expired. Run the command again.');
  })().finally(() => {
    activeFlow = null;
  });
  activeFlow = { code, done };
  return activeFlow;
}

/** True when an error from Lavalink looks like YouTube's bot wall / login requirement. */
export function isYoutubeBlock(message) {
  return /sign in to confirm|requires login|not a bot|login required|LOGIN_REQUIRED/i.test(String(message ?? ''));
}

/* ------------------------------ yt-dlp backend ------------------------------ */

const backendFile = () => join(config.dataDir, 'youtube-backend');
export const cookiesFile = () => join(config.dataDir, 'youtube-cookies.txt');

/** "plugin" (Lavalink's YouTube plugin) or "ytdlp". A choice made in Discord wins over YOUTUBE_BACKEND. */
export function youtubeBackend() {
  try {
    const chosen = readFileSync(backendFile(), 'utf8').trim();
    if (chosen === 'ytdlp' || chosen === 'plugin') return chosen;
  } catch {
    /* not chosen in Discord */
  }
  return process.env.YOUTUBE_BACKEND === 'ytdlp' ? 'ytdlp' : 'plugin';
}

export function setYoutubeBackend(backend) {
  writeFileSync(backendFile(), `${backend}\n`);
}

export function hasCookies() {
  try {
    return readFileSync(cookiesFile(), 'utf8').includes('youtube.com');
  } catch {
    return false;
  }
}

/** yt-dlp handles plain YouTube searches only; YouTube Music search needs the plugin. */
export function resolveSearchSource(source) {
  return youtubeBackend() === 'ytdlp' && source === 'ytmsearch' ? 'ytsearch' : source;
}
