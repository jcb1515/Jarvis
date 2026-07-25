"""Tests for deterministic MCP read/write classification."""

from openjarvis.mcp.safety import requires_confirmation


def test_explicit_read_tool_runs_without_confirmation():
    assert (
        requires_confirmation(
            "vault_lookup",
            read_only_tools=["vault_lookup"],
            write_tools=[],
            default_mode="confirm",
        )
        is False
    )


def test_write_marker_requires_confirmation():
    assert (
        requires_confirmation(
            "browser_navigate",
            read_only_tools=[],
            write_tools=[],
            default_mode="confirm",
        )
        is True
    )


def test_explicit_playwright_navigation_is_read_only():
    assert (
        requires_confirmation(
            "browser_navigate",
            read_only_tools=["browser_navigate"],
            write_tools=[],
            default_mode="confirm",
        )
        is False
    )


def test_unknown_tool_defaults_to_confirmation():
    assert (
        requires_confirmation(
            "custom_operation",
            read_only_tools=[],
            write_tools=[],
            default_mode="confirm",
        )
        is True
    )
