// Lavalink-wide settings changed from Discord. They're saved in $DATA_DIR and read by the entrypoint
// each time Lavalink starts, so changing one restarts Lavalink (once nothing is playing).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const bufferFile = () => join(config.dataDir, 'lavalink-buffer-ms');
export const BUFFER_MIN_MS = 200;
export const BUFFER_MAX_MS = 30_000;

/** The audio buffer Lavalink uses (ms): Discord setting > LAVALINK_FRAME_BUFFER_MS > 1000. */
export function bufferMs() {
  try {
    const v = Number(readFileSync(bufferFile(), 'utf8').trim());
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    /* not set in Discord */
  }
  const env = Number(process.env.LAVALINK_FRAME_BUFFER_MS);
  return Number.isFinite(env) && env > 0 ? env : 1000;
}

export function setBufferMs(ms) {
  const v = Math.round(Math.min(Math.max(ms, BUFFER_MIN_MS), BUFFER_MAX_MS));
  writeFileSync(bufferFile(), `${v}\n`);
  return v;
}
