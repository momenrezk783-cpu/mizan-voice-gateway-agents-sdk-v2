// ============================================================================
// TTS provider contract
// ============================================================================
// One shape for every speech provider so the agent never talks to a vendor
// directly. Adding a third provider means adding one file here, not editing
// agent.ts.

export type TtsProviderId = "elevenlabs" | "google";

/** The voice settings a provider needs. ElevenLabs fields are ignored by Google. */
export interface TtsVoiceConfig {
  voice_id: string;
  model_id: string;
  stability: number;
  similarity_boost: number;
  speed: number;
}

export interface TtsEnv {
  ELEVENLABS_TTS_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  GOOGLE_TTS_API_KEY?: string;
  GOOGLE_TTS_VOICE?: string;
  TTS_PROVIDER?: string;
  TTS_FALLBACK_PROVIDER?: string;
}

export interface TtsRequest {
  text: string;
  language: "ar" | "en";
  voice: TtsVoiceConfig;
}

/** What happened on one provider, in order. Safe to log: no credentials. */
export interface TtsAttempt {
  provider: TtsProviderId;
  ok: boolean;
  reason?: string;
}

export interface TtsResult {
  audio: ArrayBuffer;
  mimeType: string;
  provider: TtsProviderId;
  attempts: TtsAttempt[];
}