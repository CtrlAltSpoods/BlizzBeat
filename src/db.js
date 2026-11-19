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

    // Idle behaviour
    autoLeaveMinutes: d.autoLeaveMinutes,
    stay247: false,
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
