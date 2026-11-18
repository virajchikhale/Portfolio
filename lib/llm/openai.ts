/**
 * Any OpenAI-compatible chat-completions endpoint: Groq, OpenRouter, Together, Ollama, vLLM, LM Studio...
 * Select with LLM_PROVIDER=openai plus LLM_BASE_URL / LLM_API_KEY / LLM_MODEL. Streams over SSE and supports tool
 * calling for agent mode. The API key is only ever sent to LLM_BASE_URL.
 */
import type { Settings } from "../config.js";
import { EMPTY_ANSWER, LLMError, sseData, toTranscript, type LLMClient, type Message, type ModelTurn, type ToolCall,
  type ToolSpec, type TranscriptEntry } from "./types.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal", "ollama"]);

export function explainError(status: number | null, s: Pick<Settings, "environment" | "llmModel">): string {
  if (s.environment === "prod") return "The AI service is temporarily unavailable.";
  if (status === 401 || status === 403) return "The LLM provider rejected the API key (check LLM_API_KEY).";
  if (status === 404) return `Model '${s.llmModel}' was not found at LLM_BASE_URL (check LLM_MODEL).`;
  if (status === 429) return "The LLM provider's rate limit / quota was reached.";
  return "The AI service is temporarily unavailable (see function logs).";
}

export class OpenAICompatClient implements LLMClient {
  private url: string;
  private headers: Record<string, string>;

  constructor(private s: Settings, private fetchImpl: typeof fetch = fetch) {
    this.url = s.llmBaseUrl.replace(/\/$/, "") + "/chat/completions";
    let host = "";
    try {
      host = new URL(s.llmBaseUrl).hostname;
    } catch {
      throw new LLMError("LLM_BASE_URL is not a valid URL");
    }
    if (!s.llmApiKey && !LOCAL_HOSTS.has(host)) throw new LLMError("LLM_API_KEY is not configured");
    this.headers = { "Content-Type": "application/json", ...(s.llmApiKey ? { Authorization: `Bearer ${s.llmApiKey}` } : {}) };
  }

  private payload(system: string, messages: unknown[], tools: ToolSpec[]) {
    const body: Record<string, unknown> = {
      model: this.s.llmModel,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
      temperature: this.s.llmTemperature,
      max_tokens: this.s.llmMaxOutputTokens,
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    return body;
  }

  static toMessages(transcript: TranscriptEntry[]): unknown[] {
    const out: unknown[] = [];
    for (const e of transcript) {
      if (e.type === "message") out.push({ role: e.role, content: e.content });
      else if (e.type === "user") out.push({ role: "user", content: e.text });
      else if (e.type === "turn") {
        const msg: Record<string, unknown> = { role: "assistant", content: e.text || null };
        if (e.toolCalls.length) {
          msg.tool_calls = e.toolCalls.map((c) => ({ id: c.id, type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) } }));
        }
        out.push(msg);
      } else {
        for (const r of e.results) out.push({ role: "tool", tool_call_id: r.call.id, content: JSON.stringify(r.response) });
      }
    }
    return out;
  }

  async *streamTurn(system: string, transcript: TranscriptEntry[], tools: ToolSpec[], signal?: AbortSignal):
    AsyncGenerator<string | ModelTurn> {
    let text = "";
    const calls = new Map<number, { id: string | null; name: string; args: string }>();
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST", headers: this.headers, signal,
        body: JSON.stringify(this.payload(system, OpenAICompatClient.toMessages(transcript), tools)),
      });
      if (!res.ok) {
        console.error(`LLM provider returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
        throw new LLMError(explainError(res.status, this.s));
      }
      for await (const data of sseData(res, signal)) {
        if (data === "[DONE]") break;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        for (const choice of ev.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.content) {
            text += delta.content;
            yield delta.content as string;
          }
          for (const tc of delta.tool_calls ?? []) {
            const slot = calls.get(tc.index ?? 0) ?? { id: null, name: "", args: "" };
            slot.id = tc.id || slot.id;
            slot.name += tc.function?.name ?? "";
            slot.args += tc.function?.arguments ?? "";
            calls.set(tc.index ?? 0, slot);
          }
        }
      }
    } catch (err) {
      if (err instanceof LLMError || signal?.aborted) throw err;
      console.error(`LLM call failed (model=${this.s.llmModel})`, err);
      throw new LLMError(explainError(null, this.s));
    }
    const toolCalls: ToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => {
      let args: unknown = {};
      try {
        args = c.args.trim() ? JSON.parse(c.args) : {};
      } catch {
        args = {};
      }
      return { name: c.name, args: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {},
        id: c.id ?? `call_${crypto.randomUUID().slice(0, 12)}` };
    });
    if (!text.trim() && !toolCalls.length) throw new LLMError(EMPTY_ANSWER);
    yield { type: "turn", text, toolCalls };
  }

  async *stream(system: string, messages: Message[], signal?: AbortSignal): AsyncGenerator<string> {
    for await (const item of this.streamTurn(system, toTranscript(messages), [], signal)) {
      if (typeof item === "string") yield item;
    }
  }
}
