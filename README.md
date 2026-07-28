# Astrono Jarvis

A voice-first, locally operated AI command console built on
[OpenJarvis](https://github.com/open-jarvis/OpenJarvis).

![JARVIS console reference](design/jarvis-console-reference.png)

Astrono Jarvis combines a local Qwen 3.5 agent through Ollama, optimized local
Whisper speech recognition, high-quality ElevenLabs speech, a local Kokoro voice
fallback, and confirmation-gated MCP tools in one desktop-ready interface.

## What is implemented

- Hold-to-talk microphone capture with `Space` or the on-screen control.
- Local transcription through `faster-whisper` using the `small` English model
  with CPU `int8` inference. The official
  [openai/whisper](https://github.com/openai/whisper) backend remains available.
- Always-on local "Hey Jarvis" activation through openWakeWord's pretrained
  ONNX model, with no wake-word API key or usage fee.
- Acoustic echo cancellation plus hard wake-listener gating while JARVIS is
  listening, thinking, or speaking, preventing self-reactivation.
- A 12-second post-response conversation window that accepts a follow-up
  without repeating "Hey Jarvis", then returns to the normal wake-word state.
- Automatic silence handoff through a dedicated 16 kHz PCM Silero VAD stream,
  with raw probability, input-level, and elapsed-silence diagnostics. Hold-Space
  and microphone push-to-talk remain deterministic fallbacks.
- Live hearing and thinking timers synchronized through backend WebSocket state
  transitions.
- A full-screen React Three Fiber astronomy interface:
  - persistent depth-aware starfield;
  - separate live microphone spectrum bar;
  - shader-driven black-hole and solar-system modes, including differential
    accretion flow with faster inner material and layered plasma turbulence;
  - a continuously replenishing gravity field that spirals stars into the
    black hole in every assistant state;
  - a smoothly accelerated capture rate while the single THINKING phase is
    active;
  - a damped visual crossfade from the faster thinking disk into
    audio-reactive speaking jets;
  - speech-reactive outward jets or solar flares.
- A unified phase label such as `THINKING, 1.2s`, keeping state and elapsed
  time on one synchronized line.
- Persistent `INSTANT` and `THINKING` controls. Request-level phrases such as
  "think carefully about this" enable Qwen reasoning for that request only;
  reasoning streams into a collapsible panel and is never spoken as the answer.
- Streaming OpenJarvis agent and tool events.
- Immediate ElevenLabs audio streaming with native playback-state events,
  explicit Web Audio context resume checks, and progress-based stall recovery
  that does not truncate healthy long responses.
- ElevenLabs voice selection tuned toward a calm, articulate British
  AI-assistant character.
- Automatic local Kokoro TTS fallback when ElevenLabs is unavailable.
- MCP tool safety classification: read operations can run directly; browser,
  filesystem, note, and other write-like operations require confirmation.
- A live approval queue with approve and deny actions.
- Deterministic Chrome navigation for explicit `http://` and `https://`
  commands, independent from the tool-less conversation agent.
- Strict daily-brief reads from `Morning Brief/Daily Briefs` through Obsidian
  MCP, plus approval-gated durable context in `Jarvis/context.md`.
- Local Google Workspace tools for Gmail and Calendar reads and
  confirmation-gated writes.
- Typed-command fallback and a responsive monochrome astronomical console.

The ElevenLabs profile is intentionally an original, JARVIS-inspired delivery.
It does not clone or claim to reproduce a film actor's voice.

## Requirements

- Windows 10/11, macOS, or Linux
- Python 3.10–3.13
- Node.js 20+
- [uv](https://docs.astral.sh/uv/)
- [Ollama](https://ollama.com/) with the configured `qwen3.5:4b` model
- Rust's `x86_64-pc-windows-msvc` target, `cargo-xwin`, and LLVM-MinGW UCRT are
  required only when building the Windows desktop installer. This avoids a
  machine-wide Visual Studio Build Tools dependency.
- No system FFmpeg install is required; the speech extra installs a
  project-local FFmpeg binary through `imageio-ffmpeg`.

An NVIDIA GPU and hosted language-model API key are not required. The default
Whisper configuration runs on CPU.

## Setup

```powershell
git clone https://github.com/jcb1515/Jarvis.git
cd Jarvis
uv sync --extra desktop --extra speech-faster
uv pip install --python .venv/Scripts/python.exe https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
Copy-Item .env.example .env
Copy-Item configs/jarvis-assistant.toml "$HOME/.openjarvis/config.toml"
ollama pull qwen3.5:4b
cd frontend
npm install
```

The desktop extra installs Whisper directly from the pinned official GitHub
revision in `pyproject.toml`; `speech-faster` installs the optimized active
backend. Both use the project-local FFmpeg runtime for WAV, MP3, and browser
WebM decoding. No transcription API key or per-minute fee is required. The
configured model is downloaded once on first use and cached locally.

Add ElevenLabs to `.env` if you want the primary cloud voice:

```dotenv
ELEVENLABS_API_KEY=your_key_here
# Optional: force a voice from ElevenLabs "My Voices".
ELEVENLABS_VOICE_ID=
```

Without an ElevenLabs key, speech synthesis uses the local Kokoro backend.
The configured agent model is `qwen3.5:4b`, served entirely by Ollama on the
local machine.

The sample MCP list connects directly to Obsidian Local REST API's built-in
MCP endpoint. Its default HTTPS endpoint uses a self-signed certificate, so
TLS verification is disabled only for this loopback connection. Set the three
`OBSIDIAN_*` values before starting JARVIS.

## Run

Start the local backend from the repository root:

```powershell
$env:OPENJARVIS_CONFIG="$PWD/configs/jarvis-assistant.toml"
uv run --env-file .env jarvis serve
```

In another terminal:

```powershell
cd frontend
npm run dev
```

On Windows, the project launcher starts both services in hidden processes and
opens the interface in regular Google Chrome:

```powershell
.\scripts\start-local.ps1
```

Open `http://localhost:5173` and allow microphone access. The first connection
downloads and caches openWakeWord's pretrained "Hey Jarvis" model. Once the
header reads `WAKE ARMED`, say "Hey Jarvis", wait for the cue, speak naturally,
and pause; Silero VAD finalizes the command automatically.

Hold `Space` or hold the `MANUAL FALLBACK` control when ambient sound makes the
wake phrase unreliable. You can also type a command in the bottom field.

The first Whisper transcription can take longer because the selected model must
be downloaded and loaded. Change `speech.model` in the config if needed:

| Model | Relative speed | Relative accuracy |
| --- | --- | --- |
| `tiny` | Fastest | Basic |
| `base` | Fast | Good default |
| `small` | Moderate | Better |
| `medium` | Slow | High |
| `turbo` | GPU-oriented | High |

## Voice character

When `ELEVENLABS_VOICE_ID` is blank, the backend lists the voices available to
your account and ranks them for qualities such as British, baritone,
articulate, crisp, calm, and professional. It then applies a stable, deliberate
delivery profile. To select a voice manually, copy its ID from ElevenLabs
**My Voices** and set `ELEVENLABS_VOICE_ID`.

## MCP tools and approvals

The sample config includes Playwright and Obsidian MCP server definitions.
Every server may specify:

- `read_only_tools`: explicit tools that can execute immediately;
- `write_tools`: explicit tools that always require confirmation;
- `default_mode`: use `confirm` for unknown tools.

Tool-name classification adds a second safety layer. Names containing operations
such as `create`, `delete`, `click`, `fill`, `send`, or `write` are treated as
writes. Playwright navigation, page reading, snapshots, console inspection, and
network inspection are explicitly read-only. Unknown tools default to
confirmation.

The Obsidian entry expects Local REST API at
`https://127.0.0.1:27124/mcp/`. Set its bearer key in `.env` before starting
JARVIS. Store the raw key only—do not include the `Bearer ` prefix. Read
operations such as vault listing and search run directly; note
creation, edits, deletes, moves, commands, and UI-opening actions require
confirmation. If you do not use Obsidian, set that server object's `enabled`
field to `false`.

Daily briefs are read-only. The research workflow remains their sole producer.
For a date, Astrono Jarvis first checks `YYYY-MM-DD.md`; if that is absent, it
accepts exactly one `YYYY-MM-DD*.md` themed note. Missing or duplicate notes
produce an explicit vault error and never fall back to Gmail.

Durable context is consolidated at 9:00 PM Toronto time, with a missed run
caught up on the next startup. Credentials, temporary instructions, assistant
guesses, and duplicate facts are excluded. The approval queue receives one
exact section-patch action; an approved action executes once, a denied action
never executes, and a failed action remains retryable.

## Google Workspace

Create a Google OAuth Desktop app, enable the Gmail and Google Calendar APIs,
and put the client ID and secret in `.env`. Then run:

```powershell
uv run --env-file .env python scripts/oauth_all.py --google
```

The renewed consent includes `gmail.send` and full Calendar access. Gmail
search/thread/unread and Calendar today/search/next-meeting are reads. Gmail
send/archive/trash and Calendar create/update/delete/respond always enter the
approval queue.

## One-click desktop launcher

The Tauri app is the authoritative launcher. It starts or attaches to Ollama,
starts or attaches to the backend, waits for health, and presents the voice
interface without a terminal window. Its NSIS installer creates `Astrono
Jarvis` shortcuts on the Windows Desktop and Start Menu using the black-hole
icon.

Build the Windows installer:

```powershell
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
winget install --id MartinStorsjo.LLVM-MinGW.UCRT --exact
cd frontend
npm run package:windows
```

The installer is emitted under
`frontend/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.
The PWA remains available as an optional browser installation, but it cannot
start stopped local services and is not the primary launcher.

## Configuration

The main project configuration is
[`configs/jarvis-assistant.toml`](configs/jarvis-assistant.toml). The assistant
persona is in [`prompts/jarvis-system.md`](prompts/jarvis-system.md).

Important values:

```toml
[intelligence]
default_model = "qwen3.5:4b"
preferred_engine = "ollama"
provider = "local"

[speech]
backend = "faster-whisper"
model = "small"
language = "en"
device = "cpu"
compute_type = "int8"
tts_backend = "kokoro"
tts_voice = "bm_george"
tts_speed = 0.92
auto_speak = true
wake_word_enabled = true
wake_word_model = "hey jarvis"
wake_word_threshold = 0.5
wake_word_vad_threshold = 0.35
vad_threshold = 0.5
vad_min_speech_ms = 96
vad_min_silence_ms = 1000

[daily_brief]
folder = "Morning Brief/Daily Briefs"
timezone = "America/Toronto"

[context_memory]
path = "Jarvis/context.md"
consolidation_hour = 21

[applications]
applications = "chrome,obsidian"

[google_workspace]
timezone = "America/Toronto"
max_tool_turns = 5

[security]
profile = "personal"
mode = "warn"
```

Kokoro handles spoken output only. Microphone input continues through local
openWakeWord, Silero VAD, and Faster-Whisper. Set `tts_backend = "auto"` to
restore ElevenLabs-first output when that account has available quota.

## Validation

```powershell
uv run ruff check src/openjarvis
uv run pytest tests/speech tests/mcp/test_safety.py tests/tools/test_mcp_adapter.py
cd frontend
npm run build
npm test
```

To inspect the detector without Whisper, the agent, or TTS, run the standalone
diagnostic against any supported audio file:

```powershell
uv run python scripts/diagnose_vad.py path\to\speech.wav
```

It prints every raw Silero probability, RMS input level, speech state, elapsed
trailing silence, and the exact frame where the one-second stop condition is
reached.

## Security and privacy

- Whisper transcription stays on the machine.
- Wake-word audio stays on the machine and is processed by openWakeWord through
  ONNX Runtime. Continuous microphone audio is not sent to Ollama or
  ElevenLabs.
- Ollama/local-model prompts stay on the machine.
- Text sent to ElevenLabs leaves the machine when that backend is enabled.
- MCP write-like tools are confirmation-gated.
- Never commit `.env`, API keys, local model files, recordings, or approval
  databases.

## Project foundation and license

This project builds on
[OpenJarvis](https://github.com/open-jarvis/OpenJarvis) and retains its Apache
2.0 license. OpenAI Whisper is installed from its official repository and is
licensed separately under MIT. Review third-party service terms before
commercial use, especially ElevenLabs voice and output licensing.
