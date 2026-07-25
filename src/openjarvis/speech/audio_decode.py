"""Decode browser and file audio into Whisper-compatible PCM."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_SUPPORTED_FORMATS = frozenset({"wav", "mp3", "m4a", "ogg", "flac", "webm"})


def get_bundled_ffmpeg_executable() -> str:
    """Return the FFmpeg binary supplied by the project speech dependency."""
    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise RuntimeError(
            "The project-local FFmpeg runtime is not installed. "
            "Run: uv sync --extra speech"
        ) from exc

    executable = imageio_ffmpeg.get_ffmpeg_exe()
    if not executable or not Path(executable).is_file():
        raise RuntimeError(
            "imageio-ffmpeg did not provide a usable FFmpeg executable: "
            f"path={executable!r}"
        )
    return executable


def decode_audio_bytes(audio: bytes, audio_format: str) -> np.ndarray:
    """Decode encoded audio bytes to mono 16 kHz float32 PCM."""
    if not audio:
        raise ValueError("Cannot decode an empty audio buffer")

    normalized_format = audio_format.lower().lstrip(".")
    if normalized_format not in _SUPPORTED_FORMATS:
        raise ValueError(
            f"Unsupported audio format {audio_format!r}; "
            f"expected one of {sorted(_SUPPORTED_FORMATS)}"
        )

    temp_audio = tempfile.NamedTemporaryFile(
        suffix=f".{normalized_format}",
        delete=False,
    )
    try:
        with temp_audio:
            temp_audio.write(audio)

        command = [
            get_bundled_ffmpeg_executable(),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            temp_audio.name,
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-",
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            timeout=120,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(
                "Project-local FFmpeg could not decode audio: "
                f"format={normalized_format!r}, bytes={len(audio)}, "
                f"returncode={completed.returncode}, stderr={stderr[:2000]!r}"
            )
        if not completed.stdout:
            raise RuntimeError(
                "Project-local FFmpeg returned no PCM audio: "
                f"format={normalized_format!r}, bytes={len(audio)}"
            )

        pcm = np.frombuffer(completed.stdout, dtype=np.int16)
        return pcm.astype(np.float32) / 32768.0
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            "Project-local FFmpeg timed out while decoding audio: "
            f"format={normalized_format!r}, bytes={len(audio)}, timeout=120"
        ) from exc
    finally:
        try:
            os.unlink(temp_audio.name)
        except OSError as exc:
            logger.warning(
                "Could not remove temporary decoded audio input",
                extra={"path": temp_audio.name, "error": str(exc)},
            )


__all__ = ["decode_audio_bytes", "get_bundled_ffmpeg_executable"]
