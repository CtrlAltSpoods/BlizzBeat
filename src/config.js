// Runtime configuration, read once from environment variables.

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function str(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function hexColor(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  return m ? `#${m[1].toUpperCase()}` : '#5BC0F8';
}

export const config = {
  token: str('DISCORD_TOKEN'),
  // Optional: register commands to one guild instantly while testing.
  devGuildId: str('DEV_GUILD_ID'),

  lavalink: {
    host: str('LAVALINK_HOST', '127.0.0.1'),
    port: int('LAVALINK_PORT', 2333),
    password: str('LAVALINK_PASSWORD', 'youshallnotpass'),
    secure: bool('LAVALINK_SECURE', false),
  },

  // Typing song names in the Blizzbeat channel needs the privileged
  // "Message Content" intent enabled in the Discord developer portal.
  messageContent: bool('ENABLE_MESSAGE_CONTENT', true),

  spotifyEnabled: bool('SPOTIFY_ENABLED', false),

  dataDir: str('DATA_DIR', '/data'),
  assetsDir: str('ASSETS_DIR', new URL('../assets/', import.meta.url).pathname),

  // How often (seconds) the progress bar on the player embed refreshes.
  progressInterval: int('PROGRESS_UPDATE_SECONDS', 10, { min: 5, max: 120 }),

  // Defaults for new servers (each can be changed per server with /config).
  defaults: {
    defaultVolume: int('DEFAULT_VOLUME', 50, { min: 1, max: 150 }),
    maxVolume: int('MAX_VOLUME', 150, { min: 1, max: 200 }),
    maxQueue: int('DEFAULT_MAX_QUEUE', 500, { min: 1, max: 5000 }),
    autoLeaveMinutes: int('DEFAULT_AUTO_LEAVE_MINUTES', 5, { min: 0, max: 1440 }),
    searchSource: str('DEFAULT_SEARCH_SOURCE', 'ytmsearch'),
    embedColor: hexColor(str('DEFAULT_EMBED_COLOR', '5BC0F8')),
    requestCooldown: int('DEFAULT_REQUEST_COOLDOWN', 3, { min: 0, max: 600 }),
    controlCooldown: int('DEFAULT_CONTROL_COOLDOWN', 0, { min: 0, max: 600 }),
  },

  // Ignore saved sessions older than this when restoring after a restart (minutes).
  restoreMaxAgeMinutes: int('RESTORE_MAX_AGE_MINUTES', 60, { min: 0, max: 10080 }),

  logLevel: str('LOG_LEVEL', 'info'),
};

export function assertConfig() {
  if (!config.token) {
    throw new Error('DISCORD_TOKEN is not set. Add it to your .env file.');
  }
}
