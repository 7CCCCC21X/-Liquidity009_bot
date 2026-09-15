// Client-side token bucket for the Predict.fun REST API.
//
// Predict.fun enforces a per-app "general" bucket (5,000 req/min on the
// base tier, shared by every process using the same API key). Without a
// local governor the booklog fast loop × POLL_CONCURRENCY can blow past
// that the moment a few markets are journaled at 1s, and every 429 then
// costs a retry cycle on top. This bucket keeps us under a configurable
// budget and lets a 429's Retry-After pause *everything* at once instead
// of each in-flight request backing off independently.
//
// Zero dependencies; one shared timer; FIFO fairness.

export function createRateLimiter({ perMinute = 0, burst } = {}) {
  const enabled = Number.isFinite(perMinute) && perMinute > 0;
  const perSecond = enabled ? perMinute / 60 : Infinity;
  // Default burst: ~2s worth of budget, never below 5 so a single tick
  // with a handful of markets doesn't serialise unnecessarily.
  const capacity = enabled
    ? Math.max(5, Math.floor(Number.isFinite(burst) && burst > 0 ? burst : perSecond * 2))
    : Infinity;

  let tokens = capacity;
  let lastRefill = Date.now();
  let blockedUntil = 0;
  let timer = null;
  const queue = []; // resolvers waiting for a token
  const stats = { acquired: 0, waited: 0, blocks: 0, maxQueue: 0 };

  function refill(now) {
    if (!enabled) return;
    const elapsed = (now - lastRefill) / 1000;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * perSecond);
    lastRefill = now;
  }

  function drain() {
    timer = null;
    const now = Date.now();
    refill(now);
    while (queue.length) {
      if (now < blockedUntil) break;
      if (tokens < 1) break;
      tokens -= 1;
      stats.acquired += 1;
      queue.shift()();
    }
    if (queue.length) schedule();
  }

  function schedule() {
    if (timer) return;
    const now = Date.now();
    let waitMs;
    if (now < blockedUntil) waitMs = blockedUntil - now;
    else if (tokens >= 1) waitMs = 0;
    else waitMs = Math.ceil(((1 - tokens) / perSecond) * 1000);
    timer = setTimeout(drain, Math.max(1, waitMs));
    // Never keep the process alive just for a pending refill.
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    enabled,
    perMinute,
    capacity,
    // Resolve when a request may go out. Fast path returns a resolved
    // promise without touching the queue.
    acquire() {
      if (!enabled) { stats.acquired += 1; return Promise.resolve(); }
      const now = Date.now();
      refill(now);
      if (!queue.length && now >= blockedUntil && tokens >= 1) {
        tokens -= 1;
        stats.acquired += 1;
        return Promise.resolve();
      }
      stats.waited += 1;
      return new Promise((resolve) => {
        queue.push(resolve);
        if (queue.length > stats.maxQueue) stats.maxQueue = queue.length;
        schedule();
      });
    },
    // Global pause — a 429 from the server means the *bucket* is empty,
    // not just this one request, so everybody waits.
    block(ms) {
      const until = Date.now() + Math.max(0, Number(ms) || 0);
      if (until > blockedUntil) {
        blockedUntil = until;
        stats.blocks += 1;
        // Drop to zero so the first requests after the pause don't
        // burst straight back into the limit.
        tokens = 0;
        lastRefill = until;
      }
      if (queue.length) schedule();
    },
    blockedForMs() {
      return Math.max(0, blockedUntil - Date.now());
    },
    snapshot() {
      refill(Date.now());
      return {
        enabled,
        perMinute,
        capacity,
        tokens: enabled ? Math.floor(tokens) : null,
        queued: queue.length,
        blockedForMs: Math.max(0, blockedUntil - Date.now()),
        ...stats,
      };
    },
  };
}
