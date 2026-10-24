import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  ResponsibilityRulesService,
  type Resolution,
} from './responsibility-rules.service.js';
import type { UserRefDto } from './dto/responsibility.dto.js';

export type AssignmentSourceView =
  'GLOBAL_DEFAULT' | 'CUSTOMER_OVERRIDE' | 'MANUAL' | 'UNASSIGNED';

export interface StageProcessItem {
  stageId: string;
  stageKey: string;
  label: string;
  sequence: number;
  attempt: number;
  departmentType: string;
  status: string;
  isOnHold: boolean;
  /** The primary owner of the stage right now (actual assignment, not the default rule). */
  responsibleUser: UserRefDto | null;
  additionalUsers: UserRefDto[];
  assignmentSource: AssignmentSourceView;
  assignedAt: Date | null;
  readyAt: Date | null;
  startedAt: Date | null;
  startedBy: UserRefDto | null;
  completedAt: Date | null;
  completedBy: UserRefDto | null;
  /** Completed: completedAt - startedAt. In progress: elapsed so far. Otherwise null. */
  durationMinutes: number | null;
  dueAt: Date | null;
  blocker: {
    active: boolean;
    reason: string | null;
    type: string | null;
    since: Date | null;
  };
  /** Completed stages only: who the work went to next (derived from real stage state). */
  handoff: {
    toStageKey: string;
    toLabel: string;
    toStatus: string;
    toUser: UserRefDto | null;
  } | null;
}

export interface NextStageView {
  stageKey: string;
  label: string;
  status: string;
  responsibleUser: UserRefDto | null;
}

export type Attention =
  'BLOCKED' | 'OVERDUE' | 'IN_PROGRESS' | 'READY' | 'PLANNED';

export interface JobProcess {
  jobId: string;
  jobNumber: string;
  jobStatus: string;
  priority: string;
  sourceType: string;
  referenceType: 'SAMPLE' | 'ORDER';
  referenceId: string;
  referenceNumber: string;
  batchNumber: string | null;
  customerId: string;
  productName: string;
  targetCompletionDate: Date | null;
  attention: Attention;
  currentStage: StageProcessItem | null;
  nextStage: NextStageView | null;
  /** The most recently completed stage, with the handoff to whoever has the work now. */
  lastCompleted: StageProcessItem | null;
  /** Every stage that is READY, in progress or blocked (parallel branches). */
  activeStages: StageProcessItem[];
  progress: { completedStages: number; totalStages: number; percent: number };
  blocker: { active: boolean; reason: string | null };
  stages: StageProcessItem[];
}

const PRIORITY_RANK: Record<string, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};
const ATTENTION_RANK: Record<Attention, number> = {
  BLOCKED: 0,
  OVERDUE: 1,
  IN_PROGRESS: 2,
  READY: 3,
  PLANNED: 4,
};
const CURRENT_ORDER = ['IN_PROGRESS', 'BLOCKED', 'READY', 'WAITING'];
const LIVE_JOB_STATUSES = [
  'PLANNED',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
  'ON_HOLD',
] as const;
const ACTIVE_SAMPLE_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'QUOTED',
  'AWAITING_PAYMENT',
  'READY_FOR_PRODUCTION',
  'IN_PRODUCTION',
  'AWAITING_APPROVAL',
  'ON_HOLD',
] as const;
const INACTIVE_ORDER_STATUSES = [
  'DRAFT',
  'COMPLETED',
  'DELIVERED',
  'CANCELLED',
] as const;

const jobInclude = {
  stages: {
    where: { supersededAt: null },
    orderBy: [{ sequence: 'asc' }, { attempt: 'desc' }],
    include: {
      assignments: {
        where: { removedAt: null },
        orderBy: { assignedAt: 'asc' },
        include: { user: { select: { id: true, name: true } } },
      },
    },
  },
  blockers: {
    where: { status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    select: {
      jobStageId: true,
      type: true,
      description: true,
      createdAt: true,
    },
  },
} satisfies Prisma.FactoryJobInclude;

type JobRow = Prisma.FactoryJobGetPayload<{ include: typeof jobInclude }>;

const minutes = (a: Date, b: Date) =>
  Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

/**
 * Read-only operational projections built from real production data (stages, assignments, blockers and the
 * job activity log). Staff names live here: this is ADMIN/STAFF data and must never reach the customer portal.
 */
@Injectable()
export class ProcessProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: ResponsibilityRulesService,
  ) {}

  // ───────────────────────── building blocks ─────────────────────────

  /** Jobs matching `where`, projected and sorted (blocked, overdue, in progress, ready, planned). */
  async jobs(where: Prisma.FactoryJobWhereInput): Promise<JobProcess[]> {
    const rows = await this.prisma.factoryJob.findMany({
      where,
      include: jobInclude,
    });
    if (rows.length === 0) return [];
    const jobIds = rows.map((r) => r.id);
    const stageIds = rows.flatMap((r) => r.stages.map((s) => s.id));

    const [events, orders, samples, batches] = await Promise.all([
      this.prisma.jobActivity.findMany({
        where: {
          jobId: { in: jobIds },
          jobStageId: { in: stageIds },
          type: { in: ['STAGE_STARTED', 'STAGE_COMPLETED'] },
          actorUserId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { jobStageId: true, type: true, actorUserId: true },
      }),
      this.prisma.order.findMany({
        where: {
          id: {
            in: rows.map((r) => r.orderId).filter((x): x is string => !!x),
          },
        },
        select: { id: true, orderNumber: true },
      }),
      this.prisma.sample.findMany({
        where: {
          id: {
            in: rows.map((r) => r.sampleId).filter((x): x is string => !!x),
          },
        },
        select: { id: true, sampleNumber: true },
      }),
      this.prisma.orderBatch.findMany({
        where: {
          id: {
            in: rows.map((r) => r.orderBatchId).filter((x): x is string => !!x),
          },
        },
        select: { id: true, batchNumber: true },
      }),
    ]);
    const actorIds = [...new Set(events.map((e) => e.actorUserId!))];
    const actors = await this.rules.userRefs(actorIds);
    // newest first, so the first hit per stage and type is the latest
    const startedBy = new Map<string, string>();
    const completedBy = new Map<string, string>();
    for (const e of events) {
      const bucket = e.type === 'STAGE_STARTED' ? startedBy : completedBy;
      if (e.jobStageId && !bucket.has(e.jobStageId)) {
        bucket.set(e.jobStageId, e.actorUserId!);
      }
    }
    const orderNo = new Map(orders.map((o) => [o.id, o.orderNumber]));
    const sampleNo = new Map(samples.map((s) => [s.id, s.sampleNumber]));
    const batchNo = new Map(batches.map((b) => [b.id, b.batchNumber]));
    const now = new Date();

    const out = rows.map((r) =>
      this.project(r, {
        now,
        startedBy,
        completedBy,
        actors,
        referenceNumber: r.orderId
          ? (orderNo.get(r.orderId) ?? '')
          : (sampleNo.get(r.sampleId ?? '') ?? ''),
        batchNumber: r.orderBatchId
          ? (batchNo.get(r.orderBatchId) ?? null)
          : null,
      }),
    );
    return out.sort(
      (a, b) =>
        ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention] ||
        (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
        a.jobNumber.localeCompare(b.jobNumber),
    );
  }

  private project(
    job: JobRow,
    ctx: {
      now: Date;
      startedBy: Map<string, string>;
      completedBy: Map<string, string>;
      actors: Map<string, UserRefDto>;
      referenceNumber: string;
      batchNumber: string | null;
    },
  ): JobProcess {
    const openBlockers = job.blockers;
    const blockerOf = (stageId: string) =>
      openBlockers.find((b) => b.jobStageId === stageId) ??
      openBlockers.find((b) => b.jobStageId === null) ??
      null;
    const ref = (id: string | undefined): UserRefDto | null =>
      id ? (ctx.actors.get(id) ?? null) : null;

    const items: StageProcessItem[] = job.stages.map((s) => {
      const primary =
        s.assignments.find((a) => a.isPrimary) ?? s.assignments[0];
      const open = ['READY', 'IN_PROGRESS', 'BLOCKED', 'WAITING'].includes(
        s.status,
      );
      const blocker = open ? blockerOf(s.id) : null;
      const stageBlocked = s.status === 'BLOCKED' || (!!blocker && open);
      return {
        stageId: s.id,
        stageKey: s.stageCode,
        label: s.stageName,
        sequence: s.sequence,
        attempt: s.attempt,
        departmentType: s.departmentType,
        status: s.status,
        isOnHold: s.isOnHold,
        responsibleUser: primary ? primary.user : null,
        additionalUsers: s.assignments
          .filter((a) => a !== primary)
          .map((a) => a.user),
        assignmentSource: primary ? primary.source : 'UNASSIGNED',
        assignedAt: primary?.assignedAt ?? null,
        readyAt: s.readyAt,
        startedAt: s.startedAt,
        startedBy: ref(ctx.startedBy.get(s.id)),
        completedAt: s.completedAt,
        completedBy: ref(ctx.completedBy.get(s.id)),
        durationMinutes:
          s.startedAt && s.completedAt
            ? minutes(s.startedAt, s.completedAt)
            : s.startedAt && s.status === 'IN_PROGRESS'
              ? minutes(s.startedAt, ctx.now)
              : null,
        dueAt: s.dueAt,
        blocker: {
          active: stageBlocked,
          reason: blocker?.description ?? s.blockReason ?? null,
          type: blocker?.type ?? null,
          since: s.blockedAt ?? blocker?.createdAt ?? null,
        },
        handoff: null,
      };
    });

    const isDone = (st: string) => st === 'COMPLETED' || st === 'SKIPPED';
    const live = items.filter((i) => i.status !== 'CANCELLED');
    const nextAfter = (seq: number) =>
      live.find(
        (i) => i.sequence > seq && !isDone(i.status) && i.status !== 'FAILED',
      ) ?? null;
    for (const i of items) {
      if (i.status === 'COMPLETED') {
        const n = nextAfter(i.sequence);
        if (n) {
          i.handoff = {
            toStageKey: n.stageKey,
            toLabel: n.label,
            toStatus: n.status,
            toUser: n.responsibleUser,
          };
        }
      }
    }

    const jobDone = job.status === 'COMPLETED' || job.status === 'CANCELLED';
    const current = jobDone
      ? null
      : (CURRENT_ORDER.map((st) => live.find((i) => i.status === st)).find(
          (x) => !!x,
        ) ?? null);
    const next = current ? nextAfter(current.sequence) : null;
    const completed = live.filter((i) => i.status === 'COMPLETED');
    const lastCompleted =
      [...completed].sort(
        (a, b) =>
          (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
      )[0] ?? null;
    const totalStages = live.length;
    const completedStages = live.filter((i) => isDone(i.status)).length;
    const jobBlocker = openBlockers[0] ?? null;
    const blockedNow =
      job.status === 'BLOCKED' ||
      openBlockers.length > 0 ||
      !!current?.blocker.active;
    const overdue =
      !jobDone &&
      ((job.targetCompletionDate !== null &&
        job.targetCompletionDate < ctx.now) ||
        (!!current?.dueAt && current.dueAt < ctx.now));
    const attention: Attention = blockedNow
      ? 'BLOCKED'
      : overdue
        ? 'OVERDUE'
        : current?.status === 'IN_PROGRESS'
          ? 'IN_PROGRESS'
          : current?.status === 'READY'
            ? 'READY'
            : 'PLANNED';

    return {
      jobId: job.id,
      jobNumber: job.jobNumber,
      jobStatus: job.status,
      priority: job.priority,
      sourceType: job.sourceType,
      referenceType: job.orderId ? 'ORDER' : 'SAMPLE',
      referenceId: (job.orderId ?? job.sampleId)!,
      referenceNumber: ctx.referenceNumber,
      batchNumber: ctx.batchNumber,
      customerId: job.customerId,
      productName: job.productName,
      targetCompletionDate: job.targetCompletionDate,
      attention,
      currentStage: current,
      nextStage: next && {
        stageKey: next.stageKey,
        label: next.label,
        status: next.status,
        responsibleUser: next.responsibleUser,
      },
      lastCompleted,
      activeStages: live.filter((i) =>
        ['READY', 'IN_PROGRESS', 'BLOCKED'].includes(i.status),
      ),
      progress: {
        completedStages,
        totalStages,
        percent: totalStages
          ? Math.round((completedStages / totalStages) * 100)
          : 0,
      },
      blocker: {
        active: blockedNow,
        reason: blockedNow
          ? (current?.blocker.reason ??
            jobBlocker?.description ??
            job.holdReason ??
            null)
          : null,
      },
      stages: items,
    };
  }

  /** The compact shape lists use: no stage timeline. */
  compact(p: JobProcess) {
    const {
      stages: _stages,
      activeStages: _active,
      lastCompleted: _last,
      ...rest
    } = p;
    const c = p.currentStage;
    return {
      ...rest,
      currentStage: c && {
        stageKey: c.stageKey,
        label: c.label,
        status: c.status,
        responsibleUser: c.responsibleUser,
        assignmentSource: c.assignmentSource,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        durationMinutes: c.durationMinutes,
      },
    };
  }

  // ───────────────────────── views ─────────────────────────

  async forJob(jobId: string) {
    const [p] = await this.jobs({ id: jobId });
    if (!p) throw new NotFoundException('Job not found');
    return p;
  }

  async forOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerId: true,
        assignedSalesUserId: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const owner = order.assignedSalesUserId
      ? ((await this.rules.userRefs([order.assignedSalesUserId])).get(
          order.assignedSalesUserId,
        ) ?? null)
      : null;
    const jobs = await this.jobs({ orderId, status: { not: 'CANCELLED' } });
    return {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        customerId: order.customerId,
        salesOwner: owner,
      },
      jobs,
      progress: this.mergeProgress(jobs),
    };
  }

  async forSample(sampleId: string) {
    const sample = await this.prisma.sample.findUnique({
      where: { id: sampleId },
      select: {
        id: true,
        sampleNumber: true,
        status: true,
        paymentState: true,
        customerId: true,
        assignedSales: { select: { id: true, name: true } },
      },
    });
    if (!sample) throw new NotFoundException('Sample not found');
    const jobs = await this.jobs({ sampleId, status: { not: 'CANCELLED' } });
    return {
      sample: {
        id: sample.id,
        sampleNumber: sample.sampleNumber,
        status: sample.status,
        paymentState: sample.paymentState,
        customerId: sample.customerId,
        salesOwner: sample.assignedSales,
      },
      jobs,
      progress: this.mergeProgress(jobs),
    };
  }

  private mergeProgress(jobs: JobProcess[]) {
    const total = jobs.reduce((s, j) => s + j.progress.totalStages, 0);
    const done = jobs.reduce((s, j) => s + j.progress.completedStages, 0);
    return {
      completedStages: done,
      totalStages: total,
      percent: total ? Math.round((done / total) * 100) : 0,
    };
  }

  async forCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        customerNumber: true,
        displayName: true,
        status: true,
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const [jobs, samples, orders] = await Promise.all([
      this.jobs({ customerId, status: { in: [...LIVE_JOB_STATUSES] } }),
      this.prisma.sample.findMany({
        where: { customerId, status: { in: [...ACTIVE_SAMPLE_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          sampleNumber: true,
          status: true,
          assignedSales: { select: { id: true, name: true } },
        },
      }),
      this.prisma.order.findMany({
        where: { customerId, status: { notIn: [...INACTIVE_ORDER_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          assignedSalesUserId: true,
        },
      }),
    ]);
    const orderOwners = await this.rules.userRefs(
      orders.map((o) => o.assignedSalesUserId).filter((x): x is string => !!x),
    );
    const jobNumbersBy = (key: 'SAMPLE' | 'ORDER') => {
      const m = new Map<string, string[]>();
      for (const j of jobs.filter((x) => x.referenceType === key)) {
        m.set(j.referenceId, [...(m.get(j.referenceId) ?? []), j.jobNumber]);
      }
      return m;
    };
    const sj = jobNumbersBy('SAMPLE');
    const oj = jobNumbersBy('ORDER');
    return {
      customer,
      activeSamples: samples.map((s) => ({
        id: s.id,
        sampleNumber: s.sampleNumber,
        status: s.status,
        salesOwner: s.assignedSales,
        jobNumbers: sj.get(s.id) ?? [],
      })),
      activeOrders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        salesOwner: orderOwners.get(o.assignedSalesUserId ?? '') ?? null,
        jobNumbers: oj.get(o.id) ?? [],
      })),
      currentWork: jobs.map((j) => this.compact(j)),
    };
  }

  // ───────────────────────── customer list summaries ─────────────────────────

  /**
   * Responsibility and current-process summaries for a page of customers in a fixed number of queries
   * (rules, sales owners, live jobs): nothing is fetched per customer.
   */
  async customerSummaries(customerIds: string[]) {
    const out = new Map<
      string,
      {
        responsibilitySummary: ReturnType<
          ProcessProjectionService['responsibilityOf']
        >;
        currentProcess: ReturnType<
          ProcessProjectionService['currentOf']
        > | null;
        activeJobCount: number;
        currentProcesses: ReturnType<ProcessProjectionService['currentOf']>[];
      }
    >();
    if (customerIds.length === 0) return out;
    const areas = await this.rules.areas();
    const [resolved, owners, jobs] = await Promise.all([
      this.rules.resolveMany(customerIds, areas),
      this.rules.salesOwners(customerIds),
      this.jobs({
        customerId: { in: customerIds },
        status: { in: [...LIVE_JOB_STATUSES] },
      }),
    ]);
    const userIds = [
      ...new Set(
        [...resolved.values()].flatMap((m) =>
          [...m.values()]
            .map((r) => r.effectiveUserId)
            .filter((x): x is string => !!x),
        ),
      ),
    ];
    const users = await this.rules.userRefs(userIds);
    const byCustomer = new Map<string, JobProcess[]>();
    for (const j of jobs) {
      byCustomer.set(j.customerId, [
        ...(byCustomer.get(j.customerId) ?? []),
        j,
      ]);
    }
    for (const id of customerIds) {
      const mine = byCustomer.get(id) ?? []; // already sorted by attention, priority, number
      out.set(id, {
        responsibilitySummary: this.responsibilityOf(
          resolved.get(id)!,
          areas,
          users,
          owners.get(id) ?? null,
        ),
        currentProcess: mine[0] ? this.currentOf(mine[0]) : null,
        activeJobCount: mine.length,
        currentProcesses: mine.slice(0, 5).map((j) => this.currentOf(j)),
      });
    }
    return out;
  }

  private responsibilityOf(
    resolution: Map<string, Resolution>,
    areas: Array<{ stageKey: string; label: string }>,
    users: Map<string, UserRefDto>,
    salesOwner: (UserRefDto & { referenceNumber: string }) | null,
  ) {
    const list = areas.map((a) => {
      const r = resolution.get(a.stageKey)!;
      return {
        stageKey: a.stageKey,
        label: a.label,
        user: r.effectiveUserId ? (users.get(r.effectiveUserId) ?? null) : null,
        source: r.source,
        health: r.health,
      };
    });
    return {
      salesOwner: salesOwner && { id: salesOwner.id, name: salesOwner.name },
      areas: list,
      configuredCount: list.filter((a) => a.user).length,
      totalAreas: list.length,
      needsAttention: list.some((a) => a.health === 'NEEDS_ATTENTION'),
    };
  }

  private currentOf(j: JobProcess) {
    const c = j.currentStage;
    return {
      referenceType: j.referenceType,
      referenceNumber: j.referenceNumber,
      jobNumber: j.jobNumber,
      stage: c?.stageKey ?? null,
      stageLabel: c?.label ?? null,
      status: c?.status ?? j.jobStatus,
      attention: j.attention,
      responsibleUser: c?.responsibleUser ?? null,
      startedAt: c?.startedAt ?? null,
      progressPercent: j.progress.percent,
      blocked: j.blocker.active,
    };
  }
}
