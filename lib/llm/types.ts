/** Provider-agnostic LLM interface so the model/vendor can be swapped by env var. */
export interface Message {
  role: "user" | "assistant";
  content: string;
}

/** Raised for any provider failure. The message is safe to show to the visitor. */
export class LLMError extends Error {}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (what both Gemini and MCP expect)
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/** One model response: any text it produced and the tool calls it asked for.
 * `raw` is the provider-native content exactly as received. It MUST be replayed unchanged in the next request:
 * Gemini keeps thought signatures inside the function-call parts and expects them back. */
export interface ModelTurn {
  type: "turn";
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export interface ToolResult {
  call: ToolCall;
  response: Record<string, unknown>; // what the model sees: {result} or {error}
}

export type TranscriptEntry =
  | ({ type: "message" } & Message)
  | { type: "user"; text: string }
  | ModelTurn
  | { type: "results"; results: ToolResult[] };

export interface LLMClient {
  /** Yield text chunks. Throws LLMError on failure. */
  stream(system: string, messages: Message[], signal?: AbortSignal): AsyncGenerator<string>;
  /** One agent turn: yields text deltas (string) as they arrive and finally ONE ModelTurn. With no tools the model
   * must answer in text. Throws LLMError on failure. */
  streamTurn(system: string, transcript: TranscriptEntry[], tools: ToolSpec[], signal?: AbortSignal):
    AsyncGenerator<string | ModelTurn>;
}

export const EMPTY_ANSWER = "The model returned an empty answer. Try rephrasing your question.";

/** Plain chat history as transcript entries, so `stream` can reuse `streamTurn`. */
export const toTranscript = (messages: Message[]): TranscriptEntry[] =>
  messages.map((m) => ({ type: "message" as const, ...m }));

/** Iterate the `data:` payloads of a server-sent-events response body. */
export async function* sseData(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    const rest = buf.trim();
    if (rest.startsWith("data:")) yield rest.slice(5).trim();
  } finally {
    reader.cancel().catch(() => {});
  }
}
