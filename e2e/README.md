# End-to-end browser checks

Real backend + real frontend + headless Firefox. Checks across the pages in `pages/`:

| page | covers |
|---|---|
| `pipeline` | every playback speed, STEP/SKIP, answer gating, replay, blocked and offline paths, XSS, narrow layout |
| `dock` | opening the Flow Monitor from the dock, menu, icon, FLOW button and terminal |
| `agent` | the growing agent graph, nested retrieval detail, 2x gating, STEP, SKIP, fallback note, XSS, terminal toggle |
| `ui` | no emoji anywhere, Internet Explorer hardening (no third-party requests, hostile metadata, `javascript:` URLs), smooth switching (same DOM elements survive a mode switch), run history, request size, Activity window |
| `tour` | the first-visit mode chooser, the guided tour (spotlight, steps, keyboard, clean-up), the landing layout leaving the desktop visible, window dragging and fitting |
| `hard` | self-hosted font and zero third-party requests, terminal escaping, and the OS booting with site data **blocked** |
| `session` | the saved chat: survives a real page reload, 24 h sliding / 7 day expiry, NEW CHAT, strict validation of what is read back (tampering, XSS), size caps, storage-full behaviour, and the source list showing only what the answer cites |
| `actions` | page actions: typed commands run locally with no server call, questions that merely mention a command still reach the model, offers and "yes" (one message only), the allowlist, hostile text, restore, and agent-mode offers through the real SSE stream (**TS backend only**) |

```bash
pip install -r backend/requirements-dev.txt
EMBEDDING_CACHE_DIR=/path/to/models e2e/run.sh        # all pages (needs the local embedding model once)
E2E_EMBEDDINGS=fake e2e/run.sh ui hard                # no model needed; some pages then use keyword retrieval
python e2e/server.py                                  # then browse http://localhost:8767/t.html?page=ui
E2E_BACKEND=ts e2e/run.sh session                     # same checks against the TypeScript backend (api/, lib/), via Docker: no Node install needed
```
Pages are opened with `open=none`, so the chooser, tour and landing layout never start on their own; `tour` starts them explicitly.
Each page posts `PASS`/`FAIL` lines to `/report`; `run.sh` prints the totals and exits non-zero on any failure.
A fresh Firefox profile is created in the system temp dir per run (a reused one gets corrupted when the browser is killed, and Firefox failed to start with a profile inside the repo).
Headless screenshots freeze CSS transitions, so they look washed-out; the checks read computed styles instead.
