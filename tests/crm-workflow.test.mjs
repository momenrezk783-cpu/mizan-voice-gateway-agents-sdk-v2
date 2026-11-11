import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url), ts=require('typescript');
const source=readFileSync('src/lib/crm.ts','utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const lib=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
for(const status of lib.REQUEST_STATUSES) assert.equal(lib.isRequestStatus(status),true);
assert.equal(lib.isRequestStatus('super_admin'),false);
assert.equal(lib.isRequestStatus('__proto__'),false);
const api=readFileSync('src/index.ts','utf8');
assert.match(api, /updateTenantRequestStatus\(env\.DB, slug, requestStatusMatch\[1\], body\.status\)/);
assert.match(api, /listTenantRequests\(env\.DB, slug, isRequestStatus\(filter\) \? filter : undefined\)/);
const sql=source.match(/`(UPDATE client_queries SET status = \?, updated_at = \?[\s\S]*?)`/)[1];
const python=`import sqlite3,sys
c=sqlite3.connect(':memory:')
c.executescript("""CREATE TABLE client_queries(id TEXT,tenant_id TEXT,status TEXT,updated_at TEXT);
INSERT INTO client_queries VALUES ('a','tenant-a','open','');INSERT INTO client_queries VALUES ('b','tenant-b','open','');""")
c.execute(sys.argv[1],('closed','2026-11-10','b','tenant-a'))
assert c.execute("select status from client_queries where id='b'").fetchone()[0]=='open'
c.execute(sys.argv[1],('closed','2026-11-10','a','tenant-a'))
assert c.execute("select status from client_queries where id='a'").fetchone()[0]=='closed'
print('PASS tenant-isolated CRM update SQL')`;
assert.match(execFileSync('python3',['-c',python,sql],{encoding:'utf8'}),/PASS/);
const page=readFileSync('public/client.html','utf8');
assert.match(page, /function loadFollowups\(\)/);
assert.match(page,/cell\.textContent = String\(value\)/);
console.log('PASS CRM status validation, tenant-isolated mutations, safe client rendering');
