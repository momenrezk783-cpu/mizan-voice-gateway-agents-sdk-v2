import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const compiled=ts.transpileModule(readFileSync('src/lib/telephony/routing.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {resolveTrustedPbxRoute}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const routes=[
 {peerId:'pbx-a',calledNumber:'+201234567890',tenantSlug:'clinic-a'},
 {peerId:'pbx-b',calledNumber:'+201234567890',tenantSlug:'clinic-b'},
];
assert.equal(resolveTrustedPbxRoute('pbx-a','+201234567890',routes),'clinic-a');
assert.equal(resolveTrustedPbxRoute('pbx-b','+201234567890',routes),'clinic-b');
assert.equal(resolveTrustedPbxRoute('pbx-c','+201234567890',routes),null);
assert.equal(resolveTrustedPbxRoute('pbx-a','12345678',routes),null);
assert.equal(resolveTrustedPbxRoute('pbx-a','+201234567890', [...routes,routes[0]]),null);
assert.equal(resolveTrustedPbxRoute('pbx-a','+201234567891',routes),null);
assert.equal(resolveTrustedPbxRoute('pbx-a','+201234567890', [{...routes[0],tenantSlug:'../admin'}]),null);
console.log('PASS trusted PBX routing requires authenticated peer, E.164 destination, unique tenant mapping');
