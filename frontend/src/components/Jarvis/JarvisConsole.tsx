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

const DEFAULT_JARVIS_MODEL = 'qwen3.5:4b';
const CONVERSATION_WINDOW_MS = 12_000;
const CHAT_START_TIMEOUT_MS = 60_000;
const CHAT_TOKEN_STALL_TIMEOUT_MS = 12_000;

interface ListeningSessionOptions {
  automatic: boolean;
  conversation: boolean;
  prompt: string;
}

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

const hasElapsedPhase = (stage: JarvisStage): boolean =>
  stage === 'HEARING' ||
  stage === 'THINKING' ||
  stage === 'RESPONDING' ||
  stage === 'SPEAKING';

const formatPhaseLabel = (
  stage: JarvisStage,
  elapsedMs: number,
): string => {
  const phase = stage === 'RESPONDING' ? 'THINKING' : stage;
  return hasElapsedPhase(stage)
    ? `${phase}, ${formatElapsed(elapsedMs)}`
    : phase;
};

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
  const [timerNowMs, setTimerNowMs] = useState(Date.now());
  const [cosmicMode, setCosmicMode] = useState<CosmicMode>('BLACK_HOLE');
  const [command, setCommand] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [error, setError] = useState('');
  const [wakeFlash, setWakeFlash] = useState(false);
  const [listeningAutomatically, setListeningAutomatically] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>(
    isDemo ? [DEMO_APPROVAL] : [],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const autoFinishRef = useRef<() => void>(() => undefined);
  const beginConversationRef = useRef<() => Promise<void>>(
    async () => undefined,
  );
  const conversationActiveRef = useRef(false);
  const conversationDeadlineAtRef = useRef<number | null>(null);
  const conversationSpeechObservedRef = useRef(false);
  const handledWakeSequenceRef = useRef(0);
  const stageRef = useRef<JarvisStage>(stage);
  const voice = useVoicePipeline();

  const transcript = useMemo(() => {
    if (isDemo && sessionMessages.length === 0) return DEMO_TRANSCRIPT;
    return sessionMessages.slice(-4).map((message) => ({
      speaker: message.role === 'user' ? 'YOU' : 'JARVIS',
      text: message.content,
    }));
  }, [isDemo, sessionMessages]);

  const visibleElapsedMs = useMemo(() => {
    if (!hasElapsedPhase(stage)) return 0;
    return Math.max(0, timerNowMs - stageStartedAtMs);
  }, [stage, stageStartedAtMs, timerNowMs]);

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
      stageRef.current = nextStage;
      setStage(nextStage);
      setStageStartedAtMs(startedAtMs);
      voice.transitionState(nextStage);
    },
    [voice.transitionState],
  );

  const clearConversationDeadline = useCallback((): void => {
    conversationDeadlineAtRef.current = null;
  }, []);

  const deactivateConversation = useCallback((): void => {
    clearConversationDeadline();
    conversationActiveRef.current = false;
    conversationSpeechObservedRef.current = false;
    setConversationActive(false);
  }, [clearConversationDeadline]);

  const expireConversationWindow = useCallback(async (): Promise<void> => {
    conversationDeadlineAtRef.current = null;
    if (!conversationActiveRef.current) return;
    if (conversationSpeechObservedRef.current) {
      autoFinishRef.current();
      return;
    }

    conversationActiveRef.current = false;
    setConversationActive(false);
    try {
      await voice.cancelListening();
      setPartialTranscript('');
      transitionToStage('READY');
    } catch (caught) {
      const detail =
        caught instanceof Error
          ? caught.message
          : 'Could not close the conversation listening window.';
      setError(detail);
      transitionToStage('ERROR');
    }
  }, [transitionToStage, voice.cancelListening]);

  const armConversationDeadline = useCallback((): void => {
    conversationDeadlineAtRef.current = Date.now() + CONVERSATION_WINDOW_MS;
  }, []);

  useEffect(() => {
    if (!conversationActive || stage !== 'HEARING') return;
    const deadlineAt = conversationDeadlineAtRef.current;
    if (deadlineAt === null || timerNowMs < deadlineAt) return;
    void expireConversationWindow();
  }, [
    conversationActive,
    expireConversationWindow,
    stage,
    timerNowMs,
  ]);

  const refreshApprovals = useCallback(async (): Promise<void> => {
    if (isDemo) return;
    try {
      setApprovals(await fetchPendingApprovals());
      setError((current) =>
        current.startsWith('Failed:') ||
        current.startsWith('Could not refresh')
          ? ''
          : current,
      );
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
    if (!hasElapsedPhase(stage)) return;
    const interval = window.setInterval(() => setTimerNowMs(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [stage]);

  useEffect(() => {
    const transition = voice.runtimeTransition;
    if (
      transition.stage === stage &&
      hasElapsedPhase(stage)
    ) {
      setStageStartedAtMs(transition.startedAtMs);
    }
  }, [stage, voice.runtimeTransition]);

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    let retryTimer = 0;
    const connectWakeWord = async (attempt: number): Promise<void> => {
      try {
        await voice.enableWakeWord();
        if (!cancelled) {
          setError((current) =>
            current.startsWith('Wake connection:') ? '' : current,
          );
        }
      } catch (caught) {
        if (cancelled) return;
        const detail =
          caught instanceof Error
            ? caught.message
            : 'Wake-word initialization failed.';
        const delayMs = Math.min(1000 * 2 ** attempt, 10000);
        setError(`Wake connection: ${detail} Retrying automatically.`);
        console.warn('Wake-word connection retry scheduled', {
          attempt: attempt + 1,
          delayMs,
          error: detail,
        });
        retryTimer = window.setTimeout(
          () => void connectWakeWord(attempt + 1),
          delayMs,
        );
      }
    };
    void connectWakeWord(0);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [isDemo, voice.enableWakeWord, voice.wakeStatus]);

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
        deactivateConversation();
        transitionToStage('READY');
        return;
      }
      clearConversationDeadline();
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
      try {
        const apiMessages = history.map((message) => ({
          role: message.role,
          content: message.content,
        }));
        const chatController = new AbortController();
        let chatTimeoutMessage =
          'The local model did not begin responding within 60 seconds.';
        let chatTimeoutId = window.setTimeout(() => {
          chatController.abort();
        }, CHAT_START_TIMEOUT_MS);
        const armChatTimeout = (message: string, timeoutMs: number): void => {
          window.clearTimeout(chatTimeoutId);
          chatTimeoutMessage = message;
          chatTimeoutId = window.setTimeout(() => {
            chatController.abort();
          }, timeoutMs);
        };

        try {
          for await (const event of streamChat(
            {
              model: activeModel,
              messages: apiMessages,
              stream: true,
              temperature: settings.temperature,
              max_tokens: settings.maxTokens,
            },
            chatController.signal,
          )) {
            if (
              event.event === 'tool_call_start' ||
              event.event === 'tool_call_end'
            ) {
              continue;
            }
            try {
              const delta = parseDelta(event.data);
              response += delta;
              updateSessionAssistant(response);
              if (delta) {
                armChatTimeout(
                  'The local model stopped producing response tokens for 12 seconds.',
                  CHAT_TOKEN_STALL_TIMEOUT_MS,
                );
              }
            } catch (caught) {
              if (caught instanceof SyntaxError) continue;
              throw caught;
            }
          }
        } catch (caught) {
          if (!chatController.signal.aborted) throw caught;
          if (!response.trim()) throw new Error(chatTimeoutMessage);
          console.warn('JARVIS closed a stalled response stream', {
            reason: chatTimeoutMessage,
            responseLength: response.length,
          });
        } finally {
          window.clearTimeout(chatTimeoutId);
        }
        const resolvedResponse =
          response.trim() || 'The operation completed without a text response.';
        updateSessionAssistant(resolvedResponse);
        await refreshApprovals();
        try {
          await voice.speak(resolvedResponse, {
            onPlaybackStart: () => transitionToStage('SPEAKING'),
          });
        } catch (caught) {
          const detail =
            caught instanceof Error
              ? caught.message
              : 'Synthesized speech playback failed.';
          console.error('JARVIS recovered from speech playback failure', {
            error: detail,
            recoveryStage: 'READY',
          });
          setError(`Speech playback: ${detail}`);
          transitionToStage('READY');
          return;
        }
        transitionToStage('READY');
        await beginConversationRef.current();
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
      clearConversationDeadline,
      deactivateConversation,
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
    clearConversationDeadline();
    setPartialTranscript('Finalizing locally with Whisper…');
    transitionToStage('THINKING');
    try {
      const text = await voice.stopListening();
      setPartialTranscript(text || 'No speech detected.');
      if (text) {
        await executeCommand(text);
      } else {
        deactivateConversation();
        transitionToStage('READY');
      }
    } catch (caught) {
      deactivateConversation();
      setError(
        caught instanceof Error ? caught.message : 'Transcription failed.',
      );
      transitionToStage('ERROR');
    }
  }, [
    clearConversationDeadline,
    deactivateConversation,
    executeCommand,
    transitionToStage,
    voice.stopListening,
  ]);

  useEffect(() => {
    autoFinishRef.current = () => {
      void finishListening();
    };
  }, [finishListening]);

  const beginListening = useCallback(
    async (options: ListeningSessionOptions): Promise<void> => {
      if (
        voice.isListening ||
        stageRef.current === 'THINKING' ||
        stageRef.current === 'RESPONDING' ||
        stageRef.current === 'SPEAKING'
      ) {
        return;
      }
      if (!options.conversation) deactivateConversation();
      voice.setWakePaused(true);
      setError('');
      setListeningAutomatically(options.automatic);
      setPartialTranscript(options.prompt);
      transitionToStage('HEARING');
      try {
        await voice.startListening({
          autoStop: options.automatic,
          onPartialTranscript: (text) => setPartialTranscript(text),
          onPartialError: (partialError) => setError(partialError.message),
          onSpeechEnd: () => autoFinishRef.current(),
        });
        if (options.conversation) armConversationDeadline();
      } catch (caught) {
        const detail =
          caught instanceof Error
            ? caught.message
            : 'Microphone access failed.';
        if (options.conversation) {
          deactivateConversation();
          setError(`Conversation listening: ${detail}`);
          transitionToStage('READY');
          return;
        }
        setError(detail);
        transitionToStage('ERROR');
      }
    },
    [
      armConversationDeadline,
      deactivateConversation,
      transitionToStage,
      voice.isListening,
      voice.setWakePaused,
      voice.startListening,
    ],
  );

  const beginConversation = useCallback(async (): Promise<void> => {
    conversationActiveRef.current = true;
    conversationSpeechObservedRef.current = false;
    setConversationActive(true);
    await beginListening({
      automatic: true,
      conversation: true,
      prompt: 'Conversation open. Listening for your reply…',
    });
  }, [beginListening]);

  useEffect(() => {
    beginConversationRef.current = beginConversation;
  }, [beginConversation]);

  useEffect(() => {
    if (
      !conversationActive ||
      !voice.isListening ||
      !voice.vadActive
    ) {
      return;
    }
    conversationSpeechObservedRef.current = true;
    armConversationDeadline();
  }, [
    armConversationDeadline,
    conversationActive,
    voice.isListening,
    voice.vadActive,
    voice.vadProbability,
  ]);

  useEffect(
    () => () => {
      clearConversationDeadline();
    },
    [clearConversationDeadline],
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
    void beginListening({
      automatic: true,
      conversation: false,
      prompt: 'Wake phrase confirmed. Listening…',
    });
    return () => window.clearTimeout(flashTimer);
  }, [beginListening, stage, voice.wakeSequence]);

  const sendTypedCommand = useCallback(async (): Promise<void> => {
    const text = command.trim();
    if (!text || stage === 'THINKING') return;
    clearConversationDeadline();
    if (voice.isListening) {
      try {
        await voice.cancelListening();
      } catch (caught) {
        const detail =
          caught instanceof Error
            ? caught.message
            : 'Could not stop microphone capture before sending text.';
        setError(detail);
        transitionToStage('ERROR');
        return;
      }
    }
    transitionToStage('THINKING');
    await executeCommand(text);
  }, [
    clearConversationDeadline,
    command,
    executeCommand,
    stage,
    transitionToStage,
    voice.cancelListening,
    voice.isListening,
  ]);

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
      void beginListening({
        automatic: false,
        conversation: false,
        prompt: 'Manual microphone fallback active…',
      });
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
      if (conversationActive) {
        return 'Conversation open — reply without saying “Hey Jarvis”';
      }
      return listeningAutomatically
        ? 'Speak naturally — silence sends automatically'
        : 'Release Space or the microphone to send';
    }
    if (stage === 'THINKING' || stage === 'RESPONDING') {
      return 'Reasoning and preparing the response';
    }
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
          <img src="/astrono-black-hole.png" alt="" />
          <div>
            <span>ASTRONO JARVIS</span>
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
            <span>{formatPhaseLabel(stage, visibleElapsedMs)}</span>
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
            onPointerDown={() =>
              void beginListening({
                automatic: false,
                conversation: false,
                prompt: 'Manual microphone fallback active…',
              })
            }
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
            SILERO P {voice.vadProbability.toFixed(3)} ·{' '}
            {voice.vadRmsDbfs.toFixed(1)} DB · {voice.vadSilenceMs} MS{' '}
            {voice.vadActive ? 'SPEECH' : 'QUIET'}
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
