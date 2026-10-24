import type {
  AutomationAudience,
  NotificationChannel,
  NotificationSeverity,
} from '../../generated/prisma/client.js';

/**
 * Seeded defaults: who hears about which event. Everything here is configuration (editable through the
 * automation API) and is only created when missing, so admin edits survive redeploys.
 *
 * `critical` rules ignore user preferences and quiet hours. Defaults: a failed delivery, a commercial re-approval
 * and escalations to ADMIN. Everything else respects preferences; customers can only switch off the optional
 * PRODUCTION_MILESTONE category.
 */
export interface RuleSeed {
  code: string;
  eventType: string;
  alertType?: string;
  minSeverity?: NotificationSeverity;
  audience: AutomationAudience;
  audienceValue?: string;
  channels: NotificationChannel[];
  templateCode: string;
  severity?: NotificationSeverity;
  critical?: boolean;
}

const IN: NotificationChannel[] = ['IN_APP'];
const IN_MAIL: NotificationChannel[] = ['IN_APP', 'EMAIL'];
const EXT: NotificationChannel[] = ['EMAIL', 'WHATSAPP'];

export const DEFAULT_AUTOMATION_RULES: RuleSeed[] = [
  {
    code: 'SAMPLE_SUBMITTED_REVIEWERS',
    eventType: 'SAMPLE_SUBMITTED',
    audience: 'PERMISSION',
    audienceValue: 'samples.review',
    channels: IN_MAIL,
    templateCode: 'SAMPLE_SUBMITTED',
  },
  {
    code: 'SAMPLE_READY_SALES',
    eventType: 'SAMPLE_READY_FOR_APPROVAL',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'SAMPLE_READY_FOR_APPROVAL_STAFF',
  },
  {
    code: 'SAMPLE_READY_CUSTOMER',
    eventType: 'SAMPLE_READY_FOR_APPROVAL',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'SAMPLE_READY_FOR_APPROVAL',
  },
  {
    code: 'SAMPLE_APPROVED_SALES',
    eventType: 'SAMPLE_APPROVED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'SAMPLE_APPROVED',
  },
  {
    code: 'SAMPLE_APPROVED_FACTORY',
    eventType: 'SAMPLE_APPROVED',
    audience: 'PERMISSION',
    audienceValue: 'factory_jobs.manage',
    channels: IN,
    templateCode: 'SAMPLE_APPROVED',
  },
  {
    code: 'QUOTATION_SENT_CUSTOMER',
    eventType: 'QUOTATION_SENT',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'QUOTATION_READY',
  },
  {
    code: 'QUOTATION_ACCEPTED_SALES',
    eventType: 'QUOTATION_ACCEPTED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'QUOTATION_ACCEPTED',
  },
  {
    code: 'QUOTATION_ACCEPTED_FINANCE',
    eventType: 'QUOTATION_ACCEPTED',
    audience: 'ROLE',
    audienceValue: 'FINANCE',
    channels: IN,
    templateCode: 'QUOTATION_ACCEPTED',
  },
  {
    code: 'PAYMENT_SUBMITTED_VERIFIERS',
    eventType: 'PAYMENT_SUBMITTED',
    audience: 'PERMISSION',
    audienceValue: 'payments.verify',
    channels: IN_MAIL,
    templateCode: 'PAYMENT_SUBMITTED',
  },
  {
    code: 'PAYMENT_VERIFIED_SALES',
    eventType: 'PAYMENT_VERIFIED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'PAYMENT_VERIFIED_STAFF',
  },
  {
    code: 'PAYMENT_VERIFIED_CUSTOMER',
    eventType: 'PAYMENT_VERIFIED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'PAYMENT_VERIFIED',
  },
  {
    code: 'PAYMENT_REJECTED_CUSTOMER',
    eventType: 'PAYMENT_REJECTED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'PAYMENT_REJECTED',
  },
  {
    code: 'SAMPLE_APPROVED_CUSTOMER',
    eventType: 'SAMPLE_APPROVED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'SAMPLE_APPROVED_CUSTOMER',
  },
  {
    code: 'SAMPLE_CHANGES_REQUESTED_CUSTOMER',
    eventType: 'SAMPLE_CHANGES_REQUESTED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'SAMPLE_CHANGES_REQUESTED_CUSTOMER',
  },
  {
    code: 'SAMPLE_CHANGES_REQUESTED_SALES',
    eventType: 'SAMPLE_CHANGES_REQUESTED',
    audience: 'SALES_OWNER',
    channels: IN_MAIL,
    templateCode: 'SAMPLE_CHANGES_REQUESTED_STAFF',
  },
  {
    code: 'SAMPLE_CHANGES_REQUESTED_FACTORY',
    eventType: 'SAMPLE_CHANGES_REQUESTED',
    audience: 'PERMISSION',
    audienceValue: 'factory_jobs.manage',
    channels: IN,
    templateCode: 'SAMPLE_CHANGES_REQUESTED_STAFF',
  },
  {
    code: 'ORDER_SUBMITTED_CONFIRMERS',
    eventType: 'ORDER_SUBMITTED',
    audience: 'PERMISSION',
    audienceValue: 'orders.confirm',
    channels: IN_MAIL,
    templateCode: 'ORDER_SUBMITTED',
  },
  {
    code: 'ORDER_READY_PRODUCTION_CUSTOMER',
    eventType: 'ORDER_READY_FOR_PRODUCTION',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'ORDER_READY_FOR_PRODUCTION_CUSTOMER',
  },
  {
    code: 'ORDER_PRODUCTION_COMPLETED_CUSTOMER',
    eventType: 'ORDER_PRODUCTION_COMPLETED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'ORDER_PRODUCTION_COMPLETED_CUSTOMER',
  },
  {
    code: 'ORDER_CONFIRMED_ADMIN',
    eventType: 'ORDER_CONFIRMED',
    audience: 'ROLE',
    audienceValue: 'ADMIN',
    channels: IN,
    templateCode: 'ORDER_CONFIRMED_STAFF',
  },
  {
    code: 'ORDER_CONFIRMED_CUSTOMER',
    eventType: 'ORDER_CONFIRMED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'ORDER_CONFIRMED',
  },
  {
    code: 'REAPPROVAL_SALES',
    eventType: 'COMMERCIAL_REAPPROVAL_REQUIRED',
    audience: 'SALES_OWNER',
    channels: IN_MAIL,
    templateCode: 'COMMERCIAL_REAPPROVAL_REQUIRED',
    severity: 'WARNING',
    critical: true,
  },
  {
    code: 'REAPPROVAL_FINANCE',
    eventType: 'COMMERCIAL_REAPPROVAL_REQUIRED',
    audience: 'ROLE',
    audienceValue: 'FINANCE',
    channels: IN,
    templateCode: 'COMMERCIAL_REAPPROVAL_REQUIRED',
    severity: 'WARNING',
  },
  {
    code: 'ORDER_RELEASED_FACTORY',
    eventType: 'ORDER_READY_FOR_PRODUCTION',
    audience: 'PERMISSION',
    audienceValue: 'factory_jobs.manage',
    channels: IN,
    templateCode: 'ORDER_READY_FOR_PRODUCTION',
  },
  {
    code: 'JOB_STARTED_SALES',
    eventType: 'JOB_STARTED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'JOB_STARTED',
  },
  {
    code: 'STAGE_ASSIGNED_ASSIGNEE',
    eventType: 'STAGE_ASSIGNED',
    audience: 'STAGE_ASSIGNEES',
    channels: IN,
    templateCode: 'STAGE_ASSIGNED',
  },
  {
    code: 'STAGE_BLOCKED_ADMIN',
    eventType: 'STAGE_BLOCKED',
    audience: 'ROLE',
    audienceValue: 'ADMIN',
    channels: IN_MAIL,
    templateCode: 'STAGE_BLOCKED',
    severity: 'WARNING',
  },
  {
    code: 'STAGE_BLOCKED_SALES',
    eventType: 'STAGE_BLOCKED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'STAGE_BLOCKED',
    severity: 'WARNING',
  },
  {
    code: 'QC_FAILED_QC',
    eventType: 'QC_FAILED',
    audience: 'ROLE',
    audienceValue: 'QC',
    channels: IN,
    templateCode: 'QC_FAILED',
    severity: 'WARNING',
  },
  {
    code: 'QC_FAILED_ADMIN',
    eventType: 'QC_FAILED',
    audience: 'ROLE',
    audienceValue: 'ADMIN',
    channels: IN_MAIL,
    templateCode: 'QC_FAILED',
    severity: 'WARNING',
  },
  {
    code: 'REWORK_ADMIN',
    eventType: 'REWORK_CREATED',
    audience: 'ROLE',
    audienceValue: 'ADMIN',
    channels: IN,
    templateCode: 'REWORK_CREATED',
    severity: 'WARNING',
  },
  {
    code: 'REWORK_ASSIGNEES',
    eventType: 'REWORK_CREATED',
    audience: 'JOB_ASSIGNEES',
    channels: IN,
    templateCode: 'REWORK_CREATED',
    severity: 'WARNING',
  },
  {
    code: 'JOB_COMPLETED_SALES',
    eventType: 'JOB_COMPLETED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'JOB_COMPLETED',
  },
  {
    code: 'PRODUCTION_COMPLETED_SALES',
    eventType: 'ORDER_PRODUCTION_COMPLETED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'ORDER_PRODUCTION_COMPLETED',
  },
  {
    code: 'READY_FOR_DELIVERY_SALES',
    eventType: 'ORDER_READY_FOR_DELIVERY',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'ORDER_READY_FOR_DELIVERY_STAFF',
  },
  {
    code: 'READY_FOR_DELIVERY_DELIVERY',
    eventType: 'ORDER_READY_FOR_DELIVERY',
    audience: 'ROLE',
    audienceValue: 'DELIVERY',
    channels: IN,
    templateCode: 'ORDER_READY_FOR_DELIVERY_STAFF',
  },
  {
    code: 'READY_FOR_DELIVERY_CUSTOMER',
    eventType: 'ORDER_READY_FOR_DELIVERY',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'ORDER_READY_FOR_DELIVERY',
  },
  {
    code: 'DISPATCHED_SALES',
    eventType: 'SHIPMENT_DISPATCHED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'SHIPMENT_DISPATCHED_STAFF',
  },
  {
    code: 'DISPATCHED_CUSTOMER',
    eventType: 'SHIPMENT_DISPATCHED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'SHIPMENT_DISPATCHED',
  },
  {
    code: 'SHIPMENT_FAILED_SALES',
    eventType: 'SHIPMENT_FAILED',
    audience: 'SALES_OWNER',
    channels: IN_MAIL,
    templateCode: 'SHIPMENT_FAILED',
    severity: 'CRITICAL',
    critical: true,
  },
  {
    code: 'SHIPMENT_FAILED_ADMIN',
    eventType: 'SHIPMENT_FAILED',
    audience: 'ROLE',
    audienceValue: 'ADMIN',
    channels: IN_MAIL,
    templateCode: 'SHIPMENT_FAILED',
    severity: 'CRITICAL',
    critical: true,
  },
  {
    code: 'DELIVERED_SALES',
    eventType: 'ORDER_DELIVERED',
    audience: 'SALES_OWNER',
    channels: IN,
    templateCode: 'ORDER_DELIVERED_STAFF',
  },
  {
    code: 'DELIVERED_CUSTOMER',
    eventType: 'ORDER_DELIVERED',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'ORDER_DELIVERED',
  },
  {
    code: 'MILESTONE_CUSTOMER',
    eventType: 'ORDER_MILESTONE',
    audience: 'CUSTOMER',
    channels: EXT,
    templateCode: 'PRODUCTION_MILESTONE',
  },
  {
    code: 'ALERT_OPENED_RESPONSIBLE',
    eventType: 'ALERT_OPENED',
    audience: 'ALERT_RESPONSIBLE',
    channels: IN,
    templateCode: 'ALERT_OPENED',
  },
  {
    code: 'ALERT_OPENED_ADMIN',
    eventType: 'ALERT_OPENED',
    minSeverity: 'CRITICAL',
    audience: 'ROLE',
    audienceValue: 'ADMIN',
    channels: IN_MAIL,
    templateCode: 'ALERT_OPENED',
  },
  {
    code: 'ALERT_SEVERITY_RESPONSIBLE',
    eventType: 'ALERT_SEVERITY_INCREASED',
    audience: 'ALERT_RESPONSIBLE',
    channels: IN,
    templateCode: 'ALERT_SEVERITY_INCREASED',
  },
  {
    code: 'ALERT_SEVERITY_ADMIN',
    eventType: 'ALERT_SEVERITY_INCREASED',
    minSeverity: 'CRITICAL',
    audience: 'ROLE',
    audienceValue: 'ADMIN',
    channels: IN_MAIL,
    templateCode: 'ALERT_SEVERITY_INCREASED',
  },
];

export interface EscalationSeed {
  code: string;
  alertType: string;
  level: number;
  afterMinutes: number;
  recipientKind: 'ROLE' | 'RESPONSIBLE_DEPARTMENT';
  recipientRoleCode?: string;
  channels: NotificationChannel[];
  critical?: boolean;
}

/** `afterMinutes` are WORKING minutes since the alert was first detected (calendar minutes without a working calendar). */
export const DEFAULT_ESCALATION_RULES: EscalationSeed[] = [
  {
    code: 'ESC_DELAYED_STAGE_L1',
    alertType: 'DELAYED_STAGE',
    level: 1,
    afterMinutes: 120,
    recipientKind: 'RESPONSIBLE_DEPARTMENT',
    channels: IN,
  },
  {
    code: 'ESC_DELAYED_STAGE_L2',
    alertType: 'DELAYED_STAGE',
    level: 2,
    afterMinutes: 480,
    recipientKind: 'ROLE',
    recipientRoleCode: 'ADMIN',
    channels: IN_MAIL,
    critical: true,
  },
  {
    code: 'ESC_PACKAGING_DELAY_L1',
    alertType: 'PACKAGING_DELAY',
    level: 1,
    afterMinutes: 120,
    recipientKind: 'RESPONSIBLE_DEPARTMENT',
    channels: IN,
  },
  {
    code: 'ESC_PACKAGING_DELAY_L2',
    alertType: 'PACKAGING_DELAY',
    level: 2,
    afterMinutes: 480,
    recipientKind: 'ROLE',
    recipientRoleCode: 'ADMIN',
    channels: IN_MAIL,
    critical: true,
  },
  {
    code: 'ESC_BLOCKED_STAGE_L1',
    alertType: 'BLOCKED_STAGE',
    level: 1,
    afterMinutes: 60,
    recipientKind: 'RESPONSIBLE_DEPARTMENT',
    channels: IN,
  },
  {
    code: 'ESC_BLOCKED_STAGE_L2',
    alertType: 'BLOCKED_STAGE',
    level: 2,
    afterMinutes: 240,
    recipientKind: 'ROLE',
    recipientRoleCode: 'ADMIN',
    channels: IN_MAIL,
    critical: true,
  },
  {
    code: 'ESC_OVERDUE_ORDER_L1',
    alertType: 'OVERDUE_ORDER',
    level: 1,
    afterMinutes: 60,
    recipientKind: 'ROLE',
    recipientRoleCode: 'SALES',
    channels: IN_MAIL,
  },
  {
    code: 'ESC_OVERDUE_ORDER_L2',
    alertType: 'OVERDUE_ORDER',
    level: 2,
    afterMinutes: 240,
    recipientKind: 'ROLE',
    recipientRoleCode: 'ADMIN',
    channels: IN_MAIL,
    critical: true,
  },
  {
    code: 'ESC_OVERDUE_JOB_L1',
    alertType: 'OVERDUE_JOB',
    level: 1,
    afterMinutes: 120,
    recipientKind: 'ROLE',
    recipientRoleCode: 'ADMIN',
    channels: IN_MAIL,
  },
  {
    code: 'ESC_SHIPMENT_FAILED_L1',
    alertType: 'SHIPMENT_FAILED',
    level: 1,
    afterMinutes: 120,
    recipientKind: 'ROLE',
    recipientRoleCode: 'ADMIN',
    channels: IN_MAIL,
    critical: true,
  },
];
