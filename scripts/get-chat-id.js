// Run once to find your TELEGRAM_CHAT_ID. After starting the script,
// send any message to your bot in the chat you want to use; the script
// prints {chat_id, type, title} for each new update.
import { config, requireConfig } from '../src/config.js';
import { getUpdates } from '../src/telegram.js';

requireConfig();

let offset = 0;
console.log('Listening for messages… send any text to your bot now.');
const ctrl = new AbortController();
process.on('SIGINT', () => ctrl.abort());

while (!ctrl.signal.aborted) {
  try {
    const updates = await getUpdates({ offset, timeoutSec: 25, signal: ctrl.signal });
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const chat = u.message?.chat ?? u.callback_query?.message?.chat ?? u.my_chat_member?.chat;
      if (chat) {
        console.log(JSON.stringify({
          chat_id: chat.id,
          type: chat.type,
          title: chat.title ?? chat.username ?? chat.first_name ?? null,
        }));
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted) break;
    console.warn('error:', err.message);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
