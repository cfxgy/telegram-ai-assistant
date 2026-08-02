const MAX_CONTEXT_MESSAGES = 16;
const MAX_TG_LENGTH = 3800;
const MAX_INPUT_LENGTH = 8000;
const MAX_SYSTEM_PROMPT_LENGTH = 2000;
const MAX_MEMORY_ITEMS = 50;
const DEFAULT_MODEL = "v4flash";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT = "你是一个有用、准确、简洁的中文 AI 助手。";

// DeepSeek uses the OpenAI-compatible Chat Completions API.
// The model names are stable aliases maintained by DeepSeek.
const MODELS = {
  v4flash: {
    label: "DeepSeek V4 Flash",
    url: "https://api.deepseek.com/chat/completions",
    keyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-flash",
  },
  v4pro: {
    label: "DeepSeek V4 Pro",
    url: "https://api.deepseek.com/chat/completions",
    keyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-pro",
  },
  qwen: {
    label: "Qwen Flash",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    keyEnv: "QWEN_API_KEY",
    model: "qwen-flash",
  },
};

const MODEL_ALIASES = {
  flash: "v4flash",
  chat: "v4flash",
  reason: "v4pro",
  pro: "v4pro",
};

const MEMORY_KEYS = ["goals", "projects", "preferences", "facts"];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") return new Response("Telegram AI Worker OK");
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const expectedSecret = env.TG_SECRET_TOKEN;
    if (expectedSecret && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const message = update?.message;
    if (!message?.chat?.id || typeof message.text !== "string") return new Response("OK");
    if (!isAllowed(message, env)) return new Response("OK");

    // Telegram expects a quick acknowledgement. Work continues after the webhook response.
    ctx.waitUntil(processMessage(message, env));
    return new Response("OK");
  },
};

function isAllowed(message, env) {
  const ids = String(env.TG_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  // Backward-compatible when unset, but production deployments should always configure it.
  if (ids.length === 0) {
    console.warn("TG_ALLOWED_USER_IDS is not configured; the bot accepts every Telegram user.");
    return true;
  }

  const userId = String(message.from?.id || "");
  const chatId = String(message.chat.id);
  return ids.includes(userId) || ids.includes(chatId);
}

async function processMessage(message, env) {
  const chatId = String(message.chat.id);
  const text = message.text.trim().slice(0, MAX_INPUT_LENGTH);

  if (text.startsWith("/")) {
    await handleCommand(chatId, text, env);
    return;
  }

  const [shortMem, longMem, aiConfig] = await Promise.all([
    readJson(env.CHAT_KV, key(chatId, "short"), []),
    readJson(env.CHAT_KV, key(chatId, "long"), emptyMemory()),
    readJson(env.CHAT_KV, key(chatId, "ai"), defaultAI()),
  ]);

  const config = normalizeAI(aiConfig);
  const history = [...shortMem, { role: "user", content: text }].slice(-MAX_CONTEXT_MESSAGES);
  const reply = await callAI(env, config, longMem, history);
  await sendTG(env, chatId, reply);

  // Do not make the user wait for the second model call used for memory extraction.
  const nextHistory = [...history, { role: "assistant", content: reply }].slice(-MAX_CONTEXT_MESSAGES);
  await env.CHAT_KV.put(key(chatId, "short"), JSON.stringify(nextHistory));

  const memoryUpdate = await shouldRemember(env, text);
  if (memoryUpdate) {
    const merged = mergeMemory(longMem, memoryUpdate);
    await env.CHAT_KV.put(key(chatId, "long"), JSON.stringify(merged));
  }
}

async function handleCommand(chatId, rawText, env) {
  const [command, ...args] = rawText.split(/\s+/);
  const name = command.split("@")[0].toLowerCase();
  const argText = args.join(" ").trim();

  if (name === "/start" || name === "/help") {
    await sendTG(env, chatId, helpText());
    return;
  }

  if (name === "/model" || name === "/setmodel") {
    const selectedModel = normalizeModelName(argText);
    if (!selectedModel) {
      await sendTG(env, chatId, "可选模型：\n" + ["v4flash", "v4pro", "qwen"].map((m) => `/model ${m} — ${MODELS[m].label}`).join("\n"));
      return;
    }
    const config = normalizeAI(await readJson(env.CHAT_KV, key(chatId, "ai"), defaultAI()));
    config.model = selectedModel;
    await env.CHAT_KV.put(key(chatId, "ai"), JSON.stringify(config));
    await sendTG(env, chatId, `已切换到 ${MODELS[selectedModel].label}。\n当前 AI：${config.name}`);
    return;
  }

  if (name === "/ai" || name === "/current") {
    const config = normalizeAI(await readJson(env.CHAT_KV, key(chatId, "ai"), defaultAI()));
    await sendTG(env, chatId, formatAI(config));
    return;
  }

  if (name === "/setname") {
    if (!argText || argText.length > 40) {
      await sendTG(env, chatId, "用法：/setname 你的 AI 名称（最多 40 个字符）");
      return;
    }
    const config = normalizeAI(await readJson(env.CHAT_KV, key(chatId, "ai"), defaultAI()));
    config.name = argText;
    await env.CHAT_KV.put(key(chatId, "ai"), JSON.stringify(config));
    await sendTG(env, chatId, `AI 名称已设置为：${config.name}`);
    return;
  }

  if (name === "/setprompt") {
    if (!argText || argText.length > MAX_SYSTEM_PROMPT_LENGTH) {
      await sendTG(env, chatId, `用法：/setprompt 你的角色设定（最多 ${MAX_SYSTEM_PROMPT_LENGTH} 个字符）`);
      return;
    }
    const config = normalizeAI(await readJson(env.CHAT_KV, key(chatId, "ai"), defaultAI()));
    config.systemPrompt = argText;
    await env.CHAT_KV.put(key(chatId, "ai"), JSON.stringify(config));
    await sendTG(env, chatId, "系统提示词已更新。它只影响你的 AI 配置，不会改变服务器 API Key。");
    return;
  }

  if (name === "/settemp") {
    const temperature = Number(argText);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      await sendTG(env, chatId, "用法：/settemp 0 到 2 之间的数字，例如 /settemp 0.7");
      return;
    }
    const config = normalizeAI(await readJson(env.CHAT_KV, key(chatId, "ai"), defaultAI()));
    config.temperature = temperature;
    await env.CHAT_KV.put(key(chatId, "ai"), JSON.stringify(config));
    await sendTG(env, chatId, `随机性已设置为 ${temperature}。Reasoner 模式会忽略此设置。`);
    return;
  }

  if (name === "/resetai") {
    await Promise.all([
      env.CHAT_KV.delete(key(chatId, "ai")),
      env.CHAT_KV.delete(key(chatId, "short")),
    ]);
    await sendTG(env, chatId, "AI 配置和短期上下文已恢复默认，长期记忆保留。\n" + formatAI(defaultAI()));
    return;
  }

  if (name === "/memory") {
    const memory = normalizeMemory(await readJson(env.CHAT_KV, key(chatId, "long"), emptyMemory()));
    await sendTG(env, chatId, formatMemory(memory));
    return;
  }

  if (name === "/clear") {
    await Promise.all([
      env.CHAT_KV.delete(key(chatId, "short")),
      env.CHAT_KV.delete(key(chatId, "long")),
    ]);
    await sendTG(env, chatId, "短期上下文和长期记忆已清除。");
    return;
  }

  await sendTG(env, chatId, "未知命令。发送 /help 查看用法。");
}

async function callAI(env, config, longMem, history) {
  const modelConfig = MODELS[config.model] || MODELS[DEFAULT_MODEL];
  const apiKey = env[modelConfig.keyEnv];
  if (!apiKey) return `未配置 ${modelConfig.label} 的 API Key。请联系管理员。`;

  const body = {
    model: modelConfig.model,
    messages: [
      { role: "system", content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
      { role: "system", content: "以下是用户授权保存的长期记忆，仅作参考：" + JSON.stringify(longMem) },
      ...history,
    ],
  };

  // DeepSeek thinking mode does not use the normal sampling controls.
  if (!modelConfig.reasoning) body.temperature = config.temperature;

  try {
    const response = await fetchWithRetry(modelConfig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "模型没有返回有效内容，请稍后重试。";
  } catch (error) {
    console.error("AI request failed", { model: config.model, error: error.message });
    return friendlyApiError(error);
  }
}

async function shouldRemember(env, text) {
  const cfg = env.QWEN_API_KEY ? MODELS.qwen : MODELS.v4flash;
  const apiKey = env[cfg.keyEnv];
  if (!apiKey) return null;

  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: '只提取明确、稳定、对未来有帮助的信息。没有则输出 null；有则只输出 JSON：{"goals":[],"projects":[],"preferences":[],"facts":[]}。不要输出解释。' },
      { role: "user", content: text },
    ],
    temperature: 0,
  };

  try {
    const response = await fetchWithRetry(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    let content = String(data?.choices?.[0]?.message?.content || "").trim();
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    if (!content || content === "null") return null;
    return normalizeMemory(JSON.parse(content));
  } catch (error) {
    console.error("Memory extraction failed", error.message);
    return null;
  }
}

async function fetchWithRetry(url, options, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
      if (response.ok) return response;
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError || new Error("Request failed");
}

async function sendTG(env, chatId, text) {
  const content = String(text || "模型返回为空。" );
  for (let i = 0; i < content.length; i += MAX_TG_LENGTH) {
    const chunk = content.slice(i, i + MAX_TG_LENGTH);
    try {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.description || "Telegram API error");
    } catch (error) {
      console.error("Telegram send failed", { chatId, error: error.message });
    }
  }
}

function key(chatId, suffix) { return `${chatId}_${suffix}`; }
function emptyMemory() { return { goals: [], projects: [], preferences: [], facts: [] }; }
function defaultAI() { return { name: "我的 AI", model: DEFAULT_MODEL, systemPrompt: DEFAULT_SYSTEM_PROMPT, temperature: DEFAULT_TEMPERATURE }; }

function normalizeModelName(value) {
  const name = String(value || "").toLowerCase();
  return MODELS[name] ? name : MODEL_ALIASES[name] || null;
}

function normalizeAI(value) {
  const base = defaultAI();
  const config = value && typeof value === "object" ? value : {};
  return {
    name: String(config.name || base.name).slice(0, 40),
    model: normalizeModelName(config.model) || base.model,
    systemPrompt: String(config.systemPrompt || base.systemPrompt).slice(0, MAX_SYSTEM_PROMPT_LENGTH),
    temperature: Number.isFinite(Number(config.temperature)) ? Math.min(2, Math.max(0, Number(config.temperature))) : base.temperature,
  };
}

function normalizeMemory(value) {
  const output = emptyMemory();
  for (const field of MEMORY_KEYS) {
    const values = Array.isArray(value?.[field]) ? value[field] : [];
    output[field] = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].slice(-MAX_MEMORY_ITEMS);
  }
  return output;
}

function mergeMemory(oldMemory, newMemory) {
  const oldValue = normalizeMemory(oldMemory);
  const newValue = normalizeMemory(newMemory);
  return normalizeMemory(Object.fromEntries(MEMORY_KEYS.map((field) => [field, [...oldValue[field], ...newValue[field]]] )));
}

async function readJson(kv, name, fallback) {
  try { return JSON.parse((await kv.get(name)) || "null") || fallback; }
  catch { return fallback; }
}

function formatAI(config) {
  return `当前 AI：${config.name}\n模型：${MODELS[config.model].label}\n随机性：${config.temperature}\n系统提示词：${config.systemPrompt}`;
}

function formatMemory(memory) {
  const lines = MEMORY_KEYS.flatMap((field) => memory[field].length ? [`${field}：`, ...memory[field].map((item) => `- ${item}`)] : []);
  return lines.length ? `长期记忆：\n${lines.join("\n")}` : "暂无长期记忆。";
}

function helpText() {
  return [
    "可用命令：",
    "/ai 查看当前 AI 配置",
    "/setname 名称 设置 AI 名称",
    "/setprompt 提示词 设置角色和行为",
    "/model v4flash|v4pro|qwen 切换模型",
    "/settemp 0.7 设置随机性（Reasoner 忽略）",
    "/resetai 恢复 AI 默认配置",
    "/memory 查看长期记忆",
    "/clear 清除上下文和长期记忆",
  ].join("\n");
}

function friendlyApiError(error) {
  if (error?.name === "TimeoutError") return "模型请求超时，请稍后重试。";
  if (error?.status === 401 || error?.status === 403) return "模型 API Key 无效或已过期，请联系管理员。";
  if (error?.status === 429) return "请求过于频繁，请稍后再试。";
  return "模型调用失败，请稍后重试。";
}
