(() => {
  'use strict';

  const STORAGE_KEY = 'mizan_ui_language';
  const translations = {
    'Mizan HQ — تطوير الذكاء الاصطناعي والحلول الذكية': 'Mizan HQ — AI Development & Smart Solutions',
    'تسجيل الدخول — ميزان هيد كوارتر': 'Sign In — Mizan HQ',
    'لوحة المدير العام — ميزان هيد كوارتر': 'Super Admin Dashboard — Mizan HQ',
    'بوابة المنشأة — ميزان هيد كوارتر': 'Organization Portal — Mizan HQ',
    'محرك البحث الداخلي — ميزان هيد كوارتر': 'Internal Search — Mizan HQ',
    'ميزان هيد كوارتر': 'Mizan Headquarters',
    'الخدمات': 'Services',
    'كيف نعمل': 'How We Work',
    'محرك البحث الداخلي': 'Internal Search',
    'التجربة الصوتية': 'Voice Experience',
    '🎯 جولة تعريفية للزائر': '🎯 Product Tour',
    'دخول العملاء والمنشآت': 'Client & Organization Login',
    'اطلب مساعدك الصوتي': 'Get Your Voice Assistant',
    'شركة متخصصة في تطوير الذكاء الاصطناعي والحلول الذكية': 'AI Development & Smart Solutions Company',
    'نطوّر حلول ذكاء اصطناعي تحوّل الأفكار إلى منتجات عملية': 'We turn AI ideas into practical products',
    'نصمم ونطوّر أنظمة ذكاء اصطناعي مخصصة للشركات، من الوكلاء الذكيين والمساعدات الصوتية إلى الأتمتة والتطبيقات التي تفهم احتياجات العمل وتتكامل مع عملياته.': 'We design and build custom AI systems for businesses, from intelligent agents and voice assistants to automation and applications that understand and integrate with business operations.',
    'ابدأ الآن عبر بوابة المنشآت': 'Get Started in the Organization Portal',
    'جرّب مساعداً تجريبياً': 'Try a Demo Assistant',
    '🎯 جولة تعريفية في المنصة': '🎯 Take a Product Tour',
    'مكالمة مباشرة — كافة المجالات': 'Live Call — All Industries',
    'المساعد نشط': 'Assistant Online',
    'مواعيدكم والخدمات المتاحة بكرة إيه؟': 'What are your hours and available services tomorrow?',
    'بنستقبل حضرتك بكرة من تسعة الصبح لحد تسعة بالليل. تحب أحجزلك ميعاد أو أسجل طلبك؟': 'We are open tomorrow from 9 AM to 9 PM. Would you like to book an appointment or submit a request?',
    'لماذا Mizan HQ': 'Why Mizan HQ',
    'نحوّل فرص الذكاء الاصطناعي إلى حلول قابلة للاستخدام والقياس داخل المؤسسات والشركات.': 'We turn AI opportunities into practical, measurable solutions for organizations and businesses.',
    'وكلاء ذكاء اصطناعي': 'AI Agents',
    'وكلاء ذكيون يتفاعلون مع العملاء والموظفين، ويفهمون السياق وينفذون مهاماً ضمن حدود واضحة.': 'Intelligent agents that engage customers and employees, understand context, and perform tasks within clear boundaries.',
    'حلول وتطبيقات مخصصة': 'Custom Solutions & Applications',
    'نطوّر تطبيقات ذكاء اصطناعي تتكامل مع بيانات وأنظمة العمل وتُصمم وفق احتياجات كل شركة.': 'We build AI applications that integrate with business data and systems, tailored to each organization.',
    'أتمتة وذكاء تشغيلي': 'Automation & Operational Intelligence',
    'نحوّل المهام المتكررة وتدفقات العمل إلى عمليات أكثر كفاءة باستخدام الذكاء الاصطناعي.': 'We use AI to turn repetitive tasks and workflows into more efficient operations.',
    'من الفكرة إلى الحل الذكي': 'From Idea to Intelligent Solution',
    'من فهم الاحتياج إلى التطوير والاختبار والتحسين': 'From understanding requirements to development, testing, and improvement',
    'فهم الاحتياج': 'Understand the Need',
    'نحدد أهداف العمل والمشكلة المطلوب حلها': 'Define business goals and the problem to solve',
    'تصميم الحل': 'Design the Solution',
    'نختار النهج والنموذج والتكاملات المناسبة': 'Choose the right approach, model, and integrations',
    'التطوير والاختبار': 'Development & Testing',
    'نبني الحل ونختبره على حالات استخدام واقعية': 'Build and test the solution against real-world use cases',
    'الإطلاق والتحسين': 'Launch & Improve',
    'نطلق الحل ونتابع الأداء والتحسين': 'Launch the solution and continuously improve performance',
    'لديك فكرة لمشروع ذكاء اصطناعي؟': 'Have an AI Project in Mind?',
    'تواصل مع Mizan HQ لمناقشة احتياجاتك وتحويلها إلى حل ذكي قابل للتنفيذ.': 'Contact Mizan HQ to discuss your needs and turn them into an actionable intelligent solution.',
    'دخول البوابة والبدء': 'Open the Portal',
    '© ميزان هيد كوارتر — جميع الحقوق محفوظة': '© Mizan HQ — All Rights Reserved',
    'تسجيل دخول المنشأة': 'Organization Sign In',
    '🎯 جولة تعريفية': '🎯 Product Tour',
    'أدخل بيانات حسابك للوصول إلى سجل المكالمات والأسئلة الشائعة وإعدادات الصوت لمختلف المجالات.': 'Sign in to access your call history, FAQs, and voice settings.',
    'البريد الإلكتروني': 'Email Address',
    'كلمة المرور': 'Password',
    'تسجيل الدخول': 'Sign In',
    'نسيت كلمة المرور؟ تواصل مع فريق ميزان هيد كوارتر •': 'Forgot your password? Contact the Mizan HQ team •',
    'العودة للرئيسية': 'Back to Home',
    'بوابة العميل والمنشآت': 'Client & Organization Portal',
    'تابع مكالمات مساعدك الصوتي، وحدّث الأسئلة الشائعة، واضبط شخصية الصوت لمنشأتك من مكان واحد.': 'Track assistant calls, update FAQs, and configure your organization’s voice from one place.',
    'تم الحفظ بنجاح': 'Saved successfully',
    'SUPER ADMIN': 'SUPER ADMIN',
    'نظرة عامة': 'Overview',
    'المنشآت والعملاء': 'Organizations & Clients',
    'إنشاء مساعد لمنشأة': 'Create an Organization Assistant',
    'الهوية والضوابط القطاعية': 'Global Identity & Industry Guards',
    'بوابة المنشأة': 'Organization Portal',
    'معاينة بوابة العميل': 'Preview Client Portal',
    'لوحة المدير العام': 'Super Admin Dashboard',
    'إدارة المنشآت في كافة القطاعات والأعمال.': 'Manage organizations across all industries and business sectors.',
    'تبديل الحساب': 'Switch Account',
    '🎯 جولة تعريفية للمدير': '🎯 Admin Tour',
    'إضافة منشأة جديدة': 'Add Organization',
    'مدير النظام': 'System Administrator',
    'Super Admin': 'Super Admin',
    'إدارة المنشآت والشركات في مختلف المجالات والإحصائيات الشاملة للمنصة': 'Manage organizations and review platform-wide statistics',
    'المنشآت النشطة': 'Active Organizations',
    'إجمالي المكالمات': 'Total Calls',
    'نسبة الرد الآلي': 'Automation Rate',
    'متوسط الاستجابة': 'Average Response',
    'أحدث المكالمات عبر جميع المنشآت': 'Latest Calls Across Organizations',
    'مراقبة حية للمكالمات في مختلف القطاعات': 'Live call monitoring across industries',
    'التاريخ والوقت': 'Date & Time',
    'المنشأة': 'Organization',
    'الموضوع / القسم': 'Topic / Department',
    'النتيجة': 'Outcome',
    'المدة': 'Duration',
    'توزيع المكالمات حسب الباقة': 'Calls by Plan',
    'من إجمالي المكالمات هذا الشهر': 'Share of total calls this month',
    'باقة الإنتاج والربط الكامل (production_pbx)': 'Production & Full Integration (production_pbx)',
    'الباقة التجريبية (pilot_14d)': '14-Day Pilot (pilot_14d)',
    'نشط ويعمل بشكل طبيعي': 'Online and Operating Normally',
    'إدارة المنشآت والعملاء': 'Organizations & Clients',
    'كل منشأة أو شركة لها رابط مكالمة خاص (/c/slug) وإعدادات قطاع مستقلة': 'Each organization has its own call link (/c/slug) and industry settings',
    'إضافة منشأة': 'Add Organization',
    'قائمة المنشآت المشتركة': 'Organizations',
    'الشركات والمكاتب والمؤسسات في مختلف القطاعات': 'Companies and institutions across industries',
    'اسم المنشأة': 'Organization Name',
    'الرابط المخصص': 'Custom Link',
    'المجال / القطاع': 'Industry / Sector',
    'الباقة': 'Plan',
    'الحالة': 'Status',
    'الإجراء': 'Action',
    'إنشاء مساعد صوتي لمنشأة جديدة': 'Create a Voice Assistant',
    'إعداد فوري للمنشأة وتوليد رابط المكالمة المخصص خلال ثوانٍ': 'Set up an organization and generate its dedicated call link in seconds',
    'اسم المنشأة أو الشركة': 'Organization or Company Name',
    'المعرّف الفريد للرابط (Slug)': 'Unique Link Identifier (Slug)',
    'مجال نشاط المنشأة (Industry)': 'Organization Industry',
    'عام / شركات وأعمال': 'General / Business',
    'خدمة عملاء ومراكز اتصال': 'Customer Service & Contact Centers',
    'استشارات قانونية ومحاماة': 'Legal Consulting & Law',
    'تطوير عقاري ومبيعات': 'Real Estate & Sales',
    'خدمات مالية ومحاسبية': 'Financial & Accounting Services',
    'تعليم وتدريب': 'Education & Training',
    'تجزئة وتجارة إلكترونية': 'Retail & E-commerce',
    'ضيافة وسياحة': 'Hospitality & Tourism',
    'سيارات وخدمات صيانة': 'Automotive & Maintenance',
    'رعاية صحية ومراكز متخصصة': 'Healthcare & Specialty Clinics',
    'الـ System Prompt التأسيسي للمنشأة': 'Organization Base System Prompt',
    'إنشاء المنشأة وتفعيل الرابط': 'Create Organization & Activate Link',
    'الهوية العامة لميزان وضوابط الأمان القطاعية': 'Mizan Global Identity & Industry Safety Guards',
    'إعدادات الطبقة الأولى والثانية المقفولة (Global Identity & Industry Safety Guards)': 'Locked Layer 1 & 2 Settings (Global Identity & Industry Safety Guards)',
    'الهوية المصرية الموحدة لميزان (Global Voice Config)': 'Mizan Unified Egyptian Identity (Global Voice Config)',
    'تُحقن تلقائياً في بداية كل مكالمة لجميع المنشآت': 'Automatically applied at the start of every call for all organizations',
    'النص التأسيسي للهوية المصرية': 'Egyptian Identity Base Prompt',
    'حفظ الهوية العامة': 'Save Global Identity',
    'ضوابط الحماية حسب القطاع (Industry Guards)': 'Industry Safety Guards',
    'قواعد أمان إلزامية تمنع الوعود الخاطئة في كل مجال': 'Mandatory safeguards that prevent inaccurate promises in every industry',
    'محرك البحث الداخلي الشامل': 'Unified Internal Search',
    'واجهة فرونت إند مجهزة لربط محرك البحث الداخلي الخاص بك لاحقاً': 'Frontend prepared for your internal search integration',
    'Frontend Placeholder': 'Frontend Placeholder',
    'بحث داخلي': 'Search Internally',
    'منطقة نتائج محرك البحث الداخلي': 'Internal Search Results',
    'جاهزة للربط البرمجي بالباك إند المحلي الخاص بك في وقت لاحق.': 'Ready to connect to your local backend.',
    'MIZAN HQ': 'MIZAN HQ',
    'العملاء والطلبات': 'Clients & Requests',
    'المكالمات': 'Calls',
    'قاعدة المعرفة': 'Knowledge Base',
    'أداء المساعد': 'Assistant Performance',
    'التقارير': 'Reports',
    'الفواتير': 'Billing',
    'الإعدادات': 'Settings',
    'روابط ومشاركة': 'Links & Sharing',
    'أدوات إضافية': 'More Tools',
    'هل تحتاج إلى مساعدة؟': 'Need Help?',
    'فريق ميزان هيد كوارتر متاح لدعم منشأتك.': 'The Mizan HQ team is here to support your organization.',
    'تسجيل الخروج': 'Sign Out',
    '🎯 جولة تعريفية في البوابة': '🎯 Portal Tour',
    'مدير الحساب': 'Account Manager',
    'مرحباً بك': 'Welcome',
    'هنا نظرة عامة على أداء مساعدك الصوتي لمختلف خدمات منشأتك': 'Here is an overview of your voice assistant performance',
    'رابط المكالمة والمشاركة': 'Call Link & Sharing',
    'مقارنة بالشهر الماضي': 'Compared with last month',
    'الحجوزات والطلبات المؤكدة': 'Confirmed Bookings & Requests',
    'معدل رضا العملاء': 'Customer Satisfaction',
    'رحلة الحصول على المساعد الصوتي': 'Your Voice Assistant Journey',
    'من الطلب إلى التسليم خلال ثلاثة أيام عمل لأي قطاع أو نشاط تجاري': 'From request to delivery in three business days',
    'إرسال الطلب': 'Submit Request',
    'أرسل بريداً إلكترونياً أو رسالة واتساب لبدء الخدمة': 'Send an email or WhatsApp message to get started',
    'مقابلة المتطلبات': 'Requirements Meeting',
    'جلسة قصيرة لفهم عمليات منشأتك ومتطلباتك': 'A short session to understand your operations and requirements',
    'إعداد المساعد': 'Assistant Setup',
    'بناء قاعدة المعرفة وتخصيص المساعد وفق احتياجاتك': 'Build the knowledge base and tailor the assistant to your needs',
    'التسليم خلال 3 أيام': 'Delivery in 3 Days',
    'استلام مساعدك الصوتي الجاهز خلال ثلاثة أيام عمل': 'Receive your ready-to-use voice assistant within three business days',
    'حجم المكالمات الأسبوعي': 'Weekly Call Volume',
    'عدد المكالمات المستلمة خلال آخر 7 أيام': 'Calls received in the last 7 days',
    'متوسط المدة': 'Average Duration',
    'المكالمات المحلولة آلياً': 'AI-Resolved Calls',
    'وقت الاستجابة': 'Response Time',
    'السبت': 'Saturday', 'الأحد': 'Sunday', 'الاثنين': 'Monday',
    'الثلاثاء': 'Tuesday', 'الأربعاء': 'Wednesday', 'الخميس': 'Thursday', 'الجمعة': 'Friday',
    'الاستفسارات الأكثر تكراراً': 'Most Frequent Inquiries',
    'نسبة من إجمالي الاستفسارات': 'Share of All Inquiries',
    'مواعيد العمل': 'Business Hours',
    'حجز موعد أو طلب خدمة': 'Book an Appointment or Request a Service',
    'مواقع الفروع': 'Branch Locations',
    'الخدمات والباقات المتوفرة': 'Available Services & Plans',
    'سياسة الإلغاء أو التعديل': 'Cancellation & Modification Policy',
    'أحدث المكالمات': 'Latest Calls',
    'عرض الكل': 'View All',
    'موضوع المكالمة / المختص': 'Call Topic / Specialist',
    'عدد مقالات قاعدة المعرفة': 'Knowledge Base Articles',
    'متوسط سرعة الاستجابة': 'Average Response Speed',
    'نسبة جاهزية النظام': 'System Availability',
    'قائمة المتصلين والعملاء الذين طلبوا حجز موعد أو خدمة عبر المساعد الصوتي': 'Callers and customers who requested an appointment or service through the voice assistant',
    'تصدير بيانات العملاء': 'Export Client Data',
    'إجمالي العملاء المتفاعلين': 'Total Engaged Customers',
    'طلبات وحجوزات مؤكدة': 'Confirmed Requests & Bookings',
    'قيد المتابعة': 'In Progress',
    'حماية البيانات (AES-GCM)': 'Data Protection (AES-GCM)',
    'الكل': 'All',
    'حجز مؤكد': 'Confirmed Booking',
    'طلب تواصل': 'Contact Request',
    'التاريخ': 'Date',
    'الخدمة / القسم / المختص': 'Service / Department / Specialist',
    'الموعد المحدد': 'Scheduled Time',
    'حالة الطلب': 'Request Status',
    'سجل كامل لمكالمات مساعدك الصوتي وتفريغ المحادثات': 'Full history of voice assistant calls and transcripts',
    'تصدير السجل': 'Export History',
    'مكالمات مسجلة': 'Recorded Calls',
    'مكالمات فائتة': 'Missed Calls',
    'تم الرد': 'Answered',
    'مكالمة فائتة': 'Missed Call',
    'قيد المعالجة': 'Processing',
    'الموضوع / القسم': 'Topic / Department',
    'التفاصيل': 'Details',
    'تفاصيل المكالمة': 'Call Details',
    'ملخص المساعد': 'Assistant Summary',
    'العميل': 'Customer',
    'المساعد': 'Assistant',
    'الأسئلة الشائعة ومعلومات النشاط التي يعتمد عليها مساعدك': 'FAQs and business information used by your assistant',
    'إضافة بند معرفة': 'Add Knowledge Entry',
    'مقالات وبنود المعرفة': 'Knowledge Articles & Entries',
    'مفعّلة للرد الفوري': 'Enabled for Instant Answers',
    'تحديث ذاكرة الكاش (TTL)': 'Cache Refresh (TTL)',
    'نسبة الإجابة الصحيحة': 'Answer Accuracy',
    'المواعيد': 'Appointments',
    'الخدمات والأسعار': 'Services & Pricing',
    'الفروع': 'Branches',
    'السياسات': 'Policies',
    'تحرير بند المعرفة': 'Edit Knowledge Entry',
    'يستخدمه المساعد الصوتي مباشرة عند الإجابة عن المتصلين': 'Used directly by the voice assistant when answering callers',
    'التصنيف (Category)': 'Category',
    'المواعيد وساعات العمل (schedules)': 'Appointments & Business Hours (schedules)',
    'الخدمات والأسعار والباقات (pricing)': 'Services, Pricing & Plans (pricing)',
    'الفروع والعناوين (branches)': 'Branches & Addresses (branches)',
    'السياسات والتعاقد والإلغاء (policies)': 'Policies, Contracts & Cancellations (policies)',
    'الأقسام والمختصون (specialists)': 'Departments & Specialists (specialists)',
    'النص والمعلومات المعتمدة (FAQ Text)': 'Approved Text & Information (FAQ Text)',
    'حفظ التغييرات': 'Save Changes',
    'أداء المساعد وضوابط الأمان': 'Assistant Performance & Safety',
    'مؤشرات سرعة الاستجابة الصوتية والالتزام بضوابط القطاع وقانون حماية البيانات': 'Voice response metrics, industry safeguards, and data protection compliance',
    'النظام متوافق مع قانون 151 لسنة 2020': 'System aligned with Data Protection Law 151/2020',
    'متوسط زمن الاستجابة': 'Average Response Time',
    'دقة التعرف الصوتي (Flux STT)': 'Speech Recognition Accuracy (Flux STT)',
    'تعمية أرقام الهواتف (PII)': 'Phone Number Masking (PII)',
    'جاهزية الخدمة (Uptime)': 'Service Uptime',
    'طبقات بناء البرومبت والأمان (4-Layer Architecture)': 'Prompt & Safety Layers (4-Layer Architecture)',
    'كيف يضمن ميزان دقة وأمان كل مكالمة في قطاعك': 'How Mizan ensures accuracy and safety in every call',
    '1. الهوية المصرية العامة لميزان (Global Identity)': '1. Mizan Global Egyptian Identity',
    'مفعّل وثابت': 'Enabled & Fixed',
    '2. ضوابط الأمان القطاعية (Industry Safety Guard)': '2. Industry Safety Guard',
    'مفعّل تلقائياً': 'Automatically Enabled',
    '3. التخصيص الإضافي للمنشأة (Tenant Customization)': '3. Organization Customization',
    'قابل للتعديل': 'Customizable',
    '4. قاعدة المعرفة الفورية (Live FAQ Context)': '4. Live Knowledge Base Context',
    'تحديث خلال 30 ث': 'Updated within 30 sec',
    'مؤشرات الجودة الصوتية': 'Voice Quality Metrics',
    'الأداء المباشر على شبكة Cloudflare Edge': 'Live performance on Cloudflare Edge',
    'سرعة تحويل الصوت إلى نص (Workers AI Flux)': 'Speech-to-Text Speed (Workers AI Flux)',
    'الالتزام بقاعدة معرفة المنشأة': 'Organization Knowledge Compliance',
    'رضا المتصلين عن اللهجة المصرية': 'Caller Satisfaction with Egyptian Arabic',
    'التقارير التنفيذية': 'Executive Reports',
    'تحليل شامل للمكالمات والطلبات مع إمكانية التصدير بصيغة CSV': 'Analyze calls and requests, with CSV export',
    'تنزيل التقرير (CSV)': 'Download Report (CSV)',
    'توزيع المكالمات حسب النتيجة': 'Calls by Outcome',
    'ملخص نتائج الاتصالات المسجلة': 'Summary of recorded call outcomes',
    'مكالمات مكتملة وتم الرد عليها آلياً': 'Calls completed and answered automatically',
    'مكالمات انتهت بحجز أو طلب مؤكد': 'Calls resulting in a confirmed booking or request',
    'مكالمات تم تحويلها للمختص البشري': 'Calls transferred to a human specialist',
    'توزيع الاتصالات على مدار اليوم': 'Calls Throughout the Day',
    'نسبة الاتصالات المستلمة في أوقات الذروة وخارج أوقات العمل': 'Calls received during peak and after-hours periods',
    'ساعات العمل الصباحية (9 ص - 2 ظ)': 'Morning Business Hours (9 AM – 2 PM)',
    'ساعات العمل المسائية (2 ظ - 9 م)': 'Evening Business Hours (2 PM – 9 PM)',
    'خارج ساعات العمل الرسمية (تغطية آلية 24/7)': 'Outside Business Hours (24/7 AI Coverage)',
    'الفواتير وخطة الاشتراك': 'Billing & Subscription',
    'إدارة باقة منشأتك ومتابعة حالة الاشتراك والترقية': 'Manage your plan, subscription status, and upgrades',
    'الاشتراك نشط': 'Subscription Active',
    'الباقة التجريبية (Pilot 14-Day)': '14-Day Pilot Plan',
    '14 يوماً': '14 Days',
    'باقة التحقق': 'Pilot Plan',
    'رابط مكالمة ويب مباشر وقاعدة معرفة مخصصة لمنشأتك': 'Direct web call link and a dedicated knowledge base',
    'رابط اتصال مباشر (/c/slug)': 'Direct Call Link (/c/slug)',
    'لوحة تحكم وتقارير كاملة': 'Full Dashboard & Reports',
    'باقة النمو والأعمال (Growth)': 'Growth Business Plan',
    'الأكثر طلباً للمنشآت': 'Most Popular',
    'ج.م / شهر': 'EGP / month',
    'مناسبة للشركات والمكاتب الاستشارية والمراكز الخدمية': 'For businesses, consulting offices, and service centers',
    '1,000 دقيقة مكالمات شهرياً': '1,000 call minutes per month',
    'تحديث فوري لقاعدة المعرفة': 'Instant Knowledge Base Updates',
    'الباقة المؤسسية والربط الكامل (PBX)': 'Enterprise & Full Integration (PBX)',
    'مؤسسي': 'Enterprise',
    'ربط كامل مع سنترال المنشأة (SIP/PBX) ونطاق مخصص': 'Full PBX/SIP integration and a custom domain',
    'جلسات متزامنة متعددة': 'Multiple Concurrent Sessions',
    'مفاتيح API وربط CRM مباشر': 'API Keys & Direct CRM Integration',
    'إعدادات الصوت': 'Voice Settings',
    'خصّص صوت المساعد وشخصيته وتعليمات منشأتك الإضافية': 'Customize your assistant’s voice, personality, and organization instructions',
    'اختيار الصوت': 'Voice Selection',
    'اختر الصوت الذي يمثل منشأتك في مختلف المجالات': 'Choose the voice that represents your organization',
    'صوت هادئ': 'Calm Voice',
    'المحدد': 'Selected',
    'مصري هادي ومطمئن': 'Calm, reassuring Egyptian voice',
    'استماع': 'Preview',
    'صوت ودود': 'Friendly Voice',
    'مصري ودود وقريب': 'Friendly, approachable Egyptian voice',
    'صوت واثق': 'Confident Voice',
    'مصري واثق ومباشر': 'Confident, direct Egyptian voice',
    'الشخصية والأسلوب': 'Personality & Style',
    'اضبط طريقة حديث المساعد مع عملائك': 'Set how your assistant speaks with customers',
    'درجة الرسمية': 'Formality',
    'رسمي ومهني': 'Formal & Professional',
    'سرعة الكلام': 'Speaking Speed',
    'متوسطة': 'Normal',
    'مستوى الإيجاز': 'Response Length',
    'مختصر': 'Concise',
    'اللهجة': 'Dialect',
    'اللهجة المصرية (القاهرية)': 'Egyptian Arabic (Cairo)',
    'اللهجة المصرية (الإسكندرانية)': 'Egyptian Arabic (Alexandria)',
    'العربية الفصحى المبسطة': 'Modern Standard Arabic',
    'التعليمات الإضافية ورسالة الترحيب': 'Additional Instructions & Welcome Message',
    'تُضاف إلى هوية ميزان الأساسية لتخصيص سلوك المساعد لمنشأتك': 'Added to Mizan’s core identity to customize your assistant',
    'تعليمات خاصة بالمنشأة (tenant_customization)': 'Organization Instructions (tenant_customization)',
    'رقم التحويل المباشر / الطوارئ (escalation_phone)': 'Direct Transfer / Emergency Number (escalation_phone)',
    'معاينة مباشرة': 'Live Preview',
    'استمع للتغييرات قبل الحفظ': 'Listen to changes before saving',
    'حفظ إعدادات الصوت والتخصيص': 'Save Voice & Customization Settings',
    'روابط الاتصال والمشاركة': 'Call Links & Sharing',
    'شارك رابط مساعدك الصوتي مع عملائك أو أضف زر الاتصال العائم في موقعك': 'Share your voice assistant link or add a floating call button to your website',
    'رابط الاتصال المباشر لمنشأتك': 'Your Organization’s Direct Call Link',
    'ضع هذا الرابط في موقعك أو إعلاناتك — يفتح صفحة المكالمة الصوتية مباشرة': 'Add this link to your website or ads to open the voice call page',
    'نسخ الرابط': 'Copy Link',
    'زر اتصال عائم لموقعك الإلكتروني (Embed Widget)': 'Floating Call Button (Embed Widget)',
    'أضف هذا الكود قبل وسم </body> في موقعك لظهور زر الاتصال الصوتي': 'Add this code before </body> on your website to display the voice call button',
    'نسخ الكود': 'Copy Code',
    'معاينة الزر العائم': 'Preview Floating Button',
    'مشاركة سريعة عبر المنصات': 'Quick Social Sharing',
    'اضغط لمشاركة رابط المساعد الصوتي مع عملائك': 'Share your voice assistant link with customers',
    'رمز الاستجابة السريعة (QR Code)': 'QR Code',
    'اطبعه وضعه في مقر منشأتك ليفتح العميل صفحة المكالمة بمجرد المسح': 'Print and display it at your location so customers can scan to call',
    'جاهز لربط الباك إند (Frontend Ready)': 'Ready for Backend Integration',
    'جميع المصادر الداخلية': 'All Internal Sources',
    'المستندات والملفات': 'Documents & Files',
    'سجلات المكالمات': 'Call Records',
    'ملفات العملاء': 'Customer Files',
    'تطابق تام': 'Exact Match',
    'بحث دلالي داخلي': 'Internal Semantic Search',
    'الأحدث أولاً': 'Newest First',
    'مساحة عرض نتائج محرك البحث الداخلي': 'Internal Search Results',
    'محرك البحث الداخلي المخصص (Frontend Shell)': 'Custom Internal Search (Frontend Shell)',
    'العودة للوحة التحكم': 'Back to Dashboard',
    'صفحة فرونت إند مجهزة بالكامل لربط الباك إند الخاص بك لاحقاً (بدون بحث على الإنترنت الخارجي)': 'Frontend ready for your backend integration (no external web search)',
    'جاهز للربط البرمجي': 'Ready for Integration',
    'المستندات والعقود': 'Documents & Contracts',
    'قاعدة المعرفة': 'Knowledge Base',
    'بحث': 'Search',
    'تطابق نصي': 'Text Match',
    'بحث دلالي (Vector/RAG)': 'Semantic Search (Vector/RAG)',
    'اربط الباك إند الخاص بك في الدالة runStandaloneSearch() لعرض نتائج البحث الداخلي في هذه الحاوية.': 'Connect your backend in runStandaloneSearch() to display internal search results here.',
    'محرك البحث الداخلي المخصص': 'Custom Internal Search',
    'INTERNAL SEARCH': 'INTERNAL SEARCH',
    'المساعد الصوتي المباشر': 'Live Voice Assistant',
    'المساعد جاهز يرد على حضرتك': 'Your assistant is ready',
    'متصل وجاهز': 'Connected and ready',
    'ابدأ المكالمة': 'Start call',
    'دوس عشان تتكلم مع المساعد': 'Tap to talk to the assistant',
    'كتم': 'Mute',
    'مكتوم': 'Muted',
    'اسأل عن مواعيد العمل، أو الخدمات المتاحة، أو احجز ميعاد، أو اعرف مكان الفروع.': 'Ask about business hours or available services, book an appointment, or find a branch.',
    'بدعم من': 'Powered by',
    'يرجى السماح باستخدام الميكروفون...': 'Please allow microphone access...',
    'جاري الاتصال بالمساعد...': 'Connecting to your assistant...',
    'متصل — تحدث الآن': 'Connected — speak now',
    'انتهت المكالمة — جاهز لاتصال جديد': 'Call ended — ready for another call',
    'خطأ في الاتصال': 'Connection error',
    'حدث خطأ في المساعد الصوتي': 'A voice assistant error occurred',
    'لم يتم السماح باستخدام الميكروفون': 'Microphone access was denied',
    'المتصل': 'Caller',
    'المساعد': 'Assistant',
    'المساعد بيتكلم...': 'Assistant is speaking...',
    'وصل الرد النصي لكن تعذر تشغيل الصوت. راجع إعدادات الصوت أو أعد المحاولة.': 'The text response arrived, but audio playback failed. Check your audio settings or try again.',
    'تغيير اللغة إلى العربية': 'Switch language to Arabic'
  };

  const placeholders = {
    'ابحث عن منشأة أو افتح محرك البحث الداخلي...': 'Search organizations or open internal search...',
    'ادخل كلمات البحث الداخلي...': 'Enter your internal search terms...',
    'اسم المنشأة أو الشركة': 'Organization or company name',
    'البريد الإلكتروني': 'Email address',
    'كلمة المرور': 'Password',
    'name@organization.com': 'name@organization.com'
  };

  let currentLanguage = 'ar';
  const translatedNodes = new WeakMap();

  function safeGetLanguage() {
    try { return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'ar'; }
    catch (_) { return 'ar'; }
  }

  function translateNode(node, language) {
    const current = node.nodeValue;
    const previous = translatedNodes.get(node);
    let original = previous ? previous.original : current;
    if (previous && current !== previous.translated) original = current;
    const key = original.trim();
    if (!key) return;
    const translated = language === 'en' ? (translations[key] || key) : key;
    const leading = original.match(/^\s*/)?.[0] || '';
    const trailing = original.match(/\s*$/)?.[0] || '';
    const next = leading + translated + trailing;
    if (node.nodeValue !== next) {
      translatedNodes.set(node, { original, translated: next });
      node.nodeValue = next;
    } else {
      translatedNodes.set(node, { original, translated: next });
    }
  }

  function translateElement(root, language) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => translateNode(node, language));

    const elements = root.querySelectorAll ? root.querySelectorAll('input,textarea,option,[aria-label],[title]') : [];
    elements.forEach(el => {
      ['placeholder', 'aria-label', 'title'].forEach(attr => {
        if (!el.hasAttribute(attr)) return;
        const original = el.getAttribute('data-mz-original-' + attr) ?? el.getAttribute(attr);
        if (!el.hasAttribute('data-mz-original-' + attr)) el.setAttribute('data-mz-original-' + attr, original);
        const value = language === 'en' ? (placeholders[original] || translations[original] || original) : original;
        if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
      });
    });
  }

  function applyLanguage(language) {
    currentLanguage = language === 'en' ? 'en' : 'ar';
    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = currentLanguage === 'ar' ? 'rtl' : 'ltr';
    const arabicTitle = document.documentElement.dataset.mzArabicTitle || document.title;
    document.title = currentLanguage === 'en'
      ? (translations[arabicTitle] || arabicTitle.replace(' — المساعد الصوتي المباشر', ' — Live Voice Assistant'))
      : arabicTitle;
    translateElement(document.body, currentLanguage);
    const toggle = document.getElementById('mz-language-toggle');
    if (toggle) {
      toggle.textContent = currentLanguage === 'ar' ? 'English' : 'العربية';
      toggle.setAttribute('aria-label', currentLanguage === 'ar' ? 'Switch language to English' : 'تغيير اللغة إلى العربية');
      toggle.setAttribute('aria-pressed', currentLanguage === 'en' ? 'true' : 'false');
    }
    try { localStorage.setItem(STORAGE_KEY, currentLanguage); } catch (_) {}
  }

  function mountToggle() {
    if (document.getElementById('mz-language-toggle')) return;
    const button = document.createElement('button');
    button.id = 'mz-language-toggle';
    button.className = 'mz-language-toggle';
    button.type = 'button';
    button.addEventListener('click', () => applyLanguage(currentLanguage === 'ar' ? 'en' : 'ar'));
    const host = document.querySelector('header.tb, header.nav, .fm > div, .top-row') || document.body;
    host.insertBefore(button, host.firstChild);
    applyLanguage(currentLanguage);
  }

  function init() {
    const title = document.title;
    document.documentElement.dataset.mzArabicTitle = title;
    currentLanguage = safeGetLanguage();
    mountToggle();
    const observer = new MutationObserver(records => {
      observer.disconnect();
      records.forEach(record => {
        if (record.type === 'characterData') translateNode(record.target, currentLanguage);
        record.addedNodes && record.addedNodes.forEach(node => {
          if (node.nodeType === Node.TEXT_NODE) translateNode(node, currentLanguage);
          else if (node.nodeType === Node.ELEMENT_NODE) translateElement(node, currentLanguage);
        });
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();