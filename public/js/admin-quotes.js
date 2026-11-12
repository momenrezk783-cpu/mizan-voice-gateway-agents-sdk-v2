(() => {
  const table=document.getElementById('quote-requests-body'),status=document.getElementById('quotes-status'),filter=document.getElementById('quote-status-filter');
  if(!table)return;
  const labels={new:'جديد',contacting:'جارٍ التواصل',closed:'مغلق'};
  async function load(){
    status.textContent='جاري تحميل الطلبات...';table.replaceChildren();
    try {
      const response=await fetch('/api/admin/quote-requests'+(filter.value?'?status='+encodeURIComponent(filter.value):''),{credentials:'same-origin'});
      if(!response.ok)throw new Error('load');
      const {requests}=await response.json();
      for(const request of requests){
        const row=document.createElement('tr');
        for(const value of [new Date(request.created_at*1000).toLocaleString('ar-EG'),request.name,request.email,request.phone||'—',request.organization||'—',request.service,request.description]){
          const cell=document.createElement('td');cell.textContent=String(value);cell.style.whiteSpace='pre-wrap';row.appendChild(cell);
        }
        const cell=document.createElement('td'),select=document.createElement('select');
        select.setAttribute('aria-label','حالة طلب '+request.id);
        for(const [value,label]of Object.entries(labels)){const option=document.createElement('option');option.value=value;option.textContent=label;select.appendChild(option);}select.value=request.status;
        select.addEventListener('change',async()=>{select.disabled=true;try{const changed=await fetch('/api/admin/quote-requests/'+encodeURIComponent(request.id),{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:select.value})});if(!changed.ok)throw new Error('save');request.status=select.value;status.textContent='تم تحديث الحالة.';}catch{select.value=request.status;status.textContent='لم تُحفظ الحالة؛ حاول مجددًا.';}finally{select.disabled=false;}});
        cell.appendChild(select);row.appendChild(cell);table.appendChild(row);
      }
      status.textContent=requests.length?'عروض الأسعار مجانية؛ راجع الطلبات وتواصل مع أصحابها عبر البيانات المعروضة.':'لا توجد طلبات تطابق الفلتر.';
    }catch{status.textContent='تعذر تحميل الطلبات. تحقق من الجلسة وصلاحية المدير العام وتطبيق الترحيل المطلوب.';}
  }
  filter.addEventListener('change',load);document.getElementById('refresh-quotes').addEventListener('click',load);
  window.loadQuoteRequests=load;
})();
