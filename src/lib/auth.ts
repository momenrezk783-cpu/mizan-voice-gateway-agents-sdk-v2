// ============================================================================
// Mizan Voice Gateway — Session Authentication
// ============================================================================
// Cookie-based session using HMAC-SHA256 signed tokens.
// Session cookie: __Host-mizan_session (Secure, HttpOnly, SameSite=Strict, Path=/)

export interface SessionUser {
  id: string;
  email: string;
  role: "super_admin" | "clinic_admin";
  tenantSlug: string;
}

const COOKIE_NAME = "__Host-mizan_session";
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Extract and verify the session cookie from the request.
 * Returns the decoded SessionUser, or null if not authenticated.
 */
export async function getSessionUser(
  request: Request,
  env: { SESSION_SECRET: string }
): Promise<SessionUser | null> {
  const cookie = parseCookie(request, COOKIE_NAME);
  if (!cookie) return null;

  try {
    const payload = await verifyToken(cookie, env.SESSION_SECRET);
    return payload as SessionUser;
  } catch {
    return null;
  }
}

/**
 * Create a signed session token and set it as a cookie header.
 */
export async function createSessionResponse(
  user: SessionUser,
  env: { SESSION_SECRET: string }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({ ...user, iat: now, exp: now + SESSION_TTL }, env.SESSION_SECRET);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`;
}

/**
 * Generate a cookie header that clears the session.
 */
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * Verify that the authenticated user has access to the given tenant.
 * Super admins can access any tenant. Clinic admins are scoped to their own.
 */
export function canAccessTenant(
  user: SessionUser,
  tenantSlug: string
): boolean {
  if (user.role === "super_admin") return true;
  return user.tenantSlug === tenantSlug;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 Token Implementation (Web Crypto API)
// ---------------------------------------------------------------------------

async function signToken(
  payload: SessionUser & { iat: number; exp: number },
  secret: string
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const data = enc.encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", key, data);

  // Base64url encode
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const payloadB64 = btoa(String.fromCharCode(...enc.encode(JSON.stringify(payload))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${payloadB64}.${sigB64}`;
}

async function verifyToken(
  token: string,
  secret: string
): Promise<SessionUser> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid token format");
  const [payloadB64, sigB64] = parts;

  // Decode only after checking token shape. Claims are trusted only after verifying the HMAC.
  const payloadBytes = Uint8Array.from(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const payloadJson = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);

  // Verify signature
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sigBytes = Uint8Array.from(
    atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );

  const data = enc.encode(payloadJson);
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, data);
  if (!valid) throw new Error("Invalid signature");

  const payload: unknown = JSON.parse(payloadJson);
  if (!payload || typeof payload !== "object") throw new Error("Invalid claims");
  const claims = payload as Partial<SessionUser> & { iat?: number; exp?: number };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.exp! <= now || claims.iat! > now + 60 ||
      claims.exp! <= claims.iat! || claims.exp! - claims.iat! > SESSION_TTL ||
      typeof claims.id !== "string" || !claims.id ||
      typeof claims.email !== "string" || !claims.email ||
      typeof claims.tenantSlug !== "string" ||
      (claims.role !== "super_admin" && claims.role !== "clinic_admin")) {
    throw new Error("Expired or invalid session claims");
  }
  return { id: claims.id, email: claims.email, role: claims.role, tenantSlug: claims.tenantSlug };
}

function parseCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("Cookie");
  if (!cookies) return null;

  for (const part of cookies.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * Hash a password using PBKDF2 (Web Crypto API).
 * Returns "salt:hash" in base64.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return `${saltB64}:${hashB64}`;
}

/**
 * Verify a password against a stored "salt:hash" string.
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(":");
  if (!saltB64 || !hashB64) return false;

  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const computedB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return computedB64 === hashB64;
}
