"""Diagnose the LLM setup with the REAL error text (unlike the API, which sanitises errors).

    cd backend && python scripts/check_llm.py
Reads the same env/.env as the app. Never prints the key.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402


async def main() -> int:
    s = get_settings()
    key = s.gemini_api_key.get_secret_value().strip() if s.gemini_api_key else ""
    print(f"provider={s.llm_provider} model={s.llm_model} thinking_budget={s.llm_thinking_budget} "
          f"max_output_tokens={s.llm_max_output_tokens}")
    print(f"GEMINI_API_KEY: {'set (' + str(len(key)) + ' chars)' if key else 'MISSING'}")
    if not key:
        print("-> put GEMINI_API_KEY in .env (repo root or backend/) or the environment.")
        return 1

    from google import genai

    client = genai.Client(api_key=key)

    print("\n[1] Listing models that support generateContent ...")
    try:
        names = [m.name.removeprefix("models/") for m in await client.aio.models.list()
                 if "generateContent" in (m.supported_actions or [])]
        print("   ", ", ".join(sorted(names)[:40]) or "(none)")
        if s.llm_model not in names:
            print(f"   !! LLM_MODEL '{s.llm_model}' is NOT in that list -> set LLM_MODEL to one of the above.")
    except Exception as e:
        print(f"   FAILED: {type(e).__name__}: {e}")
        print("   -> usually an invalid/expired key, or the Generative Language API is not enabled for it.")
        return 1

    print(f"\n[2] Streaming a test call to '{s.llm_model}' through the app's own client ...")
    import logging

    from app.llm.base import Message
    from app.llm.gemini import GeminiClient
    logging.disable(logging.CRITICAL)
    try:
        out = ""
        async for t in GeminiClient(s).stream("Answer in one short sentence.", [Message("user", "Say hello.")]):
            out += t
        print("    OK:", out.strip())
        rc = 0
    except Exception as e:
        print(f"    FAILED: {e}")
        cause = e.__cause__
        if cause:
            print(f"    underlying: {type(cause).__name__}: {str(cause)[:400]}")
        rc = 1

    print(f"\n[3] Tool calling (agent mode) with '{s.llm_model}' ...")
    try:
        from app.agent.tools import build_tools
        from app.llm.base import ToolResult, ToolResults, UserText

        specs = [t.spec for t in build_tools({}).values() if t.spec.name == "list_projects"]
        client = GeminiClient(s)
        sys_prompt = ("You can call tools. For questions about projects, call list_projects, "
                      "then answer in one sentence.")
        transcript = [UserText("Which projects does Viraj have? Use the tool.")]
        turn = None
        async for item in client.stream_turn(sys_prompt, transcript, specs):
            if not isinstance(item, str):
                turn = item
        if not turn or not turn.tool_calls:
            print("    FAILED: the model did not request the tool (it answered in text instead).")
            rc = 1
        else:
            call = turn.tool_calls[0]
            print(f"    model asked for: {call.name}({call.args})  [thought signature kept: "
                  f"{any(getattr(p, 'thought_signature', None) for p in turn.raw.parts)}]")
            transcript += [turn, ToolResults([ToolResult(call, {"result": "- Demo Project: a made-up example."})])]
            out = ""
            async for item in client.stream_turn(sys_prompt, transcript, specs):
                if isinstance(item, str):
                    out += item
            print("    OK, final answer after the tool result:", out.strip()[:120])
    except Exception as e:
        print(f"    FAILED: {e}")
        if e.__cause__:
            print(f"    underlying: {type(e.__cause__).__name__}: {str(e.__cause__)[:400]}")
        print("    -> agent mode will not work with this model. Try LLM_THINKING_LEVEL=low (Gemini 3.x) or "
              "LLM_THINKING_BUDGET=-1, or a different LLM_MODEL. Pipeline mode is unaffected.")
        rc = 1

    print(f"\n[4] Embedding test with '{s.embedding_model}' (dim {s.embedding_dim}) ...")
    try:
        from app.rag.embeddings import GeminiEmbedder

        v = await GeminiEmbedder(s).embed_query("hello")
        print(f"    OK: {len(v)}-dim vector")
    except Exception as e:
        print(f"    FAILED: {e} (check EMBEDDING_MODEL against the model list in step 1; embedding models "
              "support embedContent, not generateContent, so they may not be listed above)")
        rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
