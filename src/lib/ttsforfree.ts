// TTSForFree adapter for Mizan's authenticated voice evaluation studio.
// CreateBy only: Mizan generates each reply without an external fixed timeline.
const API = "https://api.ttsforfree.com";
type Dict = Record<string, unknown>;
const obj = (x: unknown): Dict => x && typeof x === "object" && !Array.isArray(x) ? x as Dict : {};
const str = (x: unknown) => typeof x === "string" ? x : "";
const jobId = (x: unknown): string | null => typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? String(x) : typeof x === "string" && /^[1-9]\\d{0,17}$/.test(x) ? x : null;
const json = (body: unknown, status=200, extra: Record<string,string>={}) => new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...extra}});
export class TTSForFreeError extends Error {
  constructor(message: string, public status=502, public retryAfter: string | null=null) { super(message); }
}
export const ttsStatusPath = (id: string, mode: "single" | "multi" = "single") => mode === "single" ? `/api/TTS/Status/${id}` : `/api/TTS/Multi/Status/${id}`;
export function normalizeStatus(raw: unknown) {
  const r=obj(raw), d=obj(r.Data);
  const status=str(r.Status || r.StatusName || d.Status || d.StatusName).toUpperCase();
  const code=Number(r.StatusId ?? d.StatusId);
  const failed=status==="ERROR" || code===-100;
  const success=!failed && (status==="SUCCESS" || code===200);
  const url=[r.Data, r.FinalAudioUrl,d.FinalAudioUrl,d.Data].find(x=>typeof x==="string" && /^https:\/\//.test(x as string));
  return {id:jobId(r.Id ?? d.Id), status:failed?"ERROR":success?"SUCCESS":status || "PROCESSING", done:success, failed, audioUrl:success ? url ?? null : null, message:str(r.Message || d.Message)};
}
export function extractLimit(raw: unknown): number | null {
  const data=obj(raw).Data ?? raw;
  const r=obj(data);
  const candidates=[data,r.MaxLength,r.MaxTextLength,r.MaxCharacters,r.TextMaxLength,r.MaxChars];
  for (const c of candidates) {
    const n=Number(c); if(Number.isSafeInteger(n) && n>0 && n<1_000_000) return n;
  }
  return null;
}
async function call(env:{TTSFORFREE_API_KEY?:string}, path:string, body?:Dict) {
  const key=env.TTSFORFREE_API_KEY?.trim();
  if(!key)throw new TTSForFreeError("TTSForFree API key is not configured",503);
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),12000);
  try {
    const res=await fetch(API+path,{method:body?"POST":"GET",headers:{"X-API-Key":key,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal});
    if(!res.ok) {
      const payload=await res.json().catch(()=>({}));
      const msg=str(obj(payload).Message);
      throw new TTSForFreeError(msg && ![401,403].includes(res.status)?msg:`TTSForFree HTTP ${res.status}`,res.status===429?429:res.status===400?400:res.status===401?401:res.status===403?403:502,res.headers.get("Retry-After"));
    }
    return await res.json() as unknown;
  } catch(e) {
    if(e instanceof TTSForFreeError)throw e;
    throw new TTSForFreeError("TTSForFree temporarily unreachable",503);
  } finally { clearTimeout(timer); }
}
function routeError(e:unknown):Response {
  const err=e instanceof TTSForFreeError ? e : new TTSForFreeError("TTS provider request failed");
  return json({error:err.message},err.status,err.retryAfter?{"Retry-After":err.retryAfter}:{});
}
export async function ttsForFreeRoute(request: Request, env:{TTSFORFREE_API_KEY?:string}, url:URL):Promise<Response> {
  const path=url.pathname.replace(/^\/api\/admin\/ttsforfree/,"");
  try {
    if(request.method==="GET") {
      let remote: string | null = null;
      if(path==="/languages")remote="/api/Common/GetListLanguage";
      if(path==="/limits")remote="/api/Common/GetConfigMaxLength";
      if(path==="/favorites")remote="/api/FavoriteVoices/GetMyFavorites";
      if(path==="/custom")remote="/api/CustomVoices/GetMyVoices";
      if(path==="/voices") {
        const lang=url.searchParams.get("lang")||"";
        if(!/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(lang))return json({error:"Invalid language"},400);
        remote=`/api/Common/GetListVoice?lang=${encodeURIComponent(lang)}&type=singlevoice`;
      }
      if(path==="/voice-detail") {
        const name=url.searchParams.get("voice")||"";
        if(!name || name.length>600)return json({error:"Invalid voice"},400);
        remote=`/api/Common/GetVoiceDetail?voiceName=${encodeURIComponent(name)}`;
      }
      if(path==="/history")remote="/api/TTS/GetHistory?page=1&pageSize=20";
      const match=path.match(/^\/status\/([1-9]\\d{0,17})$/);
      if(match)remote=ttsStatusPath(match[1]);
      if(remote) {
        const data=await call(env,remote);
        return json(match?normalizeStatus(data):data);
      }
    }
    if(path==="/create" && request.method==="POST") {
      const input=obj(await request.json());
      const text=str(input.text).trim(),voice=str(input.voice);
      const max=Number(input.maxLength);
      if(!text || !Number.isSafeInteger(max) || max<=0 || max>1_000_000 || [...text].length>max)return json({error:"Text exceeds current provider limit"},400);
      if(!voice || voice.length>600 || /[\u0000-\u001f]/.test(voice))return json({error:"Invalid voice token"},400);
      // Validate against freshly fetched provider limit, not browser-provided limit alone.
      const current=extractLimit(await call(env,"/api/Common/GetConfigMaxLength"));
      if(current===null)return json({error:"Could not validate provider text limit"},503);
      if([...text].length>current)return json({error:`Text exceeds provider limit (${current})`},400);
      const result=obj(await call(env,"/api/TTS/CreateBy",{Texts:text,Voice:voice}));
      const id=jobId(result.Id);
      if(!id)return json({error:"Provider did not return a valid job Id; check history before trying again"},502);
      return json({id,status:str(result.Status)||"PENDING"},202);
    }
    return json({error:"Not found"},404);
  } catch(e){return routeError(e);}
}
