import { waitUntil } from "@vercel/functions";
import { getState, getTelemetry } from "../lib/app.js";
import { loadSettings } from "../lib/config.js";
import { streamTurn } from "../lib/chat.js";
import { checkInput, GuardrailViolation, looksLikeInjection, sanitize } from "../lib/guardrails.js";
import { baseHeaders, errorResponse, json, readJson, unavailable } from "../lib/http.js";
import { getKv } from "../lib/kv.js";
import type { Message } from "../lib/llm/types.js";
import { chatLimiter, clientIp, HttpError } from "../lib/ratelimit.js";
import { Outcome, summarize } from "../lib/telemetry.js";
import { Tracer } from "../lib/trace.js";

interface ChatRequest {
  message: string;
  history: { role: "user" | "assistant"; content: string }[];
  mode: "pipeline" | "agent";
}

/** Strict shape check (the equivalent of the old pydantic model). */
function parse(body: unknown): ChatRequest {
  const bad = () => new HttpError(422, "Invalid request.");
  if (typeof body !== "object" || body === null) throw bad();
  const b = body as Record<string, unknown>;
  if (typeof b.message !== "string" || b.message.length > 4000) throw bad();
  const history = b.history ?? [];
  if (!Array.isArray(history) || history.length > 50) throw bad();
  for (const t of history) {
    if (typeof t !== "object" || t === null) throw bad();
    const { role, content } = t as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || content.length > 4000) throw bad();
  }
  const mode = b.mode ?? "pipeline";
  if (mode !== "pipeline" && mode !== "agent") throw bad();
  return { message: b.message, history: history as ChatRequest["history"], mode };
}

export function OPTIONS(request: Request): Response {
  return new Response(null, { status: 204, headers: baseHeaders(request, loadSettings()) });
}

export async function POST(request: Request): Promise<Response> {
  let state;
  try {
    state = await getState();
  } catch (err) {
    return unavailable(err, baseHeaders(request, { corsOrigins: [] }));
  }
  const s = state.settings;
  const headers = baseHeaders(request, s);
  const tracer = new Tracer();
  const telemetry = getTelemetry(state);
  const kv = getKv();
  const limiter = chatLimiter(kv, s);

  let body: ChatRequest;
  try {
    body = parse(await readJson(request));
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err, headers, { error: err.detail });
    throw err;
  }

  const record = (outcome: string, mode: string, out = new Outcome()) => {
    if (!telemetry) return;
    waitUntil(telemetry.record(summarize(tracer.events, { outcome, mode, requested: body.mode, model: s.llmModel,
      question: body.message, sources: out.sources, ttftMs: out.firstDeltaMs, storeQuestion: s.telemetryStoreQuestions })));
  };

  // The trace goes back with the error so the UI can show WHERE the request was stopped.
  const blocked = (stage: string, detail: string, payload: object, status: number, extra: Record<string, string> = {}) => {
    tracer.end(stage, "blocked", detail);
    record("blocked", "pipeline");
    return json({ ...payload, trace: tracer.drain() }, status, { ...headers, ...extra });
  };

  tracer.start("rate_limit", "Rate limit");
  try {
    await limiter.check(clientIp(request, s));
  } catch (err) {
    if (err instanceof HttpError) return blocked("rate_limit", "limit reached", { detail: err.detail }, err.status, err.headers);
    throw err;
  }
  tracer.end("rate_limit", "ok", "within limits");

  tracer.start("guardrails", "Input guardrails");
  let text: string;
  const history: Message[] = [];
  try {
    text = checkInput(body.message, s);
    for (const t of s.maxHistoryTurns ? body.history.slice(-s.maxHistoryTurns) : []) {
      if (t.role === "user") {
        history.push({ role: "user", content: checkInput(t.content, s) });
        continue;
      }
      // Clients can forge "assistant" turns, so screen them too; drop (don't fail) if suspicious.
      if (!looksLikeInjection(t.content)) history.push({ role: "assistant", content: sanitize(t.content).slice(0, s.maxInputChars * 3) });
    }
  } catch (err) {
    // Deliberately generic: never reveal which pattern matched.
    if (err instanceof GuardrailViolation) return blocked("guardrails", "blocked by input guardrail", { error: err.message }, err.status);
    throw err;
  }
  tracer.end("guardrails", "ok", `${text.length} chars checked`, { chars: text.length });

  // Retrieval. A follow-up like "tell me more" has no keywords, so include the previous user turn.
  const priorUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const query = `${priorUser} ${text}`.trim().slice(0, s.maxInputChars * 2);

  // Agent mode costs up to agentMaxSteps model calls. If the daily budget cannot absorb that, quietly use the cheap
  // pipeline instead (and say so in the trace) rather than failing the visitor's question.
  const useAgent = body.mode === "agent" && s.agentEnabled && (await limiter.canAfford(s.agentMaxSteps - 1));
  const note = body.mode === "agent" && !useAgent
    ? (!s.agentEnabled ? "agent mode is disabled" : "daily budget low: using the fast pipeline") : null;
  const mode = useAgent ? "agent" : "pipeline";
  tracer.meta({ mode, requested: body.mode, note });

  const abort = new AbortController();
  const encoder = new TextEncoder();
  const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = new Outcome();
      let completed = false;
      try {
        for (const e of tracer.drain()) controller.enqueue(sse({ trace: e }));
        for await (const item of streamTurn(state, { useAgent, history, text, query, tracer, signal: abort.signal })) {
          out.observe(item, tracer.now());
          controller.enqueue(sse(item));
        }
        completed = true;
        if (out.error === null) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        if (!abort.signal.aborted) {
          console.error("stream failed", err);
          try { controller.error(err); } catch { /* already closed */ }
        }
      } finally {
        // Runs on normal completion AND when the visitor leaves mid-answer (the stream was cancelled).
        record(out.classify(completed), out.mode ?? mode, out);
        if (useAgent) { // the extra model calls were really made, even if the visitor never saw the answer
          const steps = tracer.events.filter((e) => e.phase === "start" && String(e.id).startsWith("step_")).length;
          waitUntil(limiter.charge(steps - 1).catch((e) => console.error("charge failed", e)));
        }
      }
    },
    cancel(reason) {
      abort.abort(reason);
    },
  });

  return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
