"""Tests for strict Obsidian daily-brief resolution."""

from datetime import date
from typing import Any

import pytest

from openjarvis.assistant.obsidian import (
    DailyBriefDuplicateError,
    DailyBriefNotFoundError,
    DailyBriefService,
    summarize_daily_brief,
)
from openjarvis.tools._stubs import ToolSpec


class _FakeObsidianClient:
    def __init__(self, files: list[str], notes: dict[str, str]) -> None:
        self.files = files
        self.notes = notes
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def list_tools(self) -> list[ToolSpec]:
        path_schema = {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        }
        return [
            ToolSpec(
                name="vault_list",
                description="List vault files",
                parameters=path_schema,
            ),
            ToolSpec(
                name="vault_read",
                description="Read a vault note",
                parameters=path_schema,
            ),
        ]

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None,
    ) -> dict[str, Any]:
        assert arguments is not None
        self.calls.append((name, arguments))
        if name == "vault_list":
            return {
                "content": [
                    {"type": "text", "text": "\n".join(self.files)}
                ]
            }
        path = str(arguments["path"])
        return {
            "content": [
                {"type": "text", "text": self.notes[path]}
            ]
        }


def test_daily_brief_prefers_exact_dated_note() -> None:
    exact_path = "Morning Brief/Daily Briefs/2026-07-27.md"
    themed_path = "Morning Brief/Daily Briefs/2026-07-27 - Sunday Reset.md"
    client = _FakeObsidianClient(
        [exact_path, themed_path],
        {exact_path: "# Exact\nComplete brief"},
    )
    service = DailyBriefService(client, "Morning Brief/Daily Briefs")

    note = service.read_brief(date(2026, 7, 27))

    assert note.source_path == exact_path
    assert note.content == "# Exact\nComplete brief"


def test_daily_brief_accepts_one_themed_note() -> None:
    themed_path = "Morning Brief/Daily Briefs/2026-07-27 - Sunday Reset.md"
    client = _FakeObsidianClient(
        [themed_path],
        {themed_path: "# Sunday Reset\nComplete brief"},
    )
    service = DailyBriefService(client, "Morning Brief/Daily Briefs")

    note = service.read_brief(date(2026, 7, 27))

    assert note.source_path == themed_path


def test_daily_brief_rejects_missing_date_without_fallback() -> None:
    client = _FakeObsidianClient(
        ["Morning Brief/Daily Briefs/2026-07-26.md"],
        {},
    )
    service = DailyBriefService(client, "Morning Brief/Daily Briefs")

    with pytest.raises(DailyBriefNotFoundError, match="No daily brief exists"):
        service.read_brief(date(2026, 7, 27))

    assert [name for name, _ in client.calls] == ["vault_list"]


def test_daily_brief_rejects_duplicate_themed_notes() -> None:
    first = "Morning Brief/Daily Briefs/2026-07-27 - A.md"
    second = "Morning Brief/Daily Briefs/2026-07-27 - B.md"
    client = _FakeObsidianClient([first, second], {})
    service = DailyBriefService(client, "Morning Brief/Daily Briefs")

    with pytest.raises(DailyBriefDuplicateError, match="Multiple daily briefs"):
        service.read_brief(date(2026, 7, 27))


def test_summary_scans_sections_and_reports_key_lines() -> None:
    path = "Morning Brief/Daily Briefs/2026-07-27.md"
    client = _FakeObsidianClient(
        [path],
        {
            path: (
                "# Daily Brief\nOpening context.\n"
                "## Calendar\n- First event\n- Second event\n"
                "## Research\n- Important finding\n"
            )
        },
    )
    service = DailyBriefService(client, "Morning Brief/Daily Briefs")
    note = service.read_brief(date(2026, 7, 27))

    summary = summarize_daily_brief(note, 1000)

    assert "Calendar: First event Second event" in summary
    assert "Research: Important finding" in summary


def test_summary_reads_production_banner_sections() -> None:
    path = "Morning Brief/Daily Briefs/2026-07-27 - Waterloo Prep.md"
    client = _FakeObsidianClient(
        [path],
        {
            path: (
                "---\ndate: 2026-07-27\n---\n"
                "MORNING BRIEF\n"
                "Subject: Waterloo Prep: deadline and course check\n"
                "==============================\n"
                "READ THIS FIRST\n"
                "==============================\n"
                "- Submit the application tonight.\n"
                "- Verify the course schedule today.\n"
                "==============================\n"
                "EXECUTIVE SNAPSHOT\n"
                "==============================\n"
                "- Today is a preparation day.\n"
                "- No duplicate calendar writes were needed.\n"
                "==============================\n"
                "OTHER RESEARCH\n"
                "==============================\n"
                "- Additional source material.\n"
            )
        },
    )
    service = DailyBriefService(client, "Morning Brief/Daily Briefs")
    note = service.read_brief(date(2026, 7, 27))

    summary = summarize_daily_brief(note, 1000)

    assert "Waterloo Prep: deadline and course check" in summary
    assert "Top priorities: Submit the application tonight." in summary
    assert "Executive snapshot: Today is a preparation day." in summary
