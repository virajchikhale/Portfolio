"""Input guardrails. Heuristics only — the real defence is architectural:

* the model has NO tools that mutate anything or read secrets,
* the system prompt is never echoed back,
* the API key lives only in server env,
* output is length-capped and rendered as text (not HTML) by the frontend.
"""
import re
import unicodedata

from app.config import Settings

# What the regexes are (and are not): a cheap first filter for the obvious attacks. They are NOT the security boundary.
# The boundary is architectural: the model has no secret to leak (keys live outside the prompt), no tool that writes or
# fetches, and its output is rendered as text. So these patterns target the INTENT to override or extract, rather than
# any mention of a word, otherwise honest questions ("does he manage secrets in Docker?") would be refused.
_VERB = (r"(?:reveal|show|print|display|dump|leak|expose|output|repeat|recite|send|give|tell|share|read|cat|echo|"
         r"what(?:'s| is| are))")
_INJECTION = [
    # override: "ignore / forget / disregard (all) previous instructions" (+ common synonyms)
    r"\b(?:ignore|disregard|forget|override|bypass|skip|drop)\b.{0,25}\b(?:previous|prior|above|earlier|preceding|"
    r"all|your|these|the|any)\b.{0,20}\b(?:instructions?|prompts?|rules?|guidelines?|directives?|constraints?)\b",
    r"\bnew (?:instructions?|rules?)\s*:",
    # prompt extraction
    rf"\b{_VERB}\b.{{0,30}}\b(?:system|hidden|initial|original|secret|developer)\s+(?:prompt|instructions?|message)\b",
    rf"\b{_VERB}\b.{{0,40}}\byour\s+(?:prompt|instructions|rules|guidelines)\b",
    r"\bwhat (?:were|are) you (?:told|instructed|programmed)\b",
    r"\brepeat (?:everything|all|the text|the words) (?:above|before)\b",
    # role / mode switching
    r"\byou are now (?!viraj)",
    r"\bact as (?:an? )?(?:unrestricted|unfiltered|jailbroken|evil|dan)\b",
    r"\bpretend (?:you|to) (?:are|be|have) (?:no|without) (?:rules|restrictions|filters|limits)\b",
    r"\bdan\b|developer mode|jailbreak|do anything now|\bgod mode\b",
    # secrets: asking for the VALUE of a key/secret/credential, or for the server's configuration
    r"\bwhat(?:'s| is| are)\s+(?:the|your|his|its|this)\s+(?:\w+\s+)?(?:api[_ -]?keys?|secrets?|passwords?|"
    r"tokens?|credentials?)\b",
    rf"\b{_VERB}\b.{{0,30}}\b(?:your|the (?:server|backend|site|app|bot|system)'?s?|this (?:site|app|bot))\b"
    r".{0,15}\b(?:api[_ -]?keys?|secrets?|passwords?|credentials?|tokens?|env(?:ironment)?[ _]?var(?:iable)?s?|"
    r"\.env|config(?:uration)?)\b",
    r"\b(?:your|the backend'?s?|the server'?s?)\s+(?:api[_ -]?keys?|secrets?|passwords?|credentials?)\b",
    r"\bcat\s+\.env\b|\bprintenv\b|\bprocess\.env\b|\bos\.environ\b",
    # the same override in other languages the site's visitors are likely to use
    r"ignor(?:a|e|ez|iere|ar)\b.{0,25}(?:instrucciones|instructions|anweisungen|instru[cç][oõ]es|istruzioni)",
    r"(?:vergiss|oublie[sz]?|olvida|esquece)\b.{0,25}(?:anweisungen|instructions|instrucciones|instru[cç][oõ]es)",
    r"(?:पिछले|पिछली|सभी|ऊपर).{0,20}(?:निर्देश|आदेश).{0,15}(?:अनदेखा|भूल|ignore)",
    r"(?:मागील|वरील|सर्व).{0,20}(?:सूचना|आदेश).{0,15}(?:दुर्लक्ष|विसर)",
]
_INJECTION_RE = [re.compile(p, re.I | re.S) for p in _INJECTION]

# Lookalike letters people use to dodge keyword filters (Cyrillic/Greek that render like Latin, and leetspeak digits).
_CONFUSABLES = str.maketrans({
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d",
    "ο": "o", "α": "a", "ε": "e", "ι": "i", "ν": "v", "ρ": "p", "τ": "t", "υ": "u",
})
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"})
_SPACED_LETTERS = re.compile(r"\b(?:\w[\s.\-_*]){5,}\w\b")  # "i g n o r e"  /  "i.g.n.o.r.e"


def normalize_for_matching(text: str) -> str:
    """A copy of the text with common obfuscation undone. Used ONLY to run the patterns: the model still receives
    exactly what the visitor wrote."""
    t = text.lower().translate(_CONFUSABLES)
    t = _SPACED_LETTERS.sub(lambda m: re.sub(r"[\s.\-_*]", "", m.group()), t)
    return t.translate(_LEET)


def _matches(text: str) -> bool:
    candidates = (text, normalize_for_matching(text))
    return any(r.search(c) for r in _INJECTION_RE for c in candidates)


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
    return _matches(sanitize(text))


def check_input(text: str, settings: Settings) -> str:
    clean = sanitize(text)
    if not clean:
        raise GuardrailViolation("Message is empty.")
    if len(clean) > settings.max_input_chars:
        raise GuardrailViolation(f"Message too long (max {settings.max_input_chars} characters).", 413)
    if _matches(clean):
        raise GuardrailViolation(REFUSAL)
    return clean
