import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  AutomationRule,
  NotificationChannel,
  NotificationSeverity,
  NotificationTemplate,
  OperationalAlert,
  OutboxEvent,
  Prisma,
} from '../../generated/prisma/client.js';
import { ManagementContext } from '../management/management-context.service.js';
import {
  EVENT_CATEGORY,
  OPTIONAL_CUSTOMER_CATEGORIES,
  notificationTypeForAlert,
  type EventType,
  type NotificationCategory,
} from './events.js';
import {
  EventContextService,
  type ResolvedContext,
} from './event-context.service.js';
import { EmailProvider, WhatsAppProvider } from './providers/provider.ports.js';
import { inQuietHours, parseQuietHours, quietHoursEnd } from './quiet-hours.js';
import { render } from './template-renderer.js';

type Row = Prisma.NotificationCreateManyInput;

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

/** Responsible department → the role whose members work it (there is no separate "lead" concept yet). */
export const DEPARTMENT_ROLE: Record<string, string> = {
  FABRIC: 'FABRIC',
  PATTERN: 'PATTERN_MAKER',
  CUTTING: 'CUTTING',
  PRINTING: 'PRINTING',
  SEWING: 'SEWING',
  QC: 'QC',
  PACKAGING: 'PACKAGING',
  DELIVERY: 'DELIVERY',
  SALES: 'SALES',
  FINANCE: 'FINANCE',
};

/** Alert types whose "opened" message has its own, more specific template. */
const OPENED_TEMPLATE: Record<string, string> = {
  DELAYED_STAGE: 'STAGE_DELAYED',
  PACKAGING_DELAY: 'STAGE_DELAYED',
};

interface StaffRecipient {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  locale: string;
}

/**
 * Event → notifications. Pure database work (no network): resolves the audience of every matching automation
 * rule, applies preferences / provider availability / quiet hours, renders the active template of the
 * recipient's locale and inserts the rows with a deterministic deduplication key
 * (`event:rule:recipient:channel`), so processing the same event twice can never create a second notification.
 * Delivery happens later in `NotificationDispatcherService`.
 */
@Injectable()
export class NotificationPlannerService {
  private readonly logger = new Logger(NotificationPlannerService.name);
  private readonly cfg: AppConfig['notifications'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: EventContextService,
    private readonly mgmt: ManagementContext,
    private readonly email: EmailProvider,
    private readonly whatsapp: WhatsAppProvider,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app').notifications;
  }

  private channelEnabled(channel: NotificationChannel): boolean {
    return (
      channel === 'IN_APP' ||
      (channel === 'EMAIL' ? this.email.enabled : this.whatsapp.enabled)
    );
  }

  /** Returns the number of notifications created. */
  async plan(event: OutboxEvent): Promise<number> {
    const ctx = await this.context.resolve(event);
    const type = event.eventType as EventType;
    const category = EVENT_CATEGORY[type];
    if (!category) throw new Error(`Unsupported event type ${event.eventType}`);
    if (type === 'ALERT_ESCALATED') return this.planEscalation(event, ctx);

    const alertType = ctx.alert?.type;
    const rules = (
      await this.prisma.automationRule.findMany({
        where: { eventType: type, active: true },
        orderBy: { code: 'asc' },
      })
    ).filter(
      (r) =>
        (!r.alertType || r.alertType === alertType) &&
        (!r.minSeverity ||
          (ctx.alert &&
            SEVERITY_RANK[ctx.alert.severity] >= SEVERITY_RANK[r.minSeverity])),
    );
    if (rules.length === 0) return 0;

    const codes = [
      ...new Set(rules.map((r) => this.templateCodeFor(r, ctx.alert))),
    ];
    const templates = await this.prisma.notificationTemplate.findMany({
      where: { code: { in: codes }, active: true },
    });
    const rows: Row[] = [];
    for (const rule of rules) {
      const code = this.templateCodeFor(rule, ctx.alert);
      const common = {
        event,
        ctx,
        category,
        rule: {
          code: rule.code,
          channels: rule.channels,
          critical: rule.critical,
        },
        severity: ctx.alert?.severity ?? rule.severity,
        type: ctx.alert ? notificationTypeForAlert(ctx.alert.type) : type,
        templateCode: code,
        templates,
      };
      if (rule.audience === 'CUSTOMER')
        rows.push(...(await this.customerRows(common)));
      else
        rows.push(
          ...(await this.staffRows(
            common,
            await this.staffAudience(rule, ctx),
          )),
        );
    }
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.notification.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }

  private templateCodeFor(
    rule: AutomationRule,
    alert?: OperationalAlert,
  ): string {
    if (alert && rule.eventType === 'ALERT_OPENED')
      return OPENED_TEMPLATE[alert.type] ?? rule.templateCode;
    return rule.templateCode;
  }

  // ───────────────────────── audiences ─────────────────────────

  private async users(where: Prisma.UserWhereInput): Promise<StaffRecipient[]> {
    const rows = await this.prisma.user.findMany({
      where: { isActive: true, deletedAt: null, status: 'ACTIVE', ...where },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        notificationLocale: true,
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      locale: u.notificationLocale ?? this.cfg.defaultLocale,
    }));
  }

  private async staffAudience(
    rule: AutomationRule,
    ctx: ResolvedContext,
  ): Promise<StaffRecipient[]> {
    switch (rule.audience) {
      case 'ROLE':
        return this.users({
          roles: { some: { role: { code: rule.audienceValue! } } },
        });
      case 'PERMISSION':
        return this.users({
          roles: {
            some: {
              role: {
                permissions: {
                  some: { permission: { code: rule.audienceValue! } },
                },
              },
            },
          },
        });
      case 'SALES_OWNER':
        return ctx.ids.salesUserId
          ? this.users({ id: ctx.ids.salesUserId })
          : [];
      case 'STAGE_ASSIGNEES': {
        if (ctx.assigneeUserId) return this.users({ id: ctx.assigneeUserId });
        if (!ctx.ids.stageId) return [];
        return this.users({
          stageAssignments: {
            some: { jobStageId: ctx.ids.stageId, removedAt: null },
          },
        });
      }
      case 'JOB_ASSIGNEES':
        return ctx.ids.jobId
          ? this.users({
              stageAssignments: {
                some: {
                  removedAt: null,
                  jobStage: {
                    jobId: ctx.ids.jobId,
                    supersededAt: null,
                    status: {
                      in: ['READY', 'IN_PROGRESS', 'BLOCKED', 'WAITING'],
                    },
                  },
                },
              },
            })
          : [];
      case 'ALERT_RESPONSIBLE':
        return ctx.responsibleUserIds.length
          ? this.users({ id: { in: ctx.responsibleUserIds } })
          : [];
      default:
        return [];
    }
  }

  // ───────────────────────── staff ─────────────────────────

  private pickTemplate(
    templates: NotificationTemplate[],
    code: string,
    channel: NotificationChannel,
    locale: string,
  ) {
    return (
      templates.find(
        (t) => t.code === code && t.channel === channel && t.locale === locale,
      ) ??
      templates.find(
        (t) =>
          t.code === code &&
          t.channel === channel &&
          t.locale === this.cfg.defaultLocale,
      )
    );
  }

  private async staffRows(
    c: {
      event: OutboxEvent;
      ctx: ResolvedContext;
      category: NotificationCategory;
      rule: {
        code: string;
        channels: NotificationChannel[];
        critical: boolean;
      };
      severity: NotificationSeverity;
      type: string;
      templateCode: string;
      templates: NotificationTemplate[];
    },
    recipients: StaffRecipient[],
  ): Promise<Row[]> {
    if (recipients.length === 0) return [];
    const prefs = await this.prisma.userNotificationPreference.findMany({
      where: {
        userId: { in: recipients.map((r) => r.id) },
        category: c.category,
      },
    });
    const now = this.mgmt.now();
    const rows: Row[] = [];
    for (const r of recipients) {
      const pref = prefs.find((p) => p.userId === r.id);
      for (const channel of c.rule.channels) {
        if (!this.channelEnabled(channel)) continue;
        const allowed =
          c.rule.critical ||
          (channel === 'IN_APP'
            ? (pref?.inApp ?? true)
            : channel === 'EMAIL'
              ? (pref?.email ?? true)
              : (pref?.whatsapp ?? false));
        if (!allowed) continue;
        const address =
          channel === 'EMAIL'
            ? r.email
            : channel === 'WHATSAPP'
              ? r.phone
              : null;
        if (channel !== 'IN_APP' && !address) continue;
        const tpl = this.pickTemplate(
          c.templates,
          c.templateCode,
          channel,
          r.locale,
        );
        if (!tpl) {
          this.logger.warn(
            `No active ${channel} template ${c.templateCode} (${r.locale}); skipped`,
          );
          continue;
        }
        const vars = { ...c.ctx.vars(tpl.locale), recipientName: r.name };
        const body = render(tpl.bodyTemplate, vars);
        const title = tpl.subject
          ? render(tpl.subject, vars)
          : body.split('\n')[0]!.slice(0, 120);
        const release = this.releaseAt(channel, 'STAFF', c.rule.critical, now);
        rows.push({
          type: c.type,
          severity: c.severity,
          recipientKind: 'STAFF',
          recipientUserId: r.id,
          channel,
          recipientAddress: address,
          locale: tpl.locale,
          templateCode: tpl.code,
          templateVersion: tpl.version,
          title,
          body,
          variables: vars,
          entityType: c.ctx.entityType,
          entityId: c.ctx.entityId,
          status: channel === 'IN_APP' ? 'SENT' : 'PENDING',
          sentAt: channel === 'IN_APP' ? now : null,
          critical: c.rule.critical,
          scheduledAt: release,
          nextAttemptAt: channel === 'IN_APP' ? null : (release ?? now),
          deduplicationKey: `${c.event.id}:${c.rule.code}:${r.id}:${channel}`,
          outboxEventId: c.event.id,
          alertId: c.ctx.alert?.id,
        });
      }
    }
    return rows;
  }

  // ───────────────────────── customers ─────────────────────────

  /**
   * Customers are reached through contact details that already exist on the customer record (there is no
   * customer login). The destination is snapshotted on the notification and never exposed publicly.
   */
  private async customerRows(c: {
    event: OutboxEvent;
    ctx: ResolvedContext;
    category: NotificationCategory;
    rule: { code: string; channels: NotificationChannel[]; critical: boolean };
    severity: NotificationSeverity;
    type: string;
    templateCode: string;
    templates: NotificationTemplate[];
  }): Promise<Row[]> {
    const customerId = c.ctx.ids.customerId;
    if (!customerId) return [];
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        contacts: {
          where: { archivedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        notificationPreferences: { where: { category: c.category } },
      },
    });
    if (!customer || customer.status === 'ARCHIVED') return [];
    const pref = customer.notificationPreferences[0];
    const optional = OPTIONAL_CUSTOMER_CATEGORIES.includes(c.category);
    const locale = customer.preferredLocale ?? this.cfg.defaultLocale;
    const now = this.mgmt.now();
    const rows: Row[] = [];
    for (const channel of c.rule.channels) {
      if (channel === 'IN_APP' || !this.channelEnabled(channel)) continue; // customers have no in-app inbox
      if (
        optional &&
        pref &&
        !(channel === 'EMAIL' ? pref.email : pref.whatsapp)
      )
        continue;
      const contact = customer.contacts.find((ct) =>
        channel === 'EMAIL' ? ct.email : (ct.whatsapp ?? ct.phone),
      );
      const address =
        channel === 'EMAIL'
          ? (contact?.email ?? customer.email)
          : (contact?.whatsapp ??
            contact?.phone ??
            customer.whatsapp ??
            customer.phone);
      if (!address) continue;
      const tpl = this.pickTemplate(
        c.templates,
        c.templateCode,
        channel,
        locale,
      );
      if (!tpl) continue;
      const vars = {
        ...c.ctx.vars(tpl.locale),
        recipientName: contact?.name ?? customer.displayName,
      };
      const body = render(tpl.bodyTemplate, vars);
      const title = tpl.subject
        ? render(tpl.subject, vars)
        : body.split('\n')[0]!.slice(0, 120);
      const release = this.releaseAt(channel, 'CUSTOMER', c.rule.critical, now);
      rows.push({
        type: c.type,
        severity: c.severity,
        recipientKind: 'CUSTOMER',
        customerId: customer.id,
        customerContactId: contact?.id,
        channel,
        recipientAddress: address,
        locale: tpl.locale,
        templateCode: tpl.code,
        templateVersion: tpl.version,
        title,
        body,
        variables: vars,
        entityType: c.ctx.entityType,
        entityId: c.ctx.entityId,
        status: 'PENDING',
        critical: c.rule.critical,
        scheduledAt: release,
        nextAttemptAt: release ?? now,
        deduplicationKey: `${c.event.id}:${c.rule.code}:c-${customer.id}:${channel}`,
        outboxEventId: c.event.id,
      });
    }
    return rows;
  }

  // ───────────────────────── escalation ─────────────────────────

  private async planEscalation(
    event: OutboxEvent,
    ctx: ResolvedContext,
  ): Promise<number> {
    const p = event.payload as { ruleId?: string };
    const alert = ctx.alert;
    if (!alert || !p.ruleId) return 0;
    const rule = await this.prisma.escalationRule.findUnique({
      where: { id: p.ruleId },
    });
    if (!rule) return 0;
    const roleCode =
      rule.recipientKind === 'ROLE'
        ? rule.recipientRoleCode
        : alert.department
          ? DEPARTMENT_ROLE[alert.department]
          : undefined;
    if (!roleCode) {
      this.logger.warn(
        `Escalation ${rule.code}: no role for department ${alert.department ?? '-'}; skipped`,
      );
      return 0;
    }
    const recipients = await this.users({
      roles: { some: { role: { code: roleCode } } },
    });
    const templates = await this.prisma.notificationTemplate.findMany({
      where: { code: 'ALERT_ESCALATED', active: true },
    });
    const rows = await this.staffRows(
      {
        event,
        ctx,
        category: 'ALERTS',
        rule: {
          code: rule.code,
          channels: rule.channels,
          critical: rule.critical,
        },
        severity: alert.severity,
        type: 'ALERT_ESCALATED',
        templateCode: 'ALERT_ESCALATED',
        templates,
      },
      recipients,
    );
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.notification.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }

  // ───────────────────────── quiet hours ─────────────────────────

  /** Quiet hours hold external messages (never in-app, never critical ones) until the window ends. */
  private releaseAt(
    channel: NotificationChannel,
    kind: 'STAFF' | 'CUSTOMER',
    critical: boolean,
    now: Date,
  ): Date | null {
    if (channel === 'IN_APP' || critical) return null;
    const q = this.cfg.quietHours;
    if (q.appliesTo === 'customer' && kind !== 'CUSTOMER') return null;
    const window = parseQuietHours(q.start, q.end);
    if (!window || !inQuietHours(window, now, this.mgmt.timezone)) return null;
    return quietHoursEnd(window, now, this.mgmt.timezone);
  }
}
