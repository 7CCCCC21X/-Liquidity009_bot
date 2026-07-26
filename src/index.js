import { config, requireConfig } from './config.js';
import { getUpdates, sendMessage, editMessageText, sendDocument, answerCallbackQuery, setMyCommands, getMe, htmlEscape } from './telegram.js';
import { readEvents, readDigests, readWholeFile, fileStats, maybePrune } from './history.js';
import {
  loadState, saveState, getState,
  addSubscription, removeSubscription, listSubscriptionsForChat,
  getSubscription, updateSubscriptionLevels, updateSubscriptionNote,
  updateSubscriptionTriggerMode, setSubscriptionPause, pauseAllForChat,
  setSubscriptionThresholds,
  putPendingChoice, peekPendingChoice, takePendingChoice, gcPendingChoices,
  putPendingNote, takePendingNote, gcPendingNotes,
  putPendingWatch, takePendingWatch, gcPendingWatch,
  putPendingPrompt, takePendingPrompt, gcPendingPrompts,
  getChatSettings, setChatDigest, setChatQuiet, isChatInQuietHours,
  setChatDigestOnly, isChatDigestOnly,
  setChatDefaultLevels, setChatDefaultTriggerMode, setChatDefaultCooldown,
  putPendingBulkRetry, takePendingBulkRetry, gcPendingBulkRetry,
  markChatDigestLogQuery, getChatDigestLogLastQueryAt,
  ALL_LEVELS, LEVEL_LABEL, TRIGGER_MODES, TRIGGER_LABEL,
} from './state.js';
import { extractSlugFromUrl, extractMarketId, resolveUrlToMarkets, fuzzySlugSuggestions, getMarketById, getOrderbook } from './predict.js';
import { fmtBook, fmtSpreadLine, subActionKeyboard, primeSubscriptionSnapshot, marketLink, fmtClockTime, fmtClockDateTime, sendDigestForChat, effectiveThresholds, deriveEventTitle, getLatestSnapForSub } from './monitor.js';
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
  '/note &lt;id&gt; — 弹输入框输入备注（或 /note &lt;id&gt; 文字 直接设；/note &lt;id&gt; - 清除）',
  '/digest [时长] — 定期摘要，例 <code>/digest 30m</code>；不带参数显示当前 + 立即来一份',
  '/digestlog — 回看时间窗内有变动的市场（去重后汇总；显示上次查询时间，<code>/digestlog last</code> 直接看上次查询以来；加 <code>full</code> 看每份摘要原文）',
  '/digestonly [on|off] — 只发摘要，静音即时提醒（不带参数 = 切换）',
  '/quiet &lt;HH:MM-HH:MM&gt; — 勿扰时段（例 23:00-08:00），勿扰期间只写历史不推送',
  '/settings — 聊天设置面板（默认档位 / 默认触发 / 默认冷却 / 摘要 / 勿扰）',
  '/threshold &lt;id&gt; — 改该市场的灵敏度（🔕 低噪 / ⚖️ 平衡 / 🔔 高频 / 🌐 全局）',
  '/stats &lt;id&gt; [小时] — 该市场近 N 小时统计：触发次数 / 最大 Δ价 / 最大 Δ量 / 价差',
  '/history &lt;id&gt; [N] — 查看历史变动（默认最近 10 条）',
  '/movers [时长] [N] — 近期变动最大的市场排序，例 <code>/movers 24h</code>（默认 24h，最多列 N=20）',
  '/stale [N] — 买1/卖1 停滞最久的市场排行（盘口最稳、最不易被插队；辅助判断挂 Yes/No，默认 N=20，别名 /idle）',
  '/export — 把整个 history.jsonl 发回给你',
  '/probe &lt;id&gt; — 立即抓一次订单簿（不等下次轮询）',
  '/speedtest [N] — 测延迟（默认 5 次），给出推荐的最快 POLL_INTERVAL_MS',
  '/stop [id] — 取消订阅（不带 id 时回复网址，弹出确认/选项）',
  '/stopall — 取消全部订阅（弹确认）',
  '/resetthresholds — 把所有订阅的阈值改回全局默认（弹确认）',
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

function fmtMinOfDay(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtRelativeRemaining(untilMs) {
  const sec = Math.max(0, Math.floor((untilMs - Date.now()) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
}

// Human-readable elapsed duration (a span, not a countdown). Used by
// /stale to render how long a market's 买1/卖1 has gone unchanged.
function fmtElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 ? `${hr}小时${min % 60}分` : `${hr}小时`;
  const d = Math.floor(hr / 24);
  return hr % 24 ? `${d}天${hr % 24}小时` : `${d}天`;
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

// Threshold presets — per-sub sensitivity profiles overriding the env
// defaults. 'global' resets the sub to use env-only.
const THRESHOLD_PRESETS = {
  low: {
    label: '🔕 低噪音',
    priceEpsilon: 0.02, sizeAbsoluteMin: 500, sizeRelativeEpsilon: 0.30,
    notifyCooldownMs: 5 * 60_000,
  },
  balanced: {
    label: '⚖️ 平衡',
    priceEpsilon: 0.005, sizeAbsoluteMin: 50, sizeRelativeEpsilon: 0.10,
    notifyCooldownMs: 60_000,
  },
  high: {
    label: '🔔 高频',
    priceEpsilon: 0.001, sizeAbsoluteMin: 10, sizeRelativeEpsilon: 0.05,
    notifyCooldownMs: 10_000,
  },
};

function detectThresholdPreset(sub) {
  const t = sub?.thresholds;
  if (!t) return 'global';
  for (const [name, p] of Object.entries(THRESHOLD_PRESETS)) {
    if (t.priceEpsilon === p.priceEpsilon
        && t.sizeAbsoluteMin === p.sizeAbsoluteMin
        && t.sizeRelativeEpsilon === p.sizeRelativeEpsilon
        && t.notifyCooldownMs === p.notifyCooldownMs) return name;
  }
  return 'custom';
}

function buildThresholdKeyboard(marketId, currentPreset) {
  const mark = (key) => (currentPreset === key ? '🟢 ' : '');
  return {
    inline_keyboard: [
      [
        { text: mark('low') + THRESHOLD_PRESETS.low.label, callback_data: `thresh:${marketId}:low` },
        { text: mark('balanced') + THRESHOLD_PRESETS.balanced.label, callback_data: `thresh:${marketId}:balanced` },
        { text: mark('high') + THRESHOLD_PRESETS.high.label, callback_data: `thresh:${marketId}:high` },
      ],
      [
        { text: (currentPreset === 'global' ? '🟢 ' : '') + '🌐 用全局默认', callback_data: `thresh:${marketId}:global` },
      ],
    ],
  };
}

function thresholdHeader(sub) {
  const eff = effectiveThresholds(sub);
  const preset = detectThresholdPreset(sub);
  const presetLabel = {
    low: '🔕 低噪音',
    balanced: '⚖️ 平衡',
    high: '🔔 高频',
    global: '🌐 全局默认',
    custom: '⚙️ 自定义',
  }[preset];
  return [
    `<b>🎚 灵敏度设置</b>`,
    htmlEscape(sub.title || `Market ${sub.marketId}`),
    `<code>id=${sub.marketId}</code>`,
    '',
    `当前预设：<b>${presetLabel}</b>`,
    `<i>价 ≥ ${eff.priceEpsilon} · 量 ≥ ${eff.sizeAbsoluteMin} 张 / ${(eff.sizeRelativeEpsilon * 100).toFixed(0)}% · 冷却 ${Math.round(eff.notifyCooldownMs / 1000)}s</i>`,
    '',
    '<b>预设说明</b>',
    '<code>🔕 低噪音</code>  价 0.02 · 量 500/30% · 冷却 5m  （热门市场只看大波动）',
    '<code>⚖️ 平衡  </code>  价 0.005 · 量 50/10% · 冷却 1m  （默认）',
    '<code>🔔 高频  </code>  价 0.001 · 量 10/5%  · 冷却 10s （小盘做市）',
    '<code>🌐 全局  </code>  跟 Railway env 走（重置）',
  ].join('\n');
}

// Render the "📝 …" line that appears under titles in /list, alert,
// probe, subscribe-success, etc. Returns null when there's nothing to
// show. Tags come before note text and are rendered as hashtags so
// /list #tag filters and the chat-side search both stay obvious.
// /list search predicate. `#tag` form filters exactly on sub.tags
// (case-insensitive); anything else does substring on title / note /
// marketId. Tags + plain text can be mixed: "#主仓 btc" matches subs
// tagged 主仓 AND whose title/note/id contain "btc".
function filterSubsBySearch(subs, search) {
  if (!search) return subs;
  const tokens = String(search).split(/\s+/).filter(Boolean);
  const tagFilters = [];
  const textFilters = [];
  for (const t of tokens) {
    if (t.startsWith('#') && t.length > 1) tagFilters.push(t.slice(1).toLowerCase());
    else textFilters.push(t.toLowerCase());
  }
  return subs.filter((s) => {
    const tagsLower = (s.tags ?? []).map((x) => String(x).toLowerCase());
    for (const t of tagFilters) {
      if (!tagsLower.includes(t)) return false;
    }
    for (const t of textFilters) {
      const hay = `${(s.title || '').toLowerCase()} ${(s.note || '').toLowerCase()} ${s.marketId}`;
      if (!hay.includes(t)) return false;
    }
    return true;
  });
}

function fmtNoteLine(sub) {
  const tags = Array.isArray(sub?.tags) ? sub.tags : [];
  const note = sub?.note ? String(sub.note) : '';
  if (!tags.length && !note) return null;
  const tagStr = tags.length ? tags.map((t) => `#${htmlEscape(t)}`).join(' ') : '';
  if (tagStr && note) return `📝 <i>${tagStr} ${htmlEscape(note)}</i>`;
  if (tagStr) return `📝 <i>${tagStr}</i>`;
  return `📝 <i>${htmlEscape(note)}</i>`;
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
  ];
  // Event question (parent title) shown when distinct from option label.
  {
    const q = (m.question || '').trim();
    const t = (titleText || '').trim();
    if (q && q !== t) {
      const trimmed = q.length > 120 ? `${q.slice(0, 117)}…` : q;
      lines.push(`<i>${htmlEscape(trimmed)}</i>`);
    }
  }
  lines.push(`<code>id=${m.id}</code>`);
  { const nl = fmtNoteLine(sub); if (nl) lines.push(nl); }
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

function buildChoiceKeyboard(token, matches, selected = [], existingIds = new Set(), mode = 'sub') {
  const sel = new Set(selected);
  const rows = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    // Number prefix + #id suffix disambiguates same-titled cards
    // (events with multiple sub-markets share Yes/No/Draw labels).
    // 🟢 suffix flags markets the user already has a subscription for
    // — clicking such a row "re-subscribes" but addSubscription
    // preserves the existing levels/note/triggerMode.
    // Telegram button text caps at ~64 chars; trim title to fit.
    const rawTitle = (m.title || m.question || `#${m.id}`).replace(/\s+/g, ' ').trim();
    const idSuffix = ` · #${m.id}`;
    const checkbox = sel.has(i) ? '✅' : '⬜';
    const monitoringSuffix = existingIds.has(String(m.id)) ? ' 🟢' : '';
    const titleBudget = 64 - 2 /* checkbox+space */ - String(i + 1).length - 2
                          - idSuffix.length - monitoringSuffix.length;
    const title = rawTitle.length > titleBudget ? rawTitle.slice(0, titleBudget - 1) + '…' : rawTitle;
    rows.push([{
      text: `${checkbox} ${i + 1}. ${title}${idSuffix}${monitoringSuffix}`,
      callback_data: `pick:${token}:t:${i}`,
    }]);
  }
  rows.push([
    { text: '✅ 全选', callback_data: `pick:${token}:all` },
    { text: '⬜ 清空', callback_data: `pick:${token}:none` },
  ]);
  rows.push([
    {
      text: mode === 'unsub' ? `🛑 取消所选 (${sel.size})` : `✓ 完成 (${sel.size})`,
      callback_data: `pick:${token}:done`,
    },
    { text: '✖ 取消', callback_data: `pick:${token}:cancel` },
  ]);
  return { inline_keyboard: rows };
}

function buildChoiceHeaderText(matches, selectedCount, existingCount = 0, mode = 'sub') {
  if (mode === 'unsub') {
    return [
      `🛑 这个事件里你订阅了 <b>${matches.length}</b> 个市场，请<b>勾选</b>要取消的：`,
      `<i>已选 <b>${selectedCount}</b> 个 · 30 分钟内有效</i>`,
    ].join('\n');
  }
  const existingHint = existingCount
    ? ` · 🟢 ${existingCount} 个已在监控（再次勾选会刷新信息，不会动档位/备注）`
    : '';
  return [
    `🔎 识别出 <b>${matches.length}</b> 个市场卡片，请<b>勾选</b>要监控的：`,
    `<i>已选 <b>${selectedCount}</b> 个${existingHint} · 30 分钟内有效</i>`,
  ].join('\n');
}

// Helper: which marketIds in this match list are already subscribed
// in this chat. Recomputed on every render so it stays current after
// the user stops a sub from a different message during the picker
// session.
function existingMatchIds(chatId, matches) {
  const out = new Set();
  for (const m of matches) {
    if (getSubscription(chatId, m.id)) out.add(String(m.id));
  }
  return out;
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
  const mode = entry.mode === 'unsub' ? 'unsub' : 'sub';

  if (action === 'all') {
    entry.selected = matches.map((_, i) => i);
    await saveState();
    await answerCallbackQuery(callbackId, { text: `已全选 ${matches.length}` });
    await refreshChoiceKeyboard(chatId, messageId, token, matches, entry.selected, mode);
    return;
  }
  if (action === 'none') {
    entry.selected = [];
    await saveState();
    await answerCallbackQuery(callbackId, { text: '已清空' });
    await refreshChoiceKeyboard(chatId, messageId, token, matches, entry.selected, mode);
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
    await refreshChoiceKeyboard(chatId, messageId, token, matches, entry.selected, mode);
    return;
  }
  if (action === 'done') {
    if (!entry.selected.length) {
      await answerCallbackQuery(callbackId, { text: '请先勾选至少一个市场', showAlert: true });
      return;
    }
    takePendingChoice(chatId, token);
    if (mode === 'unsub') {
      await answerCallbackQuery(callbackId, { text: `取消 ${entry.selected.length} 个…` });
      await commitPickedUnsubscriptions(chatId, messageId, matches, entry.selected);
      return;
    }
    await answerCallbackQuery(callbackId, { text: `订阅 ${entry.selected.length} 个…` });
    await commitPickedSubscriptions(chatId, messageId, matches, entry.selected);
    return;
  }
  await answerCallbackQuery(callbackId);
}

async function refreshChoiceKeyboard(chatId, messageId, token, matches, selected, mode = 'sub') {
  if (!messageId) return;
  const existingIds = existingMatchIds(chatId, matches);
  try {
    await editMessageText(
      chatId,
      messageId,
      buildChoiceHeaderText(matches, selected.length, existingIds.size, mode),
      buildChoiceKeyboard(token, matches, selected, existingIds, mode),
    );
  } catch { /* edit may fail on old messages — ignore */ }
}

// 完成 in unsub mode — remove every picked subscription and replace
// the picker message with a summary.
async function commitPickedUnsubscriptions(chatId, messageId, matches, selectedIdx) {
  const lines = [];
  let removed = 0;
  for (const idx of selectedIdx) {
    const m = matches[idx];
    if (!m) continue;
    if (removeSubscription(chatId, m.id)) {
      removed += 1;
      const titleShort = (m.title || m.question || '').replace(/\s+/g, ' ').slice(0, 50);
      lines.push(`✓ <code>${m.id}</code> ${htmlEscape(titleShort)}`);
    } else {
      lines.push(`✗ <code>${m.id}</code> 订阅已不存在`);
    }
  }
  if (removed) await saveState();
  const summary = [
    `🛑 <b>已取消 ${removed} 个订阅</b>`,
    '',
    ...lines,
    '',
    '<i>历史记录保留；重新发送网址可再次订阅。</i>',
  ].join('\n');
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, summary);
      return;
    } catch { /* old message — fall through to a fresh send */ }
  }
  await sendMessage(chatId, summary);
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
      question: m.question ?? null,
      slug: m.slug,
    });
    await saveState();
    if (messageId) {
      try { await editMessageText(chatId, messageId, `✅ 已订阅 1 个市场`); } catch { /* */ }
    }
    await sendSubscribed(chatId, m, { wasExisting });
    return;
  }
  // Batch path: subscribe each silently, then prime baselines in
  // parallel so the next poll doesn't fire N "🆕 初次抓取" alerts
  // for the batch. Finally send one summary message.
  const lines = [];
  const toPrime = [];
  let ok = 0;
  for (const idx of selectedIdx) {
    const m = matches[idx];
    try {
      addSubscription({
        chatId,
        marketId: m.id,
        conditionId: m.conditionId,
        title: m.title || m.question || `Market ${m.id}`,
        question: m.question ?? null,
        slug: m.slug,
      });
      const titleShort = (m.title || m.question || '').slice(0, 50);
      lines.push(`✓ <code>${m.id}</code> ${marketLink(titleShort, m.slug)}`);
      ok += 1;
      if (m.conditionId) toPrime.push(m);
    } catch (err) {
      lines.push(`✗ <code>${m.id}</code> ${htmlEscape(err.message).slice(0, 60)}`);
    }
  }
  await saveState();
  // Fetch each market's orderbook in parallel and prime baselines.
  // Failures here are non-fatal — the next monitor tick will backfill
  // sub.initial automatically via the existing fallback path.
  const primed = await Promise.allSettled(toPrime.map(async (m) => {
    const market = { id: m.id, conditionId: m.conditionId };
    const snap = await getOrderbook(market);
    primeSubscriptionSnapshot(chatId, m.id, snap);
    return m.id;
  }));
  const primedCount = primed.filter((r) => r.status === 'fulfilled').length;
  if (primedCount) await saveState();
  if (messageId) {
    try { await editMessageText(chatId, messageId, `✅ 已订阅 ${ok} 个市场（详见下条）`); } catch { /* */ }
  }
  await sendMessage(chatId, [
    `<b>📥 批量订阅完成</b>  ✓${ok} / ${selectedIdx.length}`,
    '',
    ...lines,
    '',
    primedCount === toPrime.length
      ? `<i>已抓取 ${primedCount} 个市场的初始盘口作为「监控起点」，价格变动时会显示累计 Δ。</i>`
      : `<i>${primedCount}/${toPrime.length} 个市场基线已建立；其余下次轮询自动补。</i>`,
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
      const existingIds = existingMatchIds(chatId, suggestions);
      await sendMessage(chatId, [
        `❓ 没找到完全匹配 slug=<code>${htmlEscape(slug)}</code>，下面是相似的市场：`,
        ``,
        buildChoiceHeaderText(suggestions, 0, existingIds.size).split('\n').slice(1).join('\n'),
      ].join('\n'), { replyMarkup: buildChoiceKeyboard(token, suggestions, [], existingIds) });
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
      question: m.question ?? null,
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
  const existingIds = existingMatchIds(chatId, matches);
  await sendMessage(chatId, buildChoiceHeaderText(matches, 0, existingIds.size), {
    replyMarkup: buildChoiceKeyboard(token, matches, [], existingIds),
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
    // /list compact → single-message overview (best when many subs)
    // /list paused  → only paused subs
    // /list <text>  → filter by title/note substring
    // /list (default) → paginated cards
    const filter = args[0];
    if (filter === 'compact') return await renderListCompact(chatId, args.slice(1).join(' ')), true;
    if (filter === 'paused') return await renderListView(chatId, 0, { onlyPaused: true }), true;
    if (filter) return await renderListView(chatId, 0, { search: args.join(' ') }), true;
    await renderListView(chatId);
    return true;
  }
  if (c === '/probe' || /^\/probe_\d+$/.test(c)) {
    let id = args[0];
    if (!id && /^\/probe_\d+$/.test(c)) id = c.slice('/probe_'.length);
    if (!id) {
      await promptCommandTarget(chatId, 'probe', {
        headline: '<b>🔍 即时抓取</b>  <i>回复要抓的市场</i>',
      });
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
      await promptCommandTarget(chatId, 'levels', {
        headline: '<b>📐 改档位 + 触发模式</b>  <i>回复要改的市场</i>',
      });
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
      // No id → prompt the user to reply with URL/id/slug.
      await promptCommandTarget(chatId, 'history', {
        args: { n: Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 10 },
        headline: '<b>📜 历史变动</b>  <i>回复要查的市场</i>',
      });
      return true;
    }
    if (!Number.isFinite(n) || n <= 0) n = 10;
    n = Math.min(50, Math.floor(n));
    await runHistoryView(chatId, id, n);
    return true;
  }
  if (c === '/movers' || c === '/top') {
    // 近期变动最大的市场排序：scan this chat's change history over a
    // time window (default 24h) and rank markets by how far top-of-book
    // moved from the window's start to its end. Optional second arg caps
    // how many rows to show.
    let windowMs = parseDurationMs(args[0]);
    let windowLabel = args[0];
    if (!windowMs) { windowMs = 24 * 3_600_000; windowLabel = '24h'; }
    const topN = Math.max(1, Math.min(100, Number(args[1]) || 20));
    await runMoversView(chatId, { windowMs, windowLabel, topN });
    return true;
  }
  if (c === '/stale' || c === '/idle' || c === '/停滞') {
    // 买1/卖1 停滞排行：rank monitored markets by how long their
    // top-of-book has gone unchanged, so the user can spot the most
    // "frozen" books and decide which side (Yes/No) to provide.
    const topN = Math.max(1, Math.min(100, Number(args[0]) || 20));
    await runStaleView(chatId, { topN });
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
      // No id → reply-with-URL flow, mirroring the wallet bot UX:
      // reply to the prompt with a market URL/id/slug and the bot
      // resolves it, then shows cancel buttons.
      await promptCommandTarget(chatId, 'stop', {
        headline: '🛑 <b>取消订阅</b>',
        hint: '<b>📝 回复此条消息</b>，发送要取消的市场 URL / marketId / slug；解析后会弹出确认按钮。',
        placeholder: 'URL/id/slug',
      });
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
    // Disambiguation rule: if the first arg is a bare number AND it
    // matches an existing subscription's marketId, treat as
    // /pause <id> [duration]. Otherwise it's /pause <duration>
    // applied to all subs (bare numbers default to minutes via
    // parseDurationMs). Without this check, "/pause 272779" gets
    // misread as "pause everyone for 272779 minutes (~189 days)".
    let id = null, durRaw = null;
    if (/^\/pause_\d+$/.test(c)) {
      id = c.slice('/pause_'.length);
      durRaw = args[0];
    } else if (args.length === 0) {
      // /pause → pause all for default 1h
    } else if (/^\d+$/.test(args[0]) && getSubscription(chatId, args[0])) {
      id = args[0];
      durRaw = args[1];
    } else {
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
  if (c === '/threshold' || /^\/threshold_\d+$/.test(c)) {
    let id = args[0];
    if (/^\/threshold_\d+$/.test(c)) id = c.slice('/threshold_'.length);
    if (!id) {
      await promptCommandTarget(chatId, 'threshold', {
        headline: '<b>🎚 改阈值</b>  <i>回复要改的市场</i>',
      });
      return true;
    }
    const sub = getSubscription(chatId, id);
    if (!sub) {
      await sendMessage(chatId, `❌ 没有订阅 <code>${htmlEscape(id)}</code>`);
      return true;
    }
    const preset = detectThresholdPreset(sub);
    await sendMessage(chatId, thresholdHeader(sub), {
      replyMarkup: buildThresholdKeyboard(id, preset),
    });
    return true;
  }
  if (c === '/stats' || /^\/stats_\d+$/.test(c)) {
    let id = args[0];
    if (/^\/stats_\d+$/.test(c)) id = c.slice('/stats_'.length);
    if (!id) {
      const hours = Math.max(1, Math.min(24 * 30, Number(args[0]) || 24));
      await promptCommandTarget(chatId, 'stats', {
        args: { hours },
        headline: `<b>📊 市场统计</b>  <i>回复要查的市场（窗口 ${hours}h）</i>`,
      });
      return true;
    }
    const hours = Math.max(1, Math.min(24 * 30, Number(args[1] ?? args[0]) || 24));
    await runStats(chatId, id, hours);
    return true;
  }
  if (c === '/settings') {
    await renderSettingsPanel(chatId);
    return true;
  }
  if (c === '/quiet') {
    const arg = args[0];
    const settings = getChatSettings(chatId);
    if (!arg) {
      const cur = (settings?.quietStartMin != null && settings?.quietEndMin != null)
        ? `${fmtMinOfDay(settings.quietStartMin)}-${fmtMinOfDay(settings.quietEndMin)}`
        : '未设置';
      const inside = isChatInQuietHours(chatId);
      await sendMessage(chatId, [
        `<b>🌙 勿扰时段</b>  (${config.displayTzLabel || config.displayTz})`,
        `当前：${cur}${inside ? ' · <b>正在勿扰中</b>' : ''}`,
        '',
        '<b>用法</b>',
        '<code>/quiet 23:00-08:00</code>  — 跨天勿扰',
        '<code>/quiet 12:00-14:00</code>  — 中午勿扰',
        '<code>/quiet off</code>          — 关闭',
        '',
        '<i>勿扰期间订单簿变化只写历史、不发即时通知；用 /digest 或 /history 回看。</i>',
      ].join('\n'));
      return true;
    }
    if (arg === 'off' || arg === '0') {
      setChatQuiet(chatId, null, null);
      await saveState();
      await sendMessage(chatId, '✓ 已关闭勿扰时段。');
      return true;
    }
    const m = arg.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) {
      await sendMessage(chatId, '用法：<code>/quiet 23:00-08:00</code> 或 <code>/quiet off</code>');
      return true;
    }
    const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
    if (sh > 23 || sm > 59 || eh > 23 || em > 59) {
      await sendMessage(chatId, '❌ 小时 0-23、分钟 0-59');
      return true;
    }
    setChatQuiet(chatId, sh * 60 + sm, eh * 60 + em);
    await saveState();
    await sendMessage(chatId, `🌙 已设勿扰 <b>${sh.toString().padStart(2,'0')}:${m[2]}-${eh.toString().padStart(2,'0')}:${m[4]}</b> (${config.displayTzLabel || config.displayTz})\n<i>勿扰期间订单簿变化只写历史，不发即时通知。</i>`);
    return true;
  }
  if (c === '/digest') {
    // /digest                — show current setting + send one now
    // /digest <duration>     — enable periodic digest (e.g. 30m, 2h)
    // /digest off            — disable
    const arg = args[0];
    const settings = getChatSettings(chatId);
    if (!arg) {
      const cur = settings?.digestIntervalMs ?? 0;
      const note = cur > 0
        ? `当前：每 ${fmtRelativeRemaining(Date.now() + cur)} 推送一次摘要`
        : `当前：未开启`;
      await sendMessage(chatId, [
        `<b>📋 定期摘要</b>`,
        note,
        '',
        '<b>用法</b>',
        '<code>/digest 30m</code> — 每 30 分钟一次',
        '<code>/digest 2h</code>  — 每 2 小时一次',
        '<code>/digest 1d</code>  — 每 24 小时一次',
        '<code>/digest off</code> — 关闭',
        '',
        '<i>摘要会列出所有订阅的最新买1/卖1，避免长时间没消息时遗漏盘口。</i>',
      ].join('\n'));
      // Also fire one immediately if user just types /digest. The
      // sendDigestForChat mutates each sub's digestBaseline, so we
      // need to persist after.
      if (cur > 0) {
        await sendDigestForChat(chatId);
        await saveState();
      }
      return true;
    }
    if (arg === 'off' || arg === '0') {
      setChatDigest(chatId, 0);
      await saveState();
      await sendMessage(chatId, '✓ 已关闭定期摘要。');
      return true;
    }
    const ms = parseDurationMs(arg);
    if (!ms || ms < 60_000) {
      await sendMessage(chatId, '❌ 请输入有效时长（最小 1m），如 <code>30m</code> / <code>2h</code> / <code>1d</code>。');
      return true;
    }
    setChatDigest(chatId, ms);
    await saveState();
    await sendMessage(chatId, [
      `✓ 已开启定期摘要：每 <b>${fmtRelativeRemaining(Date.now() + ms)}</b> 推送一次。`,
      '',
      '<i>取消：/digest off · 改频率：/digest 新时长 · 立即触发一次：再发 /digest 即可。</i>',
    ].join('\n'));
    return true;
  }
  if (c === '/digestlog') {
    // Back-compat: bare number still works as a count cap. With no
    // args, surface the picker card so the user can choose a time
    // window without remembering syntax.
    if (args.length === 0) {
      await sendDigestLogPicker(chatId);
      return true;
    }
    // Optional 'full' suffix re-enables per-digest replay before the
    // aggregate (default is aggregate-only since the user just wants
    // "what moved in this window").
    const full = args.includes('full');
    const tArgs = args.filter((a) => a !== 'full');
    const arg = tArgs[0];
    if (arg === 'last' || arg === '上次') {
      // /digestlog last — text shortcut for the 自上次查询以来 button.
      const lastAt = getChatDigestLogLastQueryAt(chatId);
      if (!lastAt) {
        await sendMessage(chatId, '<i>还没有上次查询记录 — 先用 <code>/digestlog 6h</code> 之类查一次，之后就能用 <code>/digestlog last</code> 补看这之后的变动。</i>');
        return true;
      }
      await runDigestLog(chatId, {
        sinceMs: lastAt,
        windowLabel: `上次查询以来（${fmtClockDateTime(lastAt)} 起，${fmtElapsed(Date.now() - lastAt)}）`,
        full,
      });
      return true;
    }
    const asNum = parseInt(arg, 10);
    if (Number.isFinite(asNum) && /^\d+$/.test(arg)) {
      await runDigestLog(chatId, { count: Math.max(1, Math.min(500, asNum)), full });
      return true;
    }
    const ms = parseDurationMs(arg);
    if (!ms) {
      await sendMessage(chatId, '❌ 用法：<code>/digestlog</code>（弹卡片选）· <code>/digestlog 6h</code>（汇总 6 小时变动）· <code>/digestlog last</code>（上次查询以来）· 加 <code>full</code> 同时回放每一份摘要');
      return true;
    }
    await runDigestLog(chatId, { sinceMs: Date.now() - ms, windowLabel: arg, full });
    return true;
  }
  if (c === '/diagq') {
    // Diagnose digest-grouping: report question coverage for this
    // chat's subs and probe Predict.fun for a few that are missing it.
    const subs = listSubscriptionsForChat(chatId);
    if (!subs.length) { await sendMessage(chatId, '当前没有订阅。'); return true; }
    const withQ = subs.filter((s) => s.question && String(s.question).trim());
    const without = subs.filter((s) => !(s.question && String(s.question).trim()));
    // Groupability of currently-stored questions.
    const qCount = new Map();
    for (const s of withQ) {
      const q = s.question.trim();
      qCount.set(q, (qCount.get(q) ?? 0) + 1);
    }
    const groups = [...qCount.values()].filter((n) => n >= 2).length;
    const lines = [
      '<b>🔧 摘要分组诊断</b>',
      `订阅总数：<b>${subs.length}</b>`,
      `已存事件标题(question)：<b>${withQ.length}</b> · 缺失：<b>${without.length}</b>`,
      `可分组事件（≥2 选项同标题）：<b>${groups}</b>`,
      '',
    ];
    // Show actual question + slug + categorySlug for the first handful
    // of subs so we can see what the real grouping key should be when
    // `question` turns out to be per-option (unique) rather than the
    // shared event title.
    const sample = subs.slice(0, 6);
    lines.push('<b>样本（看真正能分组的字段）：</b>');
    for (const s of sample) {
      let catSlug = null, fq = null;
      try {
        const m = await getMarketById(s.marketId);
        catSlug = m?.categorySlug ?? m?.slug ?? m?.marketSlug ?? null;
        fq = m?.question ?? null;
      } catch { /* ignore */ }
      lines.push(`· <code>${s.marketId}</code> title="${htmlEscape((s.title || '').slice(0, 14))}"`);
      lines.push(`   q="${htmlEscape((fq || s.question || '').slice(0, 46))}"`);
      lines.push(`   slug=${s.slug ? htmlEscape(String(s.slug).slice(0, 30)) : 'NULL'} · catSlug=${catSlug ? htmlEscape(String(catSlug).slice(0, 30)) : 'NULL'}`);
    }
    lines.push('');
    lines.push('<i>把这条发回——看 q / slug / catSlug 哪个在同事件的几个选项间是一样的，就用那个当分组 key。</i>');
    await sendMessage(chatId, lines.join('\n'));
    return true;
  }
  if (c === '/digestonly') {
    // Toggle, or set explicitly with /digestonly on|off.
    const arg = (args[0] ?? '').toLowerCase();
    const cur = isChatDigestOnly(chatId);
    let next;
    if (arg === 'on' || arg === '开' || arg === '1') next = true;
    else if (arg === 'off' || arg === '关' || arg === '0') next = false;
    else next = !cur;
    setChatDigestOnly(chatId, next);
    await saveState();
    const digestSet = !!(getChatSettings(chatId)?.digestIntervalMs);
    const warn = next && !digestSet
      ? '\n\n<i>⚠️ 还没设定期摘要频率，开了之后就什么都不会推送。先发 <code>/digest 30m</code> 之类设一下。</i>'
      : '';
    await sendMessage(chatId, [
      next
        ? '📨 <b>只发摘要 = 开</b>'
        : '🔔 <b>只发摘要 = 关</b>',
      '',
      next
        ? '即时提醒全部静音；只有 <code>/digest</code> 的定期摘要会推送。所有历史 / 统计仍照常记录。'
        : '已恢复正常即时提醒。',
      warn,
    ].join('\n'));
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
  if (c === '/resetthresholds') {
    const subs = listSubscriptionsForChat(chatId);
    const overridden = subs.filter((s) => s.thresholds && Object.keys(s.thresholds).length > 0);
    if (!subs.length) {
      await sendMessage(chatId, '当前没有订阅。');
      return true;
    }
    if (!overridden.length) {
      await sendMessage(chatId, [
        `<b>所有 ${subs.length} 个订阅已经在用全局默认</b>`,
        ``,
        `<i>价 ≥ ${config.priceEpsilon} · 量 ≥ ${config.sizeAbsoluteMin} 张 / ${(config.sizeRelativeEpsilon * 100).toFixed(0)}% · 冷却 ${Math.round(config.notifyCooldownMs / 1000)}s</i>`,
      ].join('\n'));
      return true;
    }
    await sendMessage(chatId, [
      `⚠️ <b>把 ${overridden.length}/${subs.length} 个订阅的阈值改回全局默认？</b>`,
      ``,
      `将清除每条订阅自己保存的 priceEpsilon / sizeAbsoluteMin / sizeRelativeEpsilon / notifyCooldownMs 覆盖，统一回到：`,
      `<i>价 ≥ ${config.priceEpsilon} · 量 ≥ ${config.sizeAbsoluteMin} 张 / ${(config.sizeRelativeEpsilon * 100).toFixed(0)}% · 冷却 ${Math.round(config.notifyCooldownMs / 1000)}s</i>`,
    ].join('\n'), {
      replyMarkup: {
        inline_keyboard: [[
          { text: '✅ 全部重置', callback_data: 'resetth_ok' },
          { text: '↩️ 返回', callback_data: 'resetth_no' },
        ]],
      },
    });
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
  // ForceReply prompts (note / watch / generic command-target),
  // route the message to the matching handler instead of treating
  // it as a fresh subscription.
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
    const prompt = takePendingPrompt(chatId, replyTo);
    if (prompt) {
      await resolveAndDispatchPrompt(chatId, text, prompt.cmd, prompt.args ?? {});
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
    question: m.question ?? null,
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
async function renderListView(chatId, page = 0, { onlyPaused = false, search = null } = {}) {
  let subs = listSubscriptionsForChat(chatId);
  if (onlyPaused) subs = subs.filter((s) => s.pausedUntil && s.pausedUntil > Date.now());
  if (search) {
    subs = filterSubsBySearch(subs, search);
  }
  if (!subs.length) {
    await sendMessage(chatId, onlyPaused
      ? '当前没有处于暂停状态的订阅。'
      : (search ? `没有匹配 "${htmlEscape(search)}" 的订阅。` : '当前没有订阅。直接发个 Predict.fun 网址或 marketId 就能开始监控；批量用 /watch。'));
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
    { const nl = fmtNoteLine(s); if (nl) lines.push(nl); }
    await sendMessage(chatId, lines.join('\n'), { replyMarkup: subActionKeyboard(s.marketId) });
  }

  // Pagination footer with prev/next/全部停止 buttons.
  await sendMessage(
    chatId,
    `<i>翻页或快捷操作：</i>`,
    { replyMarkup: listPageKeyboard(safePage, totalPages) },
  );
}

// Compact list view — single message, no per-sub cards. Best for
// scanning many subs at once. Optional filter narrows to title /
// note / id substring.
async function renderListCompact(chatId, search = null) {
  let subs = listSubscriptionsForChat(chatId);
  if (search) subs = filterSubsBySearch(subs, search);
  if (!subs.length) {
    await sendMessage(chatId, search ? `没有匹配 "${htmlEscape(search)}" 的订阅。` : '当前没有订阅。');
    return;
  }
  const now = Date.now();
  const lines = [`<b>📋 紧凑视图</b>  <i>${subs.length} 个${search ? ` · 匹配 "${htmlEscape(search)}"` : ''}</i>`, ''];
  for (const s of subs.slice(0, 50)) {
    const isPaused = s.pausedUntil && s.pausedUntil > now;
    const dot = isPaused ? '⏸' : '🟢';
    const levels = s.levels?.length ? s.levels.map((l) => LEVEL_LABEL[l]).join('/') : '无';
    const mode = TRIGGER_LABEL[s.triggerMode] ?? '价+量';
    const titleLink = marketLink(s.title || `Market ${s.marketId}`, s.slug);
    const noteBit = s.note ? ` 📝 ${htmlEscape(s.note.slice(0, 16))}` : '';
    lines.push(`${dot} ${titleLink}`);
    lines.push(`  <code>${s.marketId}</code> · ${levels} · ${mode}${noteBit}`);
  }
  if (subs.length > 50) lines.push('', `<i>… 还有 ${subs.length - 50} 个，请用 /list 默认视图分页。</i>`);
  lines.push('', `<i>/list 默认视图 · /list paused 仅看暂停 · /list 关键字 搜索</i>`);
  await sendMessage(chatId, lines.join('\n'));
}

// /stats <id> [hours] — computes per-market activity stats from the
// JSONL history. All four ad-hoc metrics the review asked for, in
// one screen.
// ───────────────── /settings panel ─────────────────
// Everything per-chat that's configurable. Buttons open ForceReply
// sub-flows via the generic pendingPrompt mechanism — pasting a
// duration / HH:MM / levels list completes the action; bare cycle
// buttons toggle inline (default trigger mode).

function settingsHeaderText(chatId) {
  const cs = getChatSettings(chatId) ?? {};
  const labelMap = LEVEL_LABEL;
  const defaultLevels = cs.defaultLevels?.length
    ? cs.defaultLevels.map((l) => labelMap[l] ?? l).join('/')
    : `(env: ${(config.defaultLevels ?? []).map((l) => labelMap[l] ?? l).join('/')})`;
  const defaultMode = cs.defaultTriggerMode
    ? (TRIGGER_LABEL[cs.defaultTriggerMode] ?? cs.defaultTriggerMode)
    : `(env: ${TRIGGER_LABEL[config.defaultTriggerMode] ?? config.defaultTriggerMode ?? 'both'})`;
  const defaultCooldown = cs.defaultCooldownMs
    ? `${Math.round(cs.defaultCooldownMs / 1000)}s`
    : `(env: ${Math.round(config.notifyCooldownMs / 1000)}s)`;
  const digest = cs.digestIntervalMs
    ? `每 ${fmtRelativeRemaining(Date.now() + cs.digestIntervalMs)}`
    : '未开启';
  const quiet = (cs.quietStartMin != null && cs.quietEndMin != null)
    ? `${fmtMinOfDay(cs.quietStartMin)}-${fmtMinOfDay(cs.quietEndMin)}`
    : '未设置';
  const digestOnly = isChatDigestOnly(chatId) ? '✅ 开（即时提醒已静音，只发摘要）' : '⬜ 关';
  return [
    '<b>⚙️ 聊天设置</b>',
    '',
    `📐 新订阅默认档位：<b>${defaultLevels}</b>`,
    `🔔 新订阅默认触发：<b>${defaultMode}</b>`,
    `⏱ 新订阅默认冷却：<b>${defaultCooldown}</b>`,
    `📋 定期摘要：<b>${digest}</b>`,
    `📨 只发摘要：<b>${digestOnly}</b>`,
    `🌙 勿扰时段：<b>${quiet}</b> <i>(${config.displayTzLabel || config.displayTz})</i>`,
    `🕐 显示时区：<i>${config.displayTzLabel || config.displayTz} · env</i>`,
    '',
    '<i>已存在的订阅不受默认值影响；用 /levels /threshold 改单个。</i>',
  ].join('\n');
}

function buildSettingsKeyboard(chatId) {
  const digestOnly = isChatDigestOnly(chatId);
  return {
    inline_keyboard: [
      [
        { text: '📐 默认档位',  callback_data: 'setings:levels' },
        { text: '🔔 默认触发',  callback_data: 'setings:trigger' },
      ],
      [
        { text: '⏱ 默认冷却',  callback_data: 'setings:cooldown' },
        { text: '📋 摘要频率',  callback_data: 'setings:digest' },
      ],
      [
        { text: '🌙 勿扰时段',  callback_data: 'setings:quiet' },
        { text: `📨 只发摘要 ${digestOnly ? '✅' : '⬜'}`, callback_data: 'setings:digestonly' },
      ],
      [
        { text: '↻ 全部重置',  callback_data: 'setings:reset' },
      ],
    ],
  };
}

async function renderSettingsPanel(chatId) {
  await sendMessage(chatId, settingsHeaderText(chatId), { replyMarkup: buildSettingsKeyboard(chatId) });
}

// Sub-flows for each setting button. Each one either toggles inline
// (default trigger cycles through both/price/size) or opens a
// ForceReply via pendingPrompt with a setings:* cmd value.
async function handleSettingsCallback(chatId, messageId, callbackId, action) {
  if (action === 'reset') {
    setChatDefaultLevels(chatId, null);
    setChatDefaultTriggerMode(chatId, null);
    setChatDefaultCooldown(chatId, null);
    setChatDigest(chatId, 0);
    setChatQuiet(chatId, null, null);
    setChatDigestOnly(chatId, false);
    await saveState();
    await answerCallbackQuery(callbackId, { text: '已重置全部聊天设置' });
    try { await editMessageText(chatId, messageId, settingsHeaderText(chatId), buildSettingsKeyboard(chatId)); } catch {}
    return;
  }
  if (action === 'trigger') {
    // Cycle: <unset> → both → price → size → <unset>
    const cs = getChatSettings(chatId) ?? {};
    const cur = cs.defaultTriggerMode ?? null;
    const order = [null, 'both', 'price', 'size'];
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setChatDefaultTriggerMode(chatId, next);
    await saveState();
    await answerCallbackQuery(callbackId, { text: next ? `默认触发: ${TRIGGER_LABEL[next]}` : '已清除（用 env）' });
    try { await editMessageText(chatId, messageId, settingsHeaderText(chatId), buildSettingsKeyboard(chatId)); } catch {}
    return;
  }
  if (action === 'digestonly') {
    // Inline toggle: flip the flag, save, re-render the panel.
    const newVal = !isChatDigestOnly(chatId);
    setChatDigestOnly(chatId, newVal);
    await saveState();
    await answerCallbackQuery(callbackId, {
      text: newVal ? '已开启：只发摘要，不发即时提醒' : '已关闭：恢复即时提醒',
    });
    try { await editMessageText(chatId, messageId, settingsHeaderText(chatId), buildSettingsKeyboard(chatId)); } catch {}
    return;
  }
  // Everything else uses ForceReply.
  const prompts = {
    levels:   { headline: '<b>📐 设置默认档位</b>', hint: '回复要监控的档位，逗号分隔。可选: <code>bid1,bid2,bid3,ask1,ask2,ask3</code>。\n回复 <code>-</code> 清除（用 env 默认）。', placeholder: 'bid1,ask1' },
    cooldown: { headline: '<b>⏱ 设置默认冷却</b>', hint: '回复一个时长（<code>30s</code> / <code>1m</code> / <code>5m</code>）；<code>-</code> 清除（用 env）。', placeholder: '30s / 1m / 5m' },
    digest:   { headline: '<b>📋 摘要频率</b>',     hint: '回复时长（<code>30m</code> / <code>2h</code> / <code>1d</code>）；<code>off</code> 关闭。', placeholder: '30m / 2h / off' },
    quiet:    { headline: '<b>🌙 勿扰时段</b>',     hint: '回复格式 <code>HH:MM-HH:MM</code>（例 <code>23:00-08:00</code>）；<code>off</code> 关闭。', placeholder: '23:00-08:00' },
  };
  const p = prompts[action];
  if (!p) {
    await answerCallbackQuery(callbackId);
    return;
  }
  await answerCallbackQuery(callbackId);
  const sent = await sendMessage(chatId, `${p.headline}\n\n📝 <b>回复此条消息</b>${p.hint ? ' ' + p.hint : ''}\n<i>30 分钟内有效。</i>`, {
    replyMarkup: { force_reply: true, selective: true, input_field_placeholder: p.placeholder ?? '' },
  });
  putPendingPrompt(chatId, sent.message_id, `setings:${action}`);
  await saveState();
}

// resolveAndDispatchPrompt also handles setings:* cmds by parsing
// the reply text and calling the appropriate setter, then
// re-rendering the panel.
async function applySettingsReply(chatId, cmd, replyText) {
  const action = cmd.slice('setings:'.length);
  const text = String(replyText ?? '').trim();
  if (action === 'levels') {
    if (text === '-' || text === '——') {
      setChatDefaultLevels(chatId, null);
    } else {
      const parts = text.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const valid = parts.filter((p) => ALL_LEVELS.includes(p));
      if (!valid.length) {
        await sendMessage(chatId, `❌ 无法识别档位。可选: <code>bid1,bid2,bid3,ask1,ask2,ask3</code>`);
        return;
      }
      setChatDefaultLevels(chatId, valid);
    }
  } else if (action === 'cooldown') {
    if (text === '-' || text === '——' || text === 'off') {
      setChatDefaultCooldown(chatId, null);
    } else {
      const ms = parseDurationMs(text);
      if (!ms || ms < 1000) {
        await sendMessage(chatId, `❌ 无法识别时长。例：<code>30s</code> / <code>1m</code> / <code>5m</code>`);
        return;
      }
      setChatDefaultCooldown(chatId, ms);
    }
  } else if (action === 'digest') {
    if (text === 'off' || text === '0' || text === '-') {
      setChatDigest(chatId, 0);
    } else {
      const ms = parseDurationMs(text);
      if (!ms || ms < 60_000) {
        await sendMessage(chatId, `❌ 最小 1 分钟。例：<code>30m</code> / <code>2h</code> / <code>1d</code>`);
        return;
      }
      setChatDigest(chatId, ms);
    }
  } else if (action === 'quiet') {
    if (text === 'off' || text === '-') {
      setChatQuiet(chatId, null, null);
    } else {
      const m = text.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (!m) {
        await sendMessage(chatId, '❌ 格式应为 <code>HH:MM-HH:MM</code>（例 <code>23:00-08:00</code>）');
        return;
      }
      const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
      if (sh > 23 || sm > 59 || eh > 23 || em > 59) {
        await sendMessage(chatId, '❌ 小时 0-23、分钟 0-59');
        return;
      }
      setChatQuiet(chatId, sh * 60 + sm, eh * 60 + em);
    }
  }
  await saveState();
  await sendMessage(chatId, '✓ 已保存。');
  await renderSettingsPanel(chatId);
}

// /digestlog picker card. Time-window presets plus a "custom" button
// that opens a ForceReply (handled via the existing pendingPrompt
// mechanism, cmd='digestlog'). Each preset button maps to a sinceMs
// cutoff and dispatches runDigestLog directly.
async function sendDigestLogPicker(chatId) {
  // Surface when the user last ran /digestlog and offer a one-tap
  // "everything since then" window — the most common catch-up query.
  const lastAt = getChatDigestLogLastQueryAt(chatId);
  const lines = [
    '<b>📚 查看历史摘要</b>',
    '',
  ];
  if (lastAt) {
    lines.push(`🕘 上次查询：<b>${fmtClockDateTime(lastAt)}</b>（${fmtElapsed(Date.now() - lastAt)}前）`);
    lines.push('');
  }
  lines.push('<i>选时间窗口 → 发回这段时间内<b>有变动的市场（去重）</b>，每个市场只显示 1 次。</i>');
  lines.push('<i>需要看每一份摘要原文，加 <code>full</code>，例 <code>/digestlog 6h full</code>。</i>');
  const keyboard = [];
  if (lastAt) {
    keyboard.push([
      { text: `🕘 自上次查询以来（${fmtElapsed(Date.now() - lastAt)}）`, callback_data: 'dlog:sincelast' },
    ]);
  }
  keyboard.push(
    [
      { text: '最近 1h', callback_data: 'dlog:1h' },
      { text: '最近 6h', callback_data: 'dlog:6h' },
      { text: '最近 12h', callback_data: 'dlog:12h' },
    ],
    [
      { text: '最近 24h', callback_data: 'dlog:24h' },
      { text: '最近 3 天', callback_data: 'dlog:3d' },
      { text: '最近 7 天', callback_data: 'dlog:7d' },
    ],
    [
      { text: '🕒 自定义时长…', callback_data: 'dlog:custom' },
      { text: '🔢 最近 N 份…', callback_data: 'dlog:countN' },
    ],
  );
  await sendMessage(chatId, lines.join('\n'), {
    replyMarkup: { inline_keyboard: keyboard },
  });
}

// Default flow: scan digests in the chosen window, send ONE summary
// message that lists each market once with its net Δ over the window.
// `full: true` additionally replays every individual digest first
// (legacy behaviour, kept for users who want the time-ordered view).
// Public entry: never let /digestlog leave the user with no feedback.
// Any unexpected failure (history read error, Telegram send error, …)
// surfaces as an explicit ❌ message instead of a silent throw that the
// poll loop would only log. Empty/no-data cases are handled inside.
async function runDigestLog(chatId, args = {}) {
  try {
    // Capture the previous query time BEFORE stamping the new one, so
    // this run can still display "上次查询：…" with the old value.
    const prevQueryAt = getChatDigestLogLastQueryAt(chatId);
    await runDigestLogInner(chatId, { ...args, prevQueryAt });
    markChatDigestLogQuery(chatId);
    await saveState();
  } catch (err) {
    console.error(new Date().toISOString(), '[digestlog] failed:', err.stack || err.message);
    try {
      await sendMessage(chatId, [
        '❌ <b>加载历史摘要出错</b>',
        `<i>${htmlEscape(err.message || String(err))}</i>`,
        '',
        '<i>已记录日志；稍后重试，或换个时间窗口。</i>',
      ].join('\n'));
    } catch { /* even the error report failed — already logged above */ }
  }
}

async function runDigestLogInner(chatId, { sinceMs, windowLabel, count, full = false, prevQueryAt = null } = {}) {
  // Aggregate scans more digests than we'd ever replay since the cap
  // there was about Telegram message throughput, not data volume.
  const SCAN_LIMIT = 500;
  const REPLAY_CAP = 20;
  const opts = { chatId, limit: SCAN_LIMIT };
  if (sinceMs) opts.sinceMs = sinceMs;
  if (count) opts.limit = Math.min(SCAN_LIMIT, count);
  // Shown on every result so the user always knows when they last
  // looked; null on the very first query.
  const lastQueryLine = prevQueryAt
    ? `<i>🕘 上次查询：${fmtClockDateTime(prevQueryAt)}（${fmtElapsed(Date.now() - prevQueryAt)}前）</i>`
    : null;
  const digests = await readDigests(opts);
  if (!digests.length) {
    // A 自上次查询以来-style label already reads as a full window
    // description — don't prepend 最近 to it.
    const label = sinceMs
      ? (windowLabel && windowLabel.startsWith('上次查询') ? windowLabel : `最近 ${windowLabel ?? ''}`)
      : (count ? `最近 ${count} 份` : '');
    await sendMessage(chatId, [
      `<i>📭 ${label}没有摘要记录。</i>`,
      ...(lastQueryLine ? [lastQueryLine] : []),
      '',
      '<i>开启定期摘要：<code>/digest 30m</code></i>',
    ].join('\n'));
    return;
  }
  // readDigests returns newest→oldest; flip to chronological so the
  // aggregate's first-observation walk matches calendar order.
  const chrono = digests.slice().reverse();
  if (full) {
    const headerLabel = sinceMs
      ? `${windowLabel && windowLabel.startsWith('上次查询') ? windowLabel : `最近 ${windowLabel ?? ''}`} 内 ${digests.length} 份`
      : `最近 ${digests.length} 份`;
    await sendMessage(chatId, `<i>📚 ${headerLabel}摘要（旧→新）：</i>`);
    const toReplay = chrono.slice(-REPLAY_CAP);
    for (const d of toReplay) {
      try {
        await sendMessage(chatId, d.text);
      } catch (err) {
        console.warn('[digestlog] send failed:', err.message);
      }
    }
    if (chrono.length > REPLAY_CAP) {
      await sendMessage(chatId, `<i>… 已截断到最近 ${REPLAY_CAP} 份回放（共 ${chrono.length} 份在窗口内，汇总仍按全部计算）</i>`);
    }
  }
  // Always send the dedup aggregate — this is the "what moved over
  // the window" view the user actually came here for.
  await sendAggregateSummary(chatId, chrono, {
    windowLabel: windowLabel ?? (count ? `${digests.length} 份` : `${digests.length} 份摘要`),
    totalDigests: chrono.length,
    lastQueryLine,
  });
}

// Walk every digest in chronological order, take the FIRST observation
// of each marketId as the window start and the LAST as the window end,
// then emit one ranked summary message. Markets that didn't move appear
// collapsed at the tail so the user can still see they were tracked.
//
// The "start" anchor prefers the EARLIEST digest's prevBestBid/Ask
// (i.e. the digest-baseline that digest was comparing against) when
// available, since that's one extra data point further back in time
// than the digest's own snap. Otherwise falls back to the earliest
// digest's snap. This lets single-digest windows still report Δ.
async function sendAggregateSummary(chatId, chronoDigests, { windowLabel, totalDigests, lastQueryLine = null } = {}) {
  const startById = new Map();
  const endById = new Map();
  let digestsWithData = 0;
  for (const d of chronoDigests) {
    const entries = Array.isArray(d.entries) ? d.entries : [];
    if (entries.length) digestsWithData += 1;
    for (const e of entries) {
      if (e.bestBid == null || e.bestAsk == null) continue;
      const id = String(e.marketId);
      if (!startById.has(id)) {
        // Prefer the prev-baseline as the window-start anchor when the
        // digest carried it (added 2026-05-18); else use the snap.
        const startBid = e.prevBestBid != null ? e.prevBestBid : e.bestBid;
        const startAsk = e.prevBestAsk != null ? e.prevBestAsk : e.bestAsk;
        startById.set(id, { ...e, bestBid: startBid, bestAsk: startAsk, ts: d.ts });
      }
      endById.set(id, { ...e, ts: d.ts });
    }
  }
  if (!startById.size) {
    // Digests existed in the window but none carried per-market
    // structured data (e.g. digests written before the `entries` field
    // landed, or ones whose snapshots had no top-of-book). Without this
    // branch the function returned silently and the user — who just
    // tapped a /digestlog button — saw no response at all.
    await sendMessage(chatId, [
      `<b>📊 ${windowLabel} 没有可用于计算变化的数据</b>`,
      ...(lastQueryLine ? [lastQueryLine] : []),
      `<i>这段时间有 ${totalDigests ?? chronoDigests.length} 份摘要，但都不带结构化盘口数据（可能是早期版本生成的旧摘要）。</i>`,
      '',
      '<i>之后的摘要会带上结构化数据；等下一份 <code>/digest</code> 摘要生成后再用 <code>/digestlog</code> 即可看到净变化。</i>',
    ].join('\n'));
    return;
  }
  const rows = [];
  for (const [id, start] of startById) {
    const end = endById.get(id);
    const dBid = end.bestBid - start.bestBid;
    const dAsk = end.bestAsk - start.bestAsk;
    rows.push({ id, title: end.title || start.title, slug: end.slug || start.slug, question: end.question || start.question || null, start, end, dBid, dAsk, mag: Math.max(Math.abs(dBid), Math.abs(dAsk)) });
  }
  rows.sort((a, b) => b.mag - a.mag);
  const moved = rows.filter((r) => r.mag >= 1e-9);
  const flatCount = rows.length - moved.length;
  const digestsBit = totalDigests
    ? (digestsWithData < totalDigests
        ? ` · ${digestsWithData}/${totalDigests} 份摘要有数据`
        : ` · 含 ${totalDigests} 份摘要`)
    : '';
  const lines = [
    `<b>📊 ${windowLabel} 内有变动的市场（去重后 ${moved.length} 个）</b>`,
    `<i>共 ${rows.length} 个订阅市场${digestsBit} · 点市场名进 Predict.fun</i>`,
    ...(lastQueryLine ? [lastQueryLine] : []),
    '',
  ];
  if (digestsWithData < 2 && moved.length === 0) {
    lines.push(`<i>⚠️ 这段时间只有 ${digestsWithData} 份带详细数据的摘要，无法计算窗口变化。等再多积累几份摘要后重试。</i>`);
    await sendMessage(chatId, lines.join('\n'));
    return;
  }
  if (moved.length === 0) {
    lines.push(`<i>✅ 全部 ${rows.length} 个市场都没有净变化。</i>`);
    await sendMessage(chatId, lines.join('\n'));
    return;
  }
  const dot = (dBid, dAsk) => {
    const dom = Math.abs(dBid) >= Math.abs(dAsk) ? dBid : dAsk;
    if (dom > 1e-9) return '🟢';
    if (dom < -1e-9) return '🔴';
    return '🔔';
  };
  const fmtDelta = (dp) => Math.abs(dp) < 1e-9 ? '0' : `${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`;
  // Group movers by shared event slug (same key the periodic digest
  // uses) so options of one event collapse under a 📂 header derived
  // from their questions. Singletons render flat.
  const bySlug = new Map();
  for (const r of moved) {
    const key = (r.slug || '').trim() || `__solo:${r.id}`;
    if (!bySlug.has(key)) bySlug.set(key, { slug: (r.slug || '').trim(), items: [] });
    bySlug.get(key).items.push(r);
  }
  const blocks = [];
  for (const { slug, items } of bySlug.values()) {
    items.sort((a, b) => b.mag - a.mag);
    const isGroup = items.length > 1 && !!slug;
    blocks.push({
      isGroup,
      header: isGroup ? deriveEventTitle(items.map((r) => r.question || '')) : '',
      items,
      biggest: items[0].mag,
    });
  }
  blocks.sort((a, b) => b.biggest - a.biggest);
  // sendMessage auto-splits; cap is only a pathological-case guard.
  const MOVE_CAP = 300;
  let shown = 0;
  for (const b of blocks) {
    if (shown >= MOVE_CAP) break;
    if (b.isGroup) {
      const h = b.header && b.header.length > 80 ? b.header.slice(0, 77) + '…' : b.header;
      lines.push(`<b>📂 ${htmlEscape(h || '（同事件）')}</b>`);
      for (const r of b.items) {
        if (shown >= MOVE_CAP) break;
        const titleLink = marketLink(r.title || `#${r.id}`, r.slug);
        lines.push(`  ${dot(r.dBid, r.dAsk)} ${titleLink} <code>${r.id}</code> · 买1 ${r.start.bestBid.toFixed(4)}→${r.end.bestBid.toFixed(4)} (${fmtDelta(r.dBid)}) / 卖1 ${r.start.bestAsk.toFixed(4)}→${r.end.bestAsk.toFixed(4)} (${fmtDelta(r.dAsk)})`);
        shown += 1;
      }
    } else {
      const r = b.items[0];
      // Singleton: mirror a group — bold black 📂 header (question) +
      // one indented row carrying the clickable option label.
      const headline = r.question || r.title || `Market ${r.id}`;
      const h = headline.length > 80 ? headline.slice(0, 77) + '…' : headline;
      lines.push(`<b>📂 ${htmlEscape(h)}</b>`);
      const optLabel = (r.title && r.title.trim() && r.title !== headline) ? r.title : '查看盘口';
      lines.push(`  ${dot(r.dBid, r.dAsk)} ${marketLink(optLabel, r.slug)} <code>${r.id}</code> · 买1 ${r.start.bestBid.toFixed(4)}→${r.end.bestBid.toFixed(4)} (${fmtDelta(r.dBid)}) / 卖1 ${r.start.bestAsk.toFixed(4)}→${r.end.bestAsk.toFixed(4)} (${fmtDelta(r.dAsk)})`);
      shown += 1;
    }
  }
  if (moved.length > shown) {
    lines.push('', `<i>… 还有 ${moved.length - shown} 个有变化（已达 ${MOVE_CAP} 上限）</i>`);
  }
  if (flatCount) {
    lines.push('', `<i>· 另 ${flatCount} 个市场无变化（已隐藏）</i>`);
  }
  await sendMessage(chatId, lines.join('\n'));
}

// 近期变动最大的市场排序。Unlike /digestlog (which depends on periodic
// digests being configured), this works off the raw change-history that
// every alert writes, so it's available even when digests are off. For
// each market we take the EARLIEST in-window event's pre-change book as
// the window start (falling back to its post-change book when prev is
// absent, e.g. first-ever poll) and the LATEST event's post-change book
// as the end, then rank by the bigger of |Δ买1| / |Δ卖1|.
async function runMoversView(chatId, { windowMs, windowLabel, topN } = {}) {
  const sinceMs = Date.now() - windowMs;
  // Generous cap: scan all in-window events; busy chats still bounded.
  const events = await readEvents({ chatId, limit: 100_000, sinceMs });
  // History stores top-of-book as {price, size}; digests (no `cur`)
  // and first-poll rows without usable prices get skipped below.
  const price = (lvl) => (lvl && typeof lvl.price === 'number' ? lvl.price : null);
  const startById = new Map();
  const endById = new Map();
  // readEvents returns newest→oldest; walk oldest→newest so the first
  // time we see a market is its window-start anchor.
  for (const e of events.slice().reverse()) {
    const curBid = price(e.cur?.bestBid);
    const curAsk = price(e.cur?.bestAsk);
    if (curBid == null || curAsk == null) continue; // not a usable book row
    const id = String(e.marketId);
    if (!startById.has(id)) {
      // Prefer the pre-change book as the start anchor (one step further
      // back in time); fall back to this event's own book otherwise.
      const startBid = price(e.prev?.bestBid);
      const startAsk = price(e.prev?.bestAsk);
      startById.set(id, {
        bestBid: startBid != null ? startBid : curBid,
        bestAsk: startAsk != null ? startAsk : curAsk,
        title: e.title || null, slug: e.slug || null, note: e.note || null, ts: e.ts,
      });
    }
    endById.set(id, { bestBid: curBid, bestAsk: curAsk, title: e.title || null, slug: e.slug || null, note: e.note || null, ts: e.ts });
  }
  if (!startById.size) {
    await sendMessage(chatId, [
      `<i>📭 最近 ${htmlEscape(windowLabel)} 没有任何市场变动记录。</i>`,
      '',
      '<i>有订单簿变动时才会记录；换个更长的时间窗试试，例 <code>/movers 3d</code>。</i>',
    ].join('\n'));
    return;
  }
  const rows = [];
  for (const [id, start] of startById) {
    const end = endById.get(id);
    const dBid = end.bestBid - start.bestBid;
    const dAsk = end.bestAsk - start.bestAsk;
    rows.push({
      id,
      title: end.title || start.title,
      slug: end.slug || start.slug,
      note: end.note || start.note,
      start, end, dBid, dAsk,
      mag: Math.max(Math.abs(dBid), Math.abs(dAsk)),
    });
  }
  rows.sort((a, b) => b.mag - a.mag);
  const moved = rows.filter((r) => r.mag >= 1e-9);
  const flatCount = rows.length - moved.length;
  if (!moved.length) {
    await sendMessage(chatId, [
      `<b>📈 最近 ${htmlEscape(windowLabel)} 变动最大的市场</b>`,
      '',
      `<i>✅ ${rows.length} 个市场在这段时间都没有净变化。</i>`,
    ].join('\n'));
    return;
  }
  const dot = (dBid, dAsk) => {
    const dom = Math.abs(dBid) >= Math.abs(dAsk) ? dBid : dAsk;
    if (dom > 1e-9) return '🟢';
    if (dom < -1e-9) return '🔴';
    return '🔔';
  };
  const fmtDelta = (dp) => Math.abs(dp) < 1e-9 ? '0' : `${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`;
  const lines = [
    `<b>📈 最近 ${htmlEscape(windowLabel)} 变动最大的市场（${moved.length} 个）</b>`,
    `<i>按 买1/卖1 最大净变化排序 · 点市场名进 Predict.fun</i>`,
    '',
  ];
  const shown = moved.slice(0, topN);
  shown.forEach((r, i) => {
    const titleLink = marketLink(r.title || `Market ${r.id}`, r.slug);
    const noteBit = r.note ? ` <i>📝${htmlEscape(String(r.note).slice(0, 20))}</i>` : '';
    lines.push(`${i + 1}. ${dot(r.dBid, r.dAsk)} ${titleLink} <code>${r.id}</code>${noteBit}`);
    lines.push(`   买1 ${r.start.bestBid.toFixed(4)}→${r.end.bestBid.toFixed(4)} (${fmtDelta(r.dBid)}) · 卖1 ${r.start.bestAsk.toFixed(4)}→${r.end.bestAsk.toFixed(4)} (${fmtDelta(r.dAsk)})`);
  });
  if (moved.length > shown.length) {
    lines.push('', `<i>… 还有 ${moved.length - shown.length} 个有变化（加大 N 看更多，例 <code>/movers ${htmlEscape(windowLabel)} 50</code>）</i>`);
  }
  if (flatCount) {
    lines.push('', `<i>· 另 ${flatCount} 个市场无净变化（已隐藏）</i>`);
  }
  await sendMessage(chatId, lines.join('\n'));
}

// 买1/卖1 停滞时长排行。For each market this chat monitors, work out
// when each side's top-of-book price last actually moved, then rank by
// how long the whole book has sat frozen (longest first). Unlike
// /movers (which ranks by size of change), this surfaces the *quietest*
// books — the ones where a maker quote is least likely to be jumped, so
// the user can judge which side (挂 Yes / 挂 No) to rest liquidity on.
//
// "Last moved" is read from this chat's change-history: walking newest→
// oldest, the first event whose 买1 (resp. 卖1) price differs from its
// own recorded prev is that side's last-change moment. A market with no
// recorded change since subscribe is treated as frozen since its
// monitoring start (sub.initial.atMs / addedAt).
async function runStaleView(chatId, { topN = 20 } = {}) {
  const subs = listSubscriptionsForChat(chatId);
  if (!subs.length) {
    await sendMessage(chatId, '<i>📭 当前聊天没有订阅。先发个网址 / id / slug 开始监控。</i>');
    return;
  }
  const now = Date.now();
  const events = await readEvents({ chatId, limit: 100_000 });
  const price = (lvl) => (lvl && typeof lvl.price === 'number' ? lvl.price : null);
  // marketId → ts of the most recent event where that side's price moved.
  const lastBidChange = new Map();
  const lastAskChange = new Map();
  for (const e of events) { // newest → oldest
    const id = String(e.marketId);
    if (!lastBidChange.has(id)) {
      const cur = price(e.cur?.bestBid);
      const prev = price(e.prev?.bestBid);
      if (cur != null && (prev == null || Math.abs(cur - prev) >= 1e-9)) lastBidChange.set(id, e.ts);
    }
    if (!lastAskChange.has(id)) {
      const cur = price(e.cur?.bestAsk);
      const prev = price(e.prev?.bestAsk);
      if (cur != null && (prev == null || Math.abs(cur - prev) >= 1e-9)) lastAskChange.set(id, e.ts);
    }
  }
  const rows = [];
  for (const s of subs) {
    const id = String(s.marketId);
    // Frozen-since anchor for a side with no recorded change: the moment
    // monitoring started. Clamp to now so a clock skew never yields a
    // negative span.
    const anchor = Math.min(now, s.initial?.atMs ?? s.addedAt ?? now);
    const bidTs = lastBidChange.get(id) ?? anchor;
    const askTs = lastAskChange.get(id) ?? anchor;
    const lastChange = Math.max(bidTs, askTs); // whole book frozen since this
    const snap = getLatestSnapForSub(chatId, s.marketId) ?? s.lastSnap ?? null;
    rows.push({
      sub: s,
      bidTs, askTs, lastChange,
      stale: now - lastChange,
      bidStale: now - bidTs,
      askStale: now - askTs,
      snap,
      paused: s.pausedUntil && s.pausedUntil > now,
    });
  }
  rows.sort((a, b) => b.stale - a.stale);
  const shown = rows.slice(0, topN);
  const lines = [
    `<b>🧊 买1/卖1 停滞排行（${rows.length} 个市场）</b>`,
    '<i>按盘口最久未变排序 · 越靠前 = 报价越稳、越不易被插队</i>',
    '',
  ];
  shown.forEach((r, i) => {
    const s = r.sub;
    const titleLink = marketLink(s.title || `Market ${s.marketId}`, s.slug);
    const noteBit = s.note ? ` <i>📝${htmlEscape(String(s.note).slice(0, 20))}</i>` : '';
    const pauseBit = r.paused ? ' ⏸' : '';
    lines.push(`${i + 1}. 🧊 ${titleLink} <code>${s.marketId}</code>${noteBit}${pauseBit}`);
    const bb = r.snap?.bestBid;
    const ba = r.snap?.bestAsk;
    if (bb && ba && typeof bb.price === 'number' && typeof ba.price === 'number') {
      const mid = (bb.price + ba.price) / 2;
      const spread = ba.price - bb.price;
      // Line 1 — precise orderbook, same 买1/卖1 vocabulary as alerts /
      // /history / /movers so the command stays consistent.
      lines.push(`   买1 ${bb.price.toFixed(4)}×${bb.size}（停 ${fmtElapsed(r.bidStale)}） · 卖1 ${ba.price.toFixed(4)}×${ba.size}（停 ${fmtElapsed(r.askStale)}）`);
      // Line 2 — Yes/No action translation. 挂 Yes rests a bid (买入
      // Yes) → reference ≈ 买1, frozen for bidStale. 挂 No rests a
      // buy-No order, i.e. sell Yes at the ask → the No-denominated
      // price is 1 − 卖1, frozen for askStale. Mark whichever side has
      // sat longer (>60s apart) as the more stable queue.
      const noPrice = 1 - ba.price;
      const yesMark = r.bidStale - r.askStale > 60_000 ? ' ·更稳' : '';
      const noMark = r.askStale - r.bidStale > 60_000 ? ' ·更稳' : '';
      lines.push(`   → 挂 <b>Yes</b> 参考 ${bb.price.toFixed(4)}（停${fmtElapsed(r.bidStale)}${yesMark}） ｜ 挂 <b>No</b> 参考 ${noPrice.toFixed(4)}（停${fmtElapsed(r.askStale)}${noMark}）`);
      // Line 3 — implied probability + spread for context.
      lines.push(`   隐含 Yes ${(mid * 100).toFixed(1)}% · 价差 ${spread.toFixed(4)}`);
    } else {
      lines.push(`   <i>盘口待抓取 · 整体停滞 ${fmtElapsed(r.stale)}</i>`);
    }
    lines.push(`   整体停滞 ${fmtElapsed(r.stale)} <i>（自 ${fmtClockDateTime(r.lastChange)}）</i>`);
  });
  if (rows.length > shown.length) {
    lines.push('', `<i>… 还有 ${rows.length - shown.length} 个（加大 N 看更多，例 <code>/stale 50</code>）</i>`);
  }
  lines.push('', '<i>挂 Yes = 在买1侧报价（≈买1）；挂 No = 在卖1侧报价（No 价 = 1−卖1）。停滞越久的一侧队列越稳，仅供参考。</i>');
  await sendMessage(chatId, lines.join('\n'));
}

async function runHistoryView(chatId, marketId, n = 10) {
  const events = await readEvents({ chatId, marketId, limit: n });
  if (!events.length) {
    await sendMessage(chatId, `没有 <code>${htmlEscape(marketId)}</code> 的历史记录。`);
    return;
  }
  const lines = [
    `<b>📜 ${marketLink(events[0].title || `Market ${marketId}`, events[0].slug)}</b>`,
    `<i>最近 ${events.length} 条变动（新→旧）· /export 拿完整文件</i>`,
    '',
  ];
  for (const e of events) lines.push(fmtHistoryEntry(e));
  await sendMessage(chatId, lines.join('\n'));
}

// Send a ForceReply prompt asking the user to reply with a URL /
// marketId / slug. Reply text is parsed by handleMessage's reply
// branch via takePendingPrompt → resolveAndDispatchPrompt. Greatly
// reduces the "memorise marketId" friction — user can just paste
// the Predict.fun URL and the bot handles the rest.
async function promptCommandTarget(chatId, cmd, { args = {}, headline, hint, placeholder } = {}) {
  const lines = [
    headline,
    '',
    hint || '<b>📝 回复此条消息</b>，发送 URL / marketId / slug',
    '<i>不用再输入命令；30 分钟内有效。</i>',
    '',
    '<b>💡 格式示例</b>',
    '<code>https://predict.fun/zh-cn/market/foo</code>',
    '<code>272779</code>',
    '<code>btc-eom-2026</code>',
  ];
  const sent = await sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    replyMarkup: { force_reply: true, selective: true, input_field_placeholder: placeholder || 'URL/id/slug' },
  });
  putPendingPrompt(chatId, sent.message_id, cmd, args);
  await saveState();
}

// Resolve the user's reply text to a single marketId, then dispatch
// to the cmd handler with the saved args. Used by every URL-aware
// reply prompt (/stats /history /probe /threshold /levels).
async function resolveAndDispatchPrompt(chatId, replyText, cmd, args = {}) {
  // Settings sub-flows don't need a market resolution — the reply IS
  // the value (duration / levels list / HH:MM range).
  if (cmd.startsWith('setings:')) {
    await applySettingsReply(chatId, cmd, replyText);
    return;
  }
  // /digestlog 自定义 sub-flow: the reply is a duration ("3h") or a
  // bare integer ("10"); no market resolution needed.
  if (cmd === 'digestlog') {
    const t = String(replyText ?? '').trim();
    if (args.kind === 'count') {
      const n = parseInt(t, 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        await sendMessage(chatId, '❌ 请回复 1–50 的整数。');
        return;
      }
      await runDigestLog(chatId, { count: n });
      return;
    }
    // default: duration
    const ms = parseDurationMs(t);
    if (!ms) {
      await sendMessage(chatId, '❌ 请回复有效时长，例 <code>3h</code> / <code>30m</code> / <code>2d</code>。');
      return;
    }
    await runDigestLog(chatId, { sinceMs: Date.now() - ms, windowLabel: t });
    return;
  }
  // /stop reply-flow: a URL may map to several subscribed sub-markets
  // (event page). Resolve to the full set, keep only the ones this
  // chat actually subscribes, and show the same checkbox card picker
  // as the subscribe flow, in 'unsub' mode. The picker keeps callback
  // data token-sized — packing the id list into a button used to blow
  // Telegram's 64-byte callback_data cap and the whole card message
  // got rejected (BUTTON_DATA_INVALID), so the user saw nothing.
  // Numeric ids fall through to the single-market confirm below.
  if (cmd === 'stop') {
    const t = String(replyText ?? '').trim();
    const numeric = extractMarketId(t);
    if (!numeric) {
      let markets = [];
      try {
        const r = await resolveUrlToMarkets(t);
        markets = r.markets ?? [];
      } catch (err) {
        await sendMessage(chatId, `❌ 解析失败：${htmlEscape(err.message)}`);
        return;
      }
      const subscribed = markets.filter((m) => getSubscription(chatId, m.id));
      if (markets.length && !subscribed.length) {
        await sendMessage(chatId, `<i>这个链接对应的 ${markets.length} 个市场你都没有订阅。</i>`);
        return;
      }
      if (subscribed.length > 1) {
        const token = shortToken();
        putPendingChoice(chatId, token, subscribed, [], 'unsub');
        await saveState();
        const existingIds = existingMatchIds(chatId, subscribed);
        await sendMessage(chatId, buildChoiceHeaderText(subscribed, 0, existingIds.size, 'unsub'), {
          replyMarkup: buildChoiceKeyboard(token, subscribed, [], existingIds, 'unsub'),
        });
        return;
      }
      if (subscribed.length === 1) {
        const m = subscribed[0];
        const sub = getSubscription(chatId, m.id);
        await sendMessage(chatId, [
          `⚠️ <b>确认停止监控？</b>`,
          `🏷 ${marketLink(sub.title || `Market ${m.id}`, sub.slug)}`,
          `<code>id=${m.id}</code>`,
        ].join('\n'), {
          replyMarkup: { inline_keyboard: [[
            { text: '✅ 确认停止', callback_data: `unsub_ok:${m.id}` },
            { text: '↩️ 返回',     callback_data: 'noop' },
          ]] },
        });
        return;
      }
      // markets.length === 0 → fall through to the generic "无法识别"
    }
  }
  const trimmed = String(replyText ?? '').trim();
  if (!trimmed) {
    await sendMessage(chatId, '❌ 回复内容为空。');
    return;
  }
  // First try: pure numeric marketId.
  let marketId = extractMarketId(trimmed);
  if (!marketId) {
    // Else try URL / slug resolution.
    try {
      const r = await resolveUrlToMarkets(trimmed);
      if (r.markets.length === 1) {
        marketId = r.markets[0].id;
      } else if (r.markets.length > 1) {
        await sendMessage(chatId, [
          `🔎 识别出 <b>${r.markets.length}</b> 个子市场，请直接发送某一个子市场的 id 或单页 URL。`,
          `<i>（事件页含多个子市场无法定位单一目标）</i>`,
        ].join('\n'));
        return;
      }
    } catch (err) {
      await sendMessage(chatId, `❌ 解析失败：${htmlEscape(err.message)}`);
      return;
    }
  }
  if (!marketId) {
    await sendMessage(chatId, `❌ 无法识别 <code>${htmlEscape(trimmed.slice(0, 80))}</code> — 请回复 URL、marketId 或 slug。`);
    return;
  }
  // Dispatch.
  switch (cmd) {
    case 'stats':
      await runStats(chatId, marketId, args.hours ?? 24);
      return;
    case 'history':
      await runHistoryView(chatId, marketId, args.n ?? 10);
      return;
    case 'probe':
      await runProbe(chatId, marketId);
      return;
    case 'threshold': {
      const sub = getSubscription(chatId, marketId);
      if (!sub) {
        await sendMessage(chatId, `❌ 没有订阅 <code>${marketId}</code>，先发 URL 订阅它。`);
        return;
      }
      await sendMessage(chatId, thresholdHeader(sub), { replyMarkup: buildThresholdKeyboard(marketId, detectThresholdPreset(sub)) });
      return;
    }
    case 'levels': {
      const sub = getSubscription(chatId, marketId);
      if (!sub) {
        await sendMessage(chatId, `❌ 没有订阅 <code>${marketId}</code>，先发 URL 订阅它。`);
        return;
      }
      await sendMessage(chatId, levelsHeader(sub), { replyMarkup: buildLevelsKeyboard(sub.marketId, sub.levels, sub.triggerMode) });
      return;
    }
    case 'note': {
      const sub = getSubscription(chatId, marketId);
      if (!sub) {
        await sendMessage(chatId, `❌ 没有订阅 <code>${marketId}</code>，先发 URL 订阅它。`);
        return;
      }
      await promptForNote(chatId, marketId);
      return;
    }
    case 'pause': {
      const sub = getSubscription(chatId, marketId);
      if (!sub) {
        await sendMessage(chatId, `❌ 没有订阅 <code>${marketId}</code>。`);
        return;
      }
      const durMs = parseDurationMs(args.duration) ?? 60 * 60 * 1000;
      const untilMs = Date.now() + durMs;
      setSubscriptionPause(chatId, marketId, untilMs);
      await saveState();
      await sendMessage(chatId, [
        `⏸ 已暂停 <code>${marketId}</code>  ${htmlEscape(sub.title || '')}`,
        `<i>${fmtRelativeRemaining(untilMs)}后自动恢复</i>`,
      ].join('\n'));
      return;
    }
    case 'stop': {
      const sub = getSubscription(chatId, marketId);
      if (!sub) {
        await sendMessage(chatId, `❌ 没有订阅 <code>${marketId}</code>。`);
        return;
      }
      // Confirmation flow — reuse the existing unsub:<id> callback
      // path so the experience matches the button.
      await sendMessage(chatId, [
        `⚠️ <b>确认停止监控？</b>`,
        `🏷 ${marketLink(sub.title || `Market ${marketId}`, sub.slug)}`,
        `<code>id=${marketId}</code>`,
      ].join('\n'), {
        replyMarkup: { inline_keyboard: [[
          { text: '✅ 确认停止', callback_data: `unsub_ok:${marketId}` },
          { text: '↩️ 返回',     callback_data: 'noop' },
        ]] },
      });
      return;
    }
    default:
      await sendMessage(chatId, '❌ 未知命令分支。');
  }
}

async function runStats(chatId, marketId, hours = 24) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  // readEvents tail-limits to limit; use a generous cap so the
  // window math is honest. Old entries past 14-day retention just
  // aren't there.
  const events = await readEvents({ chatId, marketId, limit: 5000 });
  const inWindow = events.filter((e) => e.ts >= cutoff);
  if (!inWindow.length) {
    await sendMessage(chatId, `<i>📊 最近 ${hours}h 没有 <code>${htmlEscape(marketId)}</code> 的触发记录。</i>`);
    return;
  }
  let maxAbsDp = 0, maxAbsDpLabel = '';
  let maxAbsDs = 0, maxAbsDsLabel = '';
  let maxSpread = 0;
  let lastSpread = null;
  let triggers = inWindow.length;
  for (const e of inWindow) {
    const prevBid = e.prev?.bestBid, prevAsk = e.prev?.bestAsk;
    const curBid = e.cur?.bestBid, curAsk = e.cur?.bestAsk;
    if (prevBid && curBid) {
      const dp = curBid.price - prevBid.price;
      if (Math.abs(dp) > maxAbsDp) { maxAbsDp = Math.abs(dp); maxAbsDpLabel = `买1 ${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`; }
      const ds = curBid.size - prevBid.size;
      if (Math.abs(ds) > maxAbsDs) { maxAbsDs = Math.abs(ds); maxAbsDsLabel = `买1 量${ds > 0 ? '↑' : '↓'}${Math.abs(ds).toLocaleString('en-US', { maximumFractionDigits: 0 })}`; }
    }
    if (prevAsk && curAsk) {
      const dp = curAsk.price - prevAsk.price;
      if (Math.abs(dp) > maxAbsDp) { maxAbsDp = Math.abs(dp); maxAbsDpLabel = `卖1 ${dp > 0 ? '↑' : '↓'}${Math.abs(dp).toFixed(4)}`; }
      const ds = curAsk.size - prevAsk.size;
      if (Math.abs(ds) > maxAbsDs) { maxAbsDs = Math.abs(ds); maxAbsDsLabel = `卖1 量${ds > 0 ? '↑' : '↓'}${Math.abs(ds).toLocaleString('en-US', { maximumFractionDigits: 0 })}`; }
    }
    if (curBid && curAsk) {
      const sp = curAsk.price - curBid.price;
      if (sp > maxSpread) maxSpread = sp;
      lastSpread = sp;
    }
  }
  const latest = inWindow[0]; // readEvents returns newest-first
  const ago = fmtRelativeRemaining(Date.now() * 2 - latest.ts) || `${Math.round((Date.now() - latest.ts) / 60000)} 分钟`;
  const sub = getSubscription(chatId, marketId);
  const titleLink = marketLink(latest.title || sub?.title || `Market ${marketId}`, latest.slug || sub?.slug);
  const lines = [
    `<b>📊 ${titleLink}</b>  <i>最近 ${hours}h</i>`,
    `<code>id=${marketId}</code>`,
    '',
    `📈 触发次数：<b>${triggers}</b>`,
  ];
  if (maxAbsDpLabel) lines.push(`🔺 最大单次 Δ价：<b>${maxAbsDpLabel}</b>`);
  if (maxAbsDsLabel) lines.push(`📦 最大单次 Δ量：<b>${maxAbsDsLabel}</b>`);
  if (maxSpread) lines.push(`↔️ 最大价差：<b>${maxSpread.toFixed(4)}</b>`);
  if (lastSpread != null) lines.push(`🟢 最近价差：<b>${lastSpread.toFixed(4)}</b>`);
  lines.push(`⏱ 最近触发：<i>${fmtClockTime(latest.ts)} ${config.displayTzLabel || ''}</i>`);
  lines.push('', `<i>/history_${marketId} 查变动 · /threshold_${marketId} 调阈值 · /probe_${marketId} 立即抓</i>`);
  await sendMessage(chatId, lines.join('\n'));
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
    fmtNoteLine(sub),
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
  const failedLines = []; // raw lines for "🔁 重试失败项" button
  const eventPickers = []; // { target, matches } — sent as pickers below
  for (const line of lines) {
    const { target, note } = parseWatchLine(line);
    const noteSuffix = note ? `  📝 ${htmlEscape(note)}` : '';
    // 1) Pure numeric → marketId direct lookup.
    const id = extractMarketId(target);
    if (id) {
      try {
        const market = await getMarketById(id);
        if (!market) {
          results.push(`✗ <code>${htmlEscape(id)}</code> 市场不存在`);
          failedLines.push(line);
          continue;
        }
        addSubscription({
          chatId,
          marketId: id,
          conditionId: market.conditionId ?? null,
          title: market.title || market.question || `Market ${id}`,
          question: market.question ?? null,
          slug: null,
          note,
        });
        results.push(`✓ <code>${id}</code> ${htmlEscape((market.title ?? '').slice(0, 50))}${noteSuffix}`);
      } catch (err) {
        results.push(`✗ <code>${htmlEscape(id)}</code> ${htmlEscape(err.message).slice(0, 60)}`);
        failedLines.push(line);
      }
      continue;
    }
    // 2) URL / slug — use the same resolver the single-message path uses.
    try {
      const r = await resolveUrlToMarkets(target);
      if (!r.markets.length) {
        results.push(`✗ <code>${htmlEscape(target).slice(0, 50)}</code> 找不到`);
        failedLines.push(line);
        continue;
      }
      if (r.markets.length === 1) {
        const m = r.markets[0];
        addSubscription({
          chatId,
          marketId: m.id,
          conditionId: m.conditionId,
          title: m.title || m.question || `Market ${m.id}`,
          question: m.question ?? null,
          slug: m.slug,
          note,
        });
        results.push(`✓ <code>${m.id}</code> ${htmlEscape((m.title ?? '').slice(0, 50))}${noteSuffix}`);
      } else {
        results.push(`📍 <code>${htmlEscape(target).slice(0, 40)}</code> 事件页（${r.markets.length} 个子市场，已弹选择器 ↓）`);
        eventPickers.push({ target, matches: r.markets });
      }
    } catch (err) {
      results.push(`✗ <code>${htmlEscape(target).slice(0, 40)}</code> ${htmlEscape(err.message).slice(0, 60)}`);
      failedLines.push(line);
    }
  }
  await saveState();
  const ok = results.filter((r) => r.startsWith('✓')).length;
  // Build retry button only if there are recoverable failures.
  const summaryButtons = [];
  if (failedLines.length) {
    const retryToken = shortToken();
    putPendingBulkRetry(chatId, retryToken, failedLines);
    await saveState();
    summaryButtons.push([{
      text: `🔁 重试失败项 (${failedLines.length})`,
      callback_data: `retry:${retryToken}`,
    }]);
  }
  await sendMessage(chatId, [
    `<b>📥 批量订阅完成</b>  ✓${ok} / ${results.length}`,
    '',
    ...results,
  ].join('\n'), summaryButtons.length ? { replyMarkup: { inline_keyboard: summaryButtons } } : undefined);

  // Pre-emptively send a picker for every event-page line so the user
  // doesn't have to re-paste those URLs individually. Each picker is
  // a separate message with the standard multi-select keyboard.
  for (const ep of eventPickers) {
    const token = shortToken();
    putPendingChoice(chatId, token, ep.matches, []);
    await saveState();
    const existingIds = existingMatchIds(chatId, ep.matches);
    await sendMessage(chatId, [
      `<b>📍 ${htmlEscape(ep.target.slice(0, 60))}</b>`,
      buildChoiceHeaderText(ep.matches, 0, existingIds.size),
    ].join('\n'), {
      replyMarkup: buildChoiceKeyboard(token, ep.matches, [], existingIds),
    });
  }
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
            fmtNoteLine(sub),
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

  // Legacy bulk-stop button (comma-separated ids in callback_data).
  // New messages use the pick:<token> unsub picker instead — id lists
  // routinely exceeded Telegram's 64-byte callback_data cap. Kept so
  // old messages that did send keep working.
  const unsubAll = data.match(/^unsuball:([\d,]+)$/);
  if (unsubAll) {
    const ids = unsubAll[1].split(',').filter(Boolean);
    let removed = 0;
    for (const id of ids) if (removeSubscription(chatId, id)) removed += 1;
    if (removed) await saveState();
    await answerCallbackQuery(cb.id, { text: `已停止 ${removed}` });
    if (messageId) {
      try {
        await editMessageText(chatId, messageId, `🛑 已停止监控该事件下的 ${removed} 个市场`);
      } catch { /* ignore */ }
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
      { const nl = fmtNoteLine(sub); if (nl) lines.push(nl); }
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

  if (data === 'resetth_ok') {
    const subs = listSubscriptionsForChat(chatId);
    let cleared = 0;
    for (const s of subs) {
      if (s.thresholds && Object.keys(s.thresholds).length > 0) {
        setSubscriptionThresholds(chatId, s.marketId, null);
        cleared += 1;
      }
    }
    if (cleared) await saveState();
    await answerCallbackQuery(cb.id, { text: `已重置 ${cleared}` });
    if (messageId) {
      try {
        await editMessageText(chatId, messageId, [
          `✅ <b>已重置 ${cleared} 个订阅的阈值</b>`,
          ``,
          `<i>统一使用全局默认：价 ≥ ${config.priceEpsilon} · 量 ≥ ${config.sizeAbsoluteMin} 张 / ${(config.sizeRelativeEpsilon * 100).toFixed(0)}% · 冷却 ${Math.round(config.notifyCooldownMs / 1000)}s</i>`,
        ].join('\n'));
      } catch { /* ignore */ }
    }
    return;
  }

  if (data === 'resetth_no') {
    await answerCallbackQuery(cb.id, { text: '已取消' });
    if (messageId) {
      try {
        await editMessageText(chatId, messageId, '↩️ 已返回，阈值未变。');
      } catch { /* ignore */ }
    }
    return;
  }

  const dlogMatch = data.match(/^dlog:(.+)$/);
  if (dlogMatch) {
    const choice = dlogMatch[1];
    if (choice === 'sincelast') {
      // "Everything since I last looked" — window starts at the stored
      // last-query timestamp instead of a fixed duration.
      const lastAt = getChatDigestLogLastQueryAt(chatId);
      if (!lastAt) {
        await answerCallbackQuery(cb.id, { text: '还没有上次查询记录，先选一个时间窗口', showAlert: true });
        return;
      }
      await answerCallbackQuery(cb.id, { text: '加载上次查询以来的变动…' });
      await runDigestLog(chatId, {
        sinceMs: lastAt,
        windowLabel: `上次查询以来（${fmtClockDateTime(lastAt)} 起，${fmtElapsed(Date.now() - lastAt)}）`,
      });
      return;
    }
    if (choice === 'custom') {
      await answerCallbackQuery(cb.id);
      const sent = await sendMessage(chatId, [
        '<b>🕒 自定义时长</b>',
        '',
        '📝 <b>回复此条消息</b>，发一个时长（例 <code>3h</code> / <code>30m</code> / <code>2d</code>）',
        '<i>30 分钟内有效。</i>',
      ].join('\n'), {
        replyMarkup: { force_reply: true, selective: true, input_field_placeholder: '3h / 30m / 2d' },
      });
      putPendingPrompt(chatId, sent.message_id, 'digestlog', { kind: 'duration' });
      return;
    }
    if (choice === 'countN') {
      await answerCallbackQuery(cb.id);
      const sent = await sendMessage(chatId, [
        '<b>🔢 最近 N 份</b>',
        '',
        '📝 <b>回复此条消息</b>，发一个数字（1–50，例 <code>10</code>）',
        '<i>30 分钟内有效。</i>',
      ].join('\n'), {
        replyMarkup: { force_reply: true, selective: true, input_field_placeholder: '10' },
      });
      putPendingPrompt(chatId, sent.message_id, 'digestlog', { kind: 'count' });
      return;
    }
    // Preset duration buttons (1h / 6h / 12h / 24h / 3d / 7d)
    const ms = parseDurationMs(choice);
    if (!ms) {
      await answerCallbackQuery(cb.id, { text: '未知选项', showAlert: true });
      return;
    }
    await answerCallbackQuery(cb.id, { text: `加载最近 ${choice}…` });
    await runDigestLog(chatId, { sinceMs: Date.now() - ms, windowLabel: choice });
    return;
  }

  const settingsMatch = data.match(/^setings:(.+)$/);
  if (settingsMatch) {
    await handleSettingsCallback(chatId, messageId, cb.id, settingsMatch[1]);
    return;
  }

  // Retry button on a batch-subscribe result message.
  const retryMatch = data.match(/^retry:([a-z0-9]+)$/);
  if (retryMatch) {
    const lines = takePendingBulkRetry(chatId, retryMatch[1]);
    if (!lines || !lines.length) {
      await answerCallbackQuery(cb.id, { text: '重试列表已过期', showAlert: true });
      return;
    }
    await saveState();
    await answerCallbackQuery(cb.id, { text: `重试 ${lines.length} 项…` });
    await applyBulkWatchInput(chatId, lines.join('\n'));
    return;
  }

  const probeMatch = data.match(/^probe:(\d+)$/);
  if (probeMatch) {
    const id = probeMatch[1];
    await answerCallbackQuery(cb.id, { text: '🔍 抓取中…' });
    await runProbe(chatId, id);
    return;
  }

  // Threshold preset selector: thresh:<id>:<preset>
  const threshMatch = data.match(/^thresh:(\d+):(.+)$/);
  if (threshMatch) {
    const id = threshMatch[1];
    const preset = threshMatch[2];
    const sub = getSubscription(chatId, id);
    if (!sub) {
      await answerCallbackQuery(cb.id, { text: '订阅不存在', showAlert: true });
      return;
    }
    if (preset === 'global') {
      setSubscriptionThresholds(chatId, id, null);
    } else if (THRESHOLD_PRESETS[preset]) {
      const { priceEpsilon, sizeAbsoluteMin, sizeRelativeEpsilon, notifyCooldownMs } = THRESHOLD_PRESETS[preset];
      setSubscriptionThresholds(chatId, id, { priceEpsilon, sizeAbsoluteMin, sizeRelativeEpsilon, notifyCooldownMs });
    } else {
      await answerCallbackQuery(cb.id, { text: '未知预设' });
      return;
    }
    await saveState();
    const fresh = getSubscription(chatId, id);
    await answerCallbackQuery(cb.id, { text: `已切换到 ${preset === 'global' ? '全局默认' : THRESHOLD_PRESETS[preset].label}` });
    try {
      await editMessageText(chatId, messageId, thresholdHeader(fresh), buildThresholdKeyboard(id, detectThresholdPreset(fresh)));
    } catch { /* old msg */ }
    return;
  }

  // Quick-mute from a notification or /list card: pause:<id>:<duration>.
  // Reuses the existing setSubscriptionPause plumbing — same as
  // /pause <id> <duration>, just one tap. The notification message
  // itself isn't edited (the user might want the orderbook detail
  // to stay visible); a new confirmation message lands with /resume
  // shortcut.
  const pauseClickMatch = data.match(/^pause:(\d+):(.+)$/);
  if (pauseClickMatch) {
    const id = pauseClickMatch[1];
    const durRaw = pauseClickMatch[2];
    const sub = getSubscription(chatId, id);
    if (!sub) {
      await answerCallbackQuery(cb.id, { text: '订阅不存在', showAlert: true });
      return;
    }
    const ms = parseDurationMs(durRaw);
    if (!ms) {
      await answerCallbackQuery(cb.id, { text: '时长无效', showAlert: true });
      return;
    }
    const untilMs = Date.now() + ms;
    setSubscriptionPause(chatId, id, untilMs);
    await saveState();
    await answerCallbackQuery(cb.id, { text: `已静音 ${fmtRelativeRemaining(untilMs)}` });
    await sendMessage(chatId, [
      `⏸ 已静音 <code>${htmlEscape(id)}</code>  ${htmlEscape(sub.title || '')}`,
      `<i>${fmtRelativeRemaining(untilMs)}后自动恢复</i>`,
      `提前恢复：/resume_${id}`,
    ].join('\n'));
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
    gcPendingPrompts();
    gcPendingBulkRetry();
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
    { command: 'list',      description: '我的订阅（分页 + 操作按钮）' },
    { command: 'digest',    description: '定期摘要（防遗漏盘口）' },
    { command: 'digestlog', description: '查看历史摘要（睡醒补看）' },
    { command: 'movers',    description: '近期变动最大的市场排序' },
    { command: 'stale',     description: '买1/卖1 停滞最久排行（辅助挂 Yes/No）' },
    { command: 'digestonly', description: '只发摘要 · 静音即时提醒（开关）' },
    { command: 'settings',  description: '聊天设置面板（默认档位/触发/摘要/勿扰…）' },
    { command: 'status',    description: 'Bot 健康状态' },
    { command: 'export',    description: '导出 history.jsonl' },
    { command: 'speedtest', description: '测抓取延迟' },
    { command: 'stop',      description: '取消订阅（回复网址，弹确认/选项）' },
    { command: 'stopall',   description: '取消全部订阅' },
    { command: 'resetthresholds', description: '把所有订阅阈值改回全局默认' },
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
