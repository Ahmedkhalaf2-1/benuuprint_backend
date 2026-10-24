import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { ManagementContext } from './management-context.service.js';
import {
  computeJobEta,
  lowestQuality,
  type DataQuality,
  type EtaStageInput,
  type JobEtaResult,
} from './pure/eta.js';
import { num } from './sql.js';

const MAX_JOBS = 200;

export interface JobEtaView extends JobEtaResult {
  jobId: string;
  jobNumber: string;
  status: string;
  targetCompletionDate: Date | null;
  projectedLate: boolean;
  projectedLateMinutes: number;
}

@Injectable()
export class EtaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
    private readonly calendar: CalendarService,
  ) {}

  private async history(now: Date) {
    const since = new Date(
      now.getTime() - this.ctx.cfg.etaHistoryDays * 86_400_000,
    );
    const rows = await this.prisma.$queryRaw<
      { id: string; avg: Prisma.Decimal; n: number }[]
    >(Prisma.sql`
      SELECT stage_definition_id::text AS id,
             AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0) AS avg, COUNT(*)::int AS n
      FROM job_stages
      WHERE status = 'COMPLETED' AND started_at IS NOT NULL AND completed_at > started_at
        AND completed_at >= ${since} AND completed_at <= ${now}
      GROUP BY stage_definition_id`);
    return new Map(
      rows.map((r) => [r.id, { avg: Number(r.avg), n: num(r.n) }]),
    );
  }

  /** Queue ahead of each READY stage: other released stages of the same definition that started or became ready first. */
  private async queueAhead(stageIds: string[]) {
    if (stageIds.length === 0) return new Map<string, number>();
    const rows = await this.prisma.$queryRaw<
      { id: string; ahead: number }[]
    >(Prisma.sql`
      SELECT a.id::text AS id, COUNT(b.id)::int AS ahead
      FROM job_stages a
      JOIN job_stages b ON b.stage_definition_id = a.stage_definition_id AND b.id <> a.id
        AND b.superseded_at IS NULL AND NOT b.is_on_hold
        AND (b.status = 'IN_PROGRESS'
             OR (b.status = 'READY' AND (b.ready_at < a.ready_at OR (b.ready_at = a.ready_at AND b.id < a.id))))
      JOIN factory_jobs fj ON fj.id = b.job_id AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD')
      WHERE a.status = 'READY' AND a.id IN (${Prisma.join(stageIds.map((i) => Prisma.sql`${i}::uuid`))})
      GROUP BY a.id`);
    return new Map(rows.map((r) => [r.id, num(r.ahead)]));
  }

  /** Workers able to take a stage: eligible staff of its definition (else the people currently assigned), at least 1. */
  private async workers(defIds: string[]) {
    const defs = await this.prisma.productionStageDefinition.findMany({
      where: { id: { in: defIds } },
      select: { id: true, eligibleRoleCodes: true },
    });
    const out = new Map<string, number>();
    for (const d of defs) {
      let n = 0;
      if (d.eligibleRoleCodes.length)
        n = await this.prisma.user.count({
          where: {
            deletedAt: null,
            isActive: true,
            roles: { some: { role: { code: { in: d.eligibleRoleCodes } } } },
          },
        });
      else {
        const assigned = await this.prisma.stageAssignment.findMany({
          where: {
            removedAt: null,
            jobStage: { stageDefinitionId: d.id, supersededAt: null },
          },
          distinct: ['userId'],
          select: { userId: true },
        });
        n = assigned.length;
      }
      out.set(d.id, Math.max(1, n));
    }
    return out;
  }

  async forJobs(
    jobIds: string[],
    now = this.ctx.now(),
  ): Promise<Map<string, JobEtaView>> {
    const out = new Map<string, JobEtaView>();
    if (jobIds.length === 0) return out;
    const jobs = await this.prisma.factoryJob.findMany({
      where: { id: { in: jobIds.slice(0, MAX_JOBS) } },
      select: {
        id: true,
        jobNumber: true,
        status: true,
        completedAt: true,
        targetCompletionDate: true,
        stages: {
          where: { supersededAt: null },
          select: {
            id: true,
            stageDefinitionId: true,
            stageCode: true,
            stageName: true,
            status: true,
            startedAt: true,
            expectedDurationMinutes: true,
            dependsOn: { select: { dependsOnJobStageId: true } },
          },
        },
        blockers: {
          where: { status: 'OPEN' },
          select: { type: true, createdAt: true },
        },
      },
    });
    const clock = await this.calendar.clock();
    const live = jobs.filter(
      (j) => !['COMPLETED', 'CANCELLED'].includes(j.status),
    );
    const stageIds = live.flatMap((j) =>
      j.stages.filter((s) => s.status === 'READY').map((s) => s.id),
    );
    const defIds = [
      ...new Set(live.flatMap((j) => j.stages.map((s) => s.stageDefinitionId))),
    ];
    const [hist, ahead, workers] = await Promise.all([
      this.history(now),
      this.queueAhead(stageIds),
      defIds.length ? this.workers(defIds) : new Map<string, number>(),
    ]);
    for (const j of jobs) {
      const stages: EtaStageInput[] = j.stages.map((s) => {
        const h = hist.get(s.stageDefinitionId);
        return {
          id: s.id,
          stageCode: s.stageCode,
          stageName: s.stageName,
          status: s.status,
          startedAt: s.startedAt,
          dependsOn: s.dependsOn.map((d) => d.dependsOnJobStageId),
          historicalAverageMinutes: h?.avg ?? null,
          historicalSamples: h?.n ?? 0,
          expectedDurationMinutes: s.expectedDurationMinutes,
          stagesAhead: ahead.get(s.id) ?? 0,
          workers: workers.get(s.stageDefinitionId) ?? 1,
        };
      });
      const eta = computeJobEta({
        now,
        jobStatus: j.status,
        completedAt: j.completedAt,
        stages,
        openBlockers: j.blockers,
        minSamples: this.ctx.cfg.etaMinSamples,
        clock,
      });
      const late =
        !!eta.estimatedCompletionAt &&
        !!j.targetCompletionDate &&
        j.status !== 'COMPLETED' &&
        eta.estimatedCompletionAt > j.targetCompletionDate;
      out.set(j.id, {
        ...eta,
        jobId: j.id,
        jobNumber: j.jobNumber,
        status: j.status,
        targetCompletionDate: j.targetCompletionDate,
        projectedLate: late,
        projectedLateMinutes: late
          ? Math.round(
              (eta.estimatedCompletionAt!.getTime() -
                j.targetCompletionDate!.getTime()) /
                60_000,
            )
          : 0,
      });
    }
    return out;
  }

  async job(id: string) {
    const now = this.ctx.now();
    const view = (await this.forJobs([id], now)).get(id);
    if (!view) throw new NotFoundException('Job not found');
    return {
      generatedAt: now,
      ...view,
      persisted: false,
      note: 'Computed on request and not stored; see docs for the algorithm and data-quality meaning',
    };
  }

  /** Production ETA (from jobs) kept apart from delivery ETA (only from shipment data). */
  async order(id: string) {
    const now = this.ctx.now();
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        targetDeliveryDate: true,
        deliveredAt: true,
        jobs: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            orderBatchId: true,
            orderBatch: { select: { batchNumber: true } },
          },
        },
        batches: {
          where: { status: { not: 'CANCELLED' } },
          select: { quantity: true },
        },
        shipments: {
          where: { status: { notIn: ['CANCELLED', 'RETURNED'] } },
          select: { status: true, scheduledAt: true, deliveredAt: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const [etas, total] = await Promise.all([
      this.forJobs(
        order.jobs.map((j) => j.id),
        now,
      ),
      this.prisma.orderVariant.aggregate({
        where: { item: { orderId: id } },
        _sum: { quantity: true },
      }),
    ]);
    const batchOf = new Map(
      order.jobs.map((j) => [j.id, j.orderBatch?.batchNumber ?? null]),
    );
    const jobs = [...etas.values()].map((e) => ({
      jobId: e.jobId,
      jobNumber: e.jobNumber,
      batchNumber: batchOf.get(e.jobId) ?? null,
      status: e.status,
      estimatedCompletionAt: e.estimatedCompletionAt,
      dataQuality: e.dataQuality,
      blocked: e.blocked,
    }));
    // a job without a batch covers the whole order; otherwise units must sit in a batch to be planned
    const wholeOrderJob = order.jobs.some((j) => !j.orderBatchId);
    const unplanned = wholeOrderJob
      ? 0
      : Math.max(
          0,
          (total._sum.quantity ?? 0) -
            order.batches.reduce((n, b) => n + b.quantity, 0),
        );
    const basis: string[] = [];
    const etaTimes = jobs
      .map((j) => j.estimatedCompletionAt)
      .filter((d): d is Date => !!d);
    let productionEta: Date | null = etaTimes.length
      ? new Date(Math.max(...etaTimes.map((d) => d.getTime())))
      : null;
    const qualities: DataQuality[] = jobs.map((j) => j.dataQuality);
    if (jobs.length === 0) {
      basis.push('The order has no production jobs yet');
      qualities.push('LOW');
    } else {
      const slowest = jobs.find(
        (j) =>
          j.estimatedCompletionAt &&
          j.estimatedCompletionAt.getTime() === productionEta?.getTime(),
      );
      basis.push(
        `${jobs.length} job${jobs.length === 1 ? '' : 's'}; the slowest is ${slowest?.jobNumber ?? '—'}${slowest?.batchNumber ? ` (${slowest.batchNumber})` : ''}`,
      );
      basis.push(
        'Packaging is included through the packaging stages of each job',
      );
    }
    if (unplanned > 0) {
      basis.push(
        `${unplanned} unit(s) are not in any batch yet and are not estimated`,
      );
      qualities.push('LOW');
    }
    const productionDone = [
      'PRODUCTION_COMPLETED',
      'READY_FOR_PACKAGING',
      'PACKAGING',
      'READY_FOR_DELIVERY',
      'PARTIALLY_SHIPPED',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'COMPLETED',
    ].includes(order.status);
    if (productionDone && unplanned === 0 && jobs.length)
      basis.push('Production is complete; this is the actual completion time');

    const open = order.shipments.filter(
      (s) => !['DELIVERED'].includes(s.status),
    );
    const scheduled = open
      .map((s) => s.scheduledAt)
      .filter((d): d is Date => !!d);
    let deliveryEta: Date | null = null;
    const deliveryBasis: string[] = [];
    if (order.deliveredAt) {
      deliveryEta = order.deliveredAt;
      deliveryBasis.push('Delivered: this is the actual delivery time');
    } else if (open.length && scheduled.length === open.length) {
      deliveryEta = new Date(Math.max(...scheduled.map((d) => d.getTime())));
      deliveryBasis.push('Latest scheduled date of the open shipments');
    } else {
      deliveryBasis.push(
        open.length
          ? 'Some open shipments have no scheduled date; delivery time is not estimated'
          : 'No shipment exists yet; delivery time is not estimated',
      );
    }
    productionEta = productionEta ?? null;
    return {
      generatedAt: now,
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      targetDeliveryDate: order.targetDeliveryDate,
      production: {
        estimatedCompletionAt: productionEta,
        dataQuality: lowestQuality(qualities),
        unplannedUnits: unplanned,
        projectedLateAgainstTarget:
          !!productionEta &&
          !!order.targetDeliveryDate &&
          !productionDone &&
          productionEta > order.targetDeliveryDate,
        jobs,
        basis,
      },
      delivery: { estimatedAt: deliveryEta, basis: deliveryBasis },
      persisted: false,
    };
  }
}
