import {
  ArrowClockwise,
  Brain,
  Check,
  Cpu,
  Ear,
  GearSix,
  Microphone,
  PaperPlaneRight,
  ShieldCheck,
  Waveform,
  X,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { approveAction, denyAction, fetchPendingApprovals } from '../../lib/api';
import type { PendingApproval } from '../../lib/api';
import { streamChat } from '../../lib/sse';
import { useAppStore } from '../../lib/store';
import type { ChatMessage } from '../../types';
import {
  CosmicVisualizer,
  type CosmicMode,
  type JarvisStage,
} from './CosmicVisualizer';
import { MicWaveform } from './MicWaveform';
import { useVoicePipeline } from './useVoicePipeline';
import './jarvis-console.css';

const DEFAULT_JARVIS_MODEL = 'nvidia/google/gemma-4-31b-it';

const DEMO_TRANSCRIPT = [
  {
    speaker: 'YOU',
    text: 'Review my Monday schedule and flag any conflicts.',
  },
  {
    speaker: 'JARVIS',
    text: 'I found one conflict in your Monday schedule.',
  },
];

const DEMO_APPROVAL: PendingApproval = {
  id: 'demo-approval',
  action_type: 'obsidian_write_note',
  description: 'Create note: “I found one conflict in your Monday schedule.”',
  payload: { path: 'Jarvis/Schedule conflicts.md' },
  permission_key: 'demo',
  tier: 'high',
  status: 'pending',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
};

const messageId = (): string =>
  `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

const parseDelta = (data: string): string => {
  const parsed = JSON.parse(data) as {
    choices?: Array<{ delta?: { content?: string } }>;
  };
  return parsed.choices?.[0]?.delta?.content ?? '';
};

const formatElapsed = (elapsedMs: number): string =>
  `${(elapsedMs / 1000).toFixed(1)}s`;

const playWakeCue = async (): Promise<void> => {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.23);
  gain.connect(context.destination);
  [660, 990].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(context.currentTime + index * 0.055);
    oscillator.stop(context.currentTime + 0.24);
  });
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 260);
  });
  await context.close();
};

export function JarvisConsole() {
  const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
  const selectedModel = useAppStore((state) => state.selectedModel);
  const serverModel = useAppStore((state) => state.serverInfo?.model);
  const activeModel = selectedModel || serverModel || DEFAULT_JARVIS_MODEL;
  const settings = useAppStore((state) => state.settings);
  const [sessionMessages, setSessionMessages] = useState<ChatMessage[]>([]);
  const [stage, setStage] = useState<JarvisStage>(
    isDemo ? 'SPEAKING' : 'READY',
  );
  const [stageStartedAtMs, setStageStartedAtMs] = useState(Date.now());
  const [thinkingEndedAtMs, setThinkingEndedAtMs] = useState<number | null>(null);
  const [timerNowMs, setTimerNowMs] = useState(Date.now());
  const [cosmicMode, setCosmicMode] = useState<CosmicMode>('BLACK_HOLE');
  const [command, setCommand] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [error, setError] = useState('');
  const [wakeFlash, setWakeFlash] = useState(false);
  const [listeningAutomatically, setListeningAutomatically] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>(
    isDemo ? [DEMO_APPROVAL] : [],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const autoFinishRef = useRef<() => void>(() => undefined);
  const handledWakeSequenceRef = useRef(0);
  const voice = useVoicePipeline();

  const transcript = useMemo(() => {
    if (isDemo && sessionMessages.length === 0) return DEMO_TRANSCRIPT;
    return sessionMessages.slice(-4).map((message) => ({
      speaker: message.role === 'user' ? 'YOU' : 'JARVIS',
      text: message.content,
    }));
  }, [isDemo, sessionMessages]);

  const visibleElapsedMs = useMemo(() => {
    if (stage !== 'HEARING' && stage !== 'THINKING') return 0;
    const endAt =
      stage === 'THINKING' && thinkingEndedAtMs !== null
        ? thinkingEndedAtMs
        : timerNowMs;
    return Math.max(0, endAt - stageStartedAtMs);
  }, [stage, stageStartedAtMs, thinkingEndedAtMs, timerNowMs]);

  const updateSessionAssistant = useCallback((content: string): void => {
    setSessionMessages((current) => {
      const updated = [...current];
      const lastIndex = updated.length - 1;
      if (lastIndex >= 0 && updated[lastIndex].role === 'assistant') {
        updated[lastIndex] = { ...updated[lastIndex], content };
      }
      return updated;
    });
  }, []);

  const transitionToStage = useCallback(
    (nextStage: JarvisStage): void => {
      const startedAtMs = Date.now();
      setStage(nextStage);
      setStageStartedAtMs(startedAtMs);
      setThinkingEndedAtMs(null);
      voice.transitionState(nextStage);
    },
    [voice.transitionState],
  );

  const refreshApprovals = useCallback(async (): Promise<void> => {
    if (isDemo) return;
    try {
      setApprovals(await fetchPendingApprovals());
    } catch (caught) {
      const detail =
        caught instanceof Error
          ? caught.message
          : 'Could not refresh the approval queue.';
      setError(detail);
    }
  }, [isDemo]);

  useEffect(() => {
    void refreshApprovals();
    const interval = window.setInterval(() => void refreshApprovals(), 2500);
    return () => window.clearInterval(interval);
  }, [refreshApprovals]);

  useEffect(() => {
    if (stage !== 'HEARING' && stage !== 'THINKING') return;
    const interval = window.setInterval(() => setTimerNowMs(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [stage]);

  useEffect(() => {
    const transition = voice.runtimeTransition;
    if (
      transition.stage === stage &&
      (stage === 'HEARING' || stage === 'THINKING')
    ) {
      setStageStartedAtMs(transition.startedAtMs);
    }
  }, [stage, voice.runtimeTransition]);

  useEffect(() => {
    if (isDemo) return;
    void voice.enableWakeWord().catch((caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Wake-word initialization failed.',
      );
    });
  }, [isDemo, voice.enableWakeWord]);

  useEffect(() => {
    if (stage !== 'READY' || voice.isSpeaking) {
      voice.setWakePaused(true);
      return;
    }
    const cooldown = window.setTimeout(() => {
      voice.setWakePaused(false);
    }, 900);
    return () => window.clearTimeout(cooldown);
  }, [stage, voice.isSpeaking, voice.setWakePaused]);

  const executeCommand = useCallback(
    async (rawCommand: string): Promise<void> => {
      const text = rawCommand.trim();
      if (!text) {
        transitionToStage('READY');
        return;
      }
      setError('');
      setCommand('');
      setPartialTranscript(text);
      const userMessage: ChatMessage = {
        id: messageId(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      const assistantMessage: ChatMessage = {
        id: messageId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      };
      const history = [...sessionMessages, userMessage];
      setSessionMessages([...history, assistantMessage]);

      if (isDemo) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 700);
        });
        updateSessionAssistant(
          'I have prepared that operation. It is waiting in the approval queue.',
        );
        transitionToStage('READY');
        return;
      }

      let response = '';
      let responseStarted = false;
      try {
        const apiMessages = history.map((message) => ({
          role: message.role,
          content: message.content,
        }));
        for await (const event of streamChat({
          model: activeModel,
          messages: apiMessages,
          stream: true,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
        })) {
          if (
            event.event === 'tool_call_start' ||
            event.event === 'tool_call_end'
          ) {
            continue;
          }
          try {
            const delta = parseDelta(event.data);
            if (delta && !responseStarted) {
              responseStarted = true;
              setThinkingEndedAtMs(Date.now());
              voice.transitionState('RESPONDING');
            }
            response += delta;
            updateSessionAssistant(response);
          } catch (caught) {
            if (caught instanceof SyntaxError) continue;
            throw caught;
          }
        }
        const resolvedResponse =
          response.trim() || 'The operation completed without a text response.';
        if (!responseStarted) setThinkingEndedAtMs(Date.now());
        updateSessionAssistant(resolvedResponse);
        await refreshApprovals();
        transitionToStage('SPEAKING');
        await voice.speak(resolvedResponse);
        transitionToStage('READY');
      } catch (caught) {
        const detail =
          caught instanceof Error ? caught.message : 'Unknown assistant error';
        updateSessionAssistant(`Error: ${detail}`);
        setError(detail);
        transitionToStage('ERROR');
      }
    },
    [
      activeModel,
      isDemo,
      refreshApprovals,
      sessionMessages,
      settings.maxTokens,
      settings.temperature,
      transitionToStage,
      updateSessionAssistant,
      voice.speak,
      voice.transitionState,
    ],
  );

  const finishListening = useCallback(async (): Promise<void> => {
    if (!voice.isListening) return;
    setPartialTranscript('Finalizing locally with Whisper…');
    transitionToStage('THINKING');
    try {
      const text = await voice.stopListening();
      setPartialTranscript(text || 'No speech detected.');
      if (text) {
        await executeCommand(text);
      } else {
        transitionToStage('READY');
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Transcription failed.',
      );
      transitionToStage('ERROR');
    }
  }, [
    executeCommand,
    transitionToStage,
    voice.isListening,
    voice.stopListening,
  ]);

  useEffect(() => {
    autoFinishRef.current = () => {
      void finishListening();
    };
  }, [finishListening]);

  const beginListening = useCallback(
    async (automatic: boolean): Promise<void> => {
      if (
        voice.isListening ||
        stage === 'THINKING' ||
        stage === 'RESPONDING' ||
        stage === 'SPEAKING'
      ) {
        return;
      }
      voice.setWakePaused(true);
      setError('');
      setListeningAutomatically(automatic);
      setPartialTranscript(
        automatic
          ? 'Wake phrase confirmed. Listening…'
          : 'Manual microphone fallback active…',
      );
      transitionToStage('HEARING');
      try {
        await voice.startListening({
          autoStop: automatic,
          onPartialTranscript: (text) => setPartialTranscript(text),
          onPartialError: (partialError) => setError(partialError.message),
          onSpeechEnd: () => autoFinishRef.current(),
        });
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Microphone access failed.',
        );
        transitionToStage('ERROR');
      }
    },
    [
      stage,
      transitionToStage,
      voice.isListening,
      voice.setWakePaused,
      voice.startListening,
    ],
  );

  useEffect(() => {
    if (
      voice.wakeSequence === 0 ||
      voice.wakeSequence === handledWakeSequenceRef.current
    ) {
      return;
    }
    handledWakeSequenceRef.current = voice.wakeSequence;
    if (stage !== 'READY') return;
    setWakeFlash(true);
    const flashTimer = window.setTimeout(() => setWakeFlash(false), 900);
    void playWakeCue().catch((caught) => {
      setError(
        caught instanceof Error ? caught.message : 'Wake cue playback failed.',
      );
    });
    void beginListening(true);
    return () => window.clearTimeout(flashTimer);
  }, [beginListening, stage, voice.wakeSequence]);

  const sendTypedCommand = useCallback(async (): Promise<void> => {
    const text = command.trim();
    if (!text || stage === 'THINKING') return;
    transitionToStage('THINKING');
    await executeCommand(text);
  }, [command, executeCommand, stage, transitionToStage]);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        document.activeElement === inputRef.current
      ) {
        return;
      }
      event.preventDefault();
      void beginListening(false);
    };
    const up = (event: KeyboardEvent): void => {
      if (
        event.code !== 'Space' ||
        document.activeElement === inputRef.current
      ) {
        return;
      }
      event.preventDefault();
      void finishListening();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [beginListening, finishListening]);

  const handleApproval = async (
    approval: PendingApproval,
    approved: boolean,
  ): Promise<void> => {
    if (isDemo) {
      setApprovals([]);
      return;
    }
    if (approved) await approveAction(approval.id);
    else await denyAction(approval.id);
    await refreshApprovals();
    if (approved) {
      transitionToStage('THINKING');
      await executeCommand(
        `I explicitly approve pending action ${approval.id}. Continue the ` +
          'same action exactly as proposed.',
      );
    }
  };

  const statusDetail = (): string => {
    if (stage === 'HEARING') {
      return listeningAutomatically
        ? 'Speak naturally — silence sends automatically'
        : 'Release Space or the microphone to send';
    }
    if (stage === 'THINKING') {
      return thinkingEndedAtMs === null
        ? 'Reasoning and coordinating local tools'
        : 'Response acquired — preparing voice';
    }
    if (stage === 'RESPONDING') return 'Preparing the final response';
    if (stage === 'SPEAKING') {
      return `Voice output via ${isDemo ? 'elevenlabs' : voice.voiceBackend}`;
    }
    if (stage === 'READY') return 'Say “Hey Jarvis” or hold Space';
    return 'Review the diagnostic readout';
  };

  return (
    <main
      className={`jarvis-console ${wakeFlash ? 'is-wake-detected' : ''}`}
    >
      <CosmicVisualizer
        getFrequencyData={voice.getOutputData}
        mode={cosmicMode}
        stage={stage}
      />
      <div className="jarvis-console__vignette" aria-hidden="true" />

      <header className="jarvis-header">
        <div className="jarvis-brand">
          <img src="/jarvis-hud-mark.png" alt="" />
          <div>
            <span>JARVIS</span>
            <small>ASTRONOMICAL INTELLIGENCE INTERFACE</small>
          </div>
        </div>
        <div className="jarvis-header__status">
          <span>
            <i /> SYSTEM ONLINE
          </span>
          <span
            className={`jarvis-wake-status jarvis-wake-status--${voice.wakeStatus.toLowerCase()}`}
          >
            WAKE {voice.wakeStatus}
          </span>
          <span>
            {new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <a href="/settings" aria-label="Open settings">
            <GearSix size={20} />
          </a>
        </div>
      </header>

      <section className="jarvis-workspace">
        <aside className="jarvis-rail jarvis-rail--left">
          <div className="jarvis-section-label">LIVE TRANSCRIPT</div>
          <div className="jarvis-transcript">
            {transcript.length === 0 && (
              <p className="jarvis-empty">Awaiting your first command.</p>
            )}
            {transcript.map((line, index) => (
              <article key={`${line.speaker}-${index}`}>
                <span>{line.speaker}</span>
                <p>{line.text}</p>
              </article>
            ))}
            {partialTranscript && (
              <article className="jarvis-transcript__partial">
                <span>LIVE</span>
                <p>{partialTranscript}</p>
              </article>
            )}
          </div>
          <div className="jarvis-agent-steps">
            <div className="jarvis-section-label">AGENT PHASE</div>
            <div className={stage === 'HEARING' ? 'is-active' : ''}>
              <i>
                <Ear size={19} />
              </i>
              <span>HEARING</span>
            </div>
            <div
              className={
                stage === 'THINKING' || stage === 'RESPONDING'
                  ? 'is-active'
                  : ''
              }
            >
              <i>
                <Brain size={19} />
              </i>
              <span>THINKING</span>
            </div>
            <div className={stage === 'SPEAKING' ? 'is-active' : ''}>
              <i>
                <Waveform size={19} />
              </i>
              <span>SPEAKING</span>
            </div>
          </div>
        </aside>

        <section className="jarvis-core">
          <div className="jarvis-visualizer-toolbar">
            <span>CELESTIAL ENGINE</span>
            <div
              aria-label="JARVIS visualizer mode"
              className="jarvis-mode-toggle"
              role="group"
            >
              <button
                aria-pressed={cosmicMode === 'BLACK_HOLE'}
                onClick={() => setCosmicMode('BLACK_HOLE')}
                type="button"
              >
                BLACK HOLE
              </button>
              <button
                aria-pressed={cosmicMode === 'SOLAR_SYSTEM'}
                onClick={() => setCosmicMode('SOLAR_SYSTEM')}
                type="button"
              >
                SOLAR SYSTEM
              </button>
            </div>
          </div>

          <div
            aria-live="polite"
            className={`jarvis-state jarvis-state--${stage.toLowerCase()}`}
            role="status"
          >
            <span>{stage === 'RESPONDING' ? 'THINKING' : stage}</span>
            {(stage === 'HEARING' || stage === 'THINKING') && (
              <strong aria-hidden="true">
                {formatElapsed(visibleElapsedMs)}
              </strong>
            )}
            <p>{statusDetail()}</p>
          </div>

          {wakeFlash && (
            <div className="jarvis-wake-cue" role="status">
              WAKE PHRASE CONFIRMED
              <small>confidence {Math.round(voice.wakeScore * 100)}%</small>
            </div>
          )}
        </section>

        <aside className="jarvis-rail jarvis-rail--right">
          <div className="jarvis-section-label">PENDING ACTION</div>
          <div className="jarvis-approval">
            <div>
              <ShieldCheck size={18} />
              <span>APPROVAL QUEUE</span>
              <b>{approvals.length}</b>
            </div>
            {approvals.slice(0, 1).map((approval) => (
              <article key={approval.id}>
                <small>{approval.action_type.replace(/_/g, ' ')}</small>
                <p>{approval.description}</p>
                <div>
                  <button
                    type="button"
                    onClick={() => void handleApproval(approval, false)}
                  >
                    <X size={14} /> DENY
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleApproval(approval, true)}
                  >
                    <Check size={14} /> APPROVE
                  </button>
                </div>
              </article>
            ))}
            {approvals.length === 0 && (
              <p className="jarvis-empty">No pending writes.</p>
            )}
          </div>
        </aside>
      </section>

      <footer className="jarvis-command">
        <div className="jarvis-mic-deck">
          <div className="jarvis-mic-readout">
            <span>
              MIC INPUT
              <small>
                {voice.isListening
                  ? 'CAPTURING'
                  : voice.wakeStatus === 'ARMED'
                    ? 'WAKE MONITOR'
                    : voice.wakeStatus}
              </small>
            </span>
            <MicWaveform
              active={voice.isListening || voice.wakeStatus === 'ARMED'}
              getFrequencyData={voice.getMicData}
            />
          </div>
          <button
            className="jarvis-ptt"
            onPointerCancel={() => void finishListening()}
            onPointerDown={() => void beginListening(false)}
            onPointerUp={() => void finishListening()}
            type="button"
          >
            <Microphone size={18} weight="fill" />
            {voice.isListening && !listeningAutomatically
              ? 'RELEASE TO SEND'
              : 'MANUAL FALLBACK'}
            <kbd>SPACE</kbd>
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendTypedCommand();
          }}
        >
          <span className="jarvis-command__prompt">›</span>
          <input
            aria-label="Type a command"
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Type a command when silence is preferable…"
            ref={inputRef}
            value={command}
          />
          <button type="submit" aria-label="Send command">
            <PaperPlaneRight size={19} />
          </button>
        </form>
        <div className="jarvis-command__status">
          <span>
            <i /> OPENWAKEWORD LOCAL
          </span>
          <span>WHISPER LOCAL</span>
          <span>
            SILERO VAD {voice.vadActive ? 'SPEECH' : 'MONITORING'}
          </span>
          <span>
            <ArrowClockwise size={13} /> ELEVENLABS → KOKORO
          </span>
          <span>
            <Cpu size={13} /> {activeModel}
          </span>
          <span>
            {error || voice.wakeError
              ? `FAULT: ${error || voice.wakeError}`
              : 'ALL SYSTEMS NOMINAL'}
          </span>
        </div>
      </footer>
    </main>
  );
}
