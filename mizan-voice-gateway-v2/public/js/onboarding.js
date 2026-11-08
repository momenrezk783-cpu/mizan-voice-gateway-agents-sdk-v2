// ============================================================================
// Mizan Consult — User Onboarding & Product Walkthrough Tool (RTL Arabic)
// ============================================================================
// Triggers:
//   1. Automatically on first-time login (when mizan_trigger_onboarding=1 or
//      !localStorage.getItem('mizan_onboarding_done_' + context))
//   2. Manually at any time via the "جولة تعريفية" button (for visitors & users)
// ============================================================================

(function () {
  const STYLE_CSS = `
    .mz-tour-overlay {
      position: fixed;
      inset: 0;
      z-index: 99990;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    .mz-tour-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 45, 82, 0.55);
      z-index: 99990;
      backdrop-filter: blur(2px);
    }
    .mz-tour-spotlight {
      position: fixed;
      z-index: 99991;
      border-radius: 14px;
      box-shadow: 0 0 0 9999px rgba(15, 45, 82, 0.62), 0 0 0 4px #2563EB, 0 0 24px rgba(37, 99, 235, 0.5);
      transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      pointer-events: none;
    }
    .mz-tour-card {
      position: fixed;
      z-index: 99995;
      width: 390px;
      max-width: calc(100vw - 32px);
      background: #FFFFFF;
      color: #0F2D52;
      border: 1px solid #D5DEEB;
      border-radius: 16px;
      padding: 22px 24px;
      box-shadow: 0 16px 40px rgba(15, 45, 82, 0.22);
      font-family: 'IBM Plex Sans Arabic', Tahoma, sans-serif;
      direction: rtl;
      text-align: right;
      transition: all 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .mz-tour-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .mz-tour-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 999px;
      background: #EAF1FF;
      color: #1D4ED8;
      font-size: 12.5px;
      font-weight: 700;
    }
    .mz-tour-close {
      border: 0;
      background: #F6F8FB;
      color: #5B6B80;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      display: grid;
      place-items: center;
    }
    .mz-tour-close:hover { background: #E5EAF1; color: #0F2D52; }
    .mz-tour-title {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 700;
      color: #0F2D52;
    }
    .mz-tour-desc {
      margin: 0 0 18px;
      font-size: 14.5px;
      line-height: 1.75;
      color: #46566B;
    }
    .mz-tour-dots {
      display: flex;
      gap: 6px;
      margin-bottom: 16px;
    }
    .mz-tour-dot {
      height: 6px;
      flex: 1;
      border-radius: 99px;
      background: #E5EAF1;
      transition: background 0.2s;
    }
    .mz-tour-dot.done { background: #93C5FD; }
    .mz-tour-dot.active { background: #2563EB; }
    .mz-tour-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .mz-tour-btn {
      height: 40px;
      padding: 0 18px;
      border-radius: 10px;
      border: 0;
      font: 600 14px 'IBM Plex Sans Arabic', Tahoma, sans-serif;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s, transform 0.15s;
    }
    .mz-tour-btn.pri {
      background: #2563EB;
      color: #FFFFFF;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.24);
    }
    .mz-tour-btn.pri:hover { background: #1D4ED8; transform: translateY(-1px); }
    .mz-tour-btn.sec {
      background: #F6F8FB;
      color: #0F2D52;
      border: 1px solid #D5DEEB;
    }
    .mz-tour-btn.sec:hover { background: #EEF2F7; }
    .mz-tour-trigger-btn {
      height: 42px;
      padding: 0 16px;
      border-radius: 12px;
      border: 1px solid #BFDBFE;
      background: #EAF1FF;
      color: #1D4ED8;
      font: 600 13.5px 'IBM Plex Sans Arabic', Tahoma, sans-serif;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .mz-tour-trigger-btn:hover {
      background: #2563EB;
      color: #FFFFFF;
      border-color: #2563EB;
    }
  `;

  const TOURS = {
    landing: [
      {
        selector: ".hero h1",
        title: "مرحباً بك في منصة ميزان كونسلت",
        desc: "مساعد صوتي ذكي يتحدث باللهجة المصرية ومصمم لخدمة كافة الأنشطة والقطاعات (الشركات التجارية، المكاتب القانونية، العقارات، التعليم، والمراكز المتخصصة)."
      },
      {
        selector: ".dm",
        title: "معاينة حية لاستجابة المساعد الصوتي",
        desc: "يرد المساعد على المتصلين في أقل من ثانية، يجيب من قاعدة معرفة منشأتك، ويحجز المواعيد أو يسجل طلبات العملاء على مدار الساعة."
      },
      {
        selector: "#features",
        title: "معمارية سحابية موحدة وآمنة",
        desc: "يعمل النظام على Cloudflare Workers AI وقاعدة بيانات D1 مع تشفير كامل لبيانات العملاء وفق القانون المصري رقم 151 لسنة 2020."
      },
      {
        selector: "#nav-login-btn",
        title: "ابدأ الآن أو ادخل لوحة منشأتك",
        desc: "يمكنك تجربة المساعد الصوتي مباشرة أو تسجيل الدخول إلى بوابة المنشأة لإدارة المكالمات وقاعدة المعرفة."
      }
    ],
    login: [
      {
        selector: ".fm h1",
        title: "بوابة دخول موحدة للمنشآت والمديرين",
        desc: "يدخل مدير المنشأة إلى لوحة شركته (/client)، بينما يُوجَّه المدير العام تلقائياً إلى لوحة إدارة المنصة الشاملة (/dashboard)."
      },
      {
        selector: "#login-form-box",
        title: "تشغيل الجولة التعريفية تلقائياً عند أول دخول",
        desc: "بمجرد تسجيل الدخول لأول مرة، ستفتح لك أداة الجولة التعريفية تلقائياً لشرح كل قسم في لوحة التحكم خطوة بخطوة."
      }
    ],
    call: [
      {
        selector: "#callBtn",
        title: "بدء المكالمة الصوتية المباشرة",
        desc: "اضغط على زر الميكروفون للتحدث مباشرة مع المساعد الصوتي الخاص بالمنشأة عبر اتصال WebSocket فوري."
      },
      {
        selector: "#wave",
        title: "مؤشر الموجات الصوتية التفاعلي",
        desc: "يعرض حالة الاستماع والتحدث في الوقت الفعلي مع دعم كتم الصوت وإنهاء المكالمة في أي لحظة."
      },
      {
        selector: "#transcriptContainer",
        title: "النص الحي للمحادثة",
        desc: "يظهر هنا تفريغ نصي فوري لحوار المتصل وردود المساعد الصوتي خطوة بخطوة."
      }
    ],
    client: [
      {
        action: () => window.showPage && window.showPage('overview'),
        selector: "#kpi-grid",
        title: "1. مؤشرات الأداء الفورية (Overview KPIs)",
        desc: "تعرّف بسرعة على إجمالي مكالمات منشأتك، نسبة الرد الآلي، الحجوزات والطلبات المؤكدة، ومعدل رضا العملاء."
      },
      {
        action: () => window.showPage && window.showPage('calls'),
        selector: "#page-calls",
        title: "2. سجل المكالمات وتفريغ الحوار",
        desc: "استعرض كل مكالمة بالتفصيل، وافتح نافذة الحوار لقراءة ملخص المساعد ونص المحادثة الكامل وبيانات المتصل المشفرة."
      },
      {
        action: () => window.showPage && window.showPage('knowledge'),
        selector: "#page-knowledge",
        title: "3. إدارة قاعدة المعرفة الديناميكية",
        desc: "أضف أو عدّل الأسئلة الشائعة ومواعيد العمل والخدمات والسياسات؛ يتم تحديث ذاكرة المساعد الصوتي خلال 30 ثانية."
      },
      {
        action: () => window.showPage && window.showPage('settings'),
        selector: "#page-settings",
        title: "4. إعدادات الصوت والشخصية",
        desc: "اختر نبرة الصوت (هادئ، ودود، واثق)، واضبط سرعة الحديث ودرجة الرسمية والتعليمات الإضافية ورقم التحويل."
      },
      {
        action: () => window.showPage && window.showPage('links'),
        selector: "#page-links",
        title: "5. رابط المكالمة المخصص ورمز QR",
        desc: "انسخ رابط الاتصال المباشر لمنشأتك (/c/slug)، أو كود الزر العائم لموقعك، أو اطبع رمز QR لعملائك."
      },
      {
        action: () => window.showPage && window.showPage('search'),
        selector: "#page-search",
        title: "6. صفحة محرك البحث الداخلي المخصص",
        desc: "صفحة فرونت إند مجهزة بالكامل لربط محرك البحث الداخلي الخاص بك لاحقاً للبحث في سجلات ومستندات المنشأة."
      }
    ],
    admin: [
      {
        action: () => window.showPage && window.showPage('overview'),
        selector: "#kpi-grid",
        title: "1. لوحة المدير العام (Super Admin)",
        desc: "مراقبة شاملة لجميع المنشآت المشتركة عبر مختلف القطاعات، إجمالي المكالمات، وزمن الاستجابة."
      },
      {
        action: () => window.showPage && window.showPage('tenants'),
        selector: "#page-tenants",
        title: "2. إدارة المنشآت متعددة القطاعات",
        desc: "استعرض كافة الشركات والمنشآت، حالتها (نشطة / تجريبية / متوقفة)، مجال نشاطها، ورابط المكالمة الخاص بكل منشأة."
      },
      {
        action: () => window.showPage && window.showPage('new-tenant'),
        selector: "#page-new-tenant",
        title: "3. إنشاء مساعد لمنشأة جديدة في ثوانٍ",
        desc: "أضف أي شركة أو مؤسسة جديدة وحدد قطاعها (تجاري، قانوني، عقاري، خدمي، تعليمي، طبي...) ليتم توليد رابطها فوراً."
      },
      {
        action: () => window.showPage && window.showPage('guards'),
        selector: "#page-guards",
        title: "4. الهوية العامة وضوابط الأمان القطاعية",
        desc: "تحكم في الهوية المصرية الموحدة لميزان، واضبط قواعد الحماية الإلزامية لكل قطاع (Industry Guards)."
      },
      {
        action: () => window.showPage && window.showPage('search'),
        selector: "#page-search",
        title: "5. صفحة محرك البحث الداخلي",
        desc: "واجهة محرك البحث الداخلي المجهزة في الفرونت إند لربطها بالباك إند الخاص بك في أي وقت."
      }
    ]
  };

  let currentContext = "client";
  let currentStep = 0;
  let overlayEl = null;
  let spotlightEl = null;
  let cardEl = null;

  function ensureStyles() {
    if (document.getElementById("mz-tour-styles")) return;
    const st = document.createElement("style");
    st.id = "mz-tour-styles";
    st.textContent = STYLE_CSS;
    document.head.appendChild(st);
  }

  function startTour(contextName) {
    ensureStyles();
    currentContext = contextName || document.body.getAttribute("data-tour-context") || "client";
    const steps = TOURS[currentContext] || TOURS.client;
    if (!steps || !steps.length) return;
    currentStep = 0;
    createOverlay();
    renderStep();
  }

  function createOverlay() {
    removeOverlay();
    overlayEl = document.createElement("div");
    overlayEl.className = "mz-tour-backdrop";
    overlayEl.onclick = endTour;

    spotlightEl = document.createElement("div");
    spotlightEl.className = "mz-tour-spotlight";

    cardEl = document.createElement("div");
    cardEl.className = "mz-tour-card";

    document.body.appendChild(overlayEl);
    document.body.appendChild(spotlightEl);
    document.body.appendChild(cardEl);
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (spotlightEl) { spotlightEl.remove(); spotlightEl = null; }
    if (cardEl) { cardEl.remove(); cardEl = null; }
  }

  function renderStep() {
    const steps = TOURS[currentContext] || TOURS.client;
    const step = steps[currentStep];
    if (!step) {
      endTour();
      return;
    }

    if (typeof step.action === "function") {
      try { step.action(); } catch (e) {}
    }

    setTimeout(() => {
      const target = step.selector ? document.querySelector(step.selector) : null;
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      setTimeout(() => {
        positionSpotlightAndCard(target, step, steps.length);
      }, 180);
    }, 80);
  }

  function positionSpotlightAndCard(target, step, total) {
    if (!cardEl || !spotlightEl) return;

    const dotsHtml = Array.from({ length: total }).map((_, i) =>
      `<span class="mz-tour-dot ${i < currentStep ? 'done' : (i === currentStep ? 'active' : '')}"></span>`
    ).join("");

    cardEl.innerHTML = `
      <div class="mz-tour-top">
        <span class="mz-tour-badge">🎯 جولة تعريفية • الخطوة ${currentStep + 1} من ${total}</span>
        <button type="button" class="mz-tour-close" title="إغلاق الجولة" id="mz-tour-close-btn">✕</button>
      </div>
      <div class="mz-tour-dots">${dotsHtml}</div>
      <h4 class="mz-tour-title">${step.title}</h4>
      <p class="mz-tour-desc">${step.desc}</p>
      <div class="mz-tour-actions">
        <div>
          ${currentStep > 0 ? `<button type="button" class="mz-tour-btn sec" id="mz-tour-prev-btn">السابق</button>` : `<button type="button" class="mz-tour-btn sec" id="mz-tour-skip-btn">تخطي</button>`}
        </div>
        <button type="button" class="mz-tour-btn pri" id="mz-tour-next-btn">
          ${currentStep + 1 < total ? 'التالي ←' : 'إنهاء الجولة ✓'}
        </button>
      </div>
    `;

    cardEl.querySelector("#mz-tour-close-btn").onclick = endTour;
    const skipBtn = cardEl.querySelector("#mz-tour-skip-btn");
    if (skipBtn) skipBtn.onclick = endTour;
    const prevBtn = cardEl.querySelector("#mz-tour-prev-btn");
    if (prevBtn) prevBtn.onclick = () => { currentStep--; renderStep(); };
    cardEl.querySelector("#mz-tour-next-btn").onclick = () => {
      if (currentStep + 1 < total) {
        currentStep++;
        renderStep();
      } else {
        endTour();
      }
    };

    if (target) {
      const rect = target.getBoundingClientRect();
      const pad = 8;
      spotlightEl.style.display = "block";
      spotlightEl.style.top = Math.max(8, rect.top - pad) + "px";
      spotlightEl.style.left = Math.max(8, rect.left - pad) + "px";
      spotlightEl.style.width = Math.min(window.innerWidth - 16, rect.width + pad * 2) + "px";
      spotlightEl.style.height = Math.min(window.innerHeight - 16, rect.height + pad * 2) + "px";
      overlayEl.style.background = "transparent";

      const cardRect = cardEl.getBoundingClientRect();
      let top = rect.bottom + 18;
      if (top + cardRect.height > window.innerHeight - 16) {
        top = Math.max(16, rect.top - cardRect.height - 18);
      }
      let left = Math.min(window.innerWidth - cardRect.width - 16, Math.max(16, rect.right - cardRect.width));
      cardEl.style.top = top + "px";
      cardEl.style.left = left + "px";
    } else {
      spotlightEl.style.display = "none";
      overlayEl.style.background = "rgba(15, 45, 82, 0.55)";
      cardEl.style.top = "50%";
      cardEl.style.left = "50%";
      cardEl.style.transform = "translate(-50%, -50%)";
    }
  }

  function endTour() {
    try {
      localStorage.setItem("mizan_onboarding_done_" + currentContext, "1");
      sessionStorage.removeItem("mizan_trigger_onboarding");
    } catch (e) {}
    removeOverlay();
  }

  function checkAutoStart(contextName) {
    try {
      const ctx = contextName || document.body.getAttribute("data-tour-context");
      if (!ctx) return;
      const forceTrigger = sessionStorage.getItem("mizan_trigger_onboarding") === "1";
      const alreadyDone = localStorage.getItem("mizan_onboarding_done_" + ctx) === "1";
      // Auto-run for first-time logged-in users on portal/dashboard, or when explicitly triggered on login
      if (forceTrigger || ((ctx === "client" || ctx === "admin") && !alreadyDone)) {
        setTimeout(() => startTour(ctx), 650);
      }
    } catch (e) {}
  }

  window.MizanOnboarding = {
    start: startTour,
    end: endTour,
    checkAutoStart: checkAutoStart,
    resetAndStart: function (ctx) {
      try {
        localStorage.removeItem("mizan_onboarding_done_" + (ctx || currentContext));
      } catch (e) {}
      startTour(ctx);
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    ensureStyles();
    checkAutoStart();
  });
})();
