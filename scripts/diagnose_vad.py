"""Print raw Silero probability and silence timing for one audio file."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from openjarvis.speech.audio_decode import decode_audio_bytes
from openjarvis.speech.silero_vad import (
    SILERO_SAMPLE_RATE,
    SILERO_WINDOW_SAMPLES,
    SileroStreamingVAD,
)


def parse_args() -> argparse.Namespace:
    """Parse the diagnostic input path and detector timing."""
    parser = argparse.ArgumentParser(
        description=(
            "Run the standalone 16 kHz streaming Silero path without "
            "Whisper, the agent, or TTS."
        )
    )
    parser.add_argument("audio", type=Path)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--min-speech-ms", type=int, default=96)
    parser.add_argument("--min-silence-ms", type=int, default=1000)
    return parser.parse_args()


def pcm_bytes_from_file(audio_path: Path) -> bytes:
    """Decode an audio file to mono 16 kHz little-endian signed-int16 PCM."""
    if not audio_path.is_file():
        raise FileNotFoundError(f"VAD diagnostic audio does not exist: {audio_path}")
    audio_format = audio_path.suffix.lower().lstrip(".")
    waveform = decode_audio_bytes(audio_path.read_bytes(), audio_format)
    pcm = np.clip(waveform * 32768.0, -32768, 32767).astype("<i2")
    return pcm.tobytes()


def print_diagnostic(
    pcm_bytes: bytes,
    threshold: float,
    min_speech_ms: int,
    min_silence_ms: int,
) -> None:
    """Feed exact model windows and print every raw detector result."""
    detector = SileroStreamingVAD(
        threshold=threshold,
        min_silence_ms=min_silence_ms,
        min_speech_ms=min_speech_ms,
    )
    window_bytes = SILERO_WINDOW_SAMPLES * np.dtype(np.int16).itemsize
    print(
        "time_s probability rms_dbfs active observed silence_ms should_stop",
        flush=True,
    )
    for offset in range(0, len(pcm_bytes), window_bytes):
        frame = pcm_bytes[offset : offset + window_bytes]
        if len(frame) < window_bytes:
            break
        activity = detector.process(frame)
        elapsed_seconds = activity.processed_samples / SILERO_SAMPLE_RATE
        print(
            f"{elapsed_seconds:6.3f} "
            f"{activity.probability:11.6f} "
            f"{activity.rms_dbfs:8.2f} "
            f"{str(activity.speech_active):>6} "
            f"{str(activity.speech_observed):>8} "
            f"{activity.trailing_silence_ms:10d} "
            f"{str(activity.should_stop):>11}",
            flush=True,
        )


def main() -> None:
    """Run the standalone VAD diagnostic."""
    args = parse_args()
    print_diagnostic(
        pcm_bytes=pcm_bytes_from_file(args.audio),
        threshold=args.threshold,
        min_speech_ms=args.min_speech_ms,
        min_silence_ms=args.min_silence_ms,
    )


if __name__ == "__main__":
    main()
