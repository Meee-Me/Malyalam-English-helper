// Vercel function: POST /api/speak
import { handleSpeak } from "../lib/app.js";

export function POST(request) {
  return handleSpeak(request);
}
