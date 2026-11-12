// Eleven v4 Turbo uses Text to Dialogue WebSocket, not the HTTP TTS API.
// https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket
export interface DialogueVoiceConfig {
  voice_id: string;
  model_id: string;
  stability: number;
}

export async function synthesizeDialogueAudio(
  text: string,
  apiKey: string,
  config: DialogueVoiceConfig,
  language: "ar" | "en",
  fetcher: typeof fetch = fetch,
  timeoutMs = 12000
): Promise<ArrayBuffer> {
  if (!apiKey.trim()) throw new Error("ELEVENLABS_TTS_KEY secret is not configured");
  const endpoint = new URL("https://api.elevenlabs.io/v1/text-to-dialogue/stream-input");
  endpoint.searchParams.set("model_id", config.model_id);
  endpoint.searchParams.set("output_format", "mp3_44100_128");
  endpoint.searchParams.set("language_code", language);
  const controller = new AbortController();
  let socket: WebSocket | undefined;
  let rejectPending: ((error: Error) => void) | undefined;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectPending?.(new Error("ElevenLabs speech synthesis timed out"));
  }, timeoutMs);

  try {
    const response = await fetcher(endpoint.toString(), {
      headers: { Upgrade: "websocket", "xi-api-key": apiKey.trim() },
      signal: controller.signal
    });
    if (response.status !== 101 || !response.webSocket) {
      // Provider bodies can contain text or credentials: do not expose them.
      throw new Error(`ElevenLabs WebSocket upgrade failed (HTTP ${response.status})`);
    }
    socket = response.webSocket;
    if (timedOut) throw new Error("ElevenLabs speech synthesis timed out");
    const ws = socket;
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      rejectPending = fail;
      ws.addEventListener("message", (event) => {
        if (settled || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { audio?: string; is_final?: boolean; error?: string };
          if (message.error) {
            fail(new Error("ElevenLabs speech generation failed"));
            return;
          }
          if (message.audio) {
            const decoded = Uint8Array.from(atob(message.audio), (char) => char.charCodeAt(0));
            bytes += decoded.byteLength;
            if (bytes > 8 * 1024 * 1024) throw new Error("Audio limit exceeded");
            chunks.push(decoded);
          }
          // is_final_audio_for_turn is not the end of the socket's closing flush.
          if (message.is_final) {
            if (bytes < 100) throw new Error("Incomplete audio");
            const audio = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
            settled = true;
            resolve(audio.buffer);
          }
        } catch {
          fail(new Error("ElevenLabs returned invalid or incomplete audio"));
        }
      });
      ws.addEventListener("error", () => fail(new Error("ElevenLabs WebSocket error")));
      ws.addEventListener("close", () => fail(new Error("ElevenLabs closed before audio completed")));
      ws.accept();
      // The dialogue protocol accepts stability; legacy speed/speaker-boost
      // settings are not supported by this model and must not be forwarded.
      ws.send(JSON.stringify({ voices: [config.voice_id], voice_settings: { stability: config.stability } }));
      ws.send(JSON.stringify({ inputs: [{ text, voice_id: config.voice_id }], close_socket: true }));
    });
  } finally {
    clearTimeout(timeout);
    try { socket?.close(1000, "Synthesis finished"); } catch { /* Already closed. */ }
  }
}
