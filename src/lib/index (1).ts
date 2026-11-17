// ============================================================================
// Speech synthesis — provider selection and failover
// ============================================================================
// The agent calls synthesizeSpeech() and never names a vendor. Providers are
// tried in order; a failure on one falls through to the next, so a spent
// balance or a revoked key degrades the voice instead of silencing the call.
//
// Selection order:
//   1. TTS_PROVIDER              (optional env var, forces the first provider)
//   2. otherwise ElevenLabs when its key is present, else Google
//   3. TTS_FALLBACK_PROVIDER     (optional env var, forces the second provider)
//   4. otherwise the other provider, when its key is present
//
// A provider with no configured key is skipped, so adding GOOGLE_TTS_API_KEY as
// a secret is enough to gain automatic failover — no config edit, no redeploy
// of application code.

import { synthesizeElevenLabsSpeech } from "./elevenlabs";
import { synthesizeGoogleSpeech } from "./google";
import type { TtsAttempt, TtsEnv, TtsProviderId, TtsRequest, TtsResult } from "./types";

export type { TtsAttempt, TtsEnv, TtsProviderId, TtsRequest, TtsResult, TtsVoiceConfig } from "./types";
export { pcm16ToWav, parsePcmSampleRate } from "./wav";

const PROVIDERS: TtsProviderId[] = ["elevenlabs", "google"];

function asProvider(value: string | undefined): TtsProviderId | null {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return null;
  return PROVIDERS.includes(normalized as TtsProviderId) ? (normalized as TtsProviderId) : null;
}

function hasCredentials(provider: TtsProviderId, env: TtsEnv): boolean {
  if (provider === "elevenlabs") {
    return Boolean((env.ELEVENLABS_TTS_KEY || env.ELEVENLABS_API_KEY || "").trim());
  }
  return Boolean((env.GOOGLE_TTS_API_KEY || "").trim());
}

/**
 * The provider order for this environment. Exported so tests and diagnostics can
 * show what would be tried without making a request.
 */
export function resolveProviderOrder(env: TtsEnv): TtsProviderId[] {
  const forced = asProvider(env.TTS_PROVIDER);
  const primary = forced ?? (hasCredentials("elevenlabs", env) ? "elevenlabs" : "google");
  const forcedFallback = asProvider(env.TTS_FALLBACK_PROVIDER);
  const secondary =
    forcedFallback ?? (primary === "elevenlabs" ? "google" : "elevenlabs");

  const ordered = [primary, secondary].filter(
    (provider, index, list) => provider && list.indexOf(provider) === index
  ) as TtsProviderId[];

  const usable = ordered.filter((provider) => hasCredentials(provider, env));
  // When nothing is configured, keep the order so the thrown error names a provider.
  return usable.length > 0 ? usable : ordered;
}

/** Shorten a provider error to something safe to log: no keys, no bodies. */
function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

async function callProvider(
  provider: TtsProviderId,
  env: TtsEnv,
  request: TtsRequest,
  fetcher: typeof fetch
): Promise<{ audio: ArrayBuffer; mimeType: string }> {
  if (provider === "elevenlabs") {
    const key = env.ELEVENLABS_TTS_KEY || env.ELEVENLABS_API_KEY || "";
    return await synthesizeElevenLabsSpeech(request.text, key, request.voice, request.language, fetcher);
  }
  return await synthesizeGoogleSpeech(
    request.text,
    env.GOOGLE_TTS_API_KEY || "",
    { language: request.language, voiceName: env.GOOGLE_TTS_VOICE },
    fetcher
  );
}

/**
 * Synthesise `request.text` using the first provider that succeeds.
 *
 * Always returns the attempt log alongside the audio, so the caller can record
 * which provider actually spoke and why the others did not.
 */
export async function synthesizeSpeech(
  env: TtsEnv,
  request: TtsRequest,
  deps: { fetcher?: typeof fetch } = {}
): Promise<TtsResult> {
  const fetcher = deps.fetcher ?? fetch;
  const text = (request.text || "").trim();
  if (!text) throw new Error("synthesizeSpeech received empty text");

  const order = resolveProviderOrder(env);
  const attempts: TtsAttempt[] = [];
  let lastError: unknown = null;

  for (const provider of order) {
    try {
      const result = await callProvider(provider, env, { ...request, text }, fetcher);
      attempts.push({ provider, ok: true });
      return { ...result, provider, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({ provider, ok: false, reason: safeReason(error) });
    }
  }

  const summary = attempts.map((attempt) => `${attempt.provider}: ${attempt.reason}`).join(" | ");
  const failure = new Error("All TTS providers failed: " + summary);
  (failure as Error & { attempts?: TtsAttempt[] }).attempts = attempts;
  (failure as Error & { cause?: unknown }).cause = lastError;
  throw failure;
}