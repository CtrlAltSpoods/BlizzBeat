// Health diagnostics: network to Discord, clock offset, event-loop stalls, slow command acknowledgements.
// Discord gives a bot 3 seconds to acknowledge a slash command, so slowness here shows up as
// "The application did not respond" / "Unknown interaction".
import { lookup } from 'node:dns/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { client } from './client.js';
import { log } from './logger.js';

/** Local clock minus Discord's clock, in ms (positive = local clock is ahead). */
export let clockOffsetMs = 0;

async function timed(fn) {
  const start = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - start), value };
  } catch (error) {
    return { ms: Math.round(performance.now() - start), error };
  }
}

/** One-off check at startup: DNS, HTTPS round trip to Discord, and the server clock. */
export async function networkCheck() {
  const dns = await timed(() => lookup('discord.com'));
  const http = await timed(() => fetch('https://discord.com/api/v10/gateway', { signal: AbortSignal.timeout(10_000) }));
  const notes = [];

  if (dns.error) notes.push(`DNS lookup of discord.com FAILED (${dns.error.code ?? dns.error.message})`);
  else notes.push(`DNS ${dns.ms}ms`);

  if (http.error) {
    notes.push(`Discord API unreachable (${http.error.message})`);
  } else {
    notes.push(`Discord API ${http.ms}ms`);
    const serverDate = Date.parse(http.value.headers.get('date') ?? '');
    if (!Number.isNaN(serverDate)) {
      // Date header has 1s resolution; allow for half the round trip.
      clockOffsetMs = Date.now() - http.ms / 2 - serverDate;
      notes.push(`clock offset ${(clockOffsetMs / 1000).toFixed(1)}s`);
    }
  }
  log.info(`Network check: ${notes.join(', ')}`);

  if (!dns.error && dns.ms > 1000) {
    log.warn(
      `DNS is slow (${dns.ms}ms). Slow DNS can make commands time out ("The application did not respond"). ` +
        'Try setting the container DNS to 1.1.1.1 (Unraid: Extra Parameters "--dns 1.1.1.1").',
    );
  }
  if (!http.error && http.ms > 1500) {
    log.warn(`Reaching Discord took ${http.ms}ms. Commands must be acknowledged within 3s, so this network is too slow or overloaded.`);
  }
  if (Math.abs(clockOffsetMs) > 10_000) {
    log.warn(
      `This server's clock is ${(Math.abs(clockOffsetMs) / 1000).toFixed(0)}s ${clockOffsetMs < 0 ? 'behind' : 'ahead'}. ` +
        'Turn on NTP (Unraid: Settings -> Date and Time -> Use NTP server: Yes). Wrong clocks break sign-ins and timing.',
    );
  }
}

/** Keeps the HTTPS connection to Discord warm (so acknowledgements don't pay for a new connection) and reports slowness. */
function startKeepWarm() {
  let slowStreak = 0;
  setInterval(async () => {
    if (!client.isReady()) return;
    const r = await timed(() => client.rest.get('/gateway'));
    if (r.error || r.ms > 1500) {
      slowStreak++;
      if (slowStreak === 1 || slowStreak % 10 === 0) {
        log.warn(`Discord API ${r.error ? `error: ${r.error.message}` : `slow: ${r.ms}ms`} (commands may time out).`);
      }
    } else {
      slowStreak = 0;
    }
  }, 15_000).unref();
}

/** Warns when the bot's event loop is stalled (CPU starved / overloaded host). */
function startLoopMonitor() {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  setInterval(() => {
    const maxMs = Math.round(h.max / 1e6);
    if (maxMs > 1000) {
      log.warn(`The bot was frozen for up to ${maxMs}ms in the last minute. The server may be short on CPU/RAM.`);
    }
    h.reset();
  }, 60_000).unref();
}

export function startDiagnostics() {
  networkCheck().catch((err) => log.warn('Network check failed:', err.message));
  startKeepWarm();
  startLoopMonitor();
}

/** How long Discord's 3-second window had already run when the interaction reached us (clock-corrected). */
export function deliveryDelayMs(interaction) {
  return Date.now() - clockOffsetMs - interaction.createdTimestamp;
}
