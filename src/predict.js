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

// Resolve a slug to ALL matching markets — single-market URLs return one
// hit, event-level URLs (multiple sub-markets share question / categorySlug)
// return many. Each match: { id, conditionId, title, question, slug }.
export async function resolveSlugToMarkets(slug) {
  if (!slug) return [];
  const all = await getAllMarketsCached();
  const seen = new Set();
  const matches = [];
  const add = (m) => {
    const id = String(m.id);
    if (seen.has(id)) return;
    seen.add(id);
    matches.push({
      id,
      conditionId: m.conditionId ?? null,
      title: m.title ?? null,
      question: m.question ?? null,
      slug: m.categorySlug ?? m.slug ?? m.marketSlug ?? null,
    });
  };
  for (const m of all) {
    if (slugify(m.title ?? '') === slug) add(m);
  }
  for (const m of all) {
    if (slugify(m.question ?? '') === slug) add(m);
  }
  for (const m of all) {
    const cs = m.categorySlug ?? m.slug ?? m.marketSlug;
    if (cs && String(cs).toLowerCase() === slug) add(m);
  }
  return matches;
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
