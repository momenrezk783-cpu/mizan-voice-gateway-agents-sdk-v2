"use strict";
(()=>{
const $=id=>document.getElementById(id), base="/api/admin/ttsforfree", storage="mizan:ttsforfree:active-job";
const state={languages:[],favorites:[],custom:[],catalog:[],limit:null,voice:"",job:null,controller:null,polling:false,creating:false};
const setMessage=s=>{$("message").textContent=s;}, msg=e=>e instanceof Error?e.message:String(e);
const unwrap=x=>x&&typeof x==="object"&&"Data" in x?x.Data:x;
const asList=x=>Array.isArray(x)?x:Array.isArray(x?.Languages)?x.Languages:Array.isArray(x?.Voices)?x.Voices:Array.isArray(x?.Items)?x.Items:[];
const token=x=>String(x?.VoiceName??x?.Voice??"");
const friendly=x=>String(x?.DisplayName??x?.FriendlyName??x?.Name??x?.VoiceShortName??token(x));
const lang=x=>String(x?.LanguageCode??x?.Code??x?.Language??x?.Lang??"");
const option=(value,label)=>{const o=document.createElement("option");o.value=value;o.textContent=label;return o;};
const wait=(ms,signal)=>new Promise((resolve,reject)=>{if(signal.aborted)return reject(new DOMException("Cancelled","AbortError"));const t=setTimeout(()=>{signal.removeEventListener("abort",cancel);resolve();},ms);function cancel(){clearTimeout(t);reject(new DOMException("Cancelled","AbortError"));}signal.addEventListener("abort",cancel,{once:true});});
const http=async(path,settings={},signal)=>{
 const res=await fetch(base+path,{credentials:"same-origin",...settings,signal});
 const data=await res.json().catch(()=>({}));
 if(!res.ok){const error=new Error(data.error||"Server error "+res.status);error.status=res.status;const after=res.headers.get("Retry-After");error.retryAfter=after?(/^[0-9]+$/.test(after)?Number(after)*1000:Math.max(0,Date.parse(after)-Date.now())):0;throw error;}
 return data;
};
function drawGroup(id,items){const el=$(id);el.replaceChildren();if(!items.length){el.textContent="لا توجد أصوات في هذه المجموعة أو لم يتم العثور عليها";return;}
 const choices=document.createElement("div");choices.className="controls";
 for(const item of items){const t=token(item);if(!t)continue;const b=document.createElement("button");b.type="button";b.className="secondary";b.textContent=friendly(item);b.addEventListener("click",()=>chooseVoice(t));choices.append(b);}
 el.append(choices);
}
function renderVoiceDropdown(){const el=$("voice");el.replaceChildren(option("","اختر صوتًا"));for(const [name,items] of [["المفضلة",state.favorites],["أصواتي",state.custom],["كتالوج اللغة",state.catalog]]){const group=document.createElement("optgroup");group.label=name;for(const item of items){const t=token(item);if(t)group.append(option(t,friendly(item)));}el.append(group);}
 el.value=state.voice; if(el.value!==state.voice)state.voice=""; $("detail").disabled=!state.voice;updateCreate();}
function chooseVoice(v){state.voice=v;$("voice").value=v;$("voice-info").replaceChildren();$("detail").disabled=!v;updateCreate();}
function updateCreate(){const value=$("text").value,count=[...value].length;$("count").textContent=count+" حرف"+(state.limit?" / "+state.limit:" (الحد غير متاح)");$("create").disabled=state.creating||!!state.job||!state.voice||!state.limit||count===0||count>state.limit;}
async function load(){state.limit=null;state.languages=[];$("load-status").textContent="جارٍ تحديث البيانات...";$("language").disabled=true;updateCreate();
 const [langs,limits]=await Promise.allSettled([http("/languages"),http("/limits")]);
 if(langs.status==="fulfilled"){state.languages=asList(unwrap(langs.value));const sel=$("language");const prev=sel.value;sel.replaceChildren(option("","اختر اللغة"));for(const l of state.languages){const code=typeof l==="string"?l:lang(l);if(code)sel.append(option(code,typeof l==="string"?l:friendly(l)==="[object Object]"?code:String(l.FriendlyName??l.Name??code)));}
 const egypt=[...sel.options].find(o=>o.value.toLowerCase()==="ar-eg");sel.value=prev&&[...sel.options].some(o=>o.value===prev)?prev:egypt?.value||"";sel.disabled=false;
 }else{$("load-status").textContent="فشل تحميل اللغات: "+msg(langs.reason)+"، أعد المحاولة";}
 if(limits.status==="fulfilled"){const d=unwrap(limits.value);const candidates=[d,d?.MaxLength,d?.MaxTextLength,d?.MaxCharacters,d?.TextMaxLength,d?.MaxChars].map(Number);state.limit=candidates.find(n=>Number.isSafeInteger(n)&&n>0&&n<1000000)||null;}
 if(!state.limit)$("load-status").textContent="تعذر تحديد الحد الأقصى للنص. جرّب تحديث الإعدادات.";
 else if(langs.status==="fulfilled")$("load-status").textContent="الإعدادات جاهزة";
 const side=await Promise.allSettled([http("/favorites"),http("/custom")]);state.favorites=side[0].status==="fulfilled"?asList(unwrap(side[0].value)):[];state.custom=side[1].status==="fulfilled"?asList(unwrap(side[1].value)):[];drawGroup("favorites",state.favorites);drawGroup("custom",state.custom);
 await loadCatalog();updateCreate();
}
async function loadCatalog(){const v=$("language").value;state.catalog=[];$("catalog").textContent="جارٍ تحميل الأصوات...";if(!v){renderVoiceDropdown();return;}try{state.catalog=asList(unwrap(await http("/voices?lang="+encodeURIComponent(v))));drawGroup("catalog",state.catalog);}
 catch(e){$("catalog").textContent="فشل تحميل الأصوات: "+msg(e);const b=document.createElement("button");b.className="secondary";b.textContent="إعادة المحاولة";b.onclick=loadCatalog;$("catalog").append(b);}
 const allowed=[...state.favorites,...state.custom,...state.catalog].some(x=>token(x)===state.voice && (!lang(x)||lang(x).toLowerCase()===v.toLowerCase()));if(!allowed)state.voice="";renderVoiceDropdown();
}
async function details(){if(!state.voice)return;$("voice-info").textContent="جارٍ تحميل تفاصيل الصوت...";try{const data=unwrap(await http("/voice-detail?voice="+encodeURIComponent(state.voice)));const detail=typeof data==="object"&&data?data:{};const box=document.createElement("div");box.className="group";const entries=[["الاسم",detail.FriendlyName??detail.DisplayName??detail.Name],["اللكنة",detail.Accent],["الاستخدام",detail.UseCase],["الشخصية",detail.Persona],["التكلفة لكل حرف",detail.BaseCreditsPerCharacter]];for(const [k,v]of entries){if(v!==undefined&&v!==null){const p=document.createElement("p");p.textContent=k+": "+String(v);box.append(p);}}
 const audio=detail.ReviewAudio??detail.PreviewAudioUrl??detail.SampleAudioUrl;if(typeof audio==="string"&&/^https:\/\//.test(audio)){const player=document.createElement("audio");player.controls=true;player.src=audio;box.append(player);}else{const p=document.createElement("p");p.textContent="معاينة صوتية غير متاحة من المزود";box.append(p);}$("voice-info").replaceChildren(box);
 }catch(e){$("voice-info").textContent="تعذر الحصول على تفاصيل الصوت: "+msg(e);}}
function showAudio(url){const safe=typeof url==="string"&&/^https:\/\//.test(url);$("player").hidden=!safe;$("download").hidden=!safe;if(safe){$("player").src=url;$("download").href=url;$("download").textContent="فتح أو تنزيل الملف الصوتي";}}
function stopPoll(){state.controller?.abort();state.controller=null;state.polling=false;$("cancel").disabled=true;}
async function poll(){if(!state.job||state.polling)return;const ctl=new AbortController();state.controller=ctl;state.polling=true;$("cancel").disabled=false;$("retry").hidden=true;
 const deadline=Date.now()+3*60*1000;let failures=0;
 try{while(!ctl.signal.aborted){if(Date.now()>deadline){setMessage("انتهت مهلة الانتظار. رقم الـ Job محفوظ، اضغط إعادة فحص الحالة.");$("retry").hidden=false;break;}
 try{const r=await http("/status/"+encodeURIComponent(state.job.id),{},ctl.signal);failures=0;
 if(r.failed||r.status==="ERROR"){setMessage("فشل التوليد: "+(r.message||"خطأ غير معروف"));localStorage.removeItem(storage);state.job=null;break;}
 if(r.done||r.status==="SUCCESS"){if(r.audioUrl){setMessage("العينة جاهزة للاستماع");showAudio(r.audioUrl);}else{setMessage("نجح الـ Job لكن رابط الملف غير متاح في الاستجابة. استخدم سجل الحساب.");}localStorage.removeItem(storage);state.job=null;break;}
 setMessage("جاري معالجة العينة... الحالة: "+r.status);
 await wait(5000,ctl.signal);
 }catch(e){if(ctl.signal.aborted)break;if(e.status===400||e.status===401||e.status===403||e.status===404){setMessage(msg(e));$("retry").hidden=false;break;}
 failures++;const ms=e.retryAfter||Math.min(30000,5000*Math.pow(2,Math.min(failures-1,3)))*(0.8+Math.random()*0.4);
 setMessage("تعذّر فحص الحالة مؤقتًا. إعادة المحاولة بدون إنشاء Job جديد...");await wait(ms,ctl.signal);
 }}
 }catch(e){if(!ctl.signal.aborted)setMessage(msg(e));}
 finally{if(state.controller===ctl){state.controller=null;state.polling=false;$("cancel").disabled=true;}updateCreate();}
}
async function create(){if(state.creating||state.job||!state.voice||!state.limit)return;state.creating=true;updateCreate();showAudio(null);$("retry").hidden=true;setMessage("إرسال طلب توليد واحد...");
 // On unknown create response we MUST NOT auto-submit again (credits may be charged).
 try{const result=await http("/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:$("text").value,voice:state.voice,maxLength:state.limit})});if(!result.id)throw Error("لم يتم استلام رقم Job صالح");
 state.job={id:String(result.id),createdAt:Date.now()};localStorage.setItem(storage,JSON.stringify(state.job));await poll();
 }catch(e){setMessage("تعذر تأكيد طلب التوليد: "+msg(e)+". إذا كان الطلب وصل للمزود، راجع سجل حسابك قبل إعادة التوليد.");}
 finally{state.creating=false;updateCreate();}
}
$("reload").onclick=load;$("language").onchange=loadCatalog;$("voice").onchange=e=>chooseVoice(e.target.value);$("text").oninput=updateCreate;$("detail").onclick=details;$("create").onclick=create;
$("cancel").onclick=()=>{stopPoll();setMessage("توقفت المتابعة فقط. الـ Job لم يُلغَ ولا يزال محفوظًا.");$("retry").hidden=false;};$("retry").onclick=poll;
window.addEventListener("pagehide",stopPoll);
try{const old=JSON.parse(localStorage.getItem(storage)||"null");if(old&&/^[1-9]\\d{0,17}$/.test(String(old.id))){state.job={id:String(old.id),createdAt:Number(old.createdAt)||Date.now()};setMessage("استعادة متابعة Job سابق: "+state.job.id);$("retry").hidden=false;poll();}}catch{localStorage.removeItem(storage);}
load().catch(e=>{$("load-status").textContent="تعذر التحميل: "+msg(e);});
})();