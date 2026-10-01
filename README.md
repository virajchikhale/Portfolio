# VC·OS — AI Engineer Portfolio

A retro Mac OS 1984 desktop (frontend) backed by a real AI service (FastAPI + Gemini) that answers
questions about me, grounded in a profile and a set of **skills**.

> `main` = static GitHub Pages site. `ai-portfolio` = this full-stack version.

## Run
```bash
cp .env.example .env            # add GEMINI_API_KEY (or set LLM_PROVIDER=fake to run keyless)
docker compose up --build       # http://localhost:8080
```
Backend only: `cd backend && pip install -r requirements-dev.txt && pytest && uvicorn app.main:app --reload`

## RAG: how your content gets in
* Edit/add Markdown in `backend/data/` (`# Title`, then `## Section` headings: each section becomes one retrievable chunk
  and its heading is the citation label). `core.md` is always in the prompt and is not retrieved.
* On startup the backend embeds only **new or changed** chunks (idempotent). Manual run:
  `docker compose run --rm backend python -m app.rag.ingest` (`--reset` rebuilds, required after changing `EMBEDDING_DIM`).
* **Embeddings run locally by default** (`EMBEDDING_PROVIDER=local`, fastembed/ONNX on CPU): no API key, quota or cost,
  and your content never leaves the machine. The model is baked into the Docker image, so the read-only container never
  downloads anything. Switch with `EMBEDDING_PROVIDER=gemini` or another `EMBEDDING_MODEL`; the vector size follows the
  model automatically. After any model change: rebuild, then `python -m app.rag.ingest --reset`.
* **Hybrid retrieval.** Dense embeddings (pgvector, cosine, gated by a per-model `RAG_MIN_SCORE`) are fused with a small
  keyword channel (BM25 over *rare* corpus terms). Why: small embedding models have never seen names like "Inorbvict" or
  "ZCOER", so "What did he do at Inorbvict?" scored below the cutoff and retrieved nothing. The keyword channel only fires
  when most of the question's content words are rare corpus terms (so "weather in Paris" can't cite the farming
  project just because it mentions weather). Off-topic questions fail both gates and the bot says it has no source.
* Retrieval quality is measured, not assumed: `python backend/scripts/eval_retrieval.py` runs the real retriever on
  `backend/evals/retrieval_set.json` (26 hand-written questions: in-scope, rare-name "entity", and off-topic) and reports
  recall, MRR and off-topic leakage, plus a recommended `RAG_MIN_SCORE`. Cosine scores are **not comparable between
  models**, so each model has its own cutoff. A real-model test in CI fails if recall or leakage regress.

  Default (MiniLM + hybrid): **recall@4 20/20, MRR 0.93, off-topic leakage 0/6** (dense alone: 18/20).

  Dense-only model comparison on the first 17 questions (before the keyword channel existed):

  | model (local) | size | recall@4 | MRR | off-topic split |
  |---|---|---|---|---|
  | **all-MiniLM-L6-v2 (default)** | 90 MB | 14/14 | 0.96 | clean |
  | nomic-embed-text-v1.5-Q | 130 MB | 14/14 | 0.96 | clean |
  | gte-base | 440 MB | 14/14 | 1.00 | clean, thin margin |
  | bge-base-en-v1.5 | 210 MB | 14/14 | 0.96 | overlaps |
  | bge-small-en-v1.5 | 70 MB | 13/14 | 0.89 | overlaps |
  | snowflake-arctic-embed-s / m | 130 / 430 MB | 10/14, 7/14 | 0.68, 0.46 | poor on this corpus |

  Caveat: a small hand-written set, and the keyword channel's stopwords were tuned after seeing one failure on it, so
  treat the numbers as indicative, not a benchmark. Add questions whenever you add content or see a bad answer.
* `python -m app.rag.search "question"` prints raw dense scores for one query.
* If retrieval fails (DB/embeddings down) chat keeps working from core facts, without sources; `/api/health` shows `rag.enabled`.
* Never put private data (phone, address) in `data/`: the public chatbot can quote anything in it.

## Flow Monitor: watch the pipeline run
Open it from the dock (**Flow**), the Apple menu, the **⚡ FLOW** button in the chat window, or `flow` in the terminal.
Every question animates as a graph: rate limit → guardrails → embed → vector search ‖ keyword search → fuse + gate → prompt → LLM.
Click a stage to inspect it (retrieved chunks with score bars and the cut-off tick, matched rare terms, which channel found each
source; click a chunk to read its text). Blocked requests stop at the stage that blocked them.

| Control | Meaning |
|---|---|
| **LIVE** | events shown the moment they arrive, true timing |
| **2× / 1× / ½×** | teaching speed: each stage stays on screen ~0.5 / 1 / 2 s |
| **STEP** | one stage per **NEXT ▶** press |
| **SKIP ⏭** | finish the animation instantly |
| **↺ REPLAY** | replay the last run at the chosen speed |
| **sync answer** | in teaching modes, hold the chat answer until the animation reaches the LLM stage |

The speed controls change *playback only*; the real pipeline is never slowed down. The data is real: the backend streams
one `trace` SSE event (`start`/`end`, real ms timestamps) per stage (`backend/app/trace.py`). A blocked request returns its
trace inside the error body, so the UI can show where it was stopped.

**What a trace never contains:** the system prompt, guardrail patterns (a block just says "blocked by input guardrail"),
API keys or per-IP rate-limit counters. The UI inserts every value with `textContent`, so hostile text is inert. A hidden
browser tab never delays a chat answer, and closing the monitor releases any held answer immediately.

## Troubleshooting the LLM
```bash
# local:   cd backend && python scripts/check_llm.py
# docker:  docker compose run --rm backend python scripts/check_llm.py
```
It prints the real provider error (the API itself only shows a safe message) and lists the models your key can use.

| Symptom in chat | Likely cause / fix |
|---|---|
| "Gemini rejected the API key" | Wrong/expired key, or the Generative Language API isn't enabled for it |
| "Model '…' was not found" | Set `LLM_MODEL` to a name from `check_llm.py`'s list |
| "quota / rate limit reached" | Free-tier limits; wait or use a billed key |
| "empty answer" | Safety filter, or thinking ate the token budget: keep `LLM_THINKING_BUDGET=0` (or `-1` for Pro models) |
| "AI service is temporarily unavailable" | `ENVIRONMENT=prod` hides details by design; read `docker compose logs backend` |
| Changed `.env` but nothing changed | Containers read env at start: `docker compose up -d --force-recreate backend` |

In `ENVIRONMENT=dev` the chat shows the specific cause; in `prod` visitors only ever see a generic message.

## Architecture
```
browser ──► nginx (static UI, CSP, rate limit) ──/api──► FastAPI ──► LLM provider (Gemini; swappable by env)
                                                           ├─ guardrails (input) + rate limiter + daily budget
                                                           ├─ skills/   (SKILL.md, OpenClaw/Agent-Skills format)
                                                           ├─ data/core.md (always in the prompt)
                                                           └─ RAG: data/*.md ─chunk─embed(local MiniLM via fastembed)─► Postgres + pgvector (HNSW, cosine)
                                                                  + in-process BM25 for rare proper nouns, fused by rank (hybrid)
                                                                  top-k chunks injected per question, answer cites [1] [2]
```
The backend is never published to the host; only nginx is. The API key exists only in the backend's environment.

## Configuration (all env vars — see `.env.example`)
`LLM_PROVIDER`, `LLM_MODEL`, `GEMINI_API_KEY`, token/rate/budget limits, `CORS_ORIGINS`, `ENVIRONMENT`.
Add a provider by implementing `LLMClient` in `backend/app/llm/` and registering it in `factory.py`.

## Security model
| Threat | Mitigation |
|---|---|
| Key leakage | Server-side env only; `SecretStr`; `.env` git-ignored; gitleaks in CI; errors never echo provider details |
| Cost abuse | Per-IP/minute + per-IP/day limits, **global daily request budget**, output-token cap, input-length cap, nginx `limit_req` |
| Prompt injection | Pattern guardrails on user *and* client-supplied history; system prompt treats input as data; model has no mutating tools or secrets to steal |
| XSS via model output | `ai.js` inserts replies with `textContent` only, never HTML (verified with an `<img onerror>` payload) |
| Spoofed client IP | `X-Forwarded-For` honoured only when `TRUST_PROXY_HEADERS=true`; nginx overwrites it |
| Container escape / supply chain | Non-root, read-only FS, `cap_drop: ALL`, `no-new-privileges`, pinned deps, `pip-audit` in CI |
| Info disclosure | `/docs` & OpenAPI off in `prod`; `/api/health` exposes no config |

Pattern guardrails are a speed bump, not a wall — the architectural limits above are the real protection.

## Skills & MCP
* **Skills** (`backend/skills/<name>/SKILL.md`): YAML frontmatter + instructions, same format as OpenClaw / Anthropic Agent Skills.
  Currently all skill bodies are included in the prompt; **next**: model-driven `load_skill` tool for true progressive disclosure.
* **MCP** (planned): expose the portfolio as an MCP server (`get_projects`, `search_profile`, …) so any MCP client can query it,
  and let the agent consume MCP tools through the same interface.

## Roadmap
1. ✅ Scaffold, Gemini provider, guardrails, rate limits, skills loader, Docker, CI
2. ✅ Terminal `ask` / VC·AI window streaming from `/api/chat` (`frontend/ai.js`; replies rendered with `textContent` only)
3. ✅ RAG over `backend/data/*.md` (pgvector, HNSW) with inline citations and a sources line in the UI
4. LangGraph agent: `load_skill` tool, MCP server/client
5. Evals (golden Q&A in CI) + trace viewer ("Agent Monitor" window)
