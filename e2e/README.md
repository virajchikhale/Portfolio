# End-to-end browser checks

Real backend + real frontend + headless Firefox. ~160 checks across five pages in `pages/`:

| page | covers |
|---|---|
| `pipeline` | every playback speed, STEP/SKIP, answer gating, replay, blocked and offline paths, XSS, narrow layout |
| `dock` | opening the Flow Monitor from the dock, menu, icon, FLOW button and terminal |
| `agent` | the growing agent graph, nested retrieval detail, 2x gating, STEP, SKIP, fallback note, XSS, terminal toggle |
| `ui` | no emoji anywhere, Internet Explorer hardening (no third-party requests, hostile metadata, `javascript:` URLs), smooth switching (same DOM elements survive a mode switch), run history, request size, Activity window |
| `hard` | self-hosted font and zero third-party requests, terminal escaping, and the OS booting with site data **blocked** |

```bash
pip install -r backend/requirements-dev.txt
EMBEDDING_CACHE_DIR=/path/to/models e2e/run.sh        # all pages (needs the local embedding model once)
E2E_EMBEDDINGS=fake e2e/run.sh ui hard                # no model needed; some pages then use keyword retrieval
python e2e/server.py                                  # then browse http://localhost:8767/t.html?page=ui
```
Each page posts `PASS`/`FAIL` lines to `/report`; `run.sh` prints the totals and exits non-zero on any failure.
A fresh Firefox profile is created in the system temp dir per run (a reused one gets corrupted when the browser is killed, and Firefox failed to start with a profile inside the repo).
Headless screenshots freeze CSS transitions, so they look washed-out; the checks read computed styles instead.
