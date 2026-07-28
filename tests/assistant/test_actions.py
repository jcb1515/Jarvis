"""Integration-focused tests for deterministic assistant actions."""

from pathlib import Path
from unittest.mock import patch

import pytest

from openjarvis.assistant.actions import (
    ActionError,
    ActionKind,
    ActionRequest,
    execute_action,
    normalize_web_url,
    resolve_action,
)


@pytest.mark.parametrize(
    ("raw_url", "expected"),
    [
        ("https://Example.com/path?q=1", "https://example.com/path?q=1"),
        ("http://example.com", "http://example.com"),
        ("example.com/docs", "https://example.com/docs"),
    ],
)
def test_normalize_web_url_accepts_only_web_addresses(
    raw_url: str,
    expected: str,
) -> None:
    assert normalize_web_url(raw_url) == expected


@pytest.mark.parametrize(
    "raw_url",
    [
        "file:///C:/Windows/System32",
        "javascript:alert(1)",
        "data:text/plain,hello",
        "not-a-website",
        "https://user:secret@example.com",
        "https://example.com:99999",
    ],
)
def test_normalize_web_url_rejects_unsafe_or_malformed_inputs(
    raw_url: str,
) -> None:
    with pytest.raises(ActionError):
        normalize_web_url(raw_url)


def test_resolve_action_routes_explicit_navigation() -> None:
    action = resolve_action("Please open example.com in Chrome")

    assert action == ActionRequest(
        kind=ActionKind.OPEN_URL,
        arguments={"url": "https://example.com"},
    )


def test_resolve_action_does_not_hijack_conversation() -> None:
    assert resolve_action("How do I open a website in Chrome?") is None
    assert resolve_action("Open the discussion about browser security") is None
    assert resolve_action("What is a daily brief?") is None


@pytest.mark.parametrize(
    "command",
    [
        "What's my daily brief today?",
        "What is my morning brief?",
        "Give me today's brief.",
        "Read my brief for today.",
    ],
)
def test_resolve_action_routes_natural_daily_brief_requests(command: str) -> None:
    assert resolve_action(command) == ActionRequest(
        kind=ActionKind.DAILY_BRIEF,
        arguments={},
    )


def test_resolve_action_routes_explicit_daily_brief_date() -> None:
    assert resolve_action("Read my morning brief for 2026-07-27") == ActionRequest(
        kind=ActionKind.DAILY_BRIEF,
        arguments={"date": "2026-07-27"},
    )


def test_resolve_action_limits_applications_to_allowlist() -> None:
    assert resolve_action("launch Obsidian") == ActionRequest(
        kind=ActionKind.OPEN_APPLICATION,
        arguments={"application": "obsidian"},
    )
    assert resolve_action("launch powershell") is None


def test_execute_open_url_uses_fixed_chrome_binary_without_shell(
    tmp_path: Path,
) -> None:
    chrome_path = tmp_path / "Google" / "Chrome" / "Application" / "chrome.exe"
    chrome_path.parent.mkdir(parents=True)
    chrome_path.touch()
    action = ActionRequest(
        kind=ActionKind.OPEN_URL,
        arguments={"url": "https://example.com"},
    )

    with patch("openjarvis.assistant.actions.subprocess.Popen") as popen:
        result = execute_action(
            action,
            {"LOCALAPPDATA": str(tmp_path)},
            ("chrome", "obsidian"),
        )

    assert result.success is True
    popen.assert_called_once_with(
        [str(chrome_path), "https://example.com"],
        shell=False,
        close_fds=True,
    )
