// Converts mic audio to 16-bit PCM and posts it in ~80 ms chunks,
// the chunk size Deepgram recommends for Flux.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(Math.round(sampleRate * 0.08));
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        const out = this.buf.buffer;
        this.port.postMessage(out, [out]);
        this.buf = new Int16Array(this.buf.length);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-worklet", PcmWorklet);
