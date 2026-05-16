// One-shot backfill: populate `question` on existing subs that
// pre-date the field. getMarketById hits the markets cache after the
// first call, so the work is one bulk GraphQL fetch + a per-sub map
// lookup. Safe to re-run — subs that already have `question` are
// skipped.
import { loadState, getState, saveState } from '../src/state.js';
import { getMarketById } from '../src/predict.js';

await loadState();
const state = getState();
const subs = Object.values(state.subs ?? {});

const missing = subs.filter((s) => !s.question);
console.log(`subs: ${subs.length}, missing question: ${missing.length}`);
if (!missing.length) {
  console.log('nothing to backfill.');
  process.exit(0);
}

let filled = 0;
let unchanged = 0;
let failed = 0;

for (const s of missing) {
  try {
    const m = await getMarketById(s.marketId);
    if (m?.question) {
      s.question = m.question;
      // Opportunistic: also refresh title if Predict.fun has a better
      // one than the synthesized `Market <id>` placeholder.
      if ((!s.title || /^Market\s+\d+$/.test(s.title)) && m.title) {
        s.title = m.title;
      }
      filled += 1;
      console.log(`  ✓ ${s.chatId}/${s.marketId}  ${(m.question || '').slice(0, 60)}`);
    } else {
      unchanged += 1;
      console.log(`  · ${s.chatId}/${s.marketId}  (no question on market)`);
    }
  } catch (err) {
    failed += 1;
    console.warn(`  ✗ ${s.chatId}/${s.marketId}  ${err.message}`);
  }
}

if (filled > 0) await saveState();
console.log(`\ndone: filled=${filled}, no-question=${unchanged}, failed=${failed}`);
