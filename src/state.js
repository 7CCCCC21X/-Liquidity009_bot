import fs from 'node:fs/promises';
import { config } from './config.js';

// Shape:
// {
//   subs: { "<chatId>:<marketId>": { chatId, marketId, conditionId, title, slug, levels, note, addedAt } },
//   pendingChoices: { "<chatId>:<token>": { matches: [...], expiresAt } },
//   pendingNotes:   { "<chatId>:<promptMessageId>": { marketId, expiresAt } },
//   pendingWatch:   { "<chatId>:<promptMessageId>": { expiresAt } },
//   telegramOffset: number
// }
// levels: array picked from ALL_LEVELS — empty array means "watch nothing"
// (sub still tracked for snapshot/list but never alerts).

export const ALL_LEVELS = ['bid1', 'bid2', 'bid3', 'ask1', 'ask2', 'ask3'];

export const LEVEL_LABEL = {
  bid1: '买1', bid2: '买2', bid3: '买3',
  ask1: '卖1', ask2: '卖2', ask3: '卖3',
};

// Per-subscription trigger condition. Default 'both' = alert on price
// OR size change (legacy behavior). 'price' / 'size' suppress the
// other half so the user can mute one signal entirely.
export const TRIGGER_MODES = ['both', 'price', 'size'];
export const TRIGGER_LABEL = { both: '价+量', price: '只看价', size: '只看量' };

export function normalizeTriggerMode(mode) {
  if (typeof mode === 'string') {
    const m = mode.toLowerCase();
    if (TRIGGER_MODES.includes(m)) return m;
  }
  // Fall back to env-configured default (e.g. 'price'); guard against a
  // typo in DEFAULT_TRIGGER_MODE by checking the allowed set.
  const def = String(config.defaultTriggerMode ?? 'both').toLowerCase();
  return TRIGGER_MODES.includes(def) ? def : 'both';
}

export function normalizeLevels(levels) {
  if (Array.isArray(levels)) {
    const set = new Set(levels.filter((l) => ALL_LEVELS.includes(l)));
    return ALL_LEVELS.filter((l) => set.has(l));
  }
  // Fall back to env-configured DEFAULT_LEVELS; ALL_LEVELS if env
  // produced an empty / invalid list.
  const def = (config.defaultLevels ?? []).filter((l) => ALL_LEVELS.includes(l));
  return def.length ? ALL_LEVELS.filter((l) => def.includes(l)) : [...ALL_LEVELS];
}

function emptyState() {
  return { subs: {}, pendingChoices: {}, pendingNotes: {}, pendingWatch: {}, telegramOffset: 0 };
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
    if (!_state.pendingNotes) _state.pendingNotes = {};
    if (!_state.pendingWatch) _state.pendingWatch = {};
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
  const existing = _state.subs[k];
  _state.subs[k] = {
    ...sub,
    levels: normalizeLevels(sub.levels ?? existing?.levels),
    note: sub.note ?? existing?.note ?? null,
    triggerMode: normalizeTriggerMode(sub.triggerMode ?? existing?.triggerMode),
    // Preserve slug if a re-add (e.g. via marketId) doesn't carry one
    // — slug drives the clickable URL in messages.
    slug: sub.slug ?? existing?.slug ?? null,
    conditionId: sub.conditionId ?? existing?.conditionId ?? null,
    addedAt: existing?.addedAt ?? Date.now(),
  };
  return k;
}

export function updateSubscriptionTriggerMode(chatId, marketId, mode) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.triggerMode = normalizeTriggerMode(mode);
  return s;
}

// Snapshot of the orderbook at subscribe time, persisted so the
// notification can show "vs 监控起点" cumulative deltas across restarts.
// Stored on the sub itself so it travels with /list, /export, etc.
export function setSubscriptionInitial(chatId, marketId, snapshot) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.initial = snapshot;
  return s;
}

// Per-sub pause window. untilMs=null clears the pause; otherwise stores
// a UTC ms timestamp after which the sub auto-resumes (monitor.js does
// the resume-check on every tick so no scheduler is needed).
export function setSubscriptionPause(chatId, marketId, untilMs) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.pausedUntil = (typeof untilMs === 'number' && untilMs > Date.now()) ? untilMs : null;
  return s;
}

// Pause every sub in a chat. Returns the count actually changed so the
// caller can render an accurate confirmation.
export function pauseAllForChat(chatId, untilMs) {
  let n = 0;
  for (const s of Object.values(_state.subs)) {
    if (String(s.chatId) !== String(chatId)) continue;
    s.pausedUntil = (typeof untilMs === 'number' && untilMs > Date.now()) ? untilMs : null;
    n += 1;
  }
  return n;
}

export function updateSubscriptionNote(chatId, marketId, note) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  const trimmed = (note ?? '').toString().trim();
  s.note = trimmed.length ? trimmed.slice(0, 200) : null;
  return s;
}

export function getSubscription(chatId, marketId) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  // Backfill defaults for subs created before these fields existed.
  s.levels = normalizeLevels(s.levels);
  s.triggerMode = normalizeTriggerMode(s.triggerMode);
  return s;
}

export function updateSubscriptionLevels(chatId, marketId, levels) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.levels = normalizeLevels(levels);
  return s;
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
  return Object.values(_state.subs).map((s) => {
    s.levels = normalizeLevels(s.levels);
    s.triggerMode = normalizeTriggerMode(s.triggerMode);
    return s;
  });
}

// Pending market-choice batches. Stored keyed by a short token so callback
// data stays under Telegram's 64-byte limit. Auto-expire after 30 min.
const CHOICE_TTL_MS = 30 * 60 * 1000;

export function putPendingChoice(chatId, token, matches, selected = []) {
  const k = `${chatId}:${token}`;
  _state.pendingChoices[k] = {
    matches,
    selected: Array.from(selected ?? []),
    expiresAt: Date.now() + CHOICE_TTL_MS,
  };
}

// Read without consuming — used by toggle/select-all/none flows so
// the entry stays around until "完成" or "取消" finalises it.
export function peekPendingChoice(chatId, token) {
  const k = `${chatId}:${token}`;
  const entry = _state.pendingChoices[k];
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    delete _state.pendingChoices[k];
    return null;
  }
  if (!Array.isArray(entry.selected)) entry.selected = [];
  return entry;
}

export function takePendingChoice(chatId, token) {
  const k = `${chatId}:${token}`;
  const entry = _state.pendingChoices[k];
  if (!entry) return null;
  delete _state.pendingChoices[k];
  if (entry.expiresAt < Date.now()) return null;
  // Backwards compat: callers used to receive the matches array; now
  // they get the full entry { matches, selected }. The legacy callers
  // already destructure entry.matches so this stays compatible.
  if (!Array.isArray(entry.selected)) entry.selected = [];
  return entry;
}

export function gcPendingChoices() {
  const now = Date.now();
  for (const [k, v] of Object.entries(_state.pendingChoices)) {
    if (!v?.expiresAt || v.expiresAt < now) delete _state.pendingChoices[k];
  }
}

// Pending note prompts. Keyed by the bot's prompt-message id (the one
// sent with ForceReply). When the user replies, message.reply_to_message
// .message_id matches this key so we know which marketId the text is for.
const NOTE_TTL_MS = 30 * 60 * 1000;

export function putPendingNote(chatId, promptMessageId, marketId) {
  const k = `${chatId}:${promptMessageId}`;
  _state.pendingNotes[k] = { marketId: String(marketId), expiresAt: Date.now() + NOTE_TTL_MS };
}

export function takePendingNote(chatId, promptMessageId) {
  const k = `${chatId}:${promptMessageId}`;
  const entry = _state.pendingNotes[k];
  if (!entry) return null;
  delete _state.pendingNotes[k];
  if (entry.expiresAt < Date.now()) return null;
  return entry.marketId;
}

export function gcPendingNotes() {
  const now = Date.now();
  for (const [k, v] of Object.entries(_state.pendingNotes)) {
    if (!v?.expiresAt || v.expiresAt < now) delete _state.pendingNotes[k];
  }
}

// /watch ForceReply prompts. Same pattern as pendingNotes — keyed by
// the bot's prompt-message id, gc'd every poll loop.
const WATCH_TTL_MS = 30 * 60 * 1000;

export function putPendingWatch(chatId, promptMessageId) {
  const k = `${chatId}:${promptMessageId}`;
  _state.pendingWatch[k] = { expiresAt: Date.now() + WATCH_TTL_MS };
}

export function takePendingWatch(chatId, promptMessageId) {
  const k = `${chatId}:${promptMessageId}`;
  const entry = _state.pendingWatch[k];
  if (!entry) return false;
  delete _state.pendingWatch[k];
  return entry.expiresAt >= Date.now();
}

export function gcPendingWatch() {
  const now = Date.now();
  for (const [k, v] of Object.entries(_state.pendingWatch)) {
    if (!v?.expiresAt || v.expiresAt < now) delete _state.pendingWatch[k];
  }
}
