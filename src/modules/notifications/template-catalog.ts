/**
 * Default notification texts (English + Arabic). Seeded once per (code, channel, locale) as version 1 and
 * never overwritten: changes are published as new versions through the API. A future locale = more entries.
 * Every placeholder must come from TEMPLATE_VARIABLES (unit tested).
 */
export interface LocalText {
  title: string;
  body: string;
}
export interface CatalogEntry {
  code: string;
  audience: 'STAFF' | 'CUSTOMER';
  en: LocalText;
  ar: LocalText;
}

export const TEMPLATE_LOCALES = ['en', 'ar'] as const;

export const TEMPLATE_CATALOG: CatalogEntry[] = [
  // ── staff ──
  {
    code: 'SAMPLE_SUBMITTED',
    audience: 'STAFF',
    en: {
      title: 'Sample {{sampleNumber}} submitted',
      body: 'Sample {{sampleNumber}} for {{brandName}} was submitted and is ready for review.',
    },
    ar: {
      title: 'تم تقديم العينة {{sampleNumber}}',
      body: 'تم تقديم العينة {{sampleNumber}} الخاصة بالعلامة {{brandName}} وهي جاهزة للمراجعة.',
    },
  },
  {
    code: 'SAMPLE_CHANGES_REQUESTED_STAFF',
    audience: 'STAFF',
    en: {
      title: 'Changes requested on sample {{sampleNumber}}',
      body: 'The customer asked for changes on sample {{sampleNumber}} ({{brandName}}): {{reason}}',
    },
    ar: {
      title: 'طلب تعديلات على العينة {{sampleNumber}}',
      body: 'طلب العميل تعديلات على العينة {{sampleNumber}} ({{brandName}}): {{reason}}',
    },
  },
  {
    code: 'ORDER_SUBMITTED',
    audience: 'STAFF',
    en: {
      title: 'Order {{orderNumber}} submitted',
      body: 'Order {{orderNumber}} for {{brandName}} was submitted and is waiting for confirmation.',
    },
    ar: {
      title: 'تم تقديم الطلب {{orderNumber}}',
      body: 'تم تقديم الطلب {{orderNumber}} الخاص بالعلامة {{brandName}} وهو بانتظار التأكيد.',
    },
  },
  {
    code: 'SAMPLE_READY_FOR_APPROVAL_STAFF',
    audience: 'STAFF',
    en: {
      title: 'Sample {{sampleNumber}} ready for approval',
      body: "The physical sample {{sampleNumber}} ({{brandName}}) is finished and waiting for the customer's approval.",
    },
    ar: {
      title: 'العينة {{sampleNumber}} جاهزة للاعتماد',
      body: 'العينة {{sampleNumber}} ({{brandName}}) جاهزة وفي انتظار اعتماد العميل.',
    },
  },
  {
    code: 'SAMPLE_APPROVED',
    audience: 'STAFF',
    en: {
      title: 'Sample {{sampleNumber}} approved',
      body: 'The customer approved sample {{sampleNumber}} ({{brandName}}). It can now be used for bulk orders.',
    },
    ar: {
      title: 'تم اعتماد العينة {{sampleNumber}}',
      body: 'اعتمد العميل العينة {{sampleNumber}} ({{brandName}}) ويمكن الآن استخدامها في أوامر الإنتاج.',
    },
  },
  {
    code: 'QUOTATION_ACCEPTED',
    audience: 'STAFF',
    en: {
      title: 'Quotation {{quotationNumber}} accepted',
      body: 'Quotation {{quotationNumber}} for {{brandName}} was accepted.',
    },
    ar: {
      title: 'تم قبول عرض السعر {{quotationNumber}}',
      body: 'تم قبول عرض السعر {{quotationNumber}} الخاص بالعلامة {{brandName}}.',
    },
  },
  {
    code: 'PAYMENT_SUBMITTED',
    audience: 'STAFF',
    en: {
      title: 'Payment waiting for verification',
      body: 'A payment for {{brandName}} ({{orderNumber}}{{sampleNumber}}) was recorded and needs verification.',
    },
    ar: {
      title: 'دفعة بانتظار التحقق',
      body: 'تم تسجيل دفعة للعلامة {{brandName}} ({{orderNumber}}{{sampleNumber}}) وتحتاج إلى التحقق.',
    },
  },
  {
    code: 'PAYMENT_VERIFIED_STAFF',
    audience: 'STAFF',
    en: {
      title: 'Payment verified',
      body: 'A payment for {{brandName}} ({{orderNumber}}{{sampleNumber}}) was verified.',
    },
    ar: {
      title: 'تم التحقق من الدفعة',
      body: 'تم التحقق من دفعة للعلامة {{brandName}} ({{orderNumber}}{{sampleNumber}}).',
    },
  },
  {
    code: 'ORDER_CONFIRMED_STAFF',
    audience: 'STAFF',
    en: {
      title: 'Order {{orderNumber}} confirmed',
      body: 'Order {{orderNumber}} for {{brandName}} was confirmed. Target date: {{targetDate}}.',
    },
    ar: {
      title: 'تم تأكيد الطلب {{orderNumber}}',
      body: 'تم تأكيد الطلب {{orderNumber}} للعلامة {{brandName}}. الموعد المستهدف: {{targetDate}}.',
    },
  },
  {
    code: 'COMMERCIAL_REAPPROVAL_REQUIRED',
    audience: 'STAFF',
    en: {
      title: 'Order {{orderNumber}} needs a new quotation',
      body: 'A revision changed the commercial terms of {{orderNumber}} ({{brandName}}). A new quotation must be accepted before production.',
    },
    ar: {
      title: 'الطلب {{orderNumber}} يحتاج عرض سعر جديد',
      body: 'غيّر التعديل الشروط التجارية للطلب {{orderNumber}} ({{brandName}}). يجب قبول عرض سعر جديد قبل الإنتاج.',
    },
  },
  {
    code: 'ORDER_READY_FOR_PRODUCTION',
    audience: 'STAFF',
    en: {
      title: 'Order {{orderNumber}} ready for production',
      body: 'Order {{orderNumber}} ({{brandName}}) was released; create its factory job. Target date: {{targetDate}}.',
    },
    ar: {
      title: 'الطلب {{orderNumber}} جاهز للإنتاج',
      body: 'تم الإفراج عن الطلب {{orderNumber}} ({{brandName}}). أنشئ أمر التشغيل الخاص به. الموعد المستهدف: {{targetDate}}.',
    },
  },
  {
    code: 'JOB_STARTED',
    audience: 'STAFF',
    en: {
      title: 'Job {{jobNumber}} started',
      body: 'Production of {{productName}} ({{jobNumber}}) has started.',
    },
    ar: {
      title: 'بدأ أمر التشغيل {{jobNumber}}',
      body: 'بدأ إنتاج {{productName}} ({{jobNumber}}).',
    },
  },
  {
    code: 'STAGE_ASSIGNED',
    audience: 'STAFF',
    en: {
      title: 'New task: {{stageName}}',
      body: 'You were assigned {{stageName}} on job {{jobNumber}} ({{productName}}).',
    },
    ar: {
      title: 'مهمة جديدة: {{stageName}}',
      body: 'تم إسناد {{stageName}} إليك في أمر التشغيل {{jobNumber}} ({{productName}}).',
    },
  },
  {
    code: 'STAGE_BLOCKED',
    audience: 'STAFF',
    en: {
      title: '{{stageName}} blocked on {{jobNumber}}',
      body: '{{stageName}} on job {{jobNumber}} is blocked: {{reason}}',
    },
    ar: {
      title: 'تم إيقاف {{stageName}} في {{jobNumber}}',
      body: 'تم إيقاف {{stageName}} في أمر التشغيل {{jobNumber}}: {{reason}}',
    },
  },
  {
    code: 'STAGE_DELAYED',
    audience: 'STAFF',
    en: { title: '{{alertTitle}}', body: '{{alertReason}} ({{severity}})' },
    ar: { title: '{{alertTitle}}', body: '{{alertReason}} ({{severity}})' },
  },
  {
    code: 'QC_FAILED',
    audience: 'STAFF',
    en: {
      title: 'QC failed on {{jobNumber}}',
      body: '{{stageName}} failed quality control on job {{jobNumber}} ({{productName}}). Rework was created.',
    },
    ar: {
      title: 'فشل فحص الجودة في {{jobNumber}}',
      body: 'فشلت مرحلة {{stageName}} في فحص الجودة لأمر التشغيل {{jobNumber}} ({{productName}}). تم إنشاء إعادة تصنيع.',
    },
  },
  {
    code: 'REWORK_CREATED',
    audience: 'STAFF',
    en: {
      title: 'Rework on {{jobNumber}}',
      body: 'Work on job {{jobNumber}} ({{productName}}) was sent back for rework.',
    },
    ar: {
      title: 'إعادة تصنيع في {{jobNumber}}',
      body: 'تمت إعادة جزء من أمر التشغيل {{jobNumber}} ({{productName}}) لإعادة التصنيع.',
    },
  },
  {
    code: 'JOB_COMPLETED',
    audience: 'STAFF',
    en: {
      title: 'Job {{jobNumber}} completed',
      body: 'Job {{jobNumber}} ({{productName}}) is complete.',
    },
    ar: {
      title: 'اكتمل أمر التشغيل {{jobNumber}}',
      body: 'اكتمل أمر التشغيل {{jobNumber}} ({{productName}}).',
    },
  },
  {
    code: 'ORDER_PRODUCTION_COMPLETED',
    audience: 'STAFF',
    en: {
      title: 'Production of {{orderNumber}} complete',
      body: 'All units of order {{orderNumber}} ({{brandName}}) are produced.',
    },
    ar: {
      title: 'اكتمل إنتاج الطلب {{orderNumber}}',
      body: 'تم إنتاج جميع وحدات الطلب {{orderNumber}} ({{brandName}}).',
    },
  },
  {
    code: 'ORDER_READY_FOR_DELIVERY_STAFF',
    audience: 'STAFF',
    en: {
      title: 'Order {{orderNumber}} ready for delivery',
      body: 'Order {{orderNumber}} ({{brandName}}) is packed and ready for delivery.',
    },
    ar: {
      title: 'الطلب {{orderNumber}} جاهز للتسليم',
      body: 'تم تعبئة الطلب {{orderNumber}} ({{brandName}}) وهو جاهز للتسليم.',
    },
  },
  {
    code: 'SHIPMENT_DISPATCHED_STAFF',
    audience: 'STAFF',
    en: {
      title: 'Shipment {{shipmentNumber}} dispatched',
      body: 'Shipment {{shipmentNumber}} of order {{orderNumber}} left the factory.',
    },
    ar: {
      title: 'تم شحن {{shipmentNumber}}',
      body: 'غادرت الشحنة {{shipmentNumber}} الخاصة بالطلب {{orderNumber}} المصنع.',
    },
  },
  {
    code: 'SHIPMENT_FAILED',
    audience: 'STAFF',
    en: {
      title: 'Delivery failed: {{shipmentNumber}}',
      body: 'Delivery of {{shipmentNumber}} (order {{orderNumber}}) failed: {{reason}}',
    },
    ar: {
      title: 'فشل التسليم: {{shipmentNumber}}',
      body: 'فشل تسليم الشحنة {{shipmentNumber}} (الطلب {{orderNumber}}): {{reason}}',
    },
  },
  {
    code: 'ORDER_DELIVERED_STAFF',
    audience: 'STAFF',
    en: {
      title: 'Order {{orderNumber}} delivered',
      body: 'Every unit of order {{orderNumber}} ({{brandName}}) was delivered.',
    },
    ar: {
      title: 'تم تسليم الطلب {{orderNumber}}',
      body: 'تم تسليم جميع وحدات الطلب {{orderNumber}} ({{brandName}}).',
    },
  },
  {
    code: 'ALERT_OPENED',
    audience: 'STAFF',
    en: { title: '{{alertTitle}}', body: '{{alertReason}} ({{severity}})' },
    ar: { title: '{{alertTitle}}', body: '{{alertReason}} ({{severity}})' },
  },
  {
    code: 'ALERT_SEVERITY_INCREASED',
    audience: 'STAFF',
    en: {
      title: 'Escalated to {{severity}}: {{alertTitle}}',
      body: '{{alertReason}}',
    },
    ar: {
      title: 'ارتفعت الخطورة إلى {{severity}}: {{alertTitle}}',
      body: '{{alertReason}}',
    },
  },
  {
    code: 'ALERT_ESCALATED',
    audience: 'STAFF',
    en: {
      title: 'Escalation level {{escalationLevel}}: {{alertTitle}}',
      body: '{{alertReason}} Still unresolved ({{severity}}).',
    },
    ar: {
      title: 'تصعيد المستوى {{escalationLevel}}: {{alertTitle}}',
      body: '{{alertReason}} لم تُحل بعد ({{severity}}).',
    },
  },
  // ── customers (transactional, customer-safe) ──
  {
    code: 'QUOTATION_READY',
    audience: 'CUSTOMER',
    en: {
      title: 'Your quotation {{quotationNumber}} is ready',
      body: 'Hello {{customerName}}, the quotation {{quotationNumber}} for {{brandName}} is ready. Please let us know your decision.',
    },
    ar: {
      title: 'عرض السعر {{quotationNumber}} جاهز',
      body: 'مرحبًا {{customerName}}، عرض السعر {{quotationNumber}} الخاص بالعلامة {{brandName}} جاهز. نرجو إبلاغنا بقرارك.',
    },
  },
  {
    code: 'SAMPLE_READY_FOR_APPROVAL',
    audience: 'CUSTOMER',
    en: {
      title: 'Your sample {{sampleNumber}} is ready for approval',
      body: 'Hello {{customerName}}, your sample {{sampleNumber}} for {{brandName}} is ready. Please review and approve it.',
    },
    ar: {
      title: 'عينتك {{sampleNumber}} جاهزة للاعتماد',
      body: 'مرحبًا {{customerName}}، عينتك {{sampleNumber}} الخاصة بالعلامة {{brandName}} جاهزة. نرجو المراجعة والاعتماد.',
    },
  },
  {
    code: 'PAYMENT_VERIFIED',
    audience: 'CUSTOMER',
    en: {
      title: 'Payment received',
      body: 'Hello {{customerName}}, we received and verified your payment for {{brandName}}. Thank you.',
    },
    ar: {
      title: 'تم استلام الدفعة',
      body: 'مرحبًا {{customerName}}، تم استلام دفعتك للعلامة {{brandName}} والتحقق منها. شكرًا لك.',
    },
  },
  {
    code: 'PAYMENT_REJECTED',
    audience: 'CUSTOMER',
    en: {
      title: 'We could not verify your payment',
      body: 'Hello {{customerName}}, we could not verify your payment for {{brandName}}. {{reason}} Please submit a new payment proof from your portal.',
    },
    ar: {
      title: 'تعذّر التحقق من دفعتك',
      body: 'مرحبًا {{customerName}}، تعذّر التحقق من دفعتك للعلامة {{brandName}}. {{reason}} نرجو إرسال إثبات دفع جديد من بوابتك.',
    },
  },
  {
    code: 'SAMPLE_APPROVED_CUSTOMER',
    audience: 'CUSTOMER',
    en: {
      title: 'Sample {{sampleNumber}} approved',
      body: 'Hello {{customerName}}, thank you for approving your sample {{sampleNumber}} for {{brandName}}. It is now the reference for production.',
    },
    ar: {
      title: 'تم اعتماد العينة {{sampleNumber}}',
      body: 'مرحبًا {{customerName}}، شكرًا لاعتمادك العينة {{sampleNumber}} الخاصة بالعلامة {{brandName}}. أصبحت الآن المرجع للإنتاج.',
    },
  },
  {
    code: 'SAMPLE_CHANGES_REQUESTED_CUSTOMER',
    audience: 'CUSTOMER',
    en: {
      title: 'We received your requested changes',
      body: 'Hello {{customerName}}, we received your requested changes for sample {{sampleNumber}} ({{brandName}}). Our team will review them and update your sample.',
    },
    ar: {
      title: 'استلمنا التعديلات المطلوبة',
      body: 'مرحبًا {{customerName}}، استلمنا التعديلات المطلوبة على العينة {{sampleNumber}} ({{brandName}}). سيراجعها فريقنا ويحدّث عينتك.',
    },
  },
  {
    code: 'ORDER_READY_FOR_PRODUCTION_CUSTOMER',
    audience: 'CUSTOMER',
    en: {
      title: 'Order {{orderNumber}} is ready for production',
      body: 'Hello {{customerName}}, your order {{orderNumber}} for {{brandName}} is ready for production. Target date: {{targetDate}}.',
    },
    ar: {
      title: 'الطلب {{orderNumber}} جاهز للإنتاج',
      body: 'مرحبًا {{customerName}}، طلبك {{orderNumber}} للعلامة {{brandName}} جاهز للإنتاج. الموعد المستهدف: {{targetDate}}.',
    },
  },
  {
    code: 'ORDER_PRODUCTION_COMPLETED_CUSTOMER',
    audience: 'CUSTOMER',
    en: {
      title: 'Production of order {{orderNumber}} is complete',
      body: 'Hello {{customerName}}, production of your order {{orderNumber}} for {{brandName}} is complete. We are preparing it for delivery.',
    },
    ar: {
      title: 'اكتمل إنتاج الطلب {{orderNumber}}',
      body: 'مرحبًا {{customerName}}، اكتمل إنتاج طلبك {{orderNumber}} للعلامة {{brandName}}. نقوم بتجهيزه للتسليم.',
    },
  },
  {
    code: 'ORDER_CONFIRMED',
    audience: 'CUSTOMER',
    en: {
      title: 'Order {{orderNumber}} confirmed',
      body: 'Hello {{customerName}}, your order {{orderNumber}} for {{brandName}} is confirmed. Target date: {{targetDate}}.',
    },
    ar: {
      title: 'تم تأكيد الطلب {{orderNumber}}',
      body: 'مرحبًا {{customerName}}، تم تأكيد طلبك {{orderNumber}} للعلامة {{brandName}}. الموعد المستهدف: {{targetDate}}.',
    },
  },
  {
    code: 'PRODUCTION_MILESTONE',
    audience: 'CUSTOMER',
    en: {
      title: 'Order {{orderNumber}}: {{milestone}}',
      body: 'Hello {{customerName}}, an update on order {{orderNumber}}: {{milestone}}.',
    },
    ar: {
      title: 'الطلب {{orderNumber}}: {{milestone}}',
      body: 'مرحبًا {{customerName}}، تحديث بشأن الطلب {{orderNumber}}: {{milestone}}.',
    },
  },
  {
    code: 'ORDER_READY_FOR_DELIVERY',
    audience: 'CUSTOMER',
    en: {
      title: 'Order {{orderNumber}} is ready for delivery',
      body: 'Hello {{customerName}}, your order {{orderNumber}} is packed and ready for delivery.',
    },
    ar: {
      title: 'طلبك {{orderNumber}} جاهز للتسليم',
      body: 'مرحبًا {{customerName}}، تم تعبئة طلبك {{orderNumber}} وهو جاهز للتسليم.',
    },
  },
  {
    code: 'SHIPMENT_DISPATCHED',
    audience: 'CUSTOMER',
    en: {
      title: 'Your shipment is on its way',
      body: 'Hello {{customerName}}, shipment {{shipmentNumber}} of order {{orderNumber}} has been dispatched.',
    },
    ar: {
      title: 'شحنتك في الطريق',
      body: 'مرحبًا {{customerName}}، تم شحن {{shipmentNumber}} الخاصة بالطلب {{orderNumber}}.',
    },
  },
  {
    code: 'ORDER_DELIVERED',
    audience: 'CUSTOMER',
    en: {
      title: 'Order {{orderNumber}} delivered',
      body: 'Hello {{customerName}}, your order {{orderNumber}} has been delivered. Thank you for choosing us.',
    },
    ar: {
      title: 'تم تسليم الطلب {{orderNumber}}',
      body: 'مرحبًا {{customerName}}، تم تسليم طلبك {{orderNumber}}. شكرًا لاختيارك لنا.',
    },
  },
];

/** Customer-facing label of a milestone, per locale (never exposes internal stages). */
export const MILESTONE_LABELS: Record<
  string,
  Record<(typeof TEMPLATE_LOCALES)[number], string>
> = {
  PRODUCTION_STARTED: { en: 'production has started', ar: 'بدأ الإنتاج' },
  PRODUCTION_IN_PROGRESS: {
    en: 'production is in progress',
    ar: 'الإنتاج قيد التنفيذ',
  },
  QUALITY_CHECK: { en: 'quality check', ar: 'فحص الجودة' },
  PACKAGING: { en: 'packaging', ar: 'التعبئة والتغليف' },
  READY_FOR_DELIVERY: { en: 'ready for delivery', ar: 'جاهز للتسليم' },
};
