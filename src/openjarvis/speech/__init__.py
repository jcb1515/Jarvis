"""Speech subsystem — speech-to-text and text-to-speech backends."""

import importlib

# Optional STT backends — each registers itself via @SpeechRegistry.register()
for _mod in ("local_whisper", "faster_whisper", "openai_whisper", "deepgram"):
    try:
        importlib.import_module(f".{_mod}", __name__)
    except ImportError:
        pass

# Optional TTS backends — each registers itself via @TTSRegistry.register()
for _mod in ("elevenlabs_tts", "cartesia_tts", "kokoro_tts", "openai_tts"):
    try:
        importlib.import_module(f".{_mod}", __name__)
    except ImportError:
        pass
