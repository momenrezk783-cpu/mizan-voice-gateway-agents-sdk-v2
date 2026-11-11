// Opt-in diagnostics only. Uses existing repository secrets in the runner;
// no new credentials, deployments, migrations or real caller prompts.
import {createAI} from 'agents/models/ai-sdk';
import {generateText} from 'ai';
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!account||!token) throw new Error('Existing Cloudflare runner credentials are missing');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}`;
function safe(value) {
  return String(value??'').replaceAll(token,'[credential]')
    .replace(/(?:Bearer|Token)\s+\S+/gi,'[credential]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]')
    .replace(/\b01[0125]\d{8}\b/g,'[phone]').slice(0,900);
}
function errorInfo(e,depth=0) {
  if(depth>3||!e) return undefined;
  return {name:safe(e.name),message:safe(e.message??e),status:e.statusCode??e.status,code:e.code,
    reason:e.reason,cause:errorInfo(e.cause,depth+1),lastError:errorInfo(e.lastError,depth+1),
    errors:Array.isArray(e.errors)?e.errors.slice(-2).map(x=>errorInfo(x,depth+1)):undefined};
}
async function request(path,body) {
  const response=await fetch(base+path,{method:body?'POST':'GET',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const data=await response.json().catch(()=>null);
  return {status:response.status,ok:response.ok,data};
}
const settings=await request('/workers/scripts/mizan-voice-gateway/settings');
console.log('SETTINGS',JSON.stringify({status:settings.status,success:settings.data?.success}));
const vars=Object.fromEntries((settings.data?.result?.bindings??[])
  .filter(b=>['PRIMARY_LLM','FALLBACK_LLM','MIZAN_VOICE_ID'].includes(b.name)).map(b=>[b.name,b.text]));
console.log('PUBLIC_RUNTIME_SELECTION',JSON.stringify(vars));

try {
  const now=Date.now();
  const logs=await request('/workers/observability/telemetry/query',{
    queryId:'mizan-llm-incident-read',timeframe:{from:now-3600000,to:now},dry:true,view:'events',limit:25,
    filters:[{key:'$metadata.service',type:'string',operation:'eq',value:'mizan-voice-gateway'},
      {key:'$metadata.message',type:'string',operation:'includes',value:'LLM failed'}]});
  console.log('OBSERVABILITY_QUERY',JSON.stringify({status:logs.status,success:logs.data?.success}));
  function inspect(v) {
    if(!v||typeof v!=='object')return;
    for(const [k,x] of Object.entries(v)) {
      if(typeof x==='string'&& /message|error/i.test(k)&& /(?:Primary|Fallback) LLM failed/.test(x)) console.log('HISTORICAL_LLM_ERROR',safe(x));
      else if(x&&typeof x==='object')inspect(x);
    }
  }
  if(logs.ok)inspect(logs.data?.result);
  else console.log('OBSERVABILITY_ERRORS',JSON.stringify((logs.data?.errors??[]).map(e=>({code:e.code,message:safe(e.message)}))));
} catch(e) { console.log('OBSERVABILITY_UNAVAILABLE',JSON.stringify(errorInfo(e))); }

for(const model of [vars.PRIMARY_LLM,vars.FALLBACK_LLM].filter(Boolean)) {
  // One small synthetic request for each transport; no production call data.
  const input={messages:[{role:'user',content:'قل أهلاً فقط.'}],temperature:0};
  try {
    const raw=await request('/ai/run/'+model,input);
    const result=raw.data?.result??raw.data;
    console.log('DIRECT_AI_PROBE',JSON.stringify({model,status:raw.status,success:raw.data?.success,
      resultKeys:result&&typeof result==='object'?Object.keys(result):[],
      errors:(raw.data?.errors??[]).map(e=>({code:e.code,message:safe(e.message)}))}));
    if(raw.status===401||raw.status===403) {
      console.log('Runner token may lack AI inference permission; this does not establish a runtime binding failure.');
      continue;
    }
  } catch(e) { console.log('DIRECT_AI_PROBE_ERROR',JSON.stringify({model,error:errorInfo(e)})); }
  try {
    const ai=createAI({accountId:account,apiToken:token,collectLog:false,skipCache:true});
    const result=await generateText({model:ai(model),messages:input.messages,temperature:0,maxRetries:0,abortSignal:AbortSignal.timeout(25000)});
    console.log('SDK_AI_PROBE',JSON.stringify({model,ok:true,finishReason:result.finishReason,characters:result.text.length}));
  } catch(e) {console.log('SDK_AI_PROBE_ERROR',JSON.stringify({model,error:errorInfo(e)}));}
}
