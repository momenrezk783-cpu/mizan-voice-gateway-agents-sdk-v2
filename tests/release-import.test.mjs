import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteD1, importTs } from "./helpers/runtime.mjs";

const { createSessionResponse } = await importTs("src/lib/auth.ts");
const studioWorker = (await importTs("src/studio-entry.ts")).default;
const prodGateway = (await importTs("src/index.ts")).default;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizan-release-import-"));
const devDb = new SqliteD1(path.join(tmpDir, "dev.sqlite"));
const prodDb = new SqliteD1(path.join(tmpDir, "prod.sqlite"));

try {
  const migrations = [
    "schema.sql",
    "migration-001.sql",
    "migration-002.sql",
    "migration-003.sql",
    "migration-004.sql",
    "migration-005.sql",
    "migration-006.sql",
    "migration-007.sql",
    "migration-008.sql"
  ];
  for (const m of migrations) {
    devDb.apply(m);
    prodDb.apply(m);
  }
  devDb.apply("scripts/seed-studio-dev.sql");

  // Seed existing tenant + call history in Production D1 to verify import never touches calls/contacts/billing
  await prodDb.batch([
    prodDb
      .prepare(
        `INSERT INTO tenants (id, slug, name, industry, status, plan_tier, max_concurrent_sessions, theme_color)
         VALUES ('c_alex-pilot-01', 'alex-pilot-01', 'عيادة الإسكندرية', 'general', 'active', 'production_pbx', 5, '#0891b2')`
      )
      .bind(),
    prodDb
      .prepare(
        `INSERT INTO tenant_voice_config (tenant_slug, system_prompt, voice_id, tenant_customization)
         VALUES ('alex-pilot-01', 'أنت ميزان، المساعد الصوتي المصري العام.', '2DkHmQavK9V2UzTYrMYT', 'إعدادات قديمة قبل الترقية.')`
      )
      .bind(),
    prodDb
      .prepare(
        `INSERT INTO call_sessions (id, tenant_slug, direction, call_status, booking_confirmed, started_at)
         VALUES ('sess-prod-01', 'alex-pilot-01', 'inbound', 'completed', 1, 1760000000)`
      )
      .bind()
  ]);

  const sharedSigningKey = "shared-hmac-signing-key-between-dev-and-prod-32b";
  const devEnv = {
    ENVIRONMENT: "staging",
    RUNTIME_VERSION: "v2.2.0-dev",
    SESSION_SECRET: "dev-session-secret-minimum-32-characters",
    PROMOTION_SIGNING_KEY: sharedSigningKey,
    STUDIO_API_TOKEN: "dev-studio-api-token-for-export-test",
    DB: devDb,
    TENANT_CONFIG: { get: async () => null, put: async () => {}, delete: async () => {} }
  };

  const prodDeletedKv = [];
  const prodEnv = {
    ENVIRONMENT: "production",
    SESSION_SECRET: "prod-session-secret-completely-different-32b",
    PROMOTION_SIGNING_KEY: sharedSigningKey,
    CONTACT_ENC_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ADMIN_PASSKEY_HASH: "unused",
    VOICE_WS_BASE: "wss://voice.mizanconsult.com",
    PRIMARY_LLM: "@cf/daily-co/phonellm-mini-alpha-2",
    FALLBACK_LLM: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    DB: prodDb,
    TENANT_CONFIG: {
      get: async () => null,
      put: async () => {},
      delete: async (k) => {
        prodDeletedKv.push(k);
      }
    }
  };
  const ctx = { waitUntil() {} };

  // 1. Publish v2 in Dev and export signed bundle
  await studioWorker.fetch(
    new Request("https://studio.example.workers.dev/api/ops/agents/publish", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${devEnv.STUDIO_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tenantId: "alex-pilot-01",
        industry: "healthcare",
        voiceId: "2DkHmQavK9V2UzTYrMYT",
        tenantCustomization: "نسخة مختبرة في الاستوديو جاهزة للإنتاج.",
        knowledgeText: "مواعيد العيادة الجديدة من 11 صباحاً حتى 9 مساءً."
      })
    }),
    devEnv,
    ctx
  );

  const exportRes = await studioWorker.fetch(
    new Request("https://studio.example.workers.dev/api/ops/agents/export?tenantId=alex-pilot-01&version=2", {
      headers: { Authorization: `Bearer ${devEnv.STUDIO_API_TOKEN}` }
    }),
    devEnv,
    ctx
  );
  assert.equal(exportRes.status, 200);
  const { bundle } = await exportRes.json();
  assert.equal(bundle.payload.sourceVersion, 2);
  assert.equal(bundle.payload.tenantSlug, "alex-pilot-01");

  const prodOrigin = "https://mizanconsult.com";
  const superAdminCookie = (
    await createSessionResponse(
      { id: "sa-1", email: "owner@mizanconsult.com", role: "super_admin", tenantSlug: "mizan-hq" },
      prodEnv
    )
  ).match(/=(.*?);/)[1];
  const clinicAdminCookie = (
    await createSessionResponse(
      { id: "ca-1", email: "clinic@example.com", role: "clinic_admin", tenantSlug: "alex-pilot-01" },
      prodEnv
    )
  ).match(/=(.*?);/)[1];

  // 2. Reject non-super_admin and cross-origin CSRF
  {
    const nonAdminRes = await prodGateway.fetch(
      new Request(`${prodOrigin}/api/admin/releases/import`, {
        method: "POST",
        headers: {
          Cookie: `__Host-mizan_session=${clinicAdminCookie}`,
          Origin: prodOrigin,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bundle, dryRun: true })
      }),
      prodEnv,
      ctx
    );
    assert.equal(nonAdminRes.status, 403, "clinic_admin must not import releases");

    const csrfRes = await prodGateway.fetch(
      new Request(`${prodOrigin}/api/admin/releases/import`, {
        method: "POST",
        headers: {
          Cookie: `__Host-mizan_session=${superAdminCookie}`,
          Origin: "https://attacker.example.com",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bundle, dryRun: true })
      }),
      prodEnv,
      ctx
    );
    assert.equal(csrfRes.status, 403, "Cross-origin release import must be rejected");
  }

  // 3. Reject tampered payload or bad HMAC signature
  {
    const badSigBundle = { ...bundle, signature: "0".repeat(64) };
    const badSigRes = await prodGateway.fetch(
      new Request(`${prodOrigin}/api/admin/releases/import`, {
        method: "POST",
        headers: {
          Cookie: `__Host-mizan_session=${superAdminCookie}`,
          Origin: prodOrigin,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bundle: badSigBundle })
      }),
      prodEnv,
      ctx
    );
    assert.equal(badSigRes.status, 403, "Invalid HMAC signature must be rejected");

    const tamperedPayloadBundle = {
      ...bundle,
      payload: { ...bundle.payload, tenantCustomization: "تم التعديل بدون توقيع" }
    };
    const tamperedRes = await prodGateway.fetch(
      new Request(`${prodOrigin}/api/admin/releases/import`, {
        method: "POST",
        headers: {
          Cookie: `__Host-mizan_session=${superAdminCookie}`,
          Origin: prodOrigin,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bundle: tamperedPayloadBundle })
      }),
      prodEnv,
      ctx
    );
    assert.equal(tamperedRes.status, 400, "Tampered payload content hash must be rejected");
  }

  // 4. Dry-run diff makes zero writes to Production D1
  {
    const dryRes = await prodGateway.fetch(
      new Request(`${prodOrigin}/api/admin/releases/import`, {
        method: "POST",
        headers: {
          Cookie: `__Host-mizan_session=${superAdminCookie}`,
          Origin: prodOrigin,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bundle, dryRun: true })
      }),
      prodEnv,
      ctx
    );
    assert.equal(dryRes.status, 200);
    const dryData = await dryRes.json();
    assert.equal(dryData.ok, true);
    assert.equal(dryData.dryRun, true);
    assert.ok(dryData.diff.changes.some((c) => c.includes("industry: general -> healthcare")));

    const beforePromote = await prodDb
      .prepare("SELECT tenant_customization FROM tenant_voice_config WHERE tenant_slug = 'alex-pilot-01'")
      .first();
    assert.equal(
      beforePromote.tenant_customization,
      "إعدادات قديمة قبل الترقية.",
      "Dry-run must not mutate production tenant_voice_config"
    );
  }

  // 5. Real import promotes config, purges KV, and preserves existing call sessions
  {
    const impRes = await prodGateway.fetch(
      new Request(`${prodOrigin}/api/admin/releases/import`, {
        method: "POST",
        headers: {
          Cookie: `__Host-mizan_session=${superAdminCookie}`,
          Origin: prodOrigin,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bundle, dryRun: false })
      }),
      prodEnv,
      ctx
    );
    assert.equal(impRes.status, 200);
    const impData = await impRes.json();
    assert.equal(impData.ok, true);
    assert.equal(impData.dryRun, false);
    assert.equal(impData.activatedVersion, 1);

    const afterVoice = await prodDb
      .prepare("SELECT system_prompt, tenant_customization FROM tenant_voice_config WHERE tenant_slug = 'alex-pilot-01'")
      .first();
    assert.equal(afterVoice.system_prompt, "أنت ميزان، المساعد الصوتي المصري العام.");
    assert.equal(afterVoice.tenant_customization, "نسخة مختبرة في الاستوديو جاهزة للإنتاج.");

    const callCount = await prodDb
      .prepare("SELECT COUNT(*) AS cnt FROM call_sessions WHERE tenant_slug = 'alex-pilot-01'")
      .first();
    assert.equal(callCount.cnt, 1, "Production call sessions must remain untouched after config import");
    assert.ok(prodDeletedKv.includes("voice_config:alex-pilot-01"), "Production KV cache must be invalidated");
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("PASS HMAC-signed release bundle export, dry-run diff, CSRF/HMAC verification, and safe production promotion");
