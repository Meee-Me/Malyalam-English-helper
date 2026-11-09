// Shared logic for Malayalam AI Helper. Each handler takes a web-standard
// Request and returns a Response, so the same code runs on Vercel (api/*.js)
// and on your own computer (server.js).
//
//   voice (Malayalam) --Sarvam speech-to-text--> Malayalam text
//   --ChatGPT--> answer in English --ChatGPT--> answer in Malayalam
//   --Sarvam text-to-speech--> spoken Malayalam

import OpenAI from "openai";

const env = (name, fallback = "") => process.env[name] || fallback;

// Read settings on each request, so keys added on Vercel apply after a redeploy
// and keys in .env apply locally.
function settings() {
  const model = env("OPENAI_MODEL", "gpt-5.5");
  return {
    password: env("APP_PASSWORD"),
    openaiKey: env("OPENAI_API_KEY"),
    model,
    reasoning: /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: "low" } : {},
    sarvamKey: env("SARVAM_API_KEY"),
    sarvamBase: env("SARVAM_BASE_URL", "https://api.sarvam.ai").replace(/\/$/, ""),
    speaker: env("SARVAM_SPEAKER"),
    pace: Number(env("SARVAM_PACE")) || 0.9, // a little slower than normal
  };
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
    chat: Boolean(s.openaiKey),
    voice: Boolean(s.sarvamKey),
  });
}

// ---------- POST /api/chat (ChatGPT) ----------
/** Streams one ChatGPT call, calling onText for each text chunk. Returns the full text. */
async function streamText(openai, s, system, messages, onText, signal) {
  const stream = await openai.chat.completions.create(
    {
      model: s.model,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
      ...s.reasoning,
    },
    { signal },
  );
  let text = "";
  let finish = null;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const piece = choice.delta?.content;
    if (piece) {
      text += piece;
      onText(piece);
    }
    if (choice.delta?.refusal) finish = "refusal";
    if (choice.finish_reason) finish = finish || choice.finish_reason;
  }
  if (finish === "content_filter" || finish === "refusal" || (!text && finish)) {
    const err = new Error("refusal");
    err.code = "refusal";
    throw err;
  }
  return text;
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
  if (!s.openaiKey) return json(503, { error: "auth" });
  const messages = cleanHistory(body.messages);
  if (!messages) return json(400, { error: "bad_request" });

  const openai = new OpenAI({ apiKey: s.openaiKey });
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
        const english = await streamText(openai, s, CHAT_SYSTEM, messages, (text) => send({ type: "en", text }), abort.signal);
        send({ type: "en_done" });
        // 2) Translate the English answer into Malayalam.
        await streamText(
          openai,
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
          else if (err instanceof OpenAI.AuthenticationError) code = "auth";
          else if (err instanceof OpenAI.RateLimitError) code = "busy";
          else if (err instanceof OpenAI.APIConnectionError) code = "network";
          else if (err instanceof OpenAI.APIError && err.status >= 500) code = "busy";
          console.error("Chat error:", err?.message || err);
          send({ type: "error", code });
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
