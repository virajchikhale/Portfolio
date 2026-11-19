/** Sliding-ish window limiter (per-minute and per-day, per client) plus a global daily budget, on top of the Kv layer. */
import { isIP } from "node:net";
import type { Settings } from "./config.js";
import type { Kv } from "./kv.js";

export class HttpError extends Error {
  constructor(public status: number, public detail: string, public headers: Record<string, string> = {}) {
    super(detail);
  }
}

/** The identity a client is limited under. IPv6 clients are grouped by /64: one subscriber normally controls a whole
 * /64, so counting each address separately would let a single attacker sidestep every limit. */
export function limiterKey(ip: string): string {
  const v = isIP(ip);
  if (v !== 6) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const groups = expandV6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}

function expandV6(ip: string): string[] | null {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill("0");
  const all = [...h, ...fill, ...t].map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""));
  return all.length === 8 ? all : null;
}

export interface Limits {
  perMinute: number;
  perDay: number;
  globalPerDay: number;
}

export class RateLimiter {
  constructor(private kv: Kv, private limits: Limits, private scope = "chat") {}

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Throws HttpError when the client (or the whole site) is over its limit. */
  async check(client: string): Promise<void> {
    const id = limiterKey(client);
    const minute = Math.floor(Date.now() / 60_000);
    const [perMin, perDay] = await Promise.all([
      this.kv.incr(`rl:${this.scope}:m:${id}:${minute}`, 1, 90),
      this.kv.incr(`rl:${this.scope}:d:${id}:${this.day()}`, 1, 172_800),
    ]);
    if (perDay > this.limits.perDay) throw new HttpError(429, "Daily limit reached for your connection.");
    if (perMin > this.limits.perMinute) {
      throw new HttpError(429, "Too many requests. Slow down.", { "Retry-After": "30" });
    }
    if (this.limits.globalPerDay < 1e9) {
      const used = await this.kv.incr(`rl:${this.scope}:g:${this.day()}`, 1, 172_800);
      if (used > this.limits.globalPerDay) {
        throw new HttpError(503, "Daily AI budget reached. Please try again tomorrow.");
      }
    }
  }

  /** True if the global daily budget can absorb `units` MORE model calls (gates agent mode). */
  async canAfford(units: number): Promise<boolean> {
    return (await this.kv.get(`rl:${this.scope}:g:${this.day()}`)) + units <= this.limits.globalPerDay;
  }

  /** Count extra model calls (an agent run makes several; check() already counted the first). */
  async charge(units: number): Promise<void> {
    if (units > 0) await this.kv.incr(`rl:${this.scope}:g:${this.day()}`, units, 172_800);
  }
}

export function chatLimiter(kv: Kv, s: Settings): RateLimiter {
  return new RateLimiter(kv, { perMinute: s.rateLimitPerMinute, perDay: s.rateLimitPerDay,
    globalPerDay: s.dailyGlobalRequestBudget }, "chat");
}

export function readLimiter(kv: Kv, s: Settings): RateLimiter {
  return new RateLimiter(kv, { perMinute: s.readRateLimitPerMinute, perDay: 1e9, globalPerDay: 1e9 }, "read");
}

export function mcpLimiter(kv: Kv, s: Settings): RateLimiter {
  return new RateLimiter(kv, { perMinute: s.mcpRateLimitPerMinute, perDay: s.mcpRateLimitPerDay, globalPerDay: 1e9 },
    "mcp");
}

export function clientIp(req: Request, s: Pick<Settings, "trustProxyHeaders">): string {
  if (s.trustProxyHeaders) {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return "unknown";
}
