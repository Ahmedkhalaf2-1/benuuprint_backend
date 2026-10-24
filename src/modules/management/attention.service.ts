import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import type { AttentionQueryDto } from './dto/management.dto.js';
import { ManagementContext } from './management-context.service.js';
import { OrderCommercialService } from '../orders/order-commercial.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { SlaService } from './sla.service.js';
import {
  ATTENTION_EXTRA_PERMISSION,
  ATTENTION_TYPES,
  attentionScore,
  compareAttention,
  severityFor,
  type AttentionSeverity,
  type AttentionType,
} from './pure/attention.js';
import { ORDER_DELAYABLE_STATUSES } from './pure/delay.js';
import { resolveDateOrRuleDeadline } from './pure/sla.js';
import {
  JOB_NOT_ACTIVE,
  JOB_TERMINAL,
  reapprovalOrderWhere,
} from './queries.js';

/** Rows fetched per category: counts are exact up to this many, then flagged `truncated`. */
const CAP = 200;

export interface AttentionItem {
  type: AttentionType;
  severity: AttentionSeverity;
  score: number;
  entityType:
    | 'JOB_STAGE'
    | 'JOB'
    | 'ORDER'
    | 'SHIPMENT'
    | 'QC_INSPECTION'
    | 'REWORK'
    | 'BLOCKER';
  entityId: string;
  reference: string;
  title: string;
  reason: string;
  priority: string | null;
  responsible: {
    department: string | null;
    users: { id: string; name: string }[];
  };
  ageMinutes: number | null;
  dueAt: Date | null;
  context: {
    orderId?: string;
    orderNumber?: string;
    sampleId?: string;
    sampleNumber?: string;
    jobId?: string;
    jobNumber?: string;
    stageId?: string;
    shipmentId?: string;
    batchId?: string;
  };
}

const mins = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

const jobSelect = {
  id: true,
  jobNumber: true,
  priority: true,
  orderId: true,
  sampleId: true,
  productName: true,
  targetCompletionDate: true,
} as const;
const assignees = {
  where: { removedAt: null },
  select: { user: { select: { id: true, name: true } } },
} as const;

type JobLite = {
  id: string;
  jobNumber: string;
  priority: string;
  orderId: string | null;
  sampleId: string | null;
  productName: string;
  targetCompletionDate: Date | null;
};

/**
 * Collects actionable operational problems into one ranked list. Each category is a bounded query
 * (CAP rows); scoring and severity are the explicit rules of pure/attention.ts. Nothing is stored:
 * a condition disappears from the list the moment the data no longer matches it, which also makes
 * these categories directly reusable as Phase 6B notification conditions.
 */
@Injectable()
export class AttentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
    private readonly sla: SlaService,
    private readonly orderCommercial: OrderCommercialService,
    private readonly config: ConfigService,
    private readonly calendar: CalendarService,
  ) {}

  async list(q: AttentionQueryDto, actor: AuthUser) {
    const now = this.ctx.now();
    const all = await this.collect(now);
    const allowed = all.filter((i) => {
      const need = ATTENTION_EXTRA_PERMISSION[i.type];
      return !need || actor.permissions.has(need as never);
    });
    const rank = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const;
    const filtered = allowed.filter(
      (i) =>
        (!q.type?.length || q.type.includes(i.type)) &&
        (!q.minSeverity || rank[i.severity] >= rank[q.minSeverity]),
    );
    filtered.sort(compareAttention);
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {
      CRITICAL: 0,
      WARNING: 0,
      INFO: 0,
    };
    for (const i of filtered) {
      byType[i.type] = (byType[i.type] ?? 0) + 1;
      bySeverity[i.severity]! += 1;
    }
    return {
      generatedAt: now,
      summary: { total: filtered.length, bySeverity, byType },
      items: filtered.slice(0, q.limit ?? 50),
      note: `Each category is read up to ${CAP} rows; ranking rules are documented in docs/PHASE_6A_MANAGEMENT_INTELLIGENCE.md`,
    };
  }

  /**
   * Every current item, unfiltered by caller permissions, for the scheduled alert evaluator. Categories that
   * hit the per-category cap are reported as truncated: a missing item there does not prove it was resolved.
   */
  async snapshot(
    now = this.ctx.now(),
  ): Promise<{ items: AttentionItem[]; truncatedTypes: Set<AttentionType> }> {
    const items = await this.collect(now);
    const counts = new Map<AttentionType, number>();
    for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
    const truncated = new Set<AttentionType>();
    for (const [type, n] of counts) if (n >= CAP) truncated.add(type);
    // delayed and packaging-delayed stages share one query
    if (
      (counts.get('DELAYED_STAGE') ?? 0) +
        (counts.get('PACKAGING_DELAY') ?? 0) >=
      CAP
    ) {
      truncated.add('DELAYED_STAGE');
      truncated.add('PACKAGING_DELAY');
    }
    // payment blocks mix two queries
    return { items, truncatedTypes: truncated };
  }

  /** Same data for the dashboard's top-N, without re-querying per consumer. */
  top(actor: AuthUser, limit = 10) {
    return this.list({ limit }, actor);
  }

  // ───────────────────────── collection ─────────────────────────

  private async collect(now: Date): Promise<AttentionItem[]> {
    const groups = await Promise.all([
      this.blockedStages(now),
      this.delayedStages(now),
      this.overdueJobs(now),
      this.overdueOrders(now),
      this.failedQc(now),
      this.openRework(now),
      this.paymentBlocks(now),
      this.reapproval(now),
      this.unassignedReady(now),
      this.approaching(now),
      this.failedShipments(now),
      this.deliveryDelays(now),
    ]);
    return groups.flat();
  }

  /** Resolves person ids to `{ id, name }` once per category. */
  private async people(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = unique.length
      ? await this.prisma.user.findMany({
          where: { id: { in: unique } },
          select: { id: true, name: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return (id: string | null) => {
      const u = id ? byId.get(id) : undefined;
      return u ? [u] : [];
    };
  }

  private make(
    now: Date,
    base: Omit<AttentionItem, 'score' | 'severity'>,
    extra: { overdueMinutes?: number; minutesLeft?: number } = {},
  ): AttentionItem {
    const score = attentionScore({
      type: base.type,
      priority: base.priority,
      overdueMinutes:
        extra.overdueMinutes ??
        (base.dueAt && base.dueAt < now ? mins(base.dueAt, now) : 0),
      ageMinutes: base.ageMinutes ?? 0,
      minutesLeft: extra.minutesLeft,
      windowMinutes: this.ctx.cfg.deadlineWindowHours * 60,
    });
    return { ...base, score, severity: severityFor(score) };
  }

  /** Order / sample numbers for a set of jobs, in one round trip each. */
  private async numbers(jobs: JobLite[]) {
    const orderIds = [
      ...new Set(jobs.map((j) => j.orderId).filter((x): x is string => !!x)),
    ];
    const sampleIds = [
      ...new Set(jobs.map((j) => j.sampleId).filter((x): x is string => !!x)),
    ];
    const [orders, samples] = await Promise.all([
      orderIds.length
        ? this.prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, orderNumber: true },
          })
        : [],
      sampleIds.length
        ? this.prisma.sample.findMany({
            where: { id: { in: sampleIds } },
            select: { id: true, sampleNumber: true },
          })
        : [],
    ]);
    const o = new Map(orders.map((x) => [x.id, x.orderNumber]));
    const s = new Map(samples.map((x) => [x.id, x.sampleNumber]));
    return (j: JobLite) => ({
      jobId: j.id,
      jobNumber: j.jobNumber,
      ...(j.orderId && { orderId: j.orderId, orderNumber: o.get(j.orderId) }),
      ...(j.sampleId && {
        sampleId: j.sampleId,
        sampleNumber: s.get(j.sampleId),
      }),
    });
  }

  private async stageItems(
    type: AttentionType,
    where: Prisma.JobStageWhereInput,
    now: Date,
    describe: (s: {
      stageName: string;
      status: string;
      blockReason: string | null;
      dueAt: Date | null;
      blockedAt: Date | null;
      readyAt: Date | null;
    }) => {
      reason: string;
      ageFrom: Date | null;
    },
    order: Prisma.JobStageOrderByWithRelationInput[],
  ): Promise<AttentionItem[]> {
    const rows = await this.prisma.jobStage.findMany({
      where,
      orderBy: order,
      take: CAP,
      select: {
        id: true,
        stageName: true,
        status: true,
        departmentType: true,
        blockReason: true,
        dueAt: true,
        blockedAt: true,
        readyAt: true,
        job: { select: jobSelect },
        assignments: assignees,
      },
    });
    const ctxOf = await this.numbers(rows.map((r) => r.job));
    return rows.map((s) => {
      const d = describe(s);
      return this.make(now, {
        type,
        entityType: 'JOB_STAGE',
        entityId: s.id,
        reference: s.job.jobNumber,
        title: `${s.stageName} · ${s.job.productName}`,
        reason: d.reason,
        priority: s.job.priority,
        responsible: {
          department: s.departmentType,
          users: s.assignments.map((a) => a.user),
        },
        ageMinutes: d.ageFrom ? mins(d.ageFrom, now) : null,
        dueAt: s.dueAt ?? s.job.targetCompletionDate,
        context: { ...ctxOf(s.job), stageId: s.id },
      });
    });
  }

  private blockedStages(now: Date) {
    return this.stageItems(
      'BLOCKED_STAGE',
      {
        supersededAt: null,
        status: 'BLOCKED',
        job: { status: { notIn: [...JOB_TERMINAL] } },
      },
      now,
      (s) => ({
        reason: s.blockReason ?? 'The stage is blocked',
        ageFrom: s.blockedAt,
      }),
      [{ job: { priority: 'desc' } }, { blockedAt: 'asc' }],
    );
  }

  private async delayedStages(now: Date) {
    const where: Prisma.JobStageWhereInput = {
      supersededAt: null,
      isOnHold: false,
      status: { in: ['READY', 'IN_PROGRESS'] },
      dueAt: { lt: now },
      job: { status: { notIn: [...JOB_NOT_ACTIVE] } },
    };
    const rows = await this.prisma.jobStage.findMany({
      where,
      orderBy: [{ job: { priority: 'desc' } }, { dueAt: 'asc' }],
      take: CAP,
      select: {
        id: true,
        stageName: true,
        status: true,
        departmentType: true,
        dueAt: true,
        readyAt: true,
        job: { select: jobSelect },
        assignments: assignees,
      },
    });
    const ctxOf = await this.numbers(rows.map((r) => r.job));
    return rows.map((s) => {
      const packaging = s.departmentType === 'PACKAGING';
      return this.make(now, {
        type: packaging ? 'PACKAGING_DELAY' : 'DELAYED_STAGE',
        entityType: 'JOB_STAGE',
        entityId: s.id,
        reference: s.job.jobNumber,
        title: `${s.stageName} is late · ${s.job.productName}`,
        reason: `${s.status === 'READY' ? 'Not started' : 'In progress'} ${Math.round(mins(s.dueAt!, now) / 60)}h past its due date`,
        priority: s.job.priority,
        responsible: {
          department: s.departmentType,
          users: s.assignments.map((a) => a.user),
        },
        ageMinutes: s.readyAt ? mins(s.readyAt, now) : null,
        dueAt: s.dueAt,
        context: { ...ctxOf(s.job), stageId: s.id },
      });
    });
  }

  private async overdueJobs(now: Date) {
    const rows = await this.prisma.factoryJob.findMany({
      where: {
        status: { notIn: [...JOB_NOT_ACTIVE] },
        targetCompletionDate: { lt: now },
      },
      orderBy: [{ priority: 'desc' }, { targetCompletionDate: 'asc' }],
      take: CAP,
      select: { ...jobSelect, createdAt: true, status: true },
    });
    const ctxOf = await this.numbers(rows);
    return rows.map((j) =>
      this.make(now, {
        type: 'OVERDUE_JOB',
        entityType: 'JOB',
        entityId: j.id,
        reference: j.jobNumber,
        title: `${j.jobNumber} is past its target date · ${j.productName}`,
        reason: `Target completion date passed ${Math.round(mins(j.targetCompletionDate!, now) / 60)}h ago; job is ${j.status}`,
        priority: j.priority,
        responsible: { department: null, users: [] },
        ageMinutes: mins(j.createdAt, now),
        dueAt: j.targetCompletionDate,
        context: ctxOf(j),
      }),
    );
  }

  private async overdueOrders(now: Date) {
    const rows = await this.prisma.order.findMany({
      where: {
        status: { in: [...ORDER_DELAYABLE_STATUSES] },
        targetDeliveryDate: { lt: now },
      },
      orderBy: [{ priority: 'desc' }, { targetDeliveryDate: 'asc' }],
      take: CAP,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        priority: true,
        targetDeliveryDate: true,
        confirmedAt: true,
        assignedSalesUserId: true,
      },
    });
    const who = await this.people(rows.map((o) => o.assignedSalesUserId));
    return rows.map((o) =>
      this.make(now, {
        type: 'OVERDUE_ORDER',
        entityType: 'ORDER',
        entityId: o.id,
        reference: o.orderNumber,
        title: `${o.orderNumber} is past its delivery date`,
        reason: `Target delivery date passed ${Math.round(mins(o.targetDeliveryDate!, now) / 24 / 60)} day(s) ago; order is ${o.status}`,
        priority: o.priority,
        responsible: {
          department: 'SALES',
          users: who(o.assignedSalesUserId),
        },
        ageMinutes: o.confirmedAt ? mins(o.confirmedAt, now) : null,
        dueAt: o.targetDeliveryDate,
        context: { orderId: o.id, orderNumber: o.orderNumber },
      }),
    );
  }

  private async failedQc(now: Date) {
    const since = new Date(
      now.getTime() - this.ctx.cfg.qcLookbackHours * 3_600_000,
    );
    const rows = await this.prisma.qcInspection.findMany({
      where: {
        status: 'COMPLETED',
        overallResult: 'FAIL',
        completedAt: { gte: since, lte: now },
        job: { status: { notIn: [...JOB_TERMINAL] } },
      },
      orderBy: [{ job: { priority: 'desc' } }, { completedAt: 'desc' }],
      take: CAP,
      select: {
        id: true,
        completedAt: true,
        failedQuantity: true,
        notes: true,
        jobStage: { select: { stageName: true, departmentType: true } },
        inspector: { select: { id: true, name: true } },
        job: { select: jobSelect },
      },
    });
    const ctxOf = await this.numbers(rows.map((r) => r.job));
    return rows.map((r) =>
      this.make(now, {
        type: 'FAILED_QC',
        entityType: 'QC_INSPECTION',
        entityId: r.id,
        reference: r.job.jobNumber,
        title: `${r.jobStage.stageName} failed · ${r.job.productName}`,
        reason: r.failedQuantity
          ? `${r.failedQuantity} unit(s) failed QC`
          : 'QC inspection failed',
        priority: r.job.priority,
        responsible: {
          department: r.jobStage.departmentType,
          users: [r.inspector],
        },
        ageMinutes: r.completedAt ? mins(r.completedAt, now) : null,
        dueAt: r.job.targetCompletionDate,
        context: ctxOf(r.job),
      }),
    );
  }

  private async openRework(now: Date) {
    const rows = await this.prisma.reworkRecord.findMany({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        job: { status: { notIn: [...JOB_TERMINAL] } },
      },
      orderBy: [{ job: { priority: 'desc' } }, { createdAt: 'asc' }],
      take: CAP,
      select: {
        id: true,
        reason: true,
        affectedQuantity: true,
        createdAt: true,
        targetDefinition: { select: { name: true, departmentType: true } },
        job: { select: jobSelect },
      },
    });
    const ctxOf = await this.numbers(rows.map((r) => r.job));
    return rows.map((r) =>
      this.make(now, {
        type: 'OPEN_REWORK',
        entityType: 'REWORK',
        entityId: r.id,
        reference: r.job.jobNumber,
        title: `Rework → ${r.targetDefinition.name} · ${r.job.productName}`,
        reason: `${r.reason}${r.affectedQuantity ? ` (${r.affectedQuantity} unit(s))` : ''}`,
        priority: r.job.priority,
        responsible: {
          department: r.targetDefinition.departmentType,
          users: [],
        },
        ageMinutes: mins(r.createdAt, now),
        dueAt: r.job.targetCompletionDate,
        context: ctxOf(r.job),
      }),
    );
  }

  /** Confirmed orders the commercial gate keeps from production, and jobs blocked on payment. */
  private async paymentBlocks(now: Date): Promise<AttentionItem[]> {
    const [orders, blockers] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          status: 'CONFIRMED',
          // fully paid orders pass the gate; without a required quotation only quoted orders can fail it
          paymentState: { not: 'PAID' },
          ...(this.config.getOrThrow<AppConfig>('app').orders
            .requireAcceptedQuotation
            ? {}
            : {
                quotations: {
                  some: { versions: { some: { status: 'ACCEPTED' } } },
                },
              }),
        },
        orderBy: [{ priority: 'desc' }, { confirmedAt: 'asc' }],
        take: CAP,
        select: {
          id: true,
          orderNumber: true,
          priority: true,
          confirmedAt: true,
          targetDeliveryDate: true,
          assignedSalesUserId: true,
        },
      }),
      this.prisma.blocker.findMany({
        where: {
          type: 'PAYMENT_PENDING',
          status: 'OPEN',
          job: { status: { notIn: [...JOB_TERMINAL] } },
        },
        orderBy: { createdAt: 'asc' },
        take: CAP,
        select: {
          id: true,
          description: true,
          createdAt: true,
          job: { select: jobSelect },
        },
      }),
    ]);
    const who = await this.people(orders.map((o) => o.assignedSalesUserId));
    const items: AttentionItem[] = [];
    for (const o of orders) {
      const gate = await this.orderCommercial.gate(this.prisma, o.id);
      if (gate.satisfied) continue;
      if (await this.isReapproval(o.id)) continue; // reported as COMMERCIAL_REAPPROVAL_REQUIRED
      items.push(
        this.make(now, {
          type: 'PAYMENT_BLOCK',
          entityType: 'ORDER',
          entityId: o.id,
          reference: o.orderNumber,
          title: `${o.orderNumber} cannot be released for production`,
          reason: gate.reasons[0] ?? 'The commercial gate is not satisfied',
          priority: o.priority,
          responsible: {
            department: 'FINANCE',
            users: who(o.assignedSalesUserId),
          },
          ageMinutes: o.confirmedAt ? mins(o.confirmedAt, now) : null,
          dueAt: o.targetDeliveryDate,
          context: { orderId: o.id, orderNumber: o.orderNumber },
        }),
      );
    }
    const ctxOf = await this.numbers(blockers.map((b) => b.job));
    for (const b of blockers)
      items.push(
        this.make(now, {
          type: 'PAYMENT_BLOCK',
          entityType: 'BLOCKER',
          entityId: b.id,
          reference: b.job.jobNumber,
          title: `${b.job.jobNumber} is blocked on payment`,
          reason: b.description,
          priority: b.job.priority,
          responsible: { department: 'FINANCE', users: [] },
          ageMinutes: mins(b.createdAt, now),
          dueAt: b.job.targetCompletionDate,
          context: ctxOf(b.job),
        }),
      );
    return items;
  }

  private async isReapproval(orderId: string) {
    return (
      (await this.prisma.order.count({
        where: { id: orderId, ...reapprovalOrderWhere },
      })) > 0
    );
  }

  private async reapproval(now: Date) {
    const rows = await this.prisma.order.findMany({
      where: reapprovalOrderWhere,
      take: CAP,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        priority: true,
        commercialRevision: true,
        targetDeliveryDate: true,
        assignedSalesUserId: true,
        quotations: {
          select: {
            versions: {
              where: { invalidatedAt: { not: null } },
              select: { invalidatedAt: true },
            },
          },
        },
      },
    });
    const who = await this.people(rows.map((o) => o.assignedSalesUserId));
    return rows.map((o) => {
      const since = o.quotations
        .flatMap((q) => q.versions.map((v) => v.invalidatedAt!))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return this.make(now, {
        type: 'COMMERCIAL_REAPPROVAL_REQUIRED',
        entityType: 'ORDER',
        entityId: o.id,
        reference: o.orderNumber,
        title: `${o.orderNumber} needs a new quotation`,
        reason: `Revision ${o.commercialRevision} changed the commercial terms; the accepted quotation no longer applies`,
        priority: o.priority,
        responsible: {
          department: 'SALES',
          users: who(o.assignedSalesUserId),
        },
        ageMinutes: since ? mins(since, now) : null,
        dueAt: o.targetDeliveryDate,
        context: { orderId: o.id, orderNumber: o.orderNumber },
      });
    });
  }

  private unassignedReady(now: Date) {
    return this.stageItems(
      'UNASSIGNED_READY_STAGE',
      {
        supersededAt: null,
        isOnHold: false,
        status: 'READY',
        requiresAssignment: true,
        assignments: { none: { removedAt: null } },
        job: { status: { notIn: [...JOB_NOT_ACTIVE] } },
      },
      now,
      (s) => ({
        reason: 'Ready to start but nobody is assigned',
        ageFrom: s.readyAt,
      }),
      [{ job: { priority: 'desc' } }, { readyAt: 'asc' }],
    );
  }

  private async approaching(now: Date): Promise<AttentionItem[]> {
    const end = new Date(
      now.getTime() + this.ctx.cfg.deadlineWindowHours * 3_600_000,
    );
    const window = { gte: now, lte: end };
    const [jobs, orders] = await Promise.all([
      this.prisma.factoryJob.findMany({
        where: {
          status: { notIn: [...JOB_NOT_ACTIVE] },
          targetCompletionDate: window,
        },
        orderBy: [{ priority: 'desc' }, { targetCompletionDate: 'asc' }],
        take: CAP,
        select: { ...jobSelect, createdAt: true },
      }),
      this.prisma.order.findMany({
        where: {
          status: { in: [...ORDER_DELAYABLE_STATUSES] },
          targetDeliveryDate: window,
        },
        orderBy: [{ priority: 'desc' }, { targetDeliveryDate: 'asc' }],
        take: CAP,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          priority: true,
          targetDeliveryDate: true,
          confirmedAt: true,
          assignedSalesUserId: true,
        },
      }),
    ]);
    const who = await this.people(orders.map((o) => o.assignedSalesUserId));
    const ctxOf = await this.numbers(jobs);
    const items: AttentionItem[] = [];
    for (const j of jobs) {
      const left = mins(now, j.targetCompletionDate!);
      items.push(
        this.make(
          now,
          {
            type: 'APPROACHING_DEADLINE',
            entityType: 'JOB',
            entityId: j.id,
            reference: j.jobNumber,
            title: `${j.jobNumber} is due soon · ${j.productName}`,
            reason: `Target completion in ${Math.round(left / 60)}h`,
            priority: j.priority,
            responsible: { department: null, users: [] },
            ageMinutes: mins(j.createdAt, now),
            dueAt: j.targetCompletionDate,
            context: ctxOf(j),
          },
          { minutesLeft: left },
        ),
      );
    }
    for (const o of orders) {
      const left = mins(now, o.targetDeliveryDate!);
      items.push(
        this.make(
          now,
          {
            type: 'APPROACHING_DEADLINE',
            entityType: 'ORDER',
            entityId: o.id,
            reference: o.orderNumber,
            title: `${o.orderNumber} delivery is due soon`,
            reason: `Target delivery in ${Math.round(left / 60)}h; order is ${o.status}`,
            priority: o.priority,
            responsible: {
              department: 'SALES',
              users: who(o.assignedSalesUserId),
            },
            ageMinutes: o.confirmedAt ? mins(o.confirmedAt, now) : null,
            dueAt: o.targetDeliveryDate,
            context: { orderId: o.id, orderNumber: o.orderNumber },
          },
          { minutesLeft: left },
        ),
      );
    }
    return items;
  }

  private async failedShipments(now: Date) {
    const rows = await this.prisma.shipment.findMany({
      where: { status: 'FAILED' },
      orderBy: [{ order: { priority: 'desc' } }, { failedAt: 'asc' }],
      take: CAP,
      select: {
        id: true,
        shipmentNumber: true,
        failureReason: true,
        failedAt: true,
        scheduledAt: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            priority: true,
            targetDeliveryDate: true,
          },
        },
        assignedDeliveryUserId: true,
      },
    });
    const who = await this.people(rows.map((s) => s.assignedDeliveryUserId));
    return rows.map((s) =>
      this.make(now, {
        type: 'SHIPMENT_FAILED',
        entityType: 'SHIPMENT',
        entityId: s.id,
        reference: s.shipmentNumber,
        title: `${s.shipmentNumber} failed delivery · ${s.order.orderNumber}`,
        reason: s.failureReason ?? 'Delivery failed',
        priority: s.order.priority,
        responsible: {
          department: 'DELIVERY',
          users: who(s.assignedDeliveryUserId),
        },
        ageMinutes: s.failedAt ? mins(s.failedAt, now) : null,
        dueAt: s.scheduledAt ?? s.order.targetDeliveryDate,
        context: {
          shipmentId: s.id,
          orderId: s.order.id,
          orderNumber: s.order.orderNumber,
        },
      }),
    );
  }

  private async deliveryDelays(now: Date) {
    const rules = await this.sla.activeRules();
    const clock = await this.calendar.clock();
    const rows = await this.prisma.shipment.findMany({
      where: {
        status: { in: ['READY', 'DISPATCHED', 'IN_TRANSIT'] },
        OR: [
          { scheduledAt: { lt: now } },
          { scheduledAt: null, readyAt: { not: null } },
        ],
      },
      orderBy: [{ order: { priority: 'desc' } }, { readyAt: 'asc' }],
      take: CAP * 2,
      select: {
        id: true,
        shipmentNumber: true,
        status: true,
        scheduledAt: true,
        readyAt: true,
        order: { select: { id: true, orderNumber: true, priority: true } },
        assignedDeliveryUserId: true,
      },
    });
    const who = await this.people(rows.map((s) => s.assignedDeliveryUserId));
    const items: AttentionItem[] = [];
    for (const s of rows) {
      const d = resolveDateOrRuleDeadline(
        s.scheduledAt,
        'SCHEDULED',
        s.readyAt,
        rules.shipment,
        s.order.priority,
        now,
        clock,
      );
      if (!d.deadline || d.deadline >= now) continue;
      items.push(
        this.make(now, {
          type: 'DELIVERY_DELAY',
          entityType: 'SHIPMENT',
          entityId: s.id,
          reference: s.shipmentNumber,
          title: `${s.shipmentNumber} is late · ${s.order.orderNumber}`,
          reason: `${s.status} and ${Math.round(mins(d.deadline, now) / 60)}h past its ${d.source === 'SCHEDULED' ? 'scheduled date' : 'SLA'}`,
          priority: s.order.priority,
          responsible: {
            department: 'DELIVERY',
            users: who(s.assignedDeliveryUserId),
          },
          ageMinutes: s.readyAt ? mins(s.readyAt, now) : null,
          dueAt: d.deadline,
          context: {
            shipmentId: s.id,
            orderId: s.order.id,
            orderNumber: s.order.orderNumber,
          },
        }),
      );
    }
    return items.slice(0, CAP);
  }
}

export { ATTENTION_TYPES };
