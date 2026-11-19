/**
 * Per-request trace of the pipeline, streamed to the browser so the UI can visualise it ("Flow Monitor").
 * Every stage emits a `start` and an `end` event with REAL timestamps (ms since the request began).
 *
 *   shown: stage names, durations, retrieved chunk labels/scores/text (public corpus), terms matched, model names
 *   NEVER: the system prompt, guardrail patterns, API keys, per-IP rate-limit counters
 */
export type TraceEvent = Record<string, any>;

export class Tracer {
  events: TraceEvent[] = [];
  private t0 = performance.now();
  private starts = new Map<string, number>();
  private sent = 0;

  constructor(private enabled = true) {}

  now(): number {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }

  start(stage: string, label: string, detail = ""): void {
    if (!this.enabled) return;
    const t = this.now();
    this.starts.set(stage, t);
    this.events.push({ id: stage, label, phase: "start", t, detail });
  }

  end(stage: string, status = "ok", detail = "", data: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const t = this.now();
    const began = this.starts.get(stage) ?? t;
    this.starts.delete(stage);
    this.events.push({ id: stage, phase: "end", t, dur: Math.round((t - began) * 10) / 10, status, detail, data });
  }

  /** Run-level facts for the UI (e.g. mode="agent"): the Flow Monitor picks its graph layout from this. */
  meta(info: Record<string, unknown>): void {
    if (this.enabled) this.events.push({ id: "meta", phase: "meta", t: this.now(), ...info });
  }

  progress(stage: string, detail: string): void {
    if (this.enabled) this.events.push({ id: stage, phase: "progress", t: this.now(), detail });
  }

  skip(stage: string, label: string, detail: string, data: Record<string, unknown> = {}): void {
    this.start(stage, label);
    this.end(stage, "skipped", detail, data);
  }

  /** Close any stage still open (an exception interrupted it) so the UI never hangs on a spinner. */
  abortOpen(detail: string): void {
    for (const stage of [...this.starts.keys()]) this.end(stage, "error", detail);
  }

  /** Events produced since the last drain (for streaming them as they happen). */
  drain(): TraceEvent[] {
    const fresh = this.events.slice(this.sent);
    this.sent = this.events.length;
    return fresh;
  }
}
