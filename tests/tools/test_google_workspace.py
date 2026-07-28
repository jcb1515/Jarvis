"""Tests for the local Google Workspace MCP provider."""

from unittest.mock import MagicMock

from openjarvis.tools.google_workspace import build_google_workspace_tools


def test_google_workspace_tool_policy_matches_read_write_boundaries() -> None:
    gmail = MagicMock()
    calendar = MagicMock()

    tools = build_google_workspace_tools(
        gmail,
        calendar,
        "America/Toronto",
    )
    policies = {
        tool.spec.name: tool.spec.requires_confirmation for tool in tools
    }

    assert policies["gmail_search"] is False
    assert policies["gmail_thread"] is False
    assert policies["gmail_unread"] is False
    assert policies["calendar_today"] is False
    assert policies["calendar_search"] is False
    assert policies["calendar_next_meeting"] is False
    assert policies["gmail_send"] is True
    assert policies["gmail_archive"] is True
    assert policies["gmail_trash"] is True
    assert policies["calendar_create"] is True
    assert policies["calendar_update"] is True
    assert policies["calendar_delete"] is True
    assert policies["calendar_respond"] is True


def test_gmail_search_read_tool_executes_without_confirmation() -> None:
    gmail = MagicMock()
    gmail.search_messages.return_value = [{"id": "message-1"}]
    calendar = MagicMock()
    tools = build_google_workspace_tools(
        gmail,
        calendar,
        "America/Toronto",
    )
    search_tool = next(tool for tool in tools if tool.spec.name == "gmail_search")

    result = search_tool.execute(query="is:unread", max_results=5)

    assert result.success is True
    assert "message-1" in result.content
    gmail.search_messages.assert_called_once_with("is:unread", 5)
