import { config } from './config.js';
import { fetchJson } from './http.js';

export function htmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Telegram caps text at 4096 chars (entity-resolved length). 3800 leaves
// headroom for HTML entities + the ellipsis marker on hard splits.
const TELEGRAM_MAX = 3800;

function tgUrl(method) {
  return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
}

// Strip the bot token from any string before logging or surfacing as
// an error. Without this an upstream HTTP error like "HTTP 502 https://
// api.telegram.org/bot12345:ABCDEFGH/sendMessage" would leak the token
// into Railway logs.
export function redactTokens(s) {
  return String(s ?? '').replace(/\/bot[^/?\s]+/gi, '/bot<redacted>');
}

// Split a long HTML message on line boundaries so we never cut a tag,
// entity, or <pre> block in half. A line that's individually longer
// than the limit gets a hard slice with an ellipsis (rare; the
// notification flow stays well under).
export function splitHtmlByLines(text, limit = TELEGRAM_MAX) {
  if (text.length <= limit) return [text];
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length <= limit) {
      cur = next;
      continue;
    }
    if (cur) parts.push(cur);
    if (line.length > limit) {
      // Hard-slice an over-long single line. Acceptable to lose a bit
      // here — better than ditching the whole notification.
      for (let i = 0; i < line.length; i += limit - 1) {
        const slice = line.slice(i, i + limit - 1);
        parts.push(i + (limit - 1) < line.length ? slice + '…' : slice);
      }
      cur = '';
    } else {
      cur = line;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// HTML tags that Telegram's parser rejects when a chunk leaves them
// open (or vice versa). Order matters for re-balancing: close inner
// before outer.
const HTML_TAGS_TO_BALANCE = ['code', 'pre', 'b', 'i', 'u', 's'];

function openTagBalance(text, tag) {
  const opens = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g'));
  const closes = text.match(new RegExp(`</${tag}>`, 'g'));
  return Math.max(0, (opens?.length ?? 0) - (closes?.length ?? 0));
}

// Walk adjacent chunk pairs — if a tag is left open at end of chunk N,
// close it there and re-open it at start of chunk N+1. Critical for
// long <pre> blocks (orderbook tables) that straddle a chunk boundary.
export function rebalanceHtmlChunks(chunks) {
  for (let i = 0; i < chunks.length - 1; i++) {
    for (const tag of HTML_TAGS_TO_BALANCE) {
      const bal = openTagBalance(chunks[i], tag);
      if (bal > 0) {
        chunks[i] = chunks[i] + `</${tag}>`.repeat(bal);
        chunks[i + 1] = `<${tag}>`.repeat(bal) + chunks[i + 1];
      }
    }
  }
  return chunks;
}

export async function tgApi(method, payload, { timeoutMs = 15_000, retries = 2 } = {}) {
  try {
    const json = await fetchJson(tgUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs,
      retries,
    });
    if (!json?.ok) {
      throw new Error(`Telegram ${method} not ok: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return json.result;
  } catch (err) {
    // Strip the bot token from any error message before it bubbles
    // out into a logger or user-facing reply.
    err.message = redactTokens(err.message);
    throw err;
  }
}

export async function getUpdates({ offset, timeoutSec = 25, signal } = {}) {
  // Local watchdog: a healthy long-poll returns within ~timeoutSec, so
  // anything past +10s means the connection died mid-flight (half-open
  // TCP, dropped NAT entry, …). Without this abort the await would hang
  // forever and freeze the entire command-processing loop.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 10) * 1000);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    signal.addEventListener('abort', onAbort);
  }
  try {
    const res = await fetch(tgUrl('getUpdates'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`getUpdates ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    if (!json?.ok) throw new Error(`getUpdates not ok: ${JSON.stringify(json).slice(0, 200)}`);
    return json.result;
  } catch (err) {
    err.message = redactTokens(err.message);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function sendMessage(chatId, text, { replyMarkup, replyTo } = {}) {
  const chunks = rebalanceHtmlChunks(splitHtmlByLines(text));
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const payload = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    // reply_to lives on the first chunk (so the thread anchors
    // correctly); reply_markup on the last (so buttons render at the
    // visible bottom of the conversation).
    if (isFirst && replyTo) payload.reply_to_message_id = replyTo;
    if (isLast && replyMarkup) payload.reply_markup = replyMarkup;
    last = await tgApi('sendMessage', payload);
    if (!isLast) await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

export async function editMessageText(chatId, messageId, text, replyMarkup) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgApi('editMessageText', payload);
}

// Upload a small file (e.g. history.jsonl) to a chat. Uses native
// FormData/Blob — no external dep. Telegram caps documents at 50MB.
export async function sendDocument(chatId, { fileName, content, caption, contentType = 'application/octet-stream' }) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) {
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
  }
  const blob = content instanceof Blob ? content : new Blob([content], { type: contentType });
  fd.append('document', blob, fileName);
  const res = await fetch(tgUrl('sendDocument'), { method: 'POST', body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`sendDocument ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`sendDocument bad JSON: ${text.slice(0, 200)}`); }
  if (!json?.ok) throw new Error(`sendDocument not ok: ${JSON.stringify(json).slice(0, 200)}`);
  return json.result;
}

export async function answerCallbackQuery(id, { text, showAlert } = {}) {
  return tgApi('answerCallbackQuery', {
    callback_query_id: id,
    text: text ?? '',
    show_alert: !!showAlert,
  });
}

export async function setMyCommands(commands) {
  return tgApi('setMyCommands', { commands });
}

let cachedMe = null;
export async function getMe() {
  if (!cachedMe) cachedMe = await tgApi('getMe', {});
  return cachedMe;
}
