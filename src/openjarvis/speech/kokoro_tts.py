"""Kokoro TTS backend — fully open-source, runs locally.

Requires the kokoro package: pip install kokoro
Falls back gracefully if not installed.
"""

from __future__ import annotations

import importlib.util
import io
import threading
from typing import Any, List

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult


def _english_language_code(voice_id: str) -> str:
    """Resolve Kokoro's English pipeline from the configured voice prefix."""
    if voice_id.startswith(("af_", "am_")):
        return "a"
    if voice_id.startswith(("bf_", "bm_")):
        return "b"
    raise ValueError(
        "Kokoro voice must use an English voice prefix "
        f"('af_', 'am_', 'bf_', or 'bm_'): voice_id={voice_id!r}"
    )


@TTSRegistry.register("kokoro")
class KokoroTTSBackend(TTSBackend):
    """Kokoro TTS — local open-source voice synthesis."""

    backend_id = "kokoro"

    def __init__(self, *, model_path: str = "", device: str = "auto") -> None:
        self._model_path = model_path
        self._device = device
        self._pipeline: Any | None = None
        self._language_code: str | None = None
        self._lock = threading.RLock()

    def _ensure_pipeline(self, voice_id: str) -> None:
        language_code = _english_language_code(voice_id)
        if self._pipeline is not None and self._language_code == language_code:
            return
        try:
            from kokoro import KPipeline

            device = None if self._device == "auto" else self._device
            self._pipeline = KPipeline(
                lang_code=language_code,
                repo_id="hexgrad/Kokoro-82M",
                device=device,
            )
            self._language_code = language_code
        except ImportError as exc:
            raise RuntimeError(
                "kokoro package not installed. Install with: pip install kokoro"
            ) from exc
        except SystemExit as exc:
            raise RuntimeError(
                "Kokoro could not initialize its English language pipeline. "
                "Install the spaCy model en_core_web_sm in the project environment."
            ) from exc

    def warm(self, voice_id: str) -> None:
        """Load the configured language pipeline and voice into memory."""
        with self._lock:
            self._ensure_pipeline(voice_id)
            self._pipeline.load_voice(voice_id)

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "af_heart",
        speed: float = 1.0,
        output_format: str = "wav",
    ) -> TTSResult:
        with self._lock:
            self._ensure_pipeline(voice_id)
            import numpy as np
            import soundfile as sf

            samples = [
                audio
                for _, _, audio in self._pipeline(
                    text,
                    voice=voice_id,
                    speed=speed,
                )
            ]

        if not samples:
            return TTSResult(audio=b"", format=output_format, voice_id=voice_id)

        combined = np.concatenate(samples)
        buf = io.BytesIO()
        sf.write(buf, combined, 24000, format=output_format.upper())
        buf.seek(0)

        return TTSResult(
            audio=buf.read(),
            format=output_format,
            voice_id=voice_id,
            sample_rate=24000,
            duration_seconds=len(combined) / 24000,
            metadata={"backend": "kokoro"},
        )

    def available_voices(self) -> List[str]:
        return [
            "af_heart",
            "af_bella",
            "am_adam",
            "am_michael",
            "bf_emma",
            "bf_isabella",
            "bm_daniel",
            "bm_george",
            "bm_lewis",
        ]

    def health(self) -> bool:
        """Report package availability without downloading models."""
        return importlib.util.find_spec("kokoro") is not None
