import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  FactoryJob,
  JobStage,
  Prisma,
} from '../../generated/prisma/client.js';
import {
  checkReport,
  requiredQuantity,
} from '../orders/pure/order-production.js';
import type {
  ReportQuantityDto,
  StageProductionReportDto,
  StageQuantityDto,
  StageReportsResponseDto,
} from './dto/quantity.dto.js';
import { JobEngineService } from './job-engine.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Quantity accounting for bulk jobs. A stage occurrence must account for `required` units
 * (produced + rejected) before it can complete; reports are append-only and can never exceed it.
 * Sample-production jobs have no planned quantity and are not affected.
 */
@Injectable()
export class StageQuantityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: JobEngineService,
  ) {}

  /** Units scrapped by earlier stages (any attempt) of the same job. */
  private async rejectedBefore(
    tx: Tx | PrismaService,
    stage: JobStage,
  ): Promise<number> {
    const agg = await tx.stageProductionReport.aggregate({
      where: {
        jobStage: { jobId: stage.jobId, sequence: { lt: stage.sequence } },
      },
      _sum: { rejectedQuantity: true },
    });
    return agg._sum.rejectedQuantity ?? 0;
  }

  /** null for jobs without a planned quantity (sample production). */
  async required(
    tx: Tx | PrismaService,
    stage: JobStage,
    job: Pick<FactoryJob, 'plannedQuantity'>,
  ): Promise<number | null> {
    if (job.plannedQuantity == null) return null;
    let affected: number | null = null;
    if (stage.reworkRecordId) {
      const rework = await tx.reworkRecord.findUnique({
        where: { id: stage.reworkRecordId },
        select: { affectedQuantity: true },
      });
      affected = rework?.affectedQuantity ?? null;
    }
    return requiredQuantity({
      plannedQuantity: job.plannedQuantity,
      reworkAffectedQuantity: affected,
      rejectedBefore: await this.rejectedBefore(tx, stage),
    });
  }

  async summary(
    tx: Tx | PrismaService,
    stage: JobStage,
    job: Pick<FactoryJob, 'plannedQuantity'>,
  ): Promise<StageQuantityDto | null> {
    const required = await this.required(tx, stage, job);
    if (required == null) return null;
    const agg = await tx.stageProductionReport.aggregate({
      where: { jobStageId: stage.id },
      _sum: {
        producedQuantity: true,
        rejectedQuantity: true,
        reworkQuantity: true,
      },
    });
    const produced = agg._sum.producedQuantity ?? 0;
    const rejected = agg._sum.rejectedQuantity ?? 0;
    let affected: number | null = null;
    if (stage.reworkRecordId) {
      affected =
        (
          await tx.reworkRecord.findUnique({
            where: { id: stage.reworkRecordId },
            select: { affectedQuantity: true },
          })
        )?.affectedQuantity ?? null;
    }
    return {
      required,
      produced,
      rejected,
      reworkFlagged: agg._sum.reworkQuantity ?? 0,
      remaining: Math.max(0, required - produced - rejected),
      reworkAffectedQuantity: affected,
    };
  }

  /** Stage completion guard for bulk jobs. */
  async assertAccounted(
    tx: Tx,
    stage: JobStage,
    job: Pick<FactoryJob, 'plannedQuantity'>,
  ): Promise<void> {
    const q = await this.summary(tx, stage, job);
    if (q && q.remaining > 0) {
      throw new ConflictException(
        `${stage.stageName} still has ${q.remaining} of ${q.required} units unreported; report produced or rejected units first`,
      );
    }
  }

  /** Recompute the job's quantity cache from the append-only reports. */
  async refreshJob(tx: Tx, jobId: string): Promise<FactoryJob> {
    const job = await tx.factoryJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.plannedQuantity == null) return job;
    const rejected = await tx.stageProductionReport.aggregate({
      where: { jobStage: { jobId } },
      _sum: { rejectedQuantity: true },
    });
    const last = await tx.jobStage.aggregate({
      where: { jobId },
      _max: { sequence: true },
    });
    const finalProduced = await tx.stageProductionReport.aggregate({
      where: { jobStage: { jobId, sequence: last._max.sequence ?? -1 } },
      _sum: { producedQuantity: true },
    });
    const rejectedTotal = rejected._sum.rejectedQuantity ?? 0;
    const completed = Math.min(
      finalProduced._sum.producedQuantity ?? 0,
      Math.max(0, job.plannedQuantity - rejectedTotal),
    );
    if (
      completed === job.completedQuantity &&
      rejectedTotal === job.rejectedQuantity
    )
      return job;
    return tx.factoryJob.update({
      where: { id: jobId },
      data: { completedQuantity: completed, rejectedQuantity: rejectedTotal },
    });
  }

  async report(
    stageId: string,
    dto: ReportQuantityDto,
    actor: AuthUser,
    /** runs in the same transaction, right after the report row exists (e.g. packaging details) */
    afterCreate?: (
      tx: Tx,
      report: { id: string },
      stage: JobStage,
      job: FactoryJob,
    ) => Promise<void>,
  ): Promise<StageReportsResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      await this.engine.assertOperable(tx, job);
      this.engine.assertStageActionable(stage);
      if (job.plannedQuantity == null) {
        throw new ConflictException(
          'Quantity reports apply to bulk production jobs only',
        );
      }
      if (stage.isQcStage) {
        throw new ConflictException(
          'QC stages record quantities in their inspection (inspected / passed / failed)',
        );
      }
      if (stage.status !== 'IN_PROGRESS') {
        throw new ConflictException(
          `Quantities can only be reported on a stage in progress (this one is ${stage.status})`,
        );
      }
      await this.engine.requireAssignment(tx, stageId, actor);

      const produced = dto.producedQuantity ?? 0;
      const rejected = dto.rejectedQuantity ?? 0;
      const rework = dto.reworkQuantity ?? 0;
      const current = await this.summary(tx, stage, job);
      const check = checkReport({
        required: current!.required,
        accounted: current!.produced + current!.rejected,
        produced,
        rejected,
        rework,
      });
      if (!check.ok) {
        throw check.reason === 'EMPTY'
          ? new BadRequestException(
              'Report at least one produced, rejected or rework unit',
            )
          : new ConflictException(
              `Over-report: only ${check.remaining} unit(s) of ${current!.required} remain on ${stage.stageName}`,
            );
      }
      if (dto.orderVariantId) {
        await this.assertVariantCapacity(
          tx,
          job,
          stage,
          dto.orderVariantId,
          produced + rejected,
        );
      }
      const report = await tx.stageProductionReport.create({
        data: {
          jobStageId: stageId,
          producedQuantity: produced,
          rejectedQuantity: rejected,
          reworkQuantity: rework,
          orderVariantId: dto.orderVariantId,
          notes: dto.notes?.trim() || null,
          reportedByUserId: actor.id,
        },
      });
      await afterCreate?.(tx, report, stage, job);
      const last = await tx.jobStage.aggregate({
        where: { jobId: job.id },
        _max: { sequence: true },
      });
      if (dto.orderVariantId && stage.sequence === last._max.sequence) {
        await tx.orderVariant.update({
          where: { id: dto.orderVariantId },
          data: {
            completedQuantity: { increment: produced },
            rejectedQuantity: { increment: rejected },
          },
        });
      }
      const updated = await this.refreshJob(tx, job.id);
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'QUANTITY_REPORTED',
        `${actor.name} reported ${produced} produced, ${rejected} rejected${rework ? `, ${rework} for rework` : ''} on ${stage.stageName}`,
        { reportId: report.id, produced, rejected, rework },
      );
      await this.engine.syncOrder(tx, updated, actor);
    });
    return this.list(stageId);
  }

  /** A variant can only be reported up to its quantity (or its batch allocation). */
  private async assertVariantCapacity(
    tx: Tx,
    job: FactoryJob,
    stage: JobStage,
    variantId: string,
    addUnits: number,
  ): Promise<void> {
    const variant = await tx.orderVariant.findUnique({
      where: { id: variantId },
      include: { item: { select: { orderId: true } } },
    });
    if (!variant || variant.item.orderId !== job.orderId) {
      throw new BadRequestException(
        "The variant does not belong to this job's order",
      );
    }
    let allowed = variant.quantity;
    if (job.orderBatchId) {
      const alloc = await tx.orderBatchVariant.findUnique({
        where: {
          batchId_orderVariantId: {
            batchId: job.orderBatchId,
            orderVariantId: variantId,
          },
        },
      });
      if (!alloc)
        throw new BadRequestException('The variant is not part of this batch');
      allowed = alloc.quantity;
    }
    const agg = await tx.stageProductionReport.aggregate({
      where: { jobStageId: stage.id, orderVariantId: variantId },
      _sum: { producedQuantity: true, rejectedQuantity: true },
    });
    const used =
      (agg._sum.producedQuantity ?? 0) + (agg._sum.rejectedQuantity ?? 0);
    if (used + addUnits > allowed) {
      throw new ConflictException(
        `Over-report: this variant has ${allowed} unit(s) in this job and ${used} are already reported on ${stage.stageName}`,
      );
    }
  }

  async list(stageId: string): Promise<StageReportsResponseDto> {
    const stage = await this.prisma.jobStage.findUnique({
      where: { id: stageId },
      include: { job: true },
    });
    if (!stage) throw new NotFoundException('Job stage not found');
    const quantity = await this.summary(this.prisma, stage, stage.job);
    if (!quantity) {
      throw new ConflictException(
        'This stage belongs to a sample-production job and has no quantities',
      );
    }
    const rows = await this.prisma.stageProductionReport.findMany({
      where: { jobStageId: stageId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.reportedByUserId))] } },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      quantity,
      reports: rows.map((r): StageProductionReportDto => ({
        id: r.id,
        jobStageId: r.jobStageId,
        producedQuantity: r.producedQuantity,
        rejectedQuantity: r.rejectedQuantity,
        reworkQuantity: r.reworkQuantity,
        orderVariantId: r.orderVariantId,
        notes: r.notes,
        reportedByUserId: r.reportedByUserId,
        reportedByName: names.get(r.reportedByUserId) ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Staff view: only assignees (or broad readers) may see a stage's reports. */
  async listFor(stageId: string, actor: AuthUser) {
    const stage = await this.prisma.jobStage.findUnique({
      where: { id: stageId },
      select: { id: true },
    });
    if (!stage) throw new NotFoundException('Job stage not found');
    if (!actor.permissions.has('jobs.read_all')) {
      const mine = await this.engine.activeAssignment(
        this.prisma,
        stageId,
        actor.id,
      );
      if (!mine)
        throw new ForbiddenException('You are not assigned to this stage');
    }
    return this.list(stageId);
  }
}
