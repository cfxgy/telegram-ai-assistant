# Telegram AI Assistant

一个基于 Cloudflare Workers 的 Telegram AI 助手。项目采用 Telegram Webhook、Cloudflare KV 和 OpenAI 兼容接口，提供多模型对话、短期上下文、长期记忆以及用户级 AI 配置。

适合个人助手、内部机器人和低流量场景。生产环境部署前，请根据实际并发量评估 Durable Objects、限流和持久化方案。

## 功能特性

- 支持 DeepSeek V4 Flash、DeepSeek V4 Pro 和 Qwen Flash
- 支持每个用户独立配置 AI 名称、系统提示词、模型和温度
- 保留最近对话作为短期上下文
- 自动提取目标、项目、偏好和事实等长期记忆
- 使用 Telegram Webhook Secret Token 验证请求来源
- 支持 Telegram 用户白名单
- 处理模型超时、限流、网络错误和无效响应
- 自动拆分超过 Telegram 单条消息限制的回复
- 基于 Cloudflare Workers，无需维护常驻服务器

## 系统架构

```text
Telegram Bot API
       │ HTTPS Webhook
       ▼
Cloudflare Worker
       ├── 请求校验
       ├── 用户白名单
       ├── Telegram 命令处理
       ├── 模型请求
       ├── KV 状态读写
       └── Telegram 回复
             │
             ├── DeepSeek API
             └── DashScope API
```

### 请求流程

1. Telegram 向 Worker 发送更新事件。
2. Worker 校验 `X-Telegram-Bot-Api-Secret-Token`。
3. Worker 校验用户或聊天 ID 是否在白名单中。
4. Worker 从 KV 读取短期上下文、长期记忆和用户 AI 配置。
5. Worker 调用当前用户选择的模型。
6. Worker 将回复拆分后发送回 Telegram。
7. Worker 异步提取并保存长期记忆。

## 支持的模型

| Command | API model ID | Provider | Intended use |
| --- | --- | --- | --- |
| `/model v4flash` | `deepseek-v4-flash` | DeepSeek | 快速、低延迟的日常对话 |
| `/model v4pro` | `deepseek-v4-pro` | DeepSeek | 更复杂的分析和高质量回答 |
| `/model qwen` | `qwen-flash` | DashScope | 低成本对话和记忆提取 |

DeepSeek 请求使用官方 OpenAI 兼容接口：

```text
https://api.deepseek.com/chat/completions
```

Telegram 命令 `chat`、`reason`、`flash` 和 `pro` 作为旧配置兼容别名保留，但不会作为 API 的模型 ID 发送。

官方文档：[DeepSeek API 中文文档](https://api-docs.deepseek.com/zh-cn/)

## 用户级 AI 配置

每个用户拥有独立的 AI 配置。用户可以修改行为和模型，但不能修改服务器端 API Key。

```text
/ai                         查看当前 AI 配置
/setname <name>             设置 AI 名称
/setprompt <prompt>         设置系统提示词
/model v4flash|v4pro|qwen   切换模型
/settemp <0-2>              设置温度
/resetai                    恢复 AI 默认配置
/memory                     查看长期记忆
/clear                      清除上下文和长期记忆
/help                       查看帮助
```

示例：

```text
/setname 代码审查助手
/setprompt 你是一名资深 TypeScript 工程师，回答时给出具体、可执行的建议。
/model v4pro
/settemp 0.3
```

系统提示词最大长度为 2000 个字符。短期上下文、单条输入和长期记忆数量均有上限，以控制成本和存储增长。

## 环境要求

- Cloudflare 账号
- Workers 和 KV 权限
- 一个 Telegram Bot
- 一个 Cloudflare KV Namespace
- DeepSeek API Key，或 DashScope API Key
- Node.js 18+（本地开发和 Wrangler）

## 配置说明

### 1. 创建 KV 命名空间

创建 KV Namespace，并将 ID 写入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CHAT_KV"
id = "YOUR_KV_NAMESPACE_ID"
```

不要将真实的 KV ID、Token 或 API Key 写入公开仓库中的源码。

### 2. 配置 Secret

```bash
npx wrangler secret put TG_TOKEN
npx wrangler secret put TG_SECRET_TOKEN
npx wrangler secret put TG_ALLOWED_USER_IDS
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put QWEN_API_KEY
```

| Secret | Required | Description |
| --- | --- | --- |
| `TG_TOKEN` | Yes | Telegram Bot Token |
| `TG_SECRET_TOKEN` | Recommended | Telegram Webhook Secret Token |
| `TG_ALLOWED_USER_IDS` | Strongly recommended | 允许访问机器人的用户 ID 或聊天 ID，使用逗号分隔 |
| `DEEPSEEK_API_KEY` | Conditional | 使用 DeepSeek V4 Flash 或 V4 Pro 时需要 |
| `QWEN_API_KEY` | Conditional | 使用 Qwen 或 Qwen 记忆提取时需要 |

示例：

```text
TG_ALLOWED_USER_IDS=123456789,987654321
```

为了兼容旧部署，未配置 `TG_ALLOWED_USER_IDS` 时代码会允许所有用户访问，并记录警告日志。生产环境必须配置白名单。

## 部署

```bash
npm install
npx wrangler login
npx wrangler deploy
```

设置 Telegram Webhook：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<TG_SECRET_TOKEN>"
```

检查 Webhook 状态：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Worker 的 `GET /` 请求会返回健康检查文本：

```text
Telegram AI Worker OK
```

## 本地开发

安装依赖：

```bash
npm install
```

启动本地 Worker：

```bash
npm run dev
```

部署到 Cloudflare：

```bash
npm run deploy
```

生成 Wrangler 类型定义：

```bash
npm run typecheck
```

## 安全注意事项

- `TG_SECRET_TOKEN` 只验证请求来源，不能替代用户白名单。
- API Key 必须存储在 Cloudflare Secrets 中，不能由用户通过 Telegram 设置。
- 用户提示词会被发送给所选模型，不应包含密码、Token 或其他敏感数据。
- `/memory` 仅展示当前聊天对应的记忆。
- 建议对 Worker 增加 Cloudflare 层面的速率限制和用量监控。
- 如果机器人用于多人或公开服务，建议将白名单改为默认拒绝策略。

## 已知限制

当前版本使用 KV 保存短期上下文和长期记忆。KV 的读改写不是强一致事务，在同一用户快速发送多条消息时可能发生写入覆盖。

如果需要更高并发或严格的消息顺序，建议将状态迁移到 Durable Objects，并以 `chat_id` 作为对象 ID，使每个聊天的消息串行处理。

此外，当前版本主要处理 Telegram 文本消息，尚未实现图片、文件、语音和按钮回调等输入类型。

## 故障排查

### 机器人没有回复

检查以下项目：

1. `TG_TOKEN` 是否正确；
2. `TG_ALLOWED_USER_IDS` 是否包含当前 Telegram 用户 ID；
3. `TG_SECRET_TOKEN` 是否与 `setWebhook` 中的值完全一致；
4. `getWebhookInfo` 中的 URL 是否指向当前 Worker；
5. Cloudflare Worker 日志中是否存在 KV 或模型请求错误。

### DeepSeek 模型调用错误

确认实际模型 ID 为：

```text
deepseek-v4-flash
deepseek-v4-pro
```

不要使用已经弃用的旧模型名称，也不要把 Telegram 命令别名直接当作 API `model` 参数。

### 模型成本过高

- 默认使用 `v4flash`；
- 复杂任务再切换到 `v4pro`；
- 缩短系统提示词和上下文；
- 限制 `TG_ALLOWED_USER_IDS`；
- 增加调用频率限制和每日用量上限；
- 根据实际需求降低长期记忆提取频率。

## 项目结构

```text
.
├── src/
│   └── worker.js       # Worker、Telegram、模型和记忆逻辑
├── wrangler.toml       # Cloudflare Workers 配置
├── package.json        # Wrangler 脚本和开发依赖
├── README.md
└── LICENSE
```

## 后续计划

- [ ] 使用 Durable Objects 保证同一聊天的消息顺序
- [ ] 增加 Vitest 和外部 API mock 测试
- [ ] 增加速率限制、用量统计和管理员命令
- [ ] 支持图片、文件和语音消息
- [ ] 支持长期记忆单条删除、导出和过期策略
- [ ] 增加 staging/production 多环境配置

## License

Apache-2.0，详见 [LICENSE](LICENSE)。
