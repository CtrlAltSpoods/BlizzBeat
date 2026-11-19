import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function out(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] [blizzbeat] ${level.toUpperCase()}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line, ...args);
}

export const log = {
  debug: (...a) => out('debug', a),
  info: (...a) => out('info', a),
  warn: (...a) => out('warn', a),
  error: (...a) => out('error', a),
};
