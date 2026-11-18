/**
 * Run telemetry: one small summary per question, kept for the activity view and for debugging.
 *
 * Privacy by default: a run is stored WITHOUT the visitor's question, the answer, or any network identifier. Only shape
 * and timing: mode, outcome, durations, how many tool calls, whether any source was found. (Opt in to keeping the
 * question text with TELEMETRY_STORE_QUESTIONS=true, e.g. to find gaps in the corpus.)
 */
import type { Settings } from "./config.js";
import type { Kv } from "./kv.js";
import type { TraceEvent } from "./trace.js";

export const OUTCOMES = ["ok", "empty", "blocked", "error", "cancelled"] as const;
export const STAGES = ["embed", "dense", "keyword", "fuse", "prompt", "llm"] as const;
const RUNS_KEY = "telemetry:runs";
const MAX_ROWS = 5000;

export interface RunSummary {
  ts: number; // epoch seconds
  mode: string; // mode actually used: pipeline | agent
  requested: string; // mode the visitor asked for
  outcome: string; // ok | empty | blocked | error | cancelled
  total_ms: number;
  ttft_ms: number | null;
  steps: number;
  tool_calls: number;
  sources: number;
  fallback: boolean; // agent was requested but the fast pipeline was used instead
  stage_ms: Record<string, number>;
  model: string;
  question_len: number;
  question: string | null;
}

export function summarize(events: TraceEvent[], o: { outcome: string; mode: string; requested: string; model: string;
  question: string; sources: number; ttftMs: number | null; storeQuestion: boolean }): RunSummary {
  const ends = events.filter((e) => e.phase === "end");
  return {
    ts: Date.now() / 1000, mode: o.mode, requested: o.requested, outcome: o.outcome,
    total_ms: Math.max(0, ...events.map((e) => e.t as number)), ttft_ms: o.ttftMs,
    steps: events.filter((e) => e.phase === "start" && String(e.id).startsWith("step_")).length,
    tool_calls: events.filter((e) => e.phase === "start" && String(e.id).startsWith("tool_")).length,
    sources: o.sources, fallback: o.requested === "agent" && o.mode !== "agent",
    stage_ms: Object.fromEntries(ends.filter((e) => (STAGES as readonly string[]).includes(e.id)).map((e) => [e.id, e.dur])),
    model: o.model, question_len: [...o.question].length, question: o.storeQuestion ? o.question.slice(0, 300) : null,
  };
}

/** What the stream turned out to contain; filled in as payloads go by. */
export class Outcome {
  deltas = 0;
  error: string | null = null;
  sources = 0;
  firstDeltaMs: number | null = null;
  mode: string | null = null; // a later meta event overrides it (agent -> pipeline fallback)

  observe(item: Record<string, any>, nowMs: number): void {
    const trace = item.trace;
    if (trace?.phase === "meta" && trace.mode) this.mode = trace.mode;
    if ("delta" in item) {
      this.deltas++;
      this.firstDeltaMs ??= Math.round(nowMs * 10) / 10;
    } else if ("error" in item) this.error = item.error;
    else if ("sources" in item) this.sources = item.sources.length;
  }

  classify(completed: boolean): string {
    if (!completed) return "cancelled"; // the visitor left before the answer finished
    return this.error ? "error" : this.deltas ? "ok" : "empty";
  }
}

/** Nearest-rank percentile (no interpolation: with few runs, an honest observed value beats a made-up one). */
function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return Math.round(v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)]! * 10) / 10;
}

/** Public statistics: counts and latency percentiles only. Nothing here identifies a visitor or a question. */
export function aggregate(rows: RunSummary[], o: { window: string; startedAt: number; now?: number }) {
  const now = o.now ?? Date.now() / 1000;
  const answered = rows.filter((r) => r.outcome === "ok" || r.outcome === "empty");
  const ok = rows.filter((r) => r.outcome === "ok");
  const agent = answered.filter((r) => r.mode === "agent");
  const withSources = ok.filter((r) => r.sources > 0).length;
  const avg = (f: (r: RunSummary) => number) => agent.length ? Math.round((agent.reduce((a, r) => a + f(r), 0) / agent.length) * 100) / 100 : null;
  return {
    window: o.window,
    uptime_s: Math.round(now - o.startedAt),
    runs: {
      total: rows.length,
      by_mode: Object.fromEntries(["pipeline", "agent"].map((m) => [m, rows.filter((r) => r.mode === m).length])),
      by_outcome: Object.fromEntries(OUTCOMES.map((x) => [x, rows.filter((r) => r.outcome === x).length])),
    },
    latency_ms: { p50: pct(ok.map((r) => r.total_ms), 50), p95: pct(ok.map((r) => r.total_ms), 95) },
    ttft_ms: { p50: pct(ok.filter((r) => r.ttft_ms !== null).map((r) => r.ttft_ms!), 50) },
    answers: { with_sources: withSources, without_sources: ok.length - withSources,
      with_sources_pct: ok.length ? Math.round((1000 * withSources) / ok.length) / 10 : null },
    agent: { runs: agent.length, avg_steps: avg((r) => r.steps), avg_tool_calls: avg((r) => r.tool_calls),
      fallbacks: rows.filter((r) => r.fallback).length },
    stages_p50_ms: Object.fromEntries(STAGES.map((s) => [s, pct(answered.filter((r) => s in r.stage_ms).map((r) => r.stage_ms[s]!), 50)])),
  };
}

const WINDOWS: Record<string, number | null> = { "24h": 86400, "7d": 7 * 86400, all: null };

export class Telemetry {
  private startedAt = Date.now() / 1000;

  constructor(private kv: Kv, private s: Pick<Settings, "runRetentionDays">) {}

  /** Never throws: a slow or broken store must not break a chat answer. */
  async record(run: RunSummary): Promise<void> {
    try {
      await this.kv.push(RUNS_KEY, JSON.stringify(run), MAX_ROWS);
    } catch (err) {
      console.error("could not record run telemetry", err);
    }
  }

  private async rows(): Promise<RunSummary[]> {
    const cutoff = Date.now() / 1000 - this.s.runRetentionDays * 86400;
    return (await this.kv.range(RUNS_KEY, MAX_ROWS)).flatMap((r) => {
      try {
        const row = JSON.parse(r) as RunSummary;
        return row.ts >= cutoff ? [row] : [];
      } catch {
        return [];
      }
    });
  }

  async stats(window = "24h") {
    const w = window in WINDOWS ? window : "24h";
    const span = WINDOWS[w];
    const rows = (await this.rows()).filter((r) => span === null || r.ts >= Date.now() / 1000 - span!);
    return aggregate(rows, { window: w, startedAt: this.startedAt });
  }

  async recent(limit = 50): Promise<RunSummary[]> {
    return (await this.rows()).slice(0, Math.max(1, Math.min(limit, 200)));
  }
}
