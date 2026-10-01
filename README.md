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
                                                           └─ data/profile.md (grounding)
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
3. RAG over longer content (pgvector) + citations
4. LangGraph agent: `load_skill` tool, MCP server/client
5. Evals (golden Q&A in CI) + trace viewer ("Agent Monitor" window)
