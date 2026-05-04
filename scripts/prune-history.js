// Manual one-shot prune of history.jsonl. Drops events older than
// HISTORY_KEEP_DAYS. Useful when the on-startup throttle hasn't fired
// yet but the file has grown larger than you'd like.
import { config } from '../src/config.js';
import { forcePrune } from '../src/history.js';

if (!config.historyEnabled) {
  console.log('HISTORY_ENABLED=false — nothing to do.');
  process.exit(0);
}
const r = await forcePrune();
console.log(`done: kept ${r.kept}, dropped ${r.dropped} (file: ${config.historyFile})`);
