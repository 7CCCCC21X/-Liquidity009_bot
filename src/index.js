import { config, requireConfig } from './config.js';
import { getUpdates, sendMessage, editMessageText, sendDocument, answerCallbackQuery, setMyCommands, getMe, htmlEscape } from './telegram.js';
import { readEvents, readWholeFile, fileStats, maybePrune } from './history.js';
import {
  loadState, saveState, getState,
  addSubscription, removeSubscription, listSubscriptionsForChat,
  getSubscription, updateSubscriptionLevels, updateSubscriptionNote,
  updateSubscriptionTriggerMode, setSubscriptionPause, pauseAllForChat,
  putPendingChoice, peekPendingChoice, takePendingChoice, gcPendingChoices,
  putPendingNote, takePendingNote, gcPendingNotes,
  putPendingWatch, takePendingWatch, gcPendingWatch,
  ALL_LEVELS, LEVEL_LABEL, TRIGGER_MODES, TRIGGER_LABEL,
} from './state.js';
import { extractSlugFromUrl, extractMarketId, resolveUrlToMarkets, fuzzySlugSuggestions, getMarketById, getOrderbook } from './predict.js';
import { fmtBook, fmtSpreadLine, subActionKeyboard, primeSubscriptionSnapshot, marketLink, fmtClockTime } from './monitor.js';
import { startMonitorLoop } from './monitor.js';

requireConfig();

// Welcome screen — same message for /start and /help. Keep it short
// and action-oriented; the long command list is gated behind the
// "❓ 命令列表" button so the first impression isn't a wall of text.
function welcomeText() {
  const labelMap = { bid1: '买1', bid2: '买2', bid3: '买3', ask1: '卖1', ask2: '卖2', ask3: '卖3' };
  const levelsHint = (config.defaultLevels?.length ? config.defaultLevels : ['bid1', 'ask1'])
    .map((l) => labelMap[l] ?? l).join(' / ');
  const modeHint = ({ both: '价格 + 数量', price: '只看价格', size: '只看数量' })[config.defaultTriggerMode] ?? '价格 + 数量';
  return [
    '👋 <b>Predict.fun 订单簿监控</b>',
    '',
    '直接发我下面任意一种，就开始监控：',
    '① <b>网址</b> — <code>https://predict.fun/...</code>',
    '② <b>marketId</b>（纯数字）— <code>272779</code>',
    '③ <b>slug</b> — <code>btc-eom-2026</code>',
    '',
    `<b>📐 默认监控档位</b>：${levelsHint}（<b>${modeHint}</b>）`,
    `<i>份额变动默认不推送；想看更多档位或量变，订阅后点 📐 档位 或用 /levels 修改。</i>`,
    '',
    `<b>📝 备注</b>：每个订阅可起昵称（如「主仓」「短期套利」）。`,
    `点订阅卡片上的 📝 备注 或用 <code>/note &lt;id&gt; &lt;文字&gt;</code> 设置；通知和列表里都会显示。`,
    '',
    `<b>🔗 标题链接</b>：点订阅卡片或通知里的市场<b>标题</b>就能跳转到 Predict.fun 对应页面。`,
    '',
    `⏱ 检查 ${config.pollIntervalMs}ms · 冷却 ${Math.round(config.notifyCooldownMs / 1000)}s`,
    `📐 价格阈值 ≥ ${config.priceEpsilon} · 量阈值 ≥ ${config.sizeAbsoluteMin} 张 / ${(config.sizeRelativeEpsilon * 100).toFixed(0)}%`,
  ].join('\n');
}

// Detailed command list — opened from the "❓ 命令列表" button on the
// welcome screen. Mirrors what setMyCommands registers but with the
// extra one-liner explanations.
const HELP_DETAIL = [
  '<b>📜 全部命令</b>',
  '',
  '/start, /help — 欢迎页（开始监控按钮）',
  '/watch — 批量订阅（回复消息粘贴多行 URL/id/slug）',
  '/list — 我的订阅（分页 + 操作按钮）',
  '/levels &lt;id&gt; — 自定义档位 + 触发模式（价+量 / 只看价 / 只看量）',
  '/note &lt;id&gt; [备注] — 设置备注（不带文字 = 清除）',
  '/history &lt;id&gt; [N] — 查看历史变动（默认最近 10 条）',
  '/export — 把整个 history.jsonl 发回给你',
  '/probe &lt;id&gt; — 立即抓一次订单簿（不等下次轮询）',
  '/speedtest [N] — 测延迟（默认 5 次），给出推荐的最快 POLL_INTERVAL_MS',
  '/stop &lt;id&gt; — 取消订阅（弹确认）',
  '/stopall — 取消全部订阅（弹确认）',
  '',
  '<b>📐 通知里的标记</b>',
  '👁 = 监控中的档位 · ↑/↓ = 价格或量的变化方向',
  '* = 当前订单簿表格里被监控的档位',
  '',
  '<b>🔗 标题链接</b>',
  '点订阅卡片或通知里的<b>市场标题</b>就能跳转到 Predict.fun 对应页面。',
].join('\n');

function welcomeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '👁 开始监控', callback_data: 'home:watch' },
        { text: '📋 我的订阅', callback_data: 'home:list' },
      ],
      [{ text: '❓ 命令列表', callback_data: 'home:help' }],
    ],
  };
}

// Parse a human duration like "30m", "2h", "1d" or a bare number (treated
// as minutes) into milliseconds. Returns null on invalid input.
function parseDurationMs(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([smhdSMHD])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? 'm').toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return mult ? Math.round(n * mult) : null;
}

function fmtRelativeRemaining(untilMs) {
  const sec = Math.max(0, Math.floor((untilMs - Date.now()) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
}

// Render one history entry as a compact 1-2 line block: timestamp +
// per-level prev→cur deltas. Uses bestBid/bestAsk only because that's
// what the JSONL records (we save the full top-3 for cur, but prev is
// just bestBid/bestAsk to keep entries small).
function fmtHistoryEntry(e) {
  const t = fmtClockTime(e.ts);
  const head = `<code>${t}</code>`;
  if (!e.prev) {
    const bb = e.cur?.bestBid;
    const ba = e.cur?.bestAsk;
    if (bb && ba) {
      return `${head}  🆕 初次 · 买1 ${bb.price.toFixed(4)} × ${bb.size} · 卖1 ${ba.price.toFixed(4)} × ${ba.size}`;
    }
    return `${head}  🆕 初次抓取`;
  }
  const fmtSideDiff = (label, p, c) => {
    if (!p && c) return `${label} 新挂 ${c.price.toFixed(4)}×${c.size}`;
    if (p && !c) return `${label} 撤 ${p.price.toFixed(4)}`;
    if (!p || !c) return null;
    const pieces = [];
    if (Math.abs(c.price - p.price) >= 1e-9) {
      const dp = c.price - p.price;
      const arrow = dp > 0 ? '↑' : '↓';
      pieces.push(`${p.price.toFixed(4)}→${c.price.toFixed(4)} ${arrow}${Math.abs(dp).toFixed(4)}`);
    }
    if (Math.abs(c.size - p.size) >= 1) {
      const ds = c.size - p.size;
      const fmt = Math.abs(ds).toLocaleString('en-US', { maximumFractionDigits: 0 });
      pieces.push(`量${ds > 0 ? '↑' : '↓'}${fmt}`);
    }
    if (!pieces.length) return null;
    return `${label} ${pieces.join(' ')}`;
  };
  const out = [];
  const bidLine = fmtSideDiff('买1', e.prev.bestBid, e.cur?.bestBid);
  const askLine = fmtSideDiff('卖1', e.prev.bestAsk, e.cur?.bestAsk);
  if (bidLine) out.push(bidLine);
  if (askLine) out.push(askLine);
  // Spread delta — only if both sides changed visibly.
  if (e.prev.bestBid && e.prev.bestAsk && e.cur?.bestBid && e.cur?.bestAsk) {
    const sp = e.prev.bestAsk.price - e.prev.bestBid.price;
    const sc = e.cur.bestAsk.price - e.cur.bestBid.price;
    if (Math.abs(sp - sc) >= 1e-9) {
      out.push(`价差 ${sp.toFixed(4)}→${sc.toFixed(4)}`);
    }
  }
  if (!out.length) return `${head}  深度变动`;
  // Single-line if short, two-line if multi-clause.
  return out.length === 1
    ? `${head}  ${out[0]}`
    : `${head}\n  ${out.join('\n  ')}`;
}

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
async function sendSubscribed(chatId, m, { wasExisting = false, askForNote = true } = {}) {
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
  const titleText = m.title || m.question || m.id;
  const linkSlug = m.slug || sub?.slug;
  const lines = [
    `${headerEmoji} <b>${headerText}</b>`,
    `🏷 ${marketLink(titleText, linkSlug)}`,
    `<code>id=${m.id}</code>`,
  ];
  if (sub?.note) lines.push(`📝 <i>${htmlEscape(sub.note)}</i>`);
  lines.push(`📐 档位：${levels.map((l) => LEVEL_LABEL[l]).join('/')} · 触发：${TRIGGER_LABEL[mode] ?? '价+量'}`);
  if (snap) {
    lines.push('');
    lines.push(fmtSpreadLine(snap));
    lines.push('');
    lines.push(fmtBook(null, snap, levels));
    // Suppress the "initial snapshot" alert on the next poll tick AND
    // persist the snapshot as the "vs 监控起点" baseline so notifications
    // can show cumulative deltas across restarts.
    primeSubscriptionSnapshot(chatId, m.id, snap);
    await saveState();
  } else {
    lines.push('', '<i>当前订单簿抓取失败 — 不影响订阅，下一轮轮询会自动重试。</i>');
  }
  await sendMessage(chatId, lines.join('\n'), { replyMarkup: subActionKeyboard(m.id) });

  // Auto follow-up: if the sub doesn't have a note yet, send a separate
  // ForceReply prompt asking for one. Mirrors the wallet-bot flow:
  // user fires the URL → orderbook shows up → "想加备注吗?" pops a
  // reply prompt. ForceReply doesn't block — user can ignore (just
  // send anything else and the prompt auto-dismisses) or click the
  // 📝 备注 button on the success card any time later instead.
  if (askForNote && !sub?.note && !wasExisting) {
    const promptText = [
      '📝 <b>给这条订阅加个备注？</b>',
      `<i>例如「主仓」「短期套利」「${htmlEscape((titleText || '').slice(0, 12))} 风险盘」</i>`,
      '',
      '<b>回复此条消息</b>发送文字保存；',
      '<b>忽略本条</b>即可跳过（也可随时点订阅卡片上的 📝 备注 再加）。',
    ].join('\n');
    try {
      const sent = await sendMessage(chatId, promptText, {
        replyMarkup: { force_reply: true, selective: true, input_field_placeholder: '备注（可空）' },
      });
      putPendingNote(chatId, sent.message_id, m.id);
      await saveState();
    } catch (err) {
      console.warn('[subscribed] note follow-up prompt failed:', err.message);
    }
  }
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

function buildChoiceKeyboard(token, matches, selected = []) {
  const sel = new Set(selected);
  const rows = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    // Number prefix + #id suffix disambiguates same-titled cards
    // (events with multiple sub-markets share Yes/No/Draw labels).
    // Telegram button text caps at ~64 chars; trim title to fit the
    // ✅/⬜ checkbox + prefix + id without overflow.
    const rawTitle = (m.title || m.question || `#${m.id}`).replace(/\s+/g, ' ').trim();
    const idSuffix = ` · #${m.id}`;
    const checkbox = sel.has(i) ? '✅' : '⬜';
    const titleBudget = 64 - 2 /* checkbox+space */ - String(i + 1).length - 2 - idSuffix.length;
    const title = rawTitle.length > titleBudget ? rawTitle.slice(0, titleBudget - 1) + '…' : rawTitle;
    rows.push([{ text: `${checkbox} ${i + 1}. ${title}${idSuffix}`, callback_data: `pick:${token}:t:${i}` }]);
  }
  rows.push([
    { text: '✅ 全选', callback_data: `pick:${token}:all` },
    { text: '⬜ 清空', callback_data: `pick:${token}:none` },
  ]);
  rows.push([
    { text: `✓ 完成 (${sel.size})`, callback_data: `pick:${token}:done` },
    { text: '✖ 取消', callback_data: `pick:${token}:cancel` },
  ]);
  return { inline_keyboard: rows };
}

function buildChoiceHeaderText(matches, selectedCount) {
  return [
    `🔎 识别出 <b>${matches.length}</b> 个市场卡片，请<b>勾选</b>要监控的：`,
    `<i>已选 <b>${selectedCount}</b> 个 · 可全选或多选 · 30 分钟内有效</i>`,
  ].join('\n');
}

// Single source of truth for the pick:<token>:<action> callback router.
// Actions: t:<idx> (toggle), all, none, done, cancel.
async function handlePickCallback(chatId, messageId, callbackId, token, action) {
  // 'cancel' / 'done' consume the entry; everything else just peeks.
  if (action === 'cancel') {
    takePendingChoice(chatId, token);
    await answerCallbackQuery(callbackId, { text: '已取消' });
    if (messageId) {
      try { await editMessageText(chatId, messageId, '✖ 已取消选择。'); } catch { /* old msg */ }
    }
    return;
  }

  const entry = peekPendingChoice(chatId, token);
  if (!entry) {
    await answerCallbackQuery(callbackId, { text: '选项已过期，请重新发送网址', showAlert: true });
    return;
  }
  const { matches } = entry;

  if (action === 'all') {
    entry.selected = matches.map((_, i) => i);
    await saveState();
    await answerCallbackQuery(callbackId, { text: `已全选 ${matches.length}` });
    await refreshChoiceKeyboard(chatId, messageId, token, matches, entry.selected);
    return;
  }
  if (action === 'none') {
    entry.selected = [];
    await saveState();
    await answerCallbackQuery(callbackId, { text: '已清空' });
    await refreshChoiceKeyboard(chatId, messageId, token, matches, entry.selected);
    return;
  }
  if (action.startsWith('t:')) {
    const idx = Number(action.slice(2));
    if (!Number.isInteger(idx) || idx < 0 || idx >= matches.length) {
      await answerCallbackQuery(callbackId);
      return;
    }
    const set = new Set(entry.selected);
    if (set.has(idx)) set.delete(idx); else set.add(idx);
    entry.selected = [...set].sort((a, b) => a - b);
    await saveState();
    await answerCallbackQuery(callbackId);
    await refreshChoiceKeyboard(chatId, messageId, token, matches, entry.selected);
    return;
  }
  if (action === 'done') {
    if (!entry.selected.length) {
      await answerCallbackQuery(callbackId, { text: '请先勾选至少一个市场', showAlert: true });
      return;
    }
    takePendingChoice(chatId, token);
    await answerCallbackQuery(callbackId, { text: `订阅 ${entry.selected.length} 个…` });
    await commitPickedSubscriptions(chatId, messageId, matches, entry.selected);
    return;
  }
  await answerCallbackQuery(callbackId);
}

async function refreshChoiceKeyboard(chatId, messageId, token, matches, selected) {
  if (!messageId) return;
  try {
    await editMessageText(
      chatId,
      messageId,
      buildChoiceHeaderText(matches, selected.length),
      buildChoiceKeyboard(token, matches, selected),
    );
  } catch { /* edit may fail on old messages — ignore */ }
}

async function commitPickedSubscriptions(chatId, messageId, matches, selectedIdx) {
  // Single pick → full sendSubscribed flow (orderbook + note prompt).
  // Multi-pick → batch addSubscription + one summary message; defer
  // baseline + note prompts to the natural per-tick flow.
  if (selectedIdx.length === 1) {
    const m = matches[selectedIdx[0]];
    const wasExisting = !!getSubscription(chatId, m.id);
    addSubscription({
      chatId,
      marketId: m.id,
      conditionId: m.conditionId,
      title: m.title || m.question || `Market ${m.id}`,
      slug: m.slug,
    });
    await saveState();
    if (messageId) {
      try { await editMessageText(chatId, messageId, `✅ 已订阅 1 个市场`); } catch { /* */ }
    }
    await sendSubscribed(chatId, m, { wasExisting });
    return;
  }
  // Batch path: subscribe each silently, then send one summary.
  const lines = [];
  let ok = 0;
  for (const idx of selectedIdx) {
    const m = matches[idx];
    try {
      addSubscription({
        chatId,
        marketId: m.id,
        conditionId: m.conditionId,
        title: m.title || m.question || `Market ${m.id}`,
        slug: m.slug,
      });
      const titleShort = (m.title || m.question || '').slice(0, 50);
      lines.push(`✓ <code>${m.id}</code> ${marketLink(titleShort, m.slug)}`);
      ok += 1;
    } catch (err) {
      lines.push(`✗ <code>${m.id}</code> ${htmlEscape(err.message).slice(0, 60)}`);
    }
  }
  await saveState();
  if (messageId) {
    try { await editMessageText(chatId, messageId, `✅ 已订阅 ${ok} 个市场（详见下条）`); } catch { /* */ }
  }
  await sendMessage(chatId, [
    `<b>📥 批量订阅完成</b>  ✓${ok} / ${selectedIdx.length}`,
    '',
    ...lines,
    '',
    `<i>下次轮询会自动设置「监控起点」基线，之后通知就能看到累计 Δ 了。</i>`,
    `/list 查看全部 · /watch 加更多`,
  ].join('\n'));
}

async function handleUrl(chatId, text, { initialNote = null } = {}) {
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
    // Stamp the URL's slug onto matches that don't carry their own.
    // Predict.fun's GraphQL doesn't expose categorySlug on Market,
    // so for event pages we use the parent (event) slug as the
    // clickable URL for every sub-market. Predict.fun resolves both
    // event and single-market URLs with the same /market/<slug>
    // path so clicking goes back to the user's source page.
    if (slug) {
      for (const m of matches) {
        if (!m.slug) m.slug = slug;
      }
    }
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
      putPendingChoice(chatId, token, suggestions, []);
      await saveState();
      await sendMessage(chatId, [
        `❓ 没找到完全匹配 slug=<code>${htmlEscape(slug)}</code>，下面是相似的市场：`,
        ``,
        buildChoiceHeaderText(suggestions, 0).split('\n').slice(1).join('\n'),
      ].join('\n'), { replyMarkup: buildChoiceKeyboard(token, suggestions, []) });
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
      note: initialNote ?? undefined,
    });
    await saveState();
    // Skip the auto note-prompt if the user already supplied one inline.
    await sendSubscribed(chatId, m, { wasExisting, askForNote: !initialNote });
    return;
  }
  const token = shortToken();
  putPendingChoice(chatId, token, matches, []);
  await saveState();
  await sendMessage(chatId, buildChoiceHeaderText(matches, 0), {
    replyMarkup: buildChoiceKeyboard(token, matches, []),
  });
}

async function handleCommand(chatId, text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  const c = cmd.split('@')[0].toLowerCase();
  if (c === '/start' || c === '/help') {
    await sendMessage(chatId, welcomeText(), { replyMarkup: welcomeKeyboard() });
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
    const lines = [
      `<b>📜 ${marketLink(events[0].title || `Market ${id}`, events[0].slug)}</b>`,
      `<i>最近 ${events.length} 条变动（新→旧）· /export 拿完整文件</i>`,
      '',
    ];
    for (const e of events) lines.push(fmtHistoryEntry(e));
    await sendMessage(chatId, lines.join('\n'));
    return true;
  }
  if (c === '/export') {
    // Filter to the calling chat only — /export used to dump the
    // global file (containing every chat's history). Privacy fix.
    // Cap pulls a generous N of recent events so even very busy chats
    // get exported without OOM-ing on a multi-MB file.
    const events = await readEvents({ chatId, limit: 50_000 });
    if (!events.length) {
      await sendMessage(chatId, '当前聊天没有历史记录可导出。');
      return true;
    }
    // readEvents returns newest→oldest; flip to chronological for the
    // exported file so a tail/cat reads time-ordered.
    const chronological = events.slice().reverse();
    const body = chronological.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const buf = Buffer.from(body, 'utf8');
    const fileName = `history-${chatId}-${new Date().toISOString().slice(0, 10)}.jsonl`;
    try {
      await sendDocument(chatId, {
        fileName,
        content: buf,
        contentType: 'application/x-ndjson',
        caption: `📦 当前聊天 ${events.length} 条 · ${(buf.length / 1024).toFixed(1)} KiB`,
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
  // /pause [duration]               — pause all subs in this chat
  // /pause <id> [duration]          — pause one sub
  // duration formats: 30m, 2h, 1d, or bare minutes; default 1h
  if (c === '/pause' || /^\/pause_\d+$/.test(c)) {
    let id, durRaw;
    if (/^\/pause_\d+$/.test(c)) {
      id = c.slice('/pause_'.length);
      durRaw = args[0];
    } else if (args.length === 0) {
      durRaw = null;
    } else if (/^\d+$/.test(args[0]) && parseDurationMs(args[0]) == null) {
      // Pure-numeric ID without duration unit (e.g. "/pause 272779")
      id = args[0];
      durRaw = args[1];
    } else if (/^\d+$/.test(args[0]) && args.length >= 2) {
      // "/pause 272779 2h"
      id = args[0];
      durRaw = args[1];
    } else {
      // "/pause 2h"  → all subs
      durRaw = args[0];
    }
    const durMs = parseDurationMs(durRaw) ?? 60 * 60 * 1000; // default 1h
    const untilMs = Date.now() + durMs;
    if (id) {
      const sub = getSubscription(chatId, id);
      if (!sub) {
        await sendMessage(chatId, `❌ 没有订阅 <code>${htmlEscape(id)}</code>`);
        return true;
      }
      setSubscriptionPause(chatId, id, untilMs);
      await saveState();
      await sendMessage(chatId, [
        `⏸ 已暂停 <code>${id}</code>`,
        `<i>${fmtRelativeRemaining(untilMs)}后自动恢复，期间不会推送变动通知。</i>`,
        `<i>提前恢复：/resume ${id}</i>`,
      ].join('\n'));
    } else {
      const n = pauseAllForChat(chatId, untilMs);
      if (!n) {
        await sendMessage(chatId, '当前没有订阅可暂停。');
        return true;
      }
      await saveState();
      await sendMessage(chatId, [
        `⏸ 已暂停全部 <b>${n}</b> 个订阅`,
        `<i>${fmtRelativeRemaining(untilMs)}后自动恢复。</i>`,
        `<i>提前恢复全部：/resume</i>`,
      ].join('\n'));
    }
    return true;
  }
  if (c === '/resume' || /^\/resume_\d+$/.test(c)) {
    let id = args[0];
    if (/^\/resume_\d+$/.test(c)) id = c.slice('/resume_'.length);
    if (id) {
      const sub = getSubscription(chatId, id);
      if (!sub) {
        await sendMessage(chatId, `❌ 没有订阅 <code>${htmlEscape(id)}</code>`);
        return true;
      }
      setSubscriptionPause(chatId, id, 0);
      await saveState();
      await sendMessage(chatId, `▶️ 已恢复 <code>${id}</code>，下次轮询会重新推送变动。`);
    } else {
      const subs = listSubscriptionsForChat(chatId).filter((s) => s.pausedUntil);
      for (const s of subs) setSubscriptionPause(chatId, s.marketId, 0);
      if (subs.length) await saveState();
      await sendMessage(chatId, subs.length
        ? `▶️ 已恢复 ${subs.length} 个暂停的订阅。`
        : '当前没有处于暂停状态的订阅。');
    }
    return true;
  }
  if (c === '/status') {
    const subs = listSubscriptionsForChat(chatId);
    const pausedCount = subs.filter((s) => s.pausedUntil && s.pausedUntil > Date.now()).length;
    const histStats = await fileStats();
    const histSize = histStats.exists ? `${(histStats.size / 1024).toFixed(1)} KiB` : '0';
    const lines = [
      '🟢 <b>Bot 正常运行</b>',
      '',
      `<b>订阅</b>: ${subs.length} 个${pausedCount ? ` (⏸ ${pausedCount} 暂停中)` : ''}`,
      `<b>轮询</b>: 每 ${config.pollIntervalMs}ms · 下限 ${config.pollMinIntervalMs}ms · 并发 ${config.pollConcurrency}`,
      `<b>冷却</b>: ${Math.round(config.notifyCooldownMs / 1000)}s`,
      `<b>价格阈值</b>: ≥ ${config.priceEpsilon}`,
      `<b>数量阈值</b>: ≥ ${config.sizeAbsoluteMin} 张 / ${(config.sizeRelativeEpsilon * 100).toFixed(0)}%`,
      `<b>新订阅默认</b>: ${(config.defaultLevels ?? []).map((l) => LEVEL_LABEL[l] ?? l).join('/')} · ${TRIGGER_LABEL[config.defaultTriggerMode] ?? '价+量'}`,
      `<b>历史记录</b>: ${config.historyEnabled ? `${histSize} (保留 ${config.historyKeepDays} 天)` : '已关闭'}`,
      `<b>状态文件</b>: <code>${htmlEscape(config.stateFile)}</code>`,
    ];
    await sendMessage(chatId, lines.join('\n'));
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

// Allowed-chat check. When ALLOWED_CHAT_IDS is empty the bot is open
// (legacy behaviour); when populated, every entry point gates on it.
function isAllowedChat(chatId) {
  if (chatId == null) return false;
  if (!config.allowedChatIds.length) return true;
  return config.allowedChatIds.includes(String(chatId));
}

async function denyChat(chatId) {
  try {
    await sendMessage(chatId, [
      '⛔ <b>此机器人未对当前聊天开放。</b>',
      '',
      `你的 chat ID: <code>${chatId}</code>`,
      `如需使用，请管理员把这个 ID 加到 <code>ALLOWED_CHAT_IDS</code> 环境变量。`,
    ].join('\n'));
  } catch { /* don't crash on send-fail */ }
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text ?? '').trim();
  if (!chatId || !text) return;
  if (!isAllowedChat(chatId)) { await denyChat(chatId); return; }

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

async function handleMarketIdInput(chatId, marketId, { initialNote = null } = {}) {
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
    note: initialNote ?? undefined,
  });
  await saveState();
  await sendSubscribed(chatId, m, { wasExisting, askForNote: !initialNote });
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
    const isPaused = s.pausedUntil && s.pausedUntil > Date.now();
    const dot = isPaused ? '⏸' : '🟢';
    const lines = [
      `${dot} <b>${marketLink(s.title || `Market ${s.marketId}`, s.slug)}</b>`,
      `<code>id=${s.marketId}</code>`,
      `档位：${levels} · 触发：${mode}`,
    ];
    if (isPaused) lines.push(`<i>⏸ 已暂停，${fmtRelativeRemaining(s.pausedUntil)}后恢复 · /resume_${s.marketId}</i>`);
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
    `<b>${marketLink(title, sub?.slug)}</b>  <code>id=${marketId}</code>`,
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
    '👁 <b>开始监控</b>',
    '',
    '<b>💡 格式示例</b>',
    '<code>https://predict.fun/zh-cn/market/foo</code>  — 单个市场',
    '<code>272779</code>                              — 直接用 marketId',
    '<code>btc-eom-2026</code>                        — 用 slug',
    '<code>spain 主仓</code>                          — 带备注',
    '<code>will-btc-100k - 长期持有</code>            — 带备注（<code>-</code> 分隔）',
    '<code>btc : 短期套利</code>                      — 带备注（<code>:</code> 分隔）',
    '',
    '📝 <b>回复此条消息</b>，每行一个 URL / marketId / slug',
    '可在后面跟备注（空格、<code>-</code> 或 <code>:</code> 分隔）。<b>不用再输入 /watch。</b>',
    '',
    '<i>30 分钟内有效；URL 是事件页时会跳过提示让你单独发送以选择子市场。</i>',
  ].join('\n');
  const sent = await sendMessage(chatId, text, {
    replyMarkup: { force_reply: true, selective: true, input_field_placeholder: 'URL/id/slug [备注]' },
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

  // Single-line shortcut: route through the standard handlers so the
  // user gets the orderbook + auto-note follow-up just like a direct
  // URL paste. Multi-line input keeps the bulk-results message below.
  if (lines.length === 1) {
    const { target, note } = parseWatchLine(lines[0]);
    const id = extractMarketId(target);
    if (id) {
      await handleMarketIdInput(chatId, id, { initialNote: note });
    } else {
      await handleUrl(chatId, target, { initialNote: note });
    }
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
  if (!isAllowedChat(chatId)) {
    try { await answerCallbackQuery(cb.id, { text: '此聊天未授权使用本机器人', showAlert: true }); } catch {}
    return;
  }
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
            `🏷 ${marketLink(sub.title || `Market ${id}`, sub.slug)}`,
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
        `🟢 <b>${marketLink(sub.title || `Market ${sub.marketId}`, sub.slug)}</b>`,
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

  // Welcome-screen entry buttons (also reachable via the
  // pagination footer's 👁 批量加 shortcut for the watch flow).
  if (data === 'home:watch') {
    await answerCallbackQuery(cb.id);
    await promptBulkWatch(chatId);
    return;
  }
  if (data === 'home:list') {
    await answerCallbackQuery(cb.id);
    await renderListView(chatId);
    return;
  }
  if (data === 'home:help') {
    await answerCallbackQuery(cb.id);
    await sendMessage(chatId, HELP_DETAIL);
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
    const action = pickMatch[2];
    await handlePickCallback(chatId, messageId, cb.id, token, action);
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
  // Telegram menu (the / dropdown). /help still works as a text
  // command via the handler, but it's omitted from the menu since
  // /start now serves the same welcome screen.
  await setMyCommands([
    { command: 'start',     description: '主页 · 开始监控' },
    { command: 'watch',     description: '批量订阅（粘贴多行 URL/id/slug）' },
    { command: 'list',      description: '我的订阅（分页 + 操作按钮）' },
    { command: 'levels',    description: '改档位 + 触发模式' },
    { command: 'note',      description: '加 / 改备注' },
    { command: 'probe',     description: '立即抓一次盘口' },
    { command: 'history',   description: '查看历史变动' },
    { command: 'pause',     description: '暂停推送（默认 1h）' },
    { command: 'resume',    description: '恢复推送' },
    { command: 'status',    description: 'Bot 健康状态' },
    { command: 'export',    description: '导出 history.jsonl' },
    { command: 'speedtest', description: '测抓取延迟' },
    { command: 'stop',      description: '取消单个订阅' },
    { command: 'stopall',   description: '取消全部订阅' },
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
