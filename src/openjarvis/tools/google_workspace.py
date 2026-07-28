"""Local MCP-compatible Google Workspace tool provider."""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

from openjarvis.connectors.gcalendar import GCalendarConnector
from openjarvis.connectors.gmail import (
    GmailConnector,
    _decode_body,
    _extract_header,
)
from openjarvis.core.types import ToolResult
from openjarvis.mcp.server import MCPServer
from openjarvis.tools._stubs import BaseTool, ToolSpec

logger = logging.getLogger(__name__)

ToolHandler = Callable[[Mapping[str, Any]], Any]
_MAX_TOOL_RESULT_CHARACTERS = 8_000
_GMAIL_BODY_PREVIEW_CHARACTERS = 1_200


def _truncate_json_content(content: str, max_characters: int) -> str:
    """Wrap the largest fitting preview in a valid JSON object."""

    low = 0
    high = min(len(content), max_characters)
    best = json.dumps(
        {
            "truncated": True,
            "original_characters": len(content),
            "preview": "",
        },
        ensure_ascii=False,
    )
    while low <= high:
        midpoint = (low + high) // 2
        candidate = json.dumps(
            {
                "truncated": True,
                "original_characters": len(content),
                "preview": content[:midpoint],
            },
            ensure_ascii=False,
        )
        if len(candidate) <= max_characters:
            best = candidate
            low = midpoint + 1
        else:
            high = midpoint - 1
    return best


def _json_result(tool_name: str, value: Any) -> ToolResult:
    """Serialize a connector result into bounded MCP tool text."""

    content = json.dumps(value, ensure_ascii=False, default=str)
    if len(content) > _MAX_TOOL_RESULT_CHARACTERS:
        content = _truncate_json_content(
            content,
            _MAX_TOOL_RESULT_CHARACTERS,
        )
    return ToolResult(tool_name=tool_name, content=content, success=True)


def _gmail_message_summary(message: Mapping[str, Any]) -> dict[str, Any]:
    """Project a raw Gmail message into model-friendly metadata and text."""

    raw_payload = message.get("payload", {})
    if not isinstance(raw_payload, dict):
        raise ValueError("Gmail message payload must be an object.")
    raw_headers = raw_payload.get("headers", [])
    if not isinstance(raw_headers, list):
        raise ValueError("Gmail message headers must be an array.")
    headers = [header for header in raw_headers if isinstance(header, dict)]
    body = _decode_body(raw_payload)
    return {
        "id": str(message.get("id", "")),
        "thread_id": str(message.get("threadId", "")),
        "labels": message.get("labelIds", []),
        "from": _extract_header(headers, "From"),
        "to": _extract_header(headers, "To"),
        "cc": _extract_header(headers, "Cc"),
        "subject": _extract_header(headers, "Subject"),
        "date": _extract_header(headers, "Date"),
        "snippet": str(message.get("snippet", "")),
        "body_preview": body[:_GMAIL_BODY_PREVIEW_CHARACTERS],
        "body_truncated": len(body) > _GMAIL_BODY_PREVIEW_CHARACTERS,
    }


def _gmail_thread_summary(thread: Mapping[str, Any]) -> dict[str, Any]:
    """Project every message in a Gmail thread without raw MIME payloads."""

    raw_messages = thread.get("messages", [])
    if not isinstance(raw_messages, list):
        raise ValueError("Gmail thread messages must be an array.")
    return {
        "id": str(thread.get("id", "")),
        "history_id": str(thread.get("historyId", "")),
        "messages": [
            _gmail_message_summary(message)
            for message in raw_messages
            if isinstance(message, dict)
        ],
    }


class GoogleWorkspaceTool(BaseTool):
    """One strictly specified Google Workspace connector operation."""

    is_local = False

    def __init__(self, spec: ToolSpec, handler: ToolHandler) -> None:
        self.tool_id = spec.name
        self._spec = spec
        self._handler = handler

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    def execute(self, **params: Any) -> ToolResult:
        last_error: Exception | None = None
        max_attempts = 1 if self._spec.requires_confirmation else 2
        for attempt in range(1, max_attempts + 1):
            try:
                return _json_result(self._spec.name, self._handler(params))
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Google Workspace tool call failed",
                    extra={
                        "tool": self._spec.name,
                        "arguments": params,
                        "attempt": attempt,
                        "error": str(exc),
                    },
                )
                if attempt < max_attempts:
                    time.sleep(0.2)
        return ToolResult(
            tool_name=self._spec.name,
            content=(
                f"Google Workspace tool '{self._spec.name}' failed after "
                f"{max_attempts} attempt(s) with arguments {params}: {last_error}"
            ),
            success=False,
        )


def _spec(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str],
    requires_confirmation: bool,
) -> ToolSpec:
    return ToolSpec(
        name=name,
        description=description,
        parameters={
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
        category="google_workspace",
        requires_confirmation=requires_confirmation,
        metadata={"mcp_server": "google_workspace"},
    )


def build_google_workspace_tools(
    gmail: GmailConnector,
    calendar: GCalendarConnector,
    timezone_name: str,
) -> list[BaseTool]:
    """Build read tools and confirmation-gated Google write tools."""

    timezone = ZoneInfo(timezone_name)
    string = {"type": "string"}
    positive_limit = {"type": "integer", "minimum": 1, "maximum": 100}

    def gmail_search(params: Mapping[str, Any]) -> Any:
        messages = gmail.search_messages(
            str(params["query"]),
            int(params.get("max_results", 20)),
        )
        return [_gmail_message_summary(message) for message in messages]

    def gmail_thread(params: Mapping[str, Any]) -> Any:
        return _gmail_thread_summary(
            gmail.get_thread(str(params["thread_id"]))
        )

    def gmail_unread(params: Mapping[str, Any]) -> Any:
        messages = gmail.list_unread(
            str(params.get("label", "INBOX")),
            int(params.get("max_results", 20)),
        )
        return [_gmail_message_summary(message) for message in messages]

    def gmail_send(params: Mapping[str, Any]) -> Any:
        return gmail.send_message(
            str(params["to"]),
            str(params["subject"]),
            str(params["body"]),
        )

    def gmail_archive(params: Mapping[str, Any]) -> Any:
        message_id = str(params["message_id"])
        gmail.archive_message(message_id)
        return {"archived": True, "message_id": message_id}

    def gmail_trash(params: Mapping[str, Any]) -> Any:
        message_id = str(params["message_id"])
        gmail.delete_message(message_id)
        return {"trashed": True, "message_id": message_id}

    def calendar_today(params: Mapping[str, Any]) -> Any:
        now = datetime.now(timezone)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        return calendar.list_events(
            str(params.get("calendar_id", "primary")),
            start.isoformat(),
            end.isoformat(),
            "",
            100,
        )

    def calendar_search(params: Mapping[str, Any]) -> Any:
        now = datetime.now(timezone)
        return calendar.list_events(
            str(params.get("calendar_id", "primary")),
            now.isoformat(),
            (now + timedelta(days=365)).isoformat(),
            str(params["query"]),
            int(params.get("max_results", 20)),
        )

    def calendar_next(params: Mapping[str, Any]) -> Any:
        now = datetime.now(timezone)
        events = calendar.list_events(
            str(params.get("calendar_id", "primary")),
            now.isoformat(),
            (now + timedelta(days=365)).isoformat(),
            "",
            1,
        )
        return events[0] if events else {"event": None}

    def calendar_create(params: Mapping[str, Any]) -> Any:
        return calendar.create_event(
            str(params.get("calendar_id", "primary")),
            str(params["title"]),
            str(params["start"]),
            str(params["end"]),
            str(params.get("timezone", timezone_name)),
            str(params.get("description", "")),
            str(params.get("location", "")),
        )

    def calendar_update(params: Mapping[str, Any]) -> Any:
        changes = params["changes"]
        if not isinstance(changes, dict):
            raise ValueError("Calendar changes must be an object.")
        return calendar.update_event(
            str(params.get("calendar_id", "primary")),
            str(params["event_id"]),
            changes,
        )

    def calendar_delete(params: Mapping[str, Any]) -> Any:
        return calendar.delete_event(
            str(params.get("calendar_id", "primary")),
            str(params["event_id"]),
        )

    def calendar_respond(params: Mapping[str, Any]) -> Any:
        event_id = str(params["event_id"])
        response = str(params["response"])
        calendar.respond_to_event(
            str(params.get("calendar_id", "primary")),
            event_id,
            response,
        )
        return {"event_id": event_id, "response": response}

    definitions: list[tuple[ToolSpec, ToolHandler]] = [
        (
            _spec(
                "gmail_search",
                "Search Gmail using Gmail query syntax.",
                {"query": string, "max_results": positive_limit},
                ["query"],
                False,
            ),
            gmail_search,
        ),
        (
            _spec(
                "gmail_thread",
                "Read every message in one Gmail thread.",
                {"thread_id": string},
                ["thread_id"],
                False,
            ),
            gmail_thread,
        ),
        (
            _spec(
                "gmail_unread",
                "List unread Gmail messages.",
                {"label": string, "max_results": positive_limit},
                [],
                False,
            ),
            gmail_unread,
        ),
        (
            _spec(
                "gmail_send",
                "Send one plain-text Gmail message.",
                {"to": string, "subject": string, "body": string},
                ["to", "subject", "body"],
                True,
            ),
            gmail_send,
        ),
        (
            _spec(
                "gmail_archive",
                "Archive one Gmail message by ID.",
                {"message_id": string},
                ["message_id"],
                True,
            ),
            gmail_archive,
        ),
        (
            _spec(
                "gmail_trash",
                "Move one Gmail message to Trash.",
                {"message_id": string},
                ["message_id"],
                True,
            ),
            gmail_trash,
        ),
        (
            _spec(
                "calendar_today",
                "Read today's Google Calendar events.",
                {"calendar_id": string},
                [],
                False,
            ),
            calendar_today,
        ),
        (
            _spec(
                "calendar_search",
                "Search upcoming Google Calendar events.",
                {
                    "query": string,
                    "max_results": positive_limit,
                    "calendar_id": string,
                },
                ["query"],
                False,
            ),
            calendar_search,
        ),
        (
            _spec(
                "calendar_next_meeting",
                "Read the next upcoming Google Calendar event.",
                {"calendar_id": string},
                [],
                False,
            ),
            calendar_next,
        ),
        (
            _spec(
                "calendar_create",
                "Create one Google Calendar event.",
                {
                    "title": string,
                    "start": string,
                    "end": string,
                    "timezone": string,
                    "description": string,
                    "location": string,
                    "calendar_id": string,
                },
                ["title", "start", "end"],
                True,
            ),
            calendar_create,
        ),
        (
            _spec(
                "calendar_update",
                "Update explicit fields on one Google Calendar event.",
                {
                    "event_id": string,
                    "changes": {"type": "object"},
                    "calendar_id": string,
                },
                ["event_id", "changes"],
                True,
            ),
            calendar_update,
        ),
        (
            _spec(
                "calendar_delete",
                "Delete one Google Calendar event.",
                {"event_id": string, "calendar_id": string},
                ["event_id"],
                True,
            ),
            calendar_delete,
        ),
        (
            _spec(
                "calendar_respond",
                "Accept or decline one Google Calendar invitation.",
                {
                    "event_id": string,
                    "response": {
                        "type": "string",
                        "enum": ["accepted", "declined"],
                    },
                    "calendar_id": string,
                },
                ["event_id", "response"],
                True,
            ),
            calendar_respond,
        ),
    ]
    return [
        GoogleWorkspaceTool(tool_spec, handler)
        for tool_spec, handler in definitions
    ]


def build_google_workspace_mcp_server(
    gmail: GmailConnector,
    calendar: GCalendarConnector,
    timezone_name: str,
) -> MCPServer:
    """Expose Google Workspace tools through the local MCP protocol."""

    return MCPServer(
        build_google_workspace_tools(gmail, calendar, timezone_name)
    )


__all__ = [
    "GoogleWorkspaceTool",
    "build_google_workspace_mcp_server",
    "build_google_workspace_tools",
]
