# Liquidity009 Bot

发一个 Predict.fun 网址给机器人 → 它识别出页面里的所有市场卡片 → 你点一下要监控哪个 → 订单簿（最佳买/卖、深度）一发生变化就 Telegram 推送给你。

参考 [`7CCCCC21X/pp`](https://github.com/7CCCCC21X/pp) 的 Predict.fun GraphQL/REST 调用方式实现。

## 功能
- **三种订阅入口**：发 URL、发 marketId（纯数字）、发 slug
- **网址识别**：事件页（多张卡片选择）/ 单市场页（自动订阅）
- **自定义档位**：每张订阅独立勾选买1/2/3、卖1/2/3。订阅成功消息附带「📐 配置档位」按钮，或随时 `/levels <id>`。
- **备注**：每张订阅可加自定义文字标签，列表和通知里都显示。点「📝 设置备注」按钮（ForceReply 弹输入框）或 `/note <id> <文字>`。
- 变动监控：默认 30s 轮询，被勾选的档位价位（变动 ≥ 0.001）或量（变动 ≥ 10 张或 5%）触发推送
- **到价提醒**：`/alert <id> 买1>0.55` 一次性限价提醒，触发即解除；绕过冷却和「只发摘要」
- **结算检测**：市场结算/关闭后自动发 🏁 通知并取消订阅（间隔 `RESOLVED_CHECK_INTERVAL_MS`，默认 15 分钟查一次）
- 持久化：订阅 + 档位 + 备注写入 `STATE_FILE`，Railway redeploy 不丢
- 0 第三方依赖：纯 Node 20 内置 fetch

## 命令
| 命令 | 说明 |
| --- | --- |
| `/start`, `/help` | 用法说明 |
| `/watch` | **批量订阅** — 弹出 ForceReply 输入框，每行一条 URL/id/slug + 备注 |
| `/list` | 列出当前聊天的订阅、监控档位、备注 |
| `/levels <id>` | 调出档位勾选键盘（买1/2/3、卖1/2/3） |
| `/note <id> <文字>` | 设置备注（不带文字 → 弹输入框；发 `-` 清除） |
| `/alert <id> 买1>0.55` | **到价提醒**（一次性）。指标：买/卖1-3、中价、价差；比较：`>` `>=` `<` `<=`。`/alert` 看全部，`/alert <id> -` 清除 |
| `/history <id> [N]` | 查看该市场最近 N 条变动（默认 10，最多 50） |
| `/chart <id> [窗口]` | 中价走势 sparkline（默认 24h，例 `/chart 272779 7d`） |
| `/export` | 把整个 `history.jsonl` 文件发回到聊天里 |
| `/exportsubs` | 导出本聊天全部订阅（`/watch` 格式，换机器粘贴即可恢复） |
| `/stop <id>` | 取消单个订阅 |
| `/stopall` | 取消全部订阅 |

### `/watch` 批量格式
```
https://predict.fun/zh-cn/market/foo
272779 主仓
spain — 西班牙夺冠
btc-eom-2026 : 短期套利
```
target 后面可加备注，分隔符接受空格 / `-` / `:` / `—`。事件页（多个子市场）会跳过提示，请单独发送以选择。

`/list` 里每张订阅尾部都有 `/levels_<id>`、`/note_<id>`、`/stop_<id>` 一键链接，不用复制 id。

### 档位键盘示例
```
[ ✅ 买1 ]  [ ✅ 卖1 ]
[ ⬜ 买2 ]  [ ✅ 卖2 ]
[ ⬜ 买3 ]  [ ⬜ 卖3 ]
[ 全选  ]  [ 清空  ]
[      ✅ 完成        ]
```
✅ = 监控，⬜ = 忽略。点档位按钮即时切换；通知消息里只对被勾选的档位做变动判定，但前 3 档完整深度都会展示（被监控的档前面带 👁）。

## 本地运行
```bash
cp .env.example .env   # 填好 TELEGRAM_BOT_TOKEN
npm run get-chat-id    # 顺便找到你的 chat id（可选，用于 admin 提示）
npm start
```

## 诊断 slug 解析失败
如果发了 URL 之后 bot 回复"没匹配到市场"，先在终端跑诊断脚本看链路里每一环：
```bash
node scripts/diagnose.js https://predict.fun/zh-cn/market/fifa-world-cup-group-e-winner
# 或
npm run diagnose -- https://predict.fun/zh-cn/market/fifa-world-cup-group-e-winner
```
脚本会逐步打印：① slug 解析；② GraphQL schema 暴露的字段；③ 全市场列表大小；
④ 严格匹配（title / question / categorySlug，含年份变体）；⑤ 模糊 token 匹配 top 10；
⑥ REST `/v1/markets` 兜底扫描；以及一段总结建议。

> Bot 内置的解析器现在依次试 5 层：title-slug → question-slug → 年份变体 →
> GraphQL categorySlug → REST `/v1/markets` 全表扫描。还匹配不到时会用模糊
> token 给出"你是不是要找…"的可点选列表。

## 部署到 Railway
1. 把仓库 push 到 GitHub。
2. Railway → New Project → Deploy from GitHub Repo。
3. 添加一个 **Volume**：挂载点 `/data`（推荐 1–5 GB；JSONL 平均一行 ~400 B，14 天内顶多十几 MB）。
4. 环境变量（按 `.env.example` 填，**最少这三组**）：
   ```
   TELEGRAM_BOT_TOKEN=...      # 必填
   STATE_FILE=/data/state.json
   HISTORY_FILE=/data/history.jsonl
   ```
   公网部署建议同时设置 `ALLOWED_CHAT_IDS=<你的chatId>`，否则任何找到
   bot 的人都能订阅（用 `npm run get-chat-id` 查自己的 id）。
   其它如 `POLL_INTERVAL_MS`、`PRICE_EPSILON`、`HISTORY_KEEP_DAYS` 都有合理默认值。
5. `railway.json` 已配好 `npm start`、自动重启策略；启动时自动 prune 旧记录（间隔 ≥24h）。

### 数据文件
- `STATE_FILE`（默认 `./state.json`） — 订阅、档位、备注、Telegram offset
- `HISTORY_FILE`（默认 `./history.jsonl`） — 每次推送都 append 一行 JSON：
  ```json
  {"ts":1714737000000,"chatId":123,"marketId":"257916","title":"$1B","note":"主仓","levels":["bid1","ask1"],"summary":"买1 价 +0.0050；卖1 量 -120","prev":{...},"cur":{...}}
  ```
  在聊天里 `/export` 直接拿到完整文件，或本地 `tail -f /data/history.jsonl | jq` 实时观察。
- `npm run prune-history` 强制压缩（保留最近 `HISTORY_KEEP_DAYS` 天）。

### 管理员心跳
设置 `TELEGRAM_CHAT_ID` 后，若连续 `ADMIN_ALERT_CONSECUTIVE_FAILS`（默认 3）个轮询周期
全部市场抓取失败（Predict API 故障 / 出口网络断），bot 会主动给该 chat 推 🚨 告警，
恢复后再推 ✅。设 0 关闭。

## 测试
```bash
npm test          # node:test 单元测试（纯函数 + 历史文件倒读）
npm run check     # 全文件语法检查
```
GitHub Actions（`.github/workflows/ci.yml`）在每次 push / PR 自动跑这两步。

## 调参（频率 + 阈值）
所有都是 env 变量，不用改代码。**频率四要素**：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `POLL_INTERVAL_MS` | `30000` | 多久抓一次订单簿 |
| `POLL_MIN_INTERVAL_MS` | `200` | 循环硬下限（保险丝；想更快可调更低） |
| `POLL_CONCURRENCY` | `8` | 一次 tick 同时抓多少个市场（多订阅时关键） |
| `NOTIFY_COOLDOWN_SEC` | `60` | 单订阅最少多久通知一次（防刷屏） |

实际通知间隔 ≥ max(`POLL_INTERVAL_MS`, `NOTIFY_COOLDOWN_SEC × 1000`)。

**示例**：用 `/speedtest` 看到 p95 ≈ 200ms，要做到秒级提醒：
```
POLL_INTERVAL_MS=300       # 1 秒内最多 3 次
NOTIFY_COOLDOWN_SEC=1
POLL_MIN_INTERVAL_MS=200
```
Bot 内部并行抓多市场（`Promise.all` + 并发上限），所以 N 个订阅的 wall-clock 还是 max(L)，不是 N×L。

**变动阈值**（任意一项触发就算变动）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PRICE_EPSILON` | `0.001` | 价格变动 ≥ 0.1¢（Predict.fun 最小可见跳动） |
| `SIZE_RELATIVE_EPSILON` | `0.05` | 量变 ≥ 5% |
| `SIZE_ABSOLUTE_MIN` | `10` | 量变 ≥ 10 张 |
| `RESOLVED_CHECK_INTERVAL_MS` | `900000` | 结算检测频率（每市场，ms）；0 关闭 |

**历史记录**：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HISTORY_ENABLED` | `true` | 是否记录变动到 JSONL |
| `HISTORY_FILE` | `./history.jsonl` | Railway 推荐 `/data/history.jsonl` |
| `HISTORY_KEEP_DAYS` | `14` | 自动 prune 阈值（天）；0 关闭 |

## 项目结构
```
src/
├── config.js     env 加载
├── http.js       fetch + 重试 + 超时
├── telegram.js   Telegram Bot API
├── predict.js    URL → slug → marketId 解析；GraphQL 市场列表；REST 订单簿
├── state.js      JSON 持久化
├── monitor.js    轮询 + 变动检测 + 推送
└── index.js      命令处理 + 长轮询 + 启动
scripts/
└── get-chat-id.js
```
