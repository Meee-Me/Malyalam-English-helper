// Malayalam AI Helper - a ChatGPT-style assistant for Malayalam speakers.
//
//   voice (Malayalam) --Sarvam speech-to-text--> text --Claude--> English answer
//   --Claude--> Malayalam translation --Sarvam text-to-speech--> spoken Malayalam
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... SARVAM_API_KEY=... npm start   ->  http://localhost:3000

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Optional: set APP_PASSWORD so strangers can't use your API key.
const APP_PASSWORD = process.env.APP_PASSWORD || "";

// Sarvam AI (https://www.sarvam.ai) handles the voice parts.
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || "";
const SARVAM_BASE_URL = (process.env.SARVAM_BASE_URL || "https://api.sarvam.ai").replace(/\/$/, "");
const SARVAM_STT_MODEL = process.env.SARVAM_STT_MODEL || "saaras:v3";
const SARVAM_LANGUAGE = process.env.SARVAM_LANGUAGE || "ml-IN"; // "unknown" = auto-detect
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || "bulbul:v3";
const SARVAM_SPEAKER = process.env.SARVAM_SPEAKER || ""; // empty = model default voice
const SARVAM_PACE = Number(process.env.SARVAM_PACE) || 0.9; // a little slower than normal
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_TTS_CHARS = 2500; // bulbul:v3 limit per request

const MAX_TURNS = 40; // keep only the most recent messages
const MAX_CHARS = 4000; // per message

const client = new Anthropic();

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

// Server-side refusal fallback: if a request is declined, the API retries it on
// Anthropic's recommended fallback model instead of returning a refusal.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

/** Streams one Claude call, calling onText for each text chunk. Returns full text. */
async function streamText(params, onText, signal) {
  const stream = client.beta.messages.stream(
    { model: MODEL, max_tokens: 16000, ...FALLBACK, ...params },
    { signal },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      onText(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    const err = new Error("refusal");
    err.code = "refusal";
    throw err;
  }
  return text;
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

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = (await readBody(req, 1_000_000)).toString("utf8");
  return JSON.parse(body || "{}");
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function passwordOk(req, bodyPassword) {
  if (!APP_PASSWORD) return true;
  return (req.headers["x-app-password"] || bodyPassword) === APP_PASSWORD;
}

function sarvamErrorCode(status) {
  if (status === 401 || status === 403) return "sarvam_key";
  if (status === 429 || status >= 500) return "busy";
  return "voice";
}

// ---------- Voice -> text (Sarvam speech-to-text) ----------
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

async function handleTranscribe(req, res) {
  if (!passwordOk(req)) return sendJson(res, 401, { error: "password" });
  if (!SARVAM_API_KEY) return sendJson(res, 503, { error: "sarvam_key" });

  let audio;
  try {
    audio = await readBody(req, MAX_AUDIO_BYTES);
  } catch {
    return sendJson(res, 413, { error: "too_long" });
  }
  if (audio.length < 1000) return sendJson(res, 200, { text: "" });

  const type = String(req.headers["content-type"] || "audio/webm").split(";")[0].trim();
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `voice.${AUDIO_EXT[type] || "webm"}`);
  form.append("model", SARVAM_STT_MODEL);
  if (SARVAM_STT_MODEL.startsWith("saaras")) form.append("mode", "transcribe");
  form.append("language_code", SARVAM_LANGUAGE);

  try {
    const r = await fetch(`${SARVAM_BASE_URL}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": SARVAM_API_KEY },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      console.error("Sarvam speech-to-text error:", r.status, (await r.text()).slice(0, 500));
      return sendJson(res, 502, { error: sarvamErrorCode(r.status) });
    }
    const data = await r.json();
    sendJson(res, 200, { text: (data.transcript || "").trim(), language: data.language_code || null });
  } catch (err) {
    console.error("Sarvam speech-to-text failed:", err?.message || err);
    sendJson(res, 502, { error: "network" });
  }
}

// ---------- Text -> voice (Sarvam text-to-speech) ----------
async function handleSpeak(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "bad_request" });
  }
  if (!passwordOk(req, body.password)) return sendJson(res, 401, { error: "password" });
  if (!SARVAM_API_KEY) return sendJson(res, 503, { error: "sarvam_key" });
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TTS_CHARS) : "";
  if (!text) return sendJson(res, 400, { error: "bad_request" });

  const payload = {
    text,
    language_code: SARVAM_LANGUAGE === "unknown" ? "ml-IN" : SARVAM_LANGUAGE,
    model: SARVAM_TTS_MODEL,
    pace: SARVAM_PACE,
    output_audio_codec: "mp3",
  };
  if (SARVAM_SPEAKER) payload.speaker = SARVAM_SPEAKER;

  try {
    const r = await fetch(`${SARVAM_BASE_URL}/text-to-speech`, {
      method: "POST",
      headers: { "api-subscription-key": SARVAM_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      console.error("Sarvam text-to-speech error:", r.status, (await r.text()).slice(0, 500));
      return sendJson(res, 502, { error: sarvamErrorCode(r.status) });
    }
    const data = await r.json();
    const audio = data.audios?.[0];
    if (!audio) return sendJson(res, 502, { error: "voice" });
    sendJson(res, 200, { audio });
  } catch (err) {
    console.error("Sarvam text-to-speech failed:", err?.message || err);
    sendJson(res, 502, { error: "network" });
  }
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400).end("Bad JSON");
    return;
  }
  if (!passwordOk(req, body.password)) return sendJson(res, 401, { error: "password" });
  const messages = cleanHistory(body.messages);
  if (!messages) {
    res.writeHead(400).end("Bad messages");
    return;
  }

  // Server-Sent Events: {type:"en"|"ml", text} chunks, then {type:"done"} or {type:"error"}.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    // 1) Get the answer in English.
    const english = await streamText(
      {
        system: CHAT_SYSTEM,
        output_config: { effort: "low" },
        messages,
      },
      (text) => send({ type: "en", text }),
      abort.signal,
    );
    send({ type: "en_done" });

    // 2) Translate the English answer into Malayalam.
    await streamText(
      {
        system: TRANSLATE_SYSTEM,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: english }],
      },
      (text) => send({ type: "ml", text }),
      abort.signal,
    );
    send({ type: "done" });
  } catch (err) {
    if (abort.signal.aborted) return;
    let code = "server";
    if (err?.code === "refusal") code = "refusal";
    else if (err instanceof Anthropic.AuthenticationError) code = "auth";
    else if (err instanceof Anthropic.RateLimitError) code = "busy";
    else if (err instanceof Anthropic.APIConnectionError) code = "network";
    else if (err instanceof Anthropic.APIError && err.status >= 500) code = "busy";
    console.error("Chat error:", err?.message || err);
    send({ type: "error", code });
  }
  res.end();
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && req.url === "/api/transcribe") return handleTranscribe(req, res);
  if (req.method === "POST" && req.url === "/api/speak") return handleSpeak(req, res);
  if (req.method === "GET" && req.url === "/api/config") {
    return sendJson(res, 200, { needsPassword: Boolean(APP_PASSWORD), voice: Boolean(SARVAM_API_KEY) });
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`Malayalam AI Helper running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set - chat requests will fail.");
  }
  if (!SARVAM_API_KEY) {
    console.warn("Warning: SARVAM_API_KEY is not set - voice input and Sarvam read-aloud are off.");
  }
});
