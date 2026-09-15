// Real-time orderbook feed over Predict.fun's WebSocket API.
//
// Protocol (mirrors the public Rust SDK, github.com/sproot/predict-sdk):
//   connect   wss://ws.predict.fun/ws
//   request   {"method":"subscribe","requestId":1,"params":["predictOrderbook/<marketId>"]}
//             {"method":"unsubscribe","requestId":2,"params":[...]}
//             {"method":"heartbeat","data":<ts>}       ← echo of server heartbeat
//   response  {"type":"R","requestId":1,"success":true|false,"error":{code,message}}
//   push      {"type":"M","topic":"heartbeat","data":<ts>}
//             {"type":"M","topic":"predictOrderbook/<id>","data":{marketId,bids:[{price,size}],asks:[...],timestamp}}
//
// Every market with a live subscription gets its book pushed on change,
// with the latest snapshot delivered immediately on subscribe. The
// monitor treats a market as "WS-live" (and skips its REST poll) only
// while: socket open, subscribe acked, ≥1 book received, and a message
// (heartbeats count) seen within PREDICT_WS_STALE_MS. Anything else
// falls back to REST polling automatically, so this can never be worse
// than pure polling — at worst it is exactly pure polling.
//
// Zero dependencies: uses the global WebSocket (Node ≥ 22).

import { config } from './config.js';
import { normalizeBook } from './predict.js';

const TOPIC_PREFIX = 'predictOrderbook/';
const HEARTBEAT_TOPIC = 'heartbeat';
const CONNECT_TIMEOUT_MS = 10_000;
const SYNC_INTERVAL_MS = 1_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BAD_TOPIC_TTL_MS = 5 * 60_000;

const st = {
  supported: typeof globalThis.WebSocket === 'function',
  running: false,
  connected: false,
  connects: 0,
  lastConnectAt: 0,
  lastMsgAt: 0,
  lastBookAt: 0,
  lastError: null,
  msgs: 0,
  books: 0,
  heartbeats: 0,
  subscribed: new Set(),      // acked topics (marketId strings)
  pending: new Map(),         // requestId -> { method, marketId }
  latest: new Map(),          // marketId -> last normalized snapshot
  lastBookAtBy: new Map(),    // marketId -> ts of last push
  badTopics: new Map(),       // marketId -> retry-after ts (subscribe rejected)
  distrust: new Map(),        // marketId -> until ts (monitor audit caught a gap)
};

let _ws = null;
let _reqId = 0;

export function wsEnabled() {
  return !!config.wsEnabled && st.supported;
}

export function wsStatus() {
  const now = Date.now();
  return {
    enabled: !!config.wsEnabled,
    supported: st.supported,
    running: st.running,
    connected: st.connected,
    connects: st.connects,
    subscribed: st.subscribed.size,
    booksHeld: st.latest.size,
    msgs: st.msgs,
    books: st.books,
    heartbeats: st.heartbeats,
    lastMsgAgoMs: st.lastMsgAt ? now - st.lastMsgAt : null,
    lastBookAgoMs: st.lastBookAt ? now - st.lastBookAt : null,
    distrusted: [...st.distrust.entries()].filter(([, t]) => t > now).length,
    lastError: st.lastError,
  };
}

function feedAlive(now = Date.now()) {
  return st.connected && st.lastMsgAt > 0 && (now - st.lastMsgAt) < config.wsStaleMs;
}

// Is this market's book currently being maintained by the socket?
export function isWsLive(marketId, now = Date.now()) {
  const id = String(marketId);
  if (!feedAlive(now)) return false;
  if (!st.subscribed.has(id)) return false;
  if (!st.latest.has(id)) return false;
  const until = st.distrust.get(id);
  if (until && until > now) return false;
  return true;
}

export function wsLatestBook(marketId) {
  return st.latest.get(String(marketId)) ?? null;
}

// ms since the feed last pushed this market's book (Infinity if never).
export function wsLastBookAgoMs(marketId, now = Date.now()) {
  const t = st.lastBookAtBy.get(String(marketId));
  return t ? now - t : Infinity;
}

// Called by the monitor's REST audit when it finds a change the feed
// never pushed. The market goes back to REST polling for `ms`.
export function distrustWsMarket(marketId, ms) {
  st.distrust.set(String(marketId), Date.now() + Math.max(1000, ms | 0));
}

function send(obj) {
  if (!_ws || _ws.readyState !== 1) return false;
  try {
    _ws.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    st.lastError = `send: ${err.message}`;
    return false;
  }
}

function request(method, marketId) {
  const id = ++_reqId;
  st.pending.set(id, { method, marketId: String(marketId), at: Date.now() });
  return send({ method, requestId: id, params: [`${TOPIC_PREFIX}${marketId}`] });
}

function handleMessage(raw, onBook) {
  let msg;
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const now = Date.now();
  st.msgs += 1;
  st.lastMsgAt = now;
  if (msg?.type === 'R') {
    const p = msg.requestId != null ? st.pending.get(msg.requestId) : null;
    if (msg.requestId != null) st.pending.delete(msg.requestId);
    if (!p) return;
    if (msg.success === false) {
      const why = msg.error ? `${msg.error.code ?? ''} ${msg.error.message ?? ''}`.trim() : 'rejected';
      st.lastError = `${p.method} ${p.marketId}: ${why}`;
      if (p.method === 'subscribe') {
        st.subscribed.delete(p.marketId);
        st.badTopics.set(p.marketId, now + BAD_TOPIC_TTL_MS);
        console.warn(`[ws] subscribe ${p.marketId} rejected: ${why} — REST polling continues for it`);
      }
      return;
    }
    if (p.method === 'subscribe') st.subscribed.add(p.marketId);
    else if (p.method === 'unsubscribe') {
      st.subscribed.delete(p.marketId);
      st.latest.delete(p.marketId);
      st.lastBookAtBy.delete(p.marketId);
    }
    return;
  }
  if (msg?.type !== 'M') return;
  const topic = String(msg.topic ?? '');
  if (topic === HEARTBEAT_TOPIC) {
    st.heartbeats += 1;
    send({ method: 'heartbeat', data: msg.data });
    return;
  }
  if (!topic.startsWith(TOPIC_PREFIX)) return;
  const marketId = topic.slice(TOPIC_PREFIX.length);
  const data = msg.data;
  // Defensive: only accept a payload that is unambiguously a full
  // book. Anything else is ignored and the REST fallback keeps the
  // market covered.
  if (!data || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return;
  const snap = normalizeBook(marketId, data, { source: 'ws', sort: true });
  st.books += 1;
  st.lastBookAt = now;
  st.latest.set(marketId, snap);
  st.lastBookAtBy.set(marketId, now);
  // A server pushing a subscribe we never acked still counts as live.
  st.subscribed.add(marketId);
  try {
    onBook(marketId, snap);
  } catch (err) {
    console.warn('[ws] onBook failed:', marketId, err.message);
  }
}

// Reconcile subscriptions with what the monitor currently wants.
function syncTopics(getWantedMarketIds) {
  if (!_ws || _ws.readyState !== 1) return;
  const now = Date.now();
  const wanted = new Set([...getWantedMarketIds()].map(String));
  const inflight = new Set([...st.pending.values()].map((p) => p.marketId));
  for (const id of wanted) {
    if (st.subscribed.has(id) || inflight.has(id)) continue;
    const bad = st.badTopics.get(id);
    if (bad && bad > now) continue;
    request('subscribe', id);
  }
  for (const id of st.subscribed) {
    if (wanted.has(id) || inflight.has(id)) continue;
    request('unsubscribe', id);
  }
  // Expire stale pendings (no ack in 30s) so they can be retried.
  for (const [rid, p] of st.pending) {
    if (now - p.at > 30_000) st.pending.delete(rid);
  }
}

function resetConnState() {
  st.connected = false;
  st.subscribed.clear();
  st.pending.clear();
  st.latest.clear();
  st.lastBookAtBy.clear();
  _ws = null;
}

function openSocket(url) {
  const headers = {};
  if (config.predictApiKey) headers['x-api-key'] = config.predictApiKey;
  // undici's WebSocket accepts { headers } as the second argument; the
  // spec-shaped constructor doesn't. Try with headers, fall back plain.
  try {
    return new WebSocket(url, Object.keys(headers).length ? { headers } : undefined);
  } catch {
    return new WebSocket(url);
  }
}

function connectOnce(url, getWantedMarketIds, onBook, signal) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = openSocket(url);
    } catch (err) {
      st.lastError = `open: ${err.message}`;
      resolve({ openedAt: 0 });
      return;
    }
    _ws = ws;
    let openedAt = 0;
    let syncTimer = null;
    let watchdog = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearInterval(syncTimer);
      clearInterval(watchdog);
      signal?.removeEventListener('abort', onAbort);
      resetConnState();
      resolve({ openedAt });
    };
    const onAbort = () => { try { ws.close(); } catch { /* ignore */ } finish(); };
    signal?.addEventListener('abort', onAbort);
    const connectTimer = setTimeout(() => {
      if (openedAt) return;
      st.lastError = 'connect timeout';
      try { ws.close(); } catch { /* ignore */ }
      finish();
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      openedAt = Date.now();
      st.connected = true;
      st.connects += 1;
      st.lastConnectAt = openedAt;
      st.lastMsgAt = openedAt;
      st.lastError = null;
      console.log(`[ws] connected ${url}`);
      syncTopics(getWantedMarketIds);
      syncTimer = setInterval(() => syncTopics(getWantedMarketIds), SYNC_INTERVAL_MS);
      // The server heartbeats every ~15s; if nothing at all arrives
      // for wsStaleMs the socket is half-dead — drop it and reconnect.
      watchdog = setInterval(() => {
        if (Date.now() - st.lastMsgAt > config.wsStaleMs) {
          st.lastError = `no message for ${config.wsStaleMs}ms`;
          console.warn('[ws] stale socket, reconnecting');
          try { ws.close(); } catch { /* ignore */ }
          finish();
        }
      }, 1_000);
    });
    ws.addEventListener('message', (ev) => handleMessage(ev.data, onBook));
    ws.addEventListener('error', (ev) => {
      st.lastError = `socket error: ${ev?.message ?? ev?.error?.message ?? 'unknown'}`;
    });
    ws.addEventListener('close', (ev) => {
      if (openedAt) console.warn(`[ws] closed code=${ev?.code} reason=${ev?.reason || ''}`);
      finish();
    });
  });
}

// Long-running feed. `getWantedMarketIds` is polled every second so
// new subscriptions/journals attach without any explicit wiring;
// `onBook(marketId, snap)` fires for every accepted book push.
export async function startOrderbookFeed({ signal, getWantedMarketIds, onBook }) {
  if (!config.wsEnabled) return;
  if (!st.supported) {
    console.warn('[ws] global WebSocket not available (Node < 22?) — REST polling only');
    return;
  }
  if (st.running) return;
  st.running = true;
  let backoff = BACKOFF_MIN_MS;
  while (!signal?.aborted) {
    // No point holding a socket open with nothing to watch.
    if (![...getWantedMarketIds()].length) {
      await sleep(2_000, signal);
      continue;
    }
    const { openedAt } = await connectOnce(config.wsUrl, getWantedMarketIds, onBook, signal);
    if (signal?.aborted) break;
    // A connection that lived ≥ 60s resets the backoff ladder.
    if (openedAt && Date.now() - openedAt >= 60_000) backoff = BACKOFF_MIN_MS;
    const wait = backoff + Math.random() * 250;
    console.warn(`[ws] reconnecting in ${Math.round(wait)}ms (${st.lastError ?? 'closed'})`);
    await sleep(wait, signal);
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
  }
  st.running = false;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
