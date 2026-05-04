import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Append-only JSONL log of every notification we successfully send.
// Each line: { ts, chatId, marketId, title, note, levels, summary, snap }
// snap is the orderbook snapshot at notify time (top-3 bids/asks).
//
// We cap at config.historyMax records by rewriting the file when it
// grows past 1.25× the cap (amortized O(1)). Reads load the whole
// file — fine for the default 5k cap, ~1MB.

let _writeChain = Promise.resolve();
let _trimSinceCheck = 0;

function snapTop3(snap) {
  if (!snap) return null;
  const top = (arr) => (arr ?? []).slice(0, 3).map((l) => ({
    price: l.price, size: l.size,
  }));
  return { bids: top(snap.bids), asks: top(snap.asks) };
}

export function appendHistory(record) {
  if (!config.historyFile) return Promise.resolve();
  const line = JSON.stringify({
    ts: record.ts ?? Date.now(),
    chatId: String(record.chatId),
    marketId: String(record.marketId),
    title: record.title ?? null,
    note: record.note ?? null,
    levels: record.levels ?? [],
    summary: record.summary ?? '',
    snap: snapTop3(record.snap),
  }) + '\n';
  _writeChain = _writeChain.then(async () => {
    try {
      await fs.mkdir(path.dirname(config.historyFile), { recursive: true });
      await fs.appendFile(config.historyFile, line);
      _trimSinceCheck += 1;
      if (_trimSinceCheck >= 100) {
        _trimSinceCheck = 0;
        await maybeTrim();
      }
    } catch (err) {
      console.warn(new Date().toISOString(), '[history] append failed:', err.message);
    }
  });
  return _writeChain;
}

async function maybeTrim() {
  const cap = config.historyMax;
  if (!cap || cap <= 0) return;
  let text;
  try {
    text = await fs.readFile(config.historyFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= Math.floor(cap * 1.25)) return;
  const kept = lines.slice(-cap);
  const tmp = `${config.historyFile}.tmp`;
  await fs.writeFile(tmp, kept.join('\n') + '\n');
  await fs.rename(tmp, config.historyFile);
}

export async function readHistory({ chatId, marketId, limit = 20 } = {}) {
  if (!config.historyFile) return [];
  let text;
  try {
    text = await fs.readFile(config.historyFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const raw = lines[i];
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (chatId != null && String(rec.chatId) !== String(chatId)) continue;
    if (marketId != null && String(rec.marketId) !== String(marketId)) continue;
    out.push(rec);
  }
  return out;
}
