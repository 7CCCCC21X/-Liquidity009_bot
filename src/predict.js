import { config } from './config.js';
import { fetchJson } from './http.js';

function restHeaders() {
  const h = { Accept: 'application/json' };
  if (config.predictApiKey) h['x-api-key'] = config.predictApiKey;
  return h;
}

export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’'"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Predict.fun's URL slug includes the year for dated markets but the
// API title often omits it. Inject the current year before slugifying
// so titles like "BNB up or down (May 2)" match URL slugs like
// "bnb-up-or-down-may-2-2026". For matches that already contain a
// 20XX year nothing changes.
export function slugifyWithYear(s) {
  if (!s) return '';
  let t = String(s);
  if (!/\b20\d{2}\b/.test(t)) {
    const m = t.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/i);
    const year = new Date().getUTCFullYear();
    if (m) {
      const idx = t.indexOf(m[0]) + m[0].length;
      t = t.slice(0, idx) + ' ' + year + t.slice(idx);
    } else {
      t = `${t} ${year}`;
    }
  }
  return slugify(t);
}

// SSRF guard. Only allow https://predict.fun (and subdomains). Anything
// else returns false; callers must refuse to fetch. extractSlugFromUrl
// will still successfully parse non-predict URLs (so users get a
// useful "not a Predict.fun URL" error instead of a silent failure).
export function isAllowedPredictHost(input) {
  try {
    const u = new URL(String(input));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return u.hostname === 'predict.fun' || u.hostname.endsWith('.predict.fun');
  } catch {
    return false;
  }
}

// Predict.fun's GraphQL Market type doesn't expose any URL slug field
// (verified via introspection — no slug / marketSlug / categorySlug).
// REST `/v1/markets` requires PREDICT_API_KEY. So when the user pastes
// a URL the only universally reliable path is to fetch the rendered
// HTML and pull market objects out of the Next.js __NEXT_DATA__ JSON
// blob — exactly what the browser receives.

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Recursively walk a JSON blob looking for objects shaped like a
// Predict.fun market: must have an `id` AND at least one of
// title/question. conditionId is preserved when present but not
// required (we can refetch via getMarketById later). The id must
// look numeric (4–8 digits) to filter out unrelated graph nodes
// like {id: "edge-1", ...}.
function collectMarketLikeObjects(node, out, seen) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) collectMarketLikeObjects(x, out, seen);
    return;
  }
  if (typeof node !== 'object') return;
  const id = node.id ?? node.marketId;
  const idStr = id != null ? String(id) : '';
  if (idStr && /^\d{2,9}$/.test(idStr) && (node.title || node.question) && !seen.has(idStr)) {
    seen.add(idStr);
    out.push({
      id: idStr,
      conditionId: node.conditionId ?? node.condition_id ?? null,
      title: node.title ?? null,
      question: node.question ?? null,
      slug: node.categorySlug ?? node.slug ?? node.marketSlug ?? null,
    });
  }
  for (const v of Object.values(node)) collectMarketLikeObjects(v, out, seen);
}

// Fetch a Predict.fun page, extract __NEXT_DATA__, return all markets
// embedded in it. Works for /event/<slug>, /market/<slug>, and any
// other SSR page that renders markets. `meta` returned for diagnostics.
export async function extractMarketsFromHtml(url) {
  // SSRF defence — never fetch arbitrary URLs the user might paste.
  if (!isAllowedPredictHost(url)) {
    throw new Error('refusing to fetch non-predict.fun host');
  }
  const html = await fetchJson(url, {
    method: 'GET',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    timeoutMs: 20_000,
    retries: 1,
    parseJson: false,
  });
  const meta = { url, htmlSize: html?.length ?? 0, foundNextData: false };
  if (!html) return { markets: [], meta };
  // Match the standard Next.js SSR script tag (id and type can swap order).
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
         ?? html.match(/<script[^>]*type=["']application\/json["'][^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return { markets: [], meta };
  meta.foundNextData = true;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    meta.parseError = err.message;
    return { markets: [], meta };
  }
  const out = [];
  collectMarketLikeObjects(data, out, new Set());
  meta.marketCount = out.length;
  return { markets: out, meta };
}

// Predict.fun's GraphQL exposes a `latestCategorySlug(slug: String)`
// resolver that maps a URL slug directly to the underlying category +
// markets. This is the authoritative path — it bypasses every problem
// with title/question slugify mismatches and works for event pages.
//
// Resolve a slug → list of markets via the chained GraphQL queries.
// Returns [] on any failure so this can be safely tried as one of
// several fallback strategies.
export async function getMarketsByCategorySlug(slug) {
  if (!slug) return [];
  return await resolveSlugViaCategories(slug);
}

// Predict.fun's GraphQL has an undocumented (but production-used)
// quirk: `category(id: ID!)` accepts a URL slug as the ID argument
// — the resolver looks the slug up directly. Verified via the Rust
// SDK at https://github.com/sproot/predict-sdk/blob/main/src/graphql.rs
// (which selects category.slug and uses slugs in production).
//
// So the real chain is:
//   slug → category(id: <slug>) → numeric category.id
//        → markets(filter: { categoryId: <numeric-id> })
//
// CategoryFilterInput has no slug field, so this overload is the
// only first-class slug → category lookup the API exposes.

async function getCategoryBySlug(slugOrId) {
  try {
    const data = await postGraphQL(
      `query CategoryByIdOrSlug($id: ID!) {
        category(id: $id) {
          __typename
          id
        }
      }`,
      { id: String(slugOrId) },
      null,
    );
    return data?.category ?? null;
  } catch (err) {
    console.warn('[predict] category(id:slug) lookup failed:', err.message);
    return null;
  }
}

async function getMarketsByCategoryId(categoryId) {
  try {
    const data = await postGraphQL(
      `query MarketsByCategory($f: MarketFilterInput!) {
        markets(filter: $f, pagination: { first: 100 }) {
          edges { node { id conditionId title question } }
        }
      }`,
      { f: { categoryId: String(categoryId) } },
      null,
    );
    const out = [];
    const seen = new Set();
    for (const e of data?.markets?.edges ?? []) {
      collectMarketLikeObjects(e.node, out, seen);
    }
    return out;
  } catch (err) {
    console.warn('[predict] markets-by-categoryId failed:', err.message);
    return [];
  }
}

// Resolve a URL slug → markets by chaining `category(id: slug)` →
// `markets(filter: { categoryId })`. Falls back to latestCategorySlug
// for the renamed-slug redirect case.
async function resolveSlugViaCategories(originalSlug) {
  const tried = new Set();
  const slugsToTry = [originalSlug];
  // If the user pasted a renamed slug, latestCategorySlug returns the
  // current canonical one. Add it as a secondary attempt; for current
  // slugs it returns null and we just skip it.
  try {
    const data = await postGraphQL(
      `query($s: String!) { latestCategorySlug(slug: $s) }`,
      { s: originalSlug },
      null,
    );
    const canonical = data?.latestCategorySlug;
    if (typeof canonical === 'string' && canonical && canonical !== originalSlug) {
      slugsToTry.push(canonical);
    }
  } catch { /* ignore — fall back to user's slug */ }
  for (const s of slugsToTry) {
    if (tried.has(s)) continue;
    tried.add(s);
    const cat = await getCategoryBySlug(s);
    if (!cat?.id) continue;
    const ms = await getMarketsByCategoryId(cat.id);
    if (ms.length) return ms;
  }
  return [];
}

// Top-level resolver used by the bot. Tries every known path in order:
//   1. categorySlug GraphQL resolver (works for events + single markets)
//   2. HTML scrape of the rendered page (fails behind Cloudflare but
//      kept for non-CF deployments)
//   3. Cached slug-based 5-tier matcher
export async function resolveUrlToMarkets(input) {
  const isUrl = /^https?:\/\//i.test(String(input).trim());
  // SSRF defence — refuse full URLs that don't point at predict.fun.
  // Bare slugs / marketIds still go through (no fetch on user input).
  if (isUrl && !isAllowedPredictHost(input)) {
    return { markets: [], source: 'blocked-non-predict-host' };
  }
  const slug = extractSlugFromUrl(input);
  // Tier 1: GraphQL categorySlug resolver — works for the slug regardless
  // of what the bot's market list looks like, and handles event pages.
  if (slug) {
    try {
      const markets = await getMarketsByCategorySlug(slug);
      if (markets.length) return { markets, source: 'categorySlug', slug };
    } catch (err) {
      console.warn('[predict] categorySlug query failed:', err.message);
    }
  }
  // Tier 2: HTML scrape (may be blocked by Cloudflare on predict.fun).
  if (isUrl) {
    try {
      const { markets, meta } = await extractMarketsFromHtml(input);
      if (markets.length) return { markets, source: 'html', meta };
    } catch (err) {
      console.warn('[predict] HTML scrape failed:', err.message);
    }
  }
  // Tier 3: cached title/question slug matcher.
  if (!slug) return { markets: [], source: 'none' };
  const markets = await resolveSlugToMarkets(slug);
  return { markets, source: markets.length ? 'slug' : 'none', slug };
}

// Detects an input that's just a numeric market id (e.g. "257916").
// Returns the trimmed id string, or null. Bot uses this to short-circuit
// the slug-resolution path when the user already knows the id.
export function extractMarketId(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (/^\d{1,20}$/.test(s)) return s;
  return null;
}

// Extract a slug from a Predict.fun URL or accept a bare slug.
// Supports:
//   https://predict.fun/event/<slug>
//   https://predict.fun/zh-cn/event/<slug>
//   https://predict.fun/market/<slug>
//   https://predict.fun/<slug>
//   bare-slug-like-this
export function extractSlugFromUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  // Only attempt URL parsing when input actually looks like one. A bare
  // slug like "btc-price-2026" otherwise gets parsed as a hostname with
  // empty pathname and we'd lose it.
  if (/^https?:\/\//i.test(s) || s.includes('/')) {
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        const known = new Set(['event', 'events', 'market', 'markets']);
        const langRe = /^[a-z]{2}(-[a-z]{2})?$/i;
        let i = 0;
        if (langRe.test(parts[0])) i = 1;
        if (i < parts.length && known.has(parts[i].toLowerCase())) i += 1;
        if (i < parts.length) return decodeURIComponent(parts[i]).toLowerCase();
      }
    } catch {
      // fall through
    }
  }
  if (/^[a-z0-9][a-z0-9-]{1,200}$/i.test(s)) return s.toLowerCase();
  return null;
}

async function postGraphQL(query, variables, operationName) {
  const json = await fetchJson(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables, operationName }),
    timeoutMs: config.graphqlTimeoutMs,
    retries: 1,
  });
  if (json?.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json?.data;
}

const REQUIRED = ['id', 'conditionId', 'title', 'question'];
const OPTIONAL = ['status', 'tradingStatus', 'endsAt', 'isResolved', 'categorySlug', 'slug', 'marketSlug'];
let _selectionCache = null;
let _filterFieldsCache = null;

async function getMarketSelection() {
  if (_selectionCache) return { selection: _selectionCache, filterFields: _filterFieldsCache };
  let scalar = new Set();
  let filter = new Set();
  try {
    const intro = await postGraphQL(
      `query Introspect {
        market: __type(name: "Market") {
          fields {
            name
            type { kind name ofType { kind name ofType { kind name } } }
          }
        }
        filter: __type(name: "MarketFilterInput") { inputFields { name } }
      }`,
      {},
      'Introspect',
    );
    for (const f of intro?.market?.fields ?? []) {
      let t = f.type;
      while (t && (t.kind === 'NON_NULL' || t.kind === 'LIST')) t = t.ofType;
      if (t && (t.kind === 'SCALAR' || t.kind === 'ENUM')) scalar.add(f.name);
    }
    filter = new Set((intro?.filter?.inputFields ?? []).map((f) => f.name));
  } catch {
    // fall through to minimal selection
  }
  const fields = [];
  for (const f of REQUIRED) {
    if (!scalar.size || scalar.has(f)) fields.push(f);
  }
  for (const f of OPTIONAL) {
    if (scalar.has(f)) fields.push(f);
  }
  _selectionCache = fields.join(' ');
  _filterFieldsCache = filter;
  return { selection: _selectionCache, filterFields: filter };
}

let _cache = { at: 0, list: null, byId: null, inFlight: null };

async function listAllMarkets() {
  const { selection, filterFields } = await getMarketSelection();
  const filterClause = filterFields.has('isResolved') ? 'filter: { isResolved: false }, ' : '';
  const query = `query AllMarkets($first: Int!, $after: String) {
    markets(${filterClause}pagination: { first: $first, after: $after }) {
      edges { node { ${selection} } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const seen = new Map();
  let after = null;
  for (let page = 0; page < 100; page++) {
    let data;
    try {
      data = await postGraphQL(query, { first: 100, after }, 'AllMarkets');
    } catch {
      break;
    }
    const conn = data?.markets;
    const edges = conn?.edges ?? [];
    let progress = 0;
    for (const e of edges) {
      const node = e?.node;
      if (!node?.id || seen.has(String(node.id))) continue;
      seen.set(String(node.id), node);
      progress += 1;
    }
    const pageInfo = conn?.pageInfo;
    if (!edges.length || !progress) break;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    after = pageInfo.endCursor;
  }
  return [...seen.values()];
}

export async function getAllMarketsCached() {
  const now = Date.now();
  if (_cache.list && now - _cache.at < config.marketsCacheTtlMs) return _cache.list;
  if (_cache.inFlight) return _cache.inFlight;
  _cache.inFlight = (async () => {
    const list = await listAllMarkets();
    _cache.list = list;
    _cache.byId = new Map(list.map((m) => [String(m.id), m]));
    _cache.at = Date.now();
    return list;
  })().finally(() => { _cache.inFlight = null; });
  return _cache.inFlight;
}

export async function getMarketById(id) {
  await getAllMarketsCached();
  const hit = _cache.byId?.get(String(id));
  if (hit) return hit;
  const { selection } = await getMarketSelection();
  const data = await postGraphQL(
    `query GetMarket($id: ID!) { market(id: $id) { ${selection} } }`,
    { id: String(id) },
    'GetMarket',
  );
  return data?.market ?? null;
}

// REST `/v1/markets` exposes `categorySlug` (the actual URL slug) on
// every market, while GraphQL doesn't reliably surface it. Cache an
// id → categorySlug map so resolveSlugToMarkets has an authoritative
// fallback when GraphQL title/question slugify produces a different
// string than the URL.
let _slugCache = { at: 0, byId: null, inFlight: null };

function pickRestSlug(m) {
  return m?.categorySlug || m?.slug || m?.marketSlug || m?.category_slug || null;
}

export async function getSlugMapCached() {
  const now = Date.now();
  if (_slugCache.byId && now - _slugCache.at < config.marketsCacheTtlMs) return _slugCache.byId;
  if (_slugCache.inFlight) return _slugCache.inFlight;
  _slugCache.inFlight = (async () => {
    const map = new Map();
    let lastId = null;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ first: '100' });
      if (lastId != null) params.set('after', String(lastId));
      const url = `${config.restUrl}/markets?${params.toString()}`;
      let arr = [];
      try {
        const json = await fetchJson(url, {
          headers: restHeaders(),
          timeoutMs: config.orderbookTimeoutMs,
          retries: 1,
        });
        const data = json?.data ?? json;
        arr = Array.isArray(data) ? data : (data?.markets ?? data?.items ?? data?.nodes ?? []);
      } catch {
        break;
      }
      if (!arr.length) break;
      let progress = 0;
      for (const m of arr) {
        if (m?.id == null || map.has(String(m.id))) continue;
        const slug = pickRestSlug(m);
        if (slug) {
          // Store the full record so the resolver can return title/conditionId
          // without round-tripping back to GraphQL.
          map.set(String(m.id), { slug: String(slug).toLowerCase(), market: m });
          progress += 1;
        }
      }
      if (!progress) break;
      if (arr.length < 100) break;
      const newLast = arr[arr.length - 1]?.id;
      if (newLast == null || newLast === lastId) break;
      lastId = newLast;
    }
    _slugCache.byId = map;
    _slugCache.at = Date.now();
    return map;
  })().finally(() => { _slugCache.inFlight = null; });
  return _slugCache.inFlight;
}

// Resolve a slug to ALL matching markets — single-market URLs return one
// hit, event-level URLs (multiple sub-markets share question / categorySlug)
// return many. Each match: { id, conditionId, title, question, slug }.
export async function resolveSlugToMarkets(slug) {
  if (!slug) return [];
  const all = await getAllMarketsCached();
  const seen = new Set();
  const matches = [];
  const add = (m, slugOverride) => {
    const id = String(m.id);
    if (seen.has(id)) return;
    seen.add(id);
    matches.push({
      id,
      conditionId: m.conditionId ?? null,
      title: m.title ?? null,
      question: m.question ?? null,
      slug: slugOverride ?? m.categorySlug ?? m.slug ?? m.marketSlug ?? null,
    });
  };
  // Tier 1: exact title-slug match (single-market URLs).
  for (const m of all) {
    if (slugify(m.title ?? '') === slug) add(m);
  }
  // Tier 2: question slug (event-level URLs whose subs share question text).
  for (const m of all) {
    if (slugify(m.question ?? '') === slug) add(m);
  }
  // Tier 3: year-augmented variants — Predict.fun URLs often have the
  // year ("...-2026") that the API title omits.
  for (const m of all) {
    if (slugifyWithYear(m.title ?? '') === slug) add(m);
  }
  for (const m of all) {
    if (slugifyWithYear(m.question ?? '') === slug) add(m);
  }
  // Tier 4: GraphQL-exposed categorySlug.
  for (const m of all) {
    const cs = m.categorySlug ?? m.slug ?? m.marketSlug;
    if (cs && String(cs).toLowerCase() === slug) add(m);
  }
  // Tier 5: REST slug map (authoritative — has categorySlug for every
  // market regardless of whether GraphQL exposes it). Only consult if
  // the GraphQL pass came up empty, since REST scan is a separate
  // network round-trip.
  if (matches.length === 0) {
    try {
      const slugMap = await getSlugMapCached();
      for (const [id, entry] of slugMap.entries()) {
        if (entry.slug !== slug) continue;
        // Prefer the GraphQL record (it has rewardTimings etc) but fall
        // back to the REST one so we still return something.
        const graphM = all.find((x) => String(x.id) === id);
        add(graphM ?? entry.market, entry.slug);
      }
    } catch {
      // best-effort
    }
  }
  return matches;
}

// Suggest similar markets when a slug doesn't match exactly. Used by
// the bot to render "did you mean…" buttons. Returns up to `limit`
// markets ranked by how many slug tokens they contain.
export async function fuzzySlugSuggestions(slug, limit = 8) {
  if (!slug) return [];
  const tokens = slug.split('-').filter((t) => t.length >= 3);
  if (!tokens.length) return [];
  const all = await getAllMarketsCached();
  const minScore = Math.max(1, Math.ceil(tokens.length / 2));
  const scored = [];
  for (const m of all) {
    const hay = `${slugify(m.title ?? '')} ${slugify(m.question ?? '')} ${m.categorySlug ?? ''}`;
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    if (score >= minScore) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ m }) => ({
    id: String(m.id),
    conditionId: m.conditionId ?? null,
    title: m.title ?? null,
    question: m.question ?? null,
    slug: m.categorySlug ?? m.slug ?? m.marketSlug ?? null,
  }));
}

const ORDERBOOK_DEPTH = 3;
const ID_FIELDS = ['conditionId', 'id'];
const FALLBACK_TEMPLATES = ['/markets/{key}/orderbook', '/orderbook/{key}'];

function topNOfBook(rows, n = ORDERBOOK_DEPTH) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (let i = 0; i < n && i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const price = Number(r[0]);
    const size = Number(r[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    out.push({ price, size });
  }
  return out;
}

function buildUrl(template, key) {
  const path = template.replace('{key}', encodeURIComponent(key));
  return `${config.restUrl}${path.startsWith('/') ? path : '/' + path}`;
}

async function tryFetch(template, key) {
  const url = buildUrl(template, key);
  try {
    const json = await fetchJson(url, {
      headers: restHeaders(),
      timeoutMs: config.orderbookTimeoutMs,
      retries: 1,
    });
    return { ok: true, url, json };
  } catch (err) {
    return { ok: false, url, status: err.status, msg: err.message };
  }
}

// Self-healing orderbook fetcher. Tries the configured (path, key) first,
// then fallback templates / id fields drawn from the market record. Caches
// the working combination per market so subsequent ticks go straight to
// the right URL.
const _obCache = new Map(); // marketId -> { template, key }

export async function getOrderbook(market) {
  const ctxId = String(market.id);
  const preferredKey = market[config.orderbookKeyField] ?? market.conditionId ?? market.id;
  const attempts = [];
  const cached = _obCache.get(ctxId);
  if (cached) attempts.push(cached);
  attempts.push({ template: config.orderbookPathTemplate, key: String(preferredKey) });
  for (const tpl of [config.orderbookPathTemplate, ...FALLBACK_TEMPLATES]) {
    for (const f of ID_FIELDS) {
      const v = market[f];
      if (v == null || v === '') continue;
      attempts.push({ template: tpl, key: String(v) });
    }
  }
  const seen = new Set();
  const dedup = attempts.filter((a) => {
    const k = `${a.template}|${a.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let lastErr = null;
  for (const a of dedup) {
    const r = await tryFetch(a.template, a.key);
    if (r.ok) {
      _obCache.set(ctxId, { template: a.template, key: a.key });
      const data = r.json?.data ?? r.json;
      const bids = topNOfBook(data?.bids);
      const asks = topNOfBook(data?.asks);
      return {
        marketId: ctxId,
        updatedAtMs: Number(data?.updateTimestampMs ?? Date.now()),
        bids,
        asks,
        bestBid: bids[0] ?? null,
        bestAsk: asks[0] ?? null,
      };
    }
    lastErr = `${r.status ?? '?'} ${r.url}: ${(r.msg ?? '').slice(0, 120)}`;
  }
  throw new Error(`Orderbook not found for ${ctxId} (tried ${dedup.length}). Last: ${lastErr}`);
}
