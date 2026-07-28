"""Tests for the bounded action-only tool loop."""

import json

from openjarvis.assistant.tool_loop import (
    is_action_oriented,
    run_bounded_tool_loop,
    select_action_tools,
)
from openjarvis.core.types import Message, Role, ToolResult
from openjarvis.tools._stubs import BaseTool, ToolExecutor, ToolSpec


class _ReadTool(BaseTool):
    tool_id = "calendar_next_meeting"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.tool_id,
            description="Read next meeting",
            parameters={"type": "object", "properties": {}},
        )

    def execute(self, **params) -> ToolResult:
        del params
        return ToolResult(
            tool_name=self.tool_id,
            content='{"summary":"Project review"}',
            success=True,
        )


class _ScopedTool(BaseTool):
    def __init__(self, name: str, server: str) -> None:
        self.tool_id = name
        self._server = server

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.tool_id,
            description=self.tool_id,
            parameters={"type": "object", "properties": {}},
            metadata={"mcp_server": self._server},
        )

    def execute(self, **params) -> ToolResult:
        del params
        return ToolResult(tool_name=self.tool_id, content="ok", success=True)


class _ToolCallingEngine:
    def __init__(self) -> None:
        self.calls = 0

    def generate(self, messages, **kwargs):
        del messages, kwargs
        self.calls += 1
        if self.calls == 1:
            return {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "name": "calendar_next_meeting",
                        "arguments": json.dumps({}),
                    }
                ],
            }
        return {"content": "Your next meeting is Project review."}


def test_action_classifier_preserves_direct_conversation() -> None:
    assert is_action_oriented("Check my next calendar meeting") is True
    assert is_action_oriented("Find me a movie") is True
    assert is_action_oriented("Search YouTube for a trailer") is True
    assert is_action_oriented("Browse Twitch for a live stream") is True
    assert is_action_oriented("Explain how email encryption works") is False


def test_action_tool_selection_limits_browser_snapshot_schema() -> None:
    tools = [
        _ScopedTool("browser_snapshot", "playwright"),
        _ScopedTool("browser_click", "playwright"),
        _ScopedTool("browser_run_code_unsafe", "playwright"),
        _ScopedTool("gmail_search", "google_workspace"),
        _ScopedTool("vault_read", "obsidian"),
    ]

    selected = select_action_tools("Take a browser snapshot", tools)

    assert [tool.spec.name for tool in selected] == ["browser_snapshot"]


def test_action_tool_selection_includes_read_context_for_browser_write() -> None:
    tools = [
        _ScopedTool("browser_snapshot", "playwright"),
        _ScopedTool("browser_click", "playwright"),
        _ScopedTool("browser_type", "playwright"),
        _ScopedTool("calendar_today", "google_workspace"),
    ]

    selected = select_action_tools("Click the button on this page", tools)

    assert [tool.spec.name for tool in selected] == [
        "browser_snapshot",
        "browser_click",
    ]


def test_movie_discovery_selects_only_browser_read_tools() -> None:
    tools = [
        _ScopedTool("browser_navigate", "playwright"),
        _ScopedTool("browser_snapshot", "playwright"),
        _ScopedTool("browser_click", "playwright"),
        _ScopedTool("gmail_search", "google_workspace"),
        _ScopedTool("vault_read", "obsidian"),
    ]

    selected = select_action_tools("Find me a movie", tools)

    assert [tool.spec.name for tool in selected] == [
        "browser_navigate",
        "browser_snapshot",
    ]


def test_bounded_loop_executes_tool_then_returns_final_answer() -> None:
    engine = _ToolCallingEngine()
    tool = _ReadTool()

    result = run_bounded_tool_loop(
        engine=engine,
        model="qwen3.5:4b",
        messages=[Message(role=Role.USER, content="Check my next meeting")],
        tools=[tool],
        executor=ToolExecutor([tool]),
        max_turns=3,
        temperature=0.2,
        max_tokens=512,
        think=False,
    )

    assert result.content == "Your next meeting is Project review."
    assert result.tool_names == ("calendar_next_meeting",)
    assert engine.calls == 2
