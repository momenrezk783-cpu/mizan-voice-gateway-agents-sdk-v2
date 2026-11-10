import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const python=`import sqlite3,random,time
c=sqlite3.connect(':memory:')
c.executescript('''CREATE TABLE call_sessions(id text,tenant_slug text,call_status text,started_at integer,ended_at integer);
CREATE INDEX call_tenant_time ON call_sessions(tenant_slug,started_at);
CREATE TABLE client_queries(id text,tenant_id text,status text,created_at text,updated_at text);
CREATE INDEX req_tenant_time ON client_queries(tenant_id,created_at DESC);''')
for tenant in range(100):
    c.executemany('INSERT INTO call_sessions VALUES (?,?,?,?,?)', [(f'{tenant}-{i}',f'tenant-{tenant}','completed',1760000000+i,1760000060+i) for i in range(50)])
    c.executemany('INSERT INTO client_queries VALUES (?,?,?,?,?)',[(f'{tenant}-{i}',f'tenant-{tenant}','open','2026-11-10','2026-11-10') for i in range(10)])
c.commit()
start=time.perf_counter()
for tenant in range(100):
    r=c.execute('SELECT count(*) FROM call_sessions WHERE tenant_slug=?',(f'tenant-{tenant}',)).fetchone()[0]
    assert r==50
    r=c.execute('SELECT count(*) FROM client_queries WHERE tenant_id=?',(f'tenant-{tenant}',)).fetchone()[0]
    assert r==10
elapsed=time.perf_counter()-start
print('PASS SQLite-only 100 tenant/5000 call row/1000 request row query isolation; elapsed %.3f seconds (NOT cloud load test)'%elapsed)`;
assert.match(execFileSync('python3',['-c',python],{encoding:'utf8'}),/PASS SQLite-only/);
console.log('PASS bounded local SQLite smoke, not concurrent telecom/Cloudflare benchmarking');
