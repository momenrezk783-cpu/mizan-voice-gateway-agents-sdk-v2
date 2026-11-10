// PCM Processor — AudioWorkletNode
// Converts Float32 audio (16,000 Hz mono) to 16-bit signed little-endian PCM (linear16)
// and batches 2048 samples (4096 bytes / 128ms) per frame to minimize WebSocket event overhead.
// Loaded via: audioCtx.audioWorklet.addModule('/pcm-processor.js')

const CHUNK_SAMPLES = 2048;

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(CHUNK_SAMPLES);
    this._offset = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush') {
        this._flushPartial();
      }
    };
  }

  _flushPartial() {
    if (this._offset > 0) {
      const slice = this._buffer.slice(0, this._offset);
      this.port.postMessage(slice.buffer, [slice.buffer]);
      this._offset = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const float32 = input[0];
      for (let i = 0; i < float32.length; i++) {
        const raw = float32[i];
        const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
        this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        if (this._offset >= CHUNK_SAMPLES) {
          const out = this._buffer.slice(0, CHUNK_SAMPLES);
          this.port.postMessage(out.buffer, [out.buffer]);
          this._offset = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
