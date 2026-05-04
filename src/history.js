import fs from 'node:fs/promises';
import { config } from './config.js';

// Append-only JSONL log of every notification we send. One line per
// event; cheap to write, easy to grep, easy to ship off-box. On Railway
// point HISTORY_FILE at /data/history.jsonl so it survives redeploys.

let _appendQueue = Promise.resolve();

export async function appendEvent(evt) {
  if (!config.historyEnabled) return;
  const line = JSON.stringify({ ts: Date.now(), ...evt }) + '\n';
  // Serialize appends so concurrent ticks don't interleave bytes
  // mid-line. fs.appendFile is atomic per-call on most platforms but
  // chaining keeps that property even under busy schedulers.
  _appendQueue = _appendQueue.then(() => fs.appendFile(config.historyFile, line));
  return _appendQueue.catch((err) => {
    console.warn(new Date().toISOString(), '[history] append failed:', err.message);
  });
}

// Tail the file for the last N events matching a filter. Reads the
// whole file then walks backwards — fine for the 14-day default; if
// the file ever gets huge consider an indexed format. limit is a hard
// cap so we don't blow Telegram's message length.
export async function readEvents({ chatId, marketId, limit = 50 } = {}) {
  if (!config.historyEnabled) return [];
  let raw;
  try {
    raw = await fs.readFile(config.historyFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line) continue;
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
