# Telegram AI Assistant

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

基于 **Cloudflare Workers** 的 Telegram 私人 AI 助手。支持多模型切换、上下文对话与智能长期记忆，通过 Token 优化策略降低推理成本。

---

## Features

- **多模型切换** — 命令一键切换 DeepSeek Chat / Reasoner / Qwen Flash
- **智能长期记忆** — 自动提取有价值信息（目标、项目、偏好、事实）沉淀到 KV，闲聊不记忆
- **上下文对话** — 保留最近 16 条消息作为上下文，防止 Token 无限增长
- **Token 优化** — 默认 Qwen Flash；记忆判断固定走轻量模型，不浪费推理预算
- **Webhook 鉴权** — 支持 Telegram Secret Token 防伪造请求盗刷 API
- **长文本分割** — AI 回复超 4096 字符自动分片发送
- **API 容错** — 欠费、限流、网络异常均有友好中文提示
- **Serverless 部署** — Cloudflare Workers + KV，零服务器运维

---

## Supported Models

| 命令别名 | 模型 | 服务商 |
|---------|------|--------|
| `flash` | Qwen Flash | 阿里云百炼 |
| `chat` | DeepSeek Chat | DeepSeek |
| `reason` | DeepSeek Reasoner | DeepSeek |

---

## Commands

```text
/model flash      切换到 Qwen Flash（默认，最便宜）
/model chat       切换到 DeepSeek Chat
/model reason     切换到 DeepSeek Reasoner
/current          查看当前模型
/memory           查看长期记忆
/clear            清除所有记忆
```

---

## Quick Start

### 1. 前置准备

- Cloudflare 账号（Workers + KV 可用）
- Telegram 账号
- DeepSeek API Key 和/或 阿里云百炼 API Key

### 2. 创建 Telegram Bot

在 Telegram 搜索 `@BotFather`，执行 `/newbot`，获取 Bot Token。

### 3. 部署到 Cloudflare Workers

**Dashboard 部署（推荐）**

1. Cloudflare 控制台 → **Workers & Pages** → **Create** → **Upload**
2. 上传 `src/worker.js`，或通过 Git 集成连接此仓库
3. 创建 KV Namespace，在 `wrangler.toml` 中填入 KV ID
4. 在 Worker → **Settings** → **Variables and Secrets** 添加环境变量

**wrangler CLI 部署**

```bash
npm install -g wrangler
wrangler login
# 修改 wrangler.toml 中的 KV ID
wrangler secret put TG_TOKEN
wrangler secret put QWEN_API_KEY
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put TG_SECRET_TOKEN
wrangler secret put SYSTEM_PROMPT
wrangler deploy
```

### 4. 环境变量

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中配置：

| 变量名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `TG_TOKEN` | Secret | 是 | Telegram Bot Token |
| `TG_SECRET_TOKEN` | Secret | 推荐 | Webhook Secret Token，防止伪造请求 |
| `QWEN_API_KEY` | Secret | 是 | 阿里云百炼 API Key |
| `DEEPSEEK_API_KEY` | Secret | 是 | DeepSeek API Key |
| `SYSTEM_PROMPT` | Secret | 否 | AI 系统提示词 |
| `CHAT_KV` | KV Binding | 是 | KV 命名空间，存储对话记忆 |

### 5. 设置 Telegram Webhook

将 `<BOT_TOKEN>`、`<WORKER_URL>`、`<YOUR_SECRET_TOKEN>` 替换为实际值：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<YOUR_SECRET_TOKEN>"
```

验证：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

---

## Architecture

```
Telegram User
     │
     ▼
Telegram API ──POST──▶ Cloudflare Worker (worker.js)
                            │
                    ┌───────┼───────┐
                    ▼       ▼       ▼
               Qwen Flash  DeepSeek  KV Storage
               (记忆判断)   (对话)    (记忆存储)
```

**消息处理流程：**

1. Worker 接收 Telegram Webhook 推送
2. 校验 `X-Telegram-Bot-Api-Secret-Token`（防伪造）
3. 立即返回 200 OK，异步处理（防超时重试）
4. 并行读取 KV 中的短期记忆、长期记忆、模型偏好
5. 调用目标模型生成回复
6. 判断用户消息是否含长期价值，有则提取并存入 KV
7. 分割长回复，逐片发送给用户

---

## FAQ

**收不到消息 / 机器人不回复？**  
检查 Worker 日志（`wrangler tail` 或 Dashboard Logs），确认 `TG_TOKEN` 和 Webhook 设置正确。

**被刷 API 怎么办？**  
设置 `TG_SECRET_TOKEN` 环境变量，并在 Webhook URL 中带上 `&secret_token=xxx`。

**成本太高？**  
默认已使用 Qwen Flash（最便宜）。可进一步减小 `MAX_SHORT`（目前 16），或精简 `SYSTEM_PROMPT`。

**想加新模型？**  
编辑 `worker.js` 顶部的 `MODELS` 字典，添加一条配置即可，无需改动其他代码。

---

## License

MIT
