const MAX_SHORT = 4;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    const update = await request.json();
    const message = update.message;
    if (!message || !message.text) return new Response("OK");

    const chatId = message.chat.id.toString();
    const text = message.text.trim();

    // ===== 模型切换 =====
    if (text.startsWith("/model")) {
      const parts = text.split(" ");
      const choice = parts[1];

      if (["flash", "chat", "reason"].includes(choice)) {
        await env.CHAT_KV.put(chatId + "_model", choice);
        await sendTG(env, chatId, "已切换模型为: " + choice);
      } else {
        await sendTG(env, chatId,
          "可选模型:\n/model flash\n/model chat\n/model reason");
      }
      return new Response("OK");
    }

    if (text === "/current") {
      let m = await env.CHAT_KV.get(chatId + "_model");
      m = m || "flash";
      await sendTG(env, chatId, "当前模型: " + m);
      return new Response("OK");
    }

    if (text === "/clear") {
      await env.CHAT_KV.delete(chatId + "_short");
      await env.CHAT_KV.delete(chatId + "_long");
      await sendTG(env, chatId, "记忆已清除");
      return new Response("OK");
    }

    if (text === "/memory") {
      const mem = await env.CHAT_KV.get(chatId + "_long");
      await sendTG(env, chatId, mem || "暂无长期记忆");
      return new Response("OK");
    }

    // ===== 读取记忆 =====
    let shortMem = await env.CHAT_KV.get(chatId + "_short");
    shortMem = shortMem ? JSON.parse(shortMem) : [];

    let longMem = await env.CHAT_KV.get(chatId + "_long");
    longMem = longMem
      ? JSON.parse(longMem)
      : { goals: [], projects: [], preferences: [], facts: [] };

    shortMem.push({ role: "user", content: text });
    if (shortMem.length > MAX_SHORT)
      shortMem = shortMem.slice(-MAX_SHORT);

    const modelChoice =
      (await env.CHAT_KV.get(chatId + "_model")) || "flash";

    const reply = await callAI(
      env,
      modelChoice,
      longMem,
      shortMem
    );

    shortMem.push({ role: "assistant", content: reply });
    if (shortMem.length > MAX_SHORT)
      shortMem = shortMem.slice(-MAX_SHORT);

    await env.CHAT_KV.put(
      chatId + "_short",
      JSON.stringify(shortMem)
    );

    const memUpdate = await shouldRemember(
      env,
      text
    );

    if (memUpdate) {
      longMem = mergeMemory(longMem, memUpdate);
      await env.CHAT_KV.put(
        chatId + "_long",
        JSON.stringify(longMem)
      );
    }

    await sendTG(env, chatId, reply);
    return new Response("OK");
  }
}

// ===== 模型调用 =====
async function callAI(env, modelName, longMem, shortMem) {
  let url, key, model;

  if (modelName === "flash") {
    url =
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    key = env.QWEN_API_KEY;
    model = "qwen-flash";
  } else if (modelName === "chat") {
    url = "https://api.deepseek.com/v1/chat/completions";
    key = env.DEEPSEEK_API_KEY;
    model = "deepseek-chat";
  } else {
    url = "https://api.deepseek.com/v1/chat/completions";
    key = env.DEEPSEEK_API_KEY;
    model = "deepseek-reasoner";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: env.SYSTEM_PROMPT },
        {
          role: "system",
          content: "长期记忆: " + JSON.stringify(longMem)
        },
        ...shortMem
      ],
      temperature: 0.7
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "模型调用失败";
}

// ===== 智能记忆判断（统一用 flash 省钱）=====
async function shouldRemember(env, text) {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.QWEN_API_KEY}`
      },
      body: JSON.stringify({
        model: "qwen-flash",
        messages: [
          {
            role: "system",
            content:
              "判断是否为长期重要信息，是则输出JSON {goals,projects,preferences,facts} 否则输出 null"
          },
          { role: "user", content: text }
        ],
        temperature: 0
      })
    }
  );

  const data = await res.json();
  const content =
    data.choices?.[0]?.message?.content || "null";

  if (content.trim() === "null") return null;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function mergeMemory(oldM, newM) {
  for (let k in newM) {
    oldM[k] = [
      ...new Set([...(oldM[k] || []), ...(newM[k] || [])])
    ];
  }
  return oldM;
}

async function sendTG(env, chatId, text) {
  await fetch(
    `https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    }
  );
}
