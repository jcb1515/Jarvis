import '@fontsource-variable/geist';
import {
  ArrowClockwise, ArrowUpRight, Brain, Check, Compass, Cpu, Ear, GearSix,
  Microphone, PaperPlaneRight, ShieldCheck, SlidersHorizontal, Sparkle,
  Sun, Waveform, X, ChatCircleText,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import type { PendingApproval } from '../../lib/api';
import {
  CosmicVisualizer, type CosmicMode, type JarvisStage, type SceneQuality,
  type ViewCommand, type ViewRequest,
} from './CosmicVisualizer';
import { MicWaveform } from './MicWaveform';
import type { useVoicePipeline } from './useVoicePipeline';
import './jarvis-console.css';

type VoiceReadout = Pick<ReturnType<typeof useVoicePipeline>,
  'getMicData' | 'getOutputData' | 'isListening' | 'wakeStatus' | 'wakeError' |
  'voiceBackend' | 'vadProbability' | 'vadRmsDbfs' | 'vadSilenceMs' | 'vadActive' | 'wakeScore'>;

interface TranscriptLine {
  speaker: string;
  text: string;
}

interface JarvisSurfaceProps {
  activeModel: string;
  approvals: PendingApproval[];
  command: string;
  cosmicMode: CosmicMode;
  error: string;
  inputRef: RefObject<HTMLInputElement | null>;
  isDemo: boolean;
  listeningAutomatically: boolean;
  partialTranscript: string;
  phaseLabel: string;
  reasoningTrace: string;
  stage: JarvisStage;
  statusDetail: string;
  thinkingMode: boolean;
  transcript: TranscriptLine[];
  voice: VoiceReadout;
  wakeFlash: boolean;
  onApproval: (approval: PendingApproval, approved: boolean) => void;
  onCommandChange: (command: string) => void;
  onCosmicModeChange: (mode: CosmicMode) => void;
  onMicrophoneDown: () => void;
  onMicrophoneUp: () => void;
  onSubmit: () => void;
  onThinkingModeChange: (thinking: boolean) => void;
}

interface StageCopy {
  headline: string;
  emphasis: string;
  caption: string;
}

const STAGE_COPY: Record<JarvisStage, StageCopy> = {
  READY: { headline: 'At your', emphasis: 'command.', caption: 'A little space for your next big thought.' },
  HEARING: { headline: 'The floor', emphasis: 'is yours.', caption: 'Listening. Every thought has a place here.' },
  THINKING: { headline: 'Connecting', emphasis: 'the dots.', caption: 'A thought taking shape, one connection at a time.' },
  RESPONDING: { headline: 'Connecting', emphasis: 'the dots.', caption: 'A thought taking shape, one connection at a time.' },
  SPEAKING: { headline: 'A thought,', emphasis: 'made clear.', caption: 'From a little curiosity to a clearer perspective.' },
  ERROR: { headline: 'Let’s find', emphasis: 'our way back.', caption: 'The diagnostic details are available below.' },
};

const PREVIEW_STAGES: readonly JarvisStage[] = ['READY', 'HEARING', 'THINKING', 'SPEAKING', 'ERROR'];
const SCENE_MODE_KEY = 'astrono-appearance-scene';
const SCENE_QUALITY_KEY = 'astrono-appearance-quality';

export const initialSceneMode = (): CosmicMode => {
  const saved = localStorage.getItem(SCENE_MODE_KEY);
  if (saved === null || saved === 'BLACK_HOLE') return 'BLACK_HOLE';
  if (saved === 'SOLAR_SYSTEM') return 'SOLAR_SYSTEM';
  throw new Error(`The saved scene preference is invalid. Clear ${SCENE_MODE_KEY} in browser storage.`);
};

const initialSceneQuality = (): SceneQuality => {
  const saved = localStorage.getItem(SCENE_QUALITY_KEY);
  if (saved === null || saved === 'balanced') return 'balanced';
  if (saved === 'high') return 'high';
  throw new Error(`The saved render-quality preference is invalid. Clear ${SCENE_QUALITY_KEY} in browser storage.`);
};

const initialPreviewStage = (): JarvisStage => {
  const requested = new URLSearchParams(window.location.search).get('stage');
  return PREVIEW_STAGES.find((stage) => stage === requested) ?? 'READY';
};

/** Synthetic analyser data belongs exclusively to the labelled appearance preview. */
const previewSpectrum = (stage: JarvisStage, timeMs: number): Uint8Array | null => {
  if (stage !== 'HEARING' && stage !== 'SPEAKING') return null;
  const bins = new Uint8Array(128);
  const time = timeMs / 1000;
  const envelope = 0.25 + Math.pow(0.5 + Math.sin(time * 3.3) * 0.5, 2) * 0.55;
  for (let index = 0; index < bins.length; index += 1) {
    const wave = 0.5 + 0.5 * Math.sin(time * 4.0 + index * 0.21);
    bins[index] = Math.round(255 * wave * envelope * Math.exp(-index / 60));
  }
  return bins;
};

const keepControlKeysLocal = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.code !== 'Space') return;
  const target = event.target;
  if (target instanceof HTMLElement && !target.closest('.jarvis-ptt') && target.closest('button,a,input,select,textarea')) event.stopPropagation();
};

export function JarvisSurface(props: JarvisSurfaceProps) {
  const [panel, setPanel] = useState<'transcript' | 'approvals' | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [quality, setQuality] = useState<SceneQuality>(initialSceneQuality);
  const [viewRequest, setViewRequest] = useState<ViewRequest>({ command: 'reset', revision: 0 });
  const [previewStage, setPreviewStage] = useState<JarvisStage>(initialPreviewStage);
  const [previewStarted, setPreviewStarted] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const surface = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const transcriptButton = useRef<HTMLButtonElement>(null);
  const approvalButton = useRef<HTMLButtonElement>(null);
  const previousPanel = useRef<'transcript' | 'approvals' | null>(null);
  const stage = props.isDemo ? previewStage : props.stage;
  const copy = STAGE_COPY[stage];
  const phase = stage === 'RESPONDING' ? 'THINKING' : stage;
  const phaseLabel = props.isDemo
    ? `${phase}${phase === 'READY' || phase === 'ERROR' ? '' : ` · ${((now - previewStarted) / 1000).toFixed(1)}s`}`
    : props.phaseLabel;
  const spectrum = useCallback((): Uint8Array | null => previewSpectrum(stage, performance.now()), [stage]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const fitViewport = (): void => {
      const height = viewport ? viewport.height : window.innerHeight;
      surface.current?.style.setProperty('--orbit-viewport-height', `${height}px`);
      setCompact(height < 650);
    };
    fitViewport();
    viewport?.addEventListener('resize', fitViewport);
    window.addEventListener('resize', fitViewport);
    return () => {
      viewport?.removeEventListener('resize', fitViewport);
      window.removeEventListener('resize', fitViewport);
    };
  }, []);

  useEffect(() => {
    if (!props.isDemo) return;
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [props.isDemo]);

  useEffect(() => {
    localStorage.setItem(SCENE_MODE_KEY, props.cosmicMode);
    localStorage.setItem(SCENE_QUALITY_KEY, quality);
  }, [props.cosmicMode, quality]);

  useEffect(() => {
    if (!props.isDemo) return;
    const keepPreviewSilent = (event: globalThis.KeyboardEvent): void => {
      if (event.code === 'Space') event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', keepPreviewSilent, true);
    window.addEventListener('keyup', keepPreviewSilent, true);
    return () => {
      window.removeEventListener('keydown', keepPreviewSilent, true);
      window.removeEventListener('keyup', keepPreviewSilent, true);
    };
  }, [props.isDemo]);

  useEffect(() => {
    if (panel) closeButton.current?.focus();
    else if (previousPanel.current === 'transcript') transcriptButton.current?.focus();
    else if (previousPanel.current === 'approvals') approvalButton.current?.focus();
    previousPanel.current = panel;
  }, [panel]);

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { setPanel(null); setDiagnosticsOpen(false); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const requestView = (command: ViewCommand): void => {
    setViewRequest((current) => ({ command, revision: current.revision + 1 }));
  };

  const orbitWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const directions: Record<string, ViewCommand> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'reset' };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    requestView(direction);
  };

  return (
    <main ref={surface} className={`jarvis-console ${props.wakeFlash ? 'is-wake-detected' : ''}`} data-stage={phase} data-preview={props.isDemo} data-compact={compact} onKeyDown={keepControlKeysLocal} onKeyUp={keepControlKeysLocal}>
      <div className="jarvis-space-wash" aria-hidden="true" />
      <CosmicVisualizer
        getFrequencyData={props.isDemo ? spectrum : props.voice.getOutputData}
        getMicData={props.isDemo ? spectrum : props.voice.getMicData}
        mode={props.cosmicMode}
        quality={quality}
        stage={stage}
        viewRequest={viewRequest}
      />
      <div className="jarvis-console__vignette" aria-hidden="true" />

      <header className="jarvis-header">
        <div className="jarvis-brand">
          <img src="/astrono-black-hole.png" alt="" />
          <span>astrono<span className="jarvis-brand__suffix">jarvis</span></span>
          <small>YOUR PERSONAL OBSERVATORY</small>
        </div>
        <nav className="jarvis-navigation" aria-label="Assistant workspace">
          <span className="jarvis-navigation__current"><Compass size={16} /> Observatory</span>
          <button ref={transcriptButton} type="button" aria-expanded={panel === 'transcript'} aria-controls="jarvis-context-panel" onClick={() => setPanel(panel === 'transcript' ? null : 'transcript')}><ChatCircleText size={17} /> Transcript</button>
          <button ref={approvalButton} type="button" aria-expanded={panel === 'approvals'} aria-controls="jarvis-context-panel" onClick={() => setPanel(panel === 'approvals' ? null : 'approvals')}><ShieldCheck size={17} /> Approvals <b>{props.approvals.length}</b></button>
        </nav>
        <div className="jarvis-header__status">
          <span className={`jarvis-wake-status jarvis-wake-status--${props.voice.wakeStatus.toLowerCase()}`}><i />{props.isDemo ? 'Visual preview' : `Wake ${props.voice.wakeStatus.toLowerCase()}`}</span>
          <time>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          <a href="/settings" aria-label="Open settings" className="jarvis-icon-button"><GearSix size={20} /></a>
        </div>
      </header>

      <section className="jarvis-workspace" aria-label="Observatory">
        <div className="jarvis-introduction">
          <div className="jarvis-eyebrow"><span /> ASTRONOMICAL INTELLIGENCE</div>
          <h1 key={phase}>{copy.headline}<em>{copy.emphasis}</em></h1>
          <p>{copy.caption}</p>
          <div className="jarvis-phase-path" aria-label="Assistant phase">
            <span className={phase === 'HEARING' ? 'is-active' : ''}><Ear size={15} /> Listen</span>
            <i />
            <span className={phase === 'THINKING' ? 'is-active' : ''}><Brain size={15} /> Think</span>
            <i />
            <span className={phase === 'SPEAKING' ? 'is-active' : ''}><Waveform size={15} /> Speak</span>
          </div>
        </div>

        <div className="jarvis-scene-caption" aria-hidden="true">
          <span>{props.cosmicMode === 'BLACK_HOLE' ? '01 / THE SINGULARITY' : '02 / THE SOLAR SYSTEM'}</span>
          <p>{props.cosmicMode === 'BLACK_HOLE' ? 'A quiet kind of gravity.' : 'A different perspective.'}</p>
          <div />
        </div>

        <div className="jarvis-core" tabIndex={0} onKeyDown={orbitWithKeyboard} aria-label="Scene controls: drag to orbit, scroll to zoom, use arrow keys to rotate and Home to reset">
          <div className="jarvis-drag-hint"><Compass size={14} /> DRAG TO EXPLORE</div>
          <div className="jarvis-state" role="status" aria-live="polite">
            <span className="jarvis-state__dot" />
            <span aria-hidden="true">{phaseLabel}</span>
            <span className="sr-only">{phase}</span>
            <p>{props.isDemo ? 'Appearance preview. No microphone or actions run.' : props.statusDetail}</p>
          </div>
        </div>

        <div className="jarvis-scene-tools">
          <div className="jarvis-mode-toggle" role="group" aria-label="JARVIS visualizer mode">
            <button type="button" aria-pressed={props.cosmicMode === 'BLACK_HOLE'} onClick={() => props.onCosmicModeChange('BLACK_HOLE')}><Sparkle size={15} /> Black hole</button>
            <button type="button" aria-pressed={props.cosmicMode === 'SOLAR_SYSTEM'} onClick={() => props.onCosmicModeChange('SOLAR_SYSTEM')}><Sun size={15} /> Solar system</button>
          </div>
          <button className="jarvis-icon-button" type="button" aria-label="Reset scene view" onClick={() => requestView('reset')}><ArrowClockwise size={17} /></button>
          <button className="jarvis-quality-button" type="button" aria-label={`Scene quality: ${quality}. Switch to ${quality === 'balanced' ? 'high' : 'balanced'} quality`} onClick={() => setQuality(quality === 'balanced' ? 'high' : 'balanced')}><SlidersHorizontal size={16} /><span>{quality === 'balanced' ? 'Balanced' : 'Detail'}</span></button>
        </div>

        {props.approvals.length > 0 && panel !== 'approvals' && (
          <button type="button" className="jarvis-pending-card" onClick={() => setPanel('approvals')}>
            <span className="jarvis-pending-card__icon"><ShieldCheck size={20} /></span>
            <span><small>YOUR PERMISSION, FIRST</small><strong>{props.approvals.length} action{props.approvals.length === 1 ? '' : 's'} awaiting approval</strong></span>
            <ArrowUpRight size={19} />
          </button>
        )}

        {props.reasoningTrace && (
          <details className="jarvis-reasoning">
            <summary><Brain size={15} /> Thinking trace <span>View reasoning</span></summary>
            <p>{props.reasoningTrace}</p>
          </details>
        )}
        {props.wakeFlash && <div className="jarvis-wake-cue" role="status">Wake phrase confirmed<small>Confidence {Math.round(props.voice.wakeScore * 100)}%</small></div>}
      </section>

      {panel && (
        <aside className="jarvis-context-panel" id="jarvis-context-panel" aria-label={panel === 'transcript' ? 'Live transcript' : 'Approval queue'}>
          <div className="jarvis-panel-heading"><span>{panel === 'transcript' ? <ChatCircleText size={19} /> : <ShieldCheck size={19} />}{panel === 'transcript' ? 'The conversation' : 'Your approval queue'}</span><button ref={closeButton} type="button" className="jarvis-icon-button" aria-label="Close panel" onClick={() => setPanel(null)}><X size={19} /></button></div>
          {panel === 'transcript' ? (
            <div className="jarvis-transcript">
              {props.transcript.length === 0 && <div className="jarvis-transcript-empty"><ChatCircleText size={28} /><h2>A conversation starts here.</h2><p>Your words and Jarvis’s responses will appear in this space.</p></div>}
              {props.transcript.map((line, index) => <article key={`${line.speaker}-${index}`}><span>{line.speaker === 'YOU' ? 'You' : 'Jarvis'}</span><p>{line.text || '…'}</p></article>)}
              {props.partialTranscript && <article className="jarvis-transcript__partial"><span>Live</span><p>{props.partialTranscript}</p></article>}
            </div>
          ) : (
            <div className="jarvis-approval">
              <p className="jarvis-panel-description">Consequential changes wait for your permission.</p>
              {props.approvals.slice(0, 1).map((approval) => (
                <article key={approval.id}>
                  <small>{approval.action_type.replace(/_/g, ' ')}{approval.status === 'approved' ? ' · retryable' : ''}</small>
                  <p>{approval.description}</p>
                  <div><button type="button" onClick={() => props.onApproval(approval, false)}><X size={16} /> Deny</button><button type="button" onClick={() => props.onApproval(approval, true)}><Check size={16} />{approval.status === 'approved' ? 'Retry' : 'Approve'}</button></div>
                </article>
              ))}
              {props.approvals.length === 0 && <div className="jarvis-transcript-empty"><ShieldCheck size={28} /><h2>Nothing waiting on you.</h2><p>Requests that need permission will appear here.</p></div>}
            </div>
          )}
        </aside>
      )}

      <footer className="jarvis-command">
        <div className="jarvis-command-topline">
          <div className="jarvis-command-caption"><span className="jarvis-mini-star">✦</span> A thought away.</div>
          <div className="jarvis-mode-toggle jarvis-cognition" role="group" aria-label="JARVIS thinking mode">
            <button type="button" aria-pressed={!props.thinkingMode} onClick={() => props.onThinkingModeChange(false)}>Instant</button>
            <button type="button" aria-pressed={props.thinkingMode} onClick={() => props.onThinkingModeChange(true)}><Brain size={13} /> Thinking</button>
          </div>
        </div>
        <div className="jarvis-command-dock">
          <form onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
            <span className="jarvis-command__prompt"><Sparkle size={21} /></span>
            <input aria-label="Type a command" placeholder="What’s on your mind?" ref={props.inputRef} value={props.command} onChange={(event) => props.onCommandChange(event.target.value)} />
            <button type="submit" aria-label="Send command" className="jarvis-send-button"><PaperPlaneRight size={20} /></button>
          </form>
          <div className="jarvis-dock-divider" />
          <button className={`jarvis-ptt ${props.voice.isListening ? 'is-capturing' : ''}`} type="button" disabled={props.isDemo} onPointerDown={props.onMicrophoneDown} onPointerUp={props.onMicrophoneUp} onPointerCancel={props.onMicrophoneUp} aria-label="Hold to talk">
            <Microphone size={21} weight="fill" /><span>{props.voice.isListening && !props.listeningAutomatically ? 'Release to send' : 'Hold to talk'}<kbd>SPACE</kbd></span>
          </button>
        </div>
        <div className="jarvis-command-bottomline">
          <div className="jarvis-mic-readout"><MicWaveform active={props.isDemo ? stage === 'HEARING' : props.voice.isListening || props.voice.wakeStatus === 'ARMED'} getFrequencyData={props.isDemo ? spectrum : props.voice.getMicData} /><span>{props.isDemo ? 'Preview signal' : props.voice.isListening ? 'Microphone active' : 'Say “Hey Jarvis”'}</span></div>
          <button className="jarvis-diagnostics-toggle" type="button" aria-expanded={diagnosticsOpen} onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}><Cpu size={13} /> System details <span>{props.error || props.voice.wakeError ? '!' : '↗'}</span></button>
        </div>
        {diagnosticsOpen && (
          <div className="jarvis-diagnostics" role="region" aria-label="System diagnostics">
            <div><span>Wake word</span><strong>{props.voice.wakeStatus} · openWakeWord</strong></div>
            <div><span>Transcription</span><strong>Whisper local</strong></div>
            <div><span>Voice</span><strong>{props.voice.voiceBackend || 'Not started'}</strong></div>
            <div><span>Model</span><strong>{props.activeModel}</strong></div>
            <div><span>Voice activity</span><strong>P {props.voice.vadProbability.toFixed(3)} · {props.voice.vadRmsDbfs.toFixed(1)} dB · {props.voice.vadSilenceMs} ms · {props.voice.vadActive ? 'Speech' : 'Quiet'}</strong></div>
          </div>
        )}
        {(props.error || props.voice.wakeError) && <p className="jarvis-error" role="alert">{props.error || props.voice.wakeError}</p>}
      </footer>

      {props.isDemo && (
        <div className="jarvis-appearance-preview" role="group" aria-label="Appearance preview stage">
          <span>APPEARANCE PREVIEW</span>
          {PREVIEW_STAGES.map((preview) => <button key={preview} type="button" aria-pressed={previewStage === preview} onClick={() => { setPreviewStage(preview); setPreviewStarted(Date.now()); }}>{preview === 'HEARING' ? 'Listening' : preview.charAt(0) + preview.slice(1).toLowerCase()}</button>)}
          <a href="/" aria-label="Open the live assistant">Live <ArrowUpRight size={13} /></a>
        </div>
      )}
    </main>
  );
}
