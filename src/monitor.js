import { config } from './config.js';
import { getOrderbook, getMarketById } from './predict.js';
import { sendMessage, htmlEscape } from './telegram.js';
import {
  listAllSubscriptions, removeSubscription, saveState,
  ALL_LEVELS, LEVEL_LABEL, subKey,
} from './state.js';
import { appendEvent } from './history.js';

// Per-sub last-notified snapshot (so each sub diffs against the book
// at the moment it last got an alert, not against an unrelated sub's
// state). Per-sub last notify time enforces NOTIFY_COOLDOWN_SEC.
const lastBookPerSub = new Map();
const lastNotify = new Map();

// Build a Predict.fun market URL, optionally with the configured
// referral code. Returns null when slug is missing — caller falls
// back to plain text. Locale and ref code both env-driven.
export function marketUrl(slug) {
  if (!slug) return null;
  const locale = config.predictUrlLocale ? `/${config.predictUrlLocale}` : '';
  const ref = config.predictRefCode ? `?ref=${encodeURIComponent(config.predictRefCode)}` : '';
  return `https://predict.fun${locale}/market/${encodeURIComponent(slug)}${ref}`;
}

// Render a market title as an HTML link if we have the URL slug for
// it, otherwise as plain HTML-escaped text. Caller can wrap the
// result in <b>/<i>/etc. — Telegram's HTML parse_mode allows nesting
// (<b><a href="...">title</a></b>).
export function marketLink(title, slug) {
  const safeTitle = htmlEscape(title || '');
  const url = marketUrl(slug);
  return url ? `<a href="${url}">${safeTitle}</a>` : safeTitle;
}

// Seed the per-sub baseline with a snapshot taken at subscribe time.
// Without this, the user gets a "🆕 初次抓取" alert on the next poll
// tick — duplicating the orderbook the subscribe-success message
// already showed. Calling primeSubscriptionSnapshot suppresses that.
export function primeSubscriptionSnapshot(chatId, marketId, snap) {
  if (!snap) return;
  lastBookPerSub.set(subKey(chatId, marketId), snap);
  // Mark as just-notified so the cooldown still applies even though
  // we didn't send an in-band alert. Stops a cooldown=1s subscription
  // from being woken up by the very next poll.
  lastNotify.set(subKey(chatId, marketId), Date.now());
}

// Standard 4-button action row attached to every notification + every
// /list card. The callback handlers for these live in src/index.js.
export function subActionKeyboard(marketId) {
  return {
    inline_keyboard: [[
      { text: '🔍 抓取', callback_data: `probe:${marketId}` },
      { text: '📐 档位', callback_data: `lvl:${marketId}:open` },
      { text: '📝 备注', callback_data: `note:${marketId}` },
      { text: '🛑 停止', callback_data: `unsub:${marketId}` },
    ]],
  };
}

export function fmtSide(side) {
  if (!side) return '<i>无</i>';
  const price = side.price.toFixed(4);
  const size = side.size.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${price} × ${size}`;
}

function pad(s, width, align = 'left') {
  const str = String(s);
  const need = Math.max(0, width - str.length);
  return align === 'right' ? ' '.repeat(need) + str : str + ' '.repeat(need);
}

function fmtPriceCell(side) {
  return side ? side.price.toFixed(4) : '   —  ';
}
function fmtSizeCell(side) {
  return side ? side.size.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
}

// Render a per-row delta marker in plain text. Empty string when no
// change meets thresholds. Used for the change-list section.
function fmtRowDelta(prev, cur) {
  if (!prev && !cur) return '';
  if (!prev && cur) return '新挂';
  if (prev && !cur) return '撤单';
  const dp = cur.price - prev.price;
  const ds = cur.size - prev.size;
  const parts = [];
  if (Math.abs(dp) >= 1e-9) parts.push(`${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`);
  if (Math.abs(ds) >= 1) {
    const fmt = Math.abs(ds).toLocaleString('en-US', { maximumFractionDigits: 0 });
    parts.push(`量${ds > 0 ? '↑' : '↓'}${fmt}`);
  }
  return parts.join(' ');
}

function getLevel(snap, key) {
  if (!snap) return null;
  const idx = Number(key.slice(3)) - 1;
  const side = key.startsWith('bid') ? snap.bids : snap.asks;
  return side?.[idx] ?? null;
}

// mode: 'both' | 'price' | 'size'. Default 'both' means a change to
// either price or size triggers; 'price' / 'size' mute the other.
function levelDiff(prev, cur, mode = 'both') {
  if (!prev && !cur) return false;
  if (!prev || !cur) return true;
  const checkPrice = mode !== 'size';
  const checkSize = mode !== 'price';
  if (checkPrice && Math.abs(prev.price - cur.price) >= config.priceEpsilon) return true;
  if (checkSize) {
    const sizeDelta = Math.abs(prev.size - cur.size);
    if (sizeDelta >= config.sizeAbsoluteMin) return true;
    const base = Math.max(prev.size, cur.size, 1);
    if (sizeDelta / base >= config.sizeRelativeEpsilon) return true;
  }
  return false;
}

function bookChanged(prev, cur, levels, mode = 'both') {
  if (!prev) return true;
  for (const k of levels) {
    if (levelDiff(getLevel(prev, k), getLevel(cur, k), mode)) return true;
  }
  return false;
}

// Render the book as a side-by-side <pre> table (Bid | Ask), plus the
// spread/mid/timestamp meta line. The <pre> block guarantees monospace
// alignment in Telegram. ASCII-only content inside <pre> avoids the
// CJK 2-cell-width alignment problem (markers/labels live OUTSIDE).
export function fmtBook(prev, snap, levels) {
  const set = new Set(levels);
  // Column widths chosen so 0.7100 (6) and 40,410 (6) both fit; bumping
  // the size column to 7 leaves room for 5-digit shares.
  const W_PRICE = 6;
  const W_SIZE = 7;

  const rows = [];
  // ASCII-only inside <pre> so columns stay aligned across monospace
  // fonts (CJK chars render 2-cell-wide on most Telegram clients but
  // the pad() math counts chars, not display cells). Bid/Ask are
  // universal trader column anchors; the headline above already
  // names them in Chinese (买1/卖1). '*' marks watched levels.
  rows.push(`     ${pad('Bid', W_PRICE + W_SIZE + 2)}   ${pad('Ask', W_PRICE + W_SIZE + 2)}`);
  for (let i = 0; i < 3; i++) {
    const bidWatched = set.has(`bid${i + 1}`);
    const askWatched = set.has(`ask${i + 1}`);
    const bid = snap.bids?.[i];
    const ask = snap.asks?.[i];
    const eyeBid = bidWatched ? '*' : ' ';
    const eyeAsk = askWatched ? '*' : ' ';
    const bidPrice = pad(fmtPriceCell(bid), W_PRICE, 'right');
    const bidSize = pad(fmtSizeCell(bid), W_SIZE, 'right');
    const askPrice = pad(fmtPriceCell(ask), W_PRICE, 'right');
    const askSize = pad(fmtSizeCell(ask), W_SIZE, 'right');
    rows.push(`L${i + 1} ${eyeBid} ${bidPrice} ${bidSize}   ${eyeAsk} ${askPrice} ${askSize}`);
  }
  return `<pre>${rows.join('\n')}</pre>`;
}

// 价差 + 中价 + 抓取时间。Times shown in UTC (avoids per-user TZ
// config); marker dropped from the line to keep it visually quiet.
export function fmtSpreadLine(snap) {
  const bb = snap.bestBid?.price;
  const ba = snap.bestAsk?.price;
  const time = new Date(snap.updatedAtMs ?? Date.now()).toISOString().slice(11, 19);
  if (bb == null || ba == null) return `<i>抓取于 ${time} · 缺一侧深度</i>`;
  const spread = ba - bb;
  const mid = (ba + bb) / 2;
  return `<i>价差 ${spread.toFixed(4)} · 中价 ${mid.toFixed(4)} · 抓取于 ${time}</i>`;
}

// Compact change-list: one line per watched level whose change cleared
// the threshold. Nothing emitted if no level fired (caller skips
// section entirely). Plain text — caller wraps in <i>.
export function fmtChangeLines(prev, snap, levels, mode = 'both') {
  if (!prev) return [];
  const out = [];
  for (const k of levels) {
    const p = getLevel(prev, k);
    const c = getLevel(snap, k);
    if (!levelDiff(p, c, mode)) continue;
    const label = LEVEL_LABEL[k] ?? k;
    const delta = fmtRowDelta(p, c);
    if (delta) out.push(`  ${label}: ${delta}`);
  }
  return out;
}

// Single-line headline summarising what kind of change triggered the
// alert. Kept short — the per-level deltas in fmtBook carry the details.
function fmtHeadline(prev, cur, levels, mode = 'both') {
  if (!prev) return '🆕 初次抓取';
  let nChanges = 0;
  let biggestPrice = 0;
  let biggestSize = 0;
  for (const k of levels) {
    const p = getLevel(prev, k);
    const c = getLevel(cur, k);
    if (!levelDiff(p, c, mode)) continue;
    nChanges += 1;
    if (p && c) {
      const dp = Math.abs(c.price - p.price);
      const ds = Math.abs(c.size - p.size);
      if (dp > biggestPrice) biggestPrice = dp;
      if (ds > biggestSize) biggestSize = ds;
    }
  }
  if (!nChanges) return '深度变动';
  const parts = [`${nChanges} 档变动`];
  if (mode !== 'size' && biggestPrice >= 0.0001) parts.push(`最大价 Δ${biggestPrice.toFixed(4)}`);
  if (mode !== 'price' && biggestSize >= 1) parts.push(`最大量 Δ${Math.round(biggestSize).toLocaleString('en-US')}`);
  // Plain-text mode marker — the caller wraps the whole headline in
  // <i>htmlEscape(...)</i>, so any HTML inserted here would render as
  // literal "&lt;i&gt;...&lt;/i&gt;" in Telegram.
  if (mode === 'price') parts.push('只看价');
  else if (mode === 'size') parts.push('只看量');
  return '📈 ' + parts.join(' · ');
}

// Fetch a single market's orderbook with the same fallbacks the
// monitor uses. Returns { snap } on success or { error } on failure;
// callers decide whether to log or skip.
async function fetchMarketSnap(marketId, group) {
  try {
    let market = await getMarketById(marketId);
    if (!market) {
      const s0 = group[0];
      if (!s0.conditionId) return { marketId, group, error: 'no market record and no cached conditionId' };
      market = { id: marketId, conditionId: s0.conditionId };
    }
    const snap = await getOrderbook(market);
    return { marketId, group, snap };
  } catch (err) {
    return { marketId, group, error: err.message };
  }
}

// Run async tasks with a concurrency cap. Simple worker pool — all
// tasks share a single index counter. Preserves input order in the
// returned results array.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const cap = Math.max(1, Math.min(limit | 0, items.length));
  await Promise.all(Array.from({ length: cap }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

async function pollOnce() {
  const subs = listAllSubscriptions();
  if (!subs.length) return;
  const byMarket = new Map();
  for (const s of subs) {
    if (!byMarket.has(s.marketId)) byMarket.set(s.marketId, []);
    byMarket.get(s.marketId).push(s);
  }
  // Fetch every market in parallel (bounded). With 1 sub the wall-clock
  // is one HTTP call; with N subs it's max(L), not N×L.
  const groups = [...byMarket.entries()];
  const fetched = await runWithConcurrency(
    groups,
    config.pollConcurrency,
    ([marketId, group]) => fetchMarketSnap(marketId, group),
  );
  // Process notifications serially per market so we don't fire
  // multiple Telegram sends in the same tick (rate-limit friendly).
  const now = Date.now();
  for (const result of fetched) {
    if (result.error) {
      console.warn(new Date().toISOString(), `[monitor] ${result.marketId} fetch failed:`, result.error);
      continue;
    }
    const { marketId, group, snap } = result;
    for (const s of group) {
      const levels = s.levels?.length ? s.levels : ALL_LEVELS;
      const mode = s.triggerMode || 'both';
      const k = subKey(s.chatId, s.marketId);
      const prev = lastBookPerSub.get(k);
      // Skip paused subs; reset baseline so resume doesn't dump a
      // stale diff. Auto-clear when the timer is up — handled by
      // index.js periodically since we can't write state from here.
      if (s.pausedUntil && now < s.pausedUntil) {
        lastBookPerSub.set(k, snap);
        continue;
      }
      // Empty levels = monitoring nothing (user toggled all off). Snapshot
      // the book so re-enabling levels later doesn't dump a stale diff.
      if (!s.levels?.length) {
        lastBookPerSub.set(k, snap);
        continue;
      }
      if (!bookChanged(prev, snap, levels, mode)) continue;
      const lastSentAt = lastNotify.get(k) ?? 0;
      if (prev && now - lastSentAt < config.notifyCooldownMs) continue;
      const headline = fmtHeadline(prev, snap, levels, mode);
      const body = fmtBook(prev, snap, levels);
      const spreadLine = fmtSpreadLine(snap);
      const changeLines = fmtChangeLines(prev, snap, levels, mode);
      const titleLink = marketLink(s.title || `Market ${s.marketId}`, s.slug);
      const lines = [`<b>📊 ${titleLink}</b>`];
      if (s.note) lines.push(`📝 <i>${htmlEscape(s.note)}</i>`);
      lines.push(`<i>${htmlEscape(headline)}</i>`);
      if (changeLines.length) {
        lines.push('');
        lines.push('<b>变动</b>');
        for (const l of changeLines) lines.push(`<code>${l}</code>`);
      }
      lines.push('', spreadLine, '', body);
      lines.push('', `<code>id=${s.marketId}</code>`);
      const text = lines.join('\n');
      const replyMarkup = subActionKeyboard(s.marketId);
      try {
        await sendMessage(s.chatId, text, { replyMarkup });
        lastNotify.set(k, now);
        lastBookPerSub.set(k, snap);
        // Persist a structured record of the change. Keep the payload
        // small — top of book + summary is enough to reconstruct what
        // moved when reading later. prev=null on first poll.
        await appendEvent({
          chatId: s.chatId,
          marketId: s.marketId,
          title: s.title || null,
          note: s.note || null,
          levels,
          summary: headline,
          // Save full top-3 in both prev and cur so /history can show
          // changes on bid2/3 + ask2/3 too. Old records still parse —
          // /history's renderer falls back to bestBid/bestAsk only.
          prev: prev ? {
            bestBid: prev.bestBid, bestAsk: prev.bestAsk,
            bids: prev.bids, asks: prev.asks,
          } : null,
          cur: { bestBid: snap.bestBid, bestAsk: snap.bestAsk, bids: snap.bids, asks: snap.asks },
          slug: s.slug || null,
          updatedAtMs: snap.updatedAtMs,
        });
      } catch (err) {
        console.warn('[monitor] send failed', s.chatId, err.message);
        if (err.message?.includes('403')) {
          removeSubscription(s.chatId, s.marketId);
          await saveState();
        }
      }
    }
  }
}

let _running = false;
export async function startMonitorLoop({ signal }) {
  if (_running) return;
  _running = true;
  while (!signal?.aborted) {
    const t0 = Date.now();
    try {
      await pollOnce();
    } catch (err) {
      console.error(new Date().toISOString(), '[monitor] tick error:', err.message);
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(config.pollMinIntervalMs, config.pollIntervalMs - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
  _running = false;
}
