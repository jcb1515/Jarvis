import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createTranscriptionStream,
  createVadStream,
  createWakeWordStream,
  openSpeechStream,
  transcribeAudio,
} from '../../lib/api';
import type {
  JarvisRuntimeState,
  TranscriptionStream,
  VadStream,
  WakeWordStream,
} from '../../lib/api';

type WakeStatus = 'OFF' | 'STARTING' | 'ARMED' | 'PAUSED' | 'ERROR';

interface RuntimeTransition {
  stage: JarvisRuntimeState;
  startedAtMs: number;
}

interface RecorderState {
  analyser: AnalyserNode;
  chunks: Blob[];
  context: AudioContext;
  ownsAudioResources: boolean;
  recorder: MediaRecorder;
  stream: MediaStream;
  partialTimer: number;
  partialInFlight: boolean;
  stopped: boolean;
  transcriptionStream: TranscriptionStream;
  vadStream: VadStream;
  autoStop: boolean;
  onSpeechEnd: () => void;
  speechEndRequested: boolean;
}

interface WakeMonitorState {
  analyser: AnalyserNode;
  context: AudioContext;
  mutedOutput: GainNode;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
  wakeStream: WakeWordStream;
  worklet: AudioWorkletNode;
}

interface ListeningOptions {
  autoStop: boolean;
  onPartialError: (error: Error) => void;
  onPartialTranscript: (text: string) => void;
  onSpeechEnd: () => void;
}

interface SpeechPlaybackOptions {
  onPlaybackStart: () => void;
}

interface SpeechPlaybackMetadata {
  backend: string;
  streaming: boolean;
  voice: string;
}

interface PlaybackObserver {
  cancel: () => void;
  completion: Promise<void>;
}

const SPEECH_STALL_CHECK_INTERVAL_MS = 500;
const SPEECH_STALL_WINDOW_MS = 6_000;
const PLAYBACK_PROGRESS_EPSILON_SECONDS = 0.02;

const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  autoGainControl: true,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
};

const readAnalyser = (
  analyser: AnalyserNode | null,
  bufferRef: React.MutableRefObject<Uint8Array | null>,
): Uint8Array | null => {
  if (!analyser) return null;
  if (
    !bufferRef.current ||
    bufferRef.current.length !== analyser.frequencyBinCount
  ) {
    bufferRef.current = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(bufferRef.current);
  return bufferRef.current;
};

const stopStream = (stream: MediaStream): void => {
  stream.getTracks().forEach((track) => track.stop());
};

const toError = (caught: unknown, fallbackMessage: string): Error =>
  caught instanceof Error ? caught : new Error(fallbackMessage);

const describeMediaError = (audio: HTMLAudioElement): Error => {
  const code = audio.error?.code ?? 0;
  const labels: Record<number, string> = {
    1: 'aborted',
    2: 'network',
    3: 'decode',
    4: 'source-not-supported',
  };
  return new Error(
    [
      'The synthesized audio element emitted an error.',
      `code=${code}`,
      `kind=${labels[code] ?? 'unknown'}`,
      `networkState=${audio.networkState}`,
      `readyState=${audio.readyState}`,
    ].join(' '),
  );
};

const createPlaybackObserver = (
  audio: HTMLAudioElement,
  context: AudioContext,
  metadata: SpeechPlaybackMetadata,
  onPlaybackStart: () => void,
): PlaybackObserver => {
  let settled = false;
  let started = false;
  let lastCurrentTime = audio.currentTime;
  let lastProgressAtMs = Date.now();
  let resolveCompletion: () => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const removeListeners = (): void => {
    audio.removeEventListener('playing', handlePlaying);
    audio.removeEventListener('ended', handleEnded);
    audio.removeEventListener('error', handleError);
  };
  const settle = (error: Error | null): void => {
    if (settled) return;
    settled = true;
    window.clearInterval(stallIntervalId);
    removeListeners();
    if (error) {
      rejectCompletion(error);
      return;
    }
    resolveCompletion();
  };
  const handlePlaying = (): void => {
    if (started) return;
    started = true;
    lastCurrentTime = audio.currentTime;
    lastProgressAtMs = Date.now();
    console.info('JARVIS audio playback started', {
      ...metadata,
      contextState: context.state,
      currentTime: audio.currentTime,
      readyState: audio.readyState,
    });
    onPlaybackStart();
  };
  const handleEnded = (): void => {
    console.info('JARVIS audio playback ended', {
      ...metadata,
      contextState: context.state,
      currentTime: audio.currentTime,
      duration: audio.duration,
    });
    settle(null);
  };
  const handleError = (): void => {
    const error = describeMediaError(audio);
    console.error('JARVIS audio element error', {
      ...metadata,
      contextState: context.state,
      error: error.message,
    });
    settle(error);
  };
  const stallIntervalId = window.setInterval(() => {
    const currentTime = audio.currentTime;
    if (
      currentTime >
      lastCurrentTime + PLAYBACK_PROGRESS_EPSILON_SECONDS
    ) {
      lastCurrentTime = currentTime;
      lastProgressAtMs = Date.now();
      return;
    }
    const stalledForMs = Date.now() - lastProgressAtMs;
    if (stalledForMs < SPEECH_STALL_WINDOW_MS) return;
    const error = new Error(
      `Speech playback made no progress for ${SPEECH_STALL_WINDOW_MS} ms.`,
    );
    console.error('JARVIS audio playback stalled', {
      ...metadata,
      contextState: context.state,
      currentTime,
      networkState: audio.networkState,
      playbackStarted: started,
      readyState: audio.readyState,
      stalledForMs,
    });
    settle(error);
  }, SPEECH_STALL_CHECK_INTERVAL_MS);

  audio.addEventListener('playing', handlePlaying);
  audio.addEventListener('ended', handleEnded);
  audio.addEventListener('error', handleError);

  return {
    cancel: () => settle(null),
    completion,
  };
};

const ensureAudioContextRunning = async (
  context: AudioContext,
  metadata: SpeechPlaybackMetadata,
): Promise<void> => {
  console.info('JARVIS audio context before playback', {
    ...metadata,
    contextState: context.state,
  });
  if (context.state === 'closed') {
    throw new Error(
      'The Web Audio context was closed before synthesized speech playback.',
    );
  }
  if (context.state !== 'running') await context.resume();
  if (context.state !== 'running') {
    throw new Error(
      `The Web Audio context did not resume. contextState=${context.state}`,
    );
  }
  console.info('JARVIS audio context confirmed running before playback', {
    ...metadata,
    contextState: context.state,
  });
};

const startAudioPlayback = async (
  audio: HTMLAudioElement,
  context: AudioContext,
  metadata: SpeechPlaybackMetadata,
): Promise<void> => {
  await ensureAudioContextRunning(context, metadata);
  try {
    await audio.play();
  } catch (caught) {
    const error = toError(
      caught,
      'The browser rejected the synthesized audio play request.',
    );
    console.error('JARVIS audio play promise rejected', {
      ...metadata,
      contextState: context.state,
      error: error.message,
    });
    throw error;
  }
};

const blobToDataUrl = async (blob: Blob): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      'load',
      () => {
        if (typeof reader.result !== 'string') {
          reject(
            new Error(
              'The synthesized audio could not be converted to a playable data URL.',
            ),
          );
          return;
        }
        resolve(reader.result);
      },
      { once: true },
    );
    reader.addEventListener(
      'error',
      () => {
        reject(
          new Error(
            `The synthesized audio could not be read: ${reader.error?.message ?? 'unknown FileReader error'}`,
          ),
        );
      },
      { once: true },
    );
    reader.readAsDataURL(blob);
  });

const finalizeRecorderCapture = async (
  state: RecorderState,
): Promise<Blob> => {
  state.stopped = true;
  window.clearInterval(state.partialTimer);
  state.transcriptionStream.close();
  state.vadStream.close();
  const stopped = new Promise<void>((resolve) => {
    state.recorder.addEventListener('stop', () => resolve(), { once: true });
  });
  state.recorder.stop();
  await stopped;
  const audio = new Blob(state.chunks, {
    type: state.recorder.mimeType || 'audio/webm',
  });
  if (state.ownsAudioResources) {
    stopStream(state.stream);
    await state.context.close();
  }
  return audio;
};

const disposeWakeMonitor = async (
  monitor: WakeMonitorState,
): Promise<void> => {
  monitor.wakeStream.close();
  monitor.worklet.disconnect();
  monitor.source.disconnect();
  monitor.mutedOutput.disconnect();
  stopStream(monitor.stream);
  await monitor.context.close();
};

export function useVoicePipeline() {
  const recorderRef = useRef<RecorderState | null>(null);
  const wakeMonitorRef = useRef<WakeMonitorState | null>(null);
  const wakeStartingRef = useRef<Promise<void> | null>(null);
  const wakePausedRef = useRef(false);
  const micBufferRef = useRef<Uint8Array | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputBufferRef = useRef<Uint8Array | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceBackend, setVoiceBackend] = useState('standby');
  const [vadActive, setVadActive] = useState(false);
  const [vadProbability, setVadProbability] = useState(0);
  const [vadRmsDbfs, setVadRmsDbfs] = useState(-120);
  const [vadSilenceMs, setVadSilenceMs] = useState(0);
  const [wakeStatus, setWakeStatus] = useState<WakeStatus>('OFF');
  const [wakeError, setWakeError] = useState('');
  const [wakeSequence, setWakeSequence] = useState(0);
  const [wakeScore, setWakeScore] = useState(0);
  const [runtimeTransition, setRuntimeTransition] =
    useState<RuntimeTransition>({
      stage: 'READY',
      startedAtMs: Date.now(),
    });

  const getMicData = useCallback(
    () =>
      readAnalyser(
        wakeMonitorRef.current?.analyser ??
          recorderRef.current?.analyser ??
          null,
        micBufferRef,
      ),
    [],
  );

  const getOutputData = useCallback(
    () => readAnalyser(outputAnalyserRef.current, outputBufferRef),
    [],
  );

  const enableWakeWord = useCallback(async (): Promise<void> => {
    if (wakeMonitorRef.current) return;
    if (wakeStartingRef.current) return wakeStartingRef.current;

    const start = async (): Promise<void> => {
      setWakeStatus('STARTING');
      setWakeError('');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: MICROPHONE_CONSTRAINTS,
      });
      const context = new AudioContext();
      let wakeStream: WakeWordStream | null = null;
      try {
        await context.audioWorklet.addModule('/wake-word-worklet.js');
        wakeStream = await createWakeWordStream(
          (event) => {
            if (event.type === 'wake_loading') {
              setWakeStatus('STARTING');
              return;
            }
            if (event.type === 'wake_ready') {
              setWakeStatus(wakePausedRef.current ? 'PAUSED' : 'ARMED');
              return;
            }
            if (event.type === 'wake_detected') {
              setWakeScore(event.score);
              setWakeSequence((sequence) => sequence + 1);
              return;
            }
            setRuntimeTransition({
              stage: event.state,
              startedAtMs: event.started_at_ms,
            });
          },
          (error) => {
            const failedMonitor = wakeMonitorRef.current;
            wakeMonitorRef.current = null;
            if (failedMonitor) {
              void disposeWakeMonitor(failedMonitor).catch((cleanupError) => {
                const detail =
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : 'Unknown wake monitor cleanup error';
                setWakeError(
                  `${error.message} Cleanup also failed: ${detail}`,
                );
              });
            }
            setWakeError(error.message);
            setWakeStatus('ERROR');
          },
        );
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        const worklet = new AudioWorkletNode(context, 'wake-word-processor');
        const mutedOutput = context.createGain();
        mutedOutput.gain.value = 0;
        source.connect(analyser);
        source.connect(worklet);
        worklet.connect(mutedOutput);
        mutedOutput.connect(context.destination);
        worklet.port.addEventListener(
          'message',
          (event: MessageEvent<ArrayBuffer>) => {
            try {
              const recorder = recorderRef.current;
              if (recorder && !recorder.stopped) {
                recorder.vadStream.sendFrame(event.data);
                return;
              }
              if (wakePausedRef.current || !wakeMonitorRef.current) return;
              wakeMonitorRef.current.wakeStream.sendFrame(event.data);
            } catch (caught) {
              const error =
                caught instanceof Error
                  ? caught
                  : new Error('Could not send PCM audio to local speech detection.');
              setWakeError(error.message);
              setWakeStatus('ERROR');
            }
          },
        );
        worklet.port.start();
        wakeMonitorRef.current = {
          analyser,
          context,
          mutedOutput,
          source,
          stream,
          wakeStream,
          worklet,
        };
        if (context.state === 'suspended') await context.resume();
        setWakeStatus(wakePausedRef.current ? 'PAUSED' : 'ARMED');
      } catch (caught) {
        wakeStream?.close();
        stopStream(stream);
        await context.close();
        const error =
          caught instanceof Error
            ? caught
            : new Error('Could not initialize the wake-word listener.');
        setWakeError(error.message);
        setWakeStatus('ERROR');
        throw error;
      }
    };

    wakeStartingRef.current = start().finally(() => {
      wakeStartingRef.current = null;
    });
    return wakeStartingRef.current;
  }, []);

  const setWakePaused = useCallback((paused: boolean): void => {
    wakePausedRef.current = paused;
    const monitor = wakeMonitorRef.current;
    if (!monitor) return;
    try {
      monitor.wakeStream.reset();
      setWakeStatus(paused ? 'PAUSED' : 'ARMED');
    } catch (caught) {
      const error =
        caught instanceof Error
          ? caught
          : new Error('Could not update the wake-word listener.');
      setWakeError(error.message);
      setWakeStatus('ERROR');
    }
  }, []);

  const transitionState = useCallback((stage: JarvisRuntimeState): void => {
    const localTransition = { stage, startedAtMs: Date.now() };
    setRuntimeTransition(localTransition);
    const monitor = wakeMonitorRef.current;
    if (!monitor) return;
    try {
      monitor.wakeStream.transition(stage);
    } catch (caught) {
      const error =
        caught instanceof Error
          ? caught
          : new Error('Could not record the JARVIS state transition.');
      setWakeError(error.message);
      setWakeStatus('ERROR');
    }
  }, []);

  const resetListeningState = useCallback((): void => {
    recorderRef.current = null;
    setIsListening(false);
    setVadActive(false);
    setVadProbability(0);
    setVadRmsDbfs(-120);
    setVadSilenceMs(0);
  }, []);

  const startListening = useCallback(
    async (options: ListeningOptions): Promise<void> => {
      if (recorderRef.current) return;
      const monitor = wakeMonitorRef.current;
      const stream =
        monitor?.stream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: MICROPHONE_CONSTRAINTS,
        }));
      let transcriptionStream: TranscriptionStream | null = null;
      let vadStream: VadStream | null = null;
      try {
        transcriptionStream = await createTranscriptionStream(
          (result) => {
            const text = result.text.trim();
            if (text) options.onPartialTranscript(text);
          },
          options.onPartialError,
        );
        vadStream = await createVadStream(
          (event) => {
            setVadActive(event.speech_active);
            setVadProbability(event.probability);
            setVadRmsDbfs(event.rms_dbfs);
            setVadSilenceMs(event.trailing_silence_ms);
            console.debug('JARVIS VAD', {
              probability: event.probability,
              rmsDbfs: event.rms_dbfs,
              silenceMs: event.trailing_silence_ms,
              speechActive: event.speech_active,
              speechObserved: event.speech_observed,
              shouldStop: event.should_stop,
            });
            const state = recorderRef.current;
            if (
              !state ||
              !state.autoStop ||
              state.speechEndRequested ||
              !event.should_stop
            ) {
              return;
            }
            state.speechEndRequested = true;
            window.queueMicrotask(state.onSpeechEnd);
          },
          options.onPartialError,
        );
      } catch (caught) {
        transcriptionStream?.close();
        if (!monitor) stopStream(stream);
        throw caught;
      }
      if (!transcriptionStream || !vadStream) {
        throw new Error('Local speech streams did not initialize.');
      }

      const context = monitor?.context ?? new AudioContext();
      let analyser = monitor?.analyser;
      if (!analyser) {
        const source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);
      }
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.start(200);
      const state: RecorderState = {
        analyser,
        chunks,
        context,
        ownsAudioResources: !monitor,
        recorder,
        stream,
        partialTimer: 0,
        partialInFlight: false,
        stopped: false,
        transcriptionStream,
        vadStream,
        autoStop: options.autoStop,
        onSpeechEnd: options.onSpeechEnd,
        speechEndRequested: false,
      };
      state.partialTimer = window.setInterval(async () => {
        if (
          state.stopped ||
          state.partialInFlight ||
          state.chunks.length === 0
        ) {
          return;
        }
        state.partialInFlight = true;
        try {
          const partialAudio = new Blob([...state.chunks], {
            type: state.recorder.mimeType || 'audio/webm',
          });
          state.transcriptionStream.send(partialAudio);
        } catch (caught) {
          options.onPartialError(
            caught instanceof Error
              ? caught
              : new Error('Partial Whisper transcription failed.'),
          );
        } finally {
          state.partialInFlight = false;
        }
      }, 900);
      recorderRef.current = state;
      setIsListening(true);
    },
    [],
  );

  const stopListening = useCallback(async (): Promise<string> => {
    const state = recorderRef.current;
    if (!state || state.stopped) return '';
    const audio = await finalizeRecorderCapture(state);
    resetListeningState();
    if (audio.size === 0) {
      throw new Error('The microphone recording was empty.');
    }
    const transcription = await transcribeAudio(
      audio,
      'jarvis-command.webm',
    );
    return transcription.text.trim();
  }, [resetListeningState]);

  const cancelListening = useCallback(async (): Promise<void> => {
    const state = recorderRef.current;
    if (!state || state.stopped) return;
    await finalizeRecorderCapture(state);
    resetListeningState();
  }, [resetListeningState]);

  const speak = useCallback(
    async (
      text: string,
      options: SpeechPlaybackOptions,
    ): Promise<void> => {
      const result = await openSpeechStream(text, '', 0.92);
      const metadata: SpeechPlaybackMetadata = {
        backend: result.backend,
        streaming: result.streaming,
        voice: result.voice,
      };
      setVoiceBackend(result.backend);

      const audio = new Audio();
      const existingContext = outputContextRef.current;
      const context =
        existingContext && existingContext.state !== 'closed'
          ? existingContext
          : new AudioContext();
      outputContextRef.current = context;
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyser.connect(context.destination);
      outputAnalyserRef.current = analyser;

      const playback = createPlaybackObserver(
        audio,
        context,
        metadata,
        () => {
          setIsSpeaking(true);
          options.onPlaybackStart();
        },
      );

      try {
        const audioBlob = await result.response.blob();
        if (audioBlob.size === 0) {
          throw new Error('The synthesized speech response was empty.');
        }
        audio.src = await blobToDataUrl(audioBlob);
        audio.load();
        const playTask = startAudioPlayback(audio, context, metadata).then(
          () => playback.completion,
        );
        await Promise.race([playback.completion, playTask]);
      } catch (caught) {
        const error = toError(caught, 'Synthesized speech playback failed.');
        console.error('JARVIS speech playback failed', {
          ...metadata,
          contextState: context.state,
          error: error.message,
        });
        throw error;
      } finally {
        playback.cancel();
        setIsSpeaking(false);
        if (outputAnalyserRef.current === analyser) {
          outputAnalyserRef.current = null;
        }
        source.disconnect();
        analyser.disconnect();
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    },
    [],
  );

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder) {
        window.clearInterval(recorder.partialTimer);
        recorder.transcriptionStream.close();
        recorder.vadStream.close();
        if (recorder.ownsAudioResources) {
          stopStream(recorder.stream);
          void recorder.context.close();
        }
      }
      const monitor = wakeMonitorRef.current;
      if (monitor) {
        wakeMonitorRef.current = null;
        void disposeWakeMonitor(monitor);
      }
      void outputContextRef.current?.close();
    },
    [],
  );

  return {
    cancelListening,
    enableWakeWord,
    getMicData,
    getOutputData,
    isListening,
    isSpeaking,
    runtimeTransition,
    setWakePaused,
    speak,
    startListening,
    stopListening,
    transitionState,
    vadActive,
    vadProbability,
    vadRmsDbfs,
    vadSilenceMs,
    voiceBackend,
    wakeError,
    wakeScore,
    wakeSequence,
    wakeStatus,
  };
}
