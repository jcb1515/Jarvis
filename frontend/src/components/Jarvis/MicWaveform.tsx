import { useEffect, useRef } from 'react';

interface MicWaveformProps {
  active: boolean;
  getFrequencyData: () => Uint8Array | null;
}

const drawWaveform = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frequencyData: Uint8Array | null,
  active: boolean,
  timeSeconds: number,
): void => {
  context.clearRect(0, 0, width, height);
  const barCount = Math.max(24, Math.floor(width / 10));
  const gap = 3;
  const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
  const gradient = context.createLinearGradient(0, height, width, 0);
  gradient.addColorStop(0, '#2c6b9d');
  gradient.addColorStop(0.48, '#75d7ff');
  gradient.addColorStop(1, '#d5f6ff');
  context.fillStyle = gradient;
  context.shadowColor = '#51cfff';
  context.shadowBlur = active ? 12 : 4;

  for (let index = 0; index < barCount; index += 1) {
    const sourceIndex = frequencyData
      ? Math.min(
          frequencyData.length - 1,
          Math.floor((index / barCount) * frequencyData.length * 0.72),
        )
      : 0;
    const liveValue = frequencyData ? frequencyData[sourceIndex] / 255 : 0;
    const idleValue =
      0.05 + Math.abs(Math.sin(timeSeconds * 0.8 + index * 0.38)) * 0.025;
    const value = active ? Math.max(0.07, liveValue) : idleValue;
    const barHeight = Math.max(2, value * height * 0.86);
    const x = index * (barWidth + gap);
    const y = (height - barHeight) / 2;
    context.globalAlpha = 0.42 + value * 0.58;
    context.beginPath();
    context.roundRect(x, y, barWidth, barHeight, Math.min(3, barWidth / 2));
    context.fill();
  }
  context.globalAlpha = 1;
  context.shadowBlur = 0;
};

export function MicWaveform({
  active,
  getFrequencyData,
}: MicWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('The browser could not create the microphone visualizer.');
    }

    let animationFrame = 0;
    const render = (time: number): void => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio, 2);
      const width = Math.max(1, Math.floor(rect.width * pixelRatio));
      const height = Math.max(1, Math.floor(rect.height * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      drawWaveform(
        context,
        width,
        height,
        getFrequencyData(),
        active,
        time / 1000,
      );
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, getFrequencyData]);

  return (
    <canvas
      aria-label="Live microphone spectrum"
      className="jarvis-mic-waveform"
      ref={canvasRef}
      role="img"
    />
  );
}
