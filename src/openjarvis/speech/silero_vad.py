"""Local Silero voice activity detection for streamed microphone buffers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List

from openjarvis.speech.audio_decode import decode_audio_bytes


@dataclass(frozen=True, slots=True)
class SpeechActivity:
    """Voice activity summary for the trailing edge of an audio buffer."""

    active: bool
    speech_seconds: float
    trailing_silence_seconds: float


class SileroVADDetector:
    """Load Silero VAD lazily and detect whether speech reaches the buffer tail."""

    def __init__(
        self,
        threshold: float,
        min_silence_ms: int,
    ) -> None:
        self._threshold = threshold
        self._min_silence_ms = min_silence_ms
        self._model: Any = None

    def _ensure_model(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from silero_vad import load_silero_vad
        except ImportError as exc:
            raise RuntimeError(
                "Silero VAD is not installed. Run: uv sync --extra speech"
            ) from exc
        self._model = load_silero_vad()
        return self._model

    def detect(self, audio: bytes, audio_format: str) -> SpeechActivity:
        """Return speech duration and whether speech is active at the buffer tail."""
        try:
            import torch
            from silero_vad import get_speech_timestamps
        except ImportError as exc:
            raise RuntimeError(
                "Silero VAD is not installed. Run: uv sync --extra speech"
            ) from exc

        try:
            decoded = decode_audio_bytes(audio, audio_format)
            waveform = torch.from_numpy(decoded)
            timestamps: List[dict[str, float]] = get_speech_timestamps(
                waveform,
                self._ensure_model(),
                threshold=self._threshold,
                min_silence_duration_ms=self._min_silence_ms,
                return_seconds=True,
            )
        except Exception as exc:
            raise RuntimeError(
                "Silero VAD could not analyze the streamed audio: "
                f"format={audio_format!r}, bytes={len(audio)}, error={exc}"
            ) from exc

        duration_seconds = float(waveform.shape[-1]) / 16000
        speech_seconds = sum(
            max(0.0, float(segment["end"]) - float(segment["start"]))
            for segment in timestamps
        )
        last_speech_end = (
            float(timestamps[-1]["end"]) if timestamps else 0.0
        )
        trailing_silence = max(0.0, duration_seconds - last_speech_end)
        return SpeechActivity(
            active=bool(timestamps) and trailing_silence < self._min_silence_ms / 1000,
            speech_seconds=speech_seconds,
            trailing_silence_seconds=trailing_silence,
        )
