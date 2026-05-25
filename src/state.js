import fs from 'node:fs/promises';
import path from 'node:path';
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

export function normalizeTriggerMode(mode, chatOverride = null) {
  if (typeof mode === 'string') {
    const m = mode.toLowerCase();
    if (TRIGGER_MODES.includes(m)) return m;
  }
  // Precedence: chat-level default → env default → 'both'. /settings
  // lets users set chatOverride per chat without touching env.
  const candidate = String(chatOverride ?? config.defaultTriggerMode ?? 'both').toLowerCase();
  return TRIGGER_MODES.includes(candidate) ? candidate : 'both';
}

export function normalizeLevels(levels, chatOverride = null) {
  if (Array.isArray(levels)) {
    const set = new Set(levels.filter((l) => ALL_LEVELS.includes(l)));
    return ALL_LEVELS.filter((l) => set.has(l));
  }
  // Precedence: chat-level default → env DEFAULT_LEVELS → ALL_LEVELS.
  const chatDef = Array.isArray(chatOverride) && chatOverride.length
    ? chatOverride.filter((l) => ALL_LEVELS.includes(l))
    : [];
  if (chatDef.length) return ALL_LEVELS.filter((l) => chatDef.includes(l));
  const envDef = (config.defaultLevels ?? []).filter((l) => ALL_LEVELS.includes(l));
  return envDef.length ? ALL_LEVELS.filter((l) => envDef.includes(l)) : [...ALL_LEVELS];
}

function emptyState() {
  return {
    subs: {},
    pendingChoices: {}, pendingNotes: {}, pendingWatch: {},
    pendingPrompt: {}, pendingBulkRetry: {},
    chatSettings: {},
    telegramOffset: 0,
  };
}

let _state = null;
// Save coalescing — concurrent callers all set _dirty; the lone
// _saving worker keeps draining until _dirty stays false. This
// guarantees: (a) the on-disk file is always a valid serialisation
// of some past _state, (b) the LATEST mutation always lands on disk
// before saveState resolves to an empty queue, (c) no two writers
// ever race on the same .tmp filename (each carries pid+ts).
let _saving = false;
let _dirty = false;

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
    if (!_state.pendingPrompt) _state.pendingPrompt = {};
    if (!_state.pendingBulkRetry) _state.pendingBulkRetry = {};
    if (!_state.chatSettings) _state.chatSettings = {};
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
  _dirty = true;
  if (_saving) return; // another caller already in the loop
  _saving = true;
  try {
    while (_dirty) {
      _dirty = false;
      const dir = path.dirname(config.stateFile);
      // mkdir -p in case STATE_FILE points inside an unmounted volume
      // dir (e.g. /data on Railway when the volume hasn't attached
      // yet); avoids the very first save crashing on ENOENT.
      try { await fs.mkdir(dir, { recursive: true }); } catch { /* root or already exists */ }
      // Unique tmp filename per write attempt — protects against the
      // tiny window where two saves race (different processes / two
      // event-loop turns within the same process).
      const tmp = `${config.stateFile}.${process.pid}.${Date.now()}.tmp`;
      const payload = JSON.stringify(_state, null, 2);
      await fs.writeFile(tmp, payload);
      await fs.rename(tmp, config.stateFile);
    }
  } finally {
    _saving = false;
  }
}

export function subKey(chatId, marketId) {
  return `${chatId}:${marketId}`;
}

export function addSubscription(sub) {
  const k = subKey(sub.chatId, sub.marketId);
  const existing = _state.subs[k];
  // Pull chat-level defaults so a new sub follows whatever the user
  // set via /settings; existing subs keep their own saved values.
  const cs = _state.chatSettings?.[String(sub.chatId)] ?? {};
  _state.subs[k] = {
    ...sub,
    levels: normalizeLevels(sub.levels ?? existing?.levels, cs.defaultLevels ?? null),
    note: sub.note ?? existing?.note ?? null,
    triggerMode: normalizeTriggerMode(sub.triggerMode ?? existing?.triggerMode, cs.defaultTriggerMode ?? null),
    // Preserve slug if a re-add (e.g. via marketId) doesn't carry one
    // — slug drives the clickable URL in messages.
    slug: sub.slug ?? existing?.slug ?? null,
    conditionId: sub.conditionId ?? existing?.conditionId ?? null,
    // Predict.fun event markets carry both `title` (option name like
    // "Jannik Sinner") and `question` (event question like "Madrid Open
    // 2026 winner"). Store both so the alert can show the full context.
    question: sub.question ?? existing?.question ?? null,
    addedAt: existing?.addedAt ?? Date.now(),
  };
  // Apply per-chat default cooldown to new subs only — existing subs
  // keep whatever they had (incl. /threshold per-sub override).
  if (!existing && cs.defaultCooldownMs != null && cs.defaultCooldownMs > 0) {
    _state.subs[k].thresholds = {
      ..._state.subs[k].thresholds,
      notifyCooldownMs: cs.defaultCooldownMs,
    };
  }
  return k;
}

export function updateSubscriptionTriggerMode(chatId, marketId, mode) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.triggerMode = normalizeTriggerMode(mode);
  return s;
}

// Per-sub baseline snapshot used by /digest for the "vs 上次摘要"
// comparison. Reset on every digest send so each digest reflects
// changes within its own window (not since subscribe time, which is
// what sub.initial is for).
export function setSubscriptionDigestBaseline(chatId, marketId, snapshot) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.digestBaseline = snapshot;
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

// Snapshot of the orderbook at the last time we sent an alert for
// this sub. Persisted so a redeploy/restart doesn't wipe the in-memory
// `lastBookPerSub` baseline and dump a fake "🆕 初次抓取" alert for
// every existing sub on the first post-restart poll.
export function setSubscriptionLastSnap(chatId, marketId, snapshot) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.lastSnap = snapshot;
  return s;
}

// Lazily-filled parent event question (for digest grouping). Subs
// created before the `question` field shipped get this populated on
// the next poll from the cached market record.
export function setSubscriptionQuestion(chatId, marketId, question) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  s.question = question || null;
  return s;
}

// Per-sub pause window. untilMs=null clears the pause; otherwise stores
// a UTC ms timestamp after which the sub auto-resumes (monitor.js does
// the resume-check on every tick so no scheduler is needed).
// Per-sub threshold override. Pass null to clear (revert to env
// defaults). Persisted shape:
//   sub.thresholds = { priceEpsilon, sizeRelativeEpsilon,
//                      sizeAbsoluteMin, notifyCooldownMs }
//   any field can be null/missing → fall back to env in monitor.js.
export function setSubscriptionThresholds(chatId, marketId, thresholds) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  if (thresholds == null) {
    delete s.thresholds;
  } else {
    s.thresholds = {
      priceEpsilon: thresholds.priceEpsilon ?? null,
      sizeRelativeEpsilon: thresholds.sizeRelativeEpsilon ?? null,
      sizeAbsoluteMin: thresholds.sizeAbsoluteMin ?? null,
      notifyCooldownMs: thresholds.notifyCooldownMs ?? null,
    };
  }
  return s;
}

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

// Pull #tags out of the note text. "#主仓 #BTC 套利目标 0.45" →
// { note: "套利目标 0.45", tags: ["主仓", "BTC"] }. Single source of
// truth — user types one string; /list #tag filters on the parsed tag
// list. Dedup case-sensitively (so "#BTC" and "#btc" stay separate;
// tag matching at read time normalises case).
export function parseNoteText(raw) {
  if (!raw) return { note: '', tags: [] };
  const tags = [];
  const stripped = String(raw)
    .replace(/(?:^|\s)#([^\s#]+)/g, (_, tag) => { tags.push(tag); return ' '; })
    .replace(/\s+/g, ' ')
    .trim();
  const seen = new Set();
  const unique = [];
  for (const t of tags) {
    if (!seen.has(t)) { seen.add(t); unique.push(t); }
  }
  return { note: stripped, tags: unique };
}

export function updateSubscriptionNote(chatId, marketId, note) {
  const s = _state.subs[subKey(chatId, marketId)];
  if (!s) return null;
  const trimmed = (note ?? '').toString().trim();
  if (!trimmed.length) {
    s.note = null;
    s.tags = [];
    return s;
  }
  const { note: cleanNote, tags } = parseNoteText(trimmed);
  s.note = cleanNote.length ? cleanNote.slice(0, 200) : null;
  s.tags = tags.slice(0, 16); // cap to keep state file size predictable
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

// Generic ForceReply target-prompt tracker. Used by commands that
// need a marketId / URL / slug as their target (e.g. /stats /history
// /probe /threshold /levels). When the user replies to the bot's
// prompt the message handler reads cmd/args from here and dispatches
// to the right handler with the resolved marketId.
const PROMPT_TTL_MS = 30 * 60 * 1000;
export function putPendingPrompt(chatId, promptMessageId, cmd, args = {}) {
  if (!_state.pendingPrompt) _state.pendingPrompt = {};
  _state.pendingPrompt[`${chatId}:${promptMessageId}`] = {
    cmd, args, expiresAt: Date.now() + PROMPT_TTL_MS,
  };
}
export function takePendingPrompt(chatId, promptMessageId) {
  const k = `${chatId}:${promptMessageId}`;
  const e = _state.pendingPrompt?.[k];
  if (!e) return null;
  delete _state.pendingPrompt[k];
  if (e.expiresAt < Date.now()) return null;
  return e;
}
export function gcPendingPrompts() {
  const now = Date.now();
  for (const [k, v] of Object.entries(_state.pendingPrompt ?? {})) {
    if (!v?.expiresAt || v.expiresAt < now) delete _state.pendingPrompt[k];
  }
}

export function gcPendingWatch() {
  const now = Date.now();
  for (const [k, v] of Object.entries(_state.pendingWatch)) {
    if (!v?.expiresAt || v.expiresAt < now) delete _state.pendingWatch[k];
  }
}

// Per-chat preferences. Today: digest interval. Stored as
// chatSettings[chatId] = { digestIntervalMs, digestLastSentAt }.
// Empty / missing chatSettings → digest disabled.
export function getChatSettings(chatId) {
  return _state.chatSettings?.[String(chatId)] ?? null;
}

export function getAllChatSettings() {
  return _state.chatSettings ?? {};
}

export function setChatDigest(chatId, intervalMs) {
  if (!_state.chatSettings) _state.chatSettings = {};
  const k = String(chatId);
  const cur = _state.chatSettings[k] ?? {};
  if (intervalMs > 0) {
    cur.digestIntervalMs = intervalMs;
    // Reset the clock so the FIRST digest fires intervalMs from now,
    // not immediately on the next tick (which would feel jumpy).
    cur.digestLastSentAt = Date.now();
  } else {
    cur.digestIntervalMs = 0;
  }
  _state.chatSettings[k] = cur;
  return cur;
}

// Chat-level defaults that override env DEFAULT_* on new subs only.
// Existing subs keep whatever was saved at their creation time.
export function setChatDefaultLevels(chatId, levels) {
  if (!_state.chatSettings) _state.chatSettings = {};
  const k = String(chatId);
  if (!_state.chatSettings[k]) _state.chatSettings[k] = {};
  if (!levels || !levels.length) {
    delete _state.chatSettings[k].defaultLevels;
  } else {
    _state.chatSettings[k].defaultLevels = levels.filter((l) => ALL_LEVELS.includes(l));
  }
  return _state.chatSettings[k];
}

export function setChatDefaultTriggerMode(chatId, mode) {
  if (!_state.chatSettings) _state.chatSettings = {};
  const k = String(chatId);
  if (!_state.chatSettings[k]) _state.chatSettings[k] = {};
  if (mode == null) {
    delete _state.chatSettings[k].defaultTriggerMode;
  } else {
    const m = String(mode).toLowerCase();
    if (TRIGGER_MODES.includes(m)) _state.chatSettings[k].defaultTriggerMode = m;
  }
  return _state.chatSettings[k];
}

export function setChatDefaultCooldown(chatId, ms) {
  if (!_state.chatSettings) _state.chatSettings = {};
  const k = String(chatId);
  if (!_state.chatSettings[k]) _state.chatSettings[k] = {};
  if (ms == null || ms <= 0) {
    delete _state.chatSettings[k].defaultCooldownMs;
  } else {
    _state.chatSettings[k].defaultCooldownMs = ms;
  }
  return _state.chatSettings[k];
}

// Bulk-retry token: caches the failed lines of a /watch batch so the
// "🔁 重试失败项" button on the result message can re-run them
// without the user re-typing.
const BULK_RETRY_TTL = 30 * 60 * 1000;
export function putPendingBulkRetry(chatId, token, lines) {
  if (!_state.pendingBulkRetry) _state.pendingBulkRetry = {};
  _state.pendingBulkRetry[`${chatId}:${token}`] = {
    lines: Array.from(lines),
    expiresAt: Date.now() + BULK_RETRY_TTL,
  };
}
export function takePendingBulkRetry(chatId, token) {
  const k = `${chatId}:${token}`;
  const e = _state.pendingBulkRetry?.[k];
  if (!e) return null;
  delete _state.pendingBulkRetry[k];
  if (e.expiresAt < Date.now()) return null;
  return e.lines;
}
export function gcPendingBulkRetry() {
  const now = Date.now();
  for (const [k, v] of Object.entries(_state.pendingBulkRetry ?? {})) {
    if (!v?.expiresAt || v.expiresAt < now) delete _state.pendingBulkRetry[k];
  }
}

// Quiet hours (do-not-disturb). Stored as minutes-of-day (0..1439)
// in the displayTz. Crossing-midnight windows allowed (start>end).
// null in either field = disabled.
export function setChatQuiet(chatId, startMin, endMin) {
  if (!_state.chatSettings) _state.chatSettings = {};
  const k = String(chatId);
  if (!_state.chatSettings[k]) _state.chatSettings[k] = {};
  if (startMin == null || endMin == null) {
    delete _state.chatSettings[k].quietStartMin;
    delete _state.chatSettings[k].quietEndMin;
  } else {
    _state.chatSettings[k].quietStartMin = ((startMin % 1440) + 1440) % 1440;
    _state.chatSettings[k].quietEndMin = ((endMin % 1440) + 1440) % 1440;
  }
  return _state.chatSettings[k];
}

// Digest-only mode: when true, individual per-tick alerts for this
// chat are silently swallowed (still written to history, still update
// baselines), but the periodic /digest message and any /digestlog
// query still fire normally. Use case: high-volume watcher who only
// wants the rolled-up summary, not per-poll pings.
export function setChatDigestOnly(chatId, on) {
  if (!_state.chatSettings) _state.chatSettings = {};
  const k = String(chatId);
  if (!_state.chatSettings[k]) _state.chatSettings[k] = {};
  if (on) _state.chatSettings[k].digestOnly = true;
  else delete _state.chatSettings[k].digestOnly;
  return _state.chatSettings[k];
}

export function isChatDigestOnly(chatId) {
  return !!_state.chatSettings?.[String(chatId)]?.digestOnly;
}

export function isChatInQuietHours(chatId, ms = Date.now()) {
  const s = _state.chatSettings?.[String(chatId)];
  if (!s || s.quietStartMin == null || s.quietEndMin == null) return false;
  const start = s.quietStartMin, end = s.quietEndMin;
  if (start === end) return false;
  // Current minute-of-day in the configured timezone.
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.displayTz,
      hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = fmt.formatToParts(new Date(ms));
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const cur = h * 60 + m;
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end; // crosses midnight
  } catch {
    return false;
  }
}

export function markChatDigestSent(chatId, atMs = Date.now()) {
  if (!_state.chatSettings) _state.chatSettings = {};
  const k = String(chatId);
  if (!_state.chatSettings[k]) _state.chatSettings[k] = {};
  _state.chatSettings[k].digestLastSentAt = atMs;
}
