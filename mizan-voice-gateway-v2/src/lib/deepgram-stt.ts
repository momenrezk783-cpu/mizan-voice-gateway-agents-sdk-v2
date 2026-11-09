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
  channel: { alternatives: Array<{ transcript: string; confidence: number; words?: DeepgramWord[]; languages?: string[] }> };
}

export interface DeepgramStreamConfig {
  model?: string;
  language?: string;
  encoding?: "linear16";
  sampleRate?: number;
  channels?: number;
  endpointingMs?: number;
  utteranceEndMs?: number;
  keyterms?: string[];
  languageHints?: string[];
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

const DEFAULT_KEYTERMS = ["ميزان", "Mizan", "دكتور", "دكتورة", "باشمهندس", "حجز", "ميعاد", "كشف", "استشارة", "عيادة", "مستشفى"];
const HALLUCINATION_PATTERNS = [/^اشتركوا\s+في\s+القناة[.!؟،\s]*$/u, /^لا\s+تنسوا\s+الاشتراك[.!؟،\s]*$/u, /^ترجمة\s+نانسي\s+قنقر[.!؟،\s]*$/u, /^[.،,!؟?\-\s…]+$/u];

export function computePcm16Rms(pcmBytes: Uint8Array): number {
  const sampleCount = Math.floor(pcmBytes.byteLength / 2);
  if (!sampleCount) return 0;
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export function float32ToLinear16Pcm(float32Bytes: Uint8Array): Uint8Array {
  const usableBytes = float32Bytes.byteLength - (float32Bytes.byteLength % 4);
  if (!usableBytes) return new Uint8Array(0);
  const count = usableBytes / 4;
  const input = new DataView(float32Bytes.buffer, float32Bytes.byteOffset, usableBytes);
  const output = new ArrayBuffer(count * 2);
  const view = new DataView(output);
  for (let i = 0; i < count; i++) {
    const raw = input.getFloat32(i * 4, true);
    const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    view.setInt16(i * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
  }
  return new Uint8Array(output);
}

export function normalizeToLinear16Pcm(message: ArrayBuffer | ArrayBufferView, inputFormat: "linear16" | "float32" = "linear16"): Uint8Array {
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  if (bytes.byteLength < 2) return new Uint8Array(0);
  if (inputFormat === "float32") return float32ToLinear16Pcm(bytes);
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  return usable ? (usable === bytes.byteLength ? bytes : bytes.subarray(0, usable)) : new Uint8Array(0);
}

export function fingerprintAudioFrame(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.byteLength / 64));
  for (let i = 0; i < bytes.byteLength; i += step) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= bytes.byteLength;
  return hash >>> 0;
}

export function isMeaningfulTranscript(text: string, confidence = 1): boolean {
  const cleaned = String(text ?? "").trim();
  if (!cleaned || HALLUCINATION_PATTERNS.some((pattern) => pattern.test(cleaned))) return false;
  const alphanumeric = cleaned.replace(/[^\p{L}\p{N}]+/gu, "");
  return !!alphanumeric && !(alphanumeric.length === 1 && confidence < 0.6);
}

export function detectTranscriptLanguage(text: string): "ar" | "en" {
  const arabic = (text.match(/[\u0600-\u06FF]/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/gu) || []).length;
  return arabic === 0 && latin >= 2 || latin > arabic * 3 && arabic < 3 ? "en" : "ar";
}

export function buildDeepgramListenUrl(config: DeepgramStreamConfig = {}): string {
  const language = config.language || "ar-EG";
  const params = new URLSearchParams({
    model: config.model || "nova-3", language, encoding: config.encoding || "linear16",
    sample_rate: String(config.sampleRate ?? 16000), channels: String(config.channels ?? 1),
    interim_results: "true", smart_format: "true", punctuate: "true",
    endpointing: String(config.endpointingMs ?? 300), utterance_end_ms: String(config.utteranceEndMs ?? 1000), vad_events: "true"
  });
  if (language === "multi") for (const hint of config.languageHints?.length ? config.languageHints : ["ar", "en"]) params.append("language_hint", hint);
  if ((config.model || "nova-3").startsWith("nova-3")) {
    for (const term of config.keyterms ?? DEFAULT_KEYTERMS) if (term.trim()) params.append("keyterm", term.trim());
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
  private finalSegments: string[] = [];
  private finalConfidences: number[] = [];
  private lastEmittedUtterance = "";
  private lastEmittedAt = 0;
  private lastFrameFingerprint = 0;
  private lastFrameAt = 0;
  private pendingAudioQueue: Uint8Array[] = [];
  private pendingAudioBytes = 0;
  private static readonly MAX_PENDING_AUDIO_BYTES = 16000 * 2 * 4;
  private static readonly DUPLICATE_FRAME_WINDOW_MS = 40;
  private static readonly DUPLICATE_UTTERANCE_WINDOW_MS = 1200;

  constructor(private readonly apiKey: string, private readonly callbacks: DeepgramCallbacks, private readonly config: DeepgramStreamConfig = {}) {
    if (!apiKey?.trim()) throw new Error("DEEPGRAM_API_KEY secret is not configured");
  }

  async connect(): Promise<void> {
    if (this.closed || this.ws || this.connecting) return;
    this.connecting = true;
    try {
      const url = buildDeepgramListenUrl(this.config);
      const socket = this.config.webSocketFactory ? await this.config.webSocketFactory(url, this.apiKey) : await this.openCloudflareWebSocket(url);
      if (this.closed) { socket.close(1000, "Session already closed"); return; }
      this.ws = socket;
      this.reconnectAttempts = 0;
      this.attachSocketListeners(socket);
      this.startKeepAlive();
      this.flushPendingAudio();
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
    } finally { this.connecting = false; }
  }

  private async openCloudflareWebSocket(url: string): Promise<WebSocketLike> {
    const response = await fetch(url, { headers: { Upgrade: "websocket", Authorization: `Token ${this.apiKey.trim()}` } });
    if (response.status !== 101 || !response.webSocket) {
      const body = await response.text().catch(() => "");
      throw new Error(`Deepgram WebSocket upgrade failed (${response.status}): ${body.slice(0, 200)}`);
    }
    response.webSocket.accept();
    return response.webSocket as unknown as WebSocketLike;
  }

  private attachSocketListeners(socket: WebSocketLike): void {
    socket.addEventListener("message", (event: { data: unknown }) => { if (!this.closed && typeof event.data === "string") this.handleDeepgramMessage(event.data); });
    socket.addEventListener("close", () => {
      this.stopKeepAlive();
      if (this.ws === socket) this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });
    socket.addEventListener("error", (event: unknown) => { if (!this.closed) console.error("Deepgram WebSocket error:", event); });
  }

  public handleDeepgramMessage(rawJson: string): void {
    if (this.closed) return;
    let data: any;
    try { data = JSON.parse(rawJson); } catch { return; }
    if (data.type === "SpeechStarted") { this.callbacks.onSpeechStarted?.(); return; }
    if (data.type === "Results") {
      const result = data as DeepgramResultEvent;
      const alt = result.channel?.alternatives?.[0];
      const transcript = String(alt?.transcript ?? "").trim();
      const confidence = typeof alt?.confidence === "number" ? alt.confidence : 1;
      if (!transcript) {
        if (result.speech_final && this.finalSegments.length) this.emitAccumulatedFinal();
        return;
      }
      if (!result.is_final) {
        this.callbacks.onInterimTranscript?.([...this.finalSegments, transcript].join(" ").trim(), confidence);
        return;
      }
      if (isMeaningfulTranscript(transcript, confidence) && this.finalSegments[this.finalSegments.length - 1] !== transcript) {
        this.finalSegments.push(transcript);
        this.finalConfidences.push(confidence);
      }
      if (result.speech_final && this.finalSegments.length) this.emitAccumulatedFinal();
      return;
    }
    if (data.type === "UtteranceEnd" && this.finalSegments.length) this.emitAccumulatedFinal();
  }

  private emitAccumulatedFinal(): void {
    if (this.closed || !this.finalSegments.length) return;
    const transcript = this.finalSegments.join(" ").replace(/\s+/gu, " ").trim();
    const confidence = this.finalConfidences.length ? this.finalConfidences.reduce((sum, value) => sum + value, 0) / this.finalConfidences.length : 1;
    this.finalSegments = [];
    this.finalConfidences = [];
    if (!isMeaningfulTranscript(transcript, confidence)) return;
    const now = Date.now();
    if (transcript === this.lastEmittedUtterance && now - this.lastEmittedAt < DeepgramStreamingSession.DUPLICATE_UTTERANCE_WINDOW_MS) return;
    this.lastEmittedUtterance = transcript;
    this.lastEmittedAt = now;
    Promise.resolve(this.callbacks.onFinalTranscript(transcript, confidence, detectTranscriptLanguage(transcript))).catch((error) => console.error("Final transcript handler failed:", error));
  }

  sendAudio(message: ArrayBuffer | ArrayBufferView, inputFormat: "linear16" | "float32" = "linear16"): boolean {
    if (this.closed) return false;
    const pcm = normalizeToLinear16Pcm(message, inputFormat);
    if (!pcm.byteLength) return false;
    const rms = computePcm16Rms(pcm);
    const now = Date.now();
    if (rms > 0.005) {
      const fingerprint = fingerprintAudioFrame(pcm);
      if (fingerprint === this.lastFrameFingerprint && now - this.lastFrameAt < DeepgramStreamingSession.DUPLICATE_FRAME_WINDOW_MS) return false;
      this.lastFrameFingerprint = fingerprint;
      this.lastFrameAt = now;
    }
    if (this.ws?.readyState === 1) {
      try { this.ws.send(pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm.buffer : pcm.slice().buffer); return true; }
      catch (error) { console.error("Deepgram audio send failed:", error); return false; }
    }
    if (rms > 0.008 && this.pendingAudioBytes + pcm.byteLength <= DeepgramStreamingSession.MAX_PENDING_AUDIO_BYTES) {
      const copy = pcm.slice();
      this.pendingAudioQueue.push(copy);
      this.pendingAudioBytes += copy.byteLength;
    }
    return false;
  }

  finalizeUtterance(): void {
    if (!this.closed && this.ws?.readyState === 1) {
      try { this.ws.send(JSON.stringify({ type: "Finalize" })); } catch { /* ignore */ }
    }
  }

  private flushPendingAudio(): void {
    if (this.ws?.readyState !== 1 || !this.pendingAudioQueue.length) return;
    const queued = this.pendingAudioQueue;
    this.pendingAudioQueue = [];
    this.pendingAudioBytes = 0;
    for (const chunk of queued) { try { this.ws.send(chunk.buffer); } catch { break; } }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.closed || this.ws?.readyState !== 1) return;
      try { this.ws.send(JSON.stringify({ type: "KeepAlive" })); } catch { /* ignore */ }
    }, 5000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) { clearInterval(this.keepAliveInterval); this.keepAliveInterval = null; }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.reconnectAttempts >= 3) return;
    const delay = Math.min(2000, 250 * Math.pow(2, this.reconnectAttempts++));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (!this.closed) void this.connect(); }, delay);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepAlive();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.finalSegments = [];
    this.finalConfidences = [];
    this.pendingAudioQueue = [];
    this.pendingAudioBytes = 0;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try { if (socket.readyState === 1) socket.send(JSON.stringify({ type: "CloseStream" })); socket.close(1000, "Call ended"); } catch { /* ignore */ }
    }
  }

  isClosed(): boolean { return this.closed; }
}
