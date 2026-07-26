class WakeWordProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pendingSamples = [];
    this.sourceRate = sampleRate;
    this.targetRate = 16000;
    this.frameSamples = 1280;
    this.resamplePosition = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    const ratio = this.sourceRate / this.targetRate;
    while (this.resamplePosition < input.length) {
      const sourceIndex = Math.floor(this.resamplePosition);
      const nextIndex = Math.min(sourceIndex + 1, input.length - 1);
      const fraction = this.resamplePosition - sourceIndex;
      const sample =
        input[sourceIndex] +
        (input[nextIndex] - input[sourceIndex]) * fraction;
      this.pendingSamples.push(
        Math.max(-32768, Math.min(32767, Math.round(sample * 32767))),
      );
      this.resamplePosition += ratio;
    }
    this.resamplePosition -= input.length;

    while (this.pendingSamples.length >= this.frameSamples) {
      const frame = new Int16Array(
        this.pendingSamples.splice(0, this.frameSamples),
      );
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor('wake-word-processor', WakeWordProcessor);
