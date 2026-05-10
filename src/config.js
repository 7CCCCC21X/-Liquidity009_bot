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
  graphqlTimeoutMs: envNum('GRAPHQL_TIMEOUT_MS', 30_000),
  orderbookTimeoutMs: envNum('ORDERBOOK_TIMEOUT_MS', 10_000),

  priceEpsilon: envNum('PRICE_EPSILON', 0.005),
  sizeRelativeEpsilon: envNum('SIZE_RELATIVE_EPSILON', 0.10),
  sizeAbsoluteMin: envNum('SIZE_ABSOLUTE_MIN', 50),
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
