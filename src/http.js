const RETRIABLE = [/fetch failed/i, /ECONNRESET/i, /ETIMEDOUT/i, /ENETUNREACH/i, /EAI_AGAIN/i];

function isRetriable(err) {
  if (err?.name === 'AbortError') return true;
  if (err?.status === 429) return true;
  if (Number.isFinite(err?.status) && err.status >= 500) return true;
  if (err?.status == null) return RETRIABLE.some((re) => re.test(String(err?.message ?? '')));
  return false;
}

// Parse a Retry-After header (seconds or HTTP-date) into milliseconds.
// Returns null when absent/unparseable so callers fall back to their
// own backoff. Clamped to [0, 5min] — a bogus huge value must never
// wedge the poll loops.
export function parseRetryAfterMs(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(s)) ms = Number(s) * 1000;
  else {
    const t = Date.parse(s);
    if (Number.isFinite(t)) ms = t - Date.now();
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  return Math.max(0, Math.min(ms, 300_000));
}

// Some rate limiters expose the reset time instead of Retry-After.
function rateLimitResetMs(headers) {
  const reset = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset');
  if (reset == null) return null;
  const n = Number(reset);
  if (!Number.isFinite(n)) return null;
  // Either epoch seconds, epoch millis, or a delta in seconds.
  if (n > 1e12) return Math.max(0, n - Date.now());
  if (n > 1e9) return Math.max(0, n * 1000 - Date.now());
  return Math.max(0, n * 1000);
}

export async function fetchJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15_000,
  retries = 2,
  retryDelayMs = 1_000,
  signal: externalSignal,
  parseJson = true,
  // Optional token bucket (see ratelimit.js). Every attempt acquires a
  // token first; a 429 pauses the whole bucket for Retry-After.
  limiter = null,
  // Fallback pause when a 429 carries no Retry-After (ms).
  rateLimitFallbackMs = 2_000,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (limiter) await limiter.acquire();
    if (externalSignal?.aborted) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let onAbort;
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      onAbort = () => ctrl.abort();
      externalSignal.addEventListener('abort', onAbort);
    }
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
        err.status = res.status;
        err.body = text;
        err.url = url;
        if (res.status === 429) {
          err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
            ?? rateLimitResetMs(res.headers)
            ?? rateLimitFallbackMs;
          // Pause every caller sharing this bucket, not just us.
          if (limiter) limiter.block(err.retryAfterMs);
        }
        throw err;
      }
      if (!parseJson) return text;
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        const err = new Error(`Invalid JSON from ${url}: ${parseErr.message}`);
        err.body = text;
        throw err;
      }
    } catch (err) {
      lastErr = err;
      if (externalSignal?.aborted) break;
      if (!isRetriable(err) || attempt === retries) break;
      let delay = retryDelayMs * Math.pow(2, attempt) + Math.random() * 200;
      // Honour the server's own pause on 429 — retrying sooner is
      // guaranteed to fail and burns another request from the bucket.
      if (err.status === 429 && Number.isFinite(err.retryAfterMs)) {
        delay = Math.max(delay, err.retryAfterMs + Math.random() * 200);
      }
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      clearTimeout(timer);
      if (externalSignal && onAbort) externalSignal.removeEventListener('abort', onAbort);
    }
  }
  if (lastErr?.name === 'AbortError' && !externalSignal?.aborted) {
    const e = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    e.cause = lastErr;
    throw e;
  }
  throw lastErr;
}
