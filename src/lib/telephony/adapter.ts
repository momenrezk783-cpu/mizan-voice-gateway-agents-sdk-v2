/**
 * Vendor-neutral laboratory media adapter for BYON/SIP gateways.
 * This is NOT a SIP signalling endpoint, carrier connection or live PSTN bridge.
 * The external PBX must authenticate the call and select tenantSlug from trusted routing,
 * never from a caller-supplied payload. No caller numbers are logged or retained here.
 */
export type TelephonyCodec = 'PCMU/8000' | 'L16/16000';
export type LabMediaEvent =
  | { event: 'start'; streamId: string; codec: TelephonyCodec }
  | { event: 'media'; streamId: string; sequence: number; payload: string }
  | { event: 'stop'; streamId: string };

const BIAS = 0x84;
const MAX_MEDIA_BYTES = 1600; // 200 ms of PCMU; bound untrusted WebSocket payload size.
const STREAM_ID = /^[a-zA-Z0-9_-]{1,96}$/;

/** ITU G.711 PCMU decoder for 8 kHz phone audio. */
export function decodePcmuByte(encoded: number): number {
  const u = (~encoded) & 0xff;
  const magnitude = (((u & 15) << 3) + BIAS) << ((u >>> 4) & 7);
  const sample = magnitude - BIAS;
  return sample === 0 ? 0 : (u & 0x80) ? -sample : sample;
}

export function encodePcmuSample(value: number): number {
  const s = Math.max(-32768, Math.min(32767, Math.trunc(value)));
  const sign = s < 0 ? 0x80 : 0;
  const magnitude = Math.min(32635, Math.abs(s)) + BIAS;
  let segment = 0;
  for (let x = magnitude >>> 7; x > 1; x >>>= 1) segment++;
  segment = Math.min(7, segment);
  const quant = (magnitude >>> (segment + 3)) & 0x0f;
  return (~(sign | (segment << 4) | quant)) & 0xff;
}

export function pcmuToPcm16k(input: Uint8Array): Uint8Array {
  if (input.length > MAX_MEDIA_BYTES) throw new Error('Media frame too large');
  // Each input sample is repeated twice; high fidelity filtering can be added
  // before telecom launch. Output is little-endian 16k mono PCM.
  const output = new Uint8Array(input.length * 4);
  const view = new DataView(output.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = decodePcmuByte(input[i]);
    view.setInt16(i * 4, s, true);
    view.setInt16(i * 4 + 2, s, true);
  }
  return output;
}

export function pcm16kToPcmu(input: Uint8Array): Uint8Array {
  if ((input.length & 3) !== 0 || input.length > MAX_MEDIA_BYTES * 4) {
    throw new Error('Invalid 16k PCM frame size');
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const output = new Uint8Array(input.byteLength / 4);
  for (let i = 0; i < output.length; i++) {
    // Average two consecutive 16 kHz samples down to a single 8 kHz sample.
    const s = (view.getInt16(i * 4, true) + view.getInt16(i * 4 + 2, true)) / 2;
    output[i] = encodePcmuSample(s);
  }
  return output;
}

function decodeBase64(payload: string): Uint8Array {
  if (!payload || payload.length > 2200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error('Invalid media encoding');
  }
  const raw = atob(payload);
  if (raw.length > MAX_MEDIA_BYTES) throw new Error('Media frame too large');
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

/**
 * Stateful media boundary; the SIP/PBX bridge supplies a VERIFIED tenantSlug.
 * No network sockets are opened by this class.
 */
export class TelephonyLabSession {
  private streamId: string | null = null;
  private codec: TelephonyCodec | null = null;
  private sequence = -1;
  private ended = false;
  constructor(readonly tenantSlug: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantSlug)) throw new Error('Invalid authorized tenant route');
  }

  accept(frame: LabMediaEvent): Uint8Array | null {
    if (this.ended) throw new Error('Call already stopped');
    if (!STREAM_ID.test(frame.streamId)) throw new Error('Invalid stream ID');
    if (frame.event === 'start') {
      if (this.streamId || (frame.codec !== 'PCMU/8000' && frame.codec !== 'L16/16000')) {
        throw new Error('Invalid start event');
      }
      this.streamId = frame.streamId;
      this.codec = frame.codec;
      return null;
    }
    if (frame.streamId !== this.streamId || !this.streamId) throw new Error('Unknown stream ID');
    if (frame.event === 'stop') { this.ended = true; return null; }
    if (frame.event !== 'media' || !Number.isSafeInteger(frame.sequence) || frame.sequence <= this.sequence) {
      throw new Error('Out-of-order media packet');
    }
    const bytes = decodeBase64(frame.payload);
    this.sequence = frame.sequence;
    if (this.codec === 'PCMU/8000') return pcmuToPcm16k(bytes);
    if ((bytes.length & 1) !== 0) throw new Error('Unaligned L16 frame');
    return bytes;
  }

  createOutboundPcmu(pcm16k: Uint8Array): Uint8Array {
    if (!this.streamId || this.ended) throw new Error('No active call');
    return pcm16kToPcmu(pcm16k);
  }
}

