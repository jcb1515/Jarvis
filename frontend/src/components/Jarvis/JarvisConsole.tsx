import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { approveAction, denyAction, fetchPendingApprovals } from '../../lib/api';
import type { PendingApproval } from '../../lib/api';
import { streamChat } from '../../lib/sse';
import { useAppStore } from '../../lib/store';
import type { ChatMessage } from '../../types';
import type { CosmicMode, JarvisStage } from './CosmicVisualizer';
import { initialSceneMode, JarvisSurface } from './JarvisSurface';
import { useVoicePipeline } from './useVoicePipeline';

const DEFAULT_JARVIS_MODEL = 'qwen3.5:4b';
const CONVERSATION_WINDOW_MS = 12_000;
const CHAT_START_TIMEOUT_MS = 60_000;
const CHAT_TOKEN_STALL_TIMEOUT_MS = 12_000;

interface ListeningSessionOptions {
  automatic: boolean;
  conversation: boolean;
  prompt: string;
}

interface ParsedDelta {
  content: string;
  reasoningContent: string;
}

interface ResolvedThinkingCommand {
  command: string;
  think: boolean;
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

const parseDelta = (data: string): ParsedDelta => {
  const parsed = JSON.parse(data) as {
    choices?: Array<{
      delta?: { content?: string; reasoning_content?: string };
    }>;
  };
  return {
    content: parsed.choices?.[0]?.delta?.content ?? '',
    reasoningContent:
      parsed.choices?.[0]?.delta?.reasoning_content ?? '',
  };
};

const resolveThinkingCommand = (
  rawCommand: string,
  persistentThinking: boolean,
): ResolvedThinkingCommand => {
  const manualTrigger =
    /^\s*(?:think carefully about this|use thinking mode)\s*[:,.-]?\s*/i;
  const triggered = manualTrigger.test(rawCommand);
  return {
    command: triggered
      ? rawCommand.replace(manualTrigger, '').trim()
      : rawCommand.trim(),
    think: persistentThinking || triggered,
  };
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
  const [cosmicMode, setCosmicMode] = useState<CosmicMode>(initialSceneMode);
  const [command, setCommand] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [error, setError] = useState('');
  const [wakeFlash, setWakeFlash] = useState(false);
  const [listeningAutomatically, setListeningAutomatically] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('astrono-jarvis-thinking-mode') === 'thinking';
    } catch {
      return false;
    }
  });
  const [reasoningTrace, setReasoningTrace] = useState('');
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

  useEffect(() => {
    try {
      localStorage.setItem(
        'astrono-jarvis-thinking-mode',
        thinkingMode ? 'thinking' : 'instant',
      );
    } catch (caught) {
      console.warn('Could not persist the JARVIS thinking preference', {
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, [thinkingMode]);

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
      const resolvedCommand = resolveThinkingCommand(rawCommand, thinkingMode);
      const text = resolvedCommand.command;
      if (!text) {
        deactivateConversation();
        setError('Thinking mode needs a question or command.');
        transitionToStage('READY');
        return;
      }
      clearConversationDeadline();
      setError('');
      setReasoningTrace('');
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
              think: resolvedCommand.think,
              tool_mode: 'auto',
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
              response += delta.content;
              if (delta.reasoningContent) {
                setReasoningTrace((current) =>
                  `${current}${delta.reasoningContent}`.slice(-8_000),
                );
              }
              updateSessionAssistant(response);
              if (delta.content || delta.reasoningContent) {
                armChatTimeout(
                  'The local model stopped producing tokens for 12 seconds.',
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
      thinkingMode,
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
    try {
      if (!approved) {
        await denyAction(approval.id);
        await refreshApprovals();
        return;
      }
      transitionToStage('THINKING');
      const execution = await approveAction(approval.id);
      await refreshApprovals();
      const executionMessage =
        execution.result?.content ??
        (execution.execution_status === 'already_executed'
          ? 'That exact action was already executed.'
          : 'The approved action completed.');
      setSessionMessages((current) => [
        ...current,
        {
          id: messageId(),
          role: 'assistant',
          content: executionMessage,
          timestamp: Date.now(),
        },
      ]);
      if (execution.execution_status === 'retryable') {
        setError(executionMessage);
        transitionToStage('ERROR');
        return;
      }
      try {
        await voice.speak(executionMessage, {
          onPlaybackStart: () => transitionToStage('SPEAKING'),
        });
      } catch (caught) {
        const detail =
          caught instanceof Error
            ? caught.message
            : 'Synthesized speech playback failed.';
        console.error(
          'JARVIS recovered from approval speech playback failure',
          {
            approvalId: approval.id,
            error: detail,
            recoveryStage: 'READY',
          },
        );
        setError(`Speech playback: ${detail}`);
      }
      transitionToStage('READY');
    } catch (caught) {
      const detail =
        caught instanceof Error
          ? caught.message
          : 'The approval request failed unexpectedly.';
      setError(`Approval ${approval.id}: ${detail}`);
      transitionToStage('ERROR');
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
    <JarvisSurface
      activeModel={activeModel}
      approvals={approvals}
      command={command}
      cosmicMode={cosmicMode}
      error={error}
      inputRef={inputRef}
      isDemo={isDemo}
      listeningAutomatically={listeningAutomatically}
      partialTranscript={partialTranscript}
      phaseLabel={formatPhaseLabel(stage, visibleElapsedMs)}
      reasoningTrace={reasoningTrace}
      stage={stage}
      statusDetail={statusDetail()}
      thinkingMode={thinkingMode}
      transcript={transcript}
      voice={voice}
      wakeFlash={wakeFlash}
      onApproval={(approval, approved) => void handleApproval(approval, approved)}
      onCommandChange={setCommand}
      onCosmicModeChange={setCosmicMode}
      onMicrophoneDown={() => void beginListening({
        automatic: false,
        conversation: false,
        prompt: 'Manual microphone fallback active…',
      })}
      onMicrophoneUp={() => void finishListening()}
      onSubmit={() => void sendTypedCommand()}
      onThinkingModeChange={setThinkingMode}
    />
  );
}
