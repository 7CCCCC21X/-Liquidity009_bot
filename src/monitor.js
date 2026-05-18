import { config } from './config.js';
import { getOrderbook, getMarketById } from './predict.js';
import { sendMessage, htmlEscape } from './telegram.js';
import {
  listAllSubscriptions, removeSubscription, saveState,
  setSubscriptionInitial, setSubscriptionDigestBaseline,
  setSubscriptionLastSnap,
  getAllChatSettings, markChatDigestSent, isChatInQuietHours,
  ALL_LEVELS, LEVEL_LABEL, subKey,
} from './state.js';
import { appendEvent } from './history.js';

// Per-sub last-notified snapshot (so each sub diffs against the book
// at the moment it last got an alert, not against an unrelated sub's
// state). Per-sub last notify time enforces NOTIFY_COOLDOWN_SEC.
const lastBookPerSub = new Map();
const lastNotify = new Map();
// Excursion buffer: during cooldown, if the book briefly moves away
// from prev and then snaps back, the standard A→B→A pattern leaves
// `bookChanged(prev=A, cur=A)` = false once cooldown lifts, so the B
// excursion is silently lost. We stash the most-recent over-threshold
// deviation here while cooldown is active; on the first poll after
// cooldown, the buffer is preferred over the (possibly reverted)
// current snap so the user still hears about the move.
const pendingExcursion = new Map();

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

// Predict.fun event markets carry both `title` (the option label like
// "Jannik Sinner") and `question` (the parent event question like
// "Madrid Open 2026 winner"). The alert needs both so the option name
// has context. Returns null when there's nothing extra to show.
function questionSubtitle(sub) {
  const q = (sub?.question || '').trim();
  if (!q) return null;
  const t = (sub?.title || '').trim();
  if (!t) return null;
  if (q === t) return null;
  // Trim verbose question text to keep the alert tight.
  const trimmed = q.length > 120 ? `${q.slice(0, 117)}…` : q;
  return htmlEscape(trimmed);
}

// Seed the per-sub baseline with a snapshot taken at subscribe time.
// Without this, the user gets a "🆕 初次抓取" alert on the next poll
// tick — duplicating the orderbook the subscribe-success message
// already showed. Calling primeSubscriptionSnapshot suppresses that.
//
// Also persists s.initial so notifications can render the "vs 监控
// 起点" cumulative diff across restarts. Caller should saveState()
// after to flush the new initial to disk.
export function primeSubscriptionSnapshot(chatId, marketId, snap) {
  if (!snap) return;
  const k = subKey(chatId, marketId);
  lastBookPerSub.set(k, snap);
  // Mark as just-notified so the cooldown still applies even though
  // we didn't send an in-band alert. Stops a cooldown=1s subscription
  // from being woken up by the very next poll.
  lastNotify.set(k, Date.now());
  // Resubscribe path: drop any stale excursion buffered for this key.
  pendingExcursion.delete(k);
  // Persist so a redeploy right after subscribe doesn't re-alert.
  // sendSubscribed awaits a saveState() after this call.
  setSubscriptionLastSnap(chatId, marketId, {
    bestBid: snap.bestBid,
    bestAsk: snap.bestAsk,
    bids: snap.bids,
    asks: snap.asks,
    atMs: snap.updatedAtMs ?? Date.now(),
  });
  setSubscriptionInitial(chatId, marketId, {
    bestBid: snap.bestBid,
    bestAsk: snap.bestAsk,
    bids: snap.bids,
    asks: snap.asks,
    atMs: Date.now(),
  });
}

// Standard action row attached to every notification + every /list
// card. The callback handlers for these live in src/index.js.
//
// Two rows so the most-common "noise mitigation" actions sit next
// to the per-sub editors without forcing a "更多" submenu. Quick-
// mute is the highest-impact UX add — users getting spammed by a
// hot market can mute it in one tap, no command typing.
export function subActionKeyboard(marketId) {
  return {
    inline_keyboard: [
      [
        { text: '🔍 抓取', callback_data: `probe:${marketId}` },
        { text: '📐 档位', callback_data: `lvl:${marketId}:open` },
        { text: '📝 备注', callback_data: `note:${marketId}` },
      ],
      [
        { text: '⏸ 30m', callback_data: `pause:${marketId}:30m` },
        { text: '⏸ 2h',  callback_data: `pause:${marketId}:2h` },
        { text: '🛑 停止', callback_data: `unsub:${marketId}` },
      ],
    ],
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
// change meets thresholds. Mode-aware: 'price' suppresses size deltas,
// 'size' suppresses price deltas, 'both' shows everything. This way
// 只看价 mode no longer leaks 量↓ noise into the alert.
function fmtRowDelta(prev, cur, mode = 'both') {
  if (!prev && !cur) return '';
  if (!prev && cur) return '新挂';
  if (prev && !cur) return '撤单';
  const dp = cur.price - prev.price;
  const ds = cur.size - prev.size;
  const parts = [];
  if (mode !== 'size' && Math.abs(dp) >= 1e-9) {
    parts.push(`${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`);
  }
  if (mode !== 'price' && Math.abs(ds) >= 1) {
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
// Resolve effective threshold values for a sub: per-sub override
// overrides each field individually, env defaults fill the rest.
// Exported so /threshold UI can preview the effective values.
export function effectiveThresholds(sub) {
  const t = sub?.thresholds ?? {};
  return {
    priceEpsilon: t.priceEpsilon ?? config.priceEpsilon,
    sizeRelativeEpsilon: t.sizeRelativeEpsilon ?? config.sizeRelativeEpsilon,
    sizeAbsoluteMin: t.sizeAbsoluteMin ?? config.sizeAbsoluteMin,
    notifyCooldownMs: t.notifyCooldownMs ?? config.notifyCooldownMs,
  };
}

function levelDiff(prev, cur, mode = 'both', th = null) {
  if (!prev && !cur) return false;
  if (!prev || !cur) return true;
  const priceEpsilon = th?.priceEpsilon ?? config.priceEpsilon;
  const sizeAbsoluteMin = th?.sizeAbsoluteMin ?? config.sizeAbsoluteMin;
  const sizeRelativeEpsilon = th?.sizeRelativeEpsilon ?? config.sizeRelativeEpsilon;
  const checkPrice = mode !== 'size';
  const checkSize = mode !== 'price';
  if (checkPrice && Math.abs(prev.price - cur.price) >= priceEpsilon) return true;
  if (checkSize) {
    const sizeDelta = Math.abs(prev.size - cur.size);
    if (sizeDelta >= sizeAbsoluteMin) return true;
    const base = Math.max(prev.size, cur.size, 1);
    if (sizeDelta / base >= sizeRelativeEpsilon) return true;
  }
  return false;
}

function bookChanged(prev, cur, levels, mode = 'both', th = null) {
  if (!prev) return true;
  for (const k of levels) {
    if (levelDiff(getLevel(prev, k), getLevel(cur, k), mode, th)) return true;
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

// Format a timestamp in the configured display timezone (default
// Asia/Shanghai → UTC+8). Falls back to UTC ISO if Intl is unavailable.
export function fmtClockTime(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: config.displayTz,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

// Same but includes month-day for the "vs 监控起点" header where the
// reference snapshot may be hours / days old. "06-30 11:19".
export function fmtClockDateTime(ms) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.displayTz,
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(ms));
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
  }
}

// 价差 + 中价 + 抓取时间。Times shown in UTC (avoids per-user TZ
// config); marker dropped from the line to keep it visually quiet.
export function fmtSpreadLine(snap) {
  const bb = snap.bestBid?.price;
  const ba = snap.bestAsk?.price;
  const time = fmtClockTime(snap.updatedAtMs ?? Date.now());
  const tzLabel = config.displayTzLabel ? ` ${config.displayTzLabel}` : '';
  if (bb == null || ba == null) return `<i>抓取于 ${time}${tzLabel} · 缺一侧深度</i>`;
  const spread = ba - bb;
  const mid = (ba + bb) / 2;
  return `<i>价差 ${spread.toFixed(4)} · 中价 ${mid.toFixed(4)} · 抓取于 ${time}${tzLabel}</i>`;
}

// Compact change-list: one line per watched level whose change cleared
// the threshold. Nothing emitted if no level fired (caller skips
// section entirely). Plain text — caller wraps in <i>.
export function fmtChangeLines(prev, snap, levels, mode = 'both', th = null) {
  if (!prev) return [];
  const out = [];
  for (const k of levels) {
    const p = getLevel(prev, k);
    const c = getLevel(snap, k);
    if (!levelDiff(p, c, mode, th)) continue;
    const label = LEVEL_LABEL[k] ?? k;
    const delta = fmtRowDelta(p, c, mode);
    if (delta) out.push(`  ${label}: ${delta}`);
  }
  return out;
}

// Cumulative change vs the snapshot taken when the user subscribed.
// Always shows "prev → cur" so the absolute origin is visible, plus
// the directional delta (gated by mode the same way as fmtRowDelta).
// Returns one line per watched level that has both an initial and a
// current value (no "新挂"/"撤单" — those are the live delta's job).
export function fmtSinceInitialLines(initial, snap, levels, mode = 'both') {
  if (!initial) return [];
  const out = [];
  for (const k of levels) {
    const i = getLevel(initial, k);
    const c = getLevel(snap, k);
    if (!i || !c) continue;
    const dp = c.price - i.price;
    const ds = c.size - i.size;
    const sub = [];
    if (mode !== 'size' && Math.abs(dp) >= 1e-9) {
      sub.push(`${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`);
    }
    if (mode !== 'price' && Math.abs(ds) >= 1) {
      const fmt = Math.abs(ds).toLocaleString('en-US', { maximumFractionDigits: 0 });
      sub.push(`量${ds > 0 ? '↑' : '↓'}${fmt}`);
    }
    if (!sub.length) continue;
    out.push(`  ${LEVEL_LABEL[k] ?? k}: ${i.price.toFixed(4)}→${c.price.toFixed(4)}  ${sub.join(' ')}`);
  }
  return out;
}

// Single-line headline summarising what kind of change triggered the
// alert. Kept short — the per-level deltas in fmtBook carry the details.
// Build a high-contrast alert headline: a colored emoji + bold
// one-line change summary. The FIRST line of the message — drives both
// the in-chat visual distinction and the iOS/Android notification
// preview banner. Distinct from ✅ subscribe-success and 🔍 probe so
// the user can tell at a glance what kind of message just arrived.
//
// Emoji legend:
//   🟢  price up (single level or all moves up)
//   🔴  price down (single level or all moves down)
//   🟡  size-only change, or 新挂/撤单 (no price direction)
//   🔔  multi-level mixed up+down
export function fmtAlertHeadline(prev, snap, levels, mode = 'both', th = null) {
  if (!prev) return { emoji: '🆕', text: '初次抓取' };
  const changes = [];
  for (const k of levels) {
    const p = getLevel(prev, k);
    const c = getLevel(snap, k);
    if (!levelDiff(p, c, mode, th)) continue;
    changes.push({ k, p, c });
  }
  if (changes.length === 0) return { emoji: '🔔', text: '深度变动' };

  // Single change → headline carries the entire delta verbatim.
  if (changes.length === 1) {
    const { k, p, c } = changes[0];
    const label = LEVEL_LABEL[k] ?? k;
    if (!p && c) {
      return { emoji: '🟡', text: `${label} 新挂 ${c.price.toFixed(4)} × ${c.size.toLocaleString('en-US')}` };
    }
    if (p && !c) {
      return { emoji: '🟡', text: `${label} 撤单 ${p.price.toFixed(4)}` };
    }
    const dp = c.price - p.price;
    const ds = c.size - p.size;
    if (mode !== 'size' && Math.abs(dp) >= 1e-9) {
      const arrow = dp > 0 ? '↑' : '↓';
      const emoji = dp > 0 ? '🟢' : '🔴';
      return { emoji, text: `${label} ${arrow}${Math.abs(dp).toFixed(4)}` };
    }
    if (mode !== 'price' && Math.abs(ds) >= 1) {
      const arrow = ds > 0 ? '↑' : '↓';
      const fmt = Math.abs(ds).toLocaleString('en-US', { maximumFractionDigits: 0 });
      return { emoji: '🟡', text: `${label} 量${arrow}${fmt}` };
    }
    return { emoji: '🔔', text: `${label} 变动` };
  }

  // Multi-level — pick dominant direction across watched levels.
  let priceUp = 0, priceDown = 0;
  let biggestSignedDp = 0;
  for (const { p, c } of changes) {
    if (!p || !c) continue;
    const dp = c.price - p.price;
    if (Math.abs(dp) < 1e-9) continue;
    if (dp > 0) priceUp++; else priceDown++;
    if (Math.abs(dp) > Math.abs(biggestSignedDp)) biggestSignedDp = dp;
  }
  let emoji = '🔔';
  if (priceUp > 0 && priceDown === 0) emoji = '🟢';
  else if (priceDown > 0 && priceUp === 0) emoji = '🔴';
  else if (priceUp === 0 && priceDown === 0) emoji = '🟡';

  const parts = [`${changes.length} 档变动`];
  if (Math.abs(biggestSignedDp) >= 1e-9) {
    const arrow = biggestSignedDp > 0 ? '↑' : '↓';
    parts.push(`最大 ${arrow}${Math.abs(biggestSignedDp).toFixed(4)}`);
  }
  return { emoji, text: parts.join(' · ') };
}

// Single-line headline (legacy) used for the persisted history record.
// Same data as fmtAlertHeadline but in plain text form so old
// /history viewers still see something useful.
function fmtHeadline(prev, cur, levels, mode = 'both', th = null) {
  if (!prev) return '🆕 初次抓取';
  let nChanges = 0;
  let biggestPrice = 0;
  let biggestSize = 0;
  for (const k of levels) {
    const p = getLevel(prev, k);
    const c = getLevel(cur, k);
    if (!levelDiff(p, c, mode, th)) continue;
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
//
// Cached-conditionId fast path: every subscription persists the
// conditionId from when it was first added. The orderbook endpoint
// only needs id+conditionId, so for steady-state polls we skip the
// GraphQL getMarketById round-trip entirely and only fall back to
// it when the sub was added before we started persisting conditionId
// (or the sub object is incomplete for any reason).
async function fetchMarketSnap(marketId, group) {
  try {
    const s0 = group[0];
    let market = s0?.conditionId
      ? { id: marketId, conditionId: s0.conditionId, title: s0.title, slug: s0.slug }
      : null;
    if (!market) {
      const m = await getMarketById(marketId);
      if (!m) return { marketId, group, error: 'no market record and no cached conditionId' };
      market = m;
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
  let needsSave = false;
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
      // Hydrate the in-memory baseline from the persisted last-alert
      // snapshot on the first poll after a restart. Without this every
      // sub fires "🆕 初次抓取" right after a redeploy because the
      // in-memory Map starts empty. We also cache the hydrated value
      // back into lastBookPerSub so subsequent polls in the same
      // process don't keep going to the (slower, allocating) object
      // path.
      let prev = lastBookPerSub.get(k);
      if (!prev && s.lastSnap) {
        prev = s.lastSnap;
        lastBookPerSub.set(k, prev);
      }
      // Backfill the "vs 监控起点" baseline for subs created before
      // this feature shipped. Set once per sub on the first poll
      // after upgrade; saveState lazily after the loop.
      if (!s.initial) {
        setSubscriptionInitial(s.chatId, s.marketId, {
          bestBid: snap.bestBid,
          bestAsk: snap.bestAsk,
          bids: snap.bids,
          asks: snap.asks,
          atMs: Date.now(),
        });
        needsSave = true;
      }
      // Still no baseline — legacy sub from before lastSnap shipped,
      // or a prime that failed at subscribe time. Silently establish
      // it now instead of firing "🆕 初次抓取" for every existing
      // sub on the first deploy of this feature.
      if (!prev) {
        lastBookPerSub.set(k, snap);
        lastNotify.set(k, now);
        setSubscriptionLastSnap(s.chatId, s.marketId, {
          bestBid: snap.bestBid,
          bestAsk: snap.bestAsk,
          bids: snap.bids,
          asks: snap.asks,
          atMs: snap.updatedAtMs ?? now,
        });
        needsSave = true;
        continue;
      }
      // Skip paused subs; reset baseline so resume doesn't dump a
      // stale diff. Auto-clear when the timer is up — handled by
      // index.js periodically since we can't write state from here.
      if (s.pausedUntil && now < s.pausedUntil) {
        lastBookPerSub.set(k, snap);
        pendingExcursion.delete(k);
        continue;
      }
      // Empty levels = monitoring nothing (user toggled all off). Snapshot
      // the book so re-enabling levels later doesn't dump a stale diff.
      if (!s.levels?.length) {
        lastBookPerSub.set(k, snap);
        pendingExcursion.delete(k);
        continue;
      }
      const th = effectiveThresholds(s);
      const curChanged = bookChanged(prev, snap, levels, mode, th);
      const lastSentAt = lastNotify.get(k) ?? 0;
      const inCooldown = prev && now - lastSentAt < th.notifyCooldownMs;

      // Inside the cooldown window: stash the latest over-threshold
      // deviation from prev so an A→B→A bounce can still be reported
      // after the window lifts. Overwriting (instead of "keep peak")
      // is intentional — the most recent excursion is the one most
      // likely to still be relevant when the user sees it.
      if (inCooldown) {
        if (curChanged) pendingExcursion.set(k, snap);
        continue;
      }

      // Cooldown clear. Choose the snap to alert against:
      //   1. current snap if it differs from prev (normal case)
      //   2. buffered excursion if the book reverted during cooldown
      //      and we'd otherwise drop the entire A→B→A move
      let alertSnap = snap;
      let isRebound = false;
      if (!curChanged) {
        const buffered = pendingExcursion.get(k);
        if (buffered && bookChanged(prev, buffered, levels, mode, th)) {
          alertSnap = buffered;
          isRebound = true;
        } else {
          pendingExcursion.delete(k);
          continue;
        }
      }
      const alertHead = fmtAlertHeadline(prev, alertSnap, levels, mode, th);
      const headlineText = `${alertHead.emoji} ${alertHead.text}`;
      const body = fmtBook(prev, alertSnap, levels);
      const spreadLine = fmtSpreadLine(alertSnap);
      const changeLines = fmtChangeLines(prev, alertSnap, levels, mode, th);
      const sinceInitialLines = fmtSinceInitialLines(s.initial, alertSnap, levels, mode);
      const titleLink = marketLink(s.title || `Market ${s.marketId}`, s.slug);
      // Layout: high-contrast emoji+bold change FIRST so the chat
      // visually pops vs subscribe-success (✅) and probe (🔍), and
      // the iOS/Android notification banner shows the actionable bit.
      // Title link below for context.
      const lines = [`${alertHead.emoji} <b>${htmlEscape(alertHead.text)}</b>`];
      // Rebound marker: the excursion happened during cooldown and
      // has since reverted; the snapshot below shows the moment of
      // peak deviation, not the current book state.
      if (isRebound) lines.push('<i>🔄 已回弹（冷却期内的瞬时偏离，当前已恢复）</i>');
      lines.push(`📊 ${titleLink}`);
      {
        const qSub = questionSubtitle(s);
        if (qSub) lines.push(`<i>${qSub}</i>`);
      }
      {
        // Note + tags as a single "📝 #tag1 #tag2 note text" line
        const tags = Array.isArray(s.tags) ? s.tags : [];
        if (tags.length || s.note) {
          const tagStr = tags.length ? tags.map((t) => `#${htmlEscape(t)}`).join(' ') : '';
          const noteText = s.note ? htmlEscape(s.note) : '';
          const inner = tagStr && noteText ? `${tagStr} ${noteText}` : (tagStr || noteText);
          lines.push(`📝 <i>${inner}</i>`);
        }
      }
      // Skip the "本次变动" detail block when the headline already
      // says it (single-level change). Keep it for multi-level so
      // each row's delta is visible.
      if (changeLines.length >= 2) {
        lines.push('');
        lines.push('<b>本次变动</b>');
        for (const l of changeLines) lines.push(`<code>${l}</code>`);
      }
      if (sinceInitialLines.length && s.initial?.atMs) {
        lines.push('');
        const initialTime = fmtClockDateTime(s.initial.atMs);
        const tzLabel = config.displayTzLabel ? ` ${config.displayTzLabel}` : '';
        lines.push(`<b>vs 监控起点</b>  <i>${initialTime}${tzLabel}</i>`);
        for (const l of sinceInitialLines) lines.push(`<code>${l}</code>`);
      }
      lines.push('', spreadLine, '', body);
      lines.push('', `<code>id=${s.marketId}</code>`);
      const text = lines.join('\n');
      const replyMarkup = subActionKeyboard(s.marketId);
      // Quiet hours: skip the Telegram send but still update baselines
      // + write history so /digest /history /stats stay accurate.
      const muted = isChatInQuietHours(s.chatId, now);
      try {
        if (!muted) {
          await sendMessage(s.chatId, text, { replyMarkup });
        }
        lastNotify.set(k, now);
        lastBookPerSub.set(k, snap);
        // Persist a trimmed copy of the same snapshot so a redeploy
        // can hydrate this sub's baseline without dumping a 🆕 flood.
        // Saved with bestBid/bestAsk + top-3 levels — same shape the
        // bookChanged check reads.
        setSubscriptionLastSnap(s.chatId, s.marketId, {
          bestBid: snap.bestBid,
          bestAsk: snap.bestAsk,
          bids: snap.bids,
          asks: snap.asks,
          atMs: snap.updatedAtMs ?? now,
        });
        needsSave = true;
        // Excursion has been delivered (or muted but counted). Safe to
        // clear; a fresh window starts now.
        pendingExcursion.delete(k);
        // Persist a structured record of the change. Keep the payload
        // small — top of book + summary is enough to reconstruct what
        // moved when reading later. prev=null on first poll.
        await appendEvent({
          chatId: s.chatId,
          marketId: s.marketId,
          title: s.title || null,
          note: s.note || null,
          levels,
          summary: headlineText,
          // Save full top-3 in both prev and cur so /history can show
          // changes on bid2/3 + ask2/3 too. Old records still parse —
          // /history's renderer falls back to bestBid/bestAsk only.
          prev: prev ? {
            bestBid: prev.bestBid, bestAsk: prev.bestAsk,
            bids: prev.bids, asks: prev.asks,
          } : null,
          cur: { bestBid: alertSnap.bestBid, bestAsk: alertSnap.bestAsk, bids: alertSnap.bids, asks: alertSnap.asks },
          slug: s.slug || null,
          updatedAtMs: alertSnap.updatedAtMs,
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
  // Digests: per-chat periodic summary. Runs after the change-alert
  // loop so it uses the freshest lastBookPerSub snapshots.
  try {
    if (await maybeSendDigests()) needsSave = true;
  } catch (err) {
    console.warn('[monitor] maybeSendDigests failed:', err.message);
  }
  // Flush any state mutations done above (initial-baseline backfill,
  // pause clears, digest timestamps, etc) in a single save so we
  // don't write per-tick.
  if (needsSave) {
    try { await saveState(); } catch (err) {
      console.warn('[monitor] saveState failed:', err.message);
    }
  }
}

// Periodic digest: one message per chat focused on what CHANGED since
// the last digest. Sorts changed markets by biggest |Δ| first, shows
// per-side direction + delta, and collapses unchanged subs into a
// single tail line so the user can scan in seconds.
//
// Baseline is sub.digestBaseline (set after every send). First-time
// digest shows everything as 🆕 with current prices and seeds the
// baseline for the next round.
export async function sendDigestForChat(chatId) {
  const all = listAllSubscriptions();
  const subs = all.filter((s) => String(s.chatId) === String(chatId));
  if (!subs.length) {
    await sendMessage(chatId, '<i>📋 摘要：当前没有订阅。</i>');
    return;
  }
  const now = Date.now();
  const entries = subs.map((s) => {
    const snap = lastBookPerSub.get(subKey(s.chatId, s.marketId));
    const baseline = s.digestBaseline ?? null;
    const isPaused = s.pausedUntil && s.pausedUntil > now;
    return { sub: s, snap, baseline, isPaused };
  });

  // Bucket. Paused / no-data fall through to "unchanged" so the
  // header counts make sense — user explicitly muted them, no point
  // surfacing in the "changes" list.
  const changed = [];
  const fresh = []; // baseline absent → first digest, show as 🆕
  const unchanged = [];
  for (const e of entries) {
    if (e.isPaused || !e.snap?.bestBid || !e.snap?.bestAsk) { unchanged.push(e); continue; }
    if (!e.baseline?.bestBid || !e.baseline?.bestAsk) { fresh.push(e); continue; }
    const dBid = e.snap.bestBid.price - e.baseline.bestBid.price;
    const dAsk = e.snap.bestAsk.price - e.baseline.bestAsk.price;
    if (Math.abs(dBid) < 1e-9 && Math.abs(dAsk) < 1e-9) { unchanged.push(e); continue; }
    e._biggest = Math.max(Math.abs(dBid), Math.abs(dAsk));
    e._dBid = dBid; e._dAsk = dAsk;
    changed.push(e);
  }
  // Sort by biggest absolute price move first.
  changed.sort((a, b) => (b._biggest ?? 0) - (a._biggest ?? 0));

  const tzLabel = config.displayTzLabel ? ` ${config.displayTzLabel}` : '';
  const lines = [`<b>📋 订阅摘要</b>  <i>${fmtClockTime(now)}${tzLabel} · vs 上次摘要</i>`];
  const totals = [];
  if (changed.length) totals.push(`<b>${changed.length}</b> 有变化`);
  if (fresh.length) totals.push(`<b>${fresh.length}</b> 首次`);
  if (unchanged.length) totals.push(`<b>${unchanged.length}</b> 无变化`);
  lines.push(`<i>${totals.join(' · ')}</i>`);
  lines.push('');

  const fmtDelta = (dp) => Math.abs(dp) < 1e-9 ? '' : ` (${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)})`;
  const dot = (dBid, dAsk) => {
    // Pick dominant direction by |delta|, color by sign.
    const dom = Math.abs(dBid) >= Math.abs(dAsk) ? dBid : dAsk;
    if (dom > 1e-9) return '🟢';
    if (dom < -1e-9) return '🔴';
    return '🔔';
  };

  // Show changed first — up to 20.
  for (const e of changed.slice(0, 20)) {
    const { sub, snap } = e;
    const titleLink = marketLink(sub.title || `Market ${sub.marketId}`, sub.slug);
    const bb = snap.bestBid.price.toFixed(4);
    const ba = snap.bestAsk.price.toFixed(4);
    lines.push(`${dot(e._dBid, e._dAsk)} ${titleLink}`);
    lines.push(`  <code>${sub.marketId}</code> · 买1 ${bb}${fmtDelta(e._dBid)} / 卖1 ${ba}${fmtDelta(e._dAsk)}`);
  }
  if (changed.length > 20) {
    lines.push('', `<i>… 还有 ${changed.length - 20} 个有变化（按变化大小排序，可 /list 查看全部）</i>`);
  }

  // 🆕 first-time entries (e.g. brand-new subs since last digest).
  if (fresh.length) {
    if (changed.length) lines.push('');
    for (const e of fresh.slice(0, 10)) {
      const titleLink = marketLink(e.sub.title || `Market ${e.sub.marketId}`, e.sub.slug);
      const bb = e.snap.bestBid.price.toFixed(4);
      const ba = e.snap.bestAsk.price.toFixed(4);
      lines.push(`🆕 ${titleLink}`);
      lines.push(`  <code>${e.sub.marketId}</code> · 买1 ${bb} / 卖1 ${ba}`);
    }
    if (fresh.length > 10) lines.push(`<i>… 另 ${fresh.length - 10} 个首次</i>`);
  }

  // Unchanged collapsed to one short line so the user knows they're
  // still being tracked, not silently dropped.
  if (unchanged.length) {
    const pausedCount = unchanged.filter((e) => e.isPaused).length;
    const names = unchanged
      .slice(0, 8)
      .map((e) => htmlEscape((e.sub.title || `#${e.sub.marketId}`).slice(0, 14)))
      .join(' · ');
    const extra = unchanged.length > 8 ? ` 等 ${unchanged.length} 个` : '';
    const pausedBit = pausedCount ? ` (含 ${pausedCount} 暂停)` : '';
    lines.push('', `<i>· 无变化${pausedBit}：${names}${extra}</i>`);
  }

  lines.push('', `<i>改频率 /digest · 历史 /history &lt;id&gt; · 统计 /stats &lt;id&gt;</i>`);

  const text = lines.join('\n');
  await sendMessage(chatId, text);

  // Persist the rendered digest so /digestlog can replay past summaries
  // (e.g. user wakes up and wants to see what was sent overnight).
  // Stored alongside per-event records in history.jsonl with type='digest';
  // /history filters by missing type, so this doesn't pollute that view.
  // `entries` is the structured per-market snapshot at digest time —
  // used by /digestlog's aggregate summary to compute net deltas
  // across the chosen window without parsing the rendered HTML.
  await appendEvent({
    type: 'digest',
    chatId,
    text,
    totals: { changed: changed.length, fresh: fresh.length, unchanged: unchanged.length },
    entries: entries
      .filter((e) => e.snap?.bestBid && e.snap?.bestAsk)
      .map((e) => ({
        marketId: e.sub.marketId,
        title: e.sub.title || null,
        slug: e.sub.slug || null,
        // Snap at digest time (the "now" value shown in the rendered text).
        bestBid: e.snap.bestBid.price,
        bestAsk: e.snap.bestAsk.price,
        // Previous-digest baseline (the "vs 上次摘要" anchor). Persisted
        // so /digestlog's aggregate has two data points per digest, not
        // just one — single-digest windows can still report Δ ≠ 0.
        prevBestBid: e.baseline?.bestBid?.price ?? null,
        prevBestAsk: e.baseline?.bestAsk?.price ?? null,
      })),
  });

  // Update baseline for every sub that has a snapshot now — including
  // unchanged (so the baseline stays "the last time we summarised").
  for (const e of entries) {
    if (!e.snap?.bestBid || !e.snap?.bestAsk) continue;
    setSubscriptionDigestBaseline(e.sub.chatId, e.sub.marketId, {
      bestBid: e.snap.bestBid,
      bestAsk: e.snap.bestAsk,
      atMs: now,
    });
  }
}

// Called from pollOnce. Walks every chat with a non-zero digest
// interval and fires the digest if it's due. Marks digestLastSentAt
// to bump the next-due moment forward.
async function maybeSendDigests() {
  const all = getAllChatSettings();
  const now = Date.now();
  let touched = false;
  for (const [chatId, settings] of Object.entries(all)) {
    const interval = settings?.digestIntervalMs ?? 0;
    if (interval <= 0) continue;
    const last = settings.digestLastSentAt ?? 0;
    if (now - last < interval) continue;
    try {
      await sendDigestForChat(chatId);
      markChatDigestSent(chatId, now);
      touched = true;
    } catch (err) {
      console.warn('[digest] failed for', chatId, err.message);
    }
  }
  return touched;
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
