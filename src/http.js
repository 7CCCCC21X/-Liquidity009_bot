const RETRIABLE = [/fetch failed/i, /ECONNRESET/i, /ETIMEDOUT/i, /ENETUNREACH/i, /EAI_AGAIN/i];

function isRetriable(err) {
  if (err?.name === 'AbortError') return true;
  if (err?.status === 429) return true;
  if (Number.isFinite(err?.status) && err.status >= 500) return true;
  if (err?.status == null) return RETRIABLE.some((re) => re.test(String(err?.message ?? '')));
  return false;
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
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
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
        // Surface the server-specified backoff so the retry loop can
        // honour it instead of blindly exponential-backing-off into a
        // longer ban. Two sources: the standard Retry-After header
        // (seconds) and Telegram's JSON `parameters.retry_after`.
        const headerSec = Number(res.headers.get('retry-after'));
        if (Number.isFinite(headerSec) && headerSec > 0) {
          err.retryAfterMs = headerSec * 1000;
        } else if (res.status === 429) {
          try {
            const sec = Number(JSON.parse(text)?.parameters?.retry_after);
            if (Number.isFinite(sec) && sec > 0) err.retryAfterMs = sec * 1000;
          } catch { /* body not JSON — fall back to exponential */ }
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
      // Server told us exactly how long to wait (429 / Retry-After) —
      // respect it, capped at 60s so a pathological value can't stall
      // the caller forever.
      if (Number.isFinite(err?.retryAfterMs)) {
        delay = Math.max(delay, Math.min(err.retryAfterMs, 60_000));
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
