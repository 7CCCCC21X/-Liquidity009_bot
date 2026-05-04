// Slug resolution diagnostic. Pass a Predict.fun URL or slug and walk
// the entire match chain step by step so you can see exactly where the
// bot fails to find a match.
//
//   node scripts/diagnose.js https://predict.fun/zh-cn/market/fifa-world-cup-group-e-winner
//   node scripts/diagnose.js fifa-world-cup-group-e-winner
//
// Does NOT require TELEGRAM_BOT_TOKEN. Set PREDICT_API_KEY in .env if
// you have one — otherwise public endpoints still work.

import { config } from '../src/config.js';
import { fetchJson } from '../src/http.js';
import { extractSlugFromUrl, slugify, getAllMarketsCached } from '../src/predict.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/diagnose.js <url-or-slug>');
  process.exit(1);
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }
function info(msg) { console.log(`    ${msg}`); }
function step(n, total, title) { console.log(`\n[${n}/${total}] ${title}`); }

// Mirror the year-injection slugifier from the reference repo. Many
// Predict.fun titles in the API omit the year ("World Cup Final") while
// the URL slug includes it ("world-cup-final-2026"). Try both.
function slugifyWithYear(s) {
  if (!s) return '';
  let t = s;
  if (!/\b20\d{2}\b/.test(t)) {
    const m = t.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/i);
    if (m) {
      const idx = t.indexOf(m[0]) + m[0].length;
      t = t.slice(0, idx) + ' ' + new Date().getUTCFullYear() + t.slice(idx);
    } else {
      // Append year as a separate try
      t = `${t} ${new Date().getUTCFullYear()}`;
    }
  }
  return slugify(t);
}

step(1, 6, 'Parse input');
const slug = extractSlugFromUrl(arg);
if (!slug) {
  fail('extractSlugFromUrl returned null — input is neither a recognisable URL nor a slug');
  process.exit(1);
}
ok(`slug = "${slug}"`);
info(`graphqlUrl = ${config.graphqlUrl}`);
info(`restUrl    = ${config.restUrl}`);
info(`apiKey     = ${config.predictApiKey ? '(set)' : '(empty)'}`);

step(2, 6, 'GraphQL schema introspection');
let graphFields = new Set();
try {
  const intro = await fetchJson(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { __type(name: "Market") { fields { name } } }`,
    }),
    timeoutMs: 30_000,
  });
  graphFields = new Set((intro?.data?.__type?.fields ?? []).map((f) => f.name));
  ok(`Market type exposes ${graphFields.size} fields`);
  const interesting = ['id','conditionId','title','question','slug','marketSlug','categorySlug','endsAt','isResolved','status','tradingStatus'];
  for (const f of interesting) {
    info(`${graphFields.has(f) ? '✓' : '✗'} ${f}`);
  }
} catch (err) {
  fail(`introspection failed: ${err.message}`);
}

step(3, 6, 'Fetch all markets via cached GraphQL');
let all = [];
try {
  const t0 = Date.now();
  all = await getAllMarketsCached();
  ok(`got ${all.length} markets in ${(Date.now() - t0) / 1000}s`);
} catch (err) {
  fail(`fetch failed: ${err.message}`);
  process.exit(1);
}

step(4, 6, 'Strict match against title / question / categorySlug');
const titleHits = all.filter((m) => slugify(m.title ?? '') === slug);
const qHits     = all.filter((m) => slugify(m.question ?? '') === slug);
const csHits    = all.filter((m) => {
  const cs = m.categorySlug ?? m.slug ?? m.marketSlug;
  return cs && String(cs).toLowerCase() === slug;
});
info(`title-slug    matches: ${titleHits.length}`);
info(`question-slug matches: ${qHits.length}`);
info(`categorySlug  matches: ${csHits.length}`);
const titleYearHits = all.filter((m) => slugifyWithYear(m.title ?? '') === slug);
const qYearHits     = all.filter((m) => slugifyWithYear(m.question ?? '') === slug);
info(`title +year   matches: ${titleYearHits.length}`);
info(`question+year matches: ${qYearHits.length}`);

const allHits = [...titleHits, ...qHits, ...csHits, ...titleYearHits, ...qYearHits];
const seen = new Set();
const dedup = allHits.filter((m) => { const k = String(m.id); if (seen.has(k)) return false; seen.add(k); return true; });
if (dedup.length) {
  ok(`STRICT MATCH FOUND (${dedup.length})`);
  for (const m of dedup.slice(0, 10)) {
    console.log(`    id=${m.id}  title="${m.title}"  q="${m.question}"`);
  }
} else {
  fail('no strict match in cached GraphQL list');
}

step(5, 6, 'Fuzzy contains match (top 10)');
const tokens = slug.split('-').filter((t) => t.length >= 3);
const scored = all.map((m) => {
  const hay = `${slugify(m.title ?? '')} ${slugify(m.question ?? '')} ${m.categorySlug ?? ''}`;
  let score = 0;
  for (const t of tokens) if (hay.includes(t)) score += 1;
  return { m, score };
}).filter((x) => x.score >= Math.max(1, Math.floor(tokens.length / 2)))
  .sort((a, b) => b.score - a.score)
  .slice(0, 10);
if (!scored.length) {
  fail('zero fuzzy matches — slug tokens not present in any market');
} else {
  for (const { m, score } of scored) {
    console.log(`    [${score}/${tokens.length}]  id=${m.id}  title="${m.title}"`);
    console.log(`         question="${m.question}"`);
    console.log(`         title-slug    = "${slugify(m.title ?? '')}"`);
    console.log(`         question-slug = "${slugify(m.question ?? '')}"`);
    console.log(`         categorySlug  = "${m.categorySlug ?? m.slug ?? m.marketSlug ?? ''}"`);
  }
}

step(6, 6, 'REST fallback /v1/markets scan for categorySlug');
let restHits = 0;
let scanned = 0;
let lastId = null;
const restHeaders = config.predictApiKey ? { 'x-api-key': config.predictApiKey } : {};
for (let page = 0; page < 20 && restHits < 5; page++) {
  const params = new URLSearchParams({ first: '100' });
  if (lastId != null) params.set('after', String(lastId));
  const url = `${config.restUrl}/markets?${params.toString()}`;
  let arr = [];
  try {
    const json = await fetchJson(url, { headers: restHeaders, timeoutMs: 10_000 });
    const data = json?.data ?? json;
    arr = Array.isArray(data) ? data : (data?.markets ?? data?.items ?? data?.nodes ?? []);
  } catch (err) {
    fail(`REST page ${page} failed: ${err.message}`);
    break;
  }
  if (!arr.length) break;
  scanned += arr.length;
  for (const m of arr) {
    const cs = m?.categorySlug ?? m?.slug ?? m?.marketSlug;
    if (cs && String(cs).toLowerCase() === slug) {
      restHits++;
      console.log(`    REST hit: id=${m.id} title="${m.title}" categorySlug="${cs}"`);
    }
  }
  if (arr.length < 100) break;
  lastId = arr[arr.length - 1]?.id ?? null;
  if (lastId == null) break;
}
info(`scanned ${scanned} REST markets → ${restHits} categorySlug hits`);

console.log('\n----- 总结 -----');
if (dedup.length || restHits) {
  console.log('找到了。如果 bot 仍说"没匹配到"，可能是缓存还没刷新（默认 10 分钟）：');
  console.log('  • 重启 bot');
  console.log('  • 或把 MARKETS_CACHE_TTL_MS 调小');
} else {
  console.log('GraphQL + REST 都找不到这个 slug。可能：');
  console.log('  • 它是事件页 (event) 而不是单个市场页 — Predict.fun 上 /event/<slug> 和 /market/<slug>');
  console.log('    是不同实体，bot 目前只匹配 markets() 列表');
  console.log('  • 市场已 resolve（GraphQL 默认过滤 isResolved:false）— 试试 /v1/markets/<id> 直查');
  console.log('  • slug 拼写不同（看上面 fuzzy 输出有没有相似项）');
}
