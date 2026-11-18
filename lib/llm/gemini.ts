/** Gemini over its REST API (streamGenerateContent, SSE): no SDK, so the function bundle stays tiny. */
import type { Settings } from "../config.js";
import { EMPTY_ANSWER, LLMError, sseData, toTranscript, type LLMClient, type Message, type ModelTurn, type ToolCall,
  type ToolSpec, type TranscriptEntry } from "./types.js";

/** Map a provider failure to a visitor-safe message. In dev we are specific (so you can fix config); in prod
 * everything is generic and nothing about keys/quotas/models is revealed. The full error is always logged. */
export function explainError(status: number | null, body: string, s: Pick<Settings, "environment" | "llmModel">): string {
  if (s.environment === "prod") return "The AI service is temporarily unavailable.";
  const text = body.toLowerCase();
  if ([400, 401, 403].includes(status ?? 0) && (text.includes("api key") || text.includes("api_key") || text.includes("permission"))) {
    return "Gemini rejected the API key (check GEMINI_API_KEY).";
  }
  if (status === 404 || text.includes("not found")) return `Model '${s.llmModel}' was not found (check LLM_MODEL).`;
  if (status === 429 || text.includes("quota") || text.includes("resource_exhausted")) {
    return "Gemini quota / rate limit reached for this key.";
  }
  if (text.includes("thinking")) return "This model rejected the thinking setting (set LLM_THINKING_BUDGET=-1).";
  return "The AI service is temporarily unavailable (see function logs).";
}

type Part = Record<string, any>;
type Content = { role: "user" | "model"; parts: Part[] };

export class GeminiClient implements LLMClient {
  constructor(private s: Settings) {
    if (!s.geminiApiKey) throw new LLMError("GEMINI_API_KEY is not configured");
  }

  private toContent(e: TranscriptEntry): Content {
    switch (e.type) {
      case "message":
        return { role: e.role === "assistant" ? "model" : "user", parts: [{ text: e.content }] };
      case "user":
        return { role: "user", parts: [{ text: e.text }] };
      case "turn": {
        if (e.raw) return e.raw as Content; // replay EXACTLY as received: thought signatures live inside these parts
        const parts: Part[] = e.text ? [{ text: e.text }] : [];
        for (const c of e.toolCalls) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
        return { role: "model", parts };
      }
      case "results":
        // All results of one model turn go back together in ONE content, in call order.
        return { role: "user", parts: e.results.map((r) => ({
          functionResponse: { id: r.call.id, name: r.call.name, response: r.response } })) };
    }
  }

  private body(system: string, transcript: TranscriptEntry[], tools: ToolSpec[], withThinking: boolean) {
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: this.s.llmMaxOutputTokens,
      temperature: this.s.llmTemperature,
    };
    // Thinking tokens count against maxOutputTokens; leaving them on can yield EMPTY answers.
    if (withThinking) {
      if (this.s.llmThinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: this.s.llmThinkingLevel.toUpperCase() };
      else if (this.s.llmThinkingBudget >= 0) generationConfig.thinkingConfig = { thinkingBudget: this.s.llmThinkingBudget };
    }
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: system }] },
      contents: transcript.map((e) => this.toContent(e)),
      generationConfig,
    };
    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({
        name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
    return body;
  }

  private async *turnOnce(system: string, transcript: TranscriptEntry[], tools: ToolSpec[], withThinking: boolean,
    signal?: AbortSignal): AsyncGenerator<string | ModelTurn> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.s.llmModel)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.s.geminiApiKey },
      body: JSON.stringify(this.body(system, transcript, tools, withThinking)),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      console.error(`Gemini returned ${res.status}: ${detail}`);
      throw new LLMError(explainError(res.status, detail, this.s));
    }
    const parts: Part[] = [];
    const calls: ToolCall[] = [];
    let text = "";
    for await (const data of sseData(res, signal)) {
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const cand = chunk.candidates?.[0];
      for (const part of (cand?.content?.parts ?? []) as Part[]) {
        parts.push(part); // keep every part (incl. thoughtSignature) for exact replay
        if (part.functionCall) {
          const fc = part.functionCall;
          calls.push({ name: fc.name, args: fc.args ?? {}, id: fc.id });
        } else if (part.text && !part.thought) {
          text += part.text;
          yield part.text;
        }
      }
    }
    yield { type: "turn", text, toolCalls: calls, raw: { role: "model", parts } };
  }

  async *streamTurn(system: string, transcript: TranscriptEntry[], tools: ToolSpec[], signal?: AbortSignal):
    AsyncGenerator<string | ModelTurn> {
    let emitted = false;
    let turn: ModelTurn | null = null;
    const run = async function* (self: GeminiClient, thinking: boolean) {
      for await (const item of self.turnOnce(system, transcript, tools, thinking, signal)) {
        if (typeof item === "string") emitted = true;
        else turn = item;
        if (typeof item === "string") yield item;
      }
    };
    try {
      try {
        yield* run(this, true);
      } catch (err) {
        // Some models (e.g. Pro) reject thinkingBudget=0: retry once without it.
        if (emitted || turn || !String((err as Error).message ?? err).toLowerCase().includes("thinking")) throw err;
        console.warn("Model rejected the thinking config, retrying without it:", err);
        yield* run(this, false);
      }
    } catch (err) {
      if (err instanceof LLMError) throw err;
      if (signal?.aborted) throw err;
      console.error(`Gemini call failed (model=${this.s.llmModel})`, err);
      throw new LLMError(explainError(null, String(err), this.s));
    }
    const done = turn as ModelTurn | null;
    if (!done || (!done.text.trim() && !done.toolCalls.length)) {
      console.error("Gemini returned neither text nor a tool call (safety filter or token budget exhausted)");
      throw new LLMError(EMPTY_ANSWER);
    }
    yield done;
  }

  async *stream(system: string, messages: Message[], signal?: AbortSignal): AsyncGenerator<string> {
    for await (const item of this.streamTurn(system, toTranscript(messages), [], signal)) {
      if (typeof item === "string") yield item;
    }
  }
}
