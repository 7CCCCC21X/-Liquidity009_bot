import { config } from './config.js';
import { fetchJson } from './http.js';

export function htmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const TELEGRAM_MAX = 3900;

function tgUrl(method) {
  return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
}

export async function tgApi(method, payload, { timeoutMs = 15_000, retries = 2 } = {}) {
  const json = await fetchJson(tgUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs,
    retries,
  });
  if (!json?.ok) throw new Error(`Telegram ${method} not ok: ${JSON.stringify(json).slice(0, 200)}`);
  return json.result;
}

export async function getUpdates({ offset, timeoutSec = 25, signal } = {}) {
  const res = await fetch(tgUrl('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`getUpdates ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (!json?.ok) throw new Error(`getUpdates not ok: ${JSON.stringify(json).slice(0, 200)}`);
  return json.result;
}

export async function sendMessage(chatId, text, { replyMarkup, replyTo } = {}) {
  const payload = {
    chat_id: chatId,
    text: text.length > TELEGRAM_MAX ? text.slice(0, TELEGRAM_MAX - 1) + '…' : text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyTo) payload.reply_to_message_id = replyTo;
  return tgApi('sendMessage', payload);
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
