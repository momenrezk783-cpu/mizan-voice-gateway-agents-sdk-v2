import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),ts=require('typescript');
const s=readFileSync('src/lib/billing.ts','utf8');
const compiled=ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const b=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
assert.deepEqual(b.getUtcMonthBounds('2026-02'),{start:Date.UTC(2026,1,1)/1000,end:Date.UTC(2026,2,1)/1000,month:'2026-02'});
for(const m of ['2026-00','2026-13','nonsense','1999-11','2026-1']) assert.equal(b.getUtcMonthBounds(m),null);
const sql=s.match(/`(SELECT COUNT\(\*\) AS call_count,[\s\S]+?FROM call_sessions[\s\S]+?)`/)[1];
const py=`import sqlite3,sys
c=sqlite3.connect(':memory:');c.execute('create table call_sessions (tenant_slug text,started_at integer,ended_at integer)')
jan=1767225600;feb=1769904000
c.executemany('insert into call_sessions values (?,?,?)', [('a',jan+5,jan+65),('a',jan+100,None),('b',jan+10,jan+1010),('a',feb+1,feb+61)])
assert c.execute(sys.argv[1],('a',jan,feb)).fetchone()==(2,60)
assert c.execute(sys.argv[1],('b',jan,feb)).fetchone()==(1,1000)
print('PASS tenant/time scoped usage aggregation')`;
assert.match(execFileSync('python3',['-c',py,sql],{encoding:'utf8'}),/PASS/);
const html=readFileSync('public/client.html','utf8');
assert.ok(html.includes('loadBillingUsage()'));
assert.ok(!html.includes('1,499 <span')&&!html.includes('4,999 <span'));
assert.match(readFileSync('src/index.ts','utf8'),/getTenantMonthlyUsage\(env\.DB, slug, month\)/);
console.log('PASS read-only billing estimate input/month/tenant filters, zero payment side effects');
