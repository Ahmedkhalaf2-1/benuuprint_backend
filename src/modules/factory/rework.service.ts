import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from '../../common/types/auth-user.js';
import type {
  FactoryJob,
  JobStage,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ReworkResponseDto } from './dto/factory-job.dto.js';
import { JobEngineService } from './job-engine.service.js';
import { StageQuantityService } from './stage-quantity.service.js';

type Tx = Prisma.TransactionClient;

export interface CreateReworkInput {
  job: FactoryJob;
  /** The IN_PROGRESS stage that failed (a QC gate, or any stage sent back by an admin). */
  failedStage: JobStage;
  qcInspectionId: string | null;
  /** Stage code to redo; defaults to the (non-QC) stage the failed stage depends on. */
  targetStageCode?: string;
  reason: string;
  /** Units sent back. Required for bulk jobs (1 .. what the failed stage handles); ignored for samples. */
  affectedQuantity?: number | null;
  actor: AuthUser;
}

/**
 * Rework never rewrites history: the failed stage and the redone stage keep their rows
 * (marked superseded), and fresh occurrences (attempt + 1) take their place in the graph.
 */
@Injectable()
export class ReworkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: JobEngineService,
    private readonly quantity: StageQuantityService,
  ) {}

  async create(tx: Tx, input: CreateReworkInput) {
    const { job, failedStage, actor, reason } = input;
    const failedDeps = await tx.jobStageDependency.findMany({
      where: { jobStageId: failedStage.id },
      include: { dependsOn: true },
    });

    let target: JobStage | undefined;
    if (input.targetStageCode) {
      const candidates = await tx.jobStage.findMany({
        where: {
          jobId: job.id,
          stageCode: input.targetStageCode,
          supersededAt: null,
          sequence: { lt: failedStage.sequence },
        },
        orderBy: { attempt: 'desc' },
        take: 1,
      });
      target = candidates[0];
      if (!target) {
        throw new ConflictException(
          `There is no earlier stage ${input.targetStageCode} to send this work back to`,
        );
      }
    } else {
      // Walk back through QC gates to the stage whose work they checked.
      let cursor: JobStage | undefined = failedDeps[0]?.dependsOn;
      const nonQc = failedDeps.find((d) => !d.dependsOn.isQcStage);
      if (nonQc) cursor = nonQc.dependsOn;
      for (let hops = 0; cursor?.isQcStage && hops < 10; hops += 1) {
        const upstream: { dependsOn: JobStage }[] =
          await tx.jobStageDependency.findMany({
            where: { jobStageId: cursor.id },
            include: { dependsOn: true },
          });
        cursor = upstream.find((d) => !d.dependsOn.isQcStage)?.dependsOn;
      }
      target = cursor;
      if (!target) {
        throw new ConflictException(
          'This stage has no earlier stage to send work back to',
        );
      }
    }
    if (target.isQcStage) {
      throw new ConflictException('Work cannot be sent back to a QC stage');
    }
    if (!['COMPLETED', 'SKIPPED'].includes(target.status)) {
      throw new ConflictException(
        `${target.stageName} has not been completed, so it cannot be redone`,
      );
    }

    let affected: number | null = null;
    if (job.plannedQuantity != null) {
      const handled = await this.quantity.required(tx, failedStage, job);
      affected = input.affectedQuantity ?? null;
      if (affected == null || !Number.isInteger(affected) || affected < 1) {
        throw new BadRequestException(
          'affectedQuantity (units sent back) is required for bulk jobs',
        );
      }
      if (handled != null && affected > handled) {
        throw new BadRequestException(
          `affectedQuantity ${affected} exceeds the ${handled} units this stage handles`,
        );
      }
    }
    const rework = await tx.reworkRecord.create({
      data: {
        jobId: job.id,
        affectedQuantity: affected,
        failedStageId: failedStage.id,
        qcInspectionId: input.qcInspectionId,
        targetStageDefinitionId: target.stageDefinitionId,
        reason,
        createdByUserId: actor.id,
      },
    });

    const now = new Date();
    await tx.jobStage.update({
      where: { id: failedStage.id },
      data: { status: 'FAILED', supersededAt: now },
    });
    await tx.jobStage.update({
      where: { id: target.id },
      data: { supersededAt: now },
    });

    const clone = async (from: JobStage) => {
      const latest = await tx.jobStage.aggregate({
        where: { jobId: job.id, sequence: from.sequence },
        _max: { attempt: true },
      });
      return tx.jobStage.create({
        data: {
          jobId: job.id,
          stageDefinitionId: from.stageDefinitionId,
          templateStageId: from.templateStageId,
          sequence: from.sequence,
          attempt: (latest._max.attempt ?? from.attempt) + 1,
          reworkRecordId: rework.id,
          stageCode: from.stageCode,
          stageName: from.stageName,
          departmentType: from.departmentType,
          isRequired: from.isRequired,
          isQcStage: from.isQcStage,
          requiresAssignment: from.requiresAssignment,
          requiresCompletionNote: from.requiresCompletionNote,
          requiresAttachment: from.requiresAttachment,
          expectedDurationMinutes: from.expectedDurationMinutes,
        },
      });
    };
    const copyAssignments = async (from: JobStage, to: JobStage) => {
      const active = await tx.stageAssignment.findMany({
        where: { jobStageId: from.id, removedAt: null },
      });
      for (const a of active) {
        await tx.stageAssignment.create({
          data: {
            jobStageId: to.id,
            userId: a.userId,
            assignedByUserId: actor.id,
            isPrimary: a.isPrimary,
            context: a.context,
          },
        });
      }
    };

    const redo = await clone(target);
    const recheck = await clone(failedStage);

    // The redone stage keeps the dependencies the original had (already satisfied).
    const targetDeps = await tx.jobStageDependency.findMany({
      where: { jobStageId: target.id },
    });
    for (const d of targetDeps) {
      await tx.jobStageDependency.create({
        data: {
          jobStageId: redo.id,
          dependsOnJobStageId: d.dependsOnJobStageId,
        },
      });
    }
    // The re-check waits for the redone stage (replacing the superseded one) plus its other dependencies.
    await tx.jobStageDependency.create({
      data: { jobStageId: recheck.id, dependsOnJobStageId: redo.id },
    });
    for (const d of failedDeps) {
      if (d.dependsOnJobStageId === target.id) continue;
      await tx.jobStageDependency.create({
        data: {
          jobStageId: recheck.id,
          dependsOnJobStageId: d.dependsOnJobStageId,
        },
      });
    }
    // Everything that was waiting on the failed stage now waits on its re-check.
    const dependents = await tx.jobStageDependency.findMany({
      where: { dependsOnJobStageId: failedStage.id },
      include: { jobStage: { select: { status: true, supersededAt: true } } },
    });
    for (const d of dependents) {
      if (d.jobStage.supersededAt || d.jobStage.status !== 'WAITING') continue;
      await tx.jobStageDependency.delete({
        where: {
          jobStageId_dependsOnJobStageId: {
            jobStageId: d.jobStageId,
            dependsOnJobStageId: failedStage.id,
          },
        },
      });
      await tx.jobStageDependency.create({
        data: { jobStageId: d.jobStageId, dependsOnJobStageId: recheck.id },
      });
    }
    await copyAssignments(target, redo);
    await copyAssignments(failedStage, recheck);

    await this.engine.activity(
      tx,
      job.id,
      failedStage.id,
      actor.id,
      'REWORK_CREATED',
      `Rework: ${target.stageName} must be redone (${reason})`,
      {
        reworkId: rework.id,
        failedStage: failedStage.stageName,
        targetStage: target.stageName,
        newStageIds: [redo.id, recheck.id],
        qcInspectionId: input.qcInspectionId,
      },
    );
    await this.engine.markReady(tx, redo, actor);
    return { rework, redoStageId: redo.id, recheckStageId: recheck.id };
  }

  /** Called when a stage starts: the first start of the redone stage moves the rework to IN_PROGRESS. */
  async onStageStarted(tx: Tx, stage: JobStage): Promise<void> {
    if (!stage.reworkRecordId || stage.isQcStage) return;
    await tx.reworkRecord.updateMany({
      where: { id: stage.reworkRecordId, status: 'OPEN' },
      data: { status: 'IN_PROGRESS' },
    });
  }

  /** Called when a stage completes: finishing the redone stage resolves the rework. */
  async onStageCompleted(
    tx: Tx,
    stage: JobStage,
    actor: AuthUser,
  ): Promise<void> {
    if (!stage.reworkRecordId || stage.isQcStage) return;
    const r = await tx.reworkRecord.updateMany({
      where: {
        id: stage.reworkRecordId,
        status: { in: ['OPEN', 'IN_PROGRESS'] },
      },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    if (r.count > 0) {
      await this.engine.activity(
        tx,
        stage.jobId,
        stage.id,
        actor.id,
        'REWORK_RESOLVED',
        `Rework on ${stage.stageName} finished`,
        { reworkId: stage.reworkRecordId },
      );
    }
  }

  async list(jobId: string): Promise<ReworkResponseDto[]> {
    const rows = await this.prisma.reworkRecord.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
      include: {
        targetDefinition: { select: { code: true, name: true } },
        stages: { select: { id: true }, orderBy: { sequence: 'asc' } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      failedStageId: r.failedStageId,
      qcInspectionId: r.qcInspectionId,
      targetStageCode: r.targetDefinition.code,
      targetStageName: r.targetDefinition.name,
      reason: r.reason,
      affectedQuantity: r.affectedQuantity,
      status: r.status,
      newStageIds: r.stages.map((s) => s.id),
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    }));
  }
}
