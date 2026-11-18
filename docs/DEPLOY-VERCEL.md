# Deploying on Vercel

The site is a static frontend (`frontend/`) plus four serverless functions (`api/`). There is no database and no
container: Vercel's free **Hobby** plan is enough, and it supports custom domains with automatic HTTPS.

```
browser ──► Vercel CDN ── frontend/*            (static: index.html, script.js, fonts…)
        └─► /api/chat    (SSE stream)           api/chat.ts      ─┐
            /api/health, /api/stats             api/health.ts…    ├─► lib/ (guardrails, RAG, agent, LLM clients)
            /mcp  → /api/mcp   (MCP, JSON-RPC)  api/mcp.ts       ─┘      │
                                                                         ├─► Gemini / any OpenAI-compatible LLM
        content/data/*.md + content/skills + content/embeddings.json     └─► Upstash Redis (optional: limits + stats)
        are bundled into the functions at deploy time
```

## 1. Deploy

1. Push the `vercel-typescript` branch to GitHub.
2. [vercel.com/new](https://vercel.com/new) → import the repo → **Production Branch**: set it to `vercel-typescript`
   (Settings → Git), or merge it into `main` first. Leave the framework preset on **Other**: `vercel.json` already sets
   the output directory (`frontend`), the function timeout and the security headers.
3. Add the environment variables from [`.env.vercel.example`](../.env.vercel.example). The minimum is one LLM key:
   - Gemini: `LLM_PROVIDER=gemini`, `GEMINI_API_KEY=…` (also enables dense retrieval), or
   - Groq / any OpenAI-compatible API: `LLM_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
4. Deploy. Open `https://<project>.vercel.app/api/health`: it should say `"status":"ok"`.

## 2. Add shared storage (recommended, free)

Serverless instances do not share memory, so the per-IP limits, the daily AI budget and the Activity statistics need a
shared store. In the Vercel dashboard: **Storage → Marketplace → Upstash Redis** (free tier) → connect it to the
project. It injects `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_*` equivalents), which the
code picks up automatically. Redeploy once. Without it everything still works, but each warm instance counts on its own.

## 3. Custom domain

Project → **Settings → Domains** → add your domain and create the DNS record Vercel shows (an `A` record for the apex
domain, or a `CNAME` for `www`). HTTPS certificates are issued automatically. The frontend calls the API on the same
origin, so no CORS configuration is needed.

## 4. Retrieval and embeddings

Document vectors are **precomputed** and committed as `content/embeddings.json`, so a cold start makes no embedding call
and each question costs one (the query). After editing anything in `content/data/` (or changing `EMBEDDING_MODEL`):

```bash
npm run embed            # only new/changed chunks are sent to the API
npm run eval:retrieval   # recall / leakage report, and a recommended RAG_MIN_SCORE
git add content/embeddings.json && git commit
```

A stale vector is never used (each is keyed by a hash of the chunk text, model and dimension), and if embeddings are
unavailable the site falls back to keyword search and says so in `/api/health` (`rag.reason`).

## 5. Local development and checks

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # 108 offline tests (fake LLM, stubbed embeddings, red-team + retrieval eval sets)
cp .env.vercel.example .env  # fill in a key, then:
npm run smoke            # real model, both modes, through the real route handlers
npx vercel dev           # run the whole site locally exactly as Vercel serves it
```

## What changed from the Python backend

| Python (`backend/`) | TypeScript (`api/`, `lib/`) |
| --- | --- |
| FastAPI, uvicorn, nginx proxy | Vercel Functions (Web `Request`/`Response`), static CDN |
| Postgres + pgvector, fastembed (local ONNX model) | in-memory cosine over precomputed Gemini vectors + BM25 keyword channel |
| LangGraph agent graph | the same decide → act loop as a plain async generator (same limits and trace events) |
| `google-genai`, `httpx` | `fetch` against the Gemini and OpenAI-compatible REST APIs (zero runtime SDKs) |
| in-process rate limiter, Postgres run store | Upstash Redis when configured, in-memory otherwise |
| MCP SDK (stateless streamable HTTP) | stateless JSON-RPC at `POST /mcp` (initialize, ping, tools/list, tools/call) |

The HTTP contract is unchanged (same paths, same SSE events, same trace payloads), so `frontend/` needed no edits. The
Python backend is still in `backend/` for reference and can be deleted once you are happy with the deployment.

### Limits to know about

- **Function duration:** 60 s (`vercel.json`). Agent runs stop at 50 s (`AGENT_TIMEOUT_S`) and fall back to the pipeline.
- **Cold starts:** the first request after idle loads the corpus and builds the keyword index (tens of milliseconds); no
  model download, no database connection.
- **Free-tier quotas** are the LLM provider's, not Vercel's: the per-IP and daily budgets (`RATE_LIMIT_*`,
  `DAILY_GLOBAL_REQUEST_BUDGET`) exist to keep you inside them. Provider rate-limit errors reach the visitor as a clean
  message, never a stack trace or a key.
