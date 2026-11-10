/** Offline GO/NO-GO preflight. Never deploys, provisions, or contacts production. */
import fs from 'node:fs';
const gates = [
  {name:'Pinned dependency lockfile', ready:fs.existsSync('package-lock.json'), action:'Review and commit npm lockfile after dependency resolution'},
  {name:'Installed Wrangler dependencies', ready:fs.existsSync('node_modules/.bin/wrangler'), action:'Install with npm ci in isolated build environment'},
  {name:'Provisioned staging config', ready:fs.existsSync('wrangler.staging.toml'), action:'Provision staging-only D1/KV/queue/worker and complete config guard'},
  {name:'Verified isolated Wrangler dry-run', ready:fs.existsSync('docs/evidence/verified-wrangler-dry-run.json'), action:'Run bundle/type validation and attach validated artifact'},
  {name:'Live end-to-end voice quality evidence', ready:fs.existsSync('docs/evidence/live-voice-verified.json'), action:'Run authorized Deepgram/ElevenLabs/Workers AI tests and record latency'},
  {name:'Licensed SIP/PBX interoperability evidence', ready:fs.existsSync('docs/evidence/authorized-sip-pbx.json'), action:'Run controlled authenticated PBX bridge test and regulatory/provider review'},
  {name:'Billing sandbox / payment review', ready:fs.existsSync('docs/evidence/billing-sandbox-verified.json'), action:'Select and verify sandbox gateway, pricing and accounting policies'},
];
const outstanding = gates.filter(g=>!g.ready);
for(const gate of gates) console.log(`${gate.ready?'FILE PRESENT (still requires review)':'BLOCKED'}: ${gate.name}${gate.ready?'':' — '+gate.action}`);
console.log(outstanding.length ? `NO-GO: ${outstanding.length} prerequisite evidence files absent; no deployment permitted.` : 'All files present: independent security and operator review still required. Not automatic approval.');
process.exit(outstanding.length ? 2 : 0);
