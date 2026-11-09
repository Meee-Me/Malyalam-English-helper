// Run Malayalam AI Helper on your own computer:  npm start  ->  http://localhost:3000
// (On Vercel, the files in api/ are used instead of this file.)
//
// Put your keys in a file called .env first (copy .env.example).

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(here, ".env"));
} catch {}

const { handleChat, handleConfig, handleSpeak, handleTranscribe } = await import("./lib/app.js");

const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;

const ROUTES = {
  "POST /api/chat": handleChat,
  "POST /api/transcribe": handleTranscribe,
  "POST /api/speak": handleSpeak,
  "GET /api/config": handleConfig,
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return res.writeHead(403).end();
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// Turn Node's request into a web Request, call the shared handler, and send its Response back.
async function runHandler(handler, req, res) {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const request = new Request(new URL(req.url, `http://${req.headers.host || "localhost"}`), {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req),
    duplex: "half",
    signal: abort.signal,
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  try {
    for await (const chunk of response.body) res.write(chunk);
  } catch {}
  res.end();
}

http
  .createServer((req, res) => {
    const handler = ROUTES[`${req.method} ${new URL(req.url, "http://x").pathname}`];
    if (handler) {
      return runHandler(handler, req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    }
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405).end();
  })
  .listen(PORT, () => {
    console.log(`Malayalam AI Helper running at http://localhost:${PORT}`);
    if (!process.env.OPENAI_API_KEY) console.warn("Warning: OPENAI_API_KEY is missing - chat will not work.");
    if (!process.env.SARVAM_API_KEY) console.warn("Warning: SARVAM_API_KEY is missing - voice will not work.");
  });
