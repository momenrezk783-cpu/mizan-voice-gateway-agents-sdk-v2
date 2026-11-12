(() => {
  const form=document.getElementById('quote-form');if(!form)return;
  const status=document.getElementById('quote-status'),button=form.querySelector('button[type="submit"]');
  let requestId=crypto.randomUUID(),busy=false,lastPayload=null;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!form.reportValidity())return;
    const fields=Object.fromEntries(new FormData(form));fields.consent=form.elements.consent.checked;
    const payload=JSON.stringify(fields);if(lastPayload!==null&&payload!==lastPayload)requestId=crypto.randomUUID();lastPayload=payload;
    busy=true;button.disabled=true;status.textContent='جاري إرسال طلبك...';
    try{
      const response=await fetch('/api/public/quote-requests',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({...fields,requestId})});
      if(!response.ok){status.textContent=response.status===429?'وصلت للحد المؤقت للطلبات. حاول لاحقًا أو راسلنا بالبريد.':response.status===400?'راجع الحقول المطلوبة وصحة البريد ثم حاول مجددًا.':'تعذر حفظ الطلب الآن. بياناتك ما زالت في النموذج؛ حاول مجددًا أو راسلنا بالبريد.';return;}
      form.reset();requestId=crypto.randomUUID();lastPayload=null;status.textContent='وصل طلب عرض السعر المجاني. سنراجعه ونتواصل معك في أسرع وقت ممكن.';
    }catch{status.textContent='تعذر الاتصال. احتفظنا بالمدخلات في هذه الصفحة فقط؛ أعد المحاولة أو راسلنا بالبريد.';}
    finally{busy=false;button.disabled=false;}
  });
})();
