import { timingSafeEqual } from "node:crypto";
import type { Settings } from "./config.js";
import { HttpError } from "./ratelimit.js";

/** Headers every API response carries. CORS only for origins in CORS_ORIGINS (same-origin needs none). */
export function baseHeaders(req: Request, s: Pick<Settings, "corsOrigins">): Record<string, string> {
  const h: Record<string, string> = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  const origin = req.headers.get("origin")?.replace(/\/$/, "");
  if (origin && s.corsOrigins.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h.Vary = "Origin";
  }
  return h;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function errorResponse(err: HttpError, headers: Record<string, string> = {}, extra: object = {}): Response {
  return json({ detail: err.detail, ...extra }, err.status, { ...headers, ...err.headers });
}

/** Constant-time bearer-token check. */
export function bearerOk(req: Request, token: string): boolean {
  const supplied = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** The AI backend is not configured (e.g. missing key): behave like "offline" instead of leaking details. */
export function unavailable(err: unknown, headers: Record<string, string>): Response {
  console.error("backend unavailable", err);
  return json({ error: "The AI backend is not configured." }, 503, headers);
}

export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, "Request too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, "Invalid JSON.");
  }
}
