// Shared logic for Malayalam AI Helper. Each handler takes a web-standard
// Request and returns a Response, so the same code runs on Vercel (api/*.js)
// and on your own computer (server.js).
//
//   voice (Malayalam) --Sarvam speech-to-text--> Malayalam text
//   --Gemini--> answer in English --Gemini--> answer in Malayalam
//   --Sarvam text-to-speech--> spoken Malayalam

import { ApiError, GoogleGenAI } from "@google/genai";

const env = (name, fallback = "") => process.env[name] || fallback;

// Read settings on each request, so keys added on Vercel apply after a redeploy
// and keys in .env apply locally.
function settings() {
  return {
    password: env("APP_PASSWORD"),
    geminiKey: env("GEMINI_API_KEY"),
    geminiBase: env("GEMINI_BASE_URL"), // only for testing
    preferredModel: env("GEMINI_MODEL"), // optional: try this model first
    sarvamKey: env("SARVAM_API_KEY"),
    sarvamBase: env("SARVAM_BASE_URL", "https://api.sarvam.ai").replace(/\/$/, ""),
    speaker: env("SARVAM_SPEAKER"),
    pace: Number(env("SARVAM_PACE")) || 0.9, // a little slower than normal
  };
}

// Used only if Google's model list can't be fetched.
const FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"];

// ---------- Choosing a Gemini model ----------
// Google retires model names over time (e.g. gemini-2.5-flash is "no longer
// available to new users"), so instead of hard-coding names we ask Google which
// models this key can use and rank them: newest Flash-Lite first, then Flash.
function modelVersion(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function rankModels(names) {
  const usable = names.filter(
    (n) =>
      /^gemini-/.test(n) &&
      /flash/.test(n) &&
      !/(image|tts|audio|live|embedding|robotics|computer|thinking|exp)/.test(n),
  );
  // A "-latest" alias points at the newest model, so rank it just below the
  // newest named version and above older ones.
  const newest = Math.max(0, ...usable.map(modelVersion));
  const version = (n) => (/latest/.test(n) ? newest - 0.001 : modelVersion(n));
  const score = (n) => {
    const lite = /flash-lite/.test(n) ? 0 : 1; // Flash-Lite before Flash
    const preview = /preview/.test(n) ? 1 : 0; // stable before preview
    return [lite, preview, -version(n), n.length];
  };
  return usable.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
    return a.localeCompare(b);
  });
}

let modelCache = { at: 0, list: null };
async function availableModels(ai) {
  if (modelCache.list && Date.now() - modelCache.at < 60 * 60 * 1000) return modelCache.list;
  try {
    const names = [];
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    for await (const m of pager) {
      const actions = m.supportedActions || [];
      if (actions.length && !actions.includes("generateContent")) continue;
      if (m.name) names.push(m.name.replace(/^models\//, ""));
    }
    const ranked = rankModels(names);
    if (ranked.length) {
      console.log("Gemini models available (best first):", ranked.slice(0, 6).join(", "));
      modelCache = { at: Date.now(), list: ranked };
      return ranked;
    }
  } catch (err) {
    console.warn("Could not list Gemini models:", String(err?.message || err).slice(0, 200));
  }
  return FALLBACK_MODELS;
}

// Gemini 3 models: keep thinking short so answers start quickly.
function thinkingFor(model) {
  return /^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: "LOW" } } : {};
}

// Voice is always Malayalam.
const LANGUAGE = "ml-IN";
const SARVAM_STT_MODEL = "saaras:v3";
const SARVAM_TTS_MODEL = "bulbul:v3";
const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // Vercel accepts request bodies up to 4.5 MB
const MAX_TTS_CHARS = 2500; // bulbul:v3 limit per request
const MAX_TURNS = 40; // keep only the most recent messages
const MAX_CHARS = 4000; // per message

const CHAT_SYSTEM = `You are a warm, patient, and respectful assistant helping an elderly person from Kerala, India.
Their messages may be in Malayalam, English, or a mix (including Malayalam typed in English letters, "Manglish").
Always reply in clear, simple English - your reply will be translated into Malayalam automatically, so:
- Use short sentences and everyday words. Avoid slang, idioms, and puns that don't translate.
- Prefer short paragraphs and simple numbered or bulleted lists. Do not use tables, headings, or code blocks unless asked.
- Be concise; most answers should be a few short paragraphs at most.
- For health, legal, or money questions, give helpful general information and gently suggest talking to a doctor, lawyer, or trusted family member when it matters.
- Never say that you are replying in English or mention the translation.`;

const TRANSLATE_SYSTEM = `You are an expert English-to-Malayalam translator.
Translate the user's text into natural, simple, everyday Malayalam written in Malayalam script, as a respectful family member would speak to an elder.
Rules:
- Output ONLY the Malayalam translation - no notes, no English preamble, no quotation marks around it.
- Keep the same paragraphs, line breaks, and list numbering/bullets.
- Keep names of people, brands, apps, and websites recognisable; you may add the English term in brackets after a technical word if it helps.
- Keep numbers, phone numbers, URLs, and units as they are.`;

// ---------- helpers ----------
function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function passwordOk(request, s, bodyPassword) {
  if (!s.password) return true;
  return (request.headers.get("x-app-password") || bodyPassword) === s.password;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 1_000_000) throw new Error("too large");
  return JSON.parse(text || "{}");
}

function sarvamErrorCode(status) {
  if (status === 401 || status === 403) return "sarvam_key";
  if (status === 429 || status >= 500) return "busy";
  return "voice";
}

function cleanHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim(),
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_TURNS);
  // The conversation must start with a user turn and end with one.
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

// ---------- GET /api/config ----------
export function handleConfig() {
  const s = settings();
  return json(200, {
    needsPassword: Boolean(s.password),
    chat: Boolean(s.geminiKey),
    voice: Boolean(s.sarvamKey),
  });
}

// ---------- POST /api/chat (Gemini) ----------
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

/** Streams one Gemini call, calling onText for each text chunk. Returns the full text. */
async function streamOnce(ai, model, system, messages, onText, signal) {
  const stream = await ai.models.generateContentStream({
    model,
    // Gemini calls the assistant role "model".
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    config: { systemInstruction: system, abortSignal: signal, ...thinkingFor(model) },
  });
  let text = "";
  let blocked = false;
  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) blocked = true;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason && BLOCKED.has(candidate.finishReason)) blocked = true;
    const piece = (candidate?.content?.parts || [])
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");
    if (piece) {
      text += piece;
      onText(piece);
    }
  }
  if (blocked || !text) {
    const err = new Error("refusal");
    err.code = "refusal";
    throw err;
  }
  return text;
}

// Google's error text, without the JSON wrapping.
function googleMessage(err) {
  const raw = String(err?.message || "").replace(/\\/g, "");
  return (raw.match(/"message":\s*"([^"]+)"/)?.[1] || raw).replace(/\s+/g, " ").trim();
}

// Errors where trying a different model can help: quota used up (429), model not
// found / not allowed for this key (404, 403 on a model), or an unsupported setting (400).
function shouldTryNextModel(err) {
  if (!(err instanceof ApiError)) return false;
  if (/api key/i.test(err.message)) return false; // a bad key fails on every model
  return [400, 403, 404, 429, 500, 503].includes(err.status);
}

/**
 * Streams from the first model that works. Remembers the working model so later
 * requests on the same warm function go straight to it.
 */
let workingModel = null;
const retiredModels = new Set(); // 404 "not found / no longer available" for this key
async function streamText(ai, s, system, messages, onText, signal) {
  const models = await availableModels(ai);
  const order = [...new Set([s.preferredModel, workingModel, ...models].filter(Boolean))]
    .filter((m) => !retiredModels.has(m))
    .slice(0, 6);
  const failures = [];
  let lastErr;
  for (const model of order) {
    let started = false;
    try {
      const text = await streamOnce(ai, model, system, messages, (t) => {
        started = true;
        onText(t);
      }, signal);
      workingModel = model;
      return text;
    } catch (err) {
      lastErr = err;
      // Once text has reached the user we can't switch models mid-answer.
      if (started || signal?.aborted || !shouldTryNextModel(err)) throw err;
      if (err.status === 404) retiredModels.add(model);
      failures.push(`${model} → ${err.status} ${googleMessage(err).slice(0, 90)}`);
      console.warn(`Gemini model ${model} failed (${err.status}): ${String(err.message).slice(0, 300)}`);
    }
  }
  if (!lastErr) {
    lastErr = new Error("No Gemini model available for this key");
    lastErr.code = "no_model";
  }
  lastErr.failures = failures;
  throw lastErr;
}

export async function handleChat(request) {
  const s = settings();
  let body;
  try {
    body = await readJson(request);
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!passwordOk(request, s, body.password)) return json(401, { error: "password" });
  if (!s.geminiKey) return json(503, { error: "auth" });
  const messages = cleanHistory(body.messages);
  if (!messages) return json(400, { error: "bad_request" });

  const ai = new GoogleGenAI({
    apiKey: s.geminiKey,
    ...(s.geminiBase ? { httpOptions: { baseUrl: s.geminiBase } } : {}),
  });
  const abort = new AbortController();
  request.signal?.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();

  // Server-Sent Events: {type:"en"|"ml", text} chunks, then {type:"done"} or {type:"error"}.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {}
      };
      try {
        // 1) Get the answer in English.
        const english = await streamText(ai, s, CHAT_SYSTEM, messages, (text) => send({ type: "en", text }), abort.signal);
        send({ type: "en_done" });
        // 2) Translate the English answer into Malayalam.
        await streamText(
          ai,
          s,
          TRANSLATE_SYSTEM,
          [{ role: "user", content: english }],
          (text) => send({ type: "ml", text }),
          abort.signal,
        );
        send({ type: "done" });
      } catch (err) {
        if (!abort.signal.aborted) {
          let code = "server";
          if (err?.code === "refusal") code = "refusal";
          else if (err instanceof ApiError) {
            // 400 "API key not valid", 401/403 = bad key; 429 = free-tier limit reached
            if (err.status === 401 || err.status === 403 || /api key/i.test(err.message)) code = "auth";
            else if (err.status === 429 || err.status >= 500) code = "busy";
          } else if (err instanceof TypeError) code = "network";
          console.error("Chat error:", err?.message || err);
          // A short, key-free reason from Google, shown in small text to help fix setup.
          let detail = "";
          if (err instanceof ApiError) {
            detail = err.failures?.length
              ? `Gemini: ${err.failures.join(" | ")}`.slice(0, 600)
              : `Gemini ${err.status}: ${googleMessage(err).slice(0, 200)}`;
          }
          send({ type: "error", code, detail });
        }
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

// ---------- POST /api/transcribe (Sarvam speech-to-text) ----------
const AUDIO_EXT = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export async function handleTranscribe(request) {
  const s = settings();
  if (!passwordOk(request, s)) return json(401, { error: "password" });
  if (!s.sarvamKey) return json(503, { error: "sarvam_key" });

  const audio = await request.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "too_long" });
  if (audio.byteLength < 1000) return json(200, { text: "" });

  const type = (request.headers.get("content-type") || "audio/webm").split(";")[0].trim();
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `voice.${AUDIO_EXT[type] || "webm"}`);
  form.append("model", SARVAM_STT_MODEL);
  form.append("mode", "transcribe");
  form.append("language_code", LANGUAGE);

  try {
    const r = await fetch(`${s.sarvamBase}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": s.sarvamKey },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      console.error("Sarvam speech-to-text error:", r.status, (await r.text()).slice(0, 500));
      return json(502, { error: sarvamErrorCode(r.status) });
    }
    const data = await r.json();
    return json(200, { text: (data.transcript || "").trim() });
  } catch (err) {
    console.error("Sarvam speech-to-text failed:", err?.message || err);
    return json(502, { error: "network" });
  }
}

// ---------- POST /api/speak (Sarvam text-to-speech) ----------
export async function handleSpeak(request) {
  const s = settings();
  let body;
  try {
    body = await readJson(request);
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!passwordOk(request, s, body.password)) return json(401, { error: "password" });
  if (!s.sarvamKey) return json(503, { error: "sarvam_key" });
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TTS_CHARS) : "";
  if (!text) return json(400, { error: "bad_request" });

  const payload = {
    text,
    language_code: LANGUAGE,
    model: SARVAM_TTS_MODEL,
    pace: s.pace,
    output_audio_codec: "mp3",
  };
  if (s.speaker) payload.speaker = s.speaker;

  try {
    const r = await fetch(`${s.sarvamBase}/text-to-speech`, {
      method: "POST",
      headers: { "api-subscription-key": s.sarvamKey, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      console.error("Sarvam text-to-speech error:", r.status, (await r.text()).slice(0, 500));
      return json(502, { error: sarvamErrorCode(r.status) });
    }
    const data = await r.json();
    const audio = data.audios?.[0];
    if (!audio) return json(502, { error: "voice" });
    return json(200, { audio });
  } catch (err) {
    console.error("Sarvam text-to-speech failed:", err?.message || err);
    return json(502, { error: "network" });
  }
}
