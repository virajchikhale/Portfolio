# Decisions log

Each entry: what was decided, why, what else was considered, and what it costs. Newest area first within each milestone.
"Verified" means a test or a real run showed it; "not verified" is stated plainly.

## Milestone 5 and the review pass

### D1. Telemetry stores shape and timing, never the question (privacy by default)
**Decision.** One summary row per run (mode, outcome, durations, calls, sources, fallback). No question, no answer, no IP.
`TELEMETRY_STORE_QUESTIONS=true` opts in (capped at 300 chars). **Why.** Visitors type free text; keeping it creates a duty of
care the portfolio does not need, and the Activity view needs only counts and latencies. **Alternatives.** Store everything
(useful for corpus gaps, but a privacy liability); store a hash (useless). **Cost.** You cannot see *which* questions found no
source. Opt in while you tune the corpus, then switch it off. **Verified:** tests assert no question text in stats or rows.

### D2. Reuse the vector store's Postgres pool for run rows; in-memory fallback
**Why.** No new service. Rows survive restarts when Postgres is there. If it is not (or setup fails) a bounded in-memory store
keeps the feature working. **Verified** against real pgvector: roundtrip, prune, and stats surviving an app restart.

### D3. Public stats are aggregates only; per-run data needs an admin token that must exist to work
`/api/stats` exposes counts, percentiles and stage medians. `/api/admin/runs` is **not registered at all** without `ADMIN_TOKEN`
(404, not 401), so there is nothing to probe. Constant-time token comparison; its own rate limiter.

### D4. Telemetry writes are fire-and-forget and run in `finally`
A broken database must never fail or slow an answer. Recording also happens when the visitor disconnects (`cancelled`), and the
agent's extra model calls are charged to the daily budget even then. **Verified** through a real uvicorn server.

### D5. Two-layer evaluation: deterministic in CI, live on demand
**Why.** CI has no model key and must be free and stable, but retrieval, guardrails, citation validity and leak checks are
fully testable offline. Facts, "I don't know", declining and number grounding need a real model, so they run with `--live`.
**Alternative.** LLM-as-judge: more flexible but non-deterministic, costs money, and judges are fallible; heuristics plus a
number-grounding check catch the failure that matters most (invented facts). **Verified:** the harness fails on injected bad
answers. **Not verified:** the live layer against a real Gemini model (no key here); run `eval_answers.py --live` and tell me.

### D6. Guardrails target intent, normalise obfuscation, and are measured in both directions
**Why.** The old pattern blocked any mention of "secret/password/api key", refusing honest questions. The red-team suite also
found real misses ("environment variables") and a false positive ("what are the rules of..."). Now: 35/35 attacks blocked,
0/14 legitimate questions blocked, 3 documented gaps. **Principle kept:** regexes are a speed bump; the architecture is the
boundary.

### D7. Agent failure before any text falls back to the pipeline
**Why.** Real Gemini tool calling could not be tested here; a model that rejects it should not turn into an error page. The
trace shows the failed step honestly. **Not done after text has streamed** (a second answer would be worse). Configurable.

### D8. Smooth Flow Monitor = reconcile, not rebuild
Nodes keep their DOM identity across mode switches; removed ones fade out, new ones fade in, existing ones glide. Respects
`prefers-reduced-motion`. **Verified** by tests that assert the *same elements* survive a mode switch and that nodes and edges
end fully opaque. **Caveat found while testing:** headless screenshots freeze CSS transitions and look washed-out; that is a
capture artefact, not a UI bug (I checked before "fixing" the mobile layout).

### D9. The Internet Explorer window no longer talks to third parties by default
**Found:** page metadata from arbitrary sites went into `innerHTML` (DOM XSS), `javascript:` URLs were accepted, and typed
addresses went to a CORS proxy and to Google's favicon service. **Decision:** build cards with DOM + `textContent`, only
`http(s)` URLs, live preview opt-in (`ieLivePreview`). CSP now allows same-origin connections only.

### D10. Self-host the font
Google Fonts sends every visitor's address to Google for a decorative font. The OFL font (Latin + Latin-Ext, 22 KB) is served
from this origin with its licence. **Verified:** no non-same-origin request at page load.

### D11. No emoji in the UI
Plain-word labels, CSS-drawn status marks, pixel icons. Also fixes a real bug: the Apple logo was the private-use glyph U+F8FF,
a hex box on every OS except macOS. **Verified** by a test that scans all text, labels and tooltips. `★ ● ■ ©` remain
(text-style symbols in the marquee, a game and a copyright line).

### D12. Rate limiting: IPv6 grouped by /64, bounded memory
One subscriber controls a whole /64, so per-address limits were trivially bypassed. Per-client dictionaries were never pruned.
Now grouped, garbage-collected, and capped (a flood resets limits rather than growing the process).

### D13. Bounded model calls and clean failures in pipeline mode
`LLM_TIMEOUT_S` existed but was never used. Now enforced; any unexpected exception becomes an `error` event instead of a dropped
connection. The chat flow moved out of `main.py` into `app/chat.py` so both modes share this behaviour.

### D14. Chat requests are bounded
The browser sent up to 12 history entries of unlimited length against a 16 KB proxy limit (a long conversation would have hit a
413). Now 6 entries, 1,200 chars each; the proxy allows 64 KB.

### D15. Blocked site data cannot stop boot; the terminal escapes input
`localStorage` access at load is guarded (it throws when site data is blocked), and the visitor's own typed commands are escaped.

### D16. MCP is exposed at exactly `/mcp`, not mounted at `/`
A root mount swallowed every route registered after it. Also POST-only (a GET would hold a stream open) and stateless.

### D17. Verified and left alone: BaseHTTPMiddleware does not swallow client disconnects
I suspected it would and tested through a real server: both modes cancel the model call. Kept the middleware; kept the test.

### D18. The browser checks live in the repo (`e2e/`), not in a scratch folder
They had been a throwaway harness; nothing would have protected the UI from regressions. Now `e2e/run.sh` and a CI job run the
same ~160 checks. **Why Firefox + hand-rolled pages instead of Playwright:** zero new dependencies and browsers to download, and
the checks run against the real app. **Cost:** less ergonomic than Playwright; migrating later is easy because the assertions
are plain JS. **Lesson recorded in the runner:** a reused Firefox profile gets corrupted by repeated kills and then silently
loads nothing, so every run uses a fresh profile.

### D19. Deployment-file fixes found by reading them (not run: Docker is unavailable here)
* The image no longer bakes `EMBEDDING_MODEL` into its runtime environment. It would have been passed to Gemini if you later set
  `EMBEDDING_PROVIDER=gemini` and left the model unset.
* nginx: proxy timeout raised above the app's own limits (it was equal to the agent limit, so nginx could cut a slow run just
  before it finished); `Connection` header cleared and caching off for the SSE stream; gzip for text assets (the 90 KB
  `script.js` shipped raw); hard caching for the font via `expires` (an `add_header` in a location would silently drop the
  inherited CSP and security headers).
* Backend healthcheck gets a 60 s start period (model load + ingest).

## Earlier decisions worth keeping in view
* **LangGraph for the loop, our own thin Gemini adapter** (not `langchain-google-genai`): fewer unverifiable layers.
* **Local embeddings (MiniLM) + hybrid retrieval**, chosen from a measured comparison of seven models; the BM25 channel exists
  because small embedders never saw rare names like "Inorbvict".
* **Dependency pins** keep FastAPI 0.115 working with MCP v2 (`sse-starlette==3.0.3`, `starlette<0.47`); `pip check` is clean.

## Not decided by me: needs your review
1. **Corpus accuracy** (`backend/data/*`, `frontend/config.js`, `frontend/lite.html`): "2+ years", "5+ prod apps", the 85% and
   90% metrics and LangGraph/CrewAI/FastAPI/React/Next.js are not in your resume. The chatbot repeats them.
2. **Deployment** (explicitly left pending).
3. **Real Gemini**: tool calling, the model name, and the live eval layer are untested here.
4. **Docker**: never run in this environment.
