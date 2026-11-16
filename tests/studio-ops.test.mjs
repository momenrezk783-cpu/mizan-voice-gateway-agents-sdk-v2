import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { SqliteD1, importTs } from "./helpers/runtime.mjs";
import { runStudioSmokeCheck } from "../scripts/smoke-studio.mjs";

const { createSessionResponse } = await importTs("src/lib/auth.ts");
const studioWorker = (await importTs("src/studio-entry.ts")).default;

// 1. Static verification of Studio UI assets (syntax + zero innerHTML XSS sinks)
{
  const studioHtml = fs.readFileSync("public/studio.html", "utf8");
  const studioJs = fs.readFileSync("public/js/studio.js", "utf8");
  assert.doesNotThrow(() => new vm.Script(studioJs, { filename: "public/js/studio.js" }));
  assert.ok(!studioJs.includes(".innerHTML"), "studio.js must use textContent instead of innerHTML");
  assert.ok(studioJs.includes("/api/voice/token"), "studio.js must request a signed call ticket");
  assert.ok(studioJs.includes("/pcm-processor.js"), "studio.js must use AudioWorklet /pcm-processor.js");
  assert.ok(!studioJs.includes("createScriptProcessor"), "Deprecated ScriptProcessorNode must not be used");
  assert.ok(!studioJs.includes("/ws/call"), "Unauthenticated prototype /ws/call route must not be used");
  assert.ok(studioHtml.includes('<script src="/js/studio.js"></script>'), "studio.html must load external studio.js");
}

// 2. Apply schema.sql + migrations 001..008 + seed-studio-dev.sql on real SQLite D1
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizan-studio-ops-"));
const dbFile = path.join(tmpDir, "studio.sqlite");
const db = new SqliteD1(dbFile);

try {
  for (const sqlFile of [
    "schema.sql",
    "migration-001.sql",
    "migration-002.sql",
    "migration-003.sql",
    "migration-004.sql",
    "migration-005.sql",
    "migration-006.sql",
    "migration-007.sql",
    "migration-008.sql",
    "scripts/seed-studio-dev.sql"
  ]) {
    db.apply(sqlFile);
  }

  const kvStore = new Map();
  const deletedKeys = [];
  const env = {
    ENVIRONMENT: "staging",
    RUNTIME_VERSION: "v2.2.0-studio-test",
    OPENCODE_HARNESS_URL: "https://opencode-harness-example.example.workers.dev",
    SESSION_SECRET: "studio-test-session-secret-minimum-32-chars",
    PROMOTION_SIGNING_KEY: "studio-test-promotion-signing-secret-32-chars",
    STUDIO_API_TOKEN: "studio-bearer-token-for-opencode-harness",
    CONTACT_ENC_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    DEEPGRAM_API_KEY: "dg-test-key",
    ELEVENLABS_TTS_KEY: "el-test-key",
    PRIMARY_LLM: "@cf/daily-co/phonellm-mini-alpha-2",
    FALLBACK_LLM: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    AI: {},
    DB: db,
    TENANT_CONFIG: {
      async get(key, type) {
        const val = kvStore.get(key);
        if (!val) return null;
        return type === "json" ? JSON.parse(val) : val;
      },
      async put(key, val) {
        kvStore.set(key, val);
      },
      async delete(key) {
        deletedKeys.push(key);
        kvStore.delete(key);
      }
    },
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/studio.html") {
          return new Response(fs.readFileSync("public/studio.html", "utf8"), { status: 200 });
        }
        if (u.pathname === "/js/studio.js") {
          return new Response(fs.readFileSync("public/js/studio.js", "utf8"), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }
    }
  };

  const ctx = { waitUntil() {} };
  const base = "https://mizan-voice-studio-dev.example.workers.dev";
  const authHeaders = {
    Authorization: `Bearer ${env.STUDIO_API_TOKEN}`,
    "Content-Type": "application/json"
  };

  // 3. Fail-closed on ENVIRONMENT = "production"
  {
    const prodEnv = { ...env, ENVIRONMENT: "production" };
    const res = await studioWorker.fetch(new Request(`${base}/api/ops/status`, { headers: authHeaders }), prodEnv, ctx);
    assert.equal(res.status, 404, "Studio routes must return 404 when ENVIRONMENT is production");
  }

  // 4. Auth & CSRF enforcement
  {
    const unauth = await studioWorker.fetch(new Request(`${base}/api/ops/status`), env, ctx);
    assert.equal(unauth.status, 401, "Unauthenticated Studio request must return 401");

    const badToken = await studioWorker.fetch(
      new Request(`${base}/api/ops/status`, { headers: { Authorization: "Bearer wrong-token" } }),
      env,
      ctx
    );
    assert.equal(badToken.status, 401, "Wrong Bearer token must return 401");

    const superCookie = (
      await createSessionResponse(
        { id: "admin-1", email: "admin@mizanconsult.com", role: "super_admin", tenantSlug: "mizan-hq" },
        env
      )
    ).match(/=(.*?);/)[1];

    const crossOriginPost = await studioWorker.fetch(
      new Request(`${base}/api/ops/gates/run`, {
        method: "POST",
        headers: {
          Cookie: `__Host-mizan_session=${superCookie}`,
          Origin: "https://evil.example.com",
          "Content-Type": "application/json"
        },
        body: "{}"
      }),
      env,
      ctx
    );
    assert.equal(crossOriginPost.status, 403, "Cookie-authenticated POST from foreign Origin must be rejected (CSRF)");

    const studioPageRes = await studioWorker.fetch(
      new Request(`${base}/studio`, {
        headers: { Cookie: `__Host-mizan_session=${superCookie}`, Accept: "text/html" }
      }),
      env,
      ctx
    );
    assert.equal(studioPageRes.status, 200);
    assert.match(studioPageRes.headers.get("Content-Security-Policy") || "", /script-src 'self'/);
  }

  // 5. Status endpoint returns seeded agents at v1 + locked prompt layers
  {
    const res = await studioWorker.fetch(new Request(`${base}/api/ops/status`, { headers: authHeaders }), env, ctx);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.agents.length, 3);
    assert.ok(data.lockedLayers.globalSystemPrompt.includes("أنت ميزان"));
    assert.ok(data.lockedLayers.industryGuards.healthcare.includes("تشخيص"));
    const alex = data.agents.find((a) => a.tenant_id === "alex-pilot-01");
    assert.equal(alex.active_version, 1);
  }

  // 6. Publish v2 -> Rollback to v1 -> Re-activate v2 (immutable versions, KV purged, locked prompt preserved)
  {
    deletedKeys.length = 0;
    const pubRes = await studioWorker.fetch(
      new Request(`${base}/api/ops/agents/publish`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          tenantId: "alex-pilot-01",
          industry: "healthcare",
          voiceId: "2DkHmQavK9V2UzTYrMYT",
          tenantCustomization: "تحديث إصدار 2: العيادة تعمل أيضاً يوم السبت.",
          knowledgeText: "مواعيد العمل من السبت للخميس من 9 صباحاً حتى 9 مساءً."
        })
      }),
      env,
      ctx
    );
    const pubData = await pubRes.json();
    assert.equal(pubData.ok, true);
    assert.equal(pubData.activeVersion, 2);
    assert.ok(deletedKeys.includes("voice_config:alex-pilot-01"), "Publish must purge tenant voice KV cache");
    assert.ok(deletedKeys.includes("tenant:alex-pilot-01"), "Publish must purge tenant metadata KV cache");

    // Verify locked system_prompt was NOT overwritten by tenantCustomization
    const voiceRow = await db
      .prepare("SELECT system_prompt, tenant_customization FROM tenant_voice_config WHERE tenant_slug = ?")
      .bind("alex-pilot-01")
      .first();
    assert.equal(voiceRow.system_prompt, "أنت ميزان، المساعد الصوتي المصري العام.");
    assert.equal(voiceRow.tenant_customization, "تحديث إصدار 2: العيادة تعمل أيضاً يوم السبت.");

    // Rollback to v1
    const rbRes = await studioWorker.fetch(
      new Request(`${base}/api/ops/agents/rollback`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ tenantId: "alex-pilot-01" })
      }),
      env,
      ctx
    );
    const rbData = await rbRes.json();
    assert.equal(rbData.ok, true);
    assert.equal(rbData.activeVersion, 1);

    // Both v1 and v2 still exist in agent_config_versions (immutable history)
    const allVers = await db
      .prepare("SELECT version_number FROM agent_config_versions WHERE tenant_slug = ? ORDER BY version_number ASC")
      .bind("alex-pilot-01")
      .all();
    assert.deepEqual(
      allVers.results.map((r) => r.version_number),
      [1, 2],
      "Rollback must never delete historical versions"
    );

    // Re-activate v2 explicitly
    const actRes = await studioWorker.fetch(
      new Request(`${base}/api/ops/agents/activate`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ tenantId: "alex-pilot-01", version: 2 })
      }),
      env,
      ctx
    );
    const actData = await actRes.json();
    assert.equal(actData.ok, true);
    assert.equal(actData.activeVersion, 2);
  }

  // 7. Simulate turn + trace logging + per-actor rate limit
  {
    globalThis.__mizanGenerate = async () => ({
      text: "أهلاً يا فندم، مواعيد العمل من السبت للخميس من 9 صباحاً لـ 9 مساءً.",
      finishReason: "stop",
      usage: { inputTokens: 25, outputTokens: 15 }
    });

    try {
      const simRes = await studioWorker.fetch(
        new Request(`${base}/api/ops/agents/simulate-turn`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            tenantId: "alex-pilot-01",
            message: "رقمي 01099887766 وعايز أعرف المواعيد"
          })
        }),
        env,
        ctx
      );
      assert.equal(simRes.status, 200);
      const simData = await simRes.json();
      assert.equal(simData.ok, true);
      assert.equal(simData.configVersion, 2);
      assert.ok(!simData.scrubbedInput.includes("01099887766"), "Phone number must be redacted in simulated turn");
      assert.ok(!simData.reply.includes("فندم"), "Output guard must strip يا فندم in simulated turn");
      assert.ok(simData.guardViolations.length >= 1, "Guard violations must be reported");

      const traceRow = await db
        .prepare("SELECT tenant_slug, config_version, runtime_version FROM turn_traces WHERE trace_id = ?")
        .bind(simData.traceId)
        .first();
      assert.equal(traceRow.tenant_slug, "alex-pilot-01");
      assert.equal(traceRow.config_version, 2);

      // Force rate limit threshold and verify 429
      await db
        .prepare("UPDATE studio_rate_limits SET hits = 30 WHERE rate_key = 'sim:opencode_harness'")
        .run();
      const limitedRes = await studioWorker.fetch(
        new Request(`${base}/api/ops/agents/simulate-turn`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ tenantId: "alex-pilot-01", message: "اختبار" })
        }),
        env,
        ctx
      );
      assert.equal(limitedRes.status, 429, "Simulator must enforce rate limit");
    } finally {
      delete globalThis.__mizanGenerate;
    }
  }

  // 8. Post-deploy smoke script verification against in-memory Studio Worker
  {
    const code = await runStudioSmokeCheck({
      baseUrl: base,
      token: env.STUDIO_API_TOKEN,
      fetchImpl: (url, init) => studioWorker.fetch(new Request(url, init), env, ctx),
      log: () => {}
    });
    assert.equal(code, 0, "smoke-studio.mjs must exit 0 against valid Studio Worker");
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("PASS Studio operations (migrations 001-008, immutable versioning, rollback, simulator, rate limit, smoke check)");
