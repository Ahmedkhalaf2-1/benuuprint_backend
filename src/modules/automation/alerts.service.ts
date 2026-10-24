import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Prisma,
  type NotificationSeverity,
  type OperationalAlert,
} from '../../generated/prisma/client.js';
import { CalendarService } from '../calendar/calendar.service.js';
import {
  AttentionService,
  type AttentionItem,
} from '../management/attention.service.js';
import { ManagementContext } from '../management/management-context.service.js';
import { OutboxService } from '../notifications/outbox.service.js';

const RANK: Record<NotificationSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};
const fingerprintOf = (
  i: Pick<AttentionItem, 'type' | 'entityType' | 'entityId'>,
) => `${i.type}:${i.entityType}:${i.entityId}`;

export interface AlertRunResult {
  detected: number;
  opened: number;
  severityIncreased: number;
  escalated: number;
  resolved: number;
  /** Categories that hit the read cap: their open alerts were not resolved this run. */
  truncatedTypes: string[];
}

/**
 * The scheduled evaluator. Needs Attention is a pure function of the current data; this service turns it into
 * incidents with memory (`OperationalAlert`) so the same unchanged problem is announced once:
 *
 *  - a condition that becomes active opens an alert and emits ALERT_OPENED;
 *  - a materially higher severity emits ALERT_SEVERITY_INCREASED (once per new highest level);
 *  - an open alert that stays open past an escalation rule's working-minutes threshold emits ALERT_ESCALATED,
 *    once per rule level (levels are capped at 5 and escalation messages are never alerts themselves);
 *  - a condition that disappears resolves its alert (kept as history); if it comes back, a new alert opens.
 *
 * Every state change and its outbox event are written in one transaction. Concurrent runs are harmless: the
 * partial unique index allows one OPEN alert per fingerprint and event deduplication keys are deterministic.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attention: AttentionService,
    private readonly outbox: OutboxService,
    private readonly ctx: ManagementContext,
    private readonly calendar: CalendarService,
  ) {}

  async evaluate(): Promise<AlertRunResult> {
    const now = this.ctx.now();
    const clock = await this.calendar.clock();
    const { items, truncatedTypes } = await this.attention.snapshot(now);
    const current = new Map<string, AttentionItem>();
    for (const i of items) current.set(fingerprintOf(i), i);
    const open = await this.prisma.operationalAlert.findMany({
      where: { status: 'OPEN' },
    });
    const openByFp = new Map(open.map((a) => [a.fingerprint, a]));
    const rules = await this.prisma.escalationRule.findMany({
      where: { active: true },
      orderBy: [{ alertType: 'asc' }, { level: 'asc' }],
    });

    const result: AlertRunResult = {
      detected: items.length,
      opened: 0,
      severityIncreased: 0,
      escalated: 0,
      resolved: 0,
      truncatedTypes: [...truncatedTypes],
    };

    for (const [fp, item] of current) {
      const existing = openByFp.get(fp);
      try {
        if (!existing) {
          if (await this.open(item, fp, now)) result.opened += 1;
          continue;
        }
        const out = await this.refresh(
          existing,
          item,
          now,
          clock.between(existing.firstDetectedAt, now),
          rules,
        );
        result.severityIncreased += out.severityIncreased ? 1 : 0;
        result.escalated += out.escalated;
      } catch (e) {
        this.logger.error(
          `Alert ${fp}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    for (const a of open) {
      if (current.has(a.fingerprint) || truncatedTypes.has(a.type as never))
        continue;
      await this.prisma.operationalAlert.updateMany({
        where: { id: a.id, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: now },
      });
      result.resolved += 1;
    }
    return result;
  }

  private contextOf(item: AttentionItem) {
    return {
      responsibleUserIds: item.responsible.users.map((u) => u.id),
      ...item.context,
      priority: item.priority,
    } as Prisma.InputJsonValue;
  }

  /** Returns false when another run opened the same alert first. */
  private async open(
    item: AttentionItem,
    fingerprint: string,
    now: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const alert = await tx.operationalAlert.create({
          data: {
            type: item.type,
            entityType: item.entityType,
            entityId: item.entityId,
            fingerprint,
            severity: item.severity,
            lastNotifiedSeverity: item.severity,
            reference: item.reference,
            title: item.title.slice(0, 200),
            reason: item.reason.slice(0, 500),
            department: item.responsible.department,
            context: this.contextOf(item),
            firstDetectedAt: now,
            lastDetectedAt: now,
            lastNotifiedAt: now,
          },
        });
        await this.outbox.emit(tx, {
          eventType: 'ALERT_OPENED',
          aggregateType: 'OperationalAlert',
          aggregateId: alert.id,
          payload: { alertId: alert.id },
          deduplicationKey: `ALERT_OPENED:${alert.id}`,
        });
      });
      return true;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        return false;
      throw e;
    }
  }

  private async refresh(
    alert: OperationalAlert,
    item: AttentionItem,
    now: Date,
    workingMinutesOpen: number,
    rules: {
      id: string;
      alertType: string;
      level: number;
      afterMinutes: number;
      minSeverity: NotificationSeverity | null;
    }[],
  ): Promise<{ severityIncreased: boolean; escalated: number }> {
    let severityIncreased = false;
    let escalated = 0;
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.OperationalAlertUncheckedUpdateInput = {
        lastDetectedAt: now,
        severity: item.severity,
        reason: item.reason.slice(0, 500),
        title: item.title.slice(0, 200),
        department: item.responsible.department,
        context: this.contextOf(item),
      };
      const notified = alert.lastNotifiedSeverity ?? alert.severity;
      if (RANK[item.severity] > RANK[notified]) {
        severityIncreased = true;
        data.lastNotifiedSeverity = item.severity;
        data.lastNotifiedAt = now;
        await this.outbox.emit(tx, {
          eventType: 'ALERT_SEVERITY_INCREASED',
          aggregateType: 'OperationalAlert',
          aggregateId: alert.id,
          payload: { alertId: alert.id },
          deduplicationKey: `ALERT_SEV:${alert.id}:${item.severity}`,
        });
      }
      let level = alert.escalationLevel;
      for (const r of rules) {
        if (r.alertType !== alert.type || r.level <= level) continue;
        if (r.minSeverity && RANK[item.severity] < RANK[r.minSeverity])
          continue;
        if (workingMinutesOpen < r.afterMinutes) break; // later levels need even longer
        await this.outbox.emit(tx, {
          eventType: 'ALERT_ESCALATED',
          aggregateType: 'OperationalAlert',
          aggregateId: alert.id,
          payload: { alertId: alert.id, ruleId: r.id, level: String(r.level) },
          deduplicationKey: `ALERT_ESC:${alert.id}:${r.level}`,
        });
        level = r.level;
        escalated += 1;
      }
      if (level !== alert.escalationLevel) {
        data.escalationLevel = level;
        data.lastNotifiedAt = now;
      }
      await tx.operationalAlert.update({ where: { id: alert.id }, data });
    });
    return { severityIncreased, escalated };
  }
}
