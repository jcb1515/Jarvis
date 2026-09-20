"""In-process execution registry for exact approved tool payloads."""

from __future__ import annotations

from threading import RLock
from typing import Any, Callable, Mapping

from openjarvis.core.types import ToolResult

ApprovalHandler = Callable[[Mapping[str, Any]], ToolResult]

_handlers: dict[str, ApprovalHandler] = {}
_lock = RLock()


class ApprovalExecutionError(RuntimeError):
    """Raised when an approved action has no safe executable binding."""


def execution_key(tool_name: str, server_name: str) -> str:
    """Build the stable lookup key stored with a pending action."""

    return f"{server_name}:{tool_name}"


def register_approval_handler(key: str, handler: ApprovalHandler) -> None:
    """Register the exact execution function for an approval payload."""

    if not key:
        raise ValueError("Approval execution key cannot be empty.")
    with _lock:
        _handlers[key] = handler


def execute_approved_payload(payload: Mapping[str, Any]) -> ToolResult:
    """Execute the exact arguments saved in an approved action."""

    key = payload.get("execution_key")
    arguments = payload.get("arguments")
    if not isinstance(key, str) or not key:
        raise ApprovalExecutionError("Approved action is missing its execution key.")
    if not isinstance(arguments, dict):
        raise ApprovalExecutionError(
            "Approved action arguments are missing or malformed."
        )
    with _lock:
        handler = _handlers.get(key)
    if handler is None:
        raise ApprovalExecutionError(
            f"No active tool provider is registered for '{key}'."
        )
    return handler(arguments)


def clear_approval_handlers() -> None:
    """Clear registered handlers for isolated tests."""

    with _lock:
        _handlers.clear()


__all__ = [
    "ApprovalExecutionError",
    "ApprovalHandler",
    "clear_approval_handlers",
    "execute_approved_payload",
    "execution_key",
    "register_approval_handler",
]
