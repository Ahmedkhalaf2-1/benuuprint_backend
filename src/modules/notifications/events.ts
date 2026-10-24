/**
 * The supported domain events and what category they belong to. The outbox only ever carries these
 * types; automation rules attach audiences, channels and templates to them. Adding an event = adding it
 * here, emitting it in the business transaction, and seeding a rule + templates.
 */
export const EVENT_TYPES = [
  // samples and commercial documents
  'SAMPLE_SUBMITTED',
  'SAMPLE_READY_FOR_APPROVAL',
  'SAMPLE_APPROVED',
  'QUOTATION_SENT',
  'QUOTATION_ACCEPTED',
  'PAYMENT_SUBMITTED',
  'PAYMENT_VERIFIED',
  'PAYMENT_REJECTED',
  'SAMPLE_CHANGES_REQUESTED',
  // orders
  'ORDER_SUBMITTED',
  'ORDER_CONFIRMED',
  'COMMERCIAL_REAPPROVAL_REQUIRED',
  'ORDER_READY_FOR_PRODUCTION',
  'ORDER_PRODUCTION_COMPLETED',
  'ORDER_READY_FOR_DELIVERY',
  'ORDER_DELIVERED',
  'ORDER_MILESTONE',
  // factory
  'JOB_STARTED',
  'STAGE_ASSIGNED',
  'STAGE_BLOCKED',
  'QC_FAILED',
  'REWORK_CREATED',
  'JOB_COMPLETED',
  // delivery
  'SHIPMENT_DISPATCHED',
  'SHIPMENT_FAILED',
  // automation (raised by the scheduled evaluator, e.g. STAGE_DELAYED is an alert of type DELAYED_STAGE)
  'ALERT_OPENED',
  'ALERT_SEVERITY_INCREASED',
  'ALERT_ESCALATED',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type NotificationCategory =
  | 'SAMPLES'
  | 'COMMERCIAL'
  | 'PRODUCTION'
  | 'QUALITY'
  | 'DELIVERY'
  | 'ALERTS'
  | 'PRODUCTION_MILESTONE';

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'SAMPLES',
  'COMMERCIAL',
  'PRODUCTION',
  'QUALITY',
  'DELIVERY',
  'ALERTS',
  'PRODUCTION_MILESTONE',
];

export const EVENT_CATEGORY: Record<EventType, NotificationCategory> = {
  SAMPLE_SUBMITTED: 'SAMPLES',
  SAMPLE_READY_FOR_APPROVAL: 'SAMPLES',
  SAMPLE_APPROVED: 'SAMPLES',
  QUOTATION_SENT: 'COMMERCIAL',
  QUOTATION_ACCEPTED: 'COMMERCIAL',
  PAYMENT_SUBMITTED: 'COMMERCIAL',
  PAYMENT_VERIFIED: 'COMMERCIAL',
  PAYMENT_REJECTED: 'COMMERCIAL',
  SAMPLE_CHANGES_REQUESTED: 'SAMPLES',
  ORDER_SUBMITTED: 'COMMERCIAL',
  ORDER_CONFIRMED: 'COMMERCIAL',
  COMMERCIAL_REAPPROVAL_REQUIRED: 'COMMERCIAL',
  ORDER_READY_FOR_PRODUCTION: 'PRODUCTION',
  ORDER_PRODUCTION_COMPLETED: 'PRODUCTION',
  ORDER_READY_FOR_DELIVERY: 'DELIVERY',
  ORDER_DELIVERED: 'DELIVERY',
  ORDER_MILESTONE: 'PRODUCTION_MILESTONE',
  JOB_STARTED: 'PRODUCTION',
  STAGE_ASSIGNED: 'PRODUCTION',
  STAGE_BLOCKED: 'PRODUCTION',
  QC_FAILED: 'QUALITY',
  REWORK_CREATED: 'QUALITY',
  JOB_COMPLETED: 'PRODUCTION',
  SHIPMENT_DISPATCHED: 'DELIVERY',
  SHIPMENT_FAILED: 'DELIVERY',
  ALERT_OPENED: 'ALERTS',
  ALERT_SEVERITY_INCREASED: 'ALERTS',
  ALERT_ESCALATED: 'ALERTS',
};

/**
 * Customers may switch off only optional categories. Everything else is a transactional message about
 * their own documents, money or goods (no marketing exists in this system).
 */
export const OPTIONAL_CUSTOMER_CATEGORIES: readonly NotificationCategory[] = [
  'PRODUCTION_MILESTONE',
];

/**
 * Customer-safe production milestones. Internal stages map to coarse external labels; failures, rework,
 * blockers and QC details are never part of a milestone.
 */
export const MILESTONES = [
  'PRODUCTION_STARTED',
  'PRODUCTION_IN_PROGRESS',
  'QUALITY_CHECK',
  'PACKAGING',
  'READY_FOR_DELIVERY',
] as const;
export type Milestone = (typeof MILESTONES)[number];

export function milestoneForStage(stageCode: string): Milestone | null {
  if (stageCode.startsWith('QC_')) return 'QUALITY_CHECK';
  switch (stageCode) {
    case 'FABRIC_PREPARATION':
    case 'PATTERN_MAKING':
      return 'PRODUCTION_STARTED';
    case 'CUTTING':
    case 'PRINTING_EMBROIDERY':
    case 'SEWING':
      return 'PRODUCTION_IN_PROGRESS';
    case 'PACKAGING':
      return 'PACKAGING';
    default:
      return null;
  }
}

/** Alert types → the notification type shown to people (STAGE_DELAYED is the one named in the brief). */
export const ALERT_NOTIFICATION_TYPE: Record<string, string> = {
  DELAYED_STAGE: 'STAGE_DELAYED',
  PACKAGING_DELAY: 'STAGE_DELAYED',
  BLOCKED_STAGE: 'STAGE_BLOCKED',
};
export const notificationTypeForAlert = (alertType: string) =>
  ALERT_NOTIFICATION_TYPE[alertType] ?? `ALERT_${alertType}`;
