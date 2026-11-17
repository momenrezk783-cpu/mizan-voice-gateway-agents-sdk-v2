// ============================================================================
// ElevenLabs TTS adapter
// ============================================================================
// Behaviour is unchanged from the original in-agent implementation: the
// text-to-dialogue WebSocket for eleven_v4_turbo, the streaming HTTP endpoint
// for everything else, three retries on retryable status codes, and a hard
// twelve second ceiling per attempt.

import { synthesizeDialogueAudio } from "../elevenlabs-tts";
import type { TtsVoiceConfig } from "./types";

export interface ElevenLabsResult {
  audio: ArrayBuffer;
  mimeType: string;
}

export async function synthesizeElevenLabsSpeech(
  text: string,
  apiKey: string,
  config: TtsVoiceConfig,
  language: "ar" | "en",
  fetcher: typeof fetch = fetch
): Promise<ElevenLabsResult> {
  const key = (apiKey || "").trim();
  if (!key) throw new Error("ELEVENLABS_TTS_KEY is not configured");
  if (!config?.voice_id) throw new Error("ElevenLabs voice config is unavailable");

  if (config.model_id === "eleven_v4_turbo") {
    const audio = await synthesizeDialogueAudio(
      text,
      key,
      { voice_id: config.voice_id, model_id: config.model_id, stability: config.stability },
      language,
      fetcher
    );
    return { audio, mimeType: "audio/mpeg" };
  }

  const endpoint = new URL(
    "https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(config.voice_id)
  );
  endpoint.searchParams.set("output_format", "mp3_44100_128");
  let lastError = "ElevenLabs request failed";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response: Response;
    try {
      response = await fetcher(endpoint.toString(), {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: config.model_id,
          language_code: language === "en" ? "en" : "ar",
          voice_settings: {
            stability: config.stability,
            similarity_boost: config.similarity_boost,
            speed: config.speed,
            use_speaker_boost: true,
          },
        }),
        signal: controller.signal,
      });
    } catch {
      lastError = "network request failed";
      if (attempt === 3) throw new Error("ElevenLabs network/timeout error: " + lastError);
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType && !contentType.startsWith("audio/") && !contentType.includes("octet-stream")) {
        throw new Error("ElevenLabs returned unexpected content type");
      }
      const audio = await response.arrayBuffer();
      if (audio.byteLength < 100) throw new Error("ElevenLabs returned empty or incomplete MP3 audio");
      return { audio, mimeType: "audio/mpeg" };
    }

    await response.body?.cancel();
    lastError = "ElevenLabs HTTP " + response.status;
    const retryable =
      response.status === 429 ||
      response.status === 500 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504;
    if (!retryable || attempt === 3) throw new Error(lastError);
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const delayMs = retryAfter > 0 ? Math.min(3000, Math.max(250, retryAfter * 1000)) : attempt * 400;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(lastError);
}
