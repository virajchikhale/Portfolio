"""Input guardrails. Heuristics only — the real defence is architectural:

* the model has NO tools that mutate anything or read secrets,
* the system prompt is never echoed back,
* the API key lives only in server env,
* output is length-capped and rendered as text (not HTML) by the frontend.
"""
import re
import unicodedata

from app.config import Settings

_INJECTION = [
    r"ignore (all |any |the )?(previous|prior|above) (instructions|prompts?)",
    r"disregard (all |any |the )?(previous|prior|above)",
    r"(reveal|show|print|repeat|leak).{0,30}(system|hidden|initial) (prompt|instructions?)",
    r"you are now (?!viraj)",
    r"\bDAN\b|developer mode|jailbreak",
    r"(api[_ -]?key|secret|password|credential|\.env|env(ironment)? var)",
]
_INJECTION_RE = [re.compile(p, re.I) for p in _INJECTION]

REFUSAL = "I can only answer questions about Viraj's work, skills and projects."


class GuardrailViolation(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def sanitize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    # strip control / zero-width characters often used to smuggle instructions
    text = "".join(c for c in text if c in "\n\t" or (unicodedata.category(c) not in {"Cc", "Cf"}))
    return text.strip()


def looks_like_injection(text: str) -> bool:
    return any(r.search(sanitize(text)) for r in _INJECTION_RE)


def check_input(text: str, settings: Settings) -> str:
    clean = sanitize(text)
    if not clean:
        raise GuardrailViolation("Message is empty.")
    if len(clean) > settings.max_input_chars:
        raise GuardrailViolation(f"Message too long (max {settings.max_input_chars} characters).", 413)
    if any(r.search(clean) for r in _INJECTION_RE):
        raise GuardrailViolation(REFUSAL)
    return clean
