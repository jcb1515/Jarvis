"""Strict Obsidian MCP access for daily briefs and durable context."""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Mapping, Protocol, Sequence

from openjarvis.mcp.client import MCPClient
from openjarvis.mcp.transport import StreamableHTTPTransport
from openjarvis.tools._stubs import ToolSpec

logger = logging.getLogger(__name__)


class ObsidianServiceError(RuntimeError):
    """Raised for explicit Obsidian connectivity or schema failures."""


class DailyBriefNotFoundError(ObsidianServiceError):
    """Raised when no unambiguous dated brief exists."""


class DailyBriefDuplicateError(ObsidianServiceError):
    """Raised when more than one themed brief matches a date."""


class ObsidianMCPClient(Protocol):
    """Narrow MCP client interface used by Obsidian services."""

    def list_tools(self) -> list[ToolSpec]:
        """Return the server's available tools."""

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Call one MCP tool."""


@dataclass(frozen=True)
class DailyBriefNote:
    """A complete dated brief read from the Obsidian vault."""

    date: date
    source_path: str
    content: str


def _parse_server_list(servers: str | Sequence[Mapping[str, Any]]) -> list[dict]:
    """Parse an MCP server list and reject malformed configuration."""

    try:
        parsed = json.loads(servers) if isinstance(servers, str) else servers
    except json.JSONDecodeError as exc:
        raise ObsidianServiceError(
            f"MCP server configuration is invalid JSON: {exc}"
        ) from exc
    if not isinstance(parsed, Sequence) or isinstance(parsed, (str, bytes)):
        raise ObsidianServiceError("MCP server configuration must be a list.")
    server_list: list[dict] = []
    for entry in parsed:
        if not isinstance(entry, Mapping):
            raise ObsidianServiceError("Every MCP server entry must be an object.")
        server_list.append(dict(entry))
    return server_list


def build_obsidian_client(mcp_config: Any, server_name: str) -> MCPClient:
    """Build and initialize the named Obsidian HTTP MCP client."""

    if not getattr(mcp_config, "enabled", False):
        raise ObsidianServiceError("MCP is disabled in the active configuration.")
    server_list = _parse_server_list(getattr(mcp_config, "servers", ""))
    matches = [entry for entry in server_list if entry.get("name") == server_name]
    if len(matches) != 1:
        raise ObsidianServiceError(
            f"Expected exactly one MCP server named '{server_name}', "
            f"found {len(matches)}."
        )
    server = matches[0]
    if server.get("enabled", True) is False:
        raise ObsidianServiceError(
            f"The MCP server '{server_name}' is disabled."
        )

    raw_url = str(server.get("url", ""))
    raw_token = str(server.get("token", ""))
    url = os.path.expandvars(raw_url)
    token = os.path.expandvars(raw_token)
    if not url:
        raise ObsidianServiceError(
            f"The MCP server '{server_name}' has no URL."
        )
    if "$" in url or "%" in url:
        raise ObsidianServiceError(
            f"The MCP server '{server_name}' URL has unresolved environment variables."
        )
    if not token or "$" in token or "%" in token:
        raise ObsidianServiceError(
            f"The MCP server '{server_name}' credential is not configured."
        )
    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    verify_tls = server.get("verify_tls", True)
    if not isinstance(verify_tls, bool):
        raise ObsidianServiceError(
            f"The MCP server '{server_name}' verify_tls value must be boolean."
        )
    transport = StreamableHTTPTransport(
        url=url,
        token=token,
        verify_tls=verify_tls,
    )
    client = MCPClient(transport)
    try:
        client.initialize()
    except Exception as exc:
        client.close()
        raise ObsidianServiceError(
            f"Could not initialize Obsidian MCP at {url}: {exc}"
        ) from exc
    return client


def _extract_text_blocks(result: Mapping[str, Any]) -> list[str]:
    """Extract text blocks from a standard MCP tool result."""

    if result.get("isError"):
        raise ObsidianServiceError(
            f"Obsidian MCP returned an error: {result.get('content')}"
        )
    blocks = result.get("content")
    if not isinstance(blocks, list):
        raise ObsidianServiceError(
            "Obsidian MCP response is missing its content blocks."
        )
    texts = [
        str(block["text"])
        for block in blocks
        if isinstance(block, Mapping)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    if not texts:
        raise ObsidianServiceError(
            "Obsidian MCP response contained no readable text."
        )
    return texts


def _paths_from_json(value: Any) -> list[str]:
    """Extract note paths from a structured vault-list payload."""

    if isinstance(value, list):
        paths: list[str] = []
        for item in value:
            if isinstance(item, str):
                paths.append(item)
            elif isinstance(item, Mapping):
                path = item.get("path") or item.get("name")
                if isinstance(path, str):
                    paths.append(path)
        return paths
    if isinstance(value, Mapping):
        for key in ("files", "paths", "items"):
            if key in value:
                return _paths_from_json(value[key])
    return []


def _parse_vault_paths(result: Mapping[str, Any]) -> list[str]:
    """Parse paths from structured content or textual JSON/list output."""

    structured = result.get("structuredContent")
    paths = _paths_from_json(structured)
    if paths:
        return paths

    texts = _extract_text_blocks(result)
    for text in texts:
        try:
            paths = _paths_from_json(json.loads(text))
        except json.JSONDecodeError:
            paths = []
        if paths:
            return paths

    line_paths: list[str] = []
    for text in texts:
        for line in text.splitlines():
            candidate = line.strip().lstrip("-*").strip().strip("`\"'")
            if candidate.lower().endswith(".md"):
                line_paths.append(candidate)
    if line_paths:
        return line_paths
    raise ObsidianServiceError(
        "Obsidian vault_list returned no recognizable Markdown paths."
    )


def extract_vault_note_content(result: Mapping[str, Any]) -> str:
    """Extract full Markdown content from a vault_read MCP result."""

    texts = _extract_text_blocks(result)
    for text in texts:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, Mapping) and isinstance(parsed.get("content"), str):
            return str(parsed["content"])
    return "\n".join(texts)


class DailyBriefService:
    """Resolve and read one complete dated brief through Obsidian MCP."""

    def __init__(self, client: ObsidianMCPClient, folder: str) -> None:
        if not folder.strip():
            raise ValueError("Daily brief folder cannot be empty.")
        self._client = client
        self._folder = folder.strip("/")
        self._validated = False

    def _validate_tools(self) -> None:
        if self._validated:
            return
        specs = {spec.name: spec for spec in self._client.list_tools()}
        for tool_name in ("vault_list", "vault_read"):
            spec = specs.get(tool_name)
            if spec is None:
                raise ObsidianServiceError(
                    f"Obsidian MCP does not expose required tool '{tool_name}'."
                )
            properties = spec.parameters.get("properties", {})
            if not isinstance(properties, Mapping) or "path" not in properties:
                raise ObsidianServiceError(
                    f"Obsidian MCP tool '{tool_name}' does not accept a path."
                )
        self._validated = True

    def _call(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(1, 3):
            try:
                return self._client.call_tool(tool_name, arguments)
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Obsidian MCP call failed",
                    extra={
                        "tool": tool_name,
                        "arguments": arguments,
                        "attempt": attempt,
                        "error": str(exc),
                    },
                )
        raise ObsidianServiceError(
            f"Obsidian MCP tool '{tool_name}' failed after 2 attempts "
            f"with arguments {arguments}: {last_error}"
        ) from last_error

    def read_brief(self, brief_date: date) -> DailyBriefNote:
        """Read the one exact or unambiguous themed note for a date."""

        self._validate_tools()
        date_prefix = brief_date.isoformat()
        exact_name = f"{date_prefix}.md"
        listing = self._call("vault_list", {"path": self._folder})
        listed_paths = _parse_vault_paths(listing)
        normalized_paths = [
            path.replace("\\", "/").lstrip("/")
            for path in listed_paths
            if path.lower().endswith(".md")
        ]
        full_paths = [
            path
            if path.startswith(f"{self._folder}/")
            else f"{self._folder}/{path.rsplit('/', 1)[-1]}"
            for path in normalized_paths
        ]

        exact_path = f"{self._folder}/{exact_name}"
        if exact_path in full_paths:
            selected_path = exact_path
        else:
            themed_matches = sorted(
                {
                    path
                    for path in full_paths
                    if path.rsplit("/", 1)[-1].startswith(date_prefix)
                }
            )
            if not themed_matches:
                raise DailyBriefNotFoundError(
                    f"No daily brief exists for {date_prefix} in "
                    f"'{self._folder}'. Expected '{exact_name}' or exactly one "
                    f"'{date_prefix}*.md' themed note."
                )
            if len(themed_matches) > 1:
                joined = ", ".join(themed_matches)
                raise DailyBriefDuplicateError(
                    f"Multiple daily briefs exist for {date_prefix}: {joined}. "
                    "Keep exactly one dated note."
                )
            selected_path = themed_matches[0]

        read_result = self._call("vault_read", {"path": selected_path})
        content = extract_vault_note_content(read_result).strip()
        if not content:
            raise ObsidianServiceError(
                f"The daily brief '{selected_path}' is empty."
            )
        return DailyBriefNote(
            date=brief_date,
            source_path=selected_path,
            content=content,
        )


def summarize_daily_brief(note: DailyBriefNote, max_chars: int) -> str:
    """Create a concise voice-ready summary while scanning the complete note."""

    if max_chars < 200:
        raise ValueError("Daily brief spoken_max_chars must be at least 200.")
    content = re.sub(r"\A---\s*\n.*?\n---\s*\n", "", note.content, flags=re.DOTALL)
    banner_sections = _parse_banner_sections(content)
    if banner_sections:
        summary = _summarize_banner_brief(note, content, banner_sections)
        return _truncate_summary(summary, max_chars)

    summary = _summarize_markdown_brief(note, content)
    return _truncate_summary(summary, max_chars)


def _parse_banner_sections(content: str) -> dict[str, list[str]]:
    """Parse all-caps sections surrounded by long equals-sign dividers."""

    lines = content.splitlines()
    sections: dict[str, list[str]] = {}
    index = 0
    while index + 2 < len(lines):
        if (
            _is_banner_divider(lines[index])
            and _is_banner_heading(lines[index + 1])
            and _is_banner_divider(lines[index + 2])
        ):
            heading = lines[index + 1].strip()
            index += 3
            section_lines: list[str] = []
            while index < len(lines):
                if (
                    index + 2 < len(lines)
                    and _is_banner_divider(lines[index])
                    and _is_banner_heading(lines[index + 1])
                    and _is_banner_divider(lines[index + 2])
                ):
                    break
                cleaned = _clean_spoken_line(lines[index])
                if cleaned:
                    section_lines.append(cleaned)
                index += 1
            sections[heading] = section_lines
            continue
        index += 1
    return sections


def _is_banner_divider(line: str) -> bool:
    stripped = line.strip()
    return len(stripped) >= 20 and set(stripped) == {"="}


def _is_banner_heading(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and stripped == stripped.upper()


def _clean_spoken_line(line: str) -> str:
    """Remove Markdown list/link syntax while retaining readable prose."""

    cleaned = line.strip()
    if not cleaned or cleaned.startswith(("```", "|")):
        return ""
    cleaned = re.sub(r"^[-*>\d.)\s]+", "", cleaned).strip()
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)


def _summarize_banner_brief(
    note: DailyBriefNote,
    content: str,
    sections: Mapping[str, list[str]],
) -> str:
    """Summarize the production Morning Brief format around its action sections."""

    subject_match = re.search(r"(?m)^Subject:\s*(.+)$", content)
    parts = [f"Here is your {note.date.strftime('%A, %B %d')} daily brief."]
    if subject_match is not None:
        parts.append(subject_match.group(1).strip() + ".")

    priorities = sections.get("READ THIS FIRST", [])
    snapshot = sections.get("EXECUTIVE SNAPSHOT", [])
    if priorities:
        parts.append("Top priorities: " + " ".join(priorities[:5]))
    if snapshot:
        parts.append("Executive snapshot: " + " ".join(snapshot[:2]))
    if len(parts) == 1:
        first_section = next(
            (lines for lines in sections.values() if lines),
            [],
        )
        if first_section:
            parts.append(" ".join(first_section[:3]))
    if len(parts) == 1:
        raise ObsidianServiceError(
            f"The daily brief '{note.source_path}' contains no readable prose."
        )
    return " ".join(parts)


def _summarize_markdown_brief(note: DailyBriefNote, content: str) -> str:
    """Summarize conventional Markdown headings when no banners are present."""

    sections: list[str] = []
    current_heading = ""
    section_lines: list[str] = []

    def flush_section() -> None:
        if not section_lines:
            return
        selected = section_lines[:2]
        prefix = f"{current_heading}: " if current_heading else ""
        sections.append(prefix + " ".join(selected))
        section_lines.clear()

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            flush_section()
            current_heading = line.lstrip("#").strip()
            continue
        cleaned = _clean_spoken_line(line)
        if cleaned:
            section_lines.append(cleaned)
    flush_section()

    if not sections:
        raise ObsidianServiceError(
            f"The daily brief '{note.source_path}' contains no readable prose."
        )
    introduction = f"Here is your {note.date.strftime('%A, %B %d')} daily brief. "
    return introduction + " ".join(sections)


def _truncate_summary(summary: str, max_chars: int) -> str:
    """Truncate a spoken summary cleanly at a word boundary."""

    if len(summary) > max_chars:
        summary = summary[: max_chars - 1].rsplit(" ", 1)[0] + "…"
    return summary


__all__ = [
    "DailyBriefDuplicateError",
    "DailyBriefNotFoundError",
    "DailyBriefNote",
    "DailyBriefService",
    "ObsidianMCPClient",
    "ObsidianServiceError",
    "build_obsidian_client",
    "extract_vault_note_content",
    "summarize_daily_brief",
]
