import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

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

// Stream the file's lines newest-first WITHOUT loading the whole file
// into memory. Reads fixed 64KiB chunks from the tail; the partial
// line at each chunk's head is carried as raw bytes (never decoded
// mid-chunk) so multi-byte UTF-8 sequences that straddle a boundary
// stay intact — '\n' is a single byte in UTF-8 and can't appear inside
// a multi-byte sequence, so splitting the buffer on 0x0A is safe.
// Exported for tests.
export async function* iterLinesBackwards(file, chunkSize = 64 * 1024) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  try {
    const stat = await fh.stat();
    let pos = stat.size;
    let carry = Buffer.alloc(0); // bytes of the (possibly partial) earliest line seen so far
    const buf = Buffer.alloc(chunkSize);
    while (pos > 0) {
      const readLen = Math.min(chunkSize, pos);
      pos -= readLen;
      await fh.read(buf, 0, readLen, pos);
      // Buffer.concat copies, so reusing `buf` next iteration is safe.
      const chunk = Buffer.concat([buf.subarray(0, readLen), carry]);
      // Walk newline positions back-to-front, yielding complete lines.
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue;
        if (i + 1 < end) yield chunk.toString('utf8', i + 1, end);
        end = i;
      }
      carry = Buffer.from(chunk.subarray(0, end));
    }
    if (carry.length) yield carry.toString('utf8');
  } finally {
    await fh.close();
  }
}

// Same backwards scan as readEvents, but filters to type='digest'.
// Used by /digestlog so the user can replay summaries they missed
// (overnight, while travelling, etc.). Returns newest-first.
// `sinceMs` (optional) bounds the scan to digests at or after that
// timestamp; `limit` is always honoured as a hard cap.
export async function readDigests({ chatId, limit = 10, sinceMs = 0 } = {}) {
  if (!config.historyEnabled) return [];
  const out = [];
  for await (const line of iterLinesBackwards(config.historyFile)) {
    if (out.length >= limit) break;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type !== 'digest') continue;
    if (chatId != null && String(evt.chatId) !== String(chatId)) continue;
    if (sinceMs && evt.ts < sinceMs) break; // walking backwards in time
    out.push(evt);
  }
  return out;
}

// Tail the file for the last N events matching a filter. Streams the
// file backwards and stops as soon as `limit` matches are collected,
// so cost scales with how far back the matches are — not file size.
export async function readEvents({ chatId, marketId, limit = 50 } = {}) {
  if (!config.historyEnabled) return [];
  const out = [];
  for await (const line of iterLinesBackwards(config.historyFile)) {
    if (out.length >= limit) break;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (chatId != null && String(evt.chatId) !== String(chatId)) continue;
    if (marketId != null && String(evt.marketId) !== String(marketId)) continue;
    out.push(evt);
  }
  return out;
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
  let raw;
  try {
    raw = await fs.readFile(config.historyFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { kept: 0, dropped: 0 };
    throw err;
  }
  const kept = [];
  let dropped = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.ts >= cutoff) kept.push(line);
      else dropped += 1;
    } catch {
      dropped += 1;
    }
  }
  const tmp = `${config.historyFile}.tmp`;
  await fs.writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '');
  await fs.rename(tmp, config.historyFile);
  console.log(new Date().toISOString(), `[history] pruned: kept ${kept.length}, dropped ${dropped}`);
  return { kept: kept.length, dropped };
}
