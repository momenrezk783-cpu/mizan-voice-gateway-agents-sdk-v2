// ============================================================================
// Mizan Voice Gateway — Deepgram Live Streaming Speech-to-Text (STT)
// ============================================================================
// Server-side WebSocket client for Deepgram's real-time `/v1/listen` endpoint
// inside Cloudflare Workers / Durable Objects.
//
// Official Deepgram references:
//   - https://developers.deepgram.com/docs/getting-started-with-live-streaming-audio
//   - https://developers.deepgram.com/reference/speech-to-text/listen-streaming
//   - https://developers.deepgram.com/docs/encoding
//   - https://developers.deepgram.com/docs/models-languages-overview
//   - https://developers.deepgram.com/docs/multilingual-code-switching
//   - https://developers.deepgram.com/docs/interim-results
//   - https://developers.deepgram.com/docs/endpointing
//   - https://developers.deepgram.com/docs/understanding-end-of-speech-detection
// ============================================================================

export interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
  language?: string;
}

export interface DeepgramResultEvent {
  type: "Results";
  channel_index: number[];
  duration: number;
  start: number;
  is_final: boolean;
  speech_final: boolean;
  from_finalize?: boolean;
  channel: {
    alternatives: Array<{
      transcript: string;
      confidence: number;
      words?: DeepgramWord[];
      languages?: string[];
    }>;
  };
}

export interface DeepgramUtteranceEndEvent {
  type: "UtteranceEnd";
  channel: number[];
  last_word_end: number;
}

export interface DeepgramSpeechStartedEvent {
  type: "SpeechStarted";
  channel: number[];
  timestamp: number;
}

export interface DeepgramMetadataEvent {
  type: "Metadata";
  request_id?: string;
  model_info?: Record<string, unknown>;
}

export type DeepgramEvent =
  | DeepgramResultEvent
  | DeepgramUtteranceEndEvent
  | DeepgramSpeechStartedEvent
  | DeepgramMetadataEvent
  | { type: string; [key: string]: unknown };

export interface DeepgramStreamConfig {
  /** Deepgram model. Defaults to "nova-3" (supports Arabic `ar`/`ar-EG` and `multi` code-switching). */
  model?: string;
  /** Primary language tag. Defaults to "ar-EG" for Egyptian Arabic. Supports "ar" or "multi". */
  language?: string;
  /** Audio encoding matching browser AudioWorklet output. Must be "linear16" (16-bit signed LE PCM). */
  encoding?: "linear16";
  /** Sample rate in Hz. Must match browser AudioContext (16000 Hz). */
  sampleRate?: number;
  /** Channel count. Must match mono microphone capture (1). */
  channels?: number;
  /** Endpointing pause duration in ms before marking `speech_final: true`. Defaults to 300. */
  endpointingMs?: number;
  /** Gap duration in ms before emitting `UtteranceEnd` fallback in noisy environments. Defaults to 1000. */
  utteranceEndMs?: number;
  /** Optional domain keyterms (Nova-3 supports `keyterm` boosting for Arabic & English terms). */
  keyterms?: string[];
  /** Language hints when using `language=multi`. */
  languageHints?: string[];
  /** Custom WebSocket factory for unit/integration testing without live network calls. */
  webSocketFactory?: (url: string, apiKey: string) => Promise<WebSocketLike>;
}

export interface DeepgramCallbacks {
  onInterimTranscript?: (text: string, confidence: number) => void;
  onFinalTranscript: (text: string, confidence: number, detectedLanguage: "ar" | "en") => void | Promise<void>;
  onSpeechStarted?: () => void;
  onError?: (error: Error) => void;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

const DEFAULT_KEYTERMS = [
  "ميزان",
  "Mizan",
  "دكتور",
  "دكتورة",
  "باشمهندس",
  "حجز",
  "ميعاد",
  "كشف",
  "استشارة",
  "عيادة",
  "مستشفى"
];

/**
 * Known Whisper/ASR silence hallucination phrases that must never trigger a conversation turn
 * if a noisy or silent segment produces a low-confidence artifact.
 */
const HALLUCINATION_PATTERNS = [
  /^اشتركوا\s+في\s+القناة[.!؟،\s]*$/u,
  /^لا\s+تنسوا\s+الاشتراك[.!؟،\s]*$/u,
  /^ترجمة\s+نانسي\s+قنقر[.!؟،\s]*$/u,
  /^[.،,!؟?\-\s…]+$/u
];

/**
 * Compute normalized RMS energy (0.0 to 1.0) of a 16-bit signed little-endian PCM frame.
 */
export function computePcm16Rms(pcmBytes: Uint8Array): number {
  const sampleCount = Math.floor(pcmBytes.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Convert Float32 PCM samples ([-1, 1]) into 16-bit signed little-endian PCM (`linear16`).
 * Used only when a client explicitly declares `float32` encoding.
 */
export function float32ToLinear16Pcm(float32Bytes: Uint8Array): Uint8Array {
  const usableBytes = float32Bytes.byteLength - (float32Bytes.byteLength % 4);
  if (usableBytes <= 0) return new Uint8Array(0);
  const sampleCount = usableBytes / 4;
  const inView = new DataView(float32Bytes.buffer, float32Bytes.byteOffset, usableBytes);
  const outBuffer = new ArrayBuffer(sampleCount * 2);
  const outView = new DataView(outBuffer);
  for (let i = 0; i < sampleCount; i++) {
    const raw = inView.getFloat32(i * 4, true);
    const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    outView.setInt16(i * 2, int16, true);
  }
  return new Uint8Array(outBuffer);
}

/**
 * Validate and normalize an incoming binary WebSocket audio frame into `linear16`
 * (16-bit signed little-endian PCM at 16 kHz mono).
 */
export function normalizeToLinear16Pcm(
  message: ArrayBuffer | ArrayBufferView,
  inputFormat: "linear16" | "float32" = "linear16"
): Uint8Array {
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);

  if (bytes.byteLength < 2) {
    return new Uint8Array(0);
  }

  if (inputFormat === "float32") {
    return float32ToLinear16Pcm(bytes);
  }

  // Ensure even byte length for 16-bit PCM samples (2 bytes per sample).
  const usableBytes = bytes.byteLength - (bytes.byteLength % 2);
  if (usableBytes <= 0) return new Uint8Array(0);
  return usableBytes === bytes.byteLength ? bytes : bytes.subarray(0, usableBytes);
}

/**
 * Compute a lightweight FNV-1a 32-bit fingerprint of a non-silent audio frame
 * to prevent duplicate processing if the exact same non-silent audio packet is delivered twice.
 */
export function fingerprintAudioFrame(pcmBytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(pcmBytes.byteLength / 64));
  for (let i = 0; i < pcmBytes.byteLength; i += step) {
    hash ^= pcmBytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= pcmBytes.byteLength;
  return hash >>> 0;
}

/**
 * Filter out empty, punctuation-only, or known silence-hallucination transcripts.
 */
export function isMeaningfulTranscript(text: string, confidence = 1): boolean {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) return false;
  if (HALLUCINATION_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return false;
  }
  // Strip punctuation/whitespace and verify at least one Arabic or Latin letter/digit exists.
  const alphanumeric = cleaned.replace(/[^\p{L}\p{N}]+/gu, "");
  if (!alphanumeric) return false;
  // Reject single-character low-confidence noise blips
  if (alphanumeric.length === 1 && confidence < 0.6) return false;
  return true;
}

/**
 * Detect whether a transcript is predominantly English or Arabic while preserving mixed speech.
 * Per Mizan conversation rules, Arabic (and mixed Egyptian Arabic + English terms) defaults to "ar";
 * only purely/predominantly English utterances switch response language to "en".
 */
export function detectTranscriptLanguage(text: string): "ar" | "en" {
  const arabicChars = (text.match(/[\u0600-\u06FF]/gu) || []).length;
  const latinChars = (text.match(/[A-Za-z]/gu) || []).length;
  if (arabicChars === 0 && latinChars >= 2) return "en";
  if (latinChars > arabicChars * 3 && arabicChars < 3) return "en";
  return "ar";
}

/**
 * Build the authenticated Deepgram `/v1/listen` streaming endpoint URL.
 */
export function buildDeepgramListenUrl(config: DeepgramStreamConfig = {}): string {
  const model = config.model || "nova-3";
  const language = config.language || "ar-EG";
  const encoding = config.encoding || "linear16";
  const sampleRate = config.sampleRate ?? 16000;
  const channels = config.channels ?? 1;
  const endpointingMs = config.endpointingMs ?? 300;
  const utteranceEndMs = config.utteranceEndMs ?? 1000;

  const params = new URLSearchParams({
    model,
    language,
    encoding,
    sample_rate: String(sampleRate),
    channels: String(channels),
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: String(endpointingMs),
    utterance_end_ms: String(utteranceEndMs),
    vad_events: "true"
  });

  if (language === "multi") {
    const hints = config.languageHints?.length ? config.languageHints : ["ar", "en"];
    for (const hint of hints) {
      params.append("language_hint", hint);
    }
  }

  const keyterms = config.keyterms ?? DEFAULT_KEYTERMS;
  if (model.startsWith("nova-3")) {
    for (const term of keyterms) {
      if (term.trim()) params.append("keyterm", term.trim());
    }
  }

  return `https://api.deepgram.com/v1/listen?${params.toString()}`;
}

export class DeepgramStreamingSession {
  private ws: WebSocketLike | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private connecting = false;
  private reconnectAttempts = 0;

  // Utterance assembly & deduplication state
  private finalSegments: string[] = [];
  private finalConfidences: number[] = [];
  private lastEmittedUtterance = "";
  private lastEmittedAt = 0;
  private lastFrameFingerprint = 0;
  private lastFrameAt = 0;
  private pendingAudioQueue: Uint8Array[] = [];
  private pendingAudioBytes = 0;

  private static readonly MAX_PENDING_AUDIO_BYTES = 16000 * 2 * 4; // Max 4 seconds buffered during initial handshake
  private static readonly DUPLICATE_FRAME_WINDOW_MS = 40;
  private static readonly DUPLICATE_UTTERANCE_WINDOW_MS = 1200;

  constructor(
    private readonly apiKey: string,
    private readonly callbacks: DeepgramCallbacks,
    private readonly config: DeepgramStreamConfig = {}
  ) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error("DEEPGRAM_API_KEY secret is not configured");
    }
  }

  /**
   * Open the server-side WebSocket stream to Deepgram.
   */
  async connect(): Promise<void> {
    if (this.closed || this.ws || this.connecting) return;
    this.connecting = true;

    const url = buildDeepgramListenUrl(this.config);

    try {
      const socket = this.config.webSocketFactory
        ? await this.config.webSocketFactory(url, this.apiKey)
        : await this.openCloudflareWebSocket(url);

      if (this.closed) {
        try {
          socket.close(1000, "Session already closed");
        } catch {
          // Ignore close errors
        }
        return;
      }

      this.ws = socket;
      this.reconnectAttempts = 0;
      this.attachSocketListeners(socket);
      this.startKeepAlive();
      this.flushPendingAudio();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onError?.(err);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async openCloudflareWebSocket(url: string): Promise<WebSocketLike> {
    const response = await fetch(url, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Token ${this.apiKey.trim()}`
      }
    });

    if (response.status !== 101 || !response.webSocket) {
      const body = await response.text().catch(() => "");
      throw new Error(`Deepgram WebSocket upgrade failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const ws = response.webSocket;
    ws.accept();
    return ws as unknown as WebSocketLike;
  }

  private attachSocketListeners(socket: WebSocketLike): void {
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (this.closed) return;
      if (typeof event.data !== "string") return;
      this.handleDeepgramMessage(event.data);
    });

    socket.addEventListener("close", () => {
      this.stopKeepAlive();
      if (this.ws === socket) {
        this.ws = null;
      }
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", (event: unknown) => {
      if (this.closed) return;
      console.error("Deepgram WebSocket error:", event);
    });
  }

  /**
   * Process a JSON event message from Deepgram (`Results`, `UtteranceEnd`, `SpeechStarted`, `Metadata`).
   */
  public handleDeepgramMessage(rawJson: string): void {
    if (this.closed) return;

    let data: DeepgramEvent;
    try {
      data = JSON.parse(rawJson) as DeepgramEvent;
    } catch {
      return;
    }

    if (data.type === "SpeechStarted") {
      this.callbacks.onSpeechStarted?.();
      return;
    }

    if (data.type === "Results") {
      const result = data as DeepgramResultEvent;
      const alt = result.channel?.alternatives?.[0];
      const transcript = (alt?.transcript ?? "").trim();
      const confidence = typeof alt?.confidence === "number" ? alt.confidence : 1;

      if (!transcript) {
        // Even if the final chunk itself is empty, speech_final may mark the end of previously accumulated segments.
        if (result.speech_final && this.finalSegments.length > 0) {
          this.emitAccumulatedFinal();
        }
        return;
      }

      if (!result.is_final) {
        // Interim result: NEVER trigger the LLM conversation engine.
        const interimPreview = [...this.finalSegments, transcript].join(" ").trim();
        this.callbacks.onInterimTranscript?.(interimPreview, confidence);
        return;
      }

      // Finalized segment (`is_final: true`)
      if (isMeaningfulTranscript(transcript, confidence)) {
        // Guard against duplicate consecutive segment text from overlapping frames
        const lastSegment = this.finalSegments[this.finalSegments.length - 1];
        if (lastSegment !== transcript) {
          this.finalSegments.push(transcript);
          this.finalConfidences.push(confidence);
        }
      }

      if (result.speech_final && this.finalSegments.length > 0) {
        this.emitAccumulatedFinal();
      }
      return;
    }

    if (data.type === "UtteranceEnd") {
      // Fallback endpointing in noisy environments when `speech_final` did not fire.
      // Because `emitAccumulatedFinal()` clears `this.finalSegments`, an `UtteranceEnd`
      // arriving after `speech_final` sees an empty array and never double-triggers the LLM.
      if (this.finalSegments.length > 0) {
        this.emitAccumulatedFinal();
      }
    }
  }

  private emitAccumulatedFinal(): void {
    if (this.closed || this.finalSegments.length === 0) return;

    const fullTranscript = this.finalSegments.join(" ").replace(/\s+/gu, " ").trim();
    const avgConfidence =
      this.finalConfidences.length > 0
        ? this.finalConfidences.reduce((sum, c) => sum + c, 0) / this.finalConfidences.length
        : 1;

    // Reset utterance accumulators immediately before invoking callback
    this.finalSegments = [];
    this.finalConfidences = [];

    if (!isMeaningfulTranscript(fullTranscript, avgConfidence)) {
      return;
    }

    const now = Date.now();
    if (
      fullTranscript === this.lastEmittedUtterance &&
      now - this.lastEmittedAt < DeepgramStreamingSession.DUPLICATE_UTTERANCE_WINDOW_MS
    ) {
      return;
    }

    this.lastEmittedUtterance = fullTranscript;
    this.lastEmittedAt = now;

    const detectedLanguage = detectTranscriptLanguage(fullTranscript);
    Promise.resolve(this.callbacks.onFinalTranscript(fullTranscript, avgConfidence, detectedLanguage)).catch(
      (err) => {
        console.error("Final transcript handler failed:", err);
      }
    );
  }

  /**
   * Send raw `linear16` (16-bit signed little-endian PCM, 16 kHz mono) audio bytes to Deepgram.
   * Rejects empty/malformed frames, post-close frames, and duplicate retransmitted non-silent frames.
   */
  sendAudio(
    message: ArrayBuffer | ArrayBufferView,
    inputFormat: "linear16" | "float32" = "linear16"
  ): boolean {
    if (this.closed) return false;

    const pcmBytes = normalizeToLinear16Pcm(message, inputFormat);
    if (pcmBytes.byteLength === 0) return false;

    const rms = computePcm16Rms(pcmBytes);
    const now = Date.now();

    // Reject identical non-silent frame delivered twice within 40ms
    if (rms > 0.005) {
      const fp = fingerprintAudioFrame(pcmBytes);
      if (
        fp === this.lastFrameFingerprint &&
        now - this.lastFrameAt < DeepgramStreamingSession.DUPLICATE_FRAME_WINDOW_MS
      ) {
        return false;
      }
      this.lastFrameFingerprint = fp;
      this.lastFrameAt = now;
    }

    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(
          pcmBytes.byteOffset === 0 && pcmBytes.byteLength === pcmBytes.buffer.byteLength
            ? pcmBytes.buffer
            : pcmBytes.slice().buffer
        );
        return true;
      } catch (err) {
        console.error("Deepgram audio send failed:", err);
        return false;
      }
    }

    // Buffer a bounded window of non-silent audio while the initial WebSocket handshake completes
    if (rms > 0.008 && this.pendingAudioBytes + pcmBytes.byteLength <= DeepgramStreamingSession.MAX_PENDING_AUDIO_BYTES) {
      const copy = pcmBytes.slice();
      this.pendingAudioQueue.push(copy);
      this.pendingAudioBytes += copy.byteLength;
    }
    return false;
  }

  /**
   * Explicitly ask Deepgram to finalize any buffered server-side audio (`Finalize` message).
   */
  finalizeUtterance(): void {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({ type: "Finalize" }));
      } catch {
        // Ignore send errors
      }
    }
  }

  private flushPendingAudio(): void {
    if (!this.ws || this.ws.readyState !== 1 || this.pendingAudioQueue.length === 0) return;
    const queued = this.pendingAudioQueue;
    this.pendingAudioQueue = [];
    this.pendingAudioBytes = 0;
    for (const chunk of queued) {
      try {
        this.ws.send(chunk.buffer);
      } catch {
        break;
      }
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.closed || !this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      } catch {
        // Ignore keepalive errors
      }
    }, 5000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.reconnectAttempts >= 3) return;
    const delayMs = Math.min(2000, 250 * Math.pow(2, this.reconnectAttempts++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) {
        void this.connect();
      }
    }, delayMs);
  }

  /**
   * Cleanly close the Deepgram streaming session (`CloseStream`) and suppress any late callbacks.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepAlive();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.finalSegments = [];
    this.finalConfidences = [];
    this.pendingAudioQueue = [];
    this.pendingAudioBytes = 0;

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "CloseStream" }));
        }
        socket.close(1000, "Call ended");
      } catch {
        // Ignore close errors
      }
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}
