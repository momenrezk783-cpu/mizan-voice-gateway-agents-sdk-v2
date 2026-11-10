/** Login attempt counters; keys contain only SHA-256 digests of normalized identities. */
// Keys contain only SHA-256 digests of a normalized address or a Cloudflare-supplied IP.
export async function loginRateKey(prefix: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${prefix}:${value}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `${prefix}:${Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("")}`;
}

export async function loginThrottleCheck(env: { DB: D1Database }, keys: Array<{ key: string; limit: number }>, now: number): Promise<number> {
  for (const { key, limit } of keys) {
    const row = await env.DB.prepare(`SELECT failures, reset_at FROM auth_login_attempts WHERE attempt_key = ?`)
      .bind(key).first<{ failures: number; reset_at: number }>();
    if (row && row.reset_at > now && row.failures >= limit) return row.reset_at - now;
  }
  return 0;
}

export async function recordFailedLogin(env: { DB: D1Database }, keys: Array<{ key: string; limit: number }>, now: number): Promise<void> {
  for (const { key } of keys) {
    await env.DB.prepare(`INSERT INTO auth_login_attempts (attempt_key, failures, reset_at)
        VALUES (?, 1, ?)
        ON CONFLICT(attempt_key) DO UPDATE SET
        failures = CASE WHEN reset_at <= ? THEN 1 ELSE failures + 1 END,
        reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END`)
      .bind(key, now + 900, now, now).run();
  }
}

