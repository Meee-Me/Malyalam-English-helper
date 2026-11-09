// Vercel function: POST /api/transcribe
import { handleTranscribe } from "../lib/app.js";

export function POST(request) {
  return handleTranscribe(request);
}
