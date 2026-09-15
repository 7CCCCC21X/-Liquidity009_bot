import 'node:process';

function envStr(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return String(v);
}

function envNum(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function envCsv(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const config = {
  telegramBotToken: envStr('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: envStr('TELEGRAM_CHAT_ID', ''),
  // Whitelist of chat IDs allowed to use the bot. Empty → open to
  // anyone who finds the bot (the prior default). Set to "123,456"
  // to restrict — every other chat gets a polite "not authorised"
  // refusal at the message/callback entry point.
  allowedChatIds: envCsv('ALLOWED_CHAT_IDS', []),

  predictApiKey: envStr('PREDICT_API_KEY', ''),
  graphqlUrl: envStr('GRAPHQL_URL', 'https://graphql.predict.fun/graphql'),
  restUrl: envStr('REST_URL', 'https://api.predict.fun/v1'),
  // Referral code appended to predict.fun market URLs the bot prints
  // (so clicking a market title in Telegram opens the page with this
  // ref attribution). Default 'B00EA'; blank to disable.
  predictRefCode: envStr('PREDICT_REF_CODE', 'B00EA'),
  // Locale prefix on the URL — predict.fun mirrors the same page at
  // /, /zh-cn/, /en/, etc. Pick the one you want links to land on.
  predictUrlLocale: envStr('PREDICT_URL_LOCALE', 'zh-cn'),

  // Timezone for timestamps in messages (notifications, /history).
  // Accepts any IANA name; default 'Asia/Shanghai' (UTC+8). The label
  // is appended after the time so users know the offset.
  displayTz: envStr('DISPLAY_TZ', 'Asia/Shanghai'),
  displayTzLabel: envStr('DISPLAY_TZ_LABEL', '北京时间'),

  orderbookPathTemplate: envStr('ORDERBOOK_PATH_TEMPLATE', '/markets/{key}/orderbook'),
  orderbookKeyField: envStr('ORDERBOOK_KEY_FIELD', 'conditionId'),

  pollIntervalMs: envNum('POLL_INTERVAL_MS', 30_000),
  // 挂撤单日记 fast loop — journal-enabled markets poll on their own
  // (much faster) cadence, independent of the main alert loop above.
  // Runtime-adjustable via /booklog speed; this is the default.
  booklogPollIntervalMs: envNum('BOOKLOG_POLL_INTERVAL_MS', 1000),
  // Hard floor for the monitor sleep — protects against runaway loops
  // when POLL_INTERVAL_MS is set very low. Default 200ms supports
  // sub-second polling on healthy networks; bump up if you start
  // seeing 429s from Predict.fun.
  pollMinIntervalMs: envNum('POLL_MIN_INTERVAL_MS', 200),
  // Cap on parallel orderbook fetches per tick. Predict.fun's REST is
  // healthy at moderate concurrency — 8 keeps us well under any
  // reasonable rate limit while still giving big speed-ups for users
  // with many subscriptions.
  pollConcurrency: envNum('POLL_CONCURRENCY', 8),
  marketsCacheTtlMs: envNum('MARKETS_CACHE_TTL_MS', 600_000),
  // Client-side budget for the REST API (requests per minute, token
  // bucket). Predict.fun's base "general" bucket is 5,000/min PER APP
  // and is shared by every process using the same API key — so leave
  // headroom for anything else on the key. 0 disables the governor.
  restRateLimitPerMin: envNum('REST_RATE_LIMIT_PER_MIN', 3000),
  // Max burst the bucket may release at once (defaults to ~2s of budget).
  restRateLimitBurst: envNum('REST_RATE_LIMIT_BURST', 0),
  // After an orderbook 404s (market settled/delisted, or a stale
  // conditionId) we stop hitting it every tick and back off
  // exponentially up to this cap. The auto-unsubscribe streak in
  // monitor.js still advances on cached misses, so dead markets are
  // still pruned — just without the request storm.
  orderbookNotFoundBackoffMaxMs: envNum('ORDERBOOK_404_BACKOFF_MAX_MS', 60_000),

  // Real-time orderbook feed over WebSocket (wss://ws.predict.fun/ws,
  // topic predictOrderbook/<marketId>). When a market has a fresh WS
  // snapshot the booklog fast loop and the main loop both skip their
  // REST fetch for it — sub-second journal entries with ~zero REST
  // quota. REST polling stays as the fallback whenever the socket is
  // down or a market's feed goes quiet, so turning this on can never
  // make things worse than pure polling. Needs Node ≥ 22 (global
  // WebSocket); on older runtimes it logs once and stays off.
  wsEnabled: envBool('PREDICT_WS_ENABLED', true),
  wsUrl: envStr('PREDICT_WS_URL', 'wss://ws.predict.fun/ws'),
  // Heartbeat watchdog: the server heartbeats every ~15s. If nothing
  // arrives for this long the socket is considered dead — every market
  // falls back to REST polling and the client reconnects. Default 45s
  // (three missed heartbeats).
  wsStaleMs: envNum('PREDICT_WS_STALE_MS', 45_000),
  // While a market is WS-live the booklog loop still REST-fetches it at
  // this slow cadence as an audit. If the audit finds a change the feed
  // never pushed, the market goes back to full-speed polling for
  // PREDICT_WS_DISTRUST_MS. Set audit to 0 to disable.
  wsAuditIntervalMs: envNum('PREDICT_WS_AUDIT_INTERVAL_MS', 60_000),
  wsDistrustMs: envNum('PREDICT_WS_DISTRUST_MS', 600_000),
  graphqlTimeoutMs: envNum('GRAPHQL_TIMEOUT_MS', 30_000),
  orderbookTimeoutMs: envNum('ORDERBOOK_TIMEOUT_MS', 10_000),

  // Predict.fun prices live on a 0–1 scale rendered as cents (44¢ =
  // 0.44 internally), so the smallest visible tick is 0.001. Default
  // priceEpsilon=0.001 means any single-cent-tenth move (e.g. 44.0 →
  // 44.1) clears the gate.
  priceEpsilon: envNum('PRICE_EPSILON', 0.001),
  sizeRelativeEpsilon: envNum('SIZE_RELATIVE_EPSILON', 0.05),
  sizeAbsoluteMin: envNum('SIZE_ABSOLUTE_MIN', 10),
  notifyCooldownMs: envNum('NOTIFY_COOLDOWN_SEC', 60) * 1000,

  // Defaults applied to NEW subscriptions when the user doesn't pick
  // anything explicitly. Existing subscriptions keep whatever was
  // previously saved — change these only affects future subscribes.
  // DEFAULT_LEVELS: comma-separated subset of bid1,bid2,bid3,ask1,ask2,ask3
  defaultLevels: envCsv('DEFAULT_LEVELS', ['bid1', 'ask1']),
  // DEFAULT_TRIGGER_MODE: 'both' | 'price' | 'size'
  defaultTriggerMode: envStr('DEFAULT_TRIGGER_MODE', 'price'),

  stateFile: envStr('STATE_FILE', './state.json'),

  historyEnabled: envBool('HISTORY_ENABLED', true),
  historyFile: envStr('HISTORY_FILE', './history.jsonl'),
  historyKeepDays: envNum('HISTORY_KEEP_DAYS', 14),
};

export function requireConfig() {
  const missing = [];
  if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
