// In-container updates for the parts Lavalink downloads at runtime: Lavalink itself, the YouTube plugin
// and LavaSrc. Checked before Lavalink starts (src/updater-cli.js) and daily while running. Updates are
// only ever upgrades over the versions baked into the image, are applied by restarting Lavalink while
// nothing is playing, and are rolled back automatically if Lavalink doesn't come up with them.
// Everything else (bot code, Node packages, yt-cipher, Java) updates through new images.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const VERSIONS_FILE = process.env.VERSIONS_FILE || new URL('../docker/versions.env', import.meta.url).pathname;
const UPDATES_ENV = join(config.dataDir, 'updates.env');
const PREV_ENV = join(config.dataDir, 'updates.prev.env');
const STATE_FILE = join(config.dataDir, 'updates.json');
const JAR_DIR = join(config.dataDir, 'lavalink');
const RESTART_FLAG = '/tmp/lavalink.restart-requested';
const PID_FILE = '/tmp/lavalink.pid';
const SAFE_VALUE = /^[A-Za-z0-9._:/+-]+$/;

const say = (...a) => log.info('[updater]', ...a);
const warn = (...a) => log.warn('[updater]', ...a);

export function autoUpdateEnabled() {
  return !/^(0|false|no|off)$/i.test(process.env.AUTO_UPDATE ?? 'true');
}

/* ------------------------------ files ------------------------------ */

function parseEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function writeEnvFile(file, values) {
  const lines = ['# Written by the Blizzbeat updater. Delete this file to go back to the image defaults.'];
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue;
    if (!SAFE_VALUE.test(v)) throw new Error(`refusing to write unsafe value for ${k}`);
    lines.push(`${k}='${v}'`);
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${lines.join('\n')}\n`);
  renameSync(tmp, file);
}

export function readState() {
  try {
    return { blocked: {}, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { blocked: {} };
  }
}

function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ----------------------------- versions ----------------------------- */

function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function semverGt(a, b) {
  const x = semver(a);
  const y = semver(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const isSnapshot = (v) => /^[0-9a-f]{40}$/.test(String(v ?? ''));

/**
 * The versions Lavalink will actually run: your own env vars win, then updater picks
 * (only if newer than the image's), then the image's versions.
 */
export function effectiveVersions() {
  const base = parseEnvFile(VERSIONS_FILE);
  const auto = parseEnvFile(UPDATES_ENV);
  const env = process.env;

  const lavalinkAuto = auto.AUTO_LAVALINK_VERSION && semverGt(auto.AUTO_LAVALINK_VERSION, base.LAVALINK_VERSION);
  const ytAuto =
    auto.AUTO_YOUTUBE_PLUGIN_VERSION &&
    Date.parse(auto.AUTO_YOUTUBE_PLUGIN_DATE ?? '') > Date.parse(base.YOUTUBE_PLUGIN_DATE ?? '');
  const lavasrcAuto = auto.AUTO_LAVASRC_VERSION && semverGt(auto.AUTO_LAVASRC_VERSION, base.LAVASRC_VERSION);

  return {
    base,
    auto,
    lavalink: { version: lavalinkAuto ? auto.AUTO_LAVALINK_VERSION : base.LAVALINK_VERSION, fromUpdater: Boolean(lavalinkAuto) },
    youtube: {
      version: env.YOUTUBE_PLUGIN_VERSION || (ytAuto ? auto.AUTO_YOUTUBE_PLUGIN_VERSION : base.YOUTUBE_PLUGIN_VERSION),
      date: ytAuto ? auto.AUTO_YOUTUBE_PLUGIN_DATE : base.YOUTUBE_PLUGIN_DATE,
      pinned: Boolean(env.YOUTUBE_PLUGIN_VERSION),
      fromUpdater: Boolean(ytAuto) && !env.YOUTUBE_PLUGIN_VERSION,
    },
    lavasrc: {
      version: env.LAVASRC_VERSION || (lavasrcAuto ? auto.AUTO_LAVASRC_VERSION : base.LAVASRC_VERSION),
      pinned: Boolean(env.LAVASRC_VERSION),
      fromUpdater: Boolean(lavasrcAuto) && !env.LAVASRC_VERSION,
    },
  };
}

/** Rewrites updates.env keeping only picks that are still newer than the image (a newer image wins). */
function pruneUpdates() {
  const v = effectiveVersions();
  const keep = {};
  if (v.lavalink.fromUpdater && existsSync(v.auto.AUTO_LAVALINK_JAR ?? '')) {
    keep.AUTO_LAVALINK_VERSION = v.auto.AUTO_LAVALINK_VERSION;
    keep.AUTO_LAVALINK_JAR = v.auto.AUTO_LAVALINK_JAR;
  }
  if (v.youtube.fromUpdater) {
    keep.AUTO_YOUTUBE_PLUGIN_VERSION = v.auto.AUTO_YOUTUBE_PLUGIN_VERSION;
    keep.AUTO_YOUTUBE_PLUGIN_DATE = v.auto.AUTO_YOUTUBE_PLUGIN_DATE;
  }
  if (v.lavasrc.fromUpdater) keep.AUTO_LAVASRC_VERSION = v.auto.AUTO_LAVASRC_VERSION;

  if (Object.keys(keep).length) writeEnvFile(UPDATES_ENV, keep);
  else if (existsSync(UPDATES_ENV)) unlinkSync(UPDATES_ENV);
  return keep;
}

/* ------------------------------ GitHub ------------------------------ */

async function latestRelease(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'blizzbeat-updater', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${repo}: GitHub returned HTTP ${res.status}`);
  const data = await res.json();
  return { tag: String(data.tag_name ?? ''), publishedAt: data.published_at };
}

async function downloadLavalinkJar(version) {
  mkdirSync(JAR_DIR, { recursive: true });
  const file = join(JAR_DIR, `Lavalink-${version}.jar`);
  if (existsSync(file) && statSync(file).size > 5_000_000) return file;
  const url = `https://github.com/lavalink-devs/Lavalink/releases/download/${version}/Lavalink.jar`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Lavalink ${version} download: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 5_000_000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`Lavalink ${version} download doesn't look like a jar (${bytes.length} bytes)`);
  }
  writeFileSync(`${file}.tmp`, bytes);
  renameSync(`${file}.tmp`, file);
  return file;
}

/* ------------------------------ checking ------------------------------ */

/**
 * Looks for newer releases and, if any, writes them to updates.env (keeping the old file for rollback).
 * Returns a list of human-readable changes. Never throws.
 */
export async function checkForUpdates() {
  const state = readState();
  const isBlocked = (component, version) => (state.blocked?.[component] ?? []).includes(version);
  const v = effectiveVersions();
  const next = { ...pruneUpdates() };
  const changes = [];
  const expect = { lavalink: v.lavalink.version, youtube: v.youtube.version, lavasrc: v.lavasrc.version };

  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      warn(`${name} check failed: ${err.message}`);
    }
  };

  await step('Lavalink', async () => {
    const latest = await latestRelease('lavalink-devs/Lavalink');
    const sameMajor = semver(latest.tag)?.[0] === semver(v.lavalink.version)?.[0];
    if (!sameMajor || !semverGt(latest.tag, v.lavalink.version) || isBlocked('lavalink', latest.tag)) return;
    const jar = await downloadLavalinkJar(latest.tag);
    next.AUTO_LAVALINK_VERSION = latest.tag;
    next.AUTO_LAVALINK_JAR = jar;
    expect.lavalink = latest.tag;
    changes.push({ component: 'lavalink', label: 'Lavalink', from: v.lavalink.version, to: latest.tag });
  });

  await step('YouTube plugin', async () => {
    if (v.youtube.pinned) return;
    const latest = await latestRelease('lavalink-devs/youtube-source');
    const newerDate = Date.parse(latest.publishedAt) > Date.parse(v.youtube.date ?? '');
    const newerVersion = isSnapshot(v.youtube.version) || semverGt(latest.tag, v.youtube.version);
    if (!newerDate || !newerVersion || isBlocked('youtube', latest.tag)) return;
    next.AUTO_YOUTUBE_PLUGIN_VERSION = latest.tag;
    next.AUTO_YOUTUBE_PLUGIN_DATE = latest.publishedAt;
    expect.youtube = latest.tag;
    changes.push({ component: 'youtube', label: 'YouTube plugin', from: v.youtube.version.slice(0, 12), to: latest.tag });
  });

  await step('LavaSrc', async () => {
    if (v.lavasrc.pinned) return;
    const latest = await latestRelease('topi314/LavaSrc');
    if (!semverGt(latest.tag, v.lavasrc.version) || isBlocked('lavasrc', latest.tag)) return;
    next.AUTO_LAVASRC_VERSION = latest.tag;
    expect.lavasrc = latest.tag;
    changes.push({ component: 'lavasrc', label: 'LavaSrc', from: v.lavasrc.version, to: latest.tag });
  });

  state.lastCheck = new Date().toISOString();
  if (changes.length) {
    // Keep what we had so a broken update can be undone.
    if (existsSync(UPDATES_ENV)) writeFileSync(PREV_ENV, readFileSync(UPDATES_ENV));
    else if (existsSync(PREV_ENV)) unlinkSync(PREV_ENV);
    writeEnvFile(UPDATES_ENV, next);
    state.pending = { since: new Date().toISOString(), expect, changes };
    state.lastChanges = changes;
    for (const c of changes) say(`${c.label}: ${c.from} -> ${c.to}`);
  } else {
    say('Everything is up to date.');
  }
  writeState(state);
  return changes;
}

/** Run before Lavalink starts (entrypoint). Cleans up stale picks and checks for updates. */
export async function runLaunchCheck() {
  if (!autoUpdateEnabled()) {
    if (existsSync(UPDATES_ENV)) unlinkSync(UPDATES_ENV);
    say('Auto-update is off (AUTO_UPDATE=false); using the versions in the image.');
    return;
  }
  pruneUpdates();
  await checkForUpdates();
}

/* --------------------------- applying / verifying --------------------------- */

/** Asks the entrypoint's supervisor to restart Lavalink (it regenerates the config with the new versions). */
export function restartLavalink() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    writeFileSync(RESTART_FLAG, String(Date.now()));
    process.kill(pid, 'SIGTERM');
    say('Restarting Lavalink to apply updates...');
    return true;
  } catch (err) {
    warn(`Couldn't restart Lavalink: ${err.message}`);
    return false;
  }
}

function rollback(reason) {
  const state = readState();
  const pending = state.pending;
  if (!pending) return;
  warn(`Update failed (${reason}). Rolling back.`);
  state.blocked ??= {};
  for (const c of pending.changes ?? []) {
    state.blocked[c.component] = [...new Set([...(state.blocked[c.component] ?? []), c.to])];
    warn(`${c.label} ${c.to} won't be tried again until a newer version appears.`);
  }
  if (existsSync(PREV_ENV)) renameSync(PREV_ENV, UPDATES_ENV);
  else if (existsSync(UPDATES_ENV)) unlinkSync(UPDATES_ENV);
  state.pending = null;
  state.lastRollback = { at: new Date().toISOString(), reason, changes: pending.changes };
  writeState(state);
  restartLavalink();
}

let lastInfo = null;
let pendingTimer = null;

/** Called whenever the bot connects to Lavalink: confirms a pending update actually loaded. */
export async function verifyOnConnect(node) {
  try {
    lastInfo = await node.fetchInfo();
  } catch {
    return;
  }
  const state = readState();
  if (!state.pending) return;
  const { expect } = state.pending;
  const plugin = (name) => lastInfo.plugins?.find((p) => p.name === name)?.version;
  const problems = [];
  if (expect.lavalink && lastInfo.version?.semver !== expect.lavalink) {
    problems.push(`Lavalink is ${lastInfo.version?.semver}, expected ${expect.lavalink}`);
  }
  if (expect.youtube && plugin('youtube-plugin') !== expect.youtube) {
    problems.push(`YouTube plugin is ${plugin('youtube-plugin') ?? 'missing'}, expected ${expect.youtube}`);
  }
  if (expect.lavasrc && plugin('lavasrc-plugin') !== expect.lavasrc) {
    problems.push(`LavaSrc is ${plugin('lavasrc-plugin') ?? 'missing'}, expected ${expect.lavasrc}`);
  }
  if (problems.length) {
    rollback(problems.join('; '));
    return;
  }
  say(`Update verified: ${state.pending.changes.map((c) => `${c.label} ${c.to}`).join(', ')}.`);
  state.pending = null;
  state.lastVerified = new Date().toISOString();
  writeState(state);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}

/** If an update is pending and Lavalink never comes up with it, undo it. */
function armPendingTimeout() {
  if (pendingTimer || !readState().pending) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (readState().pending) rollback("Lavalink didn't start with the update within 6 minutes");
  }, 6 * 60_000);
  pendingTimer.unref();
}

/**
 * Daily check while running. `isBusy()` returns true while any server is playing; the Lavalink
 * restart waits until it's false.
 */
export function startDailyUpdates(isBusy) {
  armPendingTimeout();
  if (!autoUpdateEnabled()) return;
  const day = 24 * 60 * 60_000;
  const run = async () => {
    const changes = await checkForUpdates().catch((err) => {
      warn('Daily check failed:', err.message);
      return [];
    });
    if (!changes.length) return;
    const waitForQuiet = setInterval(() => {
      if (isBusy()) return;
      clearInterval(waitForQuiet);
      if (restartLavalink()) armPendingTimeout();
    }, 60_000);
    waitForQuiet.unref();
    say('Will restart Lavalink to apply the update as soon as nothing is playing.');
  };
  setInterval(run, day).unref();
}

/** One-line summary for /config view. */
export function versionSummary() {
  const v = effectiveVersions();
  const state = readState();
  const running = lastInfo
    ? `Lavalink ${lastInfo.version?.semver} · ${(lastInfo.plugins ?? []).map((p) => `${p.name.replace('-plugin', '')} ${String(p.version).slice(0, 12)}`).join(' · ')}`
    : `Lavalink ${v.lavalink.version} · youtube ${String(v.youtube.version).slice(0, 12)} · lavasrc ${v.lavasrc.version}`;
  const auto = autoUpdateEnabled()
    ? `Auto-update on${state.lastCheck ? `, last checked <t:${Math.floor(Date.parse(state.lastCheck) / 1000)}:R>` : ''}`
    : 'Auto-update off';
  const pending = state.pending ? '\n⏳ Update waiting to be applied' : '';
  return `${running}\n${auto}${pending}`;
}
