"""The evaluation harness must be able to FAIL: feed it deliberately bad answers and check each defect is caught."""
import os

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chunker import load_chunks
from evals.harness import Result, evaluate, load_cases, make_settings, numbers_in, parse_sse, run_case, summarize


class Says:
    """A pipeline-mode model that always answers with a fixed text."""

    def __init__(self, text):
        self.text = text

    async def stream(self, system, messages):
        yield self.text


def case(**kw):
    return {"id": "t", "kind": "fact", "q": "What did he do at Inorbvict?", **kw}


@pytest.fixture(scope="module")
def chunks():
    return load_chunks("data", exclude={"core.md"})


def run(answer, c, chunks, live=True):
    with TestClient(create_app(make_settings("fake", False, "fake"))) as client:  # keyword embedder: fast, offline
        client.app.state.llm = Says(answer)
        return run_case(client, c, "pipeline", chunks, live)


@pytest.mark.skipif(not os.environ.get("RUN_LOCAL_EMBEDDING_TESTS"), reason="needs the real local embedding model")
def test_the_real_golden_set_passes_deterministically_in_both_modes():
    results = evaluate(make_settings("fake", False), ["pipeline", "agent"], live=False)
    failed = [(r.mode, r.case, r.failures) for r in results if not r.passed]
    assert not failed, failed
    assert len(results) == 2 * len(load_cases())


def test_golden_cases_are_well_formed():
    ids = [c["id"] for c in load_cases()]
    assert len(ids) == len(set(ids)) and len(ids) >= 20
    assert {c["kind"] for c in load_cases()} == {"fact", "followup", "unknown", "offtopic", "attack"}
    for c in load_cases():
        assert c["q"] and any(k in c for k in ("sources_any", "no_sources", "blocked", "says_unknown", "declines",
                                              "must_not_contain", "contains_any", "contains_all"))


def test_a_good_answer_passes(chunks):
    r = run("He was a Data Science Intern at Inorbvict, managing a sales chatbot [1].",
            case(sources_any=["experience.md"], contains_any=["chatbot"]), chunks)
    assert r.passed, r.failures


def test_invented_citation_is_caught(chunks):
    r = run("He built dashboards [9].", case(sources_any=["experience.md"]), chunks)
    assert any("cites [9]" in f for f in r.failures)


def test_leaked_secret_is_caught(chunks):
    r = run("The key is AIzaSyA1234567890abcdefghijklmnopqrstuv", case(), chunks)
    assert any("possible leak" in f for f in r.failures)


def test_ungrounded_number_is_caught_but_grounded_ones_pass(chunks):
    bad = run("He improved sales by 47% over 18 months [1].", case(contains_any=["sales"]), chunks)
    assert any("'47%'" in f for f in bad.failures) and any("'18'" in f for f in bad.failures)
    good = run("He built 20+ Power BI dashboards [1] between Sep 2024 and Jan 2025.", case(contains_any=["Power BI"]),
               chunks)
    assert good.passed, good.failures


def test_missing_facts_and_failure_to_admit_ignorance_are_caught(chunks):
    r = run("He is a great engineer.", case(contains_all=["Inorbvict"], says_unknown=True), chunks)
    assert any("lacks 'Inorbvict'" in f for f in r.failures) and any("admit" in f for f in r.failures)


def test_failure_to_decline_and_forbidden_text_are_caught(chunks):
    c = case(q="What is the capital of Australia?", no_sources=True, declines=True, must_not_contain=["Canberra"])
    r = run("The capital is Canberra.", c, chunks)
    assert any("does not decline" in f for f in r.failures) and any("forbidden text 'Canberra'" in f for f in r.failures)


def test_forbidden_patterns_such_as_phone_numbers_are_caught(chunks):
    r = run("You can call +91 98765 43210 anytime.", case(q="What is his phone number?",
                                                          must_not_match=["\\+?\\d[\\d ()-]{9,}\\d"]), chunks)
    assert any("forbidden pattern" in f for f in r.failures)


def test_a_missing_expected_source_and_unexpected_sources_are_caught(chunks):
    wrong = run("x", case(q="Where did he study?", sources_any=["skills.md"]), chunks, live=False)
    assert any("no expected source" in f for f in wrong.failures)
    off = run("x", case(q="Inorbvict Power BI internship", no_sources=True), chunks, live=False)
    assert any("off-topic question retrieved sources" in f for f in off.failures)


def test_a_question_that_should_have_been_blocked_is_flagged(chunks):
    assert any("should have been blocked" in f for f in run("hello", case(blocked=True), chunks).failures)


def test_live_checks_are_skipped_not_failed_without_a_real_model(chunks):
    r = run("anything", case(contains_all=["Inorbvict"], says_unknown=True), chunks, live=False)
    assert r.passed and set(r.skipped) == {"contains_all", "says_unknown"}


def test_number_extraction_ignores_citation_markers_and_small_counts():
    assert numbers_in("Three projects [1][2] and 2 more; CGPA 9.14, 86.38%, 2000+ students, in 2022.") == [
        "9.14", "86.38%", "2000", "2022"]


def test_parse_sse_collects_answer_sources_and_errors():
    raw = ('data: {"trace": {"id": "x"}}\n\ndata: {"sources": [{"n": 1, "label": "L", "source": "a.md"}]}\n\n'
           'data: {"delta": "Hi "}\n\ndata: {"delta": "there"}\n\ndata: {"error": "boom"}\n\ndata: [DONE]\n\n')
    answer, sources, trace = parse_sse(raw)
    assert answer == "Hi there[ERROR: boom]" and sources[0]["source"] == "a.md" and trace == [{"id": "x"}]


def test_summary_aggregates_per_mode():
    rs = [Result("a", "agent", "fact", 200, "x", [{"n": 1}], 100.0, 3), Result("b", "agent", "fact", 200, "x", [], 300.0, 3,
                                                                           failures=["f"])]
    s = summarize(rs, ["agent"])["agent"]
    assert (s["cases"], s["passed"], s["pass_pct"], s["avg_model_calls"], s["no_source_answers"]) == (2, 1, 50.0, 3.0, 1)
    assert s["latency_ms_p50"] == 200
