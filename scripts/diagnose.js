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
import { extractSlugFromUrl, slugify, getAllMarketsCached, extractMarketsFromHtml, getMarketsByCategorySlug } from '../src/predict.js';

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

function typeStr(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return typeStr(t.ofType) + '!';
  if (t.kind === 'LIST') return '[' + typeStr(t.ofType) + ']';
  return t.name ?? t.kind;
}

async function gql(query, variables) {
  const json = await fetchJson(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 30_000,
  });
  return json;
}

step(1, 8, 'Parse input');
const slug = extractSlugFromUrl(arg);
if (!slug) {
  fail('extractSlugFromUrl returned null — input is neither a recognisable URL nor a slug');
  process.exit(1);
}
ok(`slug = "${slug}"`);
info(`graphqlUrl = ${config.graphqlUrl}`);
info(`restUrl    = ${config.restUrl}`);
info(`apiKey     = ${config.predictApiKey ? '(set)' : '(empty)'}`);

step(2, 9, 'GraphQL schema introspection');
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

// Comprehensive Query type dump — the real source of truth for what's
// available. Print every Query field with its args + return type so we
// can see candidates for slug-based market lookup.
let allQueryFields = [];
try {
  const intro = await gql(
    `query { __type(name: "Query") { fields { name args { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } }`,
  );
  allQueryFields = intro?.data?.__type?.fields ?? [];
  ok(`Query has ${allQueryFields.length} fields`);
  console.log('    --- All Query fields (name(args): returnType) ---');
  for (const f of allQueryFields) {
    const args = (f.args ?? []).map((a) => `${a.name}: ${typeStr(a.type)}`).join(', ');
    console.log(`      ${f.name}(${args}): ${typeStr(f.type)}`);
  }
} catch (err) {
  fail(`Query dump failed: ${err.message}`);
}

// Dump MarketFilterInput so we can see if categorySlug / categoryId /
// eventSlug / etc. is a supported filter on the markets() query.
try {
  const intro = await gql(
    `query { __type(name: "MarketFilterInput") { inputFields { name type { name kind ofType { name kind } } } } }`,
  );
  const fields = intro?.data?.__type?.inputFields ?? [];
  if (fields.length) {
    console.log('    --- MarketFilterInput inputFields ---');
    for (const f of fields) console.log(`      ${f.name}: ${typeStr(f.type)}`);
  } else {
    info('MarketFilterInput not introspectable or empty');
  }
} catch { /* ignore */ }

// Try to find any type that has a `markets` field — likely the Category
// or Event wrapper that holds the list we want.
try {
  const intro = await gql(
    `query { __schema { types { name kind fields { name type { name kind ofType { name kind } } } } } }`,
  );
  const types = intro?.data?.__schema?.types ?? [];
  const interesting = [];
  for (const t of types) {
    if (!Array.isArray(t.fields)) continue;
    if (!/category|event|group/i.test(t.name)) continue;
    const marketField = t.fields.find((f) => /market/i.test(f.name));
    if (marketField) {
      interesting.push({ name: t.name, marketField: `${marketField.name}: ${typeStr(marketField.type)}` });
    }
  }
  if (interesting.length) {
    console.log('    --- Types containing a markets-like field ---');
    for (const t of interesting) console.log(`      ${t.name} { ${t.marketField} }`);
  } else {
    info('no Category/Event/Group types with a markets field');
  }
} catch { /* ignore */ }

// Actually CALL latestCategorySlug with the user's slug — see what it
// returns. The value is the next clue for which downstream query to use.
try {
  const r = await gql(`query($s: String!) { latestCategorySlug(slug: $s) }`, { s: slug });
  if (r?.errors) {
    fail(`latestCategorySlug call: ${JSON.stringify(r.errors).slice(0, 200)}`);
  } else {
    ok(`latestCategorySlug("${slug}") = ${JSON.stringify(r?.data?.latestCategorySlug)}`);
  }
} catch (err) {
  fail(`latestCategorySlug call failed: ${err.message}`);
}

// Try a few plausible markets() filter shapes — empirically discover
// which one the API actually accepts. The first one to come back with
// non-zero results is what the bot should use.
const filterCandidates = [
  { categorySlug: slug },
  { eventSlug: slug },
  { categorySlugs: [slug] },
  { slug },
];
for (const filter of filterCandidates) {
  const filterStr = JSON.stringify(filter);
  try {
    const r = await gql(
      `query($f: MarketFilterInput!) {
        markets(filter: $f, pagination: { first: 5 }) {
          edges { node { id title question } }
        }
      }`,
      { f: filter },
    );
    if (r?.errors) {
      console.log(`    markets(filter: ${filterStr}) → ${JSON.stringify(r.errors[0]?.message ?? r.errors).slice(0, 120)}`);
    } else {
      const edges = r?.data?.markets?.edges ?? [];
      if (edges.length) {
        ok(`markets(filter: ${filterStr}) → ${edges.length} results 🎯`);
        for (const e of edges) console.log(`      • ${e.node.id} ${e.node.title}`);
      } else {
        info(`markets(filter: ${filterStr}) → 0 results`);
      }
    }
  } catch (err) {
    console.log(`    markets(filter: ${filterStr}) → ${err.message}`);
  }
}

step(3, 9, 'Fetch all markets via cached GraphQL');
let all = [];
try {
  const t0 = Date.now();
  all = await getAllMarketsCached();
  ok(`got ${all.length} markets in ${(Date.now() - t0) / 1000}s`);
} catch (err) {
  fail(`fetch failed: ${err.message}`);
  process.exit(1);
}

step(4, 9, 'Strict match against title / question / categorySlug');
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

step(5, 9, 'Fuzzy contains match (top 10)');
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

step(6, 9, 'REST fallback /v1/markets scan for categorySlug');
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

step(7, 9, 'HTML scrape — fetch the URL and parse __NEXT_DATA__');
let htmlMarkets = [];
const urlGuess = /^https?:\/\//i.test(arg)
  ? arg
  : `https://predict.fun/zh-cn/market/${slug}`;
info(`fetching ${urlGuess}`);
try {
  const r = await extractMarketsFromHtml(urlGuess);
  info(`HTML size: ${r.meta.htmlSize} bytes, __NEXT_DATA__ found: ${r.meta.foundNextData}`);
  htmlMarkets = r.markets;
  if (r.meta.parseError) fail(`__NEXT_DATA__ JSON parse error: ${r.meta.parseError}`);
  if (htmlMarkets.length) {
    ok(`extracted ${htmlMarkets.length} market objects from page`);
    for (const m of htmlMarkets.slice(0, 12)) {
      console.log(`    id=${m.id}  conditionId=${m.conditionId?.slice(0, 16)}…`);
      console.log(`         title="${m.title}"  question="${m.question}"`);
    }
    if (htmlMarkets.length > 12) info(`(${htmlMarkets.length - 12} more)`);
  } else {
    fail('no market-shaped objects found in __NEXT_DATA__');
  }
} catch (err) {
  fail(`HTML fetch failed: ${err.message}`);
}

step(8, 9, 'GraphQL latestCategorySlug(slug:) — authoritative resolver');
let csMarkets = [];
try {
  csMarkets = await getMarketsByCategorySlug(slug);
  if (csMarkets.length) {
    ok(`got ${csMarkets.length} markets`);
    for (const m of csMarkets.slice(0, 12)) {
      console.log(`    id=${m.id}  conditionId=${m.conditionId ? m.conditionId.slice(0, 16) + '…' : '(none — bot will refetch)'}`);
      console.log(`         title="${m.title}"  question="${m.question}"`);
    }
    if (csMarkets.length > 12) info(`(${csMarkets.length - 12} more)`);
  } else {
    fail('returned 0 markets (will fall back to Step 9 chained query)');
  }
} catch (err) {
  fail(`call failed: ${err.message}`);
}

step(9, 9, 'Chained query: categories(filter) → category.id → markets(filter:{categoryId})');
// Introspect CategoryFilterInput first.
let categoryFilterFields = [];
try {
  const intro = await gql(`query { __type(name: "CategoryFilterInput") { inputFields { name type { name kind ofType { name kind } } } } }`);
  categoryFilterFields = intro?.data?.__type?.inputFields ?? [];
  if (categoryFilterFields.length) {
    console.log('    --- CategoryFilterInput inputFields ---');
    for (const f of categoryFilterFields) console.log(`      ${f.name}: ${typeStr(f.type)}`);
  } else {
    info('CategoryFilterInput has no inputFields (or not introspectable)');
  }
} catch (err) {
  fail(`CategoryFilterInput introspection failed: ${err.message}`);
}

// Try every plausible slug-shaped field on CategoryFilterInput.
let chainMarkets = [];
let workingChain = null;
const slugFieldGuesses = [
  ...categoryFilterFields.filter((f) => /slug/i.test(f.name)).map((f) => f.name),
  'slug', 'slugs', 'slugIn',
];
const seenGuess = new Set();
for (const field of slugFieldGuesses) {
  if (seenGuess.has(field)) continue;
  seenGuess.add(field);
  // Build filter — wrap in array if the field's type is a list.
  const def = categoryFilterFields.find((f) => f.name === field);
  let isList = false;
  let t = def?.type;
  while (t) {
    if (t.kind === 'LIST') { isList = true; break; }
    t = t.ofType;
  }
  const filter = { [field]: isList ? [slug] : slug };
  try {
    const r = await gql(
      `query($f: CategoryFilterInput!) {
        categories(filter: $f, pagination: { first: 5 }) {
          edges { node { id } }
        }
      }`,
      { f: filter },
    );
    if (r?.errors) {
      console.log(`    categories(filter: ${JSON.stringify(filter)}) → ${JSON.stringify(r.errors[0]?.message ?? r.errors).slice(0, 100)}`);
      continue;
    }
    const ids = (r?.data?.categories?.edges ?? []).map((e) => e.node.id);
    if (ids.length === 0) {
      info(`categories(filter: ${JSON.stringify(filter)}) → 0 results`);
      continue;
    }
    ok(`categories(filter: ${JSON.stringify(filter)}) → ${ids.length} categor${ids.length===1?'y':'ies'}: ${ids.join(', ')}`);
    // Now drill into the first category for markets.
    const m = await gql(
      `query($f: MarketFilterInput!) {
        markets(filter: $f, pagination: { first: 100 }) {
          edges { node { id conditionId title question } }
        }
      }`,
      { f: { categoryId: ids[0] } },
    );
    if (m?.errors) {
      console.log(`    markets(filter:{categoryId:${ids[0]}}) → ${JSON.stringify(m.errors[0]?.message ?? m.errors).slice(0, 100)}`);
      continue;
    }
    const edges = m?.data?.markets?.edges ?? [];
    if (edges.length) {
      ok(`markets(filter: { categoryId: ${ids[0]} }) → ${edges.length} markets 🎯`);
      for (const e of edges.slice(0, 12)) console.log(`      • ${e.node.id} ${e.node.title}  —  "${e.node.question}"`);
      if (edges.length > 12) info(`(${edges.length - 12} more)`);
      chainMarkets = edges.map((e) => e.node);
      workingChain = { slugField: field, isList, categoryId: ids[0] };
      break;
    } else {
      info(`markets(filter:{categoryId:${ids[0]}}) returned 0 markets`);
    }
  } catch (err) {
    console.log(`    categories(filter: ${JSON.stringify(filter)}) → ${err.message}`);
  }
}

console.log('\n----- 总结 -----');
if (chainMarkets.length) {
  console.log(`✅ Step 9 命中: 用 categories.${workingChain.slugField}=${slug} → categoryId=${workingChain.categoryId}`);
  console.log(`   → markets(filter:{categoryId}) 拿到 ${chainMarkets.length} 个 market。Bot 重启后会用这条链路。`);
} else if (csMarkets.length) {
  console.log(`✅ Step 8 命中: latestCategorySlug 直接返回 ${csMarkets.length} 个。重启 bot 即可。`);
} else if (htmlMarkets.length) {
  console.log(`✅ Step 7 命中: HTML scrape 拿到 ${htmlMarkets.length} 个。`);
} else if (dedup.length) {
  console.log('Step 4 命中：slug 匹配到了。');
} else {
  console.log('全部失败。把 [9/9] 的 CategoryFilterInput inputFields 输出贴给我，');
  console.log('特别是有没有像 search/query 之类的字段——可能要换 free-text search 路线。');
}
