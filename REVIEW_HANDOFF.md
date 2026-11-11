# Mizan — تسليم مراجعة المحادثة والصوت

- نقطة البداية: GitHub main عند `c4494be6b66ce9a5addd3ad1d47697275a9f3a9a`.
- الإصلاحات: فرع محلي `fix/conversation-memory-and-requested-voice`، وليس main منشورًا.
- التقرير: `docs/TECHNICAL_AUDIT_2026-11-11.md`.
- الأدلة: `docs/evidence/CONVERSATION_REPAIR_VERIFICATION.json` وسجلات conversation-repair.
- الصوت المطلوب مضبوط في المصدر: `2DkHmQavK9V2UzTYrMYT`، عبر `MIZAN_VOICE_ID` والقيمة الافتراضية.
- لا تغيير للنموذج الأساسي أو الاحتياطي، ولا ترحيل قاعدة بيانات مطلوب لهذه الإصلاحات.
- لا رفع أو نشر أو تعديل بيانات إنتاج في هذا التسليم. يلزم اختبار حقيقي لتوافر الصوت على حساب المالك وجودة المكالمة.

## التحقق المحلي

```sh
npm ci
npm test
npm run typecheck
npm run bundle:check
```

`bundle:check` يجمع الكود بـWrangler dry-run وإعدادات fixture وهمية معزولة؛ لا ينشئ staging ولا ينشر. فحص `npm run build` القديم ما زال يتطلب إعداد staging حقيقيًا ومعزولًا؛ لا تتجاوز هذا الشرط بإعدادات الإنتاج.

## الأرشيف

الأرشيف يتضمن كل الملفات المتتبعة في نسخة المراجعة، والتقرير، والأدلة، وملف patch للمقارنة بالـcommit المرجعي. لا يتضمن مجلد `.git` أو `node_modules` أو أسرارًا محلية. غياب هذه المجلدات ليس حذفًا لكود التطبيق. راجع `REVIEW_MANIFEST.json` للبصمات ومعرّف commit المحلي.

لا تدمج `feat/mizan-sprints-7-12` المنفصل كطريقة لاسترجاع الشغل؛ السبرنتات موجودة أصلًا في تاريخ main. لا تشغّل `db:migrate*` ضد قاعدة الإنتاج من أجل تغيير الصوت أو إزالة سقف الرد.
