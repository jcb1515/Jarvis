"""Local openWakeWord detection for signed 16-bit 16 kHz PCM audio."""

from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Any

import numpy as np


@dataclass(frozen=True, slots=True)
class WakeWordPrediction:
    """A single wake-word model prediction."""

    detected: bool
    score: float


class OpenWakeWordDetector:
    """Lazy connector around the openWakeWord ONNX runtime."""

    def __init__(
        self,
        model_name: str,
        threshold: float,
        vad_threshold: float,
    ) -> None:
        if not 0 < threshold <= 1:
            raise ValueError(
                f"Wake-word threshold must be in (0, 1], received {threshold}"
            )
        if not 0 <= vad_threshold <= 1:
            raise ValueError(
                "Wake-word VAD threshold must be in [0, 1], "
                f"received {vad_threshold}"
            )
        self._model_name = model_name
        self._threshold = threshold
        self._vad_threshold = vad_threshold
        self._model: Any = None
        self._lock = Lock()

    def _ensure_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            try:
                import openwakeword
                from openwakeword.model import Model
            except ImportError as exc:
                raise RuntimeError(
                    "openWakeWord is not installed. Run: "
                    "uv sync --extra desktop"
                ) from exc
            try:
                openwakeword.utils.download_models(
                    [self._model_name.replace(" ", "_")]
                )
                self._model = Model(
                    wakeword_models=[self._model_name],
                    vad_threshold=self._vad_threshold,
                    inference_framework="onnx",
                )
            except Exception as exc:
                raise RuntimeError(
                    "Could not initialize the local wake-word model: "
                    f"model={self._model_name!r}, framework='onnx', error={exc}"
                ) from exc
        return self._model

    def predict(self, pcm_audio: bytes) -> WakeWordPrediction:
        """Predict whether a PCM frame contains the configured wake phrase."""
        if not pcm_audio:
            raise ValueError("Wake-word PCM frame cannot be empty")
        if len(pcm_audio) % 2 != 0:
            raise ValueError(
                "Wake-word PCM frame must contain complete int16 samples: "
                f"bytes={len(pcm_audio)}"
            )
        samples = np.frombuffer(pcm_audio, dtype=np.int16)
        if samples.size < 400:
            raise ValueError(
                "Wake-word PCM frame is too short: "
                f"samples={samples.size}, minimum=400"
            )
        try:
            predictions = self._ensure_model().predict(samples)
        except Exception as exc:
            raise RuntimeError(
                "Local wake-word inference failed: "
                f"model={self._model_name!r}, samples={samples.size}, error={exc}"
            ) from exc
        score = max((float(value) for value in predictions.values()), default=0.0)
        return WakeWordPrediction(
            detected=score >= self._threshold,
            score=score,
        )

    def prepare(self) -> None:
        """Download and load the configured model before audio is accepted."""
        self._ensure_model()

    def reset(self) -> None:
        """Reset streaming feature buffers after a pause or detection."""
        if self._model is None:
            return
        with self._lock:
            self._model.reset()
