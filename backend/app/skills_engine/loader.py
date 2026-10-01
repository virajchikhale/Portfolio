"""Skill loader — OpenClaw / Anthropic-Agent-Skills style.

A skill is a directory containing SKILL.md:

    ---
    name: project-explainer
    description: When to use this skill (always in the prompt, so keep it short)
    ---
    Full instructions (loaded only when the skill is selected: "progressive disclosure").

Only name+description go into the system prompt. The body is injected on demand.
"""
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n(.*)\Z", re.S)
_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str


def load_skills(root: str | Path) -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    root = Path(root)
    if not root.is_dir():
        return skills
    for md in sorted(root.glob("*/SKILL.md")):
        m = _FRONTMATTER.match(md.read_text(encoding="utf-8"))
        if not m:
            raise ValueError(f"{md}: missing YAML frontmatter")
        meta = yaml.safe_load(m.group(1)) or {}
        name, desc = str(meta.get("name", "")), str(meta.get("description", ""))
        if not _NAME.match(name) or name != md.parent.name:
            raise ValueError(f"{md}: 'name' must equal the directory name and be kebab-case")
        if not desc:
            raise ValueError(f"{md}: 'description' is required")
        skills[name] = Skill(name, desc, m.group(2).strip())
    return skills


def catalog(skills: dict[str, Skill]) -> str:
    return "\n".join(f"- {s.name}: {s.description}" for s in skills.values())
