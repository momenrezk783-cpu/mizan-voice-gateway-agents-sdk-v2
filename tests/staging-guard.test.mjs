import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateStagingConfig} from '../scripts/check-staging-config.mjs';
const prod=fs.readFileSync('wrangler.toml','utf8');
const example=fs.readFileSync('wrangler.staging.example.toml','utf8');
assert.ok(validateStagingConfig(example,prod).some(e=>e.includes('Placeholder')));
const fake=example
  .replace('REPLACE_WITH_STAGING_D1_UUID','11111111-2222-3333-4444-555555555555')
  .replace('REPLACE_WITH_STAGING_KV_ID','22222222222222222222222222222222')
  .replace('REPLACE_WITH_STAGING_WORKERS_DEV_HOST','mizan-voice-gateway-staging.example.workers.dev');
assert.deepEqual(validateStagingConfig(fake,prod),[]);
assert.ok(validateStagingConfig(fake.replace('mizan-background-staging','mizan-background'),prod).length);
assert.ok(validateStagingConfig(fake.replace('11111111-2222-3333-4444-555555555555',prod.match(/database_id = "([^"]+)"/)[1]),prod).length);
assert.ok(validateStagingConfig(fake.replace('workers_dev = true', 'workers_dev = false'),prod).length);
assert.ok(validateStagingConfig(fake.replace('workers_dev = true','routes = [{ pattern = "mizanconsult.com/*" }]'),prod).length);
console.log('PASS fail-closed Staging guard rejects placeholders, production bindings/routes and absent workers.dev isolation');
