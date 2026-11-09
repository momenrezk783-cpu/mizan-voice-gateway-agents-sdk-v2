// PCM Processor — Float32 mono audio frames for the Mizan voice WebSocket.
// Audio is captured at the AudioContext sample rate (configured to 16 kHz).
// Frames are batched to 100 ms to avoid flooding the socket with tiny messages.
// An audio_end control message is emitted after 650 ms of silence or 10 seconds.

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.speechActive = false;
    this.silenceSamples = 0;
    this.utteranceSamples = 0;
    this.pendingFrames = [];
    this.pendingSamples = 0;
    this.chunkSamples = Math.round(sampleRate * 0.1);
    this.silenceLimit = Math.round(sampleRate * 0.65);
    this.maxUtteranceSamples = sampleRate * 10;
    this.threshold = 0.012;
  }

  flushFrame() {
    if (this.pendingSamples === 0) return;
    const frame = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (const part of this.pendingFrames) {
      frame.set(part, offset);
      offset += part.length;
    }
    this.pendingFrames = [];
    this.pendingSamples = 0;
    this.port.postMessage(frame.buffer, [frame.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    let energy = 0;
    for (let i = 0; i < channel.length; i++) {
      energy += channel[i] * channel[i];
    }
    const rms = Math.sqrt(energy / channel.length);
    const hasSpeech = rms >= this.threshold;

    if (hasSpeech) {
      this.speechActive = true;
      this.silenceSamples = 0;
    }

    if (this.speechActive) {
      this.pendingFrames.push(new Float32Array(channel));
      this.pendingSamples += channel.length;
      this.utteranceSamples += channel.length;

      if (!hasSpeech) this.silenceSamples += channel.length;
      if (this.pendingSamples >= this.chunkSamples) this.flushFrame();

      if (
        this.silenceSamples >= this.silenceLimit ||
        this.utteranceSamples >= this.maxUtteranceSamples
      ) {
        this.flushFrame();
        this.port.postMessage(JSON.stringify({ type: "audio_end" }));
        this.speechActive = false;
        this.silenceSamples = 0;
        this.utteranceSamples = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
