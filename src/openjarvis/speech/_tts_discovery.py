"""Resolve configured text-to-speech backends with a local fallback."""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Iterator, List, Tuple

if TYPE_CHECKING:
    from openjarvis.core.config import JarvisConfig
    from openjarvis.speech.tts import TTSBackend, TTSResult

logger = logging.getLogger(__name__)


def _create_backend(
    backend_key: str,
    config: "JarvisConfig",
) -> "TTSBackend":
    """Create a configured TTS backend or raise an actionable error."""
    import openjarvis.speech  # noqa: F401
    from openjarvis.core.registry import TTSRegistry

    if not TTSRegistry.contains(backend_key):
        raise RuntimeError(
            f"TTS backend {backend_key!r} is not registered. "
            "Install the matching optional dependency."
        )

    backend_class = TTSRegistry.get(backend_key)
    if backend_key == "elevenlabs":
        api_key = os.environ.get("ELEVENLABS_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY is not configured for ElevenLabs TTS"
            )
        return backend_class(api_key=api_key)
    if backend_key == "kokoro":
        return backend_class(device=config.speech.device)
    return backend_class()


def _candidate_keys(config: "JarvisConfig", requested: str) -> List[str]:
    """Return the ordered TTS candidates for this request."""
    configured = requested if requested != "auto" else config.speech.tts_backend
    if configured == "auto":
        return ["elevenlabs", "kokoro"]
    if configured == "elevenlabs":
        return ["elevenlabs", "kokoro"]
    return [configured]


def synthesize_with_fallback(
    config: "JarvisConfig",
    *,
    text: str,
    requested_backend: str,
    voice_id: str,
    speed: float,
) -> Tuple[str, "TTSResult"]:
    """Synthesize speech, falling back from ElevenLabs to local Kokoro."""
    last_error: Exception | None = None
    for backend_key in _candidate_keys(config, requested_backend):
        try:
            backend = _create_backend(backend_key, config)
            resolved_voice = voice_id
            if not resolved_voice and backend_key == "kokoro":
                resolved_voice = "am_adam"
            result = backend.synthesize(
                text,
                voice_id=resolved_voice,
                speed=speed,
                output_format="mp3" if backend_key == "elevenlabs" else "wav",
            )
            return backend_key, result
        except Exception as exc:
            last_error = exc
            logger.warning(
                "TTS backend failed",
                extra={
                    "backend": backend_key,
                    "voice_id": voice_id,
                    "text_length": len(text),
                    "error": str(exc),
                },
            )

    if last_error is None:
        raise RuntimeError("No TTS backend candidates were configured")
    raise RuntimeError(
        "All configured TTS backends failed. "
        f"requested_backend={requested_backend!r}, last_error={last_error}"
    ) from last_error


def stream_with_fallback(
    config: "JarvisConfig",
    *,
    text: str,
    requested_backend: str,
    voice_id: str,
    speed: float,
) -> Tuple[str, str, str, Iterator[bytes]]:
    """Open streaming ElevenLabs audio or return one local Kokoro WAV chunk."""
    last_error: Exception | None = None
    for backend_key in _candidate_keys(config, requested_backend):
        try:
            backend = _create_backend(backend_key, config)
            if backend_key == "elevenlabs":
                resolved_voice, chunks = backend.stream_synthesize(
                    text,
                    voice_id=voice_id,
                    speed=speed,
                )
                return backend_key, "mp3", resolved_voice, chunks

            resolved_voice = voice_id or "am_adam"
            result = backend.synthesize(
                text,
                voice_id=resolved_voice,
                speed=speed,
                output_format="wav",
            )
            return backend_key, result.format, result.voice_id, iter([result.audio])
        except Exception as exc:
            last_error = exc
            logger.warning(
                "Streaming TTS backend failed",
                extra={
                    "backend": backend_key,
                    "voice_id": voice_id,
                    "text_length": len(text),
                    "error": str(exc),
                },
            )

    if last_error is None:
        raise RuntimeError("No streaming TTS backend candidates were configured")
    raise RuntimeError(
        "All configured streaming TTS backends failed. "
        f"requested_backend={requested_backend!r}, last_error={last_error}"
    ) from last_error
