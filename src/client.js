// Discord client + Lavalink manager singletons.
import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';
import { LavalinkManager } from 'lavalink-client';
import { config } from './config.js';

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages];
if (config.messageContent) intents.push(GatewayIntentBits.MessageContent);

export const client = new Client({
  intents,
  partials: [Partials.Channel],
  allowedMentions: { parse: [], repliedUser: false },
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 25,
  }),
});

/** Strips a member/user down to what we need to show "requested by". */
export function toRequester(memberOrUser) {
  if (!memberOrUser) return null;
  const user = memberOrUser.user ?? memberOrUser;
  return {
    id: user.id,
    username: user.username,
    displayName: memberOrUser.displayName ?? user.globalName ?? user.username,
    avatar: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 64 }) : null,
  };
}

/** name -> application command id, filled after registration (used for clickable </play:id> mentions). */
export const commandIds = new Map();

export function commandMention(name, sub) {
  const id = commandIds.get(name);
  const full = sub ? `${name} ${sub}` : name;
  return id ? `</${full}:${id}>` : `\`/${full}\``;
}

/** Set by the controller so any queue change refreshes the player embed. */
export const queueHooks = { onChange: (_guildId) => {} };

class QueueWatcher {
  tracksAdd(guildId) {
    queueHooks.onChange(guildId);
  }
  tracksRemoved(guildId) {
    queueHooks.onChange(guildId);
  }
  shuffled(guildId) {
    queueHooks.onChange(guildId);
  }
}

export const lavalink = new LavalinkManager({
  nodes: [
    {
      id: 'blizzbeat-local',
      host: config.lavalink.host,
      port: config.lavalink.port,
      authorization: config.lavalink.password,
      secure: config.lavalink.secure,
      retryAmount: 1000,
      retryDelay: 5_000,
    },
  ],
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  autoSkipOnResolveError: true,
  emitNewSongsOnly: false,
  playerOptions: {
    defaultSearchPlatform: config.defaults.searchSource,
    applyVolumeAsFilter: false,
    volumeDecrementer: 1,
    requesterTransformer: (r) => (r && typeof r === 'object' && 'id' in r && 'displayName' in r ? r : toRequester(r)),
    onDisconnect: { autoReconnect: false, destroyPlayer: true },
    // Blizzbeat manages its own idle / auto-leave timers per server.
    onEmptyQueue: { destroyAfterMs: undefined },
    useUnresolvedData: true,
    maxErrorsPerTime: { threshold: 10_000, maxAmount: 3 },
  },
  queueOptions: { maxPreviousTracks: 25, queueChangesWatcher: new QueueWatcher() },
  linksAllowed: true,
});
