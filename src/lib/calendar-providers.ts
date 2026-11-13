// Provider request/response adapters. No network calls or credentials in this module.
const ZOHO_HOSTS=['www.zohoapis.com','www.zohoapis.eu','www.zohoapis.in','www.zohoapis.com.au','www.zohoapis.jp','www.zohoapis.ca'];
export function calendarConfig(b: any, validateWebhook: (url:string)=>string): Record<string,unknown> {
 if(b.provider==='webhook')return {url:validateWebhook(String(b.url))};
 if(b.provider==='calcom' && Number.isSafeInteger(b.event_type_id) && b.event_type_id>0)return {event_type_id:b.event_type_id};
 if(b.provider==='zoho' && /^\d+$/.test(String(b.service_id)) && /^\d+$/.test(String(b.staff_id)) && ZOHO_HOSTS.includes(b.host||'www.zohoapis.com'))return {service_id:String(b.service_id),staff_id:String(b.staff_id),host:b.host||'www.zohoapis.com'};
 throw new Error('Invalid calendar configuration');
}
// Resolve Cairo wall time using IANA rules, rejecting ambiguous/nonexistent DST times.
export function cairoStart(date:string,time:string):string {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))throw new Error('ISO date and HH:mm required');
 const guess=Date.parse(date+'T'+time+':00Z');if(!Number.isFinite(guess))throw new Error('Invalid date');
 const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const candidates=[2,3].map(offset=>new Date(guess-offset*3600000)).filter(d=>fmt.format(d)===date+' '+time);
 if(candidates.length!==1)throw new Error('Invalid or ambiguous Cairo time');
 return candidates[0].toISOString();
}
export function calendarRequest(provider:string,cfg:any,secret:string,slots:Record<string,string>,key:string,slug:string,session:string) {
 const start=cairoStart(slots.date,slots.time);
 const headers:Record<string,string>={'Idempotency-Key':key};
 let url:string,body:BodyInit;
 if(provider==='calcom') {
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(slots.email||''))throw new Error('Cal.com booking requires an attendee email');
  url='https://api.cal.com/v2/bookings';headers.Authorization='Bearer '+secret;headers['Content-Type']='application/json';headers['cal-api-version']='2026-02-25';
  body=JSON.stringify({eventTypeId:cfg.event_type_id,start,attendee:{name:slots.name,email:slots.email,phoneNumber:'+20'+slots.phone.slice(1),timeZone:'Africa/Cairo'},metadata:{mizan_session:session}});
 }else if(provider==='zoho') {
  if(!ZOHO_HOSTS.includes(cfg.host))throw new Error('Invalid Zoho region');
  url=`https://${cfg.host}/bookings/v1/json/appointment`;headers.Authorization='Zoho-oauthtoken '+secret;
  const [y,m,d]=slots.date.split('-');const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m)-1];
  const form=new FormData();form.set('service_id',cfg.service_id);form.set('staff_id',cfg.staff_id);form.set('timezone','Africa/Cairo');form.set('from_time',`${d}-${month}-${y} ${slots.time}:00`);form.set('customer_details',JSON.stringify({name:slots.name,email:slots.email||'',phone_number:'+20'+slots.phone.slice(1)}));body=form;
 }else {
  url=cfg.url;headers.Authorization='Bearer '+secret;headers['Content-Type']='application/json';body=JSON.stringify({tenant_slug:slug,session_id:session,action:'book_appointment',slots,time_zone:'Africa/Cairo',start});
 }
 return {url,init:{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers,body} as RequestInit};
}
export function confirmedBookingId(provider:string,data:any):string|null {
 let id:unknown;
 if(provider==='calcom' && data.status==='success' && data.data?.status==='accepted')id=data.data.uid;
 if(provider==='zoho' && data.response?.status==='success' && ['confirmed','booked','upcoming'].includes(String(data.response?.returnvalue?.status).toLowerCase()))id=data.response.returnvalue.booking_id;
 if(provider==='webhook' && data.confirmed===true)id=data.booking_id;
 return typeof id==='string' && id.length>0 && id.length<=200?id:null;
}
