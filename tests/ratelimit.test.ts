import { describe, expect, it } from "vitest";
import { MemoryKv } from "../lib/kv.js";
import { clientIp, HttpError, limiterKey, RateLimiter } from "../lib/ratelimit.js";

const limiter = (over: Partial<{ perMinute: number; perDay: number; globalPerDay: number }> = {}) =>
  new RateLimiter(new MemoryKv(), { perMinute: 3, perDay: 5, globalPerDay: 100, ...over });

const status = async (p: Promise<void>) => p.then(() => 200, (e) => (e as HttpError).status);

describe("RateLimiter", () => {
  it("blocks the 4th request in a minute with 429 + Retry-After", async () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) await l.check("1.1.1.1");
    await expect(l.check("1.1.1.1")).rejects.toMatchObject({ status: 429, headers: { "Retry-After": "30" } });
    expect(await status(l.check("2.2.2.2"))).toBe(200); // other clients are unaffected
  });
  it("enforces the daily per-client limit", async () => {
    const l = limiter({ perMinute: 100, perDay: 2 });
    await l.check("a"); await l.check("a");
    expect(await status(l.check("a"))).toBe(429);
  });
  it("enforces the global daily budget with 503, and agent runs charge extra", async () => {
    const l = limiter({ perMinute: 100, perDay: 100, globalPerDay: 3 });
    expect(await l.canAfford(3)).toBe(true);
    await l.charge(2);
    expect(await l.canAfford(2)).toBe(false);
    await l.check("a");
    expect(await status(l.check("b"))).toBe(503);
  });
  it("groups IPv6 clients by /64", () => {
    expect(limiterKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(limiterKey("2001:db8:1:2::1"));
    expect(limiterKey("2001:db8:1:3::1")).not.toBe(limiterKey("2001:db8:1:2::1"));
    expect(limiterKey("::ffff:10.0.0.7")).toBe("10.0.0.7");
    expect(limiterKey("10.0.0.7")).toBe("10.0.0.7");
  });
  it("only trusts forwarded headers when configured to", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
    expect(clientIp(req, { trustProxyHeaders: true })).toBe("9.9.9.9");
    expect(clientIp(req, { trustProxyHeaders: false })).toBe("unknown");
  });
});
