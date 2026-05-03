# Liquidity009 Bot

发一个 Predict.fun 网址给机器人 → 它识别出页面里的所有市场卡片 → 你点一下要监控哪个 → 订单簿（最佳买/卖、深度）一发生变化就 Telegram 推送给你。

参考 [`7CCCCC21X/pp`](https://github.com/7CCCCC21X/pp) 的 Predict.fun GraphQL/REST 调用方式实现。

## 功能
- 网址识别：支持事件页（多张卡片）和单市场页（自动订阅）
- 卡片选择：多市场时返回 inline keyboard，每张卡片一个按钮
- **自定义档位**：可逐订阅勾选要监控的档位（买1/2/3、卖1/2/3）。订阅后会附带「📐 配置档位」按钮，或随时 `/levels <id>` 调出 toggle 键盘。
- 变动监控：默认 30s 轮询，被勾选的档位价位（变动 ≥ 0.005）或量（变动 ≥ 50 张或 10%）触发推送
- 持久化：订阅 + 档位偏好写入 `STATE_FILE`，重启 / Railway redeploy 不丢
- 0 第三方依赖：纯 Node 20 内置 fetch

## 命令
| 命令 | 说明 |
| --- | --- |
| `/start`, `/help` | 用法说明 |
| `/list` | 列出当前聊天的订阅及监控档位 |
| `/levels <marketId>` | 调出档位勾选键盘（买1/2/3、卖1/2/3） |
| `/stop <marketId>` | 取消单个订阅 |
| `/stopall` | 取消全部订阅 |

直接发网址或 slug 就会进入"识别 + 选卡片"流程。新订阅默认监控全部 6 档，点订阅成功消息里的「📐 配置档位」可随时改。

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

## 部署到 Railway
1. 把仓库 push 到 GitHub。
2. Railway → New Project → Deploy from GitHub Repo。
3. 环境变量按 `.env.example` 填（至少要 `TELEGRAM_BOT_TOKEN`）。
4. **强烈建议**：挂一个 Volume，挂载点 `/data`，并设 `STATE_FILE=/data/state.json`，否则 redeploy 会丢订阅状态。
5. `railway.json` 已配好 `npm start`、自动重启策略。

## 调参
所有阈值都是 env 变量，不用改代码：
- `POLL_INTERVAL_MS`：轮询间隔，默认 30 000
- `PRICE_EPSILON`：价格变动阈值，默认 0.005（即 0.5¢）
- `SIZE_RELATIVE_EPSILON`：相对量变阈值，默认 0.10
- `SIZE_ABSOLUTE_MIN`：绝对量变阈值，默认 50 张
- `NOTIFY_COOLDOWN_SEC`：单 chat × market 的最短通知间隔，默认 60s

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
