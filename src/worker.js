// ===== Configuration =====
const MAX_SHORT = 16;
const MAX_TG_LENGTH = 4000;
const DEFAULT_MODEL = "flash";

const MODELS = {
  flash: {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    keyEnv: "QWEN_API_KEY",
    model: "qwen-flash",
  },
  chat: {
    url: "https://api.deepseek.com/v1/chat/completions",
    keyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-chat",
  },
  reason: {
    url: "https://api.deepseek.com/v1/chat/completions",
    keyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-reasoner",
  },
};

// ===== Main Worker =====
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK");

    // Webhook authentication: prevent unauthorized API abuse
    if (env.TG_SECRET_TOKEN) {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.TG_SECRET_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const message = update.message;
    if (!message || !message.text) return new Response("OK");

    // Process asynchronously to avoid blocking Telegram webhook
    // (prevents timeout retries and double billing)
    ctx.waitUntil(processMessage(message, env));
    return new Response("OK");
  },
};

// ===== Message Processing =====
async function processMessage(message, env) {
  const chatId = message.chat.id.toString();
  const text = message.text.trim();

  // Handle commands (don't pollute conversation context)
  if (text.startsWith("/")) {
    return handleCommand(chatId, text, env);
  }

  // Parallel KV reads
  const [shortMemStr, longMemStr, modelChoice] = await Promise.all([
    env.CHAT_KV.get(chatId + "_short"),
    env.CHAT_KV.get(chatId + "_long"),
    env.CHAT_KV.get(chatId + "_model"),
  ]);

  let shortMem = shortMemStr ? JSON.parse(shortMemStr) : [];
  let longMem = longMemStr
    ? JSON.parse(longMemStr)
    : { goals: [], projects: [], preferences: [], facts: [] };
  const model = modelChoice || DEFAULT_MODEL;

  // Add user message to short-term memory
  shortMem.push({ role: "user", content: text });
  if (shortMem.length > MAX_SHORT) shortMem = shortMem.slice(-MAX_SHORT);

  // Call AI
  const reply = await callAI(env, model, longMem, shortMem);

  // Add assistant reply to short-term memory
  shortMem.push({ role: "assistant", content: reply });
  if (shortMem.length > MAX_SHORT) shortMem = shortMem.slice(-MAX_SHORT);

  await env.CHAT_KV.put(chatId + "_short", JSON.stringify(shortMem));

  // Smart long-term memory check
  const memUpdate = await shouldRemember(env, text);
  if (memUpdate) {
    longMem = mergeMemory(longMem, memUpdate);
    await env.CHAT_KV.put(chatId + "_long", JSON.stringify(longMem));
  }

  // Send reply (with automatic long-text splitting)
  await sendTG(env, chatId, reply);
}

// ===== Command Handler =====
async function handleCommand(chatId, text, env) {
  if (text.startsWith("/model")) {
    const choice = text.split(" ")[1];
    if (MODELS[choice]) {
      await env.CHAT_KV.put(chatId + "_model", choice);
      await sendTG(env, chatId, "已切换模型为: " + choice);
    } else {
      const list = Object.keys(MODELS).map((m) => "/model " + m).join("\n");
      await sendTG(env, chatId, "可选模型:\n" + list);
    }
    return;
  }

  if (text === "/current") {
    const m = (await env.CHAT_KV.get(chatId + "_model")) || DEFAULT_MODEL;
    await sendTG(env, chatId, "当前模型: " + m);
    return;
  }

  if (text === "/clear") {
    await Promise.all([
      env.CHAT_KV.delete(chatId + "_short"),
      env.CHAT_KV.delete(chatId + "_long"),
    ]);
    await sendTG(env, chatId, "记忆已清除");
    return;
  }

  if (text === "/memory") {
    const mem = await env.CHAT_KV.get(chatId + "_long");
    await sendTG(env, chatId, mem || "暂无长期记忆");
    return;
  }

  // Unknown commands fall through to AI processing in processMessage
}

// ===== AI Model Call =====
async function callAI(env, modelName, longMem, shortMem) {
  const cfg = MODELS[modelName];
  if (!cfg) return "未知模型: " + modelName;

  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: "system", content: env.SYSTEM_PROMPT || "你是一个有用的助手。" },
      { role: "system", content: "长期记忆: " + JSON.stringify(longMem) },
      ...shortMem,
    ],
    temperature: 0.7,
  });

  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env[cfg.keyEnv],
      },
      body,
    });
  } catch (e) {
    console.error("AI fetch error:", e.message);
    return "网络请求失败，请稍后重试。";
  }

  // Check HTTP status
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("AI API error " + res.status + ": " + errText.slice(0, 200));
    if (res.status === 401 || res.status === 403) {
      return "模型 API Key 无效或已过期，请检查配置。";
    }
    if (res.status === 429) {
      return "请求过于频繁，请稍后再试。";
    }
    return "模型调用失败 (HTTP " + res.status + ")，请稍后重试。";
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return "模型返回格式异常，请重试。";
  }

  return data.choices?.[0]?.message?.content || "模型返回为空，请重试。";
}

// ===== Smart Memory Detection (always uses flash to save cost) =====
async function shouldRemember(env, text) {
  let res;
  try {
    res = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + env.QWEN_API_KEY,
        },
        body: JSON.stringify({
          model: "qwen-flash",
          messages: [
            {
              role: "system",
              content:
                "判断是否为长期重要信息，是则输出 JSON {"goals":[],"projects":[],"preferences":[],"facts":[]}，否则只输出 null。只输出纯文本，不要用 markdown 代码块包裹。",
            },
            { role: "user", content: text },
          ],
          temperature: 0,
        }),
      }
    );
  } catch (e) {
    console.error("Memory check fetch error:", e.message);
    return null;
  }

  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  let content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  // Strip markdown code fences (LLMs often wrap JSON in ```json ... ```)
  content = content.trim();
  content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");

  if (content === "null" || content === "") return null;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ===== Memory Merge =====
function mergeMemory(oldM, newM) {
  for (const k in newM) {
    oldM[k] = [...new Set([...(oldM[k] || []), ...(newM[k] || [])])];
  }
  return oldM;
}

// ===== Send Telegram Message (with auto-splitting for long text) =====
async function sendTG(env, chatId, text) {
  for (let i = 0; i < text.length; i += MAX_TG_LENGTH) {
    const chunk = text.slice(i, i + MAX_TG_LENGTH);
    try {
      await fetch(
        "https://api.telegram.org/bot" + env.TG_TOKEN + "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        }
      );
    } catch (e) {
      console.error("sendTG error:", e.message);
    }
  }
}
