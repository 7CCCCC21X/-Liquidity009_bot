import fs from 'node:fs/promises';
import { config } from './config.js';

// Shape:
// {
//   subs: { "<chatId>:<marketId>": { chatId, marketId, conditionId, title, slug, addedAt } },
//   pendingChoices: { "<chatId>:<token>": { matches: [...], expiresAt } },
//   telegramOffset: number
// }

function emptyState() {
  return { subs: {}, pendingChoices: {}, telegramOffset: 0 };
}

let _state = null;
let _saveQueued = false;

export async function loadState() {
  if (_state) return _state;
  try {
    const text = await fs.readFile(config.stateFile, 'utf8');
    const json = JSON.parse(text);
    _state = { ...emptyState(), ...(json && typeof json === 'object' ? json : {}) };
    if (!_state.subs) _state.subs = {};
    if (!_state.pendingChoices) _state.pendingChoices = {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(new Date().toISOString(), '[state] load failed:', err.message);
    _state = emptyState();
  }
  return _state;
}

export function getState() {
  if (!_state) throw new Error('state not loaded');
  return _state;
}

export async function saveState() {
  if (!_state) return;
  if (_saveQueued) return;
  _saveQueued = true;
  await new Promise((r) => setImmediate(r));
  _saveQueued = false;
  const tmp = `${config.stateFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(_state, null, 2));
  await fs.rename(tmp, config.stateFile);
}

export function subKey(chatId, marketId) {
  return `${chatId}:${marketId}`;
}

export function addSubscription(sub) {
  const k = subKey(sub.chatId, sub.marketId);
  _state.subs[k] = { ...sub, addedAt: Date.now() };
  return k;
}

export function removeSubscription(chatId, marketId) {
  const k = subKey(chatId, marketId);
  if (!_state.subs[k]) return false;
  delete _state.subs[k];
  return true;
}

export function listSubscriptionsForChat(chatId) {
  return Object.values(_state.subs).filter((s) => String(s.chatId) === String(chatId));
}

export function listAllSubscriptions() {
  return Object.values(_state.subs);
}

// Pending market-choice batches. Stored keyed by a short token so callback
// data stays under Telegram's 64-byte limit. Auto-expire after 30 min.
const CHOICE_TTL_MS = 30 * 60 * 1000;

export function putPendingChoice(chatId, token, matches) {
  const k = `${chatId}:${token}`;
  _state.pendingChoices[k] = { matches, expiresAt: Date.now() + CHOICE_TTL_MS };
}

export function takePendingChoice(chatId, token) {
  const k = `${chatId}:${token}`;
  const entry = _state.pendingChoices[k];
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    delete _state.pendingChoices[k];
    return null;
  }
  return entry.matches;
}

export function gcPendingChoices() {
  const now = Date.now();
  for (const [k, v] of Object.entries(_state.pendingChoices)) {
    if (!v?.expiresAt || v.expiresAt < now) delete _state.pendingChoices[k];
  }
}
