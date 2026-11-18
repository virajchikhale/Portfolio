import { beforeAll, describe, expect, it } from "vitest";
import { chatRequest } from "./helpers.js";

process.env.LLM_PROVIDER = "fake";
process.env.EMBEDDING_PROVIDER = "none";
process.env.RATE_LIMIT_PER_MINUTE = "2";
process.env.TRUST_PROXY_HEADERS = "true";

let chat: typeof import("../api/chat.js");
beforeAll(async () => { chat = await import("../api/chat.js"); });

describe("chat rate limit", () => {
  it("returns 429 with Retry-After and a trace once a client is over its minute limit", async () => {
    const ip = { "x-forwarded-for": "5.5.5.5" };
    expect((await chat.POST(chatRequest({ message: "hello there" }, ip))).status).toBe(200);
    expect((await chat.POST(chatRequest({ message: "hello again" }, ip))).status).toBe(200);
    const res = await chat.POST(chatRequest({ message: "hello third" }, ip));
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(body.trace.some((e: any) => e.status === "blocked")).toBe(true);
    // a different client is unaffected
    expect((await chat.POST(chatRequest({ message: "hello" }, { "x-forwarded-for": "6.6.6.6" }))).status).toBe(200);
  });
});
