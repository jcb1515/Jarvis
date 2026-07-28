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


@pytest.mark.parametrize(
    "command",
    [
        "Can you open Gmail and Chrome for me?",
        "Please open Google Chrome and Gmail.",
        "Could you open Gmail in Chrome?",
        "Open Google Mail using Chrome please.",
    ],
)
def test_resolve_action_routes_gmail_to_chrome(command: str) -> None:
    assert resolve_action(command) == ActionRequest(
        kind=ActionKind.OPEN_URL,
        arguments={"url": "https://mail.google.com/", "label": "Gmail"},
    )


@pytest.mark.parametrize(
    ("command", "url", "label"),
    [
        ("Open Claude's website.", "https://claude.ai/", "Claude"),
        ("Open claudes website.", "https://claude.ai/", "Claude"),
        ("Can you open Apple for me?", "https://www.apple.com/ca/", "Apple"),
        (
            "Please open the Best Buy website.",
            "https://www.bestbuy.ca/",
            "Best Buy",
        ),
        (
            "Can you open Instagram for me?",
            "https://www.instagram.com/",
            "Instagram",
        ),
        ("Open Reddit.", "https://www.reddit.com/", "Reddit"),
        ("Open GitHub.", "https://github.com/", "GitHub"),
    ],
)
def test_resolve_action_routes_known_named_websites(
    command: str,
    url: str,
    label: str,
) -> None:
    assert resolve_action(command) == ActionRequest(
        kind=ActionKind.OPEN_URL,
        arguments={"url": url, "label": label},
    )


@pytest.mark.parametrize(
    ("command", "query", "label"),
    [
        (
            "Open Acme Robotics' website.",
            "acme+robotics+official+website",
            "Acme Robotics",
        ),
        (
            "Can you open Ferguson Plumbing for me?",
            "ferguson+plumbing+official+website",
            "Ferguson Plumbing",
        ),
    ],
)
def test_resolve_action_uses_direct_result_for_unknown_named_website(
    command: str,
    query: str,
    label: str,
) -> None:
    assert resolve_action(command) == ActionRequest(
        kind=ActionKind.OPEN_URL,
        arguments={
            "url": f"https://www.google.com/search?btnI=1&q={query}",
            "label": label,
        },
    )


@pytest.mark.parametrize(
    ("command", "url", "label"),
    [
        (
            "Find me a movie.",
            "https://www.google.com/search?q=best+movies+to+watch",
            "live web results for best movies to watch",
        ),
        (
            "Search YouTube for science fiction trailers.",
            "https://www.youtube.com/results?search_query=science+fiction+trailers",
            "YouTube results for science fiction trailers",
        ),
        (
            "Find live astronomy streams on Twitch.",
            "https://www.twitch.tv/search?term=live+astronomy+streams",
            "Twitch results for live astronomy streams",
        ),
        (
            "Browse the web for new movie releases.",
            "https://www.google.com/search?q=new+movie+releases",
            "live web results for new movie releases",
        ),
    ],
)
def test_resolve_action_routes_live_discovery_directly_to_search(
    command: str,
    url: str,
    label: str,
) -> None:
    assert resolve_action(command) == ActionRequest(
        kind=ActionKind.OPEN_URL,
        arguments={"url": url, "label": label},
    )


def test_resolve_action_does_not_hijack_conversation() -> None:
    assert resolve_action("How do I open a website in Chrome?") is None
    assert resolve_action("How do I open Gmail and Chrome?") is None
    assert resolve_action("Open the discussion about browser security") is None
    assert resolve_action("Open PowerShell") is None
    assert resolve_action("What is a daily brief?") is None


@pytest.mark.parametrize(
    "command",
    [
        "What's my daily brief today?",
        "What is my morning brief?",
        "Give me today's brief.",
        "Read my brief for today.",
        "Read me my morning brief for the day.",
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


@pytest.mark.parametrize(
    ("command", "application"),
    [
        ("launch Obsidian", "obsidian"),
        ("Can you open Chrome for me?", "chrome"),
        ("Could you please launch Google Chrome?", "chrome"),
        ("I want you to open the Obsidian app.", "obsidian"),
        ("Would you start up the Chrome application please?", "chrome"),
    ],
)
def test_resolve_action_limits_applications_to_allowlist(
    command: str,
    application: str,
) -> None:
    assert resolve_action(command) == ActionRequest(
        kind=ActionKind.OPEN_APPLICATION,
        arguments={"application": application},
    )


def test_resolve_action_rejects_unallowlisted_applications() -> None:
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
