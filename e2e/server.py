"""End-to-end test server: the REAL backend (fake tool-calling model, real retrieval) plus the real frontend on one
origin, with a few test-only routes. Nothing here ships to production.

    python e2e/server.py            # then open http://localhost:8767/t.html?page=ui

Routes added for the tests:
  /t.html?page=NAME[&nostorage=1][&d=SECONDS]  the real index.html with a page-script from e2e/pages/ injected. `d` keeps
                                               the page alive that long (headless Firefox exits when a page finishes).
  /report  (POST)                              the page posts its PASS/FAIL lines here; written to e2e/.out/report.json
"""
import asyncio
import os
import sys
from pathlib import Path

import uvicorn
from fastapi import Request
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).parent / ".out"
OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT / "backend"))
os.chdir(ROOT / "backend")

import app.llm.factory as factory  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

ANSWER = ("Viraj worked as a Data Science Intern at Inorbvict Healthcare [1], building Power BI dashboards "
          "and supporting a sales chatbot.").split()


async def slow_stream(self, system, messages):  # test only: makes streaming visible in the UI
    for w in ANSWER:
        await asyncio.sleep(0.05)
        yield w + " "


factory.FakeClient.stream = slow_stream

embeddings = os.environ.get("E2E_EMBEDDINGS", "local")
settings = Settings(llm_provider="fake", vector_store="memory", embedding_provider=embeddings,
                    embedding_cache_dir=os.environ.get("EMBEDDING_CACHE_DIR", "models"),
                    rate_limit_per_minute=500, rate_limit_per_day=5000, _env_file=None,
                    **({"rag_min_score": 0.15} if embeddings == "fake" else {}))
app = create_app(settings)

COLLECTOR = ("<script>window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @'+"
             "(e.filename||'').split('/').pop()+':'+e.lineno));window.addEventListener('unhandledrejection',"
             "e=>window.__errs.push('unhandled: '+(e.reason&&e.reason.message||e.reason)));</script>")
NOSTORAGE = ("<script>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked',"
             "'SecurityError')}});</script>")


@app.get("/slow.js")
async def slow(d: float = 1.0):
    await asyncio.sleep(d)
    return Response("", media_type="application/javascript")


@app.post("/report")
async def report(req: Request):
    (OUT / "report.json").write_bytes(await req.body())
    return {"ok": True}


@app.get("/t.html")
async def test_page(page: str = "ui", d: float = 60, nostorage: int = 0):
    if not page.isalnum():
        return Response("bad page", status_code=400)
    html = (ROOT / "frontend" / "index.html").read_text()
    head = COLLECTOR + (NOSTORAGE if nostorage else "")
    script = (Path(__file__).parent / "pages" / f"{page}.js").read_text()
    html = html.replace("</head>", head + "</head>", 1)
    html = html.replace("</body>", f"<script>{script}</script><script src='/slow.js?d={d}'></script></body>", 1)
    return HTMLResponse(html)


app.mount("/", StaticFiles(directory=str(ROOT / "frontend"), html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("E2E_PORT", "8767")), log_level=os.environ.get("E2E_LOG", "warning"))
