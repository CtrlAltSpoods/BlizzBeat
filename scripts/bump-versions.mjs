// Used by .github/workflows/update-deps.yml: bumps the versions baked into the image to the latest
// releases (same rules as the in-container updater) and pins yt-cipher to its latest commit.
// Prints a summary and writes `changed=true|false` + `summary=...` to $GITHUB_OUTPUT.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const VERSIONS = `${root}docker/versions.env`;
const DOCKERFILE = `${root}Dockerfile`;
const headers = {
  'User-Agent': 'blizzbeat-update-deps',
  Accept: 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function gh(path) {
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? m.slice(1, 4).map(Number) : null;
}
function semverGt(a, b) {
  const x = semver(a);
  const y = semver(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

let versions = readFileSync(VERSIONS, 'utf8');
let dockerfile = readFileSync(DOCKERFILE, 'utf8');
const get = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(versions)?.[1]?.trim();
const set = (key, value) => {
  versions = versions.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
};
const getArg = (name) => new RegExp(`^ARG ${name}=(.*)$`, 'm').exec(dockerfile)?.[1]?.trim();
const setArg = (name, value) => {
  dockerfile = dockerfile.replace(new RegExp(`^ARG ${name}=.*$`, 'm'), `ARG ${name}=${value}`);
};

const changes = [];

// Lavalink: newest release within the same major version.
{
  const current = get('LAVALINK_VERSION');
  const latest = (await gh('repos/lavalink-devs/Lavalink/releases/latest')).tag_name;
  if (semver(latest)?.[0] === semver(current)?.[0] && semverGt(latest, current)) {
    set('LAVALINK_VERSION', latest);
    setArg('LAVALINK_VERSION', latest);
    changes.push(`Lavalink ${current} → ${latest}`);
  }
}

// YouTube plugin: a release newer than the build we use (which may be a dev snapshot).
{
  const current = get('YOUTUBE_PLUGIN_VERSION');
  const currentDate = get('YOUTUBE_PLUGIN_DATE');
  const rel = await gh('repos/lavalink-devs/youtube-source/releases/latest');
  const snapshot = /^[0-9a-f]{40}$/.test(current);
  if (Date.parse(rel.published_at) > Date.parse(currentDate) && (snapshot || semverGt(rel.tag_name, current))) {
    set('YOUTUBE_PLUGIN_VERSION', rel.tag_name);
    set('YOUTUBE_PLUGIN_DATE', rel.published_at);
    changes.push(`YouTube plugin ${snapshot ? current.slice(0, 7) : current} → ${rel.tag_name}`);
  }
}

// LavaSrc
{
  const current = get('LAVASRC_VERSION');
  const latest = (await gh('repos/topi314/LavaSrc/releases/latest')).tag_name;
  if (semverGt(latest, current)) {
    set('LAVASRC_VERSION', latest);
    changes.push(`LavaSrc ${current} → ${latest}`);
  }
}

// yt-cipher: latest commit on its default branch, plus the EJS commit its own Dockerfile pins.
{
  const current = getArg('YTCIPHER_COMMIT');
  const repo = await gh('repos/kikkia/yt-cipher');
  const head = (await gh(`repos/kikkia/yt-cipher/commits/${repo.default_branch}`)).sha;
  if (head && head !== current) {
    const theirs = await (await fetch(`https://raw.githubusercontent.com/kikkia/yt-cipher/${head}/Dockerfile`)).text();
    const ejs = /^ARG EJS_COMMIT=(\S+)/m.exec(theirs)?.[1];
    setArg('YTCIPHER_COMMIT', head);
    if (ejs) setArg('EJS_COMMIT', ejs);
    changes.push(`yt-cipher ${current.slice(0, 7)} → ${head.slice(0, 7)}`);
  }
}

writeFileSync(VERSIONS, versions);
writeFileSync(DOCKERFILE, dockerfile);

const summary = changes.length ? changes.join(', ') : 'no version changes';
console.log(`Update check: ${summary}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\nsummary=${summary}\n`);
}
