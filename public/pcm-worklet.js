/* Audio stays in this page until the user starts a session. Each message is
   exactly 200 ms of mono, little-endian PCM16 at 16 kHz. */
class ClassroomPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outputRate = 16000;
    this.ratio = sampleRate / this.outputRate;
    this.inputIndex = 0;
    this.outputIndex = 0;
    this.previous = 0;
    this.frame = new ArrayBuffer(3200 * 2);
    this.view = new DataView(this.frame);
    this.frameIndex = 0;
    this.filterIndex = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return;
      this.stopped = true;
      const buffer = this.frame.slice(0, this.frameIndex * 2);
      this.frameIndex = 0;
      this.port.postMessage({ type: 'flushed', buffer }, [buffer]);
    };
    // A persistent low-pass filter suppresses frequencies above the target
    // speech band before resampling; its state spans every 128-sample block.
    const taps = sampleRate > this.outputRate ? 63 : 1;
    this.filter = new Float64Array(taps);
    this.history = new Float32Array(taps);
    if (taps === 1) {
      this.filter[0] = 1;
    } else {
      const cutoff = 7200 / sampleRate;
      const midpoint = (taps - 1) / 2;
      let sum = 0;
      for (let i = 0; i < taps; i++) {
        const offset = i - midpoint;
        const sinc = offset === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
        const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
        this.filter[i] = sinc * window;
        sum += this.filter[i];
      }
      for (let i = 0; i < taps; i++) this.filter[i] /= sum;
    }
  }

  emitSample(value) {
    const clipped = Math.max(-1, Math.min(1, value));
    this.view.setInt16(this.frameIndex * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
    this.frameIndex++;
    if (this.frameIndex === 3200) {
      this.port.postMessage(this.frame, [this.frame]);
      this.frame = new ArrayBuffer(6400);
      this.view = new DataView(this.frame);
      this.frameIndex = 0;
    }
  }

  process(inputs, outputs) {
    // Never play captured audio back through the speakers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return true;
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0].length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let input = 0;
      for (let channel = 0; channel < channels.length; channel++) input += channels[channel][i];
      input /= channels.length;
      this.history[this.filterIndex] = input;
      let filtered = 0;
      for (let tap = 0; tap < this.filter.length; tap++) {
        const historyIndex = (this.filterIndex - tap + this.filter.length) % this.filter.length;
        filtered += this.history[historyIndex] * this.filter[tap];
      }
      this.filterIndex = (this.filterIndex + 1) % this.filter.length;
      // Use absolute sample indices so fractional 44.1 kHz phases never reset
      // between worklet blocks and cannot accumulate long-session rate drift.
      while (this.outputIndex * this.ratio <= this.inputIndex) {
        const fraction = this.outputIndex * this.ratio - (this.inputIndex - 1);
        this.emitSample(this.previous + (filtered - this.previous) * fraction);
        this.outputIndex++;
      }
      this.previous = filtered;
      this.inputIndex++;
    }
    return true;
  }
}

registerProcessor('classroom-pcm', ClassroomPCMProcessor);
