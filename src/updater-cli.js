// Run by the entrypoint before Lavalink starts: picks up newer Lavalink / plugin releases.
// Never blocks startup for long and never fails it.
import { runLaunchCheck } from './updater.js';

const timeout = setTimeout(() => {
  console.log('[updater] Update check took too long; starting with the current versions.');
  process.exit(0);
}, 45_000);

try {
  await runLaunchCheck();
} catch (err) {
  console.log(`[updater] Update check failed: ${err.message}`);
}
clearTimeout(timeout);
process.exit(0);
