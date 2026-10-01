import pytest

from app.skills_engine.loader import catalog, load_skills


def test_repo_skills_load():
    skills = load_skills("skills")
    assert {"about-viraj", "project-explainer", "contact-handoff"} <= set(skills)
    assert "about-viraj:" in catalog(skills)


def test_name_must_match_dir(tmp_path):
    d = tmp_path / "foo"; d.mkdir()
    (d / "SKILL.md").write_text("---\nname: bar\ndescription: x\n---\nbody")
    with pytest.raises(ValueError):
        load_skills(tmp_path)


def test_requires_frontmatter(tmp_path):
    d = tmp_path / "foo"; d.mkdir()
    (d / "SKILL.md").write_text("no frontmatter")
    with pytest.raises(ValueError):
        load_skills(tmp_path)
