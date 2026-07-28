"""Bounded tool-capable execution path for explicit action requests."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Sequence

from openjarvis.core.types import Message, Role, ToolCall
from openjarvis.tools._stubs import BaseTool, ToolExecutor

_ACTION_VERBS = (
    "accept",
    "archive",
    "browse",
    "check",
    "click",
    "close",
    "create",
    "decline",
    "delete",
    "discover",
    "download",
    "fill",
    "find",
    "list",
    "look",
    "read",
    "recommend",
    "respond",
    "schedule",
    "search",
    "send",
    "show",
    "submit",
    "trash",
    "type",
    "update",
)
_TOOL_NOUNS = (
    "calendar",
    "email",
    "event",
    "gmail",
    "inbox",
    "meeting",
    "message",
    "movie",
    "page",
    "site",
    "show",
    "stream",
    "trailer",
    "twitch",
    "video",
    "website",
    "web",
    "youtube",
    "film",
    "note",
    "obsidian",
)
_BROWSER_READ_TOOLS = frozenset(
    {
        "browser_console_messages",
        "browser_find",
        "browser_navigate",
        "browser_network_requests",
        "browser_snapshot",
    }
)
_BROWSER_WRITE_TOOL_KEYWORDS: tuple[tuple[str, frozenset[str]], ...] = (
    ("click", frozenset({"browser_click"})),
    ("close", frozenset({"browser_close"})),
    ("download", frozenset({"browser_click"})),
    ("fill", frozenset({"browser_fill_form", "browser_type"})),
    ("submit", frozenset({"browser_click", "browser_press_key"})),
    ("type", frozenset({"browser_type"})),
)


class ToolLoopError(RuntimeError):
    """Raised when a bounded action loop cannot complete safely."""


@dataclass(frozen=True)
class ToolLoopResult:
    """Final content and tool activity from a bounded action loop."""

    content: str
    tool_names: tuple[str, ...]
    success: bool
    reasoning_content: str


def is_action_oriented(command: str) -> bool:
    """Conservatively identify commands that should enter the tool path."""

    lowered = command.casefold()
    has_verb = any(
        re.search(rf"\b{re.escape(verb)}\b", lowered)
        for verb in _ACTION_VERBS
    )
    has_noun = any(
        re.search(rf"\b{re.escape(noun)}s?\b", lowered)
        for noun in _TOOL_NOUNS
    )
    return has_verb and has_noun


def select_action_tools(
    command: str,
    tools: Sequence[BaseTool],
) -> list[BaseTool]:
    """Limit an action request to the smallest relevant tool family."""

    lowered = command.casefold()
    selected_names: set[str] = set()
    selected_servers: set[str] = set()

    if re.search(r"\b(?:email|gmail|inbox|message)s?\b", lowered):
        selected_names.update(
            tool.spec.name for tool in tools if tool.spec.name.startswith("gmail_")
        )
    if re.search(r"\b(?:calendar|event|meeting)s?\b", lowered):
        selected_names.update(
            tool.spec.name
            for tool in tools
            if tool.spec.name.startswith("calendar_")
        )
    if re.search(r"\b(?:note|obsidian)s?\b", lowered):
        selected_servers.add("obsidian")
    if re.search(
        r"\b(?:browser|film|internet|movie|page|site|show|stream|trailer|"
        r"twitch|video|web|website|youtube)s?\b",
        lowered,
    ):
        selected_names.update(_BROWSER_READ_TOOLS)
        for keyword, tool_names in _BROWSER_WRITE_TOOL_KEYWORDS:
            if re.search(rf"\b{re.escape(keyword)}\b", lowered):
                selected_names.update(tool_names)

    if not selected_names and not selected_servers:
        return list(tools)

    return [
        tool
        for tool in tools
        if tool.spec.name in selected_names
        or str(tool.spec.metadata.get("mcp_server", "")).casefold()
        in selected_servers
    ]


def _parse_tool_calls(raw_calls: Any) -> list[ToolCall]:
    if not isinstance(raw_calls, list):
        return []
    parsed: list[ToolCall] = []
    for index, raw_call in enumerate(raw_calls):
        if not isinstance(raw_call, dict):
            raise ToolLoopError("The model returned a malformed tool call.")
        function = raw_call.get("function", raw_call)
        if not isinstance(function, dict):
            raise ToolLoopError("The model returned a malformed tool function.")
        name = function.get("name")
        arguments = function.get("arguments", "{}")
        if not isinstance(name, str) or not name:
            raise ToolLoopError("The model returned a tool call without a name.")
        if isinstance(arguments, dict):
            arguments = json.dumps(arguments)
        if not isinstance(arguments, str):
            raise ToolLoopError(
                f"The model returned malformed arguments for '{name}'."
            )
        parsed.append(
            ToolCall(
                id=str(raw_call.get("id", f"tool-{index + 1}")),
                name=name,
                arguments=arguments,
            )
        )
    return parsed


def run_bounded_tool_loop(
    engine: Any,
    model: str,
    messages: list[Message],
    tools: Sequence[BaseTool],
    executor: ToolExecutor,
    max_turns: int,
    temperature: float,
    max_tokens: int,
    think: bool,
) -> ToolLoopResult:
    """Run at most ``max_turns`` model/tool cycles."""

    if max_turns < 1:
        raise ValueError("Google Workspace max_tool_turns must be positive.")
    if not tools:
        raise ToolLoopError(
            "No action tools are available. Check Google OAuth and MCP services."
        )
    if executor is None:
        raise ToolLoopError("The action tool executor is not initialized.")
    active_messages = list(messages)
    tool_schemas = [tool.to_openai_function() for tool in tools]
    used_tools: list[str] = []
    reasoning_parts: list[str] = []

    for _turn in range(max_turns):
        result = engine.generate(
            active_messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tool_schemas,
            think=think,
        )
        tool_calls = _parse_tool_calls(result.get("tool_calls"))
        content = str(result.get("content", ""))
        reasoning = str(result.get("reasoning_content", ""))
        if reasoning:
            reasoning_parts.append(reasoning)
        if not tool_calls:
            return ToolLoopResult(
                content=content or "The action completed without a text response.",
                tool_names=tuple(used_tools),
                success=True,
                reasoning_content="\n".join(reasoning_parts),
            )

        active_messages.append(
            Message(
                role=Role.ASSISTANT,
                content=content,
                tool_calls=tool_calls,
            )
        )
        for tool_call in tool_calls:
            used_tools.append(tool_call.name)
            tool_result = executor.execute(tool_call)
            if tool_result.content.startswith("PENDING_APPROVAL:"):
                return ToolLoopResult(
                    content=(
                        "I prepared that action for your approval. "
                        "Open the approval panel to review and execute the exact "
                        "stored request."
                    ),
                    tool_names=tuple(used_tools),
                    success=True,
                    reasoning_content="\n".join(reasoning_parts),
                )
            active_messages.append(
                Message(
                    role=Role.TOOL,
                    content=tool_result.content,
                    name=tool_call.name,
                    tool_call_id=tool_call.id,
                )
            )

    raise ToolLoopError(
        f"The action exceeded the configured limit of {max_turns} tool turns."
    )


__all__ = [
    "ToolLoopError",
    "ToolLoopResult",
    "is_action_oriented",
    "run_bounded_tool_loop",
    "select_action_tools",
]
