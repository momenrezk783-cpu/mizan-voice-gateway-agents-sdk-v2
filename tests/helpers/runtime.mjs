import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
const cache = new Map();
const asUrl = source => 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const externals = {
  agents:asUrl(`export class Agent {constructor(ctx,env){this.env=env;this.name=ctx.name;} async keepAlive(){return ()=>{};}} export async function routeAgentRequest(request,env){return globalThis.__routeVoice(request,env);}`),
  ai:asUrl(`export async function generateText(options){if(globalThis.__mizanGenerate)return globalThis.__mizanGenerate(options);throw new Error('Live AI forbidden in local tests');}`),
  'agents/models/ai-sdk':asUrl(`export function createAI(){return id=>({modelId:id});}`)
};
export function loadUrl(file) {
  const abs = path.resolve(file);
  if (cache.has(abs)) return cache.get(abs);
  const code = ts.transpileModule(fs.readFileSync(abs,'utf8'),{fileName:abs,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
    .replace(/(from\s+["'])([^"']+)(["'])/gu,(_,prefix,spec,suffix)=>prefix+(externals[spec]??(spec.startsWith('.')?loadUrl(path.resolve(path.dirname(abs),spec+'.ts')):spec))+suffix);
  const url=asUrl(code);cache.set(abs,url);return url;
}
export const importTs = file => import(loadUrl(file));
const python = `import sqlite3,json,sys
p=json.load(sys.stdin)
c=sqlite3.connect(p['file'],timeout=30);c.row_factory=sqlite3.Row
try:
 c.execute('BEGIN IMMEDIATE')
 out=[]
 for q in p['queries']:
  cur=c.execute(q['sql'],q.get('params',[]))
  rows=[dict(r) for r in cur.fetchall()] if cur.description else []
  out.append({'results':rows,'meta':{'changes':max(0,cur.rowcount)}})
 c.commit(); print(json.dumps(out))
except:
 c.rollback();raise
finally:c.close()`;
export class SqliteD1 {
  constructor(file){this.file=file;this.history=[];}
  apply(file) {execFileSync('python3',['-c',`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.executescript(open(sys.argv[2]).read());c.close()`,this.file,file]);}
  execute(queries) {return JSON.parse(execFileSync('python3',['-c',python],{input:JSON.stringify({file:this.file,queries}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));}
  prepare(sql) {
    const db=this;
    function stmt(params=[]) {return {sql,params,bind:(...args)=>stmt(args),run:async()=>db.execute([{sql,params}])[0],all:async()=>db.execute([{sql,params}])[0],first:async()=>db.execute([{sql,params}])[0].results[0]??null};}
    this.history.push(sql);return stmt();
  }
  async batch(statements){return this.execute(statements.map(s=>({sql:s.sql,params:s.params})));}
}
