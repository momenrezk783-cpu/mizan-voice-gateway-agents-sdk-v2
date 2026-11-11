import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {runReleaseGate} from '../scripts/release-gate.mjs';

const root=fs.mkdtempSync(join(os.tmpdir(),'mizan-release-gate-'));
const revision='a'.repeat(40), now=Date.parse('2026-11-11T12:00:00Z');
const config=(features={sip:false,billing:false})=>fs.writeFileSync(join(root,'release.config.json'),JSON.stringify({schemaVersion:1,features}));
const writeEvidence=(feature,changes={})=>{
  fs.mkdirSync(join(root,'docs/evidence'),{recursive:true});
  const file=feature==='sip'?'authorized-sip-pbx.json':'billing-sandbox-verified.json';
  fs.writeFileSync(join(root,'docs/evidence',file),JSON.stringify({feature,status:'passed',revision,verifiedAt:new Date(now).toISOString(),...changes}));
};
const run=(execute,extra={})=>runReleaseGate({root,revision,now,log:()=>{},execute,...extra});
try {
  config();
  const calls=[];
  // No staging config, hand-written dry-run marker, live-call, SIP or billing files.
  assert.equal(run(args=>{calls.push(args);return {status:0};}),0);
  assert.deepEqual(calls,[['run','typecheck'],['run','test'],['run','bundle:check']]);
  for(let failure=0;failure<3;failure++) {
    const called=[];
    assert.equal(run(args=>{called.push(args);return {status:called.length===failure+1?1:0};}),2);
    assert.equal(called.length,failure+1,'a failed check must prevent later checks and release success');
  }
  assert.equal(run(()=>({status:null,error:new Error('cannot start npm')})),2);
  // Files merely existing cannot turn a failed actual check into a pass.
  fs.mkdirSync(join(root,'docs/evidence'),{recursive:true});
  fs.writeFileSync(join(root,'docs/evidence/verified-wrangler-dry-run.json'),'{}');
  assert.equal(run(()=>({status:1})),2);

  for(const feature of ['sip','billing']) {
    config({sip:feature==='sip',billing:feature==='billing'});
    let commands=0;
    assert.equal(run(()=>{commands++;return {status:0};}),2);
    assert.equal(commands,0,'enabled integrations require evidence before executing release checks');
    for(const invalid of [{status:'pending'},{revision:'b'.repeat(40)},{verifiedAt:'invalid'},
      {verifiedAt:new Date(now-8*86400_000).toISOString()}, {verifiedAt:new Date(now+3600_000).toISOString()}, {feature:'other'}]) {
      writeEvidence(feature,invalid);
      assert.equal(run(()=>({status:0})),2);
    }
    writeEvidence(feature);
    assert.equal(run(()=>({status:0})),0);
  }
  config({sip:true,billing:true});
  assert.equal(run(()=>({status:0})),0);
  for(const features of [{sip:false},{sip:'false',billing:false},{sip:false,billing:false,unknown:true},null]) {
    config(features);assert.equal(run(()=>({status:0})),2);
  }
  fs.rmSync(join(root,'release.config.json'));
  assert.equal(run(()=>({status:0})),2);
  console.log('PASS release gate executes real checks, stops on failure, and requires fresh commit-bound evidence only for enabled SIP/billing integrations');
} finally {fs.rmSync(root,{recursive:true,force:true});}
