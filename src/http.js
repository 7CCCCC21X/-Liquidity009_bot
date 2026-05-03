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
      const delay = retryDelayMs * Math.pow(2, attempt) + Math.random() * 200;
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
