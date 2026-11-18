/**
 * One chat turn as a stream of payloads: {trace}, {sources}, {delta}, {error}.
 *
 * Kept separate from HTTP so both modes are easy to test and share one failure behaviour: every failure becomes a clean
 * `error` event, never a dropped connection. A cancellation (the visitor left) is NOT caught: it must propagate so the
 * model call stops.
 */
import type { Settings } from "./config.js";
import { runAgent, type AgentDeps, type Payload } from "./agent.js";
import { LLMError, type LLMClient, type Message, type TranscriptEntry } from "./llm/types.js";
import { RAG_HINTS, formatContext, type Rag } from "./rag.js";
import { SourceBook, type Tool } from "./tools.js";
import type { Skill, Chunk } from "./content.js";
import type { Tracer } from "./trace.js";

export const GENERIC_ERROR = "Something went wrong while answering. Please try again.";

export interface AppState {
  settings: Settings;
  llm: LLMClient;
  skills: Record<string, Skill>;
  chunks: Chunk[];
  tools: Record<string, Tool>;
  systemPrompt: string;
  agentPrompt: string;
  rag: Rag | null;
  ragReason: string | null;
}

export interface TurnInput {
  useAgent: boolean;
  history: Message[];
  text: string;
  query: string;
  tracer: Tracer;
  signal?: AbortSignal;
}

const drain = (tracer: Tracer): Payload[] => tracer.drain().map((e) => ({ trace: e }));

export async function* streamTurn(state: AppState, input: TurnInput): AsyncGenerator<Payload> {
  try {
    yield* input.useAgent ? agent(state, input) : pipeline(state, input);
  } catch (err) {
    if (input.signal?.aborted) throw err;
    console.error("chat turn failed", err);
    input.tracer.abortOpen("unexpected error");
    yield* drain(input.tracer);
    yield { error: GENERIC_ERROR };
  }
}

async function* agent(state: AppState, { history, text, query, tracer, signal }: TurnInput): AsyncGenerator<Payload> {
  const s = state.settings;
  yield* drain(tracer);
  const deps: AgentDeps = { llm: state.llm, tools: state.tools, system: state.agentPrompt, settings: s,
    toolCtx: { settings: s, skills: state.skills, chunks: state.chunks, rag: state.rag, book: new SourceBook(), actions: [] } };
  const transcript: TranscriptEntry[] = history.map((m) => ({ type: "message", ...m }));
  let produced = false;
  let failure: string | null = null;
  for await (const item of runAgent(deps, transcript, text, tracer, signal)) {
    if ("agent_summary" in item) continue; // internal bookkeeping, never sent to the browser
    if ("delta" in item) produced = true;
    if ("error" in item && !produced && s.agentFallback) {
      failure = item.error as string; // swallow it: the visitor gets an answer from the pipeline instead
      break;
    }
    yield item;
  }
  if (failure === null) return;
  // The agent could not answer (e.g. the model rejected tool calling). Nothing was shown yet, so answer with the fast
  // pipeline rather than an error. The trace says so and the Flow Monitor switches graphs.
  console.warn(`agent failed before answering (${failure}); falling back to the pipeline`);
  tracer.meta({ mode: "pipeline", requested: "agent", note: "the agent could not answer, so the fast pipeline was used" });
  yield* pipeline(state, { history, text, query, tracer, signal, useAgent: false });
}

async function* pipeline(state: AppState, { history, text, query, tracer, signal }: TurnInput): AsyncGenerator<Payload> {
  const s = state.settings;
  yield* drain(tracer);

  let hits: Awaited<ReturnType<Rag["retrieve"]>> = [];
  if (state.rag) {
    try {
      hits = await state.rag.retrieve(query, s, tracer);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error("retrieval failed; answering from core facts only", err);
      tracer.abortOpen("retrieval failed; continuing without sources");
    }
  } else {
    const reason = state.ragReason ?? "unknown";
    for (const [stage, label] of [["embed", "Embed query"], ["dense", "Vector search"], ["keyword", "Keyword (BM25)"],
      ["fuse", "Fuse + gate"]] as const) {
      tracer.skip(stage, label, `retrieval unavailable: ${reason}`, { reason, hint: RAG_HINTS[reason] ?? RAG_HINTS.unknown });
    }
  }
  yield* drain(tracer);

  tracer.start("prompt", "Build prompt");
  const system = `${state.systemPrompt}\n\n${formatContext(hits)}`;
  const sources = hits.map((h, i) => ({ n: i + 1, label: `${h.chunk.title} › ${h.chunk.heading}`, source: h.chunk.source }));
  // Size only: the prompt text itself is never exposed.
  tracer.end("prompt", "ok", `${hits.length} source(s) in context`, { sources: hits.length, approx_tokens: Math.floor(system.length / 4) });
  yield* drain(tracer);
  if (sources.length) yield { sources };

  tracer.start("llm", "LLM", s.llmModel);
  yield* drain(tracer);
  let chunks = 0, chars = 0, first: number | null = null;
  const timeout = AbortSignal.timeout(s.llmTimeoutS * 1000); // a stalled model call must not hold the connection open
  const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    for await (const chunk of state.llm.stream(system, [...history, { role: "user", content: text }], callSignal)) {
      if (first === null) {
        first = tracer.now();
        tracer.progress("llm", "first token");
        yield* drain(tracer);
      }
      chunks++;
      chars += chunk.length;
      yield { delta: chunk };
    }
    tracer.end("llm", "ok", `${chunks} chunks, ${chars} chars`, { model: s.llmModel, chunks, chars, ttft_ms: first });
    yield* drain(tracer);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) {
      tracer.end("llm", "error", "timed out");
      yield* drain(tracer);
      yield { error: "The AI service took too long to answer. Please try again." };
    } else if (err instanceof LLMError) {
      tracer.end("llm", "error", "model call failed");
      yield* drain(tracer);
      yield { error: err.message };
    } else {
      throw err;
    }
  }
}
