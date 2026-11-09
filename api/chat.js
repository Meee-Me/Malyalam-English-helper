// Vercel function: POST /api/chat
import { handleChat } from "../lib/app.js";

export function POST(request) {
  return handleChat(request);
}
