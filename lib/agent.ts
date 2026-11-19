/**
 * The agent loop:
 *
 *     decide ──(model asked for tools)──► act ──┐
 *       ▲  │                                    │
 *       │  └──(model answered / limits hit)──► done
 *       └────────────────────────────────────────┘
 *
 * decide: one model call. Text streams to the user as it arrives. If tools are requested we go to `act`.
 * act:    runs the requested tools (read-only, validated, time-limited) and appends their results.
 * Hard limits (steps, tool calls, wall clock, repeated calls) make an endless or expensive loop impossible: on the last
 * step the model is offered NO tools, so it has to answer.
 *
 * It is a plain async generator: no graph framework is needed for a two-node loop, and a generator maps directly onto
 * the SSE stream (and stops spending model calls the moment the visitor disconnects, through the abort signal).
 */
import type { Settings } from "./config.js";
import { LLMError, type LLMClient, type ModelTurn, type ToolResult, type TranscriptEntry } from "./llm/types.js";
import { runTool, type Tool, type ToolContext, type ToolOutput } from "./tools.js";
import { Tracer } from "./trace.js";

const MAX_CALLS_PER_TURN = 3; // parallel calls beyond this are answered with an error instead of executed
const PREVIEW_CHARS = 300;
export const NO_ANSWER = "I couldn't put together an answer. Please try rephrasing your question.";

export interface AgentDeps {
  llm: LLMClient;
  tools: Record<string, Tool>;
  toolCtx: ToolContext;
  system: string;
  settings: Settings;
}

export type Payload = Record<string, any>;

const signature = (name: string, args: unknown) => `${name}:${JSON.stringify(args, Object.keys((args ?? {}) as object).sort())}`;

const flush = (tracer: Tracer): Payload[] => tracer.drain().map((e) => ({ trace: e }));

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), ms);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Yields SSE payloads: {trace}, {delta}, {sources}, {error}, and an internal {agent_summary}. Never throws, except for
 * a cancellation by the caller (that must propagate so the model call stops). */
export async function* runAgent(deps: AgentDeps, history: TranscriptEntry[], question: string, tracer: Tracer,
  outerSignal?: AbortSignal): AsyncGenerator<Payload> {
  const { llm, tools, toolCtx, system, settings: s } = deps;
  const timeout = AbortSignal.timeout(s.agentTimeoutS * 1000);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const deadline = Date.now() + s.agentTimeoutS * 800; // after this the next model call must be the last

  const transcript: TranscriptEntry[] = [...history, { type: "user", text: question }];
  let steps = 0, toolCalls = 0, answer = "", stop: "no_answer" | null = null;
  const seen: string[] = [];

  const closing = (why: string): Payload[] => {
    tracer.abortOpen(why);
    return flush(tracer);
  };

  try {
    while (true) {
      // ── decide ──
      const n = ++steps;
      const budgetLeft = toolCalls < s.agentMaxToolCalls;
      const last = n >= s.agentMaxSteps || !budgetLeft || Date.now() > deadline;
      const offered = last ? [] : Object.values(tools).map((t) => t.spec);
      const sid = `step_${n}`;
      tracer.start(sid, `Agent step ${n}`, last ? "final answer (no tools offered)" : "model decides");
      yield* flush(tracer);

      let turn: ModelTurn | null = null;
      for await (const item of llm.streamTurn(system, transcript, offered, signal)) {
        if (typeof item === "string") yield { delta: item }; // the answer streams live, exactly like pipeline mode
        else turn = item;
      }
      if (!turn) throw new LLMError("The model returned no turn.");
      const t: ModelTurn = turn;
      const calls = last ? [] : t.toolCalls; // when no tools were offered, ignore any call the model makes anyway
      transcript.push(t);
      if (!calls.length) {
        const ok = t.text.trim().length > 0;
        tracer.end(sid, ok ? "ok" : "empty", ok ? "answered" : "the model produced no text",
          { final: true, text_chars: t.text.length, calls: [] });
        yield* flush(tracer);
        answer = t.text;
        if (!ok) stop = "no_answer";
        break;
      }
      tracer.end(sid, "ok", "requested " + calls.map((c) => c.name).join(", "),
        { final: false, text_chars: t.text.length, calls: calls.map((c) => ({ name: c.name, args: c.args })) });
      yield* flush(tracer);

      // ── act: every function call must get exactly one response, in order (Gemini rejects missing responses) ──
      const results: ToolResult[] = [];
      for (const [i, call] of t.toolCalls.entries()) {
        toolCalls++;
        const tid = `tool_${toolCalls}`;
        tracer.start(tid, `Tool: ${call.name}`, JSON.stringify(call.args).slice(0, 120));
        yield* flush(tracer);
        const sig = signature(call.name, call.args);
        const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined;
        let out: ToolOutput;
        if (!tool) out = { text: `Error: unknown tool '${call.name}'`, isError: true };
        else if (i >= MAX_CALLS_PER_TURN) out = { text: "Error: too many tool calls in one step; call fewer tools at a time.", isError: true };
        else if (toolCalls > s.agentMaxToolCalls) out = { text: "Error: tool-call budget used up. Answer now with what you already know.", isError: true };
        else if (seen.includes(sig)) out = { text: "Error: you already made this exact call; use its earlier result and answer.", isError: true };
        else {
          seen.push(sig);
          try {
            out = await withTimeout(runTool(tool, toolCtx, call.args), s.agentToolTimeoutS * 1000, signal);
          } catch (err) {
            if (signal.aborted) throw err;
            out = { text: "Error: the tool timed out.", isError: true };
          }
        }
        results.push({ call, response: out.isError ? { error: out.text } : { result: out.text } });
        tracer.end(tid, out.isError ? "error" : "ok",
          out.isError ? out.text.slice(0, 90).replace(/\n/g, " ") : `${out.text.length} chars returned`,
          { name: call.name, args: call.args, result: out.text.slice(0, PREVIEW_CHARS), ...(out.data ?? {}) });
        yield* flush(tracer);
      }
      if (toolCtx.book.chunks.length) yield { sources: toolCtx.book.asEvents() }; // the UI keeps the latest list
      if (toolCtx.actions.length) yield { actions: toolCtx.actions.map((id) => ({ id })) }; // ids only; the page owns the labels
      transcript.push({ type: "results", results });
    }
  } catch (err) {
    if (outerSignal?.aborted) throw err; // the visitor left: stop quietly
    if (err instanceof LLMError) {
      yield* closing("model call failed");
      yield { error: err.message };
    } else if (timeout.aborted) {
      yield* closing("timed out");
      yield { error: "The agent took too long to answer. Please try again." };
    } else {
      console.error("agent run failed", err);
      yield* closing("unexpected error");
      yield { error: "Something went wrong while answering. Please try again." };
    }
    return;
  }
  if (stop === "no_answer" || !answer.trim()) yield { delta: NO_ANSWER };
  yield { agent_summary: { steps, tool_calls: toolCalls } };
}
