import type { LLMClient, Message, ModelTurn, ToolSpec, TranscriptEntry } from "./types.js";
import { toTranscript } from "./types.js";

/** Deterministic offline provider for tests and keyless local dev (LLM_PROVIDER=fake). */
export class FakeClient implements LLMClient {
  async *stream(_system: string, messages: Message[]): AsyncGenerator<string> {
    for (const word of `[fake-llm] You said: ${messages.at(-1)?.content ?? ""}`.split(" ")) yield word + " ";
  }

  /** A stand-in for a tool-calling model: load a matching skill, search the corpus, then answer from the result. */
  async *streamTurn(_system: string, transcript: TranscriptEntry[], tools: ToolSpec[]): AsyncGenerator<string | ModelTurn> {
    const question = [...transcript].reverse().find((e) => e.type === "user");
    const q = (question && question.type === "user" ? question.text : "").toLowerCase();
    const done = transcript.flatMap((e) => (e.type === "results" ? e.results : []));
    const names = new Set(tools.map((t) => t.name));
    if (tools.length && !done.some((r) => r.call.name === "load_skill") && names.has("load_skill")) {
      const skill = ["contact", "hire", "reach", "email"].some((w) => q.includes(w)) ? "contact-handoff"
        : ["project", "built", "build"].some((w) => q.includes(w)) ? "project-explainer" : "about-viraj";
      yield { type: "turn", text: "", toolCalls: [{ name: "load_skill", args: { name: skill }, id: "fake-1" }] };
    } else if (tools.length && !done.some((r) => r.call.name === "search_portfolio") && names.has("search_portfolio")) {
      yield { type: "turn", text: "", toolCalls: [{ name: "search_portfolio", args: { query: q }, id: "fake-2" }] };
    } else {
      const found = String(done.find((r) => r.call.name === "search_portfolio")?.response.result ?? "");
      const first = found.split("\n").find((l) => l.startsWith("[1]"));
      const text = first ? `[fake-agent] Based on ${first}` : "[fake-agent] I don't have that detail in my sources.";
      for (const word of text.split(" ")) yield word + " ";
      yield { type: "turn", text: text + " ", toolCalls: [] };
    }
  }
}

export { toTranscript };
