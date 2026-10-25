import { RESPONSE_SCHEMA, buildSystemPrompt, buildUserPrompt, normalizeAiResult } from "./prompt.mjs";
import { markdownToHtml, summaryBox } from "./notes.mjs";
import { sanitizeHtml } from "./html.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 使用するAIプロバイダを決める */
export function resolveProvider(config, noAi = false) {
  if (noAi) return { name: "template" };

  const requested = (process.env.AI_PROVIDER || config.ai.provider || "auto").toLowerCase();
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  if (requested === "gemini" || requested === "auto") {
    if (geminiKey) {
      const primary = process.env.GEMINI_MODEL || config.ai.model;
      const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ||
        "gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        name: "gemini",
        model: primary,
        models: [...new Set([primary, ...fallbacks])],
        apiKey: geminiKey,
      };
    }
  }
  if (requested === "openai" || requested === "auto") {
    if (openaiKey) {
      return {
        name: "openai",
        model: process.env.OPENAI_MODEL || config.ai.openai?.model || "gpt-4o-mini",
        baseUrl: process.env.OPENAI_BASE_URL || config.ai.openai?.baseUrl || "https://api.openai.com/v1",
        apiKey: openaiKey,
      };
    }
  }
  return { name: "template" };
}

async function callGemini({ apiKey, model, temperature, maxOutputTokens, system, user }) {
  const base = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 45000);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json();
      if (!res.ok) {
        const message = json?.error?.message || `HTTP ${res.status}`;
        if (res.status === 429 || res.status >= 500) throw new Error(message);
        const err = new Error(`Gemini API: ${message}`);
        err.fatal = true;
        throw err;
      }
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      if (!text) throw new Error("Geminiが空の応答を返しました");
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      if (err.fatal) throw err;
      if (attempt === 0) await sleep(800);
    }
  }
  throw lastError;
}

export function extractJson(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("AIの応答からJSONを抽出できませんでした");
  return JSON.parse(body.slice(start, end + 1));
}
async function callOpenAiCompatible({ apiKey, baseUrl, model, temperature, maxTokens, system, user }) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const makeBody = (withFormat) => ({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(withFormat ? { response_format: { type: "json_object" } } : {}),
  });

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(makeBody(true)),
      });
      if (res.status === 400) {
        // response_format 非対応のサーバー向けに再試行
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(makeBody(false)),
        });
      }
      const json = await res.json();
      if (!res.ok) {
        const message = json?.error?.message || `HTTP ${res.status}`;
        if (res.status === 429 || res.status >= 500) throw new Error(message);
        const err = new Error(`OpenAI互換API: ${message}`);
        err.fatal = true;
        throw err;
      }
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error("AIが空の応答を返しました");
      return extractJson(content);
    } catch (err) {
      lastError = err;
      if (err.fatal) throw err;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * AI生成。キーがない場合はテンプレート生成にフォールバックする。
 */
export async function generateArticle({ note, meta, promises, config, today, noAi = false }) {
  const provider = resolveProvider(config, noAi);

  if (provider.name === "template") {
    return { ...templateArticle({ note, meta, today }), generatedBy: "template" };
  }

  const system = buildSystemPrompt();
  const user = buildUserPrompt({ note, meta, promises, today });

  let raw;
  let usedModel = provider.model;

  if (provider.name === "gemini") {
    let lastError;
    for (const model of provider.models || [provider.model]) {
      try {
        raw = await callGemini({
          apiKey: provider.apiKey,
          model,
          temperature: config.ai.temperature,
          maxOutputTokens: config.ai.maxOutputTokens,
          system,
          user,
        });
        usedModel = model;
        break;
      } catch (err) {
        lastError = err;
        if (err.fatal) throw err;
      }
    }
    if (!raw) {
      throw new Error(
        "Geminiの全モデルが応答しませんでした。時間をおいて再試行してください。\n" +
          `最後のエラー: ${lastError?.message || lastError}`
      );
    }
  } else {
    raw = await callOpenAiCompatible({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      temperature: config.ai.temperature,
      maxTokens: config.ai.maxOutputTokens,
      system,
      user,
    });
  }

  const normalized = normalizeAiResult(raw, { meta, promises, today });
  if (!normalized.description || normalized.description.length < 40) {
    throw new Error("AIの本文が短すぎます。素材メモを増やすか、--no-ai でテンプレート生成してください。");
  }
  return { ...normalized, generatedBy: `${provider.name}:${usedModel}` };
}

/** AIなしでも使えるテンプレート生成（front matter + 本文Markdown） */
export function templateArticle({ note, meta, today }) {
  if (!meta.title || !meta.subtitle) {
    throw new Error(
      "AIを使わない場合は、メモの先頭に title と subtitle を書いてください。\n" +
        "（例）\n---\ntitle: 【後期役員会】第2回 緑友会議\nsubtitle: 11/5 の会議内容について\ncategory: 会議\ndate: 2026-11-05\n---"
    );
  }
  const body = markdownToHtml(note);
  const description = sanitizeHtml(`${summaryBox("ポイント", meta.subtitle)}${body}`);
  return {
    title: String(meta.title).slice(0, 80),
    subtitle: String(meta.subtitle).slice(0, 100),
    category: meta.category || "広報",
    date: meta.date || today,
    description,
    promise_ids: Array.isArray(meta.promise_ids)
      ? meta.promise_ids
      : meta.promise_ids
        ? [meta.promise_ids]
        : [],
    image_url: meta.image_url || "",
  };
}

/** キーなし運用向け: 生成に使うプロンプトをそのまま出力する */
export function buildCopyPrompt({ note, meta, promises, today }) {
  return `${buildSystemPrompt()}

---

${buildUserPrompt({ note, meta, promises, today })}

---

# 出力形式（このJSONだけを返してください）
{
  "title": "記事タイトル",
  "subtitle": "サブタイトル",
  "category": "会議|イベント|施策|点検|広報|その他",
  "description_html": "<div>...</div>",
  "promise_ids": ["promise-..."],
  "image_url": ""
}`;
}
