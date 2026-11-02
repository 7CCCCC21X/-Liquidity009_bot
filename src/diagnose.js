// /diagnose <url|slug> — run the URL → market resolution chain step by
// step ON THE SERVER (Railway) and report every request's real outcome:
// HTTP status, latency, GraphQL `errors`, Cloudflare blocks. The bot's
// normal path swallows these failures and only says "没匹配到市场", which
// can't tell "this market doesn't exist" apart from "every request to
// Predict.fun is failing". Running it here (not on a laptop) matters:
// the server's network, IP reputation and env vars are what the bot uses.

import { config } from './config.js';
import { fetchJson } from './http.js';
import { htmlEscape } from './telegram.js';
import {
  extractSlugFromUrl, isAllowedPredictHost, extractMarketsFromHtml,
  resolveUrlToMarkets, fuzzySlugSuggestions, getAllMarketsCached, restLimiter,
} from './predict.js';

const STEP_TIMEOUT_MS = 15_000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CF_RE = /cloudflare|just a moment|cf-chl|cf_chl|attention required/i;

function clip(s, n = 240) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Never let the API key leak into a chat message.
function redact(s) {
  const k = config.predictApiKey;
  let t = String(s ?? '');
  if (k) t = t.split(k).join('<key>');
  return t;
}

// One GraphQL request that reports instead of throwing. `withKey` sends
// x-api-key — the bot's own GraphQL calls never do, so comparing the two
// tells us whether the endpoint started requiring it.
async function gql(query, variables = {}, { withKey = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withKey && config.predictApiKey) headers['x-api-key'] = config.predictApiKey;
  const t0 = Date.now();
  try {
    const json = await fetchJson(config.graphqlUrl, {
      method: 'POST', headers, body: JSON.stringify({ query, variables }),
      timeoutMs: STEP_TIMEOUT_MS, retries: 0,
    });
    const ms = Date.now() - t0;
    if (json?.errors?.length) {
      return { ok: false, ms, status: 200, data: json.data ?? null, error: `GraphQL errors: ${clip(JSON.stringify(json.errors))}` };
    }
    return { ok: true, ms, status: 200, data: json?.data ?? null };
  } catch (err) {
    // fetchJson's message already carries the first 200 chars of the body.
    return { ok: false, ms: Date.now() - t0, status: err.status ?? null, error: clip(err.message, 260), cf: CF_RE.test(err.body ?? '') };
  }
}

export async function runDiagnose(input) {
  const raw = String(input ?? '').trim();
  const out = [];
  const facts = {};
  const line = (ok, title, ms, detail) => {
    const icon = ok === true ? '✅' : ok === false ? '❌' : '➖';
    out.push(`${icon} <b>${htmlEscape(title)}</b>${ms != null ? ` <i>${ms}ms</i>` : ''}`);
    if (detail) out.push(`<code>${htmlEscape(redact(detail))}</code>`);
  };

  out.push('<b>🩺 解析诊断</b>  <i>（在服务器上实际请求）</i>');
  out.push(`<i>GraphQL ${htmlEscape(config.graphqlUrl)} · REST ${htmlEscape(config.restUrl)} · API key ${config.predictApiKey ? '已设置' : '未设置'}</i>`);
  out.push('');

  // 1. slug
  const slug = extractSlugFromUrl(raw);
  const isUrl = /^https?:\/\//i.test(raw);
  if (!slug) {
    line(false, '1. 提取 slug', null, `无法从输入里提取 slug: ${clip(raw, 120)}`);
    return out.join('\n');
  }
  if (isUrl && !isAllowedPredictHost(raw)) {
    line(false, '1. 提取 slug', null, '不是 https://predict.fun 的网址，机器人会拒绝抓取');
    return out.join('\n');
  }
  line(true, '1. 提取 slug', null, slug);

  // 2. GraphQL reachable at all? (exactly how the bot calls it: no key)
  const ping = await gql('{ __typename }');
  facts.gqlNoKey = ping.ok;
  line(ping.ok, '2. GraphQL 连通（不带 key，机器人当前方式）', ping.ms,
    ping.ok ? `HTTP 200 · ${clip(JSON.stringify(ping.data))}` : `HTTP ${ping.status ?? '—'} · ${ping.error}${ping.cf ? ' · ⚠️ 疑似 Cloudflare 拦截' : ''}`);
  if (config.predictApiKey) {
    const pingKey = await gql('{ __typename }', {}, { withKey: true });
    facts.gqlWithKey = pingKey.ok;
    line(pingKey.ok, '2b. GraphQL 连通（带 key）', pingKey.ms,
      pingKey.ok ? 'HTTP 200' : `HTTP ${pingKey.status ?? '—'} · ${pingKey.error}`);
  }

  // 3. latestCategorySlug — renamed-slug redirect
  const latest = await gql('query($s: String!) { latestCategorySlug(slug: $s) }', { s: slug });
  line(latest.ok ? true : false, '3. latestCategorySlug', latest.ms,
    latest.ok ? `返回: ${JSON.stringify(latest.data?.latestCategorySlug ?? null)}` : latest.error);

  // 4. category(id: slug) → numeric id (the bot's primary resolver)
  const cat = await gql('query($id: ID!) { category(id: $id) { __typename id } }', { id: slug });
  const catId = cat.data?.category?.id ?? null;
  facts.catId = catId;
  line(cat.ok && !!catId, '4. category(id: slug)', cat.ms,
    cat.ok ? (catId ? `${cat.data.category.__typename} id=${catId}` : '返回 null — 接口里查不到这个 slug') : cat.error);

  // 5. markets(filter: { categoryId })
  if (catId) {
    const ms = await gql(
      'query($f: MarketFilterInput!) { markets(filter: $f, pagination: { first: 100 }) { edges { node { id title question } } } }',
      { f: { categoryId: String(catId) } },
    );
    const nodes = (ms.data?.markets?.edges ?? []).map((e) => e?.node).filter(Boolean);
    facts.catMarkets = nodes.length;
    line(ms.ok && nodes.length > 0, '5. markets(filter: categoryId)', ms.ms,
      ms.ok
        ? `${nodes.length} 个市场${nodes.length ? ': ' + nodes.slice(0, 5).map((n) => `${n.id} ${clip(n.title ?? n.question, 40)}`).join(' | ') : ''}`
        : ms.error);
  } else {
    line(null, '5. markets(filter: categoryId)', null, '跳过（第 4 步没拿到分类 id）');
  }

  // 6. HTML page + __NEXT_DATA__
  if (isUrl) {
    const t0 = Date.now();
    let html = null;
    try {
      html = await fetchJson(raw, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeoutMs: STEP_TIMEOUT_MS, retries: 0, parseJson: false,
      });
      const hasNext = /id=["']__NEXT_DATA__["']/i.test(html ?? '');
      const cf = CF_RE.test(html ?? '') && !hasNext;
      let found = 0;
      if (hasNext) {
        try { found = (await extractMarketsFromHtml(raw)).markets.length; } catch { /* reported as 0 */ }
      }
      facts.htmlMarkets = found;
      line(found > 0, '6. 抓网页 __NEXT_DATA__', Date.now() - t0,
        `HTTP 200 · ${(html?.length ?? 0).toLocaleString('en-US')} 字节 · __NEXT_DATA__ ${hasNext ? '有' : '无'} · 市场 ${found} 个${cf ? ' · ⚠️ Cloudflare 验证页' : ''}`);
    } catch (err) {
      const cf = CF_RE.test(err.body ?? '');
      facts.htmlBlocked = cf || err.status === 403;
      line(false, '6. 抓网页 __NEXT_DATA__', Date.now() - t0,
        `HTTP ${err.status ?? '—'} · ${clip(err.message, 160)}${cf ? ' · ⚠️ Cloudflare 拦截' : ''}`);
    }
  } else {
    line(null, '6. 抓网页 __NEXT_DATA__', null, '跳过（输入不是网址）');
  }

  // 7. One page of the market list, errors surfaced (the bot's own
  //    listAllMarkets swallows them and silently returns an empty list).
  const page = await gql('query { markets(pagination: { first: 3 }) { edges { node { id title } } } }');
  const pageN = page.data?.markets?.edges?.length ?? 0;
  facts.listOk = page.ok && pageN > 0;
  line(facts.listOk, '7. 市场列表接口（取 3 条）', page.ms,
    page.ok ? `${pageN} 条: ${(page.data?.markets?.edges ?? []).map((e) => `${e?.node?.id} ${clip(e?.node?.title, 30)}`).join(' | ')}` : page.error);

  // 8. The bot's cached full list (what slug matching + 相似市场 use)
  {
    const t0 = Date.now();
    try {
      const all = await getAllMarketsCached();
      facts.cachedCount = all.length;
      line(all.length > 0, '8. 机器人缓存的市场列表', Date.now() - t0,
        `${all.length} 个市场${all.length ? '' : ' — 列表为空，slug 匹配和「相似市场」都不可能命中'}`);
    } catch (err) {
      facts.cachedCount = 0;
      line(false, '8. 机器人缓存的市场列表', Date.now() - t0, clip(err.message, 200));
    }
  }

  // 9. REST (uses the key; orderbooks depend on it)
  {
    const t0 = Date.now();
    const headers = { Accept: 'application/json' };
    if (config.predictApiKey) headers['x-api-key'] = config.predictApiKey;
    try {
      const json = await fetchJson(`${config.restUrl}/markets?first=3`, {
        headers, timeoutMs: STEP_TIMEOUT_MS, retries: 0, limiter: restLimiter,
      });
      const data = json?.data ?? json;
      const arr = Array.isArray(data) ? data : (data?.markets ?? data?.items ?? []);
      line(true, '9. REST /markets', Date.now() - t0, `HTTP 200 · ${arr.length} 条`);
    } catch (err) {
      line(false, '9. REST /markets', Date.now() - t0, `HTTP ${err.status ?? '—'} · ${clip(err.message, 200)}`);
    }
  }

  // 10. End-to-end: exactly what pasting the URL does today
  {
    const t0 = Date.now();
    let r = { markets: [], source: 'error' };
    let sugg = [];
    try { r = await resolveUrlToMarkets(raw); } catch (err) { r.error = err.message; }
    try { sugg = await fuzzySlugSuggestions(slug, 8); } catch { /* 0 */ }
    facts.endToEnd = r.markets.length;
    line(r.markets.length > 0, '10. 完整解析（等同直接发网址）', Date.now() - t0,
      `命中 ${r.markets.length} 个（来源 ${r.source}）· 相似市场 ${sugg.length} 个${r.error ? ` · ${clip(r.error, 120)}` : ''}`);
  }

  out.push('', `<b>结论</b>：${htmlEscape(conclude(facts))}`);
  return out.join('\n');
}

function conclude(f) {
  if (f.endToEnd > 0) return '现在能解析出市场。如果直接发网址仍失败，多半是 10 分钟市场缓存还没过期，稍后再试。';
  if (!f.gqlNoKey && f.gqlWithKey) return 'GraphQL 现在要求 API key，而机器人的 GraphQL 请求没带 key。需要改代码让 GraphQL 也带上 PREDICT_API_KEY。';
  if (!f.gqlNoKey) return 'GraphQL 接口在服务器上整体连不通（见第 2 步状态码）。不是这个市场的问题，是接口或网络层面的问题。';
  if (!f.listOk) return 'GraphQL 能连通，但市场列表查询报错（见第 7 步），所以缓存为空，任何网址都匹配不到。';
  if (!f.catId && (f.htmlBlocked || !f.htmlMarkets)) return 'GraphQL 正常，但 category(id: slug) 查不到这个 slug，网页抓取也拿不到数据。可能是 Predict.fun 对这类新页面换了 slug 规则，需要按第 3–6 步的返回调整解析逻辑。';
  if (f.catId && !f.catMarkets) return '能查到分类，但按分类查市场返回 0 个（见第 5 步）。可能是接口的筛选字段变了。';
  return '各接口都能连通但没有匹配结果，请把这条诊断截图发给开发者。';
}
