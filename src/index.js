import { config, requireConfig } from './config.js';
import { getUpdates, sendMessage, editMessageText, answerCallbackQuery, setMyCommands, getMe, htmlEscape } from './telegram.js';
import {
  loadState, saveState, getState,
  addSubscription, removeSubscription, listSubscriptionsForChat,
  getSubscription, updateSubscriptionLevels,
  putPendingChoice, takePendingChoice, gcPendingChoices,
  ALL_LEVELS, LEVEL_LABEL,
} from './state.js';
import { extractSlugFromUrl, resolveSlugToMarkets, getMarketById } from './predict.js';
import { startMonitorLoop } from './monitor.js';

requireConfig();

const HELP = [
  '👋 <b>Predict.fun 订单簿监控机器人</b>',
  '',
  '直接发送一个 Predict.fun 网址（事件页或单个市场页都行），我会识别页面里的所有市场卡片，让你选择要监控哪一个。被选中的市场只要你关注的档位（买1/2/3、卖1/2/3）发生变化就会推送给你。',
  '',
  '<b>命令</b>',
  '/start, /help — 显示此帮助',
  '/list — 当前订阅的市场',
  '/levels &lt;marketId&gt; — 自定义监控档位（买1/2/3、卖1/2/3）',
  '/stop &lt;marketId&gt; — 取消订阅',
  '/stopall — 取消全部订阅',
  '',
  '<b>用法示例</b>',
  '<code>https://predict.fun/event/xxxx</code>',
  '<code>https://predict.fun/zh-cn/market/yyyy</code>',
].join('\n');

function buildLevelsKeyboard(marketId, levels) {
  const set = new Set(levels);
  const btn = (k) => ({
    text: (set.has(k) ? '✅ ' : '⬜ ') + LEVEL_LABEL[k],
    callback_data: `lvl:${marketId}:t:${k}`,
  });
  return {
    inline_keyboard: [
      [btn('bid1'), btn('ask1')],
      [btn('bid2'), btn('ask2')],
      [btn('bid3'), btn('ask3')],
      [
        { text: '全选', callback_data: `lvl:${marketId}:all` },
        { text: '清空', callback_data: `lvl:${marketId}:none` },
      ],
      [{ text: '✅ 完成', callback_data: `lvl:${marketId}:done` }],
    ],
  };
}

function levelsHeader(sub) {
  const watching = sub.levels?.length
    ? sub.levels.map((l) => LEVEL_LABEL[l]).join('、')
    : '（无 — 不会推送）';
  return [
    `<b>📐 配置监控档位</b>`,
    htmlEscape(sub.title || `Market ${sub.marketId}`),
    `<code>id=${sub.marketId}</code>`,
    '',
    `当前监控：${watching}`,
    '',
    '点按钮切换档位（✅ = 监控，⬜ = 忽略）。',
  ].join('\n');
}

function shortToken() {
  return Math.random().toString(36).slice(2, 8);
}

async function sendSubscribed(chatId, m) {
  const text = [
    `✅ 已订阅 <b>${htmlEscape(m.title || m.question || m.id)}</b>`,
    `<code>id=${m.id}</code>`,
    '默认监控买1/2/3 + 卖1/2/3 全部 6 档。',
    '点下方按钮自定义要看哪几档；订单簿一旦变动立刻推送。',
  ].join('\n');
  const replyMarkup = {
    inline_keyboard: [
      [{ text: '📐 配置档位', callback_data: `lvl:${m.id}:open` }],
      [{ text: '🛑 取消订阅', callback_data: `unsub:${m.id}` }],
    ],
  };
  await sendMessage(chatId, text, { replyMarkup });
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
    await sendSubscribed(chatId, m);
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
      const levels = s.levels?.length ? s.levels.map((l) => LEVEL_LABEL[l]).join('/') : '（无）';
      lines.push(`• <code>${s.marketId}</code> — ${htmlEscape(s.title || '')}\n   档位：${levels}  /levels_${s.marketId}`);
    }
    lines.push('', '改档位：/levels &lt;marketId&gt;\n取消单个：/stop &lt;marketId&gt;\n取消全部：/stopall');
    await sendMessage(chatId, lines.join('\n'));
    return true;
  }
  if (c === '/levels' || /^\/levels_\d+$/.test(c)) {
    let id = args[0];
    if (!id && /^\/levels_\d+$/.test(c)) id = c.slice('/levels_'.length);
    if (!id) {
      await sendMessage(chatId, '用法：/levels &lt;marketId&gt;\n（可以从 /list 里复制 id）');
      return true;
    }
    const sub = getSubscription(chatId, id);
    if (!sub) {
      await sendMessage(chatId, `❌ 没有订阅 <code>${htmlEscape(id)}</code>`);
      return true;
    }
    await sendMessage(chatId, levelsHeader(sub), {
      replyMarkup: buildLevelsKeyboard(sub.marketId, sub.levels),
    });
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
  const messageId = cb.message?.message_id;
  const data = cb.data ?? '';
  if (!chatId) {
    await answerCallbackQuery(cb.id);
    return;
  }

  const lvlMatch = data.match(/^lvl:(\d+):(.+)$/);
  if (lvlMatch) {
    const marketId = lvlMatch[1];
    const action = lvlMatch[2];
    const sub = getSubscription(chatId, marketId);
    if (!sub) {
      await answerCallbackQuery(cb.id, { text: '订阅不存在', showAlert: true });
      return;
    }
    let next = [...(sub.levels ?? ALL_LEVELS)];
    if (action === 'all') next = [...ALL_LEVELS];
    else if (action === 'none') next = [];
    else if (action === 'open') {
      // First-time open from "配置档位" button — just render the keyboard.
    } else if (action === 'done') {
      const summary = sub.levels?.length
        ? sub.levels.map((l) => LEVEL_LABEL[l]).join('、')
        : '（已关闭推送）';
      await answerCallbackQuery(cb.id, { text: '✅ 已保存' });
      try {
        await editMessageText(chatId, messageId, [
          `<b>📐 档位已保存</b>`,
          htmlEscape(sub.title || `Market ${sub.marketId}`),
          `<code>id=${sub.marketId}</code>`,
          ``,
          `监控：${summary}`,
        ].join('\n'));
      } catch { /* edit may fail if message too old; ignore */ }
      return;
    } else if (action.startsWith('t:')) {
      const key = action.slice(2);
      if (!ALL_LEVELS.includes(key)) {
        await answerCallbackQuery(cb.id, { text: '未知档位' });
        return;
      }
      const set = new Set(next);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      next = ALL_LEVELS.filter((l) => set.has(l));
    } else {
      await answerCallbackQuery(cb.id);
      return;
    }
    if (action !== 'open') {
      updateSubscriptionLevels(chatId, marketId, next);
      await saveState();
    }
    const fresh = getSubscription(chatId, marketId);
    await answerCallbackQuery(cb.id, { text: 'OK' });
    try {
      await editMessageText(chatId, messageId, levelsHeader(fresh), buildLevelsKeyboard(marketId, fresh.levels));
    } catch (err) {
      // If edit fails (e.g. opened from a notification message we didn't author), send fresh.
      await sendMessage(chatId, levelsHeader(fresh), { replyMarkup: buildLevelsKeyboard(marketId, fresh.levels) });
    }
    return;
  }

  const unsubMatch = data.match(/^unsub:(\d+)$/);
  if (unsubMatch) {
    const id = unsubMatch[1];
    const ok = removeSubscription(chatId, id);
    if (ok) await saveState();
    await answerCallbackQuery(cb.id, { text: ok ? '已取消订阅' : '订阅不存在' });
    return;
  }

  const pickMatch = data.match(/^pick:([a-z0-9]+):(.+)$/);
  if (pickMatch) {
    const token = pickMatch[1];
    const choice = pickMatch[2];
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
    await sendSubscribed(chatId, pick);
    return;
  }

  await answerCallbackQuery(cb.id);
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
    { command: 'levels', description: '自定义监控档位（买1/2/3、卖1/2/3）' },
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
