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

export function fmtSide(side) {
  if (!side) return '<i>无</i>';
  const price = side.price.toFixed(4);
  const size = side.size.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${price} × ${size}`;
}

// Compact inline delta marker. Returns '' when no meaningful change so
// the renderer can omit the trailing italics block entirely. Direction
// arrows: ↑ for increase, ↓ for decrease.
function fmtInlineDelta(prev, cur) {
  if (!prev && !cur) return '';
  if (!prev && cur) return ' <i>(新)</i>';
  if (prev && !cur) return ' <i>(撤)</i>';
  const dp = cur.price - prev.price;
  const ds = cur.size - prev.size;
  const parts = [];
  if (Math.abs(dp) >= 1e-9) {
    parts.push(`${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`);
  }
  if (Math.abs(ds) >= 1) {
    const fmt = Math.abs(ds).toLocaleString('en-US', { maximumFractionDigits: 0 });
    parts.push(`${ds > 0 ? '↑' : '↓'}${fmt}`);
  }
  return parts.length ? ` <i>${parts.join(' ')}</i>` : '';
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

// Render the book with deltas inline next to each level. Watched levels
// get the 👁 marker. Unwatched levels are still shown for context but
// without an eye and without a delta annotation (to keep them quiet).
export function fmtBook(prev, snap, levels) {
  const set = new Set(levels);
  const lines = [];
  lines.push('<b>买单 (Bids)</b>');
  for (let i = 0; i < 3; i++) {
    const k = `bid${i + 1}`;
    const watched = set.has(k);
    const cur = snap.bids?.[i];
    const p = prev?.bids?.[i];
    const mark = watched ? '👁' : ' ·';
    const delta = watched ? fmtInlineDelta(p, cur) : '';
    lines.push(`  ${mark} L${i + 1}: ${fmtSide(cur)}${delta}`);
  }
  lines.push('<b>卖单 (Asks)</b>');
  for (let i = 0; i < 3; i++) {
    const k = `ask${i + 1}`;
    const watched = set.has(k);
    const cur = snap.asks?.[i];
    const p = prev?.asks?.[i];
    const mark = watched ? '👁' : ' ·';
    const delta = watched ? fmtInlineDelta(p, cur) : '';
    lines.push(`  ${mark} L${i + 1}: ${fmtSide(cur)}${delta}`);
  }
  return lines.join('\n');
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
  if (mode === 'price') parts.push('<i>(只看价)</i>');
  else if (mode === 'size') parts.push('<i>(只看量)</i>');
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
      const titleLine = htmlEscape(s.title || `Market ${s.marketId}`);
      const lines = [`<b>📊 ${titleLine}</b>`];
      if (s.note) lines.push(`📝 <i>${htmlEscape(s.note)}</i>`);
      lines.push(
        `<i>${htmlEscape(headline)}</i>`,
        '',
        body,
        '',
        `<code>id=${s.marketId}</code> · /probe_${s.marketId} · /levels_${s.marketId} · /note_${s.marketId} · /stop_${s.marketId}`,
      );
      const text = lines.join('\n');
      try {
        await sendMessage(s.chatId, text);
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
          prev: prev ? { bestBid: prev.bestBid, bestAsk: prev.bestAsk } : null,
          cur: { bestBid: snap.bestBid, bestAsk: snap.bestAsk, bids: snap.bids, asks: snap.asks },
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
