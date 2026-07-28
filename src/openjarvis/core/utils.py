"""Small cross-platform utilities used by the CLI, OAuth flow, and evals.

Kept dependency-free so importing this module is cheap (the public re-export
from ``openjarvis.core`` must not pull in heavy modules at package init).
"""

from __future__ import annotations

import os
import platform
import shutil
import webbrowser


def get_python_executable() -> str:
    """Return the best ``python`` interpreter name on PATH.

    Prefers ``python3`` (Linux/macOS convention); falls back to ``python``
    (Windows / some minimal Linux distros that ship only ``python``). Returns
    the literal string ``"python3"`` when neither is found, so callers still
    get a usable command that will fail with a clear "command not found"
    rather than an empty string.

    The result is a *command name or absolute path* that callers can hand to
    :mod:`subprocess` directly when ``shell=False``, and must be shell-quoted
    (:func:`shlex.quote`) before being interpolated into a ``shell=True``
    command string — paths on Windows often contain spaces.
    """
    return shutil.which("python3") or shutil.which("python") or "python3"


def open_browser(url: str) -> None:
    """Open *url* in the user's default browser.

    Windows uses :func:`os.startfile` so URL query delimiters are passed to the
    shell as data instead of being interpreted by ``cmd.exe``.
    """
    if platform.system() == "Windows":
        os.startfile(url)  # type: ignore[attr-defined]
        return
    if not webbrowser.open(url):
        raise RuntimeError(f"Default browser refused to open URL: {url}")


__all__ = ["get_python_executable", "open_browser"]
