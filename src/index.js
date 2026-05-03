import { config, requireConfig } from './config.js';
import { getUpdates, sendMessage, answerCallbackQuery, setMyCommands, getMe, htmlEscape } from './telegram.js';
import {
  loadState, saveState, getState,
  addSubscription, removeSubscription, listSubscriptionsForChat,
  putPendingChoice, takePendingChoice, gcPendingChoices,
} from './state.js';
import { extractSlugFromUrl, resolveSlugToMarkets, getMarketById } from './predict.js';
import { startMonitorLoop } from './monitor.js';

requireConfig();

const HELP = [
  '👋 <b>Predict.fun 订单簿监控机器人</b>',
  '',
  '直接发送一个 Predict.fun 网址（事件页或单个市场页都行），我会识别页面里的所有市场卡片，让你选择要监控哪一个。被选中的市场只要订单簿（最佳买/卖、深度）发生变化就会推送给你。',
  '',
  '<b>命令</b>',
  '/start, /help — 显示此帮助',
  '/list — 当前订阅的市场',
  '/stop &lt;marketId&gt; — 取消订阅',
  '/stopall — 取消全部订阅',
  '',
  '<b>用法示例</b>',
  '<code>https://predict.fun/event/xxxx</code>',
  '<code>https://predict.fun/zh-cn/market/yyyy</code>',
].join('\n');

function shortToken() {
  return Math.random().toString(36).slice(2, 8);
}

function buildChoiceKeyboard(token, matches) {
  const rows = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const label = (m.title || m.question || `Market ${m.id}`).slice(0, 60);
    rows.push([{ text: label, callback_data: `pick:${token}:${i}` }]);
  }
  rows.push([{ text: '✖ 取消', callback_data: `pick:${token}:cancel` }]);
  return { inline_keyboard: rows };
}

async function handleUrl(chatId, text) {
  const slug = extractSlugFromUrl(text);
  if (!slug) {
    await sendMessage(chatId, '❌ 没看出来是 Predict.fun 网址或 slug。直接发完整网址就好，例如 <code>https://predict.fun/event/xxxx</code>。');
    return;
  }
  let matches;
  try {
    matches = await resolveSlugToMarkets(slug);
  } catch (err) {
    await sendMessage(chatId, `❌ 抓取市场列表失败：${htmlEscape(err.message)}`);
    return;
  }
  if (!matches.length) {
    await sendMessage(chatId, [
      `❌ 没匹配到市场（slug=<code>${htmlEscape(slug)}</code>）。`,
      '可能原因：市场已 resolve、slug 拼写不一致、或缓存还没刷新（10 分钟）。',
    ].join('\n'));
    return;
  }
  if (matches.length === 1) {
    const m = matches[0];
    addSubscription({
      chatId,
      marketId: m.id,
      conditionId: m.conditionId,
      title: m.title || m.question || `Market ${m.id}`,
      slug: m.slug,
    });
    await saveState();
    await sendMessage(chatId, `✅ 已订阅 <b>${htmlEscape(m.title || m.question || m.id)}</b>\n<code>id=${m.id}</code>\n订单簿一旦变动会立刻推送。`);
    return;
  }
  const token = shortToken();
  putPendingChoice(chatId, token, matches);
  await saveState();
  await sendMessage(chatId, [
    `🔎 识别出 <b>${matches.length}</b> 个市场卡片，请选择要监控的：`,
    `<i>（30 分钟内有效）</i>`,
  ].join('\n'), { replyMarkup: buildChoiceKeyboard(token, matches) });
}

async function handleCommand(chatId, text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  const c = cmd.split('@')[0].toLowerCase();
  if (c === '/start' || c === '/help') {
    await sendMessage(chatId, HELP);
    return true;
  }
  if (c === '/list') {
    const subs = listSubscriptionsForChat(chatId);
    if (!subs.length) {
      await sendMessage(chatId, '当前没有订阅。直接发个 Predict.fun 网址就能开始监控。');
      return true;
    }
    const lines = ['<b>当前订阅</b>'];
    for (const s of subs) {
      lines.push(`• <code>${s.marketId}</code> — ${htmlEscape(s.title || '')}`);
    }
    lines.push('', '取消单个：/stop &lt;marketId&gt;\n取消全部：/stopall');
    await sendMessage(chatId, lines.join('\n'));
    return true;
  }
  if (c === '/stop' || /^\/stop_\d+$/.test(c)) {
    let id = args[0];
    if (!id && /^\/stop_\d+$/.test(c)) id = c.slice('/stop_'.length);
    if (!id) {
      await sendMessage(chatId, '用法：/stop &lt;marketId&gt;');
      return true;
    }
    const ok = removeSubscription(chatId, id);
    if (ok) await saveState();
    await sendMessage(chatId, ok ? `✅ 已取消订阅 <code>${htmlEscape(id)}</code>` : `❌ 没有订阅 <code>${htmlEscape(id)}</code>`);
    return true;
  }
  if (c === '/stopall') {
    const subs = listSubscriptionsForChat(chatId);
    for (const s of subs) removeSubscription(chatId, s.marketId);
    await saveState();
    await sendMessage(chatId, `✅ 已取消全部订阅（${subs.length} 个）`);
    return true;
  }
  return false;
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text ?? '').trim();
  if (!chatId || !text) return;
  if (text.startsWith('/')) {
    const handled = await handleCommand(chatId, text);
    if (!handled) await sendMessage(chatId, '未识别的命令。/help 查看可用命令。');
    return;
  }
  // Treat any non-command message as a URL/slug attempt.
  await handleUrl(chatId, text);
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data ?? '';
  if (!chatId) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const m = data.match(/^pick:([a-z0-9]+):(.+)$/);
  if (!m) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const token = m[1];
  const choice = m[2];
  if (choice === 'cancel') {
    await answerCallbackQuery(cb.id, { text: '已取消' });
    return;
  }
  const idx = Number(choice);
  const matches = takePendingChoice(chatId, token);
  if (!matches) {
    await answerCallbackQuery(cb.id, { text: '选项已过期，请重新发送网址', showAlert: true });
    return;
  }
  const pick = matches[idx];
  if (!pick) {
    await answerCallbackQuery(cb.id, { text: '无效选项', showAlert: true });
    return;
  }
  addSubscription({
    chatId,
    marketId: pick.id,
    conditionId: pick.conditionId,
    title: pick.title || pick.question || `Market ${pick.id}`,
    slug: pick.slug,
  });
  await saveState();
  await answerCallbackQuery(cb.id, { text: '✅ 已订阅' });
  await sendMessage(chatId, [
    `✅ 已订阅 <b>${htmlEscape(pick.title || pick.question || pick.id)}</b>`,
    `<code>id=${pick.id}</code>`,
    '订单簿一旦变动会立刻推送。',
  ].join('\n'));
}

async function pollUpdates(signal) {
  const state = getState();
  let offset = state.telegramOffset || 0;
  console.log(new Date().toISOString(), '[telegram] starting long-poll from offset', offset);
  while (!signal.aborted) {
    let updates;
    try {
      updates = await getUpdates({ offset, timeoutSec: 25, signal });
    } catch (err) {
      if (signal.aborted) break;
      console.warn(new Date().toISOString(), '[telegram] getUpdates failed:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      try {
        if (u.message) await handleMessage(u.message);
        else if (u.callback_query) await handleCallback(u.callback_query);
      } catch (err) {
        console.error(new Date().toISOString(), '[telegram] handler error:', err.stack || err.message);
      }
    }
    if (offset !== state.telegramOffset) {
      state.telegramOffset = offset;
      await saveState();
    }
    gcPendingChoices();
  }
}

async function main() {
  await loadState();
  const me = await getMe();
  console.log(new Date().toISOString(), `[bot] logged in as @${me.username}`);
  await setMyCommands([
    { command: 'start', description: '欢迎信息和用法' },
    { command: 'help', description: '帮助' },
    { command: 'list', description: '当前订阅' },
    { command: 'stop', description: '取消单个订阅' },
    { command: 'stopall', description: '取消全部订阅' },
  ]).catch((e) => console.warn('[bot] setMyCommands failed:', e.message));

  const ctrl = new AbortController();
  const shutdown = (sig) => () => {
    console.log(`[bot] ${sig} received, shutting down…`);
    ctrl.abort();
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  await Promise.all([
    pollUpdates(ctrl.signal),
    startMonitorLoop({ signal: ctrl.signal }),
  ]);
  await saveState();
  console.log('[bot] bye');
}

main().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
