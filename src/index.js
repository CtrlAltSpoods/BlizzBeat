// Blizzbeat entry point.
import { writeFileSync } from 'node:fs';
import { Events, OAuth2Scopes } from 'discord.js';
import { client, commandIds, lavalink } from './client.js';
import { assertConfig, config } from './config.js';
import { requestUpdate, startProgressTicker } from './controller.js';
import { allConfiguredGuilds } from './db.js';
import { registerDiscordEvents, registerLavalinkEvents } from './events.js';
import { allCommands, handleInteraction, INVITE_PERMISSIONS } from './interactions.js';
import { log } from './logger.js';
import { destroyPlayer } from './music.js';
import { markShuttingDown, restoreSessions, saveAll, startAutosave } from './persistence.js';
import { updatePresence } from './status.js';
import { restoreYoutubeLogin } from './youtube.js';

assertConfig();

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));

registerLavalinkEvents();
registerDiscordEvents();

// Once Lavalink is connected, resume whatever was playing before the last restart.
lavalink.nodeManager.on('connect', () => {
  restoreYoutubeLogin().catch(() => null);
  setTimeout(() => restoreSessions().catch((err) => log.error('Session restore failed:', err)), 1500);
});

client.on(Events.InteractionCreate, (interaction) =>
  handleInteraction(interaction).catch((err) => log.error('Interaction failed:', err)),
);

async function registerCommands() {
  const body = allCommands.map((c) => c.toJSON());
  let registered;
  if (config.devGuildId) {
    const guild = await client.guilds.fetch(config.devGuildId);
    registered = await guild.commands.set(body);
    log.info(`Registered ${registered.size} commands in dev guild ${guild.name}.`);
  } else {
    registered = await client.application.commands.set(body);
    log.info(`Registered ${registered.size} global commands.`);
  }
  for (const cmd of registered.values()) commandIds.set(cmd.name, cmd.id);
}

const HEARTBEAT_FILE = '/tmp/blizzbeat.heartbeat';
function heartbeat() {
  try {
    if (client.isReady()) writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    /* ignore */
  }
}

client.once(Events.ClientReady, async (ready) => {
  log.info(`Logged in as ${ready.user.tag} in ${ready.guilds.cache.size} server(s).`);

  try {
    await lavalink.init({ id: ready.user.id, username: ready.user.username });
  } catch (err) {
    log.error('Lavalink init failed (will keep retrying):', err);
  }

  try {
    await registerCommands();
  } catch (err) {
    log.error('Failed to register slash commands:', err);
  }

  startProgressTicker();
  startAutosave();
  updatePresence();
  for (const { guildId } of allConfiguredGuilds()) {
    if (ready.guilds.cache.has(guildId)) requestUpdate(guildId);
  }

  heartbeat();
  setInterval(heartbeat, 30_000).unref();

  const invite = ready.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: INVITE_PERMISSIONS,
  });
  log.info(`Invite Blizzbeat to a server: ${invite}`);
  if (ready.guilds.cache.size === 0) {
    log.warn('Blizzbeat is not in any server yet. Open the invite link above to add it.');
  } else {
    log.info(`Servers: ${ready.guilds.cache.map((g) => g.name).join(', ')}`);
  }
  log.info('Ready. Slash commands are being handled (each one is logged below).');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down...`);
  const force = setTimeout(() => process.exit(0), 8000);
  force.unref();
  try {
    // Save first so the queue comes back after the restart, then leave voice cleanly.
    markShuttingDown();
    saveAll();
    await Promise.allSettled([...lavalink.players.values()].map((p) => destroyPlayer(p, 'Shutdown')));
    await client.destroy();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

client.login(config.token).catch((err) => {
  if (String(err?.message ?? '').includes('disallowed intents')) {
    log.error(
      'Discord rejected the "Message Content" intent. Enable it in the Developer Portal (Bot > Privileged Gateway Intents) ' +
        'or set ENABLE_MESSAGE_CONTENT=false to run with /play only.',
    );
  } else {
    log.error('Login failed:', err);
  }
  process.exit(1);
});
