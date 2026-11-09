// Malayalam AI Helper - a ChatGPT-style assistant whose answers are written in
// English by Claude and then translated into Malayalam.
//
// Run:  ANTHROPIC_API_KEY=sk-... npm start   ->  http://localhost:3000

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

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("too large");
  }
  return JSON.parse(body || "{}");
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400).end("Bad JSON");
    return;
  }
  if (APP_PASSWORD && body.password !== APP_PASSWORD) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "password" }));
    return;
  }
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
  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ needsPassword: Boolean(APP_PASSWORD) }));
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`Malayalam AI Helper running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set - chat requests will fail.");
  }
});
