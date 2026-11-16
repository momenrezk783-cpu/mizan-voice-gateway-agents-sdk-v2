/**
 * Post-deploy smoke check for `mizan-voice-studio-dev`.
 * Verifies authentication boundary, non-production isolation, and deterministic
 * quality gates (`/api/ops/status` and `/api/ops/gates/run`).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function runStudioSmokeCheck({
  baseUrl = process.env.STUDIO_BASE_URL || "",
  token = process.env.STUDIO_API_TOKEN || "",
  fetchImpl = globalThis.fetch,
  log = console.log
} = {}) {
  const trimmedBase = String(baseUrl || "").trim().replace(/\/+$/, "");
  const trimmedToken = String(token || "").trim();
  if (!trimmedBase || !/^https?:\/\//i.test(trimmedBase)) {
    log("SMOKE FAIL: Valid STUDIO_BASE_URL (http/https) is required");
    return 2;
  }
  if (!trimmedToken || trimmedToken.length < 16) {
    log("SMOKE FAIL: Valid STUDIO_API_TOKEN (>= 16 chars) is required");
    return 2;
  }

  try {
    // 1. Unauthenticated request must be rejected (401/403)
    const unauthRes = await fetchImpl(`${trimmedBase}/api/ops/status`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (unauthRes.status !== 401 && unauthRes.status !== 403) {
      log(`SMOKE FAIL: Expected 401/403 for unauthenticated /api/ops/status, got ${unauthRes.status}`);
      return 2;
    }

    // 2. Authenticated status check
    const statusRes = await fetchImpl(`${trimmedBase}/api/ops/status`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${trimmedToken}`
      }
    });
    if (!statusRes.ok) {
      log(`SMOKE FAIL: /api/ops/status returned HTTP ${statusRes.status}`);
      return 2;
    }
    const statusData = await statusRes.json();
    if (!statusData?.ok || statusData.environment === "production") {
      log("SMOKE FAIL: Studio status response invalid or running in production mode");
      return 2;
    }

    // 3. Deterministic gates check
    const gatesRes = await fetchImpl(`${trimmedBase}/api/ops/gates/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${trimmedToken}`
      },
      body: JSON.stringify({})
    });
    if (!gatesRes.ok) {
      log(`SMOKE FAIL: /api/ops/gates/run returned HTTP ${gatesRes.status}`);
      return 2;
    }
    const gatesData = await gatesRes.json();
    if (!gatesData?.ok || !Array.isArray(gatesData.gates)) {
      log("SMOKE FAIL: One or more Studio quality gates failed");
      return 2;
    }

    log(`PASS: Studio smoke check succeeded (${trimmedBase}, env=${statusData.environment}, agents=${statusData.agents?.length ?? 0})`);
    return 0;
  } catch (err) {
    log(`SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runStudioSmokeCheck();
}
