import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createTranscriptionStream,
  openSpeechStream,
  transcribeAudio,
} from '../../lib/api';
import type { TranscriptionStream } from '../../lib/api';

interface RecorderState {
  analyser: AnalyserNode;
  context: AudioContext;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  partialTimer: number;
  partialInFlight: boolean;
  stopped: boolean;
  transcriptionStream: TranscriptionStream;
}

const readAnalyser = (
  analyser: AnalyserNode | null,
  bufferRef: React.MutableRefObject<Uint8Array | null>,
): Uint8Array | null => {
  if (!analyser) return null;
  if (!bufferRef.current || bufferRef.current.length !== analyser.frequencyBinCount) {
    bufferRef.current = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(bufferRef.current);
  return bufferRef.current;
};

export function useVoicePipeline() {
  const recorderRef = useRef<RecorderState | null>(null);
  const micBufferRef = useRef<Uint8Array | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputBufferRef = useRef<Uint8Array | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceBackend, setVoiceBackend] = useState('standby');
  const [vadActive, setVadActive] = useState(false);

  const getMicData = useCallback(
    () => readAnalyser(recorderRef.current?.analyser ?? null, micBufferRef),
    [],
  );
  const getOutputData = useCallback(
    () => readAnalyser(outputAnalyserRef.current, outputBufferRef),
    [],
  );

  const startListening = useCallback(async (
    onPartialTranscript: (text: string) => void,
    onPartialError: (error: Error) => void,
  ): Promise<void> => {
    if (recorderRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let transcriptionStream: TranscriptionStream;
    try {
      transcriptionStream = await createTranscriptionStream(
        (result) => {
          const text = result.text.trim();
          if (text) onPartialTranscript(text);
          setVadActive(result.speech_active === true);
        },
        onPartialError,
      );
    } catch (caught) {
      stream.getTracks().forEach((track) => track.stop());
      throw caught;
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start(200);
    const state: RecorderState = {
      analyser,
      context,
      recorder,
      stream,
      chunks,
      partialTimer: 0,
      partialInFlight: false,
      stopped: false,
      transcriptionStream,
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
        onPartialError(
          caught instanceof Error
            ? caught
            : new Error('Partial Whisper transcription failed.'),
        );
      } finally {
        state.partialInFlight = false;
      }
    }, 1800);
    recorderRef.current = state;
    setIsListening(true);
  }, []);

  const stopListening = useCallback(async (): Promise<string> => {
    const state = recorderRef.current;
    if (!state) return '';
    state.stopped = true;
    window.clearInterval(state.partialTimer);
    state.transcriptionStream.close();
    const stopped = new Promise<void>((resolve) => {
      state.recorder.addEventListener('stop', () => resolve(), { once: true });
    });
    state.recorder.stop();
    await stopped;
    const audio = new Blob(state.chunks, {
      type: state.recorder.mimeType || 'audio/webm',
    });
    state.stream.getTracks().forEach((track) => track.stop());
    await state.context.close();
    recorderRef.current = null;
    setIsListening(false);
    setVadActive(false);
    if (audio.size === 0) throw new Error('The microphone recording was empty.');
    const transcription = await transcribeAudio(audio, 'jarvis-command.webm');
    return transcription.text.trim();
  }, []);

  const speak = useCallback(async (text: string): Promise<void> => {
    const result = await openSpeechStream(text, '', 0.92);
    setVoiceBackend(result.backend);
    const audio = new Audio();
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    analyser.connect(context.destination);
    outputAnalyserRef.current = analyser;
    outputContextRef.current = context;
    setIsSpeaking(true);
    const playbackFinished = new Promise<void>((resolve, reject) => {
      audio.addEventListener('ended', () => resolve(), { once: true });
      audio.addEventListener(
        'error',
        () => reject(new Error('The synthesized audio could not be played.')),
        { once: true },
      );
    });

    let audioUrl = '';
    try {
      if (result.streaming) {
        if (!result.response.body) {
          throw new Error('ElevenLabs returned an empty streaming response.');
        }
        if (!MediaSource.isTypeSupported('audio/mpeg')) {
          throw new Error(
            'This browser cannot stream MPEG audio with MediaSource.',
          );
        }
        const mediaSource = new MediaSource();
        audioUrl = URL.createObjectURL(mediaSource);
        audio.src = audioUrl;
        await new Promise<void>((resolve) => {
          mediaSource.addEventListener('sourceopen', () => resolve(), {
            once: true,
          });
        });
        const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        const reader = result.response.body.getReader();
        let playbackStarted = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await new Promise<void>((resolve, reject) => {
            sourceBuffer.addEventListener('updateend', () => resolve(), {
              once: true,
            });
            sourceBuffer.addEventListener(
              'error',
              () => reject(new Error('Could not buffer streamed voice audio.')),
              { once: true },
            );
            sourceBuffer.appendBuffer(value.slice().buffer);
          });
          if (!playbackStarted) {
            playbackStarted = true;
            await audio.play();
          }
        }
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } else {
        const audioBlob = await result.response.blob();
        audioUrl = URL.createObjectURL(audioBlob);
        audio.src = audioUrl;
        await audio.play();
      }

      await playbackFinished;
    } finally {
      setIsSpeaking(false);
      outputAnalyserRef.current = null;
      await context.close();
      outputContextRef.current = null;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    }
  }, []);

  useEffect(
    () => () => {
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      if (recorderRef.current) {
        window.clearInterval(recorderRef.current.partialTimer);
        recorderRef.current.transcriptionStream.close();
      }
      void recorderRef.current?.context.close();
      void outputContextRef.current?.close();
    },
    [],
  );

  return {
    getMicData,
    getOutputData,
    isListening,
    isSpeaking,
    speak,
    startListening,
    stopListening,
    voiceBackend,
    vadActive,
  };
}
