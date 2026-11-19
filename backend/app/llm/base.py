"""Provider-agnostic LLM interface so the model/vendor can be swapped by env var."""
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class Message:
    role: str  # "user" | "assistant"
    content: str


class LLMError(Exception):
    """Raised for any provider failure. Message is safe to show to the client."""


# ── Tool calling (agent mode) ───────────────────────────────────────────────
@dataclass(frozen=True)
class ToolSpec:
    """A tool the model may call. `parameters` is a JSON Schema object (what both Gemini and MCP expect)."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    name: str
    args: dict[str, Any]
    id: str | None = None


@dataclass
class ModelTurn:
    """One model response: any text it produced and the tool calls it asked for.

    `raw` is the provider-native content exactly as received. It MUST be replayed unchanged in the next request:
    Gemini keeps thought signatures inside the function-call parts and expects them back
    (https://ai.google.dev/gemini-api/docs/thinking).
    """

    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw: Any = None


@dataclass
class ToolResult:
    call: ToolCall
    response: dict[str, Any]  # what the model sees: {"result": "..."} or {"error": "..."}


# Transcript entries for an agent run: user text, the model's turn, and the results of its tool calls.
@dataclass(frozen=True)
class UserText:
    text: str


@dataclass(frozen=True)
class ToolResults:
    results: list[ToolResult]


TranscriptEntry = UserText | ModelTurn | ToolResults | Message


class LLMClient(Protocol):
    def stream(self, system: str, messages: list[Message]) -> AsyncIterator[str]:
        """Yield text chunks. Raises LLMError on failure."""
        ...

    def stream_turn(
        self, system: str, transcript: list[TranscriptEntry], tools: list[ToolSpec]
    ) -> AsyncIterator["str | ModelTurn"]:
        """One agent turn. Yields text deltas (str) as they arrive and finally ONE ModelTurn.

        With an empty `tools` list the model must answer in text. Raises LLMError on failure.
        """
        ...
