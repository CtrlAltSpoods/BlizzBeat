// Per-server settings, stored in SQLite (Node's built-in node:sqlite).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, 'banners'), { recursive: true });

const db = new DatabaseSync(join(config.dataDir, 'blizzbeat.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS player_sessions (
    guild_id   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favourites (
    user_id   TEXT NOT NULL,
    track_key TEXT NOT NULL,
    data      TEXT NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key)
  );
`);

const selectStmt = db.prepare('SELECT data FROM guild_settings WHERE guild_id = ?');
const upsertStmt = db.prepare(`
  INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const allStmt = db.prepare('SELECT guild_id, data FROM guild_settings');
const deleteStmt = db.prepare('DELETE FROM guild_settings WHERE guild_id = ?');

export function defaultSettings() {
  const d = config.defaults;
  return {
    // Player channel
    channelId: null,
    bannerMessageId: null,
    controllerMessageId: null,
    customBanner: null, // file name inside DATA_DIR/banners
    embedColor: d.embedColor,

    // Audio
    defaultVolume: Math.min(d.defaultVolume, d.maxVolume),
    maxVolume: d.maxVolume,
    searchSource: d.searchSource,

    // Access
    allowedVoiceChannels: [], // empty = any voice channel
    djRoleId: null, // when set, controls need this role (or Manage Server / being alone with the bot)
    requestRoleId: null, // when set, only this role can add songs
    blockedUsers: [],

    // Limits
    maxQueue: d.maxQueue,
    maxSongMinutes: 0, // 0 = no limit
    maxPerUser: 0, // 0 = no limit
    allowPlaylists: true,
    autoplayMood: null, // chill | hype | gaming | focus: steers autoplay
    voiceAccess: false, // channel visible only to people in a voice channel
    voiceAccessUsers: [], // members Blizzbeat gave their own "can see" entry
    bannerAsset: null, // which default banner is posted (so a new default can replace it)
    uploadsEnabled: true, // audio files dropped into the player channel
    uploadMaxMb: 100, // per file; Discord's own upload limit applies too

    // Idle behaviour
    autoLeaveMinutes: d.autoLeaveMinutes,
    stay247: false,

    // Playback extras
    autoplay: false,
    voteSkip: false,
    voteSkipPercent: 50,
    voiceStatus: true,

    // Cooldowns in seconds (0 = off). Admins are never limited.
    requestCooldown: d.requestCooldown,
    controlCooldown: d.controlCooldown,

    settingsVersion: 3,
  };
}

const cache = new Map();

export function getSettings(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  const row = selectStmt.get(guildId);
  let stored = {};
  if (row) {
    try {
      stored = JSON.parse(row.data);
    } catch {
      stored = {};
    }
  }
  const settings = { ...defaultSettings(), ...stored };
  // v2: the old default volume (50%) forced re-encoding; 100% passes YouTube's audio through untouched.
  if (row && !stored.settingsVersion) {
    if (stored.defaultVolume === 50) settings.defaultVolume = Math.min(100, settings.maxVolume);
    settings.settingsVersion = 2;
    upsertStmt.run(guildId, JSON.stringify(settings), Date.now());
  }
  // v3: song names are searched on plain YouTube by default (was YouTube Music).
  if (row && settings.settingsVersion < 3) {
    if (settings.searchSource === 'ytmsearch') settings.searchSource = 'ytsearch';
    settings.settingsVersion = 3;
    upsertStmt.run(guildId, JSON.stringify(settings), Date.now());
  }
  cache.set(guildId, settings);
  return settings;
}

export function updateSettings(guildId, patch) {
  const next = { ...getSettings(guildId), ...patch };
  upsertStmt.run(guildId, JSON.stringify(next), Date.now());
  cache.set(guildId, next);
  return next;
}

/** Reset everything except the player channel wiring. */
export function resetSettings(guildId) {
  const current = getSettings(guildId);
  const next = {
    ...defaultSettings(),
    channelId: current.channelId,
    bannerMessageId: current.bannerMessageId,
    controllerMessageId: current.controllerMessageId,
  };
  upsertStmt.run(guildId, JSON.stringify(next), Date.now());
  cache.set(guildId, next);
  return next;
}

export function deleteSettings(guildId) {
  deleteStmt.run(guildId);
  cache.delete(guildId);
}

export function allConfiguredGuilds() {
  return allStmt
    .all()
    .map((r) => {
      try {
        return { guildId: r.guild_id, settings: { ...defaultSettings(), ...JSON.parse(r.data) } };
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.settings.channelId);
}

export function bannerDir() {
  return join(config.dataDir, 'banners');
}

/* ---------------- Player sessions (survive restarts) ---------------- */

const sessionUpsert = db.prepare(`
  INSERT INTO player_sessions (guild_id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const sessionDelete = db.prepare('DELETE FROM player_sessions WHERE guild_id = ?');
const sessionAll = db.prepare('SELECT guild_id, data, updated_at FROM player_sessions');

export function saveSession(guildId, data) {
  sessionUpsert.run(guildId, JSON.stringify(data), Date.now());
}

export function deleteSession(guildId) {
  sessionDelete.run(guildId);
}

export function loadSessions() {
  return sessionAll
    .all()
    .map((r) => {
      try {
        return { guildId: r.guild_id, updatedAt: r.updated_at, data: JSON.parse(r.data) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* ------------------------------ Favourites (per user, across servers) ------------------------------ */

export const MAX_FAVOURITES = 500;
const favInsert = db.prepare('INSERT OR IGNORE INTO favourites (user_id, track_key, data, added_at) VALUES (?, ?, ?, ?)');
const favDelete = db.prepare('DELETE FROM favourites WHERE user_id = ? AND track_key = ?');
const favClear = db.prepare('DELETE FROM favourites WHERE user_id = ?');
const favList = db.prepare('SELECT track_key, data, added_at FROM favourites WHERE user_id = ? ORDER BY added_at DESC, rowid DESC');
const favCount = db.prepare('SELECT COUNT(*) AS n FROM favourites WHERE user_id = ?');
const favHas = db.prepare('SELECT 1 AS hit FROM favourites WHERE user_id = ? AND track_key = ?');

/** Returns 'added', 'exists' or 'full'. */
export function addFavourite(userId, key, data) {
  if (favHas.get(userId, key)) return 'exists';
  if (favCount.get(userId).n >= MAX_FAVOURITES) return 'full';
  favInsert.run(userId, key, JSON.stringify(data), Date.now());
  return 'added';
}

export function removeFavourite(userId, key) {
  return favDelete.run(userId, key).changes > 0;
}

export function clearFavourites(userId) {
  return favClear.run(userId).changes;
}

export function hasFavourite(userId, key) {
  return Boolean(favHas.get(userId, key));
}

/** Newest first: [{ key, addedAt, ...trackData }] */
export function listFavourites(userId) {
  return favList
    .all(userId)
    .map((r) => {
      try {
        return { key: r.track_key, addedAt: r.added_at, ...JSON.parse(r.data) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
