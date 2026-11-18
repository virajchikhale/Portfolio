/**
 * MCP (Model Context Protocol) endpoint: the portfolio's four READ-ONLY tools for any MCP client (Claude Desktop, IDEs,
 * other agents). Stateless JSON-RPC over POST (the "streamable HTTP" transport in JSON-response mode).
 *
 * The tools are the SAME registry the chat agent uses, so behaviour and validation are identical. They make no LLM
 * calls, write nothing, fetch nothing and read no secrets.
 */
import { getState } from "../lib/app.js";
import { baseHeaders, bearerOk, json, readJson, unavailable } from "../lib/http.js";
import { getKv } from "../lib/kv.js";
import { clientIp, HttpError, mcpLimiter } from "../lib/ratelimit.js";
import { runTool, SourceBook } from "../lib/tools.js";

const INSTRUCTIONS = "Read-only access to Viraj Chikhale's portfolio: resume, experience, education, skills and projects. " +
  "Call search_portfolio for factual questions. Results are numbered sources you can cite as [1], [2].";
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function POST(request: Request): Promise<Response> {
  let state;
  try {
    state = await getState();
  } catch (err) {
    return unavailable(err, baseHeaders(request, { corsOrigins: [] }));
  }
  const s = state.settings;
  const headers = baseHeaders(request, s);
  if (!s.mcpEnabled) return json({ error: "not found" }, 404, headers);
  if (s.mcpAuthToken && !bearerOk(request, s.mcpAuthToken)) {
    return json({ error: "unauthorized" }, 401, { ...headers, "WWW-Authenticate": "Bearer" });
  }
  try {
    await mcpLimiter(getKv(), s).check(clientIp(request, s));
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.detail }, err.status, { ...headers, ...err.headers });
    throw err;
  }

  let payload: unknown;
  try {
    payload = await readJson(request);
  } catch (err) {
    if (err instanceof HttpError) return json(fail(null, -32700, "Parse error"), err.status === 413 ? 413 : 400, headers);
    throw err;
  }

  const handle = async (msg: Rpc) => {
    if (msg.id === undefined) return null; // a notification: no response
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return ok(msg.id, { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "viraj-portfolio", title: "Viraj Chikhale: portfolio", version: "1.0" },
          instructions: INSTRUCTIONS });
      }
      case "ping":
        return ok(msg.id, {});
      case "tools/list":
        return ok(msg.id, { tools: Object.values(state.tools).map((t) => ({
          name: t.spec.name, description: t.spec.description, inputSchema: t.spec.parameters,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = Object.hasOwn(state.tools, name) ? state.tools[name] : undefined;
        if (!tool) return fail(msg.id, -32602, `Unknown tool: ${name}`);
        const out = await runTool(tool, { settings: s, skills: state.skills, chunks: state.chunks, rag: state.rag,
          book: new SourceBook() }, msg.params?.arguments ?? {});
        // An EXPECTED failure becomes a clean isError result (message kept, no stack trace).
        return ok(msg.id, { content: [{ type: "text", text: out.isError ? out.text.replace(/^Error: /, "") : out.text }],
          isError: Boolean(out.isError) });
      }
      default:
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };

  const batch = Array.isArray(payload);
  const messages = (batch ? payload : [payload]) as Rpc[];
  const replies = (await Promise.all(messages.map((m) => handle(m ?? {}).catch((err) => {
    console.error("mcp call failed", err);
    return fail(m?.id, -32603, "Internal error");
  })))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202, headers });
  return json(batch ? replies : replies[0], 200, headers);
}

export function GET(request: Request): Response {
  // Stateless JSON transport: only POST is ever needed. A GET would open a long-lived event stream that a public client
  // could hold open indefinitely, so refuse it up front.
  return json({ error: "method not allowed" }, 405, { Allow: "POST", ...baseHeaders(request, { corsOrigins: [] }) });
}
