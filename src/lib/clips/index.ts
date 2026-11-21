// طبقة المكتبة الصوتية: قبل طلب التوليد الحي، نطابق الرد مع جملة معتمدة جاهزة.
import type { TtsResult } from "../tts/types";
import { matchClipSlug, pickClipVariant } from "./registry";

const CLIPS_URL = "https://mizanconsult.com/clips/";

interface ClipCallState { played: Set<string>; cache: Map<string, ArrayBuffer>; }
const calls = new Map<string, ClipCallState>();

function stateFor(sessionId: string): ClipCallState {
  let state = calls.get(sessionId);
  if (!state) {
    if (calls.size > 8) {
      const oldest = calls.keys().next().value;
      if (oldest) calls.delete(oldest);
    }
    state = { played: new Set(), cache: new Map() };
    calls.set(sessionId, state);
  }
  return state;
}

/** صوت جاهز لو النص جملة معتمدة، أو null عشان التوليد الحي يكمّل عادي. */
export async function libraryClipForSpeech(
  env: { ASSETS?: Fetcher },
  sessionId: string,
  text: string
): Promise<TtsResult | null> {
  const slug = matchClipSlug(text);
  if (!slug || !sessionId) return null;
  const state = stateFor(sessionId);
  const variant = pickClipVariant(slug, sessionId, state.played);
  if (!variant) return null;
  let wav = state.cache.get(variant);
  if (!wav) {
    try {
      const request = new Request(CLIPS_URL + variant + ".wav");
      const response = env.ASSETS ? await env.ASSETS.fetch(request) : await fetch(request);
      if (!response.ok) return null;
      wav = await response.arrayBuffer();
      if (wav.byteLength < 1000) return null;
      state.cache.set(variant, wav);
    } catch {
      return null;
    }
  }
  state.played.add(variant);
  return { audio: wav, mimeType: "audio/wav", provider: "library", attempts: [{ provider: "library", ok: true }] };
}
