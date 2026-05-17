// One-shot: clear per-sub `thresholds` overrides on every existing
// subscription so they all fall through to the (now-lowered) global
// defaults from config.js (PRICE_EPSILON=0.001, SIZE_RELATIVE_EPSILON=0.05,
// SIZE_ABSOLUTE_MIN=10). After this runs, changing the global env
// vars later will continue to apply to every sub automatically.
//
// Safe to re-run — subs that already have no override are skipped.
import { loadState, getState, saveState } from '../src/state.js';
import { config } from '../src/config.js';

await loadState();
const state = getState();
const subs = Object.values(state.subs ?? {});

console.log(`subs: ${subs.length}`);
console.log(`global defaults: price ≥ ${config.priceEpsilon} · size ≥ ${config.sizeAbsoluteMin} 张 / ${(config.sizeRelativeEpsilon * 100).toFixed(0)}% · cooldown ${Math.round(config.notifyCooldownMs / 1000)}s`);

let cleared = 0;
let untouched = 0;
for (const s of subs) {
  if (s.thresholds && Object.keys(s.thresholds).length > 0) {
    const before = JSON.stringify(s.thresholds);
    delete s.thresholds;
    cleared += 1;
    console.log(`  ✓ ${s.chatId}/${s.marketId}  cleared ${before}`);
  } else {
    untouched += 1;
  }
}

if (cleared > 0) await saveState();
console.log(`\ndone: cleared=${cleared}, already-default=${untouched}`);
