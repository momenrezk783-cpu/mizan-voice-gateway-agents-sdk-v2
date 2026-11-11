// Manual-only, synthetic inference through a short-lived remote preview Worker.
// No deployed routes, D1, KV, queues, caller records or TTS are attached.
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
// Keep source inside the checkout for normal node_modules resolution.
const dir=mkdtempSync(join(root,'.ai-binding-probe-'));
const source=`import {createAI} from 'agents/models/ai-sdk';
import {generateText} from 'ai';
function info(e,depth=0) {
 if(depth>3||!e)return undefined;
 return {name:e.name,message:String(e.message??e).slice(0,700),status:e.statusCode??e.status,code:e.code,
  data:e.data?.code?{code:e.data.code}:undefined,cause:info(e.cause,depth+1),lastError:info(e.lastError,depth+1),
  errors:Array.isArray(e.errors)?e.errors.slice(-1).map(x=>info(x,depth+1)):undefined};
}
export default {async fetch(request,env) {
 if(new URL(request.url).pathname==='/health')return Response.json({ready:true});
 const {model,transport}=await request.json();
 if(!['@cf/daily-co/phonellm-mini-alpha-2','@cf/deepseek-ai/deepseek-v4.1-flash-1017'].includes(model))return new Response('',{status:400});
 const messages=[{role:'user',content:'قل أهلاً فقط.'}];
 try {
  if(transport==='direct') {
   const r=await env.AI.run(model,{messages,temperature:0},{signal:AbortSignal.timeout(20000)});
   return Response.json({ok:true,model,transport,keys:Object.keys(r),characters:typeof r.response==='string'?r.response.length:undefined});
  }
  const ai=createAI({binding:env.AI,collectLog:false,skipCache:true});
  const r=await generateText({model:ai(model),messages,temperature:0,maxRetries:0,abortSignal:AbortSignal.timeout(20000)});
  return Response.json({ok:true,model,transport,finishReason:r.finishReason,characters:r.text.length});
 }catch(e){return Response.json({ok:false,model,transport,error:info(e)});}
}};`;
writeFileSync(join(dir,'worker.js'),source);
writeFileSync(join(dir,'wrangler.toml'),`name="mizan-ai-binding-preview"
main="worker.js"
compatibility_date="2026-11-08"
compatibility_flags=["nodejs_compat"]
workers_dev=true
[ai]
binding="AI"
`);
let output='';
const child=spawn(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),'dev','--remote','--config',join(dir,'wrangler.toml'),'--ip','127.0.0.1','--port','9785','--inspector-port','0'],
 {cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{output=(output+b).slice(-5000);});
child.stderr.on('data',b=>{output=(output+b).slice(-5000);});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
 let ready=false;
 for(let i=0;i<40;i++) {
  try {const r=await fetch('http://127.0.0.1:9785/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ready){ready=true;break;}}catch{}
  if(child.exitCode!==null)break;
  await delay(1000);
 }
 if(!ready) {
  // Wrangler normal error output; remove URLs and bearer-shaped values.
  console.log('PREVIEW_START_FAILED',output.replace(/https?:\/\/\S+/g,'[URL]').replace(/Bearer\s+\S+/gi,'[credential]'));
  process.exitCode=2;
 } else for(const model of ['@cf/daily-co/phonellm-mini-alpha-2','@cf/deepseek-ai/deepseek-v4.1-flash-1017']) {
  for(const transport of ['direct','sdk']) {
   try {
    const r=await fetch('http://127.0.0.1:9785/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,transport}),signal:AbortSignal.timeout(30000)});
    console.log('BINDING_PROBE',JSON.stringify(await r.json()));
   }catch(e){console.log('BINDING_PROBE_TRANSPORT_ERROR',JSON.stringify({model,transport,name:e.name,message:e.message}));}
  }
 }
} finally {
 child.kill('SIGTERM');
 await Promise.race([new Promise(r=>child.once('close',r)),delay(2000)]);
 if(child.exitCode===null)child.kill('SIGKILL');
 rmSync(dir,{recursive:true,force:true});
}
