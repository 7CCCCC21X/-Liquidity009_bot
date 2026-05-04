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

export const config = {
  telegramBotToken: envStr('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: envStr('TELEGRAM_CHAT_ID', ''),

  predictApiKey: envStr('PREDICT_API_KEY', ''),
  graphqlUrl: envStr('GRAPHQL_URL', 'https://graphql.predict.fun/graphql'),
  restUrl: envStr('REST_URL', 'https://api.predict.fun/v1'),
  orderbookPathTemplate: envStr('ORDERBOOK_PATH_TEMPLATE', '/markets/{key}/orderbook'),
  orderbookKeyField: envStr('ORDERBOOK_KEY_FIELD', 'conditionId'),

  pollIntervalMs: envNum('POLL_INTERVAL_MS', 30_000),
  marketsCacheTtlMs: envNum('MARKETS_CACHE_TTL_MS', 600_000),
  graphqlTimeoutMs: envNum('GRAPHQL_TIMEOUT_MS', 30_000),
  orderbookTimeoutMs: envNum('ORDERBOOK_TIMEOUT_MS', 10_000),

  priceEpsilon: envNum('PRICE_EPSILON', 0.005),
  sizeRelativeEpsilon: envNum('SIZE_RELATIVE_EPSILON', 0.10),
  sizeAbsoluteMin: envNum('SIZE_ABSOLUTE_MIN', 50),
  notifyCooldownMs: envNum('NOTIFY_COOLDOWN_SEC', 60) * 1000,

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
