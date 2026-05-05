import { config, requireConfig } from './config.js';
import { getUpdates, sendMessage, editMessageText, sendDocument, answerCallbackQuery, setMyCommands, getMe, htmlEscape } from './telegram.js';
import { readEvents, readWholeFile, fileStats, maybePrune } from './history.js';
import {
  loadState, saveState, getState,
  addSubscription, removeSubscription, listSubscriptionsForChat,
  getSubscription, updateSubscriptionLevels, updateSubscriptionNote,
  updateSubscriptionTriggerMode,
  putPendingChoice, takePendingChoice, gcPendingChoices,
  putPendingNote, takePendingNote, gcPendingNotes,
  putPendingWatch, takePendingWatch, gcPendingWatch,
  ALL_LEVELS, LEVEL_LABEL, TRIGGER_MODES, TRIGGER_LABEL,
} from './state.js';
import { extractSlugFromUrl, extractMarketId, resolveUrlToMarkets, fuzzySlugSuggestions, getMarketById, getOrderbook } from './predict.js';
import { fmtBook, fmtSpreadLine, subActionKeyboard, primeSubscriptionSnapshot } from './monitor.js';
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
  `⏱ <b>检查间隔</b> ${config.pollIntervalMs}ms · 下限 ${config.pollMinIntervalMs}ms · 并发 ${config.pollConcurrency} · 冷却 ${Math.round(config.notifyCooldownMs / 1000)}s`,
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
  '/probe &lt;id&gt; — 立即抓一次订单簿（不等下次轮询）',
  '/speedtest [N] — 测延迟（默认 5 次），给出推荐的最快 POLL_INTERVAL_MS',
  '/stop &lt;id&gt; — 取消订阅',
  '/stopall — 取消全部订阅',
].join('\n');

function buildLevelsKeyboard(marketId, levels, triggerMode) {
  const set = new Set(levels);
  const btn = (k) => ({
    text: (set.has(k) ? '✅ ' : '⬜ ') + LEVEL_LABEL[k],
    callback_data: `lvl:${marketId}:t:${k}`,
  });
  const mbtn = (mode, label) => ({
    text: (triggerMode === mode ? '🟢 ' : '⚪ ') + label,
    callback_data: `lvl:${marketId}:m:${mode}`,
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
      [mbtn('both', '价+量'), mbtn('price', '只看价'), mbtn('size', '只看量')],
      [{ text: '✅ 完成', callback_data: `lvl:${marketId}:done` }],
    ],
  };
}

function levelsHeader(sub) {
  const watching = sub.levels?.length
    ? sub.levels.map((l) => LEVEL_LABEL[l]).join('、')
    : '（无 — 不会推送）';
  const mode = TRIGGER_LABEL[sub.triggerMode] ?? '价+量';
  return [
    `<b>📐 配置监控档位</b>`,
    htmlEscape(sub.title || `Market ${sub.marketId}`),
    `<code>id=${sub.marketId}</code>`,
    '',
    `当前档位：${watching}`,
    `触发条件：<b>${mode}</b>`,
    '',
    '点按钮切换档位（✅ = 监控）/ 触发条件（🟢 = 当前选中）。',
  ].join('\n');
}

function shortToken() {
  return Math.random().toString(36).slice(2, 8);
}

// Send the "subscribed" confirmation with current orderbook embedded.
// Three jobs:
//   1. Tell the user it worked (and whether this was new vs already
//      tracked — addSubscription preserves note/levels on re-add but
//      the user can't tell from the prior message).
//   2. Show the current book immediately so they don't wait one poll
//      cycle to verify the bot can actually reach this market.
//   3. Prime the per-sub baseline snapshot — without this, the next
//      poll tick fires "🆕 初次抓取" which duplicates this message.
async function sendSubscribed(chatId, m, { wasExisting = false } = {}) {
  const sub = getSubscription(chatId, m.id);
  const levels = sub?.levels?.length ? sub.levels : ALL_LEVELS;
  const mode = sub?.triggerMode || 'both';

  // Fetch the orderbook so the user gets immediate feedback.
  let snap = null;
  try {
    let market = await getMarketById(m.id);
    if (!market && m.conditionId) market = { id: m.id, conditionId: m.conditionId };
    if (market) snap = await getOrderbook(market);
  } catch (err) {
    console.warn('[subscribed] orderbook fetch failed:', err.message);
  }

  const headerEmoji = wasExisting ? 'ℹ️' : '✅';
  const headerText = wasExisting ? '已在监控中（信息已刷新）' : '已开始监控';
  const lines = [
    `${headerEmoji} <b>${headerText}</b>`,
    `🏷 ${htmlEscape(m.title || m.question || m.id)}`,
    `<code>id=${m.id}</code>`,
  ];
  if (sub?.note) lines.push(`📝 <i>${htmlEscape(sub.note)}</i>`);
  lines.push(`📐 档位：${levels.map((l) => LEVEL_LABEL[l]).join('/')} · 触发：${TRIGGER_LABEL[mode] ?? '价+量'}`);
  if (snap) {
    lines.push('');
    lines.push(fmtSpreadLine(snap));
    lines.push('');
    lines.push(fmtBook(null, snap, levels));
    // Suppress the "initial snapshot" alert on the next poll tick.
    primeSubscriptionSnapshot(chatId, m.id, snap);
  } else {
    lines.push('', '<i>当前订单簿抓取失败 — 不影响订阅，下一轮轮询会自动重试。</i>');
  }
  await sendMessage(chatId, lines.join('\n'), { replyMarkup: subActionKeyboard(m.id) });
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
    // Number prefix + #id suffix disambiguates same-titled cards
    // (events with multiple sub-markets share Yes/No/Draw labels).
    // Telegram button text caps at ~64 chars; trim title to fit both
    // the prefix and the id without overflow.
    const rawTitle = (m.title || m.question || `#${m.id}`).replace(/\s+/g, ' ').trim();
    const idSuffix = ` · #${m.id}`;
    const titleBudget = 64 - String(i + 1).length - 2 - idSuffix.length;
    const title = rawTitle.length > titleBudget ? rawTitle.slice(0, titleBudget - 1) + '…' : rawTitle;
    rows.push([{ text: `${i + 1}. ${title}${idSuffix}`, callback_data: `pick:${token}:${i}` }]);
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
    const wasExisting = !!getSubscription(chatId, m.id);
    addSubscription({
      chatId,
      marketId: m.id,
      conditionId: m.conditionId,
      title: m.title || m.question || `Market ${m.id}`,
      slug: m.slug,
    });
    await saveState();
    await sendSubscribed(chatId, m, { wasExisting });
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
    await renderListView(chatId);
    return true;
  }
  if (c === '/probe' || /^\/probe_\d+$/.test(c)) {
    let id = args[0];
    if (!id && /^\/probe_\d+$/.test(c)) id = c.slice('/probe_'.length);
    if (!id) {
      await sendMessage(chatId, '用法：/probe &lt;marketId&gt;\n立即抓一次订单簿（不等下次轮询）。');
      return true;
    }
    await runProbe(chatId, id);
    return true;
  }
  if (c === '/speedtest') {
    const n = Math.max(2, Math.min(20, Number(args[0]) || 5));
    const explicitId = args[1];
    await runSpeedtest(chatId, n, explicitId);
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
      replyMarkup: buildLevelsKeyboard(sub.marketId, sub.levels, sub.triggerMode),
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
    if (!subs.length) {
      await sendMessage(chatId, '当前没有订阅，无需取消。');
      return true;
    }
    // Confirm before nuking every subscription. The actual delete
    // happens on the stopall_ok callback below.
    await sendMessage(chatId, [
      `⚠️ <b>确认取消全部 ${subs.length} 个订阅？</b>`,
      ``,
      `<i>历史记录会保留；订阅本身将被全部清除。</i>`,
    ].join('\n'), {
      replyMarkup: {
        inline_keyboard: [[
          { text: '✅ 全部停止', callback_data: 'stopall_ok' },
          { text: '↩️ 返回', callback_data: 'stopall_no' },
        ]],
      },
    });
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
  const wasExisting = !!getSubscription(chatId, m.id);
  addSubscription({
    chatId,
    marketId: m.id,
    conditionId: m.conditionId,
    title: m.title || m.question || `Market ${m.id}`,
    slug: m.slug,
  });
  await saveState();
  await sendSubscribed(chatId, m, { wasExisting });
}

// One-shot orderbook fetch + render. Useful to verify a market is
// reachable without subscribing, and the latency line doubles as a
// quick "how slow is this network round trip" gauge.
const LIST_PAGE_SIZE = 5;

function listPageKeyboard(page, totalPages) {
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ 上一页', callback_data: `list:${page - 1}` });
  nav.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'noop' });
  if (page < totalPages - 1) nav.push({ text: '下一页 ➡️', callback_data: `list:${page + 1}` });
  return {
    inline_keyboard: [
      nav,
      [
        { text: '🔄 刷新', callback_data: `list:${page}` },
        { text: '👁 批量加', callback_data: 'list:watch' },
        { text: '🛑 全部停止', callback_data: 'stopall_confirm' },
      ],
    ],
  };
}

// Render one page of the subscription list (LIST_PAGE_SIZE per page).
// Each sub becomes a separate message with its own 4-button action
// row, plus a header/footer pair carrying the pagination controls.
// Used by both the /list command and the list:<page> callback.
async function renderListView(chatId, page = 0) {
  const subs = listSubscriptionsForChat(chatId);
  if (!subs.length) {
    await sendMessage(chatId, '当前没有订阅。直接发个 Predict.fun 网址或 marketId 就能开始监控；批量用 /watch。');
    return;
  }
  const totalPages = Math.max(1, Math.ceil(subs.length / LIST_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = subs.slice(safePage * LIST_PAGE_SIZE, (safePage + 1) * LIST_PAGE_SIZE);

  await sendMessage(chatId, [
    `<b>📋 当前订阅 ${subs.length} 个</b>`,
    `<i>第 ${safePage + 1} / ${totalPages} 页 · 每页 ${LIST_PAGE_SIZE} 张</i>`,
  ].join('\n'));

  for (const s of slice) {
    const levels = s.levels?.length
      ? s.levels.map((l) => LEVEL_LABEL[l]).join('/')
      : '（无 — 不会推送）';
    const mode = TRIGGER_LABEL[s.triggerMode] ?? '价+量';
    const lines = [
      `🟢 <b>${htmlEscape(s.title || `Market ${s.marketId}`)}</b>`,
      `<code>id=${s.marketId}</code>`,
      `档位：${levels} · 触发：${mode}`,
    ];
    if (s.note) lines.push(`📝 <i>${htmlEscape(s.note)}</i>`);
    await sendMessage(chatId, lines.join('\n'), { replyMarkup: subActionKeyboard(s.marketId) });
  }

  // Pagination footer with prev/next/全部停止 buttons.
  await sendMessage(
    chatId,
    `<i>翻页或快捷操作：</i>`,
    { replyMarkup: listPageKeyboard(safePage, totalPages) },
  );
}

async function runProbe(chatId, marketId) {
  const sub = getSubscription(chatId, marketId);
  let market;
  try {
    market = await getMarketById(marketId);
  } catch (err) {
    await sendMessage(chatId, `❌ getMarketById 失败: ${htmlEscape(err.message)}`);
    return;
  }
  if (!market && sub?.conditionId) {
    market = { id: marketId, conditionId: sub.conditionId };
  }
  if (!market) {
    await sendMessage(chatId, `❌ 找不到市场 <code>${htmlEscape(marketId)}</code>`);
    return;
  }
  const t0 = Date.now();
  let snap;
  try {
    snap = await getOrderbook(market);
  } catch (err) {
    await sendMessage(chatId, `❌ getOrderbook 失败: ${htmlEscape(err.message)}`);
    return;
  }
  const latency = Date.now() - t0;
  const levels = sub?.levels?.length ? sub.levels : ALL_LEVELS;
  const title = sub?.title || market.title || market.question || `Market ${marketId}`;
  const text = [
    `<b>🔍 即时抓取</b>  <i>(${latency}ms)</i>`,
    `<b>${htmlEscape(title)}</b>  <code>id=${marketId}</code>`,
    sub?.note ? `📝 <i>${htmlEscape(sub.note)}</i>` : null,
    '',
    fmtSpreadLine(snap),
    '',
    fmtBook(null, snap, levels),
  ].filter(Boolean).join('\n');
  // Only attach the action keyboard when the user actually has a sub
  // for this market — buttons would 404 otherwise.
  const replyMarkup = sub ? subActionKeyboard(marketId) : undefined;
  await sendMessage(chatId, text, { replyMarkup });
}

// Speed test: hammer one orderbook endpoint N times back-to-back and
// report the latency distribution. Tells the user the floor for
// POLL_INTERVAL_MS without trial-and-erroring it on Railway.
async function runSpeedtest(chatId, n, explicitId) {
  let target;
  if (explicitId) {
    const sub = getSubscription(chatId, explicitId);
    if (sub?.conditionId) {
      target = { id: explicitId, conditionId: sub.conditionId, title: sub.title };
    } else {
      try {
        const m = await getMarketById(explicitId);
        if (m) target = { id: explicitId, conditionId: m.conditionId, title: m.title };
      } catch { /* ignore */ }
    }
    if (!target) {
      await sendMessage(chatId, `❌ 找不到市场 <code>${htmlEscape(explicitId)}</code>`);
      return;
    }
  } else {
    const subs = listSubscriptionsForChat(chatId);
    if (!subs.length) {
      await sendMessage(chatId, '需要至少一个订阅来测速。先订阅个市场，或 <code>/speedtest 5 &lt;marketId&gt;</code> 直接指定。');
      return;
    }
    const sub = subs[0];
    target = { id: sub.marketId, conditionId: sub.conditionId, title: sub.title };
    if (!target.conditionId) {
      try {
        const m = await getMarketById(sub.marketId);
        if (m?.conditionId) target.conditionId = m.conditionId;
      } catch { /* ignore */ }
    }
  }
  if (!target.conditionId) {
    await sendMessage(chatId, '❌ 该市场缺 conditionId，无法直接测速。');
    return;
  }

  await sendMessage(chatId, `⏱ 速度测试 <b>${htmlEscape(target.title || target.id)}</b> · ${n} 次 …`);

  const market = { id: target.id, conditionId: target.conditionId };
  const times = [];
  let okCount = 0;
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      await getOrderbook(market);
      times.push(Date.now() - t0);
      okCount += 1;
    } catch (err) {
      times.push(-Math.abs(Date.now() - t0));
    }
  }
  const valid = times.filter((t) => t > 0).slice().sort((a, b) => a - b);
  if (!valid.length) {
    await sendMessage(chatId, `❌ ${n} 次全部失败`);
    return;
  }
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const median = valid[Math.floor(valid.length / 2)];
  const min = valid[0];
  const max = valid[valid.length - 1];
  const p95 = valid[Math.min(valid.length - 1, Math.floor(valid.length * 0.95))];
  // Recommend POLL_INTERVAL_MS = max(p95 × 1.5, POLL_MIN_INTERVAL_MS).
  // Round up to a clean 100ms boundary for readability.
  const recommendMs = Math.max(
    config.pollMinIntervalMs,
    Math.ceil((p95 * 1.5) / 100) * 100,
  );
  const fmt = (t) => t < 0 ? `<s>${-t}ms✗</s>` : `${t}ms`;
  await sendMessage(chatId, [
    `⏱ <b>速度测试结果</b>`,
    `市场: ${htmlEscape(target.title || target.id)}  <code>id=${target.id}</code>`,
    '',
    `成功: <b>${okCount}/${n}</b>`,
    `延迟: 最快 <b>${min}ms</b> · 中位 <b>${median}ms</b> · 平均 <b>${avg.toFixed(0)}ms</b> · p95 <b>${p95}ms</b> · 最慢 <b>${max}ms</b>`,
    '',
    `每次: ${times.map(fmt).join(' · ')}`,
    '',
    `<i>💡 推荐 <code>POLL_INTERVAL_MS=${recommendMs}</code>（p95 × 1.5 留缓冲）</i>`,
    `<i>想最快推送：把 <code>NOTIFY_COOLDOWN_SEC=1</code>（默认 60，防刷屏）</i>`,
    `<i>当前: 轮询 ${config.pollIntervalMs}ms · 循环下限 ${config.pollMinIntervalMs}ms · 并发 ${config.pollConcurrency} · 冷却 ${config.notifyCooldownMs / 1000}s</i>`,
  ].join('\n'));
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
    // Trigger-mode toggle (m:both | m:price | m:size).
    if (action.startsWith('m:')) {
      const mode = action.slice(2);
      if (!TRIGGER_MODES.includes(mode)) {
        await answerCallbackQuery(cb.id, { text: '未知模式' });
        return;
      }
      updateSubscriptionTriggerMode(chatId, marketId, mode);
      await saveState();
      const fresh = getSubscription(chatId, marketId);
      await answerCallbackQuery(cb.id, { text: `触发: ${TRIGGER_LABEL[mode]}` });
      try {
        await editMessageText(chatId, messageId, levelsHeader(fresh), buildLevelsKeyboard(marketId, fresh.levels, fresh.triggerMode));
      } catch {
        await sendMessage(chatId, levelsHeader(fresh), { replyMarkup: buildLevelsKeyboard(marketId, fresh.levels, fresh.triggerMode) });
      }
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
          `<b>📐 设置已保存</b>`,
          htmlEscape(sub.title || `Market ${sub.marketId}`),
          `<code>id=${sub.marketId}</code>`,
          ``,
          `监控档位：${summary}`,
          `触发条件：<b>${TRIGGER_LABEL[sub.triggerMode] ?? '价+量'}</b>`,
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
      await editMessageText(chatId, messageId, levelsHeader(fresh), buildLevelsKeyboard(marketId, fresh.levels, fresh.triggerMode));
    } catch (err) {
      // If edit fails (e.g. opened from a notification message we didn't author), send fresh.
      await sendMessage(chatId, levelsHeader(fresh), { replyMarkup: buildLevelsKeyboard(marketId, fresh.levels, fresh.triggerMode) });
    }
    return;
  }

  // First-tap stop: switch the message to a confirmation prompt
  // ("确认停止" / "返回"). Actual deletion only happens on unsub_ok.
  const unsubMatch = data.match(/^unsub:(\d+)$/);
  if (unsubMatch) {
    const id = unsubMatch[1];
    const sub = getSubscription(chatId, id);
    if (!sub) {
      await answerCallbackQuery(cb.id, { text: '订阅不存在' });
      return;
    }
    await answerCallbackQuery(cb.id);
    if (messageId) {
      try {
        await editMessageText(
          chatId,
          messageId,
          [
            `⚠️ <b>确认停止监控？</b>`,
            `🏷 ${htmlEscape(sub.title || `Market ${id}`)}`,
            `<code>id=${id}</code>`,
            sub.note ? `📝 <i>${htmlEscape(sub.note)}</i>` : null,
            ``,
            `<i>停止后历史记录保留；如需重新监控，再发一次同样的网址或 id。</i>`,
          ].filter(Boolean).join('\n'),
          {
            inline_keyboard: [[
              { text: '✅ 确认停止', callback_data: `unsub_ok:${id}` },
              { text: '↩️ 返回', callback_data: `unsub_no:${id}` },
            ]],
          },
        );
      } catch { /* old message — fall through with sendMessage */ }
    }
    return;
  }

  // Confirmed stop — actually remove the subscription.
  const unsubOk = data.match(/^unsub_ok:(\d+)$/);
  if (unsubOk) {
    const id = unsubOk[1];
    const ok = removeSubscription(chatId, id);
    if (ok) await saveState();
    await answerCallbackQuery(cb.id, { text: ok ? '已停止' : '订阅已不存在' });
    if (messageId) {
      try {
        await editMessageText(chatId, messageId, ok
          ? `🛑 已停止监控 <code>${htmlEscape(id)}</code>`
          : `❌ 订阅已不存在 <code>${htmlEscape(id)}</code>`);
      } catch { /* ignore */ }
    }
    return;
  }

  // Cancel-stop: restore the original card with its action keyboard.
  const unsubNo = data.match(/^unsub_no:(\d+)$/);
  if (unsubNo) {
    const id = unsubNo[1];
    const sub = getSubscription(chatId, id);
    await answerCallbackQuery(cb.id, { text: '已取消' });
    if (sub && messageId) {
      const levels = sub.levels?.length
        ? sub.levels.map((l) => LEVEL_LABEL[l]).join('/')
        : '（无 — 不会推送）';
      const mode = TRIGGER_LABEL[sub.triggerMode] ?? '价+量';
      const lines = [
        `🟢 <b>${htmlEscape(sub.title || `Market ${sub.marketId}`)}</b>`,
        `<code>id=${sub.marketId}</code>`,
        `档位：${levels} · 触发：${mode}`,
      ];
      if (sub.note) lines.push(`📝 <i>${htmlEscape(sub.note)}</i>`);
      try {
        await editMessageText(chatId, messageId, lines.join('\n'), subActionKeyboard(sub.marketId));
      } catch { /* ignore */ }
    }
    return;
  }

  // Pagination: list:<n> renders a fresh page; list:watch opens the
  // bulk-add prompt; noop is the page-indicator (no-op).
  if (data === 'noop') {
    await answerCallbackQuery(cb.id);
    return;
  }
  const listMatch = data.match(/^list:(\d+)$/);
  if (listMatch) {
    await answerCallbackQuery(cb.id);
    await renderListView(chatId, Number(listMatch[1]));
    return;
  }
  if (data === 'list:watch') {
    await answerCallbackQuery(cb.id);
    await promptBulkWatch(chatId);
    return;
  }
  if (data === 'stopall_confirm') {
    const subs = listSubscriptionsForChat(chatId);
    await answerCallbackQuery(cb.id);
    if (!subs.length) {
      await sendMessage(chatId, '当前没有订阅，无需取消。');
      return;
    }
    await sendMessage(chatId, [
      `⚠️ <b>确认取消全部 ${subs.length} 个订阅？</b>`,
      ``,
      `<i>历史记录会保留；订阅本身将被全部清除。</i>`,
    ].join('\n'), {
      replyMarkup: {
        inline_keyboard: [[
          { text: '✅ 全部停止', callback_data: 'stopall_ok' },
          { text: '↩️ 返回', callback_data: 'stopall_no' },
        ]],
      },
    });
    return;
  }

  if (data === 'stopall_ok') {
    const subs = listSubscriptionsForChat(chatId);
    for (const s of subs) removeSubscription(chatId, s.marketId);
    if (subs.length) await saveState();
    await answerCallbackQuery(cb.id, { text: `已停止 ${subs.length}` });
    if (messageId) {
      try {
        await editMessageText(chatId, messageId, `🛑 已取消全部订阅（共 ${subs.length} 个）`);
      } catch { /* ignore */ }
    }
    return;
  }

  if (data === 'stopall_no') {
    await answerCallbackQuery(cb.id, { text: '已取消' });
    if (messageId) {
      try {
        await editMessageText(chatId, messageId, '↩️ 已返回，订阅未变。');
      } catch { /* ignore */ }
    }
    return;
  }

  const probeMatch = data.match(/^probe:(\d+)$/);
  if (probeMatch) {
    const id = probeMatch[1];
    await answerCallbackQuery(cb.id, { text: '🔍 抓取中…' });
    await runProbe(chatId, id);
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
    const wasExisting = !!getSubscription(chatId, pick.id);
    addSubscription({
      chatId,
      marketId: pick.id,
      conditionId: pick.conditionId,
      title: pick.title || pick.question || `Market ${pick.id}`,
      slug: pick.slug,
    });
    await saveState();
    await answerCallbackQuery(cb.id, { text: '✅ 已订阅' });
    await sendSubscribed(chatId, pick, { wasExisting });
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
    { command: 'probe', description: '立即抓一次订单簿（不等下次轮询）' },
    { command: 'speedtest', description: '测试抓取延迟，给出推荐的最快轮询间隔' },
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
