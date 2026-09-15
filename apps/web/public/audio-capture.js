/* AudioWorklet: bounded 20 ms signed PCM16 frames, mono, 16 kHz by default.
 * The AudioContext is requested at the target rate; resampling still handles
 * browsers that select the hardware rate instead. */
class RelayCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.sampleRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;
    this.frame = new Int16Array(Math.round(this.targetRate * 0.02));
    this.offset = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      this.muted = event.data.muted === true;
    };
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || this.muted) return true;
    for (let i = 0; i < input.length; i++) {
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const value = Math.max(-1, Math.min(1, input[i]));
        this.frame[this.offset++] = value < 0 ? value * 32768 : value * 32767;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(Math.round(this.targetRate * 0.02));
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('relay-capture', RelayCapture);
