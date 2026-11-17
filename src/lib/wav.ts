// ============================================================================
// PCM → WAV container
// ============================================================================
// Some providers (Gemini TTS among them) return raw signed 16-bit little-endian
// PCM with no container. The browser plays that with AudioContext.decodeAudioData
// only if it is wrapped in a RIFF/WAVE header, so we add the 44-byte header here
// instead of pulling in an MP3 encoder dependency.

export const WAV_HEADER_BYTES = 44;

/** Build a mono/stereo 16-bit PCM WAV file from raw little-endian PCM samples. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("pcm16ToWav requires a positive sample rate");
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error("pcm16ToWav supports one or two channels");
  }
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const header = new DataView(new ArrayBuffer(WAV_HEADER_BYTES));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true);          // fmt chunk size
  header.setUint16(20, 1, true);           // 1 = PCM
  header.setUint16(22, channels, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, byteRate, true);
  header.setUint16(32, blockAlign, true);
  header.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  header.setUint32(40, pcm.byteLength, true);

  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(pcm, WAV_HEADER_BYTES);
  return out.buffer;
}

/**
 * Read the sample rate out of a provider mime type such as
 * `audio/L16;codec=pcm;rate=24000`. Falls back to 24000, which is what the
 * Gemini TTS models return today.
 */
export function parsePcmSampleRate(mimeType: string | null | undefined, fallback = 24000): number {
  const match = String(mimeType ?? "").match(/rate\s*=\s*(\d{4,6})/i);
  if (!match) return fallback;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate >= 8000 && rate <= 96000 ? rate : fallback;
}