import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';

const src = fs.readFileSync('src/index.ts','utf8');
const client = fs.readFileSync('public/client.html','utf8');
const allPages = ['client.html','dashboard.html','login.html','index.html','search.html'];
let scriptCount=0;
for (const page of allPages) {
  const html=fs.readFileSync('public/'+page,'utf8');
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) {
    if (m[1].trim()) {
      assert.doesNotThrow(()=>new vm.Script(m[1], {filename:page}), page+' contains invalid inline JS');
      scriptCount++;
    }
  }
}
assert.ok(scriptCount >= 4, 'All inline UI scripts should be syntactically validated');
console.log('PASS inline JavaScript parses across '+allPages.length+' UI pages');

// Use the production SQL, not a duplicated query, against realistic duplicate child rows.
const sqlMatch = src.match(/\/\/ GET \/api\/admin\/metrics[^\n]*\n[\s\S]*?env\.DB\.prepare\(\s*`([\s\S]*?)`\s*\)\.all\(\)/u);
assert.ok(sqlMatch, 'Admin metrics query must remain extractable');
const py = `import sqlite3, json, sys
c=sqlite3.connect(':memory:'); c.row_factory=sqlite3.Row
c.executescript("""CREATE TABLE tenants (slug TEXT PRIMARY KEY, name TEXT, status TEXT, plan_tier TEXT);
CREATE TABLE call_sessions (tenant_slug TEXT, call_status TEXT, booking_confirmed INTEGER);
CREATE TABLE call_turns (tenant_slug TEXT, latency_ms INTEGER);
INSERT INTO tenants VALUES ('a','Org A','active','pilot_14d');
INSERT INTO tenants VALUES ('b','Org B','active','pilot_14d');
INSERT INTO call_sessions VALUES ('a','completed',1);
INSERT INTO call_sessions VALUES ('a','abandoned',0);
INSERT INTO call_sessions VALUES ('b','completed',0);
INSERT INTO call_turns VALUES ('a',100);
INSERT INTO call_turns VALUES ('a',200);
INSERT INTO call_turns VALUES ('a',300);
""")
print(json.dumps([dict(r) for r in c.execute(sys.argv[1])]))`;
const metrics=JSON.parse(execFileSync('python3',['-c',py,sqlMatch[1]],{encoding:'utf8'}));
assert.equal(metrics.find(x=>x.slug==='a').total_calls,2,'Multiple transcript turns MUST NOT multiply call count');
assert.equal(metrics.find(x=>x.slug==='a').completed,1);
assert.equal(metrics.find(x=>x.slug==='a').bookings,1);
assert.equal(metrics.find(x=>x.slug==='a').avg_latency,200);
assert.equal(metrics.find(x=>x.slug==='b').total_calls,1);
console.log('PASS admin cross-tenant SQL metrics are accurate with multiple call turns');

assert.match(src, /X-Content-Type-Options/);
assert.match(src, /frame-ancestors 'none'/);
assert.match(src, /const safeName = escapeHtml\(tenant.name\)/);
assert.match(src, /const accent = safeAccent\(tenant.theme_color\)/);
assert.match(src, /function safeLogoUrl\(/);
assert.match(fs.readFileSync('src/agent.ts','utf8'), /turn_to_audio/); // actual voice metric event
assert.ok(!/\b(?:86%|88%|96\.8%|99\.9%)\b/u.test(client), 'UI must not contain fabricated metrics');
assert.ok(!client.includes('النظام متوافق مع قانون 151'), 'No unsupported legal certification');
assert.match(client,/renderCallOutcomeReports\(calls\)/);
assert.match(client,/تشفير AES-GCM جزئي/);
console.log('PASS public page hardening, realistic KPI labels and latency instrumentation');

const extractFunction=(name)=>{
 const start=client.indexOf('function '+name+'(');assert.ok(start!==-1,'Missing '+name);
 let brace=client.indexOf('{',start),depth=0,i=brace;
 for(;i<client.length;i++) {if(client[i]==='{')depth++;else if(client[i]==='}' && --depth===0)break;}
 return client.slice(start,i+1);
};
// Evaluates real browser CSV serialization without opening a browser or exposing data.
const sandbox = vm.createContext({});
vm.runInContext(extractFunction('csvSafeCell'),sandbox);
const csvSafeCell=sandbox.csvSafeCell;
assert.equal(csvSafeCell('a,b'), '"a,b"');
assert.equal(csvSafeCell('a"b'), '"a""b"');
assert.equal(csvSafeCell('=HYPERLINK("https://unsafe")'), '"\'=HYPERLINK(""https://unsafe"")"');
assert.equal(csvSafeCell('-1+2'), '"\'-1+2"');
assert.equal(csvSafeCell('safe'), '"safe"');
console.log('PASS CSV RFC4180 quoting and formula-injection mitigation');
