"""Local speech-to-text using OpenAI's open-source Whisper repository."""

from __future__ import annotations

import logging
import math
import threading
from typing import Any, Dict, List, Optional

from openjarvis.core.registry import SpeechRegistry
from openjarvis.speech._stubs import Segment, SpeechBackend, TranscriptionResult
from openjarvis.speech.audio_decode import (
    decode_audio_bytes,
    get_bundled_ffmpeg_executable,
)

try:
    import whisper
except ImportError:
    whisper = None  # type: ignore[assignment]

try:
    import torch
except ImportError:
    torch = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


def _segment_confidence(segment: Dict[str, Any]) -> Optional[float]:
    """Convert Whisper's average log probability into a bounded confidence."""
    raw_value = segment.get("avg_logprob")
    if not isinstance(raw_value, (float, int)):
        return None
    return max(0.0, min(1.0, math.exp(float(raw_value))))


@SpeechRegistry.register("whisper")
class LocalWhisperBackend(SpeechBackend):
    """Run OpenAI Whisper locally with no transcription API dependency."""

    backend_id = "whisper"

    def __init__(self, model_size: str = "base", device: str = "auto") -> None:
        self._model_size = model_size
        self._device = device
        self._model: Optional[Any] = None
        self._resolved_device = ""
        self._last_error: Optional[str] = None
        self._model_lock = threading.Lock()
        self._transcription_lock = threading.Lock()

    def _resolve_device(self) -> str:
        """Resolve the configured device without mutating global torch state."""
        if self._device != "auto":
            return self._device
        if torch is not None and bool(torch.cuda.is_available()):
            return "cuda"
        return "cpu"

    def _ensure_model(self) -> Any:
        """Lazy-load the configured Whisper model on first use."""
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            if whisper is None:
                self._last_error = (
                    "OpenAI Whisper is not installed. Run: uv sync --extra speech"
                )
                raise ImportError(self._last_error)

            self._resolved_device = self._resolve_device()
            try:
                self._model = whisper.load_model(
                    self._model_size,
                    device=self._resolved_device,
                )
            except Exception as exc:
                self._last_error = (
                    f"Could not load OpenAI Whisper model {self._model_size!r} "
                    f"on device {self._resolved_device!r}: {exc}"
                )
                raise RuntimeError(self._last_error) from exc

        self._last_error = None
        return self._model

    def transcribe(
        self,
        audio: bytes,
        *,
        format: str = "wav",
        language: Optional[str] = None,
    ) -> TranscriptionResult:
        """Transcribe audio bytes with the local OpenAI Whisper model."""
        with self._transcription_lock:
            model = self._ensure_model()
            normalized_format = format.lower().lstrip(".")

            try:
                waveform = decode_audio_bytes(audio, normalized_format)
                if waveform.size < 1600:
                    raise ValueError(
                        "Decoded microphone audio is too short for Whisper: "
                        f"samples={waveform.size}, minimum_samples=1600, "
                        "sample_rate=16000"
                    )
                options: Dict[str, Any] = {
                    "fp16": self._resolved_device == "cuda",
                    "verbose": False,
                }
                if language:
                    options["language"] = language
                raw_result = model.transcribe(waveform, **options)
            except Exception as exc:
                self._last_error = (
                    f"OpenAI Whisper transcription failed for "
                    f"{normalized_format!r} audio "
                    f"with model {self._model_size!r}: {exc}"
                )
                raise RuntimeError(self._last_error) from exc

            raw_segments = raw_result.get("segments", [])
            segments = [
                Segment(
                    text=str(segment.get("text", "")).strip(),
                    start=float(segment.get("start", 0.0)),
                    end=float(segment.get("end", 0.0)),
                    confidence=_segment_confidence(segment),
                )
                for segment in raw_segments
                if isinstance(segment, dict)
            ]
            duration = max((segment.end for segment in segments), default=0.0)

            self._last_error = None
            return TranscriptionResult(
                text=str(raw_result.get("text", "")).strip(),
                language=raw_result.get("language"),
                confidence=None,
                duration_seconds=duration,
                segments=segments,
            )

    def health(self) -> bool:
        """Return whether the local Whisper model can be loaded."""
        try:
            get_bundled_ffmpeg_executable()
            self._ensure_model()
            return True
        except Exception as exc:
            self._last_error = str(exc)
            logger.warning(
                "Local OpenAI Whisper health check failed",
                extra={
                    "model": self._model_size,
                    "device": self._device,
                    "error": str(exc),
                },
            )
            return False

    def last_error(self) -> Optional[str]:
        """Return the most recent model-load or transcription error."""
        return self._last_error

    def supported_formats(self) -> List[str]:
        """Return formats supported through the bundled FFmpeg decoder."""
        return ["wav", "mp3", "m4a", "ogg", "flac", "webm"]
