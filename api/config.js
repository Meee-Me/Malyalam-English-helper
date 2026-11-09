// Vercel function: GET /api/config
import { handleConfig } from "../lib/app.js";

export function GET() {
  return handleConfig();
}
