import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { isStageDelayed } from '../factory/pure/job-stage-state-machine.js';
import { StageQuantityService } from '../factory/stage-quantity.service.js';
import type {
  JobProgressDto,
  OrderBatchResponseDto,
  OrderJobSummaryDto,
  ProductionSummaryDto,
  StageProgressDto,
} from './dto/order.dto.js';
import { variantNames } from './order-lookups.js';
import { progressPercent } from './pure/order-production.js';

type BatchRow = Prisma.OrderBatchGetPayload<{
  include: { allocations: true };
}>;

export const toJobSummary = (
  j: Prisma.FactoryJobGetPayload<{
    include: { orderBatch: { select: { batchNumber: true } } };
  }>,
): OrderJobSummaryDto => ({
  id: j.id,
  jobNumber: j.jobNumber,
  sourceType: j.sourceType,
  status: j.status,
  orderBatchId: j.orderBatchId,
  batchNumber: j.orderBatch?.batchNumber ?? null,
  plannedQuantity: j.plannedQuantity,
  completedQuantity: j.completedQuantity,
  rejectedQuantity: j.rejectedQuantity,
});

@Injectable()
export class OrderSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quantities: StageQuantityService,
  ) {}

  async batchDtos(batches: BatchRow[]): Promise<OrderBatchResponseDto[]> {
    if (batches.length === 0) return [];
    const variantIds = [
      ...new Set(
        batches.flatMap((b) => b.allocations.map((a) => a.orderVariantId)),
      ),
    ];
    const variants = await this.prisma.orderVariant.findMany({
      where: { id: { in: variantIds } },
    });
    const names = await variantNames(this.prisma, variants);
    const jobs = await this.prisma.factoryJob.findMany({
      where: {
        orderBatchId: { in: batches.map((b) => b.id) },
        status: { not: 'CANCELLED' },
      },
      include: { orderBatch: { select: { batchNumber: true } } },
    });
    const jobFor = new Map(jobs.map((j) => [j.orderBatchId, j]));
    return batches.map((b) => {
      const job = jobFor.get(b.id);
      return {
        id: b.id,
        batchNumber: b.batchNumber,
        orderId: b.orderId,
        status: b.status,
        quantity: b.quantity,
        targetStartDate: b.targetStartDate,
        targetCompletionDate: b.targetCompletionDate,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
        holdReason: b.holdReason,
        cancelReason: b.cancelReason,
        allocations: b.allocations.map((a) => ({
          orderVariantId: a.orderVariantId,
          label: names.get(a.orderVariantId)?.label ?? 'Variant',
          quantity: a.quantity,
        })),
        job: job ? toJobSummary(job) : null,
        createdAt: b.createdAt,
      };
    });
  }

  async build(orderId: string): Promise<ProductionSummaryDto> {
    const now = new Date();
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { variants: { select: { quantity: true } } } },
        batches: {
          include: { allocations: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const total = order.items.reduce(
      (s, i) => s + i.variants.reduce((x, v) => x + v.quantity, 0),
      0,
    );
    const jobs = await this.prisma.factoryJob.findMany({
      where: { orderId, status: { not: 'CANCELLED' } },
      include: {
        orderBatch: { select: { batchNumber: true } },
        stages: { where: { supersededAt: null }, orderBy: { sequence: 'asc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const jobProgress: JobProgressDto[] = [];
    for (const job of jobs) {
      const progress: (StageProgressDto & { sequence: number })[] = [];
      for (const stage of job.stages) {
        const q = await this.quantities.summary(this.prisma, stage, job);
        progress.push({
          sequence: stage.sequence,
          stageCode: stage.stageCode,
          stageName: stage.stageName,
          status: stage.status,
          required: q?.required ?? null,
          accounted: q ? q.produced + q.rejected : null,
          isDelayed: isStageDelayed(stage, now),
        });
      }
      const strip = ({ sequence: _s, ...rest }: (typeof progress)[number]) =>
        rest;
      const active = progress.filter((s) =>
        ['READY', 'IN_PROGRESS'].includes(s.status),
      );
      const blocked = progress.filter((s) => s.status === 'BLOCKED');
      const live = [...active, ...blocked].sort(
        (a, b) => b.sequence - a.sequence,
      );
      jobProgress.push({
        jobId: job.id,
        jobNumber: job.jobNumber,
        status: job.status,
        batchNumber: job.orderBatch?.batchNumber ?? null,
        plannedQuantity: job.plannedQuantity,
        completedQuantity: job.completedQuantity,
        rejectedQuantity: job.rejectedQuantity,
        currentStage: live[0] ? strip(live[0]) : null,
        activeStages: active.map(strip),
        blockedStages: blocked.map(strip),
        delayedStages: progress.filter((s) => s.isDelayed).map(strip),
      });
    }
    const completed = jobs.reduce((s, j) => s + j.completedQuantity, 0);
    const rejected = jobs.reduce((s, j) => s + j.rejectedQuantity, 0);
    const [rework, flagged] = await Promise.all([
      this.prisma.reworkRecord.aggregate({
        where: {
          jobId: { in: jobs.map((j) => j.id) },
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
        _sum: { affectedQuantity: true },
      }),
      this.prisma.stageProductionReport.aggregate({
        where: { jobStage: { jobId: { in: jobs.map((j) => j.id) } } },
        _sum: { reworkQuantity: true },
      }),
    ]);
    const current = jobProgress.map((j) => j.currentStage).find((s) => s);
    return {
      orderId,
      orderNumber: order.orderNumber,
      status: order.status,
      totalQuantity: total,
      completedQuantity: completed,
      rejectedQuantity: rejected,
      reworkQuantity: rework._sum.affectedQuantity ?? 0,
      reworkFlaggedQuantity: flagged._sum.reworkQuantity ?? 0,
      remainingQuantity: Math.max(0, total - completed - rejected),
      progressPercent: progressPercent({
        totalQuantity: total,
        completedQuantity: completed,
        rejectedQuantity: rejected,
      }),
      targetDeliveryDate: order.targetDeliveryDate,
      isPastTargetDate:
        !!order.targetDeliveryDate &&
        order.targetDeliveryDate < now &&
        ![
          'PRODUCTION_COMPLETED',
          'READY_FOR_DELIVERY',
          'PARTIALLY_SHIPPED',
          'OUT_FOR_DELIVERY',
          'DELIVERED',
          'COMPLETED',
          'CANCELLED',
        ].includes(order.status),
      batches: await this.batchDtos(order.batches),
      jobs: jobProgress,
      activeStages: jobProgress.flatMap((j) => j.activeStages),
      blockedStages: jobProgress.flatMap((j) => j.blockedStages),
      delayedStages: jobProgress.flatMap((j) => j.delayedStages),
      currentStage: current ?? null,
    };
  }
}
