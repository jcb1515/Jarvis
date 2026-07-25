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
import { AudioOrbit } from './AudioOrbit';
import { useVoicePipeline } from './useVoicePipeline';
import './jarvis-console.css';

type Stage = 'READY' | 'HEARING' | 'THINKING' | 'SPEAKING' | 'ERROR';
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

export function JarvisConsole() {
  const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';
  const selectedModel = useAppStore((state) => state.selectedModel);
  const serverModel = useAppStore((state) => state.serverInfo?.model);
  const activeModel = selectedModel || serverModel || DEFAULT_JARVIS_MODEL;
  const settings = useAppStore((state) => state.settings);
  const [sessionMessages, setSessionMessages] = useState<ChatMessage[]>([]);
  const [stage, setStage] = useState<Stage>(isDemo ? 'SPEAKING' : 'READY');
  const [command, setCommand] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [error, setError] = useState('');
  const [approvals, setApprovals] = useState<PendingApproval[]>(
    isDemo ? [DEMO_APPROVAL] : [],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const voice = useVoicePipeline();

  const transcript = useMemo(() => {
    if (isDemo && sessionMessages.length === 0) return DEMO_TRANSCRIPT;
    return sessionMessages.slice(-4).map((message) => ({
      speaker: message.role === 'user' ? 'YOU' : 'JARVIS',
      text: message.content,
    }));
  }, [isDemo, sessionMessages]);

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

  const refreshApprovals = useCallback(async (): Promise<void> => {
    if (isDemo) return;
    try {
      setApprovals(await fetchPendingApprovals());
    } catch {
      setApprovals([]);
    }
  }, [isDemo]);

  useEffect(() => {
    void refreshApprovals();
    const interval = window.setInterval(() => void refreshApprovals(), 2500);
    return () => window.clearInterval(interval);
  }, [refreshApprovals]);

  const sendCommand = useCallback(
    async (rawCommand: string): Promise<void> => {
      const text = rawCommand.trim();
      if (!text || stage === 'THINKING') return;
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
        setStage('THINKING');
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, 700),
        );
        updateSessionAssistant(
          'I have prepared that operation. It is waiting in the approval queue.',
        );
        setStage('READY');
        return;
      }

      setStage('THINKING');
      let response = '';
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
            response += parseDelta(event.data);
            updateSessionAssistant(response);
          } catch {
            continue;
          }
        }
        const resolvedResponse =
          response.trim() || 'The operation completed without a text response.';
        updateSessionAssistant(resolvedResponse);
        await refreshApprovals();
        setStage('SPEAKING');
        await voice.speak(resolvedResponse);
        setStage('READY');
      } catch (caught) {
        const detail =
          caught instanceof Error ? caught.message : 'Unknown assistant error';
        updateSessionAssistant(`Error: ${detail}`);
        setError(detail);
        setStage('ERROR');
      }
    },
    [
      isDemo,
      refreshApprovals,
      activeModel,
      sessionMessages,
      settings.maxTokens,
      settings.temperature,
      stage,
      updateSessionAssistant,
      voice,
    ],
  );

  const beginListening = useCallback(async (): Promise<void> => {
    if (stage === 'THINKING' || stage === 'SPEAKING') return;
    setError('');
    setPartialTranscript('Listening for your command…');
    try {
      await voice.startListening(
        (text) => setPartialTranscript(text),
        (partialError) => setError(partialError.message),
      );
      setStage('HEARING');
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Microphone access failed.',
      );
      setStage('ERROR');
    }
  }, [stage, voice]);

  const finishListening = useCallback(async (): Promise<void> => {
    if (!voice.isListening) return;
    setPartialTranscript('Transcribing locally with Whisper…');
    try {
      const text = await voice.stopListening();
      setPartialTranscript(text || 'No speech detected.');
      setStage('READY');
      if (text) await sendCommand(text);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Transcription failed.',
      );
      setStage('ERROR');
    }
  }, [sendCommand, voice]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        document.activeElement === inputRef.current
      ) {
        return;
      }
      event.preventDefault();
      void beginListening();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || document.activeElement === inputRef.current) {
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
      await sendCommand(
        `I explicitly approve pending action ${approval.id}. Continue the ` +
          'same action exactly as proposed.',
      );
    }
  };

  return (
    <main className="jarvis-console">
      <div className="jarvis-console__grid" aria-hidden="true" />
      <header className="jarvis-header">
        <div className="jarvis-brand">
          <img src="/jarvis-hud-mark.png" alt="" />
          <div>
            <span>JARVIS</span>
            <small>JUST A RATHER VERY INTELLIGENT SYSTEM</small>
          </div>
        </div>
        <div className="jarvis-header__status">
          <span><i /> SYSTEM ONLINE</span>
          <span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <a href="/settings" aria-label="Open settings"><GearSix size={20} /></a>
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
                <span>LIVE</span><p>{partialTranscript}</p>
              </article>
            )}
          </div>
          <div className="jarvis-agent-steps">
            <div className="jarvis-section-label">AGENT STEPS</div>
            <div className={stage === 'HEARING' ? 'is-active' : ''}>
              <i><Ear size={19} /></i><span>HEARING</span>
            </div>
            <div className={stage === 'THINKING' ? 'is-active' : ''}>
              <i><Brain size={19} /></i><span>THINKING</span>
            </div>
            <div className={stage === 'SPEAKING' ? 'is-active' : ''}>
              <i><Waveform size={19} /></i><span>SPEAKING</span>
            </div>
          </div>
        </aside>

        <section className="jarvis-core">
          <div className="jarvis-section-label jarvis-section-label--center">
            JARVIS OUTPUT
          </div>
          <AudioOrbit
            active={
              voice.isSpeaking ||
              stage === 'THINKING' ||
              stage === 'SPEAKING'
            }
            compact={false}
            getFrequencyData={voice.getOutputData}
            label="Live assistant audio frequency visualizer"
          />
          <div className={`jarvis-state jarvis-state--${stage.toLowerCase()}`}>
            <span>{stage}</span>
            <p>
              {stage === 'HEARING' && 'Release Space to send'}
              {stage === 'THINKING' && 'Reasoning and coordinating tools'}
              {stage === 'SPEAKING' &&
                `Voice output via ${isDemo ? 'elevenlabs' : voice.voiceBackend}`}
              {stage === 'READY' && 'Hold Space or press the microphone'}
              {stage === 'ERROR' && 'Review the diagnostic below'}
            </p>
          </div>
        </section>

        <aside className="jarvis-rail jarvis-rail--right">
          <div className="jarvis-section-label">PENDING ACTION</div>
          <div className="jarvis-approval">
            <div><ShieldCheck size={18} /><span>APPROVAL QUEUE</span><b>{approvals.length}</b></div>
            {approvals.slice(0, 1).map((approval) => (
              <article key={approval.id}>
                <small>{approval.action_type.replace(/_/g, ' ')}</small>
                <p>{approval.description}</p>
                <div>
                  <button type="button" onClick={() => void handleApproval(approval, false)}>
                    <X size={14} /> DENY
                  </button>
                  <button type="button" onClick={() => void handleApproval(approval, true)}>
                    <Check size={14} /> APPROVE
                  </button>
                </div>
              </article>
            ))}
            {approvals.length === 0 && <p className="jarvis-empty">No pending writes.</p>}
          </div>
        </aside>
      </section>

      <footer className="jarvis-command">
        <div className="jarvis-mic-deck">
          <div>
            <span>MIC INPUT</span>
            <AudioOrbit
              active={voice.isListening}
              compact
              getFrequencyData={voice.getMicData}
              label="Live microphone frequency visualizer"
            />
          </div>
          <button
            className="jarvis-ptt"
            onPointerDown={() => void beginListening()}
            onPointerUp={() => void finishListening()}
            onPointerCancel={() => void finishListening()}
            type="button"
          >
            <Microphone size={22} weight="fill" />
            {voice.isListening ? 'RELEASE TO SEND' : 'HOLD SPACE TO SPEAK'}
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendCommand(command);
          }}
        >
          <span className="jarvis-command__prompt">›</span>
          <input
            ref={inputRef}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Type a command when silence is preferable…"
            aria-label="Type a command"
          />
          <button type="submit" aria-label="Send command"><PaperPlaneRight size={19} /></button>
        </form>
        <div className="jarvis-command__status">
          <span><i /> WHISPER LOCAL</span>
          <span>SILERO VAD {voice.vadActive ? 'SPEECH' : 'MONITORING'}</span>
          <span><ArrowClockwise size={13} /> ELEVENLABS → KOKORO</span>
          <span><Cpu size={13} /> {activeModel}</span>
          <span>{error ? `FAULT: ${error}` : 'ALL SYSTEMS NOMINAL'}</span>
        </div>
      </footer>
    </main>
  );
}
