"""Evaluate answer quality end to end, in both modes.

    python scripts/eval_answers.py                       # deterministic layer only (fake model): fast, free, CI-safe
    python scripts/eval_answers.py --live                # + facts / unknowns / grounded numbers with the REAL model
    python scripts/eval_answers.py --live --modes agent  # one mode;  --only edu-1,exp-1 for a subset;  --json out.json

Exit code 1 on any failure (live: when the pass rate is below --min-pass). Uses the configured provider/keys from
env/.env. --live costs real model calls (about 25 cases x 2 modes, agent runs make several calls each).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evals.harness import evaluate, make_settings, summarize  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="use the real model and run the model-quality checks")
    ap.add_argument("--modes", default="pipeline,agent")
    ap.add_argument("--only", default="")
    ap.add_argument("--min-pass", type=float, default=85.0, help="live: minimum pass %% per mode")
    ap.add_argument("--pgvector", action="store_true", help="use Postgres (needs DATABASE_URL) instead of memory")
    ap.add_argument("--json", default="", help="write full results to this file")
    a = ap.parse_args()

    modes = [m.strip() for m in a.modes.split(",") if m.strip()]
    settings = make_settings(None if a.live else "fake", a.pgvector)
    print(f"model: {settings.llm_provider}/{settings.llm_model if a.live else 'deterministic fake'}   "
          f"embeddings: {settings.embedding_model}   mode(s): {', '.join(modes)}   "
          f"layer: {'deterministic + live' if a.live else 'deterministic only'}\n")
    results = evaluate(settings, modes, a.live, {x for x in a.only.split(",") if x} or None)

    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        extra = f"  (skipped live checks: {', '.join(r.skipped)})" if r.skipped else ""
        print(f"{mark}  {r.mode:8} {r.case:9} {r.ms:6.0f} ms {r.calls} call(s){extra}")
        for f in r.failures:
            print(f"        - {f}")
    summary = summarize(results, modes)
    print("\nSUMMARY")
    for m, s in summary.items():
        print(f"  {m:8} {s['passed']}/{s['cases']} passed ({s['pass_pct']}%)  p50 {s['latency_ms_p50']} ms  "
              f"avg model calls {s['avg_model_calls']}  no-source answers {s['no_source_answers']}")
        print(f"           by kind: {s['by_kind']}")
    if a.json:
        Path(a.json).write_text(json.dumps({"summary": summary, "results": [r.__dict__ for r in results]}, indent=1))

    if a.live:
        bad = [m for m, s in summary.items() if (s["pass_pct"] or 0) < a.min_pass]
        if bad:
            print(f"\nBELOW THRESHOLD ({a.min_pass}%): {', '.join(bad)}")
            return 1
        return 0
    return 0 if all(r.passed for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
