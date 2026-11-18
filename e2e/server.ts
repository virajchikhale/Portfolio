/**
 * End-to-end test server for the TypeScript backend: the REAL route handlers (fake tool-calling model, keyword
 * retrieval) plus the real frontend on one origin, with the same test-only routes as e2e/server.py. Nothing here ships.
 *
 *   npx tsx e2e/server.ts           # then open http://localhost:8767/t.html?page=session
 *
 *   /t.html?page=NAME[&nostorage=1][&d=SECONDS]  the real index.html with a page-script from e2e/pages/ injected
 *   /report  (POST)                              the page posts its PASS/FAIL lines here -> e2e/.out/report.json
 *   /slow.js?d=SECONDS                           keeps the page alive (headless Firefox exits when a page finishes)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(import.meta.dirname, ".out");
mkdirSync(OUT, { recursive: true });

Object.assign(process.env, {
  LLM_PROVIDER: "fake", EMBEDDING_PROVIDER: "none", ENVIRONMENT: "dev", TRUST_PROXY_HEADERS: "true",
  RATE_LIMIT_PER_MINUTE: "500", RATE_LIMIT_PER_DAY: "5000", DAILY_GLOBAL_REQUEST_BUDGET: "100000",
});

// Same trick as the Python server: make streaming visible in the UI (and give the answer a citation to filter on).
const { FakeClient } = await import("../lib/llm/fake.js");
const ANSWER = ("Viraj worked as a Data Science Intern at Inorbvict Healthcare [1], building Power BI dashboards " +
  "and supporting a sales chatbot.").split(" ");
FakeClient.prototype.stream = async function* () {
  for (const w of ANSWER) {
    await new Promise((r) => setTimeout(r, 50));
    yield w + " ";
  }
};

const handlers: Record<string, Record<string, (r: Request) => Response | Promise<Response>>> = {
  "/api/chat": await import("../api/chat.js"),
  "/api/health": await import("../api/health.js"),
  "/api/stats": await import("../api/stats.js"),
  "/api/admin/runs": await import("../api/admin/runs.js"),
  "/mcp": await import("../api/mcp.js"),
};

const COLLECTOR = "<script>window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @'+" +
  "(e.filename||'').split('/').pop()+':'+e.lineno));window.addEventListener('unhandledrejection'," +
  "e=>window.__errs.push('unhandled: '+(e.reason&&e.reason.message||e.reason)));</script>";
const NOSTORAGE = "<script>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked'," +
  "'SecurityError')}});</script>";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".pdf": "application/pdf", ".txt": "text/plain" };

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function sendWeb(res: ServerResponse, web: Response): Promise<void> {
  res.writeHead(web.status, Object.fromEntries(web.headers));
  if (!web.body) return void res.end();
  const reader = web.body.getReader();
  res.on("close", () => reader.cancel().catch(() => {})); // the visitor left: cancel the stream like Vercel would
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done) break;
    res.write(value);
  }
  res.end();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (url.pathname === "/report" && method === "POST") {
      writeFileSync(join(OUT, "report.json"), await readBody(req));
      return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    }
    if (url.pathname === "/slow.js") {
      await new Promise((r) => setTimeout(r, (Number(url.searchParams.get("d")) || 1) * 1000));
      return void res.writeHead(200, { "Content-Type": "application/javascript" }).end("");
    }
    if (url.pathname === "/t.html") {
      const page = url.searchParams.get("page") ?? "ui";
      if (!/^[a-z0-9]+$/i.test(page)) return void res.writeHead(400).end("bad page");
      const d = Number(url.searchParams.get("d")) || 60;
      let html = readFileSync(join(ROOT, "frontend", "index.html"), "utf8");
      const script = readFileSync(join(import.meta.dirname, "pages", `${page}.js`), "utf8");
      html = html.replace("</head>", () => COLLECTOR + (url.searchParams.get("nostorage") === "1" ? NOSTORAGE : "") + "</head>");
      html = html.replace("</body>", () => `<script>${script}</script><script src='/slow.js?d=${d}'></script></body>`);
      return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    }

    const api = handlers[url.pathname];
    if (api) {
      const fn = api[method];
      if (!fn) return void res.writeHead(405).end();
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      return await sendWeb(res, await fn(new Request(url, { method, headers, body: body ? new Uint8Array(body) : undefined })));
    }

    // static frontend (no directory traversal)
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = resolve(ROOT, "frontend", rel);
    if (!file.startsWith(join(ROOT, "frontend") + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      return void res.writeHead(404).end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(Number(process.env.E2E_PORT ?? 8767), "127.0.0.1", () => console.log("e2e server up"));
