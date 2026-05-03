import { config } from './config.js';
import { getOrderbook, getMarketById } from './predict.js';
import { sendMessage, htmlEscape } from './telegram.js';
import { listAllSubscriptions, removeSubscription, saveState } from './state.js';

// In-memory: marketId -> last orderbook snapshot (top-3 each side).
// Per (chatId,marketId): lastNotifyMs to enforce cooldown.
const lastBook = new Map();
const lastNotify = new Map();

function fmtSide(side) {
  if (!side) return '<i>无</i>';
  const price = side.price.toFixed(4);
  const size = side.size.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${price} × ${size}`;
}

function levelDiff(prev, cur) {
  if (!prev && !cur) return false;
  if (!prev || !cur) return true;
  if (Math.abs(prev.price - cur.price) >= config.priceEpsilon) return true;
  const sizeDelta = Math.abs(prev.size - cur.size);
  if (sizeDelta >= config.sizeAbsoluteMin) return true;
  const base = Math.max(prev.size, cur.size, 1);
  if (sizeDelta / base >= config.sizeRelativeEpsilon) return true;
  return false;
}

function bookChanged(prev, cur) {
  if (!prev) return true;
  if (levelDiff(prev.bestBid, cur.bestBid)) return true;
  if (levelDiff(prev.bestAsk, cur.bestAsk)) return true;
  // Check level-2 / level-3 in case top is the same but depth shifted noticeably.
  for (let i = 1; i < 3; i++) {
    if (levelDiff(prev.bids?.[i], cur.bids?.[i])) return true;
    if (levelDiff(prev.asks?.[i], cur.asks?.[i])) return true;
  }
  return false;
}

function fmtBook(snap) {
  const lines = [];
  lines.push('<b>买单（Bids）</b>');
  for (let i = 0; i < 3; i++) {
    const r = snap.bids?.[i];
    lines.push(`  L${i + 1}: ${fmtSide(r)}`);
  }
  lines.push('<b>卖单（Asks）</b>');
  for (let i = 0; i < 3; i++) {
    const r = snap.asks?.[i];
    lines.push(`  L${i + 1}: ${fmtSide(r)}`);
  }
  return lines.join('\n');
}

function fmtChange(prev, cur) {
  if (!prev) return '初次抓取';
  const out = [];
  const arrow = (a, b) => {
    if (a == null && b == null) return '';
    if (a == null) return '↑ 新增';
    if (b == null) return '↓ 撤销';
    if (a.price === b.price && a.size === b.size) return '';
    const dp = (b.price - a.price).toFixed(4);
    const ds = b.size - a.size;
    const dpStr = (b.price === a.price) ? '' : `价 ${dp >= 0 ? '+' : ''}${dp}`;
    const dsStr = (ds === 0) ? '' : `量 ${ds > 0 ? '+' : ''}${ds.toFixed(0)}`;
    return [dpStr, dsStr].filter(Boolean).join(' / ');
  };
  const bid = arrow(prev.bestBid, cur.bestBid);
  if (bid) out.push(`最佳买 ${bid}`);
  const ask = arrow(prev.bestAsk, cur.bestAsk);
  if (ask) out.push(`最佳卖 ${ask}`);
  return out.join('；') || '深度变动';
}

async function pollOnce() {
  const subs = listAllSubscriptions();
  if (!subs.length) return;
  const byMarket = new Map(); // marketId -> { sub-list, lookup }
  for (const s of subs) {
    if (!byMarket.has(s.marketId)) byMarket.set(s.marketId, []);
    byMarket.get(s.marketId).push(s);
  }
  for (const [marketId, group] of byMarket.entries()) {
    let snap;
    try {
      let market = await getMarketById(marketId);
      if (!market) {
        // Reconstruct minimal market from sub data (conditionId is enough).
        const s0 = group[0];
        if (!s0.conditionId) {
          console.warn('[monitor] no market record for', marketId);
          continue;
        }
        market = { id: marketId, conditionId: s0.conditionId };
      }
      snap = await getOrderbook(market);
    } catch (err) {
      console.warn(new Date().toISOString(), `[monitor] ${marketId} fetch failed:`, err.message);
      continue;
    }
    const prev = lastBook.get(marketId);
    const changed = bookChanged(prev, snap);
    lastBook.set(marketId, snap);
    if (!changed) continue;
    const summary = fmtChange(prev, snap);
    const body = fmtBook(snap);
    const now = Date.now();
    for (const s of group) {
      const cooldownKey = `${s.chatId}:${s.marketId}`;
      const last = lastNotify.get(cooldownKey) ?? 0;
      if (prev && now - last < config.notifyCooldownMs) continue;
      const titleLine = htmlEscape(s.title || `Market ${s.marketId}`);
      const text = [
        `<b>📊 ${titleLine}</b>`,
        `<i>${htmlEscape(summary)}</i>`,
        '',
        body,
        '',
        `<code>id=${s.marketId}</code> · /stop_${s.marketId} 停止`,
      ].join('\n');
      try {
        await sendMessage(s.chatId, text);
        lastNotify.set(cooldownKey, now);
      } catch (err) {
        console.warn('[monitor] send failed', s.chatId, err.message);
        // 403 = user blocked the bot / kicked from group → drop the sub.
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
    const wait = Math.max(1000, config.pollIntervalMs - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
  _running = false;
}
