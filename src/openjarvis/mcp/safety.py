"""Deterministic safety classification for tools discovered from MCP servers."""

from __future__ import annotations

from typing import Iterable

READ_MARKERS = (
    "get",
    "list",
    "read",
    "search",
    "find",
    "inspect",
    "fetch",
    "query",
    "view",
    "snapshot",
)
WRITE_MARKERS = (
    "add",
    "archive",
    "click",
    "close",
    "create",
    "delete",
    "edit",
    "execute",
    "fill",
    "install",
    "move",
    "post",
    "press",
    "remove",
    "rename",
    "run",
    "save",
    "send",
    "submit",
    "type",
    "update",
    "upload",
    "write",
)


def _matches(tool_name: str, markers: Iterable[str]) -> bool:
    normalized = tool_name.lower().replace("-", "_")
    parts = normalized.split("_")
    return any(marker in parts for marker in markers)


def requires_confirmation(
    tool_name: str,
    read_only_tools: Iterable[str],
    write_tools: Iterable[str],
    default_mode: str,
) -> bool:
    """Return whether a discovered MCP tool must wait for user approval."""
    read_only = set(read_only_tools)
    writes = set(write_tools)
    if tool_name in read_only:
        return False
    if tool_name in writes:
        return True
    if _matches(tool_name, WRITE_MARKERS):
        return True
    if _matches(tool_name, READ_MARKERS):
        return False
    return default_mode != "read"
