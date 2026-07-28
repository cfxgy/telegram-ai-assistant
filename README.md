# Telegram AI Assistant (Cloudflare Worker)

一个基于 **Cloudflare Workers** 的 Telegram 私人 AI 助手：支持多模型切换、上下文对话与智能长期记忆，并通过 Token 优化策略降低推理成本。


---

## Features / 功能

- 🤖 **多模型切换**：在 Telegram 内通过命令快速切换模型
- 🧠 **智能长期记忆**：自动抽取“有价值信息”沉淀，闲聊不记忆以降低 Token
- 💬 **上下文对话**：保留最近 N 条消息作为上下文，避免无限增长
- 💰 **Token 优化**：默认使用低成本模型、限制上下文长度、记忆判断固定走轻量模型
- ☁️ **Serverless 部署**：Cloudflare Workers 部署、免服务器运维

---

## Supported Models / 支持模型

- DeepSeek Chat
- DeepSeek Reasoner
- Qwen Flash

---

## Commands / Telegram 命令

### 模型切换
```text
/model flash
/model chat
/model reason
```

### 长期记忆
查看记忆：
```text
/memory
```

清除记忆：
```text
/clear
```

---

## Quick Start


### 1) 前置准备
- 一个 Cloudflare 账号（可创建 Workers）
- 一个 Telegram 账号

### 2) 创建 Telegram Bot
1. 在 Telegram 搜索 `@BotFather`
2. 执行 `/newbot` 创建机器人
3. 获取 **Bot Token**（形如 `123456:ABC-DEF...`），记为：`BOT_TOKEN`

### 3) 准备模型 API Key
按你使用的模型服务商准备 API Key（DeepSeek / Qwen 等），记为：`AI_API_KEY`

### 4) 部署到 Cloudflare Workers
你可以用 **Dashboard** 部署（最简单）：

1. Cloudflare 控制台 → **Workers & Pages** → **Create**
2. 选择 **Worker**，创建后把仓库代码部署上去（或用 Git 集成）
3. 在 Worker → **Settings** → **Variables and Secrets** 添加环境变量（见下方 Configuration）
4. 保存并部署

### 5) 设置 Telegram Webhook
部署成功后，你会得到一个 Worker URL，类似：
```text
https://your-worker.your-account.workers.dev
```

然后设置 Webhook（把 URL 替换成你项目实际的 webhook 路径；若项目直接使用根路径接收更新，就不需要额外路径）：

```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=https://your-worker.your-account.workers.dev/"
```

验证 Webhook：
```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

完成后给你的 Bot 发消息即可开始使用。

---

## How it works / 原理简介

### 🧠 智能长期记忆
机器人会自动提取重要信息并保存（示例维度）：
- goals（目标）
- projects（项目）
- preferences（偏好）
- facts（事实）

普通闲聊不保存，以降低 Token 消耗与噪声记忆。

### 💬 上下文对话
- 默认保留 **最近 4 条消息**
- 防止 Token 无限增长

### 💰 Token 优化策略
- 默认使用 **Qwen Flash**
- 记忆判断始终使用 Flash
- 限制上下文长度，降低成本

---

## FAQ

### 1. 收不到消息/机器人不回复？
- 检查 Worker 是否部署成功、日志是否有报错
- 检查 `BOT_TOKEN` 是否正确
- 检查 Telegram Webhook 是否设置成功：`getWebhookInfo`

### 2. 成本太高怎么办？
- 降低 `CONTEXT_SIZE`
- 默认使用更便宜的模型（如 `flash`）
- 减少“会触发记忆”的内容或提高记忆筛选阈值（以代码实现为准）

---
