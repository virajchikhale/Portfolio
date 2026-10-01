"""MCP server: the portfolio's four READ-ONLY tools for any MCP client (Claude Desktop, IDEs, other agents).

Built on the official Python SDK v2 (https://py.sdk.modelcontextprotocol.io/). Two ways to run it:

  stdio (local clients):   python -m app.mcp_server
  streamable HTTP:         mounted by the web app at /mcp  (stateless, JSON responses)

The tools are the SAME registry the chat agent uses (app/agent/tools.py), so behaviour and validation are identical.
They make no LLM calls, write nothing, fetch nothing and read no secrets.
"""
import asyncio
import hmac
import logging
import sys
from collections.abc import Callable

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.agent.tools import Tool, ToolContext, build_tools, run_tool
from app.bootstrap import start_rag
from app.config import Settings, get_settings
from app.rag.chunker import load_chunks
from app.rag.ingest import CORE_FILE
from app.security.rate_limit import RateLimiter, client_ip
from app.skills_engine.loader import load_skills

log = logging.getLogger(__name__)

READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
INSTRUCTIONS = (
    "Read-only access to Viraj Chikhale's portfolio: resume, experience, education, skills and projects. "
    "Call search_portfolio for factual questions. Results are numbered sources you can cite as [1], [2]."
)


def build_mcp_server(get_ctx: Callable[[], ToolContext], get_tools: Callable[[], dict[str, Tool]]) -> MCPServer:
    """`get_ctx` returns a ToolContext (fresh citation numbering per call); `get_tools` the tool registry."""
    descriptions = {name: t.spec.description for name, t in build_tools({}).items()}
    mcp = MCPServer("viraj-portfolio", title="Viraj Chikhale: portfolio", instructions=INSTRUCTIONS, version="1.0")

    async def call(name: str, args: dict) -> str:
        out = await run_tool(get_tools()[name], get_ctx(), args)
        if out.is_error:
            # An EXPECTED failure: ToolError becomes a clean isError result (message kept, no traceback). Any other
            # exception would be treated as a crash and its message withheld.
            raise ToolError(out.text.removeprefix("Error: "))
        return out.text

    @mcp.tool(name="search_portfolio", description=descriptions["search_portfolio"], annotations=READ_ONLY)
    async def search_portfolio(query: str) -> str:
        return await call("search_portfolio", {"query": query})

    @mcp.tool(name="load_skill", description=descriptions["load_skill"], annotations=READ_ONLY)
    async def load_skill(name: str) -> str:
        return await call("load_skill", {"name": name})

    @mcp.tool(name="list_projects", description=descriptions["list_projects"], annotations=READ_ONLY)
    async def list_projects() -> str:
        return await call("list_projects", {})

    @mcp.tool(name="get_project", description=descriptions["get_project"], annotations=READ_ONLY)
    async def get_project(name: str) -> str:
        return await call("get_project", {"name": name})

    return mcp


class McpGuard:
    """ASGI wrapper in front of the HTTP transport: optional bearer token + its own per-IP rate limit.

    The token comparison is constant-time. Requests are rejected BEFORE they reach the MCP app, so an
    unauthenticated or flooding client costs us nothing. (stdio is local and has no network exposure at all.)
    """

    def __init__(self, app, settings: Settings):
        self.app = app
        self.settings = settings
        self.token = settings.mcp_auth_token.get_secret_value().strip() if settings.mcp_auth_token else ""
        # MCP tools never call the LLM, so the LLM-oriented global daily budget does not apply here.
        self.limiter = RateLimiter(settings.model_copy(update={
            "rate_limit_per_minute": settings.mcp_rate_limit_per_minute,
            "rate_limit_per_day": settings.mcp_rate_limit_per_day,
            "daily_global_request_budget": 10**9}))

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        if request.method != "POST":
            # Stateless JSON transport: only POST is ever needed. A GET would open a long-lived event stream that
            # a public client could hold open indefinitely, so refuse it up front.
            return await JSONResponse({"error": "method not allowed"}, status_code=405,
                                      headers={"Allow": "POST"})(scope, receive, send)
        if self.token:
            supplied = request.headers.get("authorization", "")
            if not hmac.compare_digest(supplied.encode(), f"Bearer {self.token}".encode()):
                return await JSONResponse({"error": "unauthorized"}, status_code=401,
                                          headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
        try:
            self.limiter.check(client_ip(request, self.settings))
        except Exception as exc:  # HTTPException from the limiter
            return await JSONResponse({"error": getattr(exc, "detail", "rate limited")},
                                      status_code=getattr(exc, "status_code", 429),
                                      headers=getattr(exc, "headers", None))(scope, receive, send)
        return await self.app(scope, receive, send)


def transport_security(settings: Settings) -> TransportSecuritySettings:
    """DNS-rebinding protection: by default only localhost Host headers are accepted (421 otherwise).
    Behind a real hostname list it in MCP_ALLOWED_HOSTS."""
    hosts = ["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*", "testserver"]
    for h in (x.strip() for x in settings.mcp_allowed_hosts.split(",")):
        if h:
            hosts += [h, f"{h}:*"] if ":" not in h else [h]
    return TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=hosts, allowed_origins=[])


def http_app(mcp: MCPServer, settings: Settings):
    """The guarded streamable-HTTP ASGI app. Stateless + JSON: the tools are read-only and need no session state."""
    inner = mcp.streamable_http_app(streamable_http_path="/mcp", stateless_http=True, json_response=True,
                                    transport_security=transport_security(settings))
    return McpGuard(inner, settings)


# ── stdio entry point ─────────────────────────────────────────────────────
async def _serve_stdio() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)  # stdout is the protocol channel: never print to it
    settings = get_settings()
    skills = load_skills(settings.skills_dir)
    chunks = load_chunks(settings.data_dir, exclude={CORE_FILE})
    rag = await start_rag(settings)
    registry = build_tools(skills)
    try:
        mcp = build_mcp_server(
            lambda: ToolContext(settings, skills, chunks, rag.store, rag.embedder, rag.lexical), lambda: registry)
        await mcp.run_stdio_async()
    finally:
        await rag.close()


def main() -> None:
    asyncio.run(_serve_stdio())


if __name__ == "__main__":
    main()
