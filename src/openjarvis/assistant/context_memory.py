"""Approval-gated durable context consolidation in Obsidian."""

from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

from openjarvis.assistant.obsidian import (
    ObsidianMCPClient,
    ObsidianServiceError,
    extract_vault_note_content,
)
from openjarvis.core.paths import get_config_dir
from openjarvis.core.types import ToolResult
from openjarvis.tools.approval_execution import register_approval_handler
from openjarvis.tools.approval_store import TIER_HIGH, ApprovalStore

logger = logging.getLogger(__name__)

CONTEXT_SECTIONS: tuple[str, ...] = (
    "Preferences",
    "Ongoing Projects",
    "Recurring Facts",
)
CONTEXT_TEMPLATE = (
    "# Astrono Jarvis Context\n\n"
    "## Preferences\n\n"
    "## Ongoing Projects\n\n"
    "## Recurring Facts\n"
)
_EXECUTION_KEY = "obsidian:context_section_patch"
_SECRET_MARKERS = (
    "api key",
    "apikey",
    "bearer ",
    "password",
    "secret",
    "token",
    "sk_",
    "nvapi-",
)
_TEMPORARY_MARKERS = (
    "just this once",
    "for now",
    "today only",
    "temporarily",
    "this time",
)


@dataclass(frozen=True)
class ContextFact:
    """One explicit durable fact stated by the user."""

    section: str
    text: str


@dataclass
class ContextState:
    """Local scheduling and candidate state."""

    last_consolidated_date: str
    pending_facts: list[ContextFact]


def extract_context_fact(user_text: str) -> ContextFact | None:
    """Extract only explicit, durable, non-secret user statements."""

    normalized = " ".join(user_text.strip().split())
    lowered = normalized.lower()
    if not normalized or any(marker in lowered for marker in _SECRET_MARKERS):
        return None
    if any(marker in lowered for marker in _TEMPORARY_MARKERS):
        return None

    patterns: tuple[tuple[str, str], ...] = (
        ("Preferences", r"^(?:i prefer|i like|i dislike|i do not like|i don't like)\b"),
        (
            "Ongoing Projects",
            r"^(?:i am|i'm|we are|we're) (?:building|working on|developing)\b",
        ),
        (
            "Recurring Facts",
            r"^(?:i always|i usually|my [a-z][a-z ]{1,40} is|i am based in)\b",
        ),
    )
    for section, pattern in patterns:
        if re.search(pattern, normalized, re.IGNORECASE):
            return ContextFact(section=section, text=normalized.rstrip(".") + ".")
    return None


def consolidation_is_due(
    now: datetime,
    last_consolidated_date: str,
    has_pending_facts: bool,
    consolidation_hour: int,
) -> bool:
    """Return whether the 9 PM run or a missed-run catch-up is due."""

    if not has_pending_facts:
        return False
    try:
        last_date = date.fromisoformat(last_consolidated_date)
    except ValueError:
        last_date = date.min
    today = now.date()
    missed_previous_day = last_date < today - timedelta(days=1)
    due_today = now.hour >= consolidation_hour and last_date < today
    return missed_previous_day or due_today


def _parse_context_sections(content: str) -> dict[str, list[str]]:
    sections = {section: [] for section in CONTEXT_SECTIONS}
    active_section = ""
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if line.startswith("## "):
            heading = line[3:].strip()
            active_section = heading if heading in sections else ""
            continue
        if active_section and line.startswith(("- ", "* ")):
            sections[active_section].append(line[2:].strip())
    return sections


def _render_context(sections: Mapping[str, list[str]]) -> str:
    chunks = ["# Astrono Jarvis Context"]
    for section in CONTEXT_SECTIONS:
        chunks.extend(["", f"## {section}", ""])
        chunks.extend(f"- {fact}" for fact in sections[section])
    return "\n".join(chunks).rstrip() + "\n"


def merge_context(
    existing_content: str,
    facts: list[ContextFact],
) -> tuple[str, dict[str, list[str]]]:
    """Merge facts without duplicates and return additions by section."""

    sections = _parse_context_sections(existing_content or CONTEXT_TEMPLATE)
    additions = {section: [] for section in CONTEXT_SECTIONS}
    normalized_existing = {
        fact.casefold().rstrip(".")
        for values in sections.values()
        for fact in values
    }
    for fact in facts:
        normalized = fact.text.casefold().rstrip(".")
        if normalized in normalized_existing:
            continue
        sections[fact.section].append(fact.text)
        additions[fact.section].append(fact.text)
        normalized_existing.add(normalized)
    return _render_context(sections), additions


class ContextMemoryService:
    """Collect durable facts and propose one daily Obsidian approval."""

    def __init__(
        self,
        client_factory: Callable[[], ObsidianMCPClient],
        approval_store: ApprovalStore,
        context_path: str,
        timezone_name: str,
        consolidation_hour: int,
        state_path: Path,
        cache_path: Path,
    ) -> None:
        self._client_factory = client_factory
        self._approval_store = approval_store
        self._context_path = context_path
        self._timezone = ZoneInfo(timezone_name)
        self._consolidation_hour = consolidation_hour
        self._state_path = state_path
        self._cache_path = cache_path
        self._lock = threading.RLock()
        self._running = False
        register_approval_handler(_EXECUTION_KEY, self._execute_approved_patch)

    @classmethod
    def from_config(
        cls,
        client_factory: Callable[[], ObsidianMCPClient],
        approval_store: ApprovalStore,
        config: Any,
    ) -> "ContextMemoryService":
        """Build the service using typed context-memory configuration."""

        return cls(
            client_factory=client_factory,
            approval_store=approval_store,
            context_path=config.path,
            timezone_name=config.timezone,
            consolidation_hour=config.consolidation_hour,
            state_path=get_config_dir() / "context_memory_state.json",
            cache_path=get_config_dir() / "obsidian_context_cache.md",
        )

    def _load_state(self) -> ContextState:
        if not self._state_path.exists():
            return ContextState(last_consolidated_date="", pending_facts=[])
        try:
            payload = json.loads(self._state_path.read_text(encoding="utf-8"))
            facts = [
                ContextFact(section=item["section"], text=item["text"])
                for item in payload.get("pending_facts", [])
            ]
            return ContextState(
                last_consolidated_date=str(
                    payload.get("last_consolidated_date", "")
                ),
                pending_facts=facts,
            )
        except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
            raise ObsidianServiceError(
                f"Context-memory state file is invalid: {self._state_path}: {exc}"
            ) from exc

    def _save_state(self, state: ContextState) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self._state_path.with_suffix(".tmp")
        payload = {
            "last_consolidated_date": state.last_consolidated_date,
            "pending_facts": [asdict(fact) for fact in state.pending_facts],
        }
        temporary_path.write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
        temporary_path.replace(self._state_path)

    def submit(self, user_text: str, assistant_text: str) -> None:
        """Collect an explicit user fact; assistant output is never trusted."""

        del assistant_text
        fact = extract_context_fact(user_text)
        if fact is None:
            return
        with self._lock:
            state = self._load_state()
            existing = {
                (item.section, item.text.casefold()) for item in state.pending_facts
            }
            if (fact.section, fact.text.casefold()) not in existing:
                state.pending_facts.append(fact)
                self._save_state(state)
        self.check_due_async()

    def check_due_async(self) -> None:
        """Run a due consolidation in one background worker."""

        with self._lock:
            state = self._load_state()
            now = datetime.now(self._timezone)
            if self._running or not consolidation_is_due(
                now,
                state.last_consolidated_date,
                bool(state.pending_facts),
                self._consolidation_hour,
            ):
                return
            self._running = True

        worker = threading.Thread(
            target=self._consolidate_worker,
            name="astrono-context-consolidation",
            daemon=True,
        )
        worker.start()

    def _consolidate_worker(self) -> None:
        try:
            self.propose_consolidation()
        except Exception as exc:
            logger.warning(
                "Context consolidation could not be proposed",
                extra={"error": str(exc), "path": self._context_path},
            )
        finally:
            with self._lock:
                self._running = False

    def propose_consolidation(self) -> str | None:
        """Queue one exact multi-section Obsidian patch for approval."""

        with self._lock:
            state = self._load_state()
            if not state.pending_facts:
                return None
            facts = list(state.pending_facts)

        client = self._client_factory()
        specs = {spec.name: spec for spec in client.list_tools()}
        for required_tool in ("vault_read", "vault_patch", "vault_write"):
            if required_tool not in specs:
                raise ObsidianServiceError(
                    f"Obsidian MCP does not expose '{required_tool}'."
                )

        existing_content = ""
        note_exists = True
        try:
            read_result = client.call_tool(
                "vault_read",
                {"path": self._context_path},
            )
            existing_content = extract_vault_note_content(read_result)
        except Exception as exc:
            if "not found" not in str(exc).lower():
                raise
            note_exists = False

        merged_content, additions = merge_context(existing_content, facts)
        added_facts = [
            fact for values in additions.values() for fact in values
        ]
        if not added_facts:
            with self._lock:
                state = self._load_state()
                state.pending_facts = []
                state.last_consolidated_date = datetime.now(
                    self._timezone
                ).date().isoformat()
                self._save_state(state)
            return None

        operations: list[dict[str, Any]] = []
        if note_exists:
            for section in CONTEXT_SECTIONS:
                section_additions = additions[section]
                if not section_additions:
                    continue
                content = "\n" + "\n".join(
                    f"- {fact}" for fact in section_additions
                )
                operations.append(
                    {
                        "tool": "vault_patch",
                        "arguments": {
                            "path": self._context_path,
                            "targetType": "heading",
                            "target": [section],
                            "operation": "append",
                            "scope": "content",
                            "content": content,
                        },
                    }
                )
        else:
            operations.append(
                {
                    "tool": "vault_write",
                    "arguments": {
                        "path": self._context_path,
                        "content": merged_content,
                    },
                }
            )

        pending = next(
            (
                action
                for action in self._approval_store.list_pending()
                if action.permission_key == "obsidian_context:daily"
            ),
            None,
        )
        if pending is not None:
            return pending.id
        action = self._approval_store.queue_action(
            action_type="obsidian_context_patch",
            description=(
                f"Add {len(added_facts)} durable fact(s) to "
                f"{self._context_path} by section"
            ),
            payload={
                "execution_key": _EXECUTION_KEY,
                "arguments": {
                    "operations": operations,
                    "merged_content": merged_content,
                    "fact_count": len(added_facts),
                },
            },
            permission_key="obsidian_context:daily",
            tier=TIER_HIGH,
        )
        return action.id

    def _execute_approved_patch(
        self,
        payload: Mapping[str, Any],
    ) -> ToolResult:
        operations = payload.get("operations")
        merged_content = payload.get("merged_content")
        if not isinstance(operations, list) or not isinstance(merged_content, str):
            return ToolResult(
                tool_name="obsidian_context_patch",
                content="Stored context patch payload is malformed.",
                success=False,
            )
        client = self._client_factory()
        for operation in operations:
            if not isinstance(operation, Mapping):
                return ToolResult(
                    tool_name="obsidian_context_patch",
                    content="Stored context patch operation is malformed.",
                    success=False,
                )
            tool_name = operation.get("tool")
            arguments = operation.get("arguments")
            if not isinstance(tool_name, str) or not isinstance(arguments, dict):
                return ToolResult(
                    tool_name="obsidian_context_patch",
                    content="Stored context patch arguments are malformed.",
                    success=False,
                )
            if tool_name == "vault_patch":
                content = arguments.get("content")
                if not isinstance(content, str):
                    return ToolResult(
                        tool_name="obsidian_context_patch",
                        content="Stored context patch content is malformed.",
                        success=False,
                    )
                read_result = client.call_tool(
                    "vault_read",
                    {"path": self._context_path},
                )
                if read_result.get("isError"):
                    return ToolResult(
                        tool_name="obsidian_context_patch",
                        content=(
                            "Obsidian vault_read failed before the idempotency "
                            f"check: {read_result.get('content')}"
                        ),
                        success=False,
                    )
                existing_content = extract_vault_note_content(read_result)
                additions = [
                    line.strip() for line in content.splitlines() if line.strip()
                ]
                if additions and all(
                    addition in existing_content for addition in additions
                ):
                    continue
            result = client.call_tool(tool_name, arguments)
            if result.get("isError"):
                return ToolResult(
                    tool_name="obsidian_context_patch",
                    content=f"Obsidian {tool_name} failed: {result.get('content')}",
                    success=False,
                )

        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_path.write_text(merged_content, encoding="utf-8")
        with self._lock:
            state = self._load_state()
            state.pending_facts = []
            state.last_consolidated_date = datetime.now(
                self._timezone
            ).date().isoformat()
            self._save_state(state)
        return ToolResult(
            tool_name="obsidian_context_patch",
            content=(
                f"Updated {self._context_path} and refreshed the local context cache."
            ),
            success=True,
        )


def read_cached_context(config: Any) -> str:
    """Read a bounded approved Obsidian context copy for prompt injection."""

    if not config.enabled:
        return ""
    cache_path = get_config_dir() / "obsidian_context_cache.md"
    if not cache_path.exists():
        return ""
    content = cache_path.read_text(encoding="utf-8")
    return content[: config.max_injected_chars]


__all__ = [
    "CONTEXT_SECTIONS",
    "CONTEXT_TEMPLATE",
    "ContextFact",
    "ContextMemoryService",
    "ContextState",
    "consolidation_is_due",
    "extract_context_fact",
    "merge_context",
    "read_cached_context",
]
