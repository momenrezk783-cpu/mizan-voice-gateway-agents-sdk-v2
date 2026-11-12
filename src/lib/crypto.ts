// ============================================================================
// Mizan Voice Gateway — AES-GCM 256-bit PII Encryption
// ============================================================================
// Used for encrypting caller_name and caller_phone in call_sessions.
// One technical protection; encryption alone does not establish legal compliance.
// CONTACT_ENC_KEY accepts a 32-byte key encoded as base64 or 64 hexadecimal digits.

/**
 * Encrypt plaintext using AES-GCM 256-bit.
 * Returns base64(IV || ciphertext) — IV is 12 bytes prepended.
 */
export async function encryptPII(
  plaintext: string,
  env: { CONTACT_ENC_KEY: string }
): Promise<string> {
  const key = await importKey(env.CONTACT_ENC_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt AES-GCM 256-bit encrypted data.
 * Input is base64(IV || ciphertext).
 */
export async function decryptPII(
  encrypted: string,
  env: { CONTACT_ENC_KEY: string }
): Promise<string> {
  const key = await importKey(env.CONTACT_ENC_KEY);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Redact PII (phone numbers) from a transcript for audit storage.
 * Replaces Egyptian mobile numbers with [رقم موبايل].
 */
export function redactPII(text: string): string {
  // Normalize Arabic-Indic and Persian digits before matching formatted numbers.
  const normalized = text.replace(/[٠-٩۰-۹]/gu, c => String(c.charCodeAt(0) - (c <= "٩" ? 0x660 : 0x6f0)));
  return normalized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[بريد إلكتروني]")
    .replace(/(?<!\d)(?:\d[\s().-]*){14}(?!\d)/gu, "[رقم قومي]")
    .replace(/(?<!\d)(?:\+?2[\s().-]*)?0[\s().-]*1[\s().-]*[0125](?:[\s().-]*\d){8}(?!\d)/gu, "[رقم موبايل]")
    .replace(/(?<!\d)\+[1-9](?:[\s().-]*\d){7,14}(?!\d)/gu, "[رقم هاتف]");
}

// ---------------------------------------------------------------------------
// Internal: Import the existing AES-GCM key without changing its key material.
// ---------------------------------------------------------------------------

async function importKey(base64Key: string): Promise<CryptoKey> {
  if (typeof base64Key !== "string") throw new Error("CONTACT_ENC_KEY is not configured");
  const encoded = base64Key.trim();
  let rawKey: Uint8Array;
  if (/^[a-f0-9]{64}$/iu.test(encoded)) {
    rawKey = Uint8Array.from(encoded.match(/../g)!, byte => parseInt(byte, 16));
  } else {
    try { rawKey = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); }
    catch { throw new Error("CONTACT_ENC_KEY must encode a 32-byte AES key"); }
  }
  if (rawKey.length !== 32) throw new Error("CONTACT_ENC_KEY must encode a 32-byte AES key");
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
