"""Tests for conservative durable-context consolidation."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from openjarvis.assistant.context_memory import (
    CONTEXT_TEMPLATE,
    ContextFact,
    consolidation_is_due,
    extract_context_fact,
    merge_context,
)


@pytest.mark.parametrize(
    ("statement", "section"),
    [
        ("I prefer concise spoken answers.", "Preferences"),
        ("I'm building Astrono Jarvis.", "Ongoing Projects"),
        ("I usually review my brief in the morning.", "Recurring Facts"),
    ],
)
def test_extract_context_fact_accepts_explicit_durable_statements(
    statement: str,
    section: str,
) -> None:
    fact = extract_context_fact(statement)

    assert fact is not None
    assert fact.section == section


@pytest.mark.parametrize(
    "statement",
    [
        "Use this bearer token abc123.",
        "My API key is secret.",
        "Open that site for now.",
        "You probably think I like blue.",
        "What should I work on?",
    ],
)
def test_extract_context_fact_excludes_secrets_temporary_and_guesses(
    statement: str,
) -> None:
    assert extract_context_fact(statement) is None


def test_merge_context_preserves_sections_and_deduplicates() -> None:
    facts = [
        ContextFact("Preferences", "I prefer concise spoken answers."),
        ContextFact("Preferences", "I prefer concise spoken answers."),
        ContextFact("Ongoing Projects", "I'm building Astrono Jarvis."),
    ]

    merged, additions = merge_context(CONTEXT_TEMPLATE, facts)

    assert merged.count("I prefer concise spoken answers.") == 1
    assert "## Ongoing Projects" in merged
    assert additions["Preferences"] == ["I prefer concise spoken answers."]


def test_consolidation_runs_at_nine_pm_and_catches_up_next_startup() -> None:
    timezone = ZoneInfo("America/Toronto")
    nine_pm = datetime(2026, 7, 27, 21, 0, tzinfo=timezone)
    next_morning = datetime(2026, 7, 28, 8, 0, tzinfo=timezone)

    assert consolidation_is_due(nine_pm, "2026-07-26", True, 21) is True
    assert consolidation_is_due(next_morning, "2026-07-26", True, 21) is True
    assert consolidation_is_due(next_morning, "2026-07-27", True, 21) is False
    assert consolidation_is_due(nine_pm, "2026-07-26", False, 21) is False
