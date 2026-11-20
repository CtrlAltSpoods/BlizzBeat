// End-to-end smoke test, run inside the Docker image by .github/workflows/smoke.yml.
// Uses the real discord.js, lavalink-client and a running Lavalink. Only Discord itself is faked.
process.env.DATA_DIR ??= '/tmp/blizzbeat-smoke';
process.env.DISCORD_TOKEN ??= 'smoke';

const results = [];
const YTDLP = process.env.YOUTUBE_BACKEND === 'ytdlp';
const ok = (name, detail = '') => results.push({ name, pass: true, detail });
// Known upstream/environment problems (YouTube's datacenter bot wall, SoundCloud's new format) are reported as WARN.
const KNOWN = /sign in to confirm|requires login|not a bot|supported formats|Something went wrong while looking up|status code: 403|playlist does not exist|Read timed out|aborted due to timeout/i;
const bad = (name, detail = '') => results.push({ name, pass: false, warn: KNOWN.test(String(detail)), detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);

const { client, lavalink } = await import('../src/client.js');
const { registerLavalinkEvents, registerDiscordEvents } = await import('../src/events.js');
const { allCommands, handleInteraction } = await import('../src/interactions.js');
const musicMod = await import('../src/music.js');
const ctrl = await import('../src/controller.js');
const db = await import('../src/db.js');
registerLavalinkEvents();
registerDiscordEvents();

// --- slash command definitions are valid
try {
  const json = allCommands.map((c) => c.toJSON());
  ok('slash commands build', `${json.length}: ${json.map((c) => c.name).join(' ')}`);
} catch (err) {
  bad('slash commands build', err.stack);
}

// --- connect to Lavalink
const events = [];
for (const e of ['trackStart', 'trackEnd', 'trackError', 'trackStuck', 'queueEnd', 'playerCreate']) {
  lavalink.on(e, (player, track, payload) =>
    events.push({ e, title: track?.info?.title, err: [payload?.exception?.message ?? payload?.error, payload?.exception?.cause].filter(Boolean).join(' :: ') }),
  );
}
try {
  const connected = new Promise((resolve) => lavalink.nodeManager.once('connect', resolve));
  await lavalink.init({ id: '100000000000000001', username: 'smoke' });
  await withTimeout(connected, 30_000, 'Lavalink connect');
  const node = lavalink.nodeManager.leastUsedNodes()[0];
  const info = await node.fetchInfo();
  ok('lavalink connected', `v${info.version?.semver} sources=${info.sourceManagers.join(',')} plugins=${info.plugins.map((p) => `${p.name}@${p.version}`).join(',')}`);
} catch (err) {
  bad('lavalink connected', err.stack);
}

// --- raw searches on every source
const node = lavalink.nodeManager.leastUsedNodes()[0];
const music = YTDLP ? 'ytsearch' : 'ytmsearch';
const searches = [
  [music, { query: 'rick astley never gonna give you up', source: music }],
  ['ytsearch', { query: 'daft punk get lucky', source: 'ytsearch' }],
  ['scsearch', { query: 'lofi hip hop', source: 'scsearch' }],
  ['youtube url', { query: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
  ['youtube playlist url', { query: 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSU' }],
  ['youtube mix (autoplay)', { query: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ' }],
];
for (const [label, q] of searches) {
  try {
    const res = await withTimeout(node.search(q, { id: '1', displayName: 'smoke' }), 20_000, label);
    if (res.loadType === 'error' || !res.tracks?.length) bad(`search: ${label}`, `${res.loadType} ${res.exception?.message ?? ''}`);
    else ok(`search: ${label}`, `${res.loadType}, ${res.tracks.length} tracks, first="${res.tracks[0].info.title}"`);
  } catch (err) {
    bad(`search: ${label}`, err.message);
  }
}

// --- fake Discord guild / channels / member around the real bot code
const members = new Map();
members.filter = function (fn) {
  return new Map([...this].filter(([, v]) => fn(v)));
};
const perms = { has: () => true };
const voice = { id: '300', type: 2, full: false, members, permissionsFor: () => perms, toString: () => '<#300>' };
const guild = {
  id: '200',
  name: 'Smoke',
  shard: { send: (payload) => events.push({ e: 'gateway-send', op: payload.op }) },
  members: { me: { id: '100000000000000001', permissions: perms, voice: { setSuppressed: async () => {} } }, fetch: async () => member },
  channels: { cache: new Map([['300', voice]]) },
};
const member = {
  id: '400',
  guild,
  user: { id: '400', username: 'tester', bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
  displayName: 'Tester',
  permissions: { has: () => true },
  roles: { cache: new Map() },
  voice: { channel: voice, channelId: '300' },
  toString: () => '<@400>',
};
members.set('400', member);
client.guilds.cache.set('200', guild);

const posted = [];
const textChannel = {
  id: '500',
  guild,
  isTextBased: () => true,
  permissionsFor: () => perms,
  toString: () => '<#500>',
  async send(payload) {
    const msg = { id: `m${posted.length}`, payload, edits: 0, async edit(p) { msg.payload = p; msg.edits++; }, async delete() { msg.deleted = true; } };
    posted.push(msg);
    return msg;
  },
  messages: {
    async fetch(id) {
      const m = posted.find((x) => x.id === id && !x.deleted);
      if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return m;
    },
  },
};
client.channels.cache.set('500', textChannel);
db.updateSettings('200', { requestCooldown: 0 });

try {
  await ctrl.setupChannel(guild, textChannel);
  ok('player channel setup', `${posted.length} messages posted (banner + player)`);
} catch (err) {
  bad('player channel setup', err.stack);
}

// --- interaction handling (what happens when someone runs a slash command)
function fakeInteraction(commandName, opts = {}, sub = null) {
  const out = { replies: [] };
  return {
    out,
    commandName,
    guildId: '200',
    channelId: '999',
    guild,
    member,
    user: member.user,
    channel: { parentId: null },
    deferred: false,
    replied: false,
    createdTimestamp: Date.now(),
    isRepliable: () => true,
    inCachedGuild: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => true,
    options: {
      getString: (n) => opts[n] ?? null,
      getBoolean: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
      getSubcommand: () => sub,
      getSubcommandGroup: () => null,
    },
    async deferReply() { this.deferred = true; },
    async reply(d) { this.replied = true; out.replies.push(d); },
    async editReply(d) { out.replies.push(d); },
    async followUp(d) { out.replies.push(d); },
    async deleteReply() {},
  };
}

for (const [name, opts, sub] of [['help', {}], ['config', {}, 'view'], ['queue', {}]]) {
  const i = fakeInteraction(name, opts, sub);
  try {
    await withTimeout(handleInteraction(i), 10_000, `/${name}`);
    const r = i.out.replies.at(-1);
    if (!r) bad(`/${name} replies`, 'no reply sent');
    else if (String(r.content ?? '').startsWith('❌')) bad(`/${name} replies`, r.content);
    else ok(`/${name} replies`, r.content ? r.content.slice(0, 80) : `${r.embeds?.length ?? 0} embed(s)`);
  } catch (err) {
    bad(`/${name} replies`, err.stack);
  }
}

// --- /play end to end: search, queue, and ask Lavalink to play
const play = fakeInteraction('play', { song: 'rick astley never gonna give you up' });
try {
  await withTimeout(handleInteraction(play), 30_000, '/play');
  const r = play.out.replies.at(-1);
  const text = r?.content ?? JSON.stringify(r);
  if (!r || text.startsWith('❌')) bad('/play replies', text);
  else ok('/play replies', text.slice(0, 120));
} catch (err) {
  bad('/play replies', err.stack);
}

// --- SoundCloud link: plays directly, or falls back to the same song from YouTube
const sc = fakeInteraction('play', { song: 'https://soundcloud.com/forss/flickermood' });
try {
  await withTimeout(handleInteraction(sc), 40_000, '/play soundcloud');
  const text = sc.out.replies.at(-1)?.content ?? '';
  (text && !text.startsWith('❌') ? ok : bad)('/play SoundCloud link', text.replace(/\n/g, ' ').slice(0, 160));
} catch (err) {
  bad('/play SoundCloud link', err.message);
}

const player = lavalink.getPlayer('200');
if (player) {
  ok('player created', `vc=${player.voiceChannelId} volume=${player.volume} current="${player.queue.current?.info?.title ?? '-'}"`);
  // Without a real Discord voice connection Lavalink can't send audio, but it still loads the stream.
  await sleep(12_000);
  const started = events.find((e) => e.e === 'trackStart');
  const failed = events.find((e) => e.e === 'trackError' || e.e === 'trackStuck');
  if (failed) bad('lavalink loads the stream', `${failed.e}: ${failed.err}`);
  else if (started) ok('lavalink loads the stream', `trackStart "${started.title}"`);
  else bad('lavalink loads the stream', `no trackStart within 12s; events=${JSON.stringify(events.filter((e) => e.e !== 'gateway-send'))}`);
  const sentVoice = events.some((e) => e.e === 'gateway-send' && e.op === 4);
  (sentVoice ? ok : bad)('voice join sent to Discord gateway', sentVoice ? 'op 4 sent' : 'no op 4 voice state update sent');

  // controls
  for (const [label, fn] of [
    ['pause', () => musicMod.pause(player)],
    ['resume', () => musicMod.resume(player)],
    ['effect bassboost', () => musicMod.applyEffect(player, 'bassboost')],
    ['effect off', () => musicMod.applyEffect(player, 'off')],
    ['volume', () => musicMod.setVolume(player, 70)],
  ]) {
    try {
      ok(`control: ${label}`, await withTimeout(fn(), 10_000, label));
    } catch (err) {
      bad(`control: ${label}`, err.message);
    }
  }
} else {
  bad('player created', 'no player after /play');
}

await sleep(2500);
const controller = posted.find((m) => m.payload?.components && !m.deleted);
try {
  const embed = controller.payload.embeds[0].toJSON();
  const rows = controller.payload.components.map((r) => r.toJSON());
  ok('player embed renders', `title="${embed.title}" fields=${embed.fields?.length ?? 0} rows=${rows.length} edits=${controller.edits}`);
} catch (err) {
  bad('player embed renders', err.stack);
}

// --- playback probe: can Lavalink actually open the audio stream for several songs?
const probes = [
  ['youtube: rick astley', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['youtube: queen', 'ytsearch:queen bohemian rhapsody'],
  [`${music}: daft punk`, `${music}:daft punk get lucky`],
  ['soundcloud url', 'https://soundcloud.com/forss/flickermood'],
];
let probeGuild = 700;
for (const [label, query] of probes) {
  const gid = String(probeGuild++);
  try {
    const p = lavalink.createPlayer({ guildId: gid, voiceChannelId: '301', volume: 50 });
    const res = await withTimeout(p.search({ query }, { id: '1', displayName: 'probe' }), 20_000, label);
    const track = res.tracks?.[0];
    if (!track) {
      bad(`stream: ${label}`, `no track (${res.loadType} ${res.exception?.message ?? ''})`);
      continue;
    }
    const outcome = new Promise((resolve) => {
      const onErr = (pl, t, payload) =>
        pl.guildId === gid &&
        resolve(`error: ${[(payload?.exception?.message ?? '').split('\n').slice(0, 4).join(' | '), payload?.exception?.cause].filter(Boolean).join(' :: ')}`);
      lavalink.on('trackError', onErr);
      setTimeout(() => resolve('ok'), 10_000);
    });
    await p.play({ clientTrack: track });
    const r = await outcome;
    (r === 'ok' ? ok : bad)(`stream: ${label}`, r === 'ok' ? `"${track.info.title}" opened without errors` : r);
    await p.destroy('probe');
  } catch (err) {
    bad(`stream: ${label}`, err.message);
  }
}

// --- in-container updater reached GitHub
try {
  const { readState, effectiveVersions } = await import('../src/updater.js');
  const st = readState();
  const v = effectiveVersions();
  (st.lastCheck ? ok : bad)(
    'updater check',
    st.lastCheck
      ? `checked ${st.lastCheck}; would run Lavalink ${v.lavalink.version}, youtube ${String(v.youtube.version).slice(0, 12)}, lavasrc ${v.lavasrc.version}${st.pending ? ' (update pending)' : ''}`
      : 'no successful check recorded',
  );
} catch (err) {
  bad('updater check', err.message);
}

// --- built-in yt-cipher answers
try {
  const res = await withTimeout(fetch('http://127.0.0.1:8001/', { headers: { Authorization: process.env.LAVALINK_PASSWORD ?? '' } }), 5000, 'yt-cipher');
  ok('yt-cipher running', `HTTP ${res.status}`);
} catch (err) {
  bad('yt-cipher running', err.message);
}

// --- YouTube sign-in plumbing (can't finish the Google login in CI, but every step up to it should work)
try {
  const yt = await import('../src/youtube.js');
  const code = await withTimeout(yt.requestDeviceCode(), 15_000, 'device code');
  ok('youtube sign-in: Google device code', `code ${code.userCode.replace(/./g, '•')} at ${code.verificationUrl}`);
  const st = await yt.youtubeStatus();
  if (YTDLP) {
    // In yt-dlp mode the YouTube plugin is switched off, so its endpoint should be gone.
    (!st.available ? ok : bad)('YouTube plugin off in yt-dlp mode', st.available ? 'plugin endpoint still answering' : '/youtube endpoint off as expected');
  } else {
    (st.available ? ok : bad)('youtube sign-in: Lavalink /youtube endpoint', JSON.stringify(st));
  }
} catch (err) {
  bad('youtube sign-in plumbing', err.message);
}
const ytCmd = fakeInteraction('config', { action: 'status' }, 'youtube');
await handleInteraction(ytCmd).catch(() => null);
const ytReply = ytCmd.out.replies.at(-1)?.content ?? '';
(/signed in|Not signed in|yt-dlp \d/i.test(ytReply) ? ok : bad)('/config youtube status', ytReply.split('\n').slice(0, 2).join(' / ').slice(0, 140));

// --- report
let failures = 0;
let warnings = 0;
console.log(`\n================ BLIZZBEAT SMOKE TEST [YouTube via ${YTDLP ? 'yt-dlp' : 'plugin'}] ================`);
for (const r of results) {
  if (!r.pass && r.warn) warnings++;
  else if (!r.pass) failures++;
  console.log(`${r.pass ? 'PASS' : r.warn ? 'WARN' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${String(r.detail).split('\n').slice(0, 6).join('\n      ')}` : ''}`);
}
console.log(`======================================================\n${results.length - failures - warnings}/${results.length} passed, ${warnings} known upstream/CI issues, ${failures} failed`);
process.exit(failures ? 1 : 0);
