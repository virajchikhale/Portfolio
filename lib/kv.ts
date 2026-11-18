/**
 * A tiny key-value layer for the two things that must survive between serverless invocations: rate-limit counters
 * and run telemetry.
 *
 *  - Upstash Redis (REST) when UPSTASH_REDIS_REST_URL/TOKEN (or Vercel KV's KV_REST_API_URL/TOKEN) are set:
 *    shared by every instance, so limits and statistics are real.
 *  - Otherwise an in-process map: fine locally, and still a useful best-effort limiter on Vercel (each warm instance
 *    enforces its own counters), but NOT a shared budget. Add Upstash for that.
 */
export interface Kv {
  readonly shared: boolean;
  /** Increment a counter (creating it with `ttlS` if new) and return the new value. */
  incr(key: string, by: number, ttlS: number): Promise<number>;
  get(key: string): Promise<number>;
  /** Push a JSON row to the head of a capped list. */
  push(key: string, value: string, max: number): Promise<void>;
  range(key: string, count: number): Promise<string[]>;
}

export class MemoryKv implements Kv {
  readonly shared = false;
  private counters = new Map<string, { n: number; exp: number }>();
  private lists = new Map<string, string[]>();

  private live(key: string) {
    const c = this.counters.get(key);
    if (c && c.exp < Date.now()) {
      this.counters.delete(key);
      return undefined;
    }
    return c;
  }

  async incr(key: string, by: number, ttlS: number): Promise<number> {
    if (this.counters.size > 20_000) this.counters.clear(); // a flood of distinct clients must not grow memory forever
    const c = this.live(key) ?? { n: 0, exp: Date.now() + ttlS * 1000 };
    c.n += by;
    this.counters.set(key, c);
    return c.n;
  }

  async get(key: string): Promise<number> {
    return this.live(key)?.n ?? 0;
  }

  async push(key: string, value: string, max: number): Promise<void> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    list.length = Math.min(list.length, max);
    this.lists.set(key, list);
  }

  async range(key: string, count: number): Promise<string[]> {
    return (this.lists.get(key) ?? []).slice(0, count);
  }
}

export class UpstashKv implements Kv {
  readonly shared = true;
  constructor(private url: string, private token: string) {}

  private async pipeline(commands: (string | number)[][]): Promise<any[]> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Upstash returned ${res.status}`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    const bad = out.find((r) => r.error);
    if (bad) throw new Error(`Upstash error: ${bad.error}`);
    return out.map((r) => r.result);
  }

  async incr(key: string, by: number, ttlS: number): Promise<number> {
    const [n] = await this.pipeline([["INCRBY", key, by], ["EXPIRE", key, ttlS, "NX"]]);
    return Number(n);
  }

  async get(key: string): Promise<number> {
    const [v] = await this.pipeline([["GET", key]]);
    return v == null ? 0 : Number(v);
  }

  async push(key: string, value: string, max: number): Promise<void> {
    await this.pipeline([["LPUSH", key, value], ["LTRIM", key, 0, max - 1]]);
  }

  async range(key: string, count: number): Promise<string[]> {
    const [rows] = await this.pipeline([["LRANGE", key, 0, count - 1]]);
    return (rows ?? []) as string[];
  }
}

let shared: Kv | undefined;

export function getKv(env: Record<string, string | undefined> = process.env): Kv {
  if (shared) return shared;
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  shared = url && token ? new UpstashKv(url, token) : new MemoryKv();
  return shared;
}

/** For tests. */
export function resetKv(): void {
  shared = undefined;
}
