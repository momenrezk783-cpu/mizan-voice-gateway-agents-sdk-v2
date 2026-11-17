// ============================================================================
// Google TTS (Gemini API / AI Studio key)
// ============================================================================
// Uses the Generative Language API, which is the same surface an AI Studio API
// key unlocks. No Cloud billing account is required for the free tier, which is
// why this provider exists: it is the fallback when an ElevenLabs balance runs
// out and a card cannot be charged.
//
// Response shape: candidates[0].content.parts[0].inlineData.data is base64 raw
// PCM (mime type `audio/L16;codec=pcm;rate=24000`). We wrap it in WAV because
// the browser cannot decode headerless PCM.

import { pcm16ToWav, parsePcmSampleRate } from "./wav";

export const DEFAULT_GOOGLE_TTS_MODEL = "gemini-2.5-flash-preview-tts";
export const DEFAULT_GOOGLE_TTS_VOICE = "Kore";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface GoogleTtsOptions {
  language: "ar" | "en";
  voiceName?: string;
  model?: string;
  timeoutMs?: number;
}

export interface GoogleTtsResult {
  audio: ArrayBuffer;
  mimeType: string;
}

interface InlineAudioPart {
  inlineData?: { data?: unknown; mimeType?: unknown };
}

/**
 * Speak `text` through Google's TTS models.
 *
 * Throws with a short, credential-free message on failure so the caller can fall
 * back to another provider without leaking anything into logs.
 */
export async function synthesizeGoogleSpeech(
  text: string,
  apiKey: string,
  options: GoogleTtsOptions,
  fetcher: typeof fetch = fetch
): Promise<GoogleTtsResult> {
  const key = (apiKey || "").trim();
  if (!key) throw new Error("GOOGLE_TTS_API_KEY is not configured");
  const clean = text.trim();
  if (!clean) throw new Error("Google TTS received empty text");

  const model = options.model || DEFAULT_GOOGLE_TTS_MODEL;
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
  try {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header auth keeps the key out of URLs, logs and proxies.
          "x-goog-api-key": key,
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: clean }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: options.voiceName || DEFAULT_GOOGLE_TTS_VOICE,
                },
              },
            },
          },
        }),
      });
    } catch {
      throw new Error("Google TTS network/timeout error");
    }

    if (!response.ok) {
      await response.body?.cancel();
      // Provider bodies can echo the key back: never surface them.
      throw new Error(`Google TTS HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Google TTS returned invalid JSON");
    }

    const candidates = (payload as { candidates?: { content?: { parts?: InlineAudioPart[] } }[] })?.candidates;
    const parts = candidates?.[0]?.content?.parts ?? [];
    const audioPart = parts.find((part) => typeof part?.inlineData?.data === "string");
    const data = audioPart?.inlineData?.data;
    if (typeof data !== "string" || !data) throw new Error("Google TTS returned no audio");

    const mimeType = String(audioPart?.inlineData?.mimeType ?? "");
    let pcm: Uint8Array;
    try {
      pcm = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    } catch {
      throw new Error("Google TTS returned undecodable audio");
    }
    if (pcm.byteLength < 200) throw new Error("Google TTS returned incomplete audio");
    if (pcm.byteLength > MAX_AUDIO_BYTES) throw new Error("Google TTS audio limit exceeded");

    // Raw PCM (or an unlabelled payload) gets a WAV header so decodeAudioData works.
    if (!mimeType || /pcm|l16|wave|x-wav/i.test(mimeType)) {
      const sampleRate = parsePcmSampleRate(mimeType);
      return { audio: pcm16ToWav(pcm, sampleRate), mimeType: "audio/wav" };
    }

    // Anything already in a container the browser understands is passed through.
    return {
      audio: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
      mimeType,
    };
  } finally {
    clearTimeout(timeout);
  }
}
