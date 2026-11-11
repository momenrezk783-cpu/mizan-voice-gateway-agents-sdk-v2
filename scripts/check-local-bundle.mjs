// Offline bundle validation only. Fixture bindings below are not provisioned
// staging resources. Never deploy this generated configuration.
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const temporary=mkdtempSync(join(tmpdir(),'mizan-bundle-check-'));
const config=join(temporary,'wrangler.toml');
const q=value=>JSON.stringify(value);
writeFileSync(config,`name = "mizan-local-bundle-staging"
main = ${q(join(root,'src/index.ts'))}
compatibility_date = "2026-11-08"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
[vars]
ENVIRONMENT = "staging"
MIZAN_VOICE_ID = "2DkHmQavK9V2UzTYrMYT"
VOICE_WS_BASE = "wss://mizan-local-bundle-staging.example.workers.dev"
PRIMARY_LLM = "@cf/daily-co/phonellm-mini-alpha-2"
FALLBACK_LLM = "@cf/deepseek-ai/deepseek-v4.1-flash-1017"
[ai]
binding = "AI"
[[d1_databases]]
binding = "DB"
database_name = "mizan-local-fixture-staging"
database_id = "00000000-0000-4000-8000-000000000001"
[[kv_namespaces]]
binding = "TENANT_CONFIG"
id = "00000000000000000000000000000001"
[[durable_objects.bindings]]
name = "MIZAN_VOICE_AGENT"
class_name = "MizanVoiceAgent"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["MizanVoiceAgent"]
[[queues.producers]]
binding = "BACKGROUND_QUEUE"
queue = "mizan-local-fixture-staging"
[[analytics_engine_datasets]]
binding = "VOICE_METRICS"
dataset = "mizan_local_fixture_staging"
[assets]
directory = ${q(join(root,'public'))}
binding = "ASSETS"
`);
let status=2;
try {
  const result=spawnSync(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),
    'deploy','--dry-run','--config',config,'--outdir',join(temporary,'dist')],{
    cwd:root,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}
  });
  status=result.status??2;
} finally { rmSync(temporary,{recursive:true,force:true}); }
console.log(status===0?'PASS: local bundle only; no resources provisioned or deployment performed.':'FAIL: local bundle validation.');
process.exitCode=status;
