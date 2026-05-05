import { config, requireConfig } from './config.js';
import { getUpdates, sendMessage, editMessageText, sendDocument, answerCallbackQuery, setMyCommands, getMe, htmlEscape } from './telegram.js';
import { readEvents, readWholeFile, fileStats, maybePrune } from './history.js';
import {
  loadState, saveState, getState,
  addSubscription, removeSubscription, listSubscriptionsForChat,
  getSubscription, updateSubscriptionLevels, updateSubscriptionNote,
  putPendingChoice, takePendingChoice, gcPendingChoices,
  putPendingNote, takePendingNote, gcPendingNotes,
  putPendingWatch, takePendingWatch, gcPendingWatch,
  ALL_LEVELS, LEVEL_LABEL,
} from './state.js';
import { extractSlugFromUrl, extractMarketId, resolveUrlToMarkets, fuzzySlugSuggestions, getMarketById } from './predict.js';
import { startMonitorLoop } from './monitor.js';

requireConfig();

const HELP = [
  '👋 <b>Predict.fun 订单簿监控机器人</b>',
  '',
  '<b>三种订阅方式</b>',
  '① 直接发 Predict.fun <b>网址</b>',
  '② 直接发 <b>marketId</b>（纯数字）',
  '③ 直接发 <b>slug</b>',
  '或用 /watch 一次性订阅多个。',
  '',
  '订阅后你关注的档位（买1/2/3、卖1/2/3）发生变化就会推送，每张可加备注。',
  '',
  `⏱ <b>检查间隔</b> ${Math.round(config.pollIntervalMs / 1000)}s · 单订阅最少 ${Math.round(config.notifyCooldownMs / 1000)}s 通知一次`,
  `📐 <b>触发阈值</b> 价 ≥ ${config.priceEpsilon} · 量 ≥ ${config.sizeAbsoluteMin} 张或 ${(config.sizeRelativeEpsilon * 100).toFixed(0)}%`,
  '',
  '<b>命令</b>',
  '/start, /help — 显示此帮助',
  '/watch — 批量订阅（回复消息粘贴多行）',
  '/list — 当前订阅',
  '/levels &lt;id&gt; — 自定义监控档位',
  '/note &lt;id&gt; [备注] — 设置备注（不带文字 = 清除）',
  '/history &lt;id&gt; [N] — 查看历史变动（默认最近 10 条）',
  '/export — 把整个 history.jsonl 发回给你',
  '/stop &lt;id&gt; — 取消订阅',
  '/stopall — 取消全部订阅',
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

async function sendSubscribed(chatId, m, { existingNote } = {}) {
  const lines = [
    `✅ 已订阅 <b>${htmlEscape(m.title || m.question || m.id)}</b>`,
    `<code>id=${m.id}</code>`,
  ];
  if (existingNote) lines.push(`📝 备注：${htmlEscape(existingNote)}`);
  lines.push('默认监控买1/2/3 + 卖1/2/3 全部 6 档。');
  lines.push('点下方按钮自定义要看哪几档 / 加备注；订单簿一旦变动立刻推送。');
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '📐 配置档位', callback_data: `lvl:${m.id}:open` },
        { text: '📝 设置备注', callback_data: `note:${m.id}` },
      ],
      [{ text: '🛑 取消订阅', callback_data: `unsub:${m.id}` }],
    ],
  };
  await sendMessage(chatId, lines.join('\n'), { replyMarkup });
}

// Send a ForceReply prompt asking the user to type a note. Records the
// prompt's message_id in pendingNotes so the eventual reply can be
// matched back to the right market.
async function promptForNote(chatId, marketId) {
  const sub = getSubscription(chatId, marketId);
  const cur = sub?.note ? `\n当前备注：<i>${htmlEscape(sub.note)}</i>` : '';
  const text = [
    `📝 请<b>回复此条消息</b>输入备注（直接发送文字）。`,
    `市场：${htmlEscape(sub?.title || `Market ${marketId}`)}  <code>id=${marketId}</code>${cur}`,
    `<i>发送 “-” 清除备注；30 分钟内有效。</i>`,
  ].join('\n');
  const sent = await sendMessage(chatId, text, {
    replyMarkup: { force_reply: true, selective: true, input_field_placeholder: '输入备注…' },
  });
  putPendingNote(chatId, sent.message_id, marketId);
  await saveState();
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
  let matches = [];
  try {
    // First try: if it's a real URL, fetch HTML and read the embedded
    // __NEXT_DATA__ — this is the only universally reliable path because
    // GraphQL doesn't expose URL slugs and REST needs an API key.
    // Falls back to slug-based resolver internally.
    const r = await resolveUrlToMarkets(text);
    matches = r.markets;
  } catch (err) {
    await sendMessage(chatId, `❌ 抓取市场列表失败：${htmlEscape(err.message)}`);
    return;
  }
  if (!matches.length) {
    // Try a fuzzy fallback so the user gets an actionable list instead
    // of a dead end. Common cause: URL slug includes the year ("...-2026")
    // but the API title omits it, or the slug points at an event page
    // whose sub-markets share a different question text.
    let suggestions = [];
    try { suggestions = await fuzzySlugSuggestions(slug, 8); } catch { /* ignore */ }
    if (suggestions.length) {
      const token = shortToken();
      putPendingChoice(chatId, token, suggestions);
      await saveState();
      await sendMessage(chatId, [
        `❓ 没找到完全匹配 slug=<code>${htmlEscape(slug)}</code>，下面是相似的市场：`,
        `<i>（点选订阅；30 分钟内有效）</i>`,
      ].join('\n'), { replyMarkup: buildChoiceKeyboard(token, suggestions) });
      return;
    }
    await sendMessage(chatId, [
      `❌ 没匹配到市场（slug=<code>${htmlEscape(slug)}</code>）。`,
      '可能原因：',
      '• 市场已 resolve（GraphQL 默认过滤已结算）',
      '• 是事件页 (event)，不是单 market',
      '• 缓存还没刷新（10 分钟 TTL）',
      '',
      '排查：在仓库目录下跑 <code>node scripts/diagnose.js &lt;url&gt;</code> 看每一步实际返回。',
    ].join('\n'));
    return;
  }
  if (matches.length === 1) {
    const m = matches[0];
    const existing = getSubscription(chatId, m.id);
    addSubscription({
      chatId,
      marketId: m.id,
      conditionId: m.conditionId,
      title: m.title || m.question || `Market ${m.id}`,
      slug: m.slug,
    });
    await saveState();
    await sendSubscribed(chatId, m, { existingNote: existing?.note });
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
      await sendMessage(chatId, '当前没有订阅。直接发个 Predict.fun 网址或 marketId 就能开始监控。');
      return true;
    }
    const lines = ['<b>当前订阅</b>'];
    for (const s of subs) {
      const levels = s.levels?.length ? s.levels.map((l) => LEVEL_LABEL[l]).join('/') : '（无）';
      const noteLine = s.note ? `\n   📝 ${htmlEscape(s.note)}` : '';
      lines.push(`• <code>${s.marketId}</code> — ${htmlEscape(s.title || '')}${noteLine}\n   档位：${levels}  /levels_${s.marketId}  /note_${s.marketId}`);
    }
    lines.push('', '改档位：/levels &lt;id&gt;\n改备注：/note &lt;id&gt; &lt;文字&gt;（不带文字 = 清除）\n取消单个：/stop &lt;id&gt;\n取消全部：/stopall');
    await sendMessage(chatId, lines.join('\n'));
    return true;
  }
  if (c === '/watch') {
    if (args.length) {
      // Inline mode: process the args as a single line — useful for
      // /watch 272779 主仓 from the keyboard.
      await applyBulkWatchInput(chatId, args.join(' '));
      return true;
    }
    await promptBulkWatch(chatId);
    return true;
  }
  if (c === '/note' || /^\/note_\d+$/.test(c)) {
    let id = args[0];
    let noteArgs = args.slice(1);
    if (/^\/note_\d+$/.test(c)) {
      id = c.slice('/note_'.length);
      noteArgs = args;
    }
    if (!id) {
      await sendMessage(chatId, '用法：/note &lt;marketId&gt; &lt;备注文字&gt;\n（不带文字 → 弹输入框；发 “-” 清除）');
      return true;
    }
    const sub = getSubscription(chatId, id);
    if (!sub) {
      await sendMessage(chatId, `❌ 没有订阅 <code>${htmlEscape(id)}</code>`);
      return true;
    }
    if (noteArgs.length === 0) {
      // Inline keyboard mode — pop a ForceReply prompt.
      await promptForNote(chatId, id);
      return true;
    }
    await applyNoteInput(chatId, id, noteArgs.join(' '));
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
  if (c === '/history' || /^\/history_\d+$/.test(c)) {
    let id = args[0];
    let n = Number(args[1]);
    if (/^\/history_\d+$/.test(c)) {
      id = c.slice('/history_'.length);
      n = Number(args[0]);
    }
    if (!id) {
      await sendMessage(chatId, '用法：/history &lt;marketId&gt; [N]\n查看该市场最近 N 条变动记录（默认 10，最多 50）。');
      return true;
    }
    if (!Number.isFinite(n) || n <= 0) n = 10;
    n = Math.min(50, Math.floor(n));
    const events = await readEvents({ chatId, marketId: id, limit: n });
    if (!events.length) {
      await sendMessage(chatId, `没有 <code>${htmlEscape(id)}</code> 的历史记录。`);
      return true;
    }
    const lines = [`<b>📜 ${htmlEscape(events[0].title || `Market ${id}`)} 最近 ${events.length} 条</b>`];
    for (const e of events) {
      const t = new Date(e.ts).toISOString().replace('T', ' ').slice(5, 19);
      lines.push(`<code>${t}</code> ${htmlEscape(e.summary || '变动')}`);
    }
    lines.push('', `完整文件：/export`);
    await sendMessage(chatId, lines.join('\n'));
    return true;
  }
  if (c === '/export') {
    const stats = await fileStats();
    if (!stats.exists || stats.size === 0) {
      await sendMessage(chatId, '没有历史记录文件可导出。');
      return true;
    }
    const buf = await readWholeFile();
    if (!buf) {
      await sendMessage(chatId, '读取历史文件失败。');
      return true;
    }
    const fileName = `history-${new Date().toISOString().slice(0, 10)}.jsonl`;
    try {
      await sendDocument(chatId, {
        fileName,
        content: buf,
        contentType: 'application/x-ndjson',
        caption: `📦 共 ${(stats.size / 1024).toFixed(1)} KiB`,
      });
    } catch (err) {
      await sendMessage(chatId, `❌ 导出失败：${htmlEscape(err.message)}`);
    }
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

  // Reply-to-prompt path: if the user is replying to one of our
  // ForceReply prompts (note or watch), route the message to the
  // matching handler instead of treating it as a fresh subscription.
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo) {
    const marketId = takePendingNote(chatId, replyTo);
    if (marketId) {
      await applyNoteInput(chatId, marketId, text);
      return;
    }
    if (takePendingWatch(chatId, replyTo)) {
      await applyBulkWatchInput(chatId, text);
      return;
    }
  }

  if (text.startsWith('/')) {
    const handled = await handleCommand(chatId, text);
    if (!handled) await sendMessage(chatId, '未识别的命令。/help 查看可用命令。');
    return;
  }

  // Pure numeric → marketId direct subscribe
  const id = extractMarketId(text);
  if (id) {
    await handleMarketIdInput(chatId, id);
    return;
  }
  // Otherwise treat as URL or slug.
  await handleUrl(chatId, text);
}

async function handleMarketIdInput(chatId, marketId) {
  let market;
  try {
    market = await getMarketById(marketId);
  } catch (err) {
    await sendMessage(chatId, `❌ 抓取市场失败：${htmlEscape(err.message)}`);
    return;
  }
  if (!market) {
    await sendMessage(chatId, [
      `❌ 找不到 marketId <code>${htmlEscape(marketId)}</code>。`,
      '可能 id 不对，或该市场已 resolve。试试发完整 URL。',
    ].join('\n'));
    return;
  }
  const m = {
    id: String(market.id),
    conditionId: market.conditionId ?? null,
    title: market.title ?? market.question ?? null,
    question: market.question ?? null,
    slug: market.categorySlug ?? market.slug ?? market.marketSlug ?? null,
  };
  const existing = getSubscription(chatId, m.id);
  addSubscription({
    chatId,
    marketId: m.id,
    conditionId: m.conditionId,
    title: m.title || m.question || `Market ${m.id}`,
    slug: m.slug,
  });
  await saveState();
  await sendSubscribed(chatId, m, { existingNote: existing?.note });
}

async function promptBulkWatch(chatId) {
  const text = [
    '👁 <b>批量订阅市场</b>',
    '',
    '回复此条消息，每行一个 URL / marketId / slug，',
    '可在后面加备注（用空格、<code>-</code> 或 <code>:</code> 分隔）。',
    '',
    '<b>📋 格式示例</b>',
    '<code>https://predict.fun/zh-cn/market/foo</code>',
    '<code>272779 主仓</code>',
    '<code>spain — 西班牙夺冠</code>',
    '<code>btc-eom-2026 : 短期套利</code>',
    '',
    '<i>每行处理一条；URL 是事件页时会跳过提示（请单独发送以选择子市场）。30 分钟内有效。</i>',
  ].join('\n');
  const sent = await sendMessage(chatId, text, {
    replyMarkup: { force_reply: true, selective: true, input_field_placeholder: 'URL/id/slug 备注' },
  });
  putPendingWatch(chatId, sent.message_id);
  await saveState();
}

// Split a /watch line into target + optional note. Separator after
// target can be whitespace, dash, em-dash, hyphen, colon, fullwidth
// colon, or any combination.
function parseWatchLine(line) {
  const ws = line.search(/\s/);
  if (ws < 0) return { target: line, note: null };
  const target = line.slice(0, ws);
  let note = line.slice(ws).trim();
  note = note.replace(/^[-—–:：]\s*/, '').trim();
  return { target, note: note || null };
}

async function applyBulkWatchInput(chatId, raw) {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    await sendMessage(chatId, '没有内容。回复 /watch 弹出的消息，每行写一条。');
    return;
  }
  const results = [];
  for (const line of lines) {
    const { target, note } = parseWatchLine(line);
    const noteSuffix = note ? `  📝 ${htmlEscape(note)}` : '';
    // 1) Pure numeric → marketId direct lookup.
    const id = extractMarketId(target);
    if (id) {
      try {
        const market = await getMarketById(id);
        if (!market) { results.push(`✗ <code>${htmlEscape(id)}</code> 市场不存在`); continue; }
        addSubscription({
          chatId,
          marketId: id,
          conditionId: market.conditionId ?? null,
          title: market.title || market.question || `Market ${id}`,
          slug: null,
          note,
        });
        results.push(`✓ <code>${id}</code> ${htmlEscape((market.title ?? '').slice(0, 50))}${noteSuffix}`);
      } catch (err) {
        results.push(`✗ <code>${htmlEscape(id)}</code> ${htmlEscape(err.message).slice(0, 60)}`);
      }
      continue;
    }
    // 2) URL / slug — use the same resolver the single-message path uses.
    try {
      const r = await resolveUrlToMarkets(target);
      if (!r.markets.length) {
        results.push(`✗ <code>${htmlEscape(target).slice(0, 50)}</code> 找不到`);
        continue;
      }
      if (r.markets.length === 1) {
        const m = r.markets[0];
        addSubscription({
          chatId,
          marketId: m.id,
          conditionId: m.conditionId,
          title: m.title || m.question || `Market ${m.id}`,
          slug: m.slug,
          note,
        });
        results.push(`✓ <code>${m.id}</code> ${htmlEscape((m.title ?? '').slice(0, 50))}${noteSuffix}`);
      } else {
        results.push(`⚠ <code>${htmlEscape(target).slice(0, 40)}</code> 是事件页（${r.markets.length} 个子市场，请单独发送以选择）`);
      }
    } catch (err) {
      results.push(`✗ <code>${htmlEscape(target).slice(0, 40)}</code> ${htmlEscape(err.message).slice(0, 60)}`);
    }
  }
  await saveState();
  const ok = results.filter((r) => r.startsWith('✓')).length;
  await sendMessage(chatId, [
    `<b>📥 批量订阅完成</b>  ✓${ok} / ${results.length}`,
    '',
    ...results,
  ].join('\n'));
}

async function applyNoteInput(chatId, marketId, raw) {
  const sub = getSubscription(chatId, marketId);
  if (!sub) {
    await sendMessage(chatId, `❌ 订阅 <code>${htmlEscape(marketId)}</code> 已不存在。`);
    return;
  }
  const text = raw.trim();
  // Single dash = clear.
  const noteText = (text === '-' || text === '——') ? '' : text;
  updateSubscriptionNote(chatId, marketId, noteText);
  await saveState();
  if (noteText) {
    await sendMessage(chatId, [
      `✅ 已设置备注`,
      `<code>id=${marketId}</code> ${htmlEscape(sub.title || '')}`,
      `📝 ${htmlEscape(noteText)}`,
    ].join('\n'));
  } else {
    await sendMessage(chatId, `✅ 已清除备注  <code>id=${marketId}</code>`);
  }
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
    const existing = getSubscription(chatId, pick.id);
    addSubscription({
      chatId,
      marketId: pick.id,
      conditionId: pick.conditionId,
      title: pick.title || pick.question || `Market ${pick.id}`,
      slug: pick.slug,
    });
    await saveState();
    await answerCallbackQuery(cb.id, { text: '✅ 已订阅' });
    await sendSubscribed(chatId, pick, { existingNote: existing?.note });
    return;
  }

  const noteMatch = data.match(/^note:(\d+)$/);
  if (noteMatch) {
    const id = noteMatch[1];
    const sub = getSubscription(chatId, id);
    if (!sub) {
      await answerCallbackQuery(cb.id, { text: '订阅不存在', showAlert: true });
      return;
    }
    await answerCallbackQuery(cb.id, { text: '请回复弹出的消息输入备注' });
    await promptForNote(chatId, id);
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
    gcPendingNotes();
    gcPendingWatch();
  }
}

async function main() {
  await loadState();
  const me = await getMe();
  console.log(new Date().toISOString(), `[bot] logged in as @${me.username}`);
  await setMyCommands([
    { command: 'start', description: '欢迎信息和用法' },
    { command: 'help', description: '帮助' },
    { command: 'watch', description: '批量订阅（粘贴多行 URL/id/slug）' },
    { command: 'list', description: '当前订阅' },
    { command: 'levels', description: '自定义监控档位（买1/2/3、卖1/2/3）' },
    { command: 'note', description: '设置/清除订阅备注' },
    { command: 'history', description: '查看市场最近 N 条变动记录' },
    { command: 'export', description: '导出完整 history.jsonl' },
    { command: 'stop', description: '取消单个订阅' },
    { command: 'stopall', description: '取消全部订阅' },
  ]).catch((e) => console.warn('[bot] setMyCommands failed:', e.message));

  // Once-per-startup history compaction (also throttled to ≤1×/24h
  // internally so frequent restarts don't thrash the file).
  maybePrune().catch((err) => console.warn('[bot] prune failed:', err.message));

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
