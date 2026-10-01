"""Provider-agnostic LLM interface so the model/vendor can be swapped by env var."""
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Message:
    role: str  # "user" | "assistant"
    content: str


class LLMError(Exception):
    """Raised for any provider failure. Message is safe to show to the client."""


class LLMClient(Protocol):
    def stream(self, system: str, messages: list[Message]) -> AsyncIterator[str]:
        """Yield text chunks. Raises LLMError on failure."""
        ...
