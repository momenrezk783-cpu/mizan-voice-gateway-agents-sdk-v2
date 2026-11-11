/** Runs actual automated release checks. Never deploys or contacts production. */
import fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync, execFileSync} from 'node:child_process';

const CHECKS = ['typecheck', 'test', 'bundle:check'];
const FEATURE_EVIDENCE = {
  sip: 'docs/evidence/authorized-sip-pbx.json',
  billing: 'docs/evidence/billing-sandbox-verified.json'
};

export function readReleaseConfig(root) {
  const config = JSON.parse(fs.readFileSync(resolve(root,'release.config.json'),'utf8'));
  if (!config || config.schemaVersion !== 1 ||
      Object.keys(config).some(key=>!['schemaVersion','features'].includes(key)) ||
      !config.features || Array.isArray(config.features) ||
      Object.keys(config.features).some(key=>!Object.hasOwn(FEATURE_EVIDENCE,key)) ||
      Object.keys(FEATURE_EVIDENCE).some(key=>typeof config.features[key] !== 'boolean')) {
    throw new Error('Invalid release.config.json: explicit sip and billing booleans are required');
  }
  return config;
}

export function validateFeatureEvidence(root, features, revision, now=Date.now()) {
  for (const [feature,relative] of Object.entries(FEATURE_EVIDENCE)) {
    if (!features[feature]) continue;
    const evidence = JSON.parse(fs.readFileSync(resolve(root,relative),'utf8'));
    const verifiedAt = Date.parse(evidence.verifiedAt);
    if (!/^[a-f0-9]{40}$/i.test(revision ?? '') || evidence.feature !== feature ||
        evidence.status !== 'passed' || evidence.revision !== revision ||
        !Number.isFinite(verifiedAt) || verifiedAt > now + 60_000 || now - verifiedAt > 7*86400_000) {
      throw new Error(`${feature}: evidence must record passed checks for this commit within the last seven days`);
    }
  }
}

export function runReleaseGate({root=process.cwd(),execute,revision,now=Date.now(),log=console.log}={}) {
  try {
    const {features} = readReleaseConfig(root);
    const enabled = Object.keys(features).filter(key=>features[key]);
    if (enabled.length && !revision) {
      revision = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    }
    validateFeatureEvidence(root,features,revision,now);
    log(`Release scope: browser voice${enabled.length ? ', '+enabled.join(', ') : ' (SIP and payment integration disabled)'}`);
    const run = execute ?? (args=>spawnSync(process.platform==='win32'?'npm.cmd':'npm',args,{cwd:root,stdio:'inherit'}));
    for (const check of CHECKS) {
      log(`RUN: npm run ${check}`);
      const result = run(['run',check]);
      if (result?.error || result?.status !== 0) {
        log(`NO-GO: npm run ${check} failed${result?.error ? ': '+result.error.message : ''}`);
        return 2;
      }
      log(`PASS: npm run ${check}`);
    }
    log('PASS: automated release checks completed for the configured features. Live voice quality is not established by these checks.');
    return 0;
  } catch (error) {
    log(`NO-GO: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runReleaseGate();
}
