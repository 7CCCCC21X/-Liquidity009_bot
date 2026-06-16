import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { config } from './config.js';

// Stream a JSONL file line by line. Critical: never read the whole file
// into one string — an append-only history.jsonl can grow past V8's
// ~512MB max string length, at which point fs.readFile(..., 'utf8')
// throws "Invalid string length" and every reader (/digestlog, /history,
// prune) breaks at once. readline over a byte stream sidesteps that.
// Returns the parsed events to `onEvt`; ENOENT resolves to no-op.
async function streamLines(file, onLine) {
  let input;
  try {
    input = createReadStream(file, { encoding: 'utf8' });
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line) await onLine(line);
    }
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  } finally {
    rl.close();
    input.destroy();
  }
}

// Append-only JSONL log of every notification we send. One line per
// event; cheap to write, easy to grep, easy to ship off-box. On Railway
// point HISTORY_FILE at /data/history.jsonl so it survives redeploys.

let _appendQueue = Promise.resolve();
let _dirEnsured = false;

export async function appendEvent(evt) {
  if (!config.historyEnabled) return;
  const line = JSON.stringify({ ts: Date.now(), ...evt }) + '\n';
  // Serialize appends so concurrent ticks don't interleave bytes
  // mid-line. The leading .catch() resets the chain after a failure
  // so one bad write (full disk, EACCES, …) doesn't leave the queue
  // permanently rejected and silently drop every subsequent event.
  // mkdir -p once per process so /data style mounts work even if the
  // directory wasn't pre-created.
  _appendQueue = _appendQueue
    .catch(() => {})
    .then(async () => {
      if (!_dirEnsured) {
        try { await fs.mkdir(path.dirname(config.historyFile), { recursive: true }); } catch { /* root or already there */ }
        _dirEnsured = true;
      }
      await fs.appendFile(config.historyFile, line);
    })
    .catch((err) => {
      console.warn(new Date().toISOString(), '[history] append failed:', err.message);
      // Re-throw so caller (if any) sees it; the next .catch() in line
      // will reset the chain on the next call.
      throw err;
    });
  // Caller's await sees a clean resolution either way.
  return _appendQueue.catch(() => {});
}

// Same backwards scan as readEvents, but filters to type='digest'.
// Used by /digestlog so the user can replay summaries they missed
// (overnight, while travelling, etc.). Returns newest-first.
// `sinceMs` (optional) bounds the scan to digests at or after that
// timestamp; `limit` is always honoured as a hard cap.
export async function readDigests({ chatId, limit = 10, sinceMs = 0 } = {}) {
  if (!config.historyEnabled) return [];
  // Forward stream (oldest→newest) keeping only the newest `limit`
  // matches in a sliding window, so memory stays bounded no matter how
  // big the file is. Returns newest-first to preserve the old contract.
  const window = [];
  await streamLines(config.historyFile, (line) => {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    if (evt.type !== 'digest') return;
    if (chatId != null && String(evt.chatId) !== String(chatId)) return;
    if (sinceMs && evt.ts < sinceMs) return; // older than the window
    window.push(evt);
    if (window.length > limit) window.shift();
  });
  window.reverse();
  return window;
}

// Tail the file for the last N events matching a filter. Reads the
// whole file then walks backwards — fine for the 14-day default; if
// the file ever gets huge consider an indexed format. limit is a hard
// cap so we don't blow Telegram's message length.
export async function readEvents({ chatId, marketId, limit = 50 } = {}) {
  if (!config.historyEnabled) return [];
  // Same bounded forward-stream as readDigests; keep newest `limit` and
  // return newest-first.
  const window = [];
  await streamLines(config.historyFile, (line) => {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    if (chatId != null && String(evt.chatId) !== String(chatId)) return;
    if (marketId != null && String(evt.marketId) !== String(marketId)) return;
    window.push(evt);
    if (window.length > limit) window.shift();
  });
  window.reverse();
  return window;
}

export async function fileStats() {
  if (!config.historyEnabled) return { size: 0, mtimeMs: 0, exists: false };
  try {
    const st = await fs.stat(config.historyFile);
    return { size: st.size, mtimeMs: st.mtimeMs, exists: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { size: 0, mtimeMs: 0, exists: false };
    throw err;
  }
}

export async function readWholeFile() {
  if (!config.historyEnabled) return null;
  try {
    return await fs.readFile(config.historyFile);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

let _lastPruneAt = 0;

// Prune entries older than HISTORY_KEEP_DAYS. Capped to once per 24h
// to keep cold-start cheap; can be invoked manually via the prune-
// history script for forced compaction.
export async function maybePrune() {
  if (!config.historyEnabled) return;
  if (!config.historyKeepDays || config.historyKeepDays <= 0) return;
  if (Date.now() - _lastPruneAt < 24 * 3600 * 1000) return;
  _lastPruneAt = Date.now();
  return forcePrune();
}

export async function forcePrune() {
  if (!config.historyEnabled) return { kept: 0, dropped: 0 };
  const cutoff = Date.now() - (config.historyKeepDays || 14) * 86_400_000;
  // Stream read → stream write so a multi-hundred-MB log is rewritten
  // without ever materialising it in memory (the old readFile('utf8')
  // path threw "Invalid string length" once the file got big enough,
  // which is exactly what let it keep growing).
  const tmp = `${config.historyFile}.tmp`;
  const out = createWriteStream(tmp);
  let kept = 0;
  let dropped = 0;
  let streamed;
  try {
    streamed = await streamLines(config.historyFile, async (line) => {
      let ts;
      try { ts = JSON.parse(line).ts; } catch { dropped += 1; return; }
      if (ts >= cutoff) {
        kept += 1;
        // Honour backpressure: if the kernel buffer is full, wait for
        // 'drain' before queueing more so memory stays bounded.
        if (!out.write(line + '\n')) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
      } else {
        dropped += 1;
      }
    });
  } catch (err) {
    out.destroy();
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  if (streamed === false) {
    // Source file didn't exist — nothing to prune; drop the empty temp.
    await fs.rm(tmp, { force: true }).catch(() => {});
    return { kept: 0, dropped: 0 };
  }
  await fs.rename(tmp, config.historyFile);
  console.log(new Date().toISOString(), `[history] pruned: kept ${kept}, dropped ${dropped}`);
  return { kept, dropped };
}
