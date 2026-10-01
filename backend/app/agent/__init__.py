"""Agent mode: a tool-calling loop (LangGraph) over the portfolio's read-only tools.

Prompt assembly lives in prompt.py; it is re-exported here so `from app.agent import build_system_prompt` still works.
"""
from app.agent.prompt import build_agent_prompt, build_system_prompt, load_core

__all__ = ["build_agent_prompt", "build_system_prompt", "load_core"]
