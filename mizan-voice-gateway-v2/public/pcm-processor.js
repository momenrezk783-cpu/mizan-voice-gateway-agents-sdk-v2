// PCM Processor — Float32 mono audio frames for the Mizan voice WebSocket.
// Audio is captured at the AudioContext sample rate (configured to 16 kHz).
// Speech frames are transferred without Int16 conversion. An audio_end control
// message is emitted after 650 ms of silence or a 10-second utterance limit.

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.speechActive = false;
    this.silenceSamples = 0;
    this.utteranceSamples = 0;
    this.silenceLimit = Math.round(sampleRate * 0.65);
    this.maxUtteranceSamples = sampleRate * 10;
    this.threshold = 0.012;
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
      // Transfer a copy because the browser owns the AudioWorklet input buffer.
      const frame = new Float32Array(channel);
      this.port.postMessage(frame.buffer, [frame.buffer]);
      this.utteranceSamples += channel.length;

      if (!hasSpeech) this.silenceSamples += channel.length;

      if (
        this.silenceSamples >= this.silenceLimit ||
        this.utteranceSamples >= this.maxUtteranceSamples
      ) {
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
