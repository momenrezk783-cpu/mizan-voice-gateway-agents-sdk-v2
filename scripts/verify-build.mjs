import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
if (!fs.existsSync('node_modules/.bin/wrangler')) {
  console.error('BLOCKED: Wrangler dependencies not installed. npm ci with a reviewed lockfile is required.'); process.exit(2);
}
const guard=spawnSync(process.execPath,['scripts/check-staging-config.mjs'],{stdio:'inherit'});
if (guard.status!==0) process.exit(guard.status||2);
// Never use production wrangler.toml for build validation.
const dry=spawnSync('node_modules/.bin/wrangler',['deploy','--dry-run','--config','wrangler.staging.toml'],{stdio:'inherit'});
process.exit(dry.status??2);
