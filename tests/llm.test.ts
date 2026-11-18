import { describe, expect, it, vi, afterEach } from "vitest";
import { loadSettings } from "../lib/config.js";
import { GeminiClient } from "../lib/llm/gemini.js";
import { OpenAICompatClient } from "../lib/llm/openai.js";
import { LLMError, toTranscript, type ModelTurn } from "../lib/llm/types.js";

const sseBody = (...events: unknown[]) =>
  new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } });

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("GeminiClient", () => {
  const s = loadSettings({ GEMINI_API_KEY: "k", LLM_PROVIDER: "gemini", ENVIRONMENT: "dev" });
  const tool = { name: "search_portfolio", description: "d", parameters: { type: "object", properties: {} } };

  it("requires a key", () => {
    expect(() => new GeminiClient(loadSettings({ LLM_PROVIDER: "gemini" }))).toThrow(LLMError);
  });

  it("streams text, hides thought parts, sends the key as a header (never in the URL)", async () => {
    const fetchMock = vi.fn(async () => sseBody(
      { candidates: [{ content: { parts: [{ text: "secret thinking", thought: true }, { text: "Hello " }] } }] },
      { candidates: [{ content: { parts: [{ text: "world" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await collect(new GeminiClient(s).stream("sys", [{ role: "user", content: "hi" }]));
    expect(out.join("")).toBe("Hello world");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("k");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(body.tools).toBeUndefined();
  });

  it("returns tool calls and keeps the raw parts for exact replay (thought signatures)", async () => {
    const part = { functionCall: { name: "search_portfolio", args: { query: "x" } }, thoughtSignature: "sig123" };
    vi.stubGlobal("fetch", vi.fn(async () => sseBody({ candidates: [{ content: { parts: [part] } }] })));
    const items = await collect(new GeminiClient(s).streamTurn("sys", toTranscript([{ role: "user", content: "q" }]), [tool]));
    const turn = items.at(-1) as ModelTurn;
    expect(turn.toolCalls).toEqual([{ name: "search_portfolio", args: { query: "x" }, id: undefined }]);
    expect(turn.raw).toEqual({ role: "model", parts: [part] });

    // replayed unchanged in the next request, followed by ONE user content holding all function responses
    const fetchMock = vi.fn(async () => sseBody({ candidates: [{ content: { parts: [{ text: "done" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await collect(new GeminiClient(s).streamTurn("sys", [{ type: "user", text: "q" }, turn,
      { type: "results", results: [{ call: turn.toolCalls[0]!, response: { result: "r" } }] }], [tool]));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.contents[1].parts[0].thoughtSignature).toBe("sig123");
    expect(body.contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "search_portfolio", response: { result: "r" } } }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe("search_portfolio");
  });

  it("retries once without the thinking config when the model rejects it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("thinking_budget is not supported", { status: 400 }))
      .mockResolvedValueOnce(sseBody({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await collect(new GeminiClient(s).stream("sys", [{ role: "user", content: "hi" }]));
    expect(out.join("")).toBe("ok");
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).generationConfig.thinkingConfig).toBeUndefined();
  });

  it("maps provider failures to visitor-safe messages (generic in prod, specific in dev)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("API key not valid", { status: 400 })));
    await expect(collect(new GeminiClient(s).stream("s", [{ role: "user", content: "h" }]))).rejects.toThrow(/API key/);
    const prod = loadSettings({ GEMINI_API_KEY: "k", ENVIRONMENT: "prod" });
    await expect(collect(new GeminiClient(prod).stream("s", [{ role: "user", content: "h" }]))).rejects.toThrow("temporarily unavailable");
  });

  it("an empty answer is an error, not a blank reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseBody({ candidates: [{ content: { parts: [] } }] })));
    await expect(collect(new GeminiClient(s).stream("s", [{ role: "user", content: "h" }]))).rejects.toThrow(/empty answer/);
  });
});

describe("OpenAICompatClient", () => {
  const s = loadSettings({ LLM_PROVIDER: "openai", LLM_BASE_URL: "https://api.example.com/v1", LLM_API_KEY: "sk", ENVIRONMENT: "dev" });

  it("needs a key unless the host is local", () => {
    expect(() => new OpenAICompatClient(loadSettings({ LLM_PROVIDER: "openai", LLM_BASE_URL: "https://api.example.com/v1" }))).toThrow(LLMError);
    expect(() => new OpenAICompatClient(loadSettings({ LLM_PROVIDER: "openai", LLM_BASE_URL: "http://localhost:11434/v1" }))).not.toThrow();
  });

  it("streams text and assembles tool calls split across chunks", async () => {
    const fetchMock = vi.fn(async () => sseBody(
      { choices: [{ delta: { content: "Hi " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search_portfolio", arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } }] },
      "[DONE]"));
    const items = await collect(new OpenAICompatClient(s, fetchMock as unknown as typeof fetch)
      .streamTurn("sys", toTranscript([{ role: "user", content: "q" }]), []));
    const turn = items.at(-1) as ModelTurn;
    expect(items[0]).toBe("Hi ");
    expect(turn.toolCalls).toEqual([{ name: "search_portfolio", args: { query: "x" }, id: "c1" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk");
  });

  it("encodes tool turns in the OpenAI wire format", () => {
    const call = { name: "load_skill", args: { name: "about-viraj" }, id: "c9" };
    const msgs = OpenAICompatClient.toMessages([{ type: "user", text: "q" },
      { type: "turn", text: "", toolCalls: [call] }, { type: "results", results: [{ call, response: { result: "body" } }] }]);
    expect(msgs).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "load_skill", arguments: '{"name":"about-viraj"}' } }] },
      { role: "tool", tool_call_id: "c9", content: '{"result":"body"}' },
    ]);
  });

  it("HTTP errors become LLMError with a mapped message", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 429 }));
    await expect(collect(new OpenAICompatClient(s, f as unknown as typeof fetch).stream("s", [{ role: "user", content: "h" }]))).rejects.toThrow(/rate limit/);
  });
});
