import fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Strict fail-closed checks for an independently provisioned STAGING config.
// This is a preflight guard, not a replacement for human review of Cloudflare credentials.
export function validateStagingConfig(candidate, production) {
  const problems=[];
  const get = (text,key) => text.match(new RegExp('^\\s*'+key+'\\s*=\\s*"([^"]*)"','m'))?.[1] || '';
  if (!/^mizan-[\w-]*(?:staging|dev)$/.test(get(candidate,'name')) || get(candidate,'name') === get(production,'name')) problems.push('Worker must have a distinct -staging or -dev name');
  if (!/ENVIRONMENT\s*=\s*"staging"/.test(candidate)) problems.push('ENVIRONMENT must be staging');
  if (/REPLACE_WITH|mizanconsult\.com|\[\[?routes?\]?\]/i.test(candidate)) problems.push('Placeholder or production domain/route found');
  if (!/workers_dev\s*=\s*true/.test(candidate)) problems.push('Staging workers_dev must be true');
  if (!/database_name\s*=\s*"[\w-]*(?:staging|dev)"/.test(candidate)) problems.push('Staging D1 database name required');
  if (!/queue\s*=\s*"[\w-]*(?:staging|dev)"/.test(candidate) || [...candidate.matchAll(/\bqueue\s*=\s*"([^"]+)"/g)].some(m=>!/-(?:staging|dev)$/.test(m[1]))) problems.push('Every queue must be a staging/dev queue');
  for (const key of ['database_id','id']) {
    const ours = key==='id' ? candidate.match(/\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*"([^"]*)"/)?.[1] : get(candidate,key);
    const live = key==='id' ? production.match(/\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*"([^"]*)"/)?.[1] : get(production,key);
    if (!ours || ours===live) problems.push(`Separate staging ${key} required`);
  }
  if (!/^wss:\/\/[^\s"]+\.workers\.dev/.test(get(candidate,'VOICE_WS_BASE'))) problems.push('Use an isolated workers.dev WebSocket domain');
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file=process.argv[2] || 'wrangler.staging.toml';
  if (!fs.existsSync(file)) { console.error(`BLOCKED: ${file} is missing. Copy the staging example and provision separate resources.`); process.exit(2); }
  const errors = validateStagingConfig(fs.readFileSync(file,'utf8'),fs.readFileSync('wrangler.toml','utf8'));
  if (errors.length) { console.error('BLOCKED staging: '+errors.join('; ')); process.exit(2); }
  console.log('PASS: staging config differs from production. Review Cloudflare account/resources before running deploy.');
}
