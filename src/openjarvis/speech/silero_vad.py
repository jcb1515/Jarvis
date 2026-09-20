"""Local Silero voice activity detection for files and streamed PCM."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any, List

import numpy as np

from openjarvis.speech.audio_decode import decode_audio_bytes

logger = logging.getLogger(__name__)

SILERO_SAMPLE_RATE = 16000
SILERO_WINDOW_SAMPLES = 512


@dataclass(frozen=True, slots=True)
class SpeechActivity:
    """Voice activity summary for the trailing edge of an audio buffer."""

    active: bool
    speech_seconds: float
    trailing_silence_seconds: float


@dataclass(frozen=True, slots=True)
class StreamingSpeechActivity:
    """Raw probability and trailing-silence state for streamed PCM."""

    probability: float
    rms_dbfs: float
    speech_active: bool
    speech_observed: bool
    trailing_silence_ms: int
    should_stop: bool
    processed_samples: int


class SileroStreamingVAD:
    """Process mono 16 kHz signed-int16 PCM in exact Silero windows."""

    def __init__(
        self,
        threshold: float,
        min_silence_ms: int,
        min_speech_ms: int,
    ) -> None:
        if not 0 < threshold < 1:
            raise ValueError(
                f"VAD threshold must be between 0 and 1: threshold={threshold}"
            )
        if min_silence_ms <= 0:
            raise ValueError(
                f"VAD minimum silence must be positive: min_silence_ms={min_silence_ms}"
            )
        if min_speech_ms <= 0:
            raise ValueError(
                f"VAD minimum speech must be positive: min_speech_ms={min_speech_ms}"
            )
        self._threshold = threshold
        self._release_threshold = max(0.01, threshold - 0.15)
        self._min_silence_samples = round(min_silence_ms * SILERO_SAMPLE_RATE / 1000)
        self._min_speech_windows = max(
            1,
            math.ceil(
                min_speech_ms * SILERO_SAMPLE_RATE / 1000 / SILERO_WINDOW_SAMPLES
            ),
        )
        self._model: Any = None
        self.reset()

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

    def reset(self) -> None:
        """Reset model history and all timing counters."""
        if self._model is not None:
            self._model.reset_states()
        self._pending = np.empty(0, dtype=np.int16)
        self._processed_samples = 0
        self._speech_candidate_windows = 0
        self._speech_observed = False
        self._speech_active = False
        self._silence_samples = 0
        self._last_probability = 0.0
        self._last_rms_dbfs = -120.0

    def _activity(self) -> StreamingSpeechActivity:
        trailing_silence_ms = round(self._silence_samples * 1000 / SILERO_SAMPLE_RATE)
        return StreamingSpeechActivity(
            probability=self._last_probability,
            rms_dbfs=self._last_rms_dbfs,
            speech_active=self._speech_active,
            speech_observed=self._speech_observed,
            trailing_silence_ms=trailing_silence_ms,
            should_stop=(
                self._speech_observed
                and self._silence_samples >= self._min_silence_samples
            ),
            processed_samples=self._processed_samples,
        )

    def process(self, pcm_bytes: bytes) -> StreamingSpeechActivity:
        """Consume little-endian PCM and return the latest streaming state."""
        if not pcm_bytes:
            raise ValueError("Silero VAD received an empty PCM frame")
        if len(pcm_bytes) % np.dtype(np.int16).itemsize != 0:
            raise ValueError(
                "Silero VAD PCM byte length must be divisible by two: "
                f"bytes={len(pcm_bytes)}"
            )

        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(
            np.int16,
            copy=True,
        )
        self._pending = np.concatenate((self._pending, samples))
        try:
            import torch
        except ImportError as exc:
            raise RuntimeError(
                "Silero VAD is not installed. Run: uv sync --extra speech"
            ) from exc

        model = self._ensure_model()
        while self._pending.size >= SILERO_WINDOW_SAMPLES:
            window = self._pending[:SILERO_WINDOW_SAMPLES]
            self._pending = self._pending[SILERO_WINDOW_SAMPLES:]
            waveform = window.astype(np.float32) / 32768.0
            self._last_probability = float(
                model(torch.from_numpy(waveform), SILERO_SAMPLE_RATE).item()
            )
            rms = float(np.sqrt(np.mean(np.square(waveform))))
            self._last_rms_dbfs = 20 * math.log10(max(rms, 1e-6)) if rms > 0 else -120.0
            self._processed_samples += SILERO_WINDOW_SAMPLES

            if not self._speech_observed:
                if self._last_probability >= self._threshold:
                    self._speech_candidate_windows += 1
                    if self._speech_candidate_windows >= self._min_speech_windows:
                        self._speech_observed = True
                        self._speech_active = True
                        self._silence_samples = 0
                else:
                    self._speech_candidate_windows = 0
            elif self._last_probability >= self._release_threshold:
                self._speech_active = True
                self._silence_samples = 0
            else:
                self._speech_active = False
                self._silence_samples += SILERO_WINDOW_SAMPLES

        activity = self._activity()
        logger.debug(
            "Silero VAD frame processed",
            extra={
                "probability": round(activity.probability, 6),
                "rms_dbfs": round(activity.rms_dbfs, 2),
                "speech_active": activity.speech_active,
                "speech_observed": activity.speech_observed,
                "trailing_silence_ms": activity.trailing_silence_ms,
                "should_stop": activity.should_stop,
                "processed_samples": activity.processed_samples,
            },
        )
        return activity


class SileroVADDetector:
    """Load Silero VAD lazily and detect whether speech reaches a file tail."""

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

        duration_seconds = float(waveform.shape[-1]) / SILERO_SAMPLE_RATE
        speech_seconds = sum(
            max(0.0, float(segment["end"]) - float(segment["start"]))
            for segment in timestamps
        )
        last_speech_end = float(timestamps[-1]["end"]) if timestamps else 0.0
        trailing_silence = max(0.0, duration_seconds - last_speech_end)
        return SpeechActivity(
            active=bool(timestamps) and trailing_silence < self._min_silence_ms / 1000,
            speech_seconds=speech_seconds,
            trailing_silence_seconds=trailing_silence,
        )


__all__ = [
    "SILERO_SAMPLE_RATE",
    "SILERO_WINDOW_SAMPLES",
    "SileroStreamingVAD",
    "SileroVADDetector",
    "SpeechActivity",
    "StreamingSpeechActivity",
]
