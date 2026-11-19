import { beforeAll, describe, expect, it } from "vitest";

process.env.LLM_PROVIDER = "fake";
process.env.EMBEDDING_PROVIDER = "none";
process.env.TRUST_PROXY_HEADERS = "true";
process.env.MCP_AUTH_TOKEN = "mcp-token";
process.env.MCP_RATE_LIMIT_PER_MINUTE = "5";

let mcp: typeof import("../api/mcp.js");
beforeAll(async () => { mcp = await import("../api/mcp.js"); });

const rpc = (body: unknown, token: string | null = "mcp-token", ip = "7.7.7.7") =>
  mcp.POST(new Request("http://localhost/mcp", { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }));

describe("/mcp", () => {
  it("requires the bearer token when configured", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null)).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "wrong")).status).toBe(401);
  });
  it("initialize, list tools (read-only annotations), call a tool", async () => {
    const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, "mcp-token", "1.1.1.1")).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "viraj-portfolio" } });
    const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "mcp-token", "1.1.1.1")).json();
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(["get_project", "list_projects", "load_skill", "search_portfolio"]);
    expect(list.result.tools.every((t: any) => t.annotations.readOnlyHint === true)).toBe(true);
    const out = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } }, "mcp-token", "1.1.1.1")).json();
    expect(out.result.isError).toBe(false);
    expect(out.result.content[0].text).toMatch(/^- /);
  });
  it("tool errors are isError results, unknown tools/methods are JSON-RPC errors, notifications get 202", async () => {
    const bad = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_project", arguments: {} } }, "mcp-token", "2.2.2.2")).json();
    expect(bad.result).toMatchObject({ isError: true });
    expect(bad.result.content[0].text).toMatch(/^missing/);
    expect((await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rm_rf" } }, "mcp-token", "2.2.2.2")).json()).error.code).toBe(-32602);
    expect((await (await rpc({ jsonrpc: "2.0", id: 3, method: "nope" }, "mcp-token", "2.2.2.2")).json()).error.code).toBe(-32601);
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, "mcp-token", "2.2.2.2")).status).toBe(202);
  });
  it("refuses GET (no long-lived streams) and rate-limits per client", async () => {
    expect(mcp.GET(new Request("http://localhost/mcp")).status).toBe(405);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await rpc({ jsonrpc: "2.0", id: i, method: "ping" }, "mcp-token", "3.3.3.3")).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("/mcp and the agent-only tool", () => {
  it("never lists or runs suggest_action (it needs the chat page's UI)", async () => {
    const list = await (await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, "mcp-token", "4.4.4.4")).json();
    expect(list.result.tools.map((t: any) => t.name)).not.toContain("suggest_action");
    const call = await (await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "suggest_action", arguments: { id: "readme" } } }, "mcp-token", "4.4.4.4")).json();
    expect(call.error.code).toBe(-32602);
  });
});
