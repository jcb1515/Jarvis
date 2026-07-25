"""ElevenLabs streaming text-to-speech backend."""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult

logger = logging.getLogger(__name__)

_DEFAULT_MODEL_ID = "eleven_multilingual_v2"
_OUTPUT_FORMAT = "mp3_44100_128"
_VOICE_SEARCH_TERMS = (
    "british",
    "baritone",
    "articulate",
    "crisp",
    "authoritative",
    "calm",
    "professional",
    "male",
)


@TTSRegistry.register("elevenlabs")
class ElevenLabsTTSBackend(TTSBackend):
    """Stream JARVIS speech from ElevenLabs with bounded retries."""

    backend_id = "elevenlabs"

    def __init__(
        self,
        *,
        api_key: str = "",
        model_id: str = _DEFAULT_MODEL_ID,
        timeout_seconds: float = 60.0,
    ) -> None:
        self._api_key = api_key or os.environ.get("ELEVENLABS_API_KEY", "")
        self._model_id = model_id
        self._timeout_seconds = timeout_seconds
        self._resolved_voice_id = ""

    @staticmethod
    def _voice_score(voice: Dict[str, Any]) -> int:
        """Rank account voices for an original British AI-assistant delivery."""
        raw_labels = voice.get("labels", {})
        labels = {
            str(key).lower(): str(value).lower()
            for key, value in raw_labels.items()
        }
        searchable = " ".join(
            [
                str(voice.get("name", "")),
                str(voice.get("description", "")),
                " ".join(f"{key} {value}" for key, value in labels.items()),
            ]
        ).lower()
        score = sum(1 for term in _VOICE_SEARCH_TERMS if term in searchable)
        if labels.get("accent") == "british":
            score += 8
        if labels.get("gender") == "male":
            score += 7
        if labels.get("age") in {"middle_aged", "old"}:
            score += 2
        if labels.get("descriptive") in {
            "formal",
            "professional",
            "calm",
            "crisp",
            "classy",
        }:
            score += 4
        return score

    def _find_jarvis_voice(self, client: httpx.Client) -> str:
        """Choose the closest available calm British male voice for this account."""
        if self._resolved_voice_id:
            return self._resolved_voice_id

        configured_voice = os.environ.get("ELEVENLABS_VOICE_ID", "")
        if configured_voice:
            self._resolved_voice_id = configured_voice
            return configured_voice

        response = client.get(
            "https://api.elevenlabs.io/v2/voices",
            params={"page_size": 100},
            headers={"xi-api-key": self._api_key},
        )
        if response.status_code >= 400:
            raise RuntimeError(
                "ElevenLabs voice discovery failed: "
                f"status={response.status_code}, body={response.text[:1000]!r}"
            )
        voices = response.json().get("voices", [])
        if not voices:
            raise RuntimeError(
                "ElevenLabs returned no available voices. Add a voice in My Voices "
                "or set ELEVENLABS_VOICE_ID."
            )
        ranked = sorted(voices, key=self._voice_score, reverse=True)
        resolved = str(ranked[0].get("voice_id", ""))
        if not resolved:
            raise RuntimeError(
                "ElevenLabs voice discovery returned a voice without an ID"
            )
        self._resolved_voice_id = resolved
        logger.info(
            "Selected ElevenLabs assistant voice",
            extra={
                "voice_id": resolved,
                "voice_name": ranked[0].get("name", ""),
                "voice_score": self._voice_score(ranked[0]),
            },
        )
        return resolved

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "",
        speed: float = 1.0,
        output_format: str = "mp3",
    ) -> TTSResult:
        """Generate MP3 speech using ElevenLabs' streaming HTTP endpoint."""
        if not self._api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY is not configured for ElevenLabs TTS"
            )
        if output_format != "mp3":
            raise ValueError(
                "ElevenLabsTTSBackend currently supports output_format='mp3' only"
            )

        resolved_voice, chunks = self.stream_synthesize(
            text,
            voice_id=voice_id,
            speed=speed,
        )
        return TTSResult(
            audio=b"".join(chunks),
            format="mp3",
            voice_id=resolved_voice,
            sample_rate=44100,
            metadata={
                "backend": self.backend_id,
                "model_id": self._model_id,
                "streaming_endpoint": True,
            },
        )

    def stream_synthesize(
        self,
        text: str,
        *,
        voice_id: str,
        speed: float,
    ) -> Tuple[str, Iterator[bytes]]:
        """Open ElevenLabs' response stream before returning its audio chunks."""
        if not self._api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY is not configured for ElevenLabs TTS"
            )

        client = httpx.Client(timeout=self._timeout_seconds)
        resolved_voice = voice_id or self._find_jarvis_voice(client)
        url = (
            "https://api.elevenlabs.io/v1/text-to-speech/"
            f"{resolved_voice}/stream"
        )
        request = client.build_request(
            "POST",
            url,
            params={"output_format": _OUTPUT_FORMAT},
            json={
                "text": text,
                "model_id": self._model_id,
                "voice_settings": {
                    "stability": 0.72,
                    "similarity_boost": 0.8,
                    "style": 0.08,
                    "use_speaker_boost": True,
                    "speed": speed,
                },
            },
            headers={
                "xi-api-key": self._api_key,
                "Content-Type": "application/json",
            },
        )
        last_error: Optional[Exception] = None
        response: Optional[httpx.Response] = None
        for attempt in range(1, 4):
            try:
                response = client.send(request, stream=True)
                if response.status_code >= 400:
                    response.read()
                    body = response.text[:1000]
                    response.close()
                    raise RuntimeError(
                        "ElevenLabs TTS request failed: "
                        f"status={response.status_code}, "
                        f"voice_id={resolved_voice!r}, "
                        f"model_id={self._model_id!r}, body={body!r}"
                    )
                break
            except (httpx.HTTPError, RuntimeError) as exc:
                last_error = exc
                logger.warning(
                    "ElevenLabs TTS attempt failed",
                    extra={
                        "attempt": attempt,
                        "voice_id": resolved_voice,
                        "model_id": self._model_id,
                        "error": str(exc),
                    },
                )
                if attempt < 3:
                    time.sleep(0.25 * attempt)

        if response is None or response.status_code >= 400:
            client.close()
            if last_error is None:
                raise RuntimeError(
                    "ElevenLabs TTS failed without an error response"
                )
            raise last_error

        def iter_audio() -> Iterator[bytes]:
            try:
                yield from response.iter_bytes()
            finally:
                response.close()
                client.close()

        return resolved_voice, iter_audio()

    def available_voices(self) -> List[str]:
        """Return the configured voice or the automatic selector marker."""
        configured_voice = os.environ.get("ELEVENLABS_VOICE_ID", "")
        return [configured_voice] if configured_voice else ["auto:jarvis-inspired"]

    def health(self) -> bool:
        """Return whether the required API key is configured."""
        return bool(self._api_key)
