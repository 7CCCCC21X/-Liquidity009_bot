// Diagnose why digest grouping (by parent event question) isn't
// kicking in. For each marketId (passed as args, or sampled from
// state.json subs when no args), prints the stored title/question and
// what getMarketById currently returns from Predict.fun.
//
//   npm run diagnose-question                 # samples first 30 subs
//   npm run diagnose-question 55019 130180    # specific ids
//
// What the output tells you:
//   - fetched question = null  → Predict.fun doesn't expose a question
//       for this market; grouping by question can't work, need another
//       key (e.g. categorySlug).
//   - stored = null, fetched = "..."  → backfill not yet run / not
//       deployed; the lazy poll backfill will fill it, or re-deploy.
//   - several ids share the SAME fetched question  → grouping WILL
//       work once stored; if their questions differ, they won't group.
import { loadState, getState } from '../src/state.js';
import { getMarketById } from '../src/predict.js';

await loadState();
const state = getState();
const subs = Object.values(state.subs ?? {});

let ids = process.argv.slice(2).filter(Boolean);
if (!ids.length) {
  ids = subs.slice(0, 30).map((s) => String(s.marketId));
  console.log(`(no ids given — sampling first ${ids.length} subs)\n`);
}

const subById = new Map(subs.map((s) => [String(s.marketId), s]));
const questionCounts = new Map();

for (const id of ids) {
  const s = subById.get(String(id));
  const storedTitle = s?.title ?? '(not subscribed)';
  const storedQ = s?.question ?? null;
  let fetchedTitle = null;
  let fetchedQ = null;
  let err = null;
  try {
    const m = await getMarketById(id);
    fetchedTitle = m?.title ?? null;
    fetchedQ = m?.question ?? null;
  } catch (e) {
    err = e.message;
  }
  console.log(`id=${id}`);
  console.log(`  stored  title="${storedTitle}"  question=${storedQ === null ? 'NULL' : `"${storedQ}"`}`);
  if (err) {
    console.log(`  fetched ERROR: ${err}`);
  } else {
    console.log(`  fetched title="${fetchedTitle}"  question=${fetchedQ === null ? 'NULL' : `"${fetchedQ}"`}`);
  }
  const qKey = fetchedQ ?? storedQ;
  if (qKey) questionCounts.set(qKey, (questionCounts.get(qKey) ?? 0) + 1);
  console.log('');
}

console.log('----- question 分组统计（出现次数 ≥2 才会折叠分组）-----');
const sorted = [...questionCounts.entries()].sort((a, b) => b[1] - a[1]);
if (!sorted.length) {
  console.log('⚠️ 所有市场的 question 都是 NULL — Predict.fun 没暴露事件主标题。');
  console.log('   需要换分组依据（categorySlug 之类）。把这段输出发回。');
} else {
  for (const [q, n] of sorted) {
    console.log(`  ${n}×  "${q.slice(0, 70)}"`);
  }
  const groupable = sorted.filter(([, n]) => n >= 2).length;
  console.log(`\n可分组的事件数: ${groupable}（这些会折叠成 📂 标题）`);
}
