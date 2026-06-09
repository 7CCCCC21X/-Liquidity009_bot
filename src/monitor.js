import { config } from './config.js';
import { getOrderbook, getMarketById, getMarketStatusById } from './predict.js';
import { sendMessage, htmlEscape } from './telegram.js';
import {
  listAllSubscriptions, removeSubscription, saveState,
  setSubscriptionInitial, setSubscriptionDigestBaseline,
  setSubscriptionLastSnap, setSubscriptionQuestion,
  removeSubscriptionPriceAlert,
  getAllChatSettings, markChatDigestSent, isChatInQuietHours,
  isChatDigestOnly,
  ALL_LEVELS, LEVEL_LABEL, ALERT_METRIC_LABEL, subKey,
} from './state.js';
import { appendEvent } from './history.js';

// Per-sub last-notified snapshot (so each sub diffs against the book
// at the moment it last got an alert, not against an unrelated sub's
// state). Per-sub last notify time enforces NOTIFY_COOLDOWN_SEC.
const lastBookPerSub = new Map();
const lastNotify = new Map();
// Per-sub freshest snapshot from any successful poll, regardless of
// whether an alert fired. `lastBookPerSub` only moves on alerts so
// digests would otherwise see stale data for slow-drifting markets;
// this map gives the digest renderer + aggregate the actual current
// orderbook at digest time.
const latestSnapPerSub = new Map();
// Subs we've already attempted a question-backfill for this process,
// so a market that genuinely has no `question` isn't re-queried every
// poll. Reset on restart (one retry per process is fine).
const questionBackfillTried = new Set();
// Excursion buffer: during cooldown, if the book briefly moves away
// from prev and then snaps back, the standard A→B→A pattern leaves
// `bookChanged(prev=A, cur=A)` = false once cooldown lifts, so the B
// excursion is silently lost. We stash the most-recent over-threshold
// deviation here while cooldown is active; on the first poll after
// cooldown, the buffer is preferred over the (possibly reverted)
// current snap so the user still hears about the move.
const pendingExcursion = new Map();
// Per-market timestamp of the last resolution-status check, so the
// sweep runs at most once per RESOLVED_CHECK_INTERVAL_MS per market.
const lastStatusCheckPerMarket = new Map();

// Drop every in-memory trace of a subscription. MUST be called when a
// sub is removed (unsubscribe, stopall, blocked chat, resolved market)
// — otherwise these Maps grow forever on a long-running process, and a
// later re-subscribe would diff against a stale baseline.
export function clearSubRuntime(chatId, marketId) {
  const k = subKey(chatId, marketId);
  lastBookPerSub.delete(k);
  lastNotify.delete(k);
  latestSnapPerSub.delete(k);
  pendingExcursion.delete(k);
  questionBackfillTried.delete(k);
}

// Telegram errors that mean this chat is permanently unreachable —
// retrying every tick is pointless, so the caller drops the sub.
// 403 = bot blocked; the text variants cover kicked-from-group,
// deleted accounts and migrated/deleted chats.
const PERMANENT_SEND_ERROR = /\b403\b|bot was blocked|user is deactivated|chat not found|bot was kicked|not enough rights/i;
export function isPermanentSendError(err) {
  return PERMANENT_SEND_ERROR.test(String(err?.message ?? ''));
}

// Per-chat send pacing. Telegram allows roughly 1 msg/sec per chat —
// when one tick produces a burst of alerts for the same chat (many
// hot markets at once) we space them out instead of eating 429s.
const lastSendPerChat = new Map();
async function sendThrottled(chatId, text, opts) {
  const key = String(chatId);
  const wait = 1_000 - (Date.now() - (lastSendPerChat.get(key) ?? 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendPerChat.set(key, Date.now());
  return sendMessage(chatId, text, opts);
}

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

// Derive a shared event title from a group of per-option questions.
// On Predict.fun the `question` embeds the option amount, e.g.
//   "Concrete FDV above $200M one day after launch?"
//   "Concrete FDV above $50M one day after launch?"
// so we take the longest common prefix + suffix (trimmed to word
// boundaries) and join with "…": "Concrete FDV above … one day after
// launch?". Falls back to the first question if there's no useful
// shared structure.
export function deriveEventTitle(questions) {
  const qs = questions.filter(Boolean);
  if (!qs.length) return '';
  if (qs.length === 1) return qs[0];
  // Longest common prefix.
  let pre = qs[0];
  for (const q of qs.slice(1)) {
    let i = 0;
    while (i < pre.length && i < q.length && pre[i] === q[i]) i++;
    pre = pre.slice(0, i);
    if (!pre) break;
  }
  // Longest common suffix.
  let suf = qs[0];
  for (const q of qs.slice(1)) {
    let i = 0;
    while (i < suf.length && i < q.length && suf[suf.length - 1 - i] === q[q.length - 1 - i]) i++;
    suf = suf.slice(suf.length - i);
    if (!suf) break;
  }
  // Trim prefix back to the last word boundary, suffix forward to the
  // first, so we don't cut mid-token ("above $" → "above").
  const preTrim = pre.replace(/[\s$#]*\S*$/, '').trimEnd();
  const sufTrim = suf.replace(/^\S*[\s]*/, '').trimStart();
  if (preTrim && sufTrim && (preTrim.length + sufTrim.length) >= 6) {
    return `${preTrim} … ${sufTrim}`;
  }
  if (preTrim.length >= 6) return `${preTrim} …`;
  return qs[0];
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

// ---- Price-cross alerts (one-shot limit alerts) --------------------

// Current value of an alert metric on a snapshot. null = not derivable
// (missing side / level) — the alert simply stays armed.
export function alertMetricValue(snap, metric) {
  if (!snap) return null;
  if (metric === 'mid') {
    const bb = snap.bestBid?.price, ba = snap.bestAsk?.price;
    return bb != null && ba != null ? (bb + ba) / 2 : null;
  }
  if (metric === 'spread') {
    const bb = snap.bestBid?.price, ba = snap.bestAsk?.price;
    return bb != null && ba != null ? ba - bb : null;
  }
  return getLevel(snap, metric)?.price ?? null;
}

function alertSatisfied(value, op, target) {
  switch (op) {
    case '>': return value > target;
    case '>=': return value >= target;
    case '<': return value < target;
    case '<=': return value <= target;
    default: return false;
  }
}

// Evaluate every armed alert on this sub against the fresh snapshot.
// Fired alerts are disarmed BEFORE the send (one-shot semantics even
// if Telegram hiccups — better to lose one ping than spam forever).
// Returns the number fired so the caller knows to saveState().
async function firePriceAlerts(s, snap) {
  let fired = 0;
  for (const a of [...(s.priceAlerts ?? [])]) {
    const value = alertMetricValue(snap, a.metric);
    if (value == null || !alertSatisfied(value, a.op, a.price)) continue;
    removeSubscriptionPriceAlert(s.chatId, s.marketId, a.id);
    fired += 1;
    const label = ALERT_METRIC_LABEL[a.metric] ?? a.metric;
    const condition = `${label} ${a.op} ${a.price}`;
    const titleLink = marketLink(s.title || `Market ${s.marketId}`, s.slug);
    const levels = s.levels?.length ? s.levels : ALL_LEVELS;
    const lines = [
      `🎯 <b>${htmlEscape(condition)} 已触发</b>  当前 <b>${value.toFixed(4)}</b>`,
      `📊 ${titleLink}`,
    ];
    if (s.note) lines.push(`📝 <i>${htmlEscape(s.note)}</i>`);
    lines.push('', fmtSpreadLine(snap), '', fmtBook(null, snap, levels));
    lines.push('', `<code>id=${s.marketId}</code>`, `<i>一次性提醒，已自动解除。再设：/alert_${s.marketId}</i>`);
    try {
      await sendThrottled(s.chatId, lines.join('\n'), { replyMarkup: subActionKeyboard(s.marketId) });
    } catch (err) {
      console.warn('[monitor] price-alert send failed', s.chatId, err.message);
    }
    await appendEvent({
      type: 'price_alert',
      chatId: s.chatId,
      marketId: s.marketId,
      title: s.title || null,
      note: s.note || null,
      summary: `🎯 ${condition} 触发 @ ${value.toFixed(4)}`,
      cur: { bestBid: snap.bestBid, bestAsk: snap.bestAsk, bids: snap.bids, asks: snap.asks },
      slug: s.slug || null,
      updatedAtMs: snap.updatedAtMs,
    });
  }
  return fired;
}

// ---- Market resolution sweep ---------------------------------------

const RESOLVED_STATUS_RE = /resolved|settled|closed|finali[sz]ed|ended|expired|cancell?ed/i;

// Ask GraphQL whether the market has ended. Conservative: only acts on
// an explicit isResolved=true or a status string that clearly says so;
// a null record or a query error is treated as "still alive" so an API
// hiccup never deletes anyone's subscription.
async function checkMarketEnded(marketId) {
  try {
    const m = await getMarketStatusById(marketId);
    if (!m) return null;
    if (m.isResolved === true) return m;
    const status = `${m.status ?? ''} ${m.tradingStatus ?? ''}`.trim();
    if (status && RESOLVED_STATUS_RE.test(status)) return m;
    return null;
  } catch {
    return null;
  }
}

// Notify each subscriber + drop the subs for a market that resolved.
async function retireEndedMarket(marketId, group, endedRecord) {
  const status = endedRecord.isResolved === true
    ? '已结算'
    : `已关闭（${endedRecord.status ?? endedRecord.tradingStatus ?? '—'}）`;
  for (const s of group) {
    const titleLink = marketLink(s.title || `Market ${marketId}`, s.slug);
    const lines = [
      `🏁 <b>市场${htmlEscape(status)}</b>`,
      `📊 ${titleLink}`,
    ];
    if (s.note) lines.push(`📝 <i>${htmlEscape(s.note)}</i>`);
    lines.push('', `<i>已自动取消订阅；历史记录保留（/history_${marketId}）。</i>`);
    try {
      await sendThrottled(s.chatId, lines.join('\n'));
    } catch (err) {
      console.warn('[monitor] retire notice failed', s.chatId, err.message);
    }
    removeSubscription(s.chatId, s.marketId);
    clearSubRuntime(s.chatId, s.marketId);
    await appendEvent({
      type: 'market_ended',
      chatId: s.chatId,
      marketId: s.marketId,
      title: s.title || null,
      summary: `🏁 市场${status} · 订阅已自动取消`,
      slug: s.slug || null,
    });
  }
  lastStatusCheckPerMarket.delete(String(marketId));
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
    // Resolution sweep — runs even when the orderbook fetch failed
    // (a vanished orderbook is often the first symptom of a resolved
    // market). Throttled per market; conservative on API errors.
    if (config.resolvedCheckIntervalMs > 0) {
      const mk = String(result.marketId);
      const lastCheck = lastStatusCheckPerMarket.get(mk) ?? 0;
      if (now - lastCheck >= config.resolvedCheckIntervalMs) {
        lastStatusCheckPerMarket.set(mk, now);
        const ended = await checkMarketEnded(result.marketId);
        if (ended) {
          await retireEndedMarket(result.marketId, result.group, ended);
          needsSave = true;
          continue;
        }
      }
    }
    if (result.error) {
      console.warn(new Date().toISOString(), `[monitor] ${result.marketId} fetch failed:`, result.error);
      continue;
    }
    const { marketId, group, snap } = result;
    for (const s of group) {
      const levels = s.levels?.length ? s.levels : ALL_LEVELS;
      const mode = s.triggerMode || 'both';
      const k = subKey(s.chatId, s.marketId);
      // Always cache the freshest snap, regardless of whether an alert
      // is going to fire below. Digests / aggregates read from this so
      // slow-drifting markets that never cross the alert threshold
      // still report accurate prices in summaries.
      latestSnapPerSub.set(k, snap);
      // One-shot price-cross alerts. Evaluated before the change-diff
      // pipeline because they deliberately BYPASS cooldown and
      // digest-only mode (the user asked for this exact price). Pause
      // and quiet hours still gate evaluation — the alert stays armed
      // and fires on the first poll after the mute lifts.
      if (s.priceAlerts?.length
          && !(s.pausedUntil && now < s.pausedUntil)
          && !isChatInQuietHours(s.chatId, now)) {
        if (await firePriceAlerts(s, snap)) needsSave = true;
      }
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
      // Lazily backfill the parent event question for subs created
      // before the field shipped — drives digest grouping (options
      // of the same event collapse under one 📂 header). Cache hit
      // after the first markets fetch, so the await is cheap; one
      // attempt per sub per process avoids re-querying markets that
      // genuinely have no question.
      if (!s.question && !questionBackfillTried.has(k)) {
        questionBackfillTried.add(k);
        try {
          const m = await getMarketById(s.marketId);
          if (m?.question) {
            setSubscriptionQuestion(s.chatId, s.marketId, m.question);
            needsSave = true;
          }
        } catch { /* best-effort; retry next process */ }
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
      // Quiet hours OR digest-only mode: skip the Telegram send but
      // still update baselines + write history so /digest /history
      // /stats / /digestlog stay accurate. digest-only is the user-
      // opted-in version of "I only want the periodic summary, not
      // per-poll alerts".
      const muted = isChatInQuietHours(s.chatId, now) || isChatDigestOnly(s.chatId);
      try {
        if (!muted) {
          await sendThrottled(s.chatId, text, { replyMarkup });
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
        // Chat permanently unreachable (blocked / kicked / deleted) —
        // drop the sub AND its runtime maps so we stop retrying.
        if (isPermanentSendError(err)) {
          removeSubscription(s.chatId, s.marketId);
          clearSubRuntime(s.chatId, s.marketId);
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
    // Prefer the freshest poll snap so non-alerting markets still
    // report current prices in the digest. Fall back to the last-alert
    // snap (and finally the persisted s.lastSnap) so a brand-new
    // process that hasn't polled this sub yet doesn't blank-line it.
    const key = subKey(s.chatId, s.marketId);
    const snap = latestSnapPerSub.get(key)
      ?? lastBookPerSub.get(key)
      ?? s.lastSnap
      ?? null;
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

  // Group entries by their shared event slug. Predict.fun gives every
  // option of one event the SAME slug (e.g. all of "$20M/$50M/$100M..."
  // share "concrete-fdv-above-one-day-after-launch") while each option's
  // `question` differs (it embeds the amount), so slug is the reliable
  // grouping key. The group header is derived from the options' questions
  // via deriveEventTitle. Subs with no slug, or the only sub under their
  // slug, render as standalone rows.
  const buildBlocks = (arr) => {
    const bySlug = new Map();
    for (const e of arr) {
      const slug = (e.sub.slug || '').trim();
      const key = slug || `__solo:${e.sub.marketId}`;
      if (!bySlug.has(key)) bySlug.set(key, { slug, items: [] });
      bySlug.get(key).items.push(e);
    }
    const out = [];
    for (const { slug, items } of bySlug.values()) {
      items.sort((a, b) => (b._biggest ?? 0) - (a._biggest ?? 0));
      const isGroup = items.length > 1 && !!slug;
      const header = isGroup
        ? deriveEventTitle(items.map((e) => (e.sub.question || '').trim()))
        : '';
      out.push({
        header,
        items,
        biggest: items[0]._biggest ?? 0,
        isGroup,
      });
    }
    out.sort((a, b) => b.biggest - a.biggest);
    return out;
  };

  // Render every changed row. sendMessage auto-splits into multiple
  // Telegram messages, so the cap is just a pathological-case guard
  // (thousands of movers), not a real truncation point.
  const CAP_DETAIL = 300;
  let detailCount = 0;
  let dropped = 0;

  // Show changed first.
  const changedBlocks = buildBlocks(changed);
  for (const b of changedBlocks) {
    if (detailCount >= CAP_DETAIL) { dropped += b.items.length; continue; }
    if (b.isGroup) {
      const qText = b.header.length > 80 ? b.header.slice(0, 77) + '…' : b.header;
      lines.push(`<b>📂 ${htmlEscape(qText)}</b>`);
      const room = CAP_DETAIL - detailCount;
      const showItems = b.items.slice(0, room);
      for (const e of showItems) {
        const { sub, snap } = e;
        const titleLink = marketLink(sub.title || `#${sub.marketId}`, sub.slug);
        const bb = snap.bestBid.price.toFixed(4);
        const ba = snap.bestAsk.price.toFixed(4);
        lines.push(`  ${dot(e._dBid, e._dAsk)} ${titleLink} <code>${sub.marketId}</code> · 买1 ${bb}${fmtDelta(e._dBid)} / 卖1 ${ba}${fmtDelta(e._dAsk)}`);
        detailCount += 1;
      }
      const hidden = b.items.length - showItems.length;
      if (hidden > 0) { lines.push(`  <i>… 另 ${hidden} 个选项</i>`); dropped += hidden; }
    } else {
      const e = b.items[0];
      const { sub, snap } = e;
      // Singleton: render exactly like a group — bold black 📂 header
      // (the full question for event context) + one indented row with
      // the clickable option label. Telegram links can't be black, so
      // the header is plain bold and the link lives on the child row.
      const headline = sub.question || sub.title || `Market ${sub.marketId}`;
      const qText = headline.length > 80 ? headline.slice(0, 77) + '…' : headline;
      lines.push(`<b>📂 ${htmlEscape(qText)}</b>`);
      const optLabel = (sub.title && sub.title.trim() && sub.title !== headline) ? sub.title : '查看盘口';
      const bb = snap.bestBid.price.toFixed(4);
      const ba = snap.bestAsk.price.toFixed(4);
      lines.push(`  ${dot(e._dBid, e._dAsk)} ${marketLink(optLabel, sub.slug)} <code>${sub.marketId}</code> · 买1 ${bb}${fmtDelta(e._dBid)} / 卖1 ${ba}${fmtDelta(e._dAsk)}`);
      detailCount += 1;
    }
  }
  if (dropped > 0) {
    lines.push('', `<i>… 还有 ${dropped} 个有变化（按变化大小排序，/list 查看全部）</i>`);
  }

  // 🆕 first-time entries (e.g. brand-new subs since last digest).
  if (fresh.length) {
    if (changed.length) lines.push('');
    const freshBlocks = buildBlocks(fresh);
    let freshDetail = 0;
    let freshDropped = 0;
    const FRESH_CAP = 100;
    for (const b of freshBlocks) {
      if (freshDetail >= FRESH_CAP) { freshDropped += b.items.length; continue; }
      if (b.isGroup) {
        const qText = b.header.length > 80 ? b.header.slice(0, 77) + '…' : b.header;
        lines.push(`<b>📂 ${htmlEscape(qText)}</b>  <i>🆕 首次</i>`);
        const room = FRESH_CAP - freshDetail;
        const showItems = b.items.slice(0, room);
        for (const e of showItems) {
          const { sub, snap } = e;
          const titleLink = marketLink(sub.title || `#${sub.marketId}`, sub.slug);
          const bb = snap.bestBid.price.toFixed(4);
          const ba = snap.bestAsk.price.toFixed(4);
          lines.push(`  🆕 ${titleLink} <code>${sub.marketId}</code> · 买1 ${bb} / 卖1 ${ba}`);
          freshDetail += 1;
        }
        const hidden = b.items.length - showItems.length;
        if (hidden > 0) { lines.push(`  <i>… 另 ${hidden} 个选项</i>`); freshDropped += hidden; }
      } else {
        const e = b.items[0];
        const headline = e.sub.question || e.sub.title || `Market ${e.sub.marketId}`;
        const qText = headline.length > 80 ? headline.slice(0, 77) + '…' : headline;
        lines.push(`<b>📂 ${htmlEscape(qText)}</b>  <i>🆕 首次</i>`);
        const optLabel = (e.sub.title && e.sub.title.trim() && e.sub.title !== headline) ? e.sub.title : '查看盘口';
        const bb = e.snap.bestBid.price.toFixed(4);
        const ba = e.snap.bestAsk.price.toFixed(4);
        lines.push(`  🆕 ${marketLink(optLabel, e.sub.slug)} <code>${e.sub.marketId}</code> · 买1 ${bb} / 卖1 ${ba}`);
        freshDetail += 1;
      }
    }
    if (freshDropped > 0) lines.push(`<i>… 另 ${freshDropped} 个首次</i>`);
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
  await sendThrottled(chatId, text);

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
        // Per-option question — lets /digestlog's aggregate derive the
        // shared event header (deriveEventTitle) when grouping by slug.
        question: e.sub.question || null,
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
