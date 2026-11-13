/* One privacy surface shared by independent and embedded calls. No storage or analytics. */
window.MizanPrivateContact = {
  mount({send,pause,resume,isActive}) {
    const dialog=document.getElementById('private-contact'),form=document.getElementById('private-contact-form'),feedback=document.getElementById('contact-feedback');
    const submit=document.getElementById('contact-submit'),cancel=document.getElementById('contact-cancel');
    let id=null,awaiting=false,busy=false,paused=false;
    const setBusy=value=>{busy=value;submit.disabled=value;cancel.disabled=value;};
    const stop=()=>{paused=true;pause();document.getElementById('privacy-call-status').textContent='الميكروفون متوقف مؤقتًا — ميزان مش هيسمعك وإنت بتملا الاستمارة.';};
    function clear(){form.reset();feedback.textContent='';if(dialog.open)dialog.close();}
    function requestCancel(){if(!id||busy)return;setBusy(true);send({type:'contact_cancel',requestId:id});}
    cancel.addEventListener('click',requestCancel);
    dialog.addEventListener('cancel',event=>{event.preventDefault();requestCancel();});
    form.addEventListener('submit',event=>{
      event.preventDefault();if(!id||busy||!form.reportValidity())return;
      setBusy(true);feedback.textContent='جاري حفظ البيانات بأمان...';
      const fields=Object.fromEntries(new FormData(form));
      send({type:'contact_submit',requestId:id,confirmed:form.elements.confirmed.checked,contact:{name:fields.name,phone:fields.phone,...(fields.email?{email:fields.email}:{})}});
    });
    return {
      get paused(){return paused;},
      handle(message){
        if(paused&&message.type==='status'&&message.status==='stt_unavailable'){
          document.getElementById('privacy-call-status').textContent='تعذر استئناف الصوت. الميكروفون ما زال متوقفًا؛ أنهِ المكالمة وحاول مجددًا.';return true;
        }
        if(message.type==='contact_required'){
          stop();clear();id=message.requestId;awaiting=false;setBusy(false);
          const email=form.elements.email;email.required=Boolean(message.requiredFields?.includes("email"));email.closest('label').hidden=!message.fields?.includes('email');
          dialog.showModal();form.elements.name.focus();return true;
        }
        if(message.type==='contact_result'&&message.requestId===id){
          if(message.ok){clear();awaiting=true;setBusy(true);feedback.textContent='';send({type:'contact_resume',requestId:id});}
          else{setBusy(false);feedback.textContent=message.message||'تعذر حفظ البيانات. راجعها ثم حاول مجددًا، أو ألغِ النموذج.';}
          return true;
        }
        if(message.type==='contact_resumed'&&message.requestId===id&&awaiting){
          id=null;awaiting=false;paused=false;setBusy(false);clear();
          const restored=isActive()?resume():false;document.getElementById('privacy-call-status').textContent=restored===false?'الميكروفون ما زال متوقفًا. راجع حالة المكالمة.':'الميكروفون عاد لحالته السابقة. لا تنطق بياناتك الشخصية.';return true;
        }
        return false;
      },
      end(){id=null;awaiting=false;paused=false;setBusy(false);clear();document.getElementById('privacy-call-status').textContent='';}
    };
  }
};
