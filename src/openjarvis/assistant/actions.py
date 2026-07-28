"""Deterministic routing for explicitly allowlisted desktop actions."""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Mapping, Sequence
from urllib.parse import SplitResult, quote_plus, urlsplit, urlunsplit


class ActionError(RuntimeError):
    """Raised when a scoped assistant action cannot be completed safely."""


class ActionKind(str, Enum):
    """Actions that may bypass the tool-less conversation agent."""

    OPEN_URL = "browser_open_url"
    OPEN_APPLICATION = "application_open"
    DAILY_BRIEF = "daily_brief_read"
    TOOL_LOOP = "bounded_tool_loop"


@dataclass(frozen=True)
class ActionRequest:
    """A validated request for one deterministic assistant action."""

    kind: ActionKind
    arguments: Mapping[str, str]


@dataclass(frozen=True)
class ActionResult:
    """User-facing result of a deterministic assistant action."""

    action: ActionRequest
    content: str
    success: bool
    reasoning_content: str


_REQUEST_PREFIX = (
    r"(?:(?:(?:can|could|would|will)\s+you|"
    r"i\s+(?:want|need)\s+you\s+to|"
    r"i(?:'d|\s+would)\s+like\s+you\s+to)\s+)?"
    r"(?:please\s+)?"
)
_REQUEST_SUFFIX = r"(?:\s+(?:for\s+me|please))?"
_URL_COMMAND = re.compile(
    rf"^\s*{_REQUEST_PREFIX}"
    r"(?:open|launch|navigate\s+to|go\s+to|visit)\s+"
    rf"(?P<target>\S+)(?:\s+(?:in|using)\s+chrome)?{_REQUEST_SUFFIX}"
    r"[.!?]?\s*$",
    re.IGNORECASE,
)
_APP_COMMAND = re.compile(
    rf"^\s*{_REQUEST_PREFIX}(?:open|launch|start)(?:\s+up)?\s+"
    r"(?:the\s+)?(?P<application>chrome|google\s+chrome|obsidian)"
    rf"(?:\s+(?:app|application))?{_REQUEST_SUFFIX}[.!?]?\s*$",
    re.IGNORECASE,
)
_GMAIL_CHROME_COMMAND = re.compile(
    rf"^\s*{_REQUEST_PREFIX}(?:open|launch|start)(?:\s+up)?\s+"
    r"(?:(?:gmail|google\s+mail)\s+(?:and|in|using)\s+"
    r"(?:google\s+)?chrome|(?:google\s+)?chrome\s+and\s+"
    r"(?:gmail|google\s+mail))"
    rf"{_REQUEST_SUFFIX}[.!?]?\s*$",
    re.IGNORECASE,
)
_NAMED_WEBSITE_COMMAND = re.compile(
    rf"^\s*{_REQUEST_PREFIX}"
    r"(?:open|navigate\s+to|go\s+to|visit)\s+"
    r"(?P<target>.+?)[.!?]?\s*$",
    re.IGNORECASE,
)
_DAILY_BRIEF_COMMAND = re.compile(
    r"^\s*(?:please\s+)?(?:"
    r"(?:give(?:\s+me)?|read|show(?:\s+me)?|summarize|tell\s+me(?:\s+about)?)"
    r"\s+(?:(?:my|the|today'?s)\s+)?(?:(?:daily|morning)\s+)?brief(?:ing)?"
    r"|what(?:'s|\s+is)\s+(?:in\s+)?(?:my|the|today'?s)\s+"
    r"(?:(?:daily|morning)\s+)?brief(?:ing)?"
    r")"
    r"(?:\s+(?:for\s+)?(?:today|\d{4}-\d{2}-\d{2}))?[?.!]?\s*$",
    re.IGNORECASE,
)
_ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_DOMAIN_WITH_OPTIONAL_PATH = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$",
    re.IGNORECASE,
)
_CHROME_RELATIVE_PATHS: tuple[tuple[str, str], ...] = (
    ("PROGRAMFILES", r"Google\Chrome\Application\chrome.exe"),
    ("PROGRAMFILES(X86)", r"Google\Chrome\Application\chrome.exe"),
    ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
)
_OBSIDIAN_RELATIVE_PATHS: tuple[tuple[str, str], ...] = (
    ("LOCALAPPDATA", r"Programs\Obsidian\Obsidian.exe"),
    ("LOCALAPPDATA", r"Obsidian\Obsidian.exe"),
    ("PROGRAMFILES", r"Obsidian\Obsidian.exe"),
)
_WEB_ALIASES: Mapping[str, tuple[str, str]] = {
    "gmail": ("https://mail.google.com/", "Gmail"),
    "google mail": ("https://mail.google.com/", "Gmail"),
    "claude": ("https://claude.ai/", "Claude"),
    "claude ai": ("https://claude.ai/", "Claude"),
    "anthropic": ("https://www.anthropic.com/", "Anthropic"),
    "apple": ("https://www.apple.com/ca/", "Apple"),
    "apple canada": ("https://www.apple.com/ca/", "Apple Canada"),
    "best buy": ("https://www.bestbuy.ca/", "Best Buy"),
    "bestbuy": ("https://www.bestbuy.ca/", "Best Buy"),
}
_NON_WEBSITE_TARGETS = frozenset(
    {
        "cmd",
        "command prompt",
        "control panel",
        "file explorer",
        "powershell",
        "registry editor",
        "regedit",
        "settings",
        "task manager",
        "terminal",
        "windows terminal",
    }
)
_NON_WEBSITE_WORDS = frozenset(
    {
        "about",
        "application",
        "command",
        "discussion",
        "document",
        "file",
        "folder",
        "program",
        "report",
        "settings",
    }
)


def _strip_wrapping_punctuation(value: str) -> str:
    """Remove punctuation commonly wrapped around a spoken URL."""

    return value.strip().strip("\"'<>[]()").rstrip(".,!?")


def _normalize_named_website(value: str) -> tuple[str, bool]:
    """Return a clean website name and whether the user named a web page."""

    candidate = _strip_wrapping_punctuation(value)
    candidate = re.sub(
        r"\s+(?:for\s+me|please)\s*$",
        "",
        candidate,
        flags=re.IGNORECASE,
    )
    candidate = re.sub(
        r"\s+(?:in|using)\s+(?:google\s+)?chrome\s*$",
        "",
        candidate,
        flags=re.IGNORECASE,
    )
    candidate = re.sub(r"^\s*the\s+", "", candidate, flags=re.IGNORECASE)
    website_marker = re.search(
        r"(?:'s|’s|'|’)?\s+"
        r"(?:website|web\s*site|site|homepage|home\s+page)\s*$",
        candidate,
        flags=re.IGNORECASE,
    )
    if website_marker is not None:
        candidate = candidate[: website_marker.start()]
    candidate = re.sub(r"(?:'s|’s)\s*$", "", candidate, flags=re.IGNORECASE)
    normalized = re.sub(r"\s+", " ", candidate).strip().casefold()
    return normalized, website_marker is not None


def _named_website_action(command: str) -> ActionRequest | None:
    """Resolve a known website or a safe official-site search."""

    match = _NAMED_WEBSITE_COMMAND.fullmatch(command)
    if match is None:
        return None
    website_name, has_website_marker = _normalize_named_website(
        match.group("target")
    )
    if not website_name:
        return None
    alias = _WEB_ALIASES.get(website_name)
    if alias is None and has_website_marker and website_name.endswith("s"):
        alias = _WEB_ALIASES.get(website_name[:-1])
    if alias is not None:
        alias_url, alias_label = alias
        return ActionRequest(
            kind=ActionKind.OPEN_URL,
            arguments={"url": alias_url, "label": alias_label},
        )
    words = website_name.split()
    is_safe_short_name = (
        1 <= len(words) <= 6
        and website_name not in _NON_WEBSITE_TARGETS
        and not any(word in _NON_WEBSITE_WORDS for word in words)
        and re.fullmatch(r"[\w&+.'’ -]+", website_name) is not None
    )
    if not has_website_marker and not is_safe_short_name:
        return None
    display_name = " ".join(
        word.capitalize() for word in website_name.split()
    )
    possessive_name = (
        f"{display_name}'" if display_name.casefold().endswith("s")
        else f"{display_name}'s"
    )
    search_query = quote_plus(f"{website_name} official website")
    return ActionRequest(
        kind=ActionKind.OPEN_URL,
        arguments={
            "url": f"https://www.google.com/search?q={search_query}",
            "label": f"a search for {possessive_name} official website",
        },
    )


def normalize_web_url(value: str) -> str:
    """Validate and normalize an HTTP(S) address.

    A bare public domain is promoted to HTTPS for natural voice commands.
    All explicit non-web schemes, credentials, and malformed hosts are rejected.
    """

    candidate = _strip_wrapping_punctuation(value)
    if not candidate:
        raise ActionError("No website address was provided.")

    explicit_scheme = re.match(r"^[a-z][a-z0-9+.-]*:", candidate, re.IGNORECASE)
    if explicit_scheme is not None and not candidate.lower().startswith(
        ("http://", "https://")
    ):
        scheme = explicit_scheme.group(0)[:-1]
        raise ActionError(
            f"The '{scheme}' scheme is not allowed. Use an http:// or https:// URL."
        )

    if "://" not in candidate:
        if not _DOMAIN_WITH_OPTIONAL_PATH.fullmatch(candidate):
            raise ActionError(
                "The website address is malformed. Provide an http:// or https:// URL."
            )
        candidate = f"https://{candidate}"

    parsed = urlsplit(candidate)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ActionError("Only http:// and https:// website addresses are allowed.")
    if not parsed.hostname:
        raise ActionError("The website address must include a valid hostname.")
    if parsed.username is not None or parsed.password is not None:
        raise ActionError("Website addresses containing credentials are not allowed.")
    if any(character.isspace() for character in candidate):
        raise ActionError("Website addresses cannot contain spaces.")

    try:
        port = parsed.port
    except ValueError as exc:
        raise ActionError(f"The website address has an invalid port: {exc}") from exc
    if port is not None and not 1 <= port <= 65535:
        raise ActionError("The website address has an invalid port.")

    normalized_host = parsed.hostname.encode("idna").decode("ascii").lower()
    if "." not in normalized_host and normalized_host not in {"localhost"}:
        raise ActionError("The website address must include a valid hostname.")
    if parsed.hostname.startswith(".") or parsed.hostname.endswith("."):
        raise ActionError("The website address has a malformed hostname.")

    netloc = normalized_host
    if ":" in normalized_host and not normalized_host.startswith("["):
        netloc = f"[{normalized_host}]"
    if port is not None:
        netloc = f"{netloc}:{port}"

    normalized = SplitResult(
        scheme=parsed.scheme.lower(),
        netloc=netloc,
        path=parsed.path or "",
        query=parsed.query,
        fragment=parsed.fragment,
    )
    return urlunsplit(normalized)


def resolve_action(command: str) -> ActionRequest | None:
    """Resolve an explicit action command without involving the language model."""

    brief_match = _DAILY_BRIEF_COMMAND.fullmatch(command)
    if brief_match is not None:
        arguments = {}
        requested_date = _ISO_DATE.search(command)
        if requested_date is not None:
            arguments["date"] = requested_date.group(0)
        return ActionRequest(
            kind=ActionKind.DAILY_BRIEF,
            arguments=arguments,
        )

    if _GMAIL_CHROME_COMMAND.fullmatch(command) is not None:
        gmail_url, gmail_label = _WEB_ALIASES["gmail"]
        return ActionRequest(
            kind=ActionKind.OPEN_URL,
            arguments={"url": gmail_url, "label": gmail_label},
        )

    application_match = _APP_COMMAND.fullmatch(command)
    if application_match is not None:
        raw_name = application_match.group("application").lower()
        application = "chrome" if "chrome" in raw_name else "obsidian"
        return ActionRequest(
            kind=ActionKind.OPEN_APPLICATION,
            arguments={"application": application},
        )

    url_match = _URL_COMMAND.fullmatch(command)
    if url_match is not None:
        raw_target = url_match.group("target")
        alias = _WEB_ALIASES.get(
            _strip_wrapping_punctuation(raw_target).casefold()
        )
        if alias is not None:
            alias_url, alias_label = alias
            return ActionRequest(
                kind=ActionKind.OPEN_URL,
                arguments={"url": alias_url, "label": alias_label},
            )
        try:
            normalized_url = normalize_web_url(raw_target)
        except ActionError:
            stripped_target = _strip_wrapping_punctuation(raw_target)
            explicit_scheme = re.match(
                r"^[a-z][a-z0-9+.-]*:",
                stripped_target,
                re.IGNORECASE,
            )
            resembles_website = (
                explicit_scheme is not None
                or "." in stripped_target
                or "/" in stripped_target
                or "\\" in stripped_target
            )
            if resembles_website:
                raise
        else:
            return ActionRequest(
                kind=ActionKind.OPEN_URL,
                arguments={"url": normalized_url},
            )

    return _named_website_action(command)


def _resolve_executable(
    candidates: Sequence[tuple[str, str]],
    environment: Mapping[str, str],
) -> Path:
    """Return the first existing executable from fixed installation locations."""

    checked_paths: list[str] = []
    for environment_name, relative_path in candidates:
        base_path = environment.get(environment_name, "")
        if not base_path:
            continue
        candidate = Path(base_path) / relative_path
        checked_paths.append(str(candidate))
        if candidate.is_file():
            return candidate
    checked = ", ".join(checked_paths) if checked_paths else "no configured paths"
    raise ActionError(f"Application executable was not found. Checked: {checked}")


def _launch_process(executable: Path, arguments: Sequence[str]) -> None:
    """Launch a fixed executable without a shell or caller-supplied arguments."""

    try:
        subprocess.Popen(  # noqa: S603 - executable is resolved from a fixed allowlist
            [str(executable), *arguments],
            shell=False,
            close_fds=True,
        )
    except OSError as exc:
        raise ActionError(
            f"Could not launch '{executable.name}': {exc}"
        ) from exc


def execute_action(
    action: ActionRequest,
    environment: Mapping[str, str] | None,
    allowed_applications: Sequence[str],
) -> ActionResult:
    """Execute one validated, confirmation-free allowlisted action."""

    active_environment = os.environ if environment is None else environment
    if action.kind == ActionKind.OPEN_URL:
        url = action.arguments["url"]
        chrome_path = _resolve_executable(_CHROME_RELATIVE_PATHS, active_environment)
        _launch_process(chrome_path, [url])
        label = action.arguments.get("label", url)
        return ActionResult(
            action=action,
            content=f"Opened {label} in Chrome.",
            success=True,
            reasoning_content="",
        )

    if action.kind == ActionKind.DAILY_BRIEF:
        raise ActionError(
            "Daily briefs require the configured Obsidian MCP service."
        )

    application = action.arguments["application"]
    if application not in {
        allowed.casefold().strip() for allowed in allowed_applications
    }:
        raise ActionError(
            f"Application '{application}' is not in the configured allowlist."
        )
    if application == "chrome":
        executable = _resolve_executable(_CHROME_RELATIVE_PATHS, active_environment)
    elif application == "obsidian":
        executable = _resolve_executable(_OBSIDIAN_RELATIVE_PATHS, active_environment)
    else:
        raise ActionError(
            f"Application '{application}' is not in the allowlist."
        )
    _launch_process(executable, [])
    return ActionResult(
        action=action,
        content=f"Opened {application.title()}.",
        success=True,
        reasoning_content="",
    )


__all__ = [
    "ActionError",
    "ActionKind",
    "ActionRequest",
    "ActionResult",
    "execute_action",
    "normalize_web_url",
    "resolve_action",
]
