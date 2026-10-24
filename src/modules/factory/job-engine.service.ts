import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../../common/types/auth-user.js';
import type {
  FactoryJob,
  JobActivityType,
  JobStage,
  JobStageStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import {
  checkStageTransition,
  SATISFIED_STAGE_STATUSES,
  type JobStageAction,
} from './pure/job-stage-state-machine.js';
import { milestoneForStage } from '../notifications/events.js';
import { OutboxService } from '../notifications/outbox.service.js';
import { OrderSyncService } from '../orders/core/order-sync.service.js';
import { SampleTransitionsService } from '../samples/sample-transitions.service.js';
import { deriveJobStatus } from './pure/job-status.js';

type Tx = Prisma.TransactionClient;

/**
 * Shared mechanics for everything that changes a job: one lock per job (so stage,
 * blocker, QC and rework operations on the same job never interleave), the operational
 * activity log, readiness/dependency unlocking and the derived job status.
 */
@Injectable()
export class JobEngineService {
  constructor(
    private readonly samples: SampleTransitionsService,
    private readonly orders: OrderSyncService,
    private readonly outbox: OutboxService,
  ) {}

  /** Serialise all changes to one job (released at commit). */
  async lockJob(tx: Tx, jobId: string): Promise<void> {
    // Order jobs lock their order first (the root lock), so order-level and job-level
    // operations can never deadlock against each other.
    const rows = await tx.$queryRaw<
      { order_id: string | null }[]
    >`SELECT order_id FROM factory_jobs WHERE id = ${jobId}::uuid`;
    const orderId = rows[0]?.order_id;
    if (orderId) {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM factory_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
  }

  /** Keep the order and batch in step with a job that changed (status or quantities). */
  async syncOrder(
    tx: Tx,
    job: Pick<FactoryJob, 'orderId' | 'orderBatchId'>,
    actor: AuthUser | null,
  ): Promise<void> {
    await this.orders.refreshForJob(tx, job, actor);
  }

  async activity(
    tx: Tx,
    jobId: string,
    jobStageId: string | null,
    actorUserId: string | null,
    type: JobActivityType,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    const row = await tx.jobActivity.create({
      data: {
        jobId,
        jobStageId,
        actorUserId,
        type,
        message,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
    await this.emitDomainEvent(tx, jobId, jobStageId, type, metadata);
    return row;
  }

  /** Job timeline entries that are also domain events: written to the outbox in the same transaction. */
  private async emitDomainEvent(
    tx: Tx,
    jobId: string,
    stageId: string | null,
    type: JobActivityType,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const base = { jobId, ...(stageId && { stageId }) };
    switch (type) {
      case 'STAGE_ASSIGNED':
        await this.outbox.emit(tx, {
          eventType: 'STAGE_ASSIGNED',
          aggregateType: 'JobStage',
          aggregateId: stageId ?? jobId,
          payload: {
            ...base,
            ...(typeof metadata?.userId === 'string' && {
              assigneeUserId: metadata.userId,
            }),
          },
        });
        return;
      case 'STAGE_BLOCKED': {
        const blocker =
          typeof metadata?.blockerId === 'string'
            ? await tx.blocker.findUnique({
                where: { id: metadata.blockerId },
                select: { description: true },
              })
            : null;
        await this.outbox.emit(tx, {
          eventType: 'STAGE_BLOCKED',
          aggregateType: stageId ? 'JobStage' : 'FactoryJob',
          aggregateId: stageId ?? jobId,
          payload: {
            ...base,
            ...(blocker && { reason: blocker.description.slice(0, 300) }),
          },
        });
        return;
      }
      case 'QC_FAILED':
        await this.outbox.emit(tx, {
          eventType: 'QC_FAILED',
          aggregateType: 'JobStage',
          aggregateId: stageId ?? jobId,
          payload: base,
        });
        return;
      case 'REWORK_CREATED':
        await this.outbox.emit(tx, {
          eventType: 'REWORK_CREATED',
          aggregateType: 'FactoryJob',
          aggregateId: jobId,
          payload: base,
        });
        return;
      case 'JOB_COMPLETED':
        await this.outbox.emit(tx, {
          eventType: 'JOB_COMPLETED',
          aggregateType: 'FactoryJob',
          aggregateId: jobId,
          payload: { jobId },
        });
        return;
      case 'STAGE_STARTED': {
        // customer-safe milestone: bulk jobs only, announced once per order and milestone
        const [job, stage] = await Promise.all([
          tx.factoryJob.findUnique({
            where: { id: jobId },
            select: { orderId: true },
          }),
          stageId
            ? tx.jobStage.findUnique({
                where: { id: stageId },
                select: { stageCode: true },
              })
            : null,
        ]);
        const milestone = stage ? milestoneForStage(stage.stageCode) : null;
        if (job?.orderId && milestone)
          await this.outbox.emit(tx, {
            eventType: 'ORDER_MILESTONE',
            aggregateType: 'Order',
            aggregateId: job.orderId,
            payload: { orderId: job.orderId, milestone },
            deduplicationKey: `MILESTONE:${job.orderId}:${milestone}`,
          });
        return;
      }
      default:
        return;
    }
  }

  /** Lock the job that owns a stage, then re-read both under the lock. */
  async lockedStage(
    tx: Tx,
    stageId: string,
  ): Promise<{ stage: JobStage; job: FactoryJob }> {
    const found = await tx.jobStage.findUnique({
      where: { id: stageId },
      select: { jobId: true },
    });
    if (!found) throw new NotFoundException('Job stage not found');
    await this.lockJob(tx, found.jobId);
    const stage = await tx.jobStage.findUniqueOrThrow({
      where: { id: stageId },
    });
    const job = await tx.factoryJob.findUniqueOrThrow({
      where: { id: found.jobId },
    });
    return { stage, job };
  }

  /** Work can only move on a released, running job: not planned, held, blocked at job level, finished or cancelled. */
  async assertOperable(tx: Tx, job: FactoryJob): Promise<void> {
    if (job.status === 'CANCELLED')
      throw new ConflictException(`${job.jobNumber} is cancelled`);
    if (job.status === 'COMPLETED')
      throw new ConflictException(`${job.jobNumber} is already completed`);
    if (job.status === 'ON_HOLD') {
      throw new ConflictException(
        `${job.jobNumber} is on hold: ${job.holdReason}`,
      );
    }
    if (job.status === 'PLANNED') {
      throw new ConflictException(
        `${job.jobNumber} has not been released to the floor yet`,
      );
    }
    if (job.orderId) {
      const order = await tx.order.findUnique({
        where: { id: job.orderId },
        select: { status: true, orderNumber: true },
      });
      if (order?.status === 'ON_HOLD')
        throw new ConflictException(`${order.orderNumber} is on hold`);
      if (order?.status === 'CANCELLED')
        throw new ConflictException(`${order.orderNumber} is cancelled`);
    }
    if (job.orderBatchId) {
      const batch = await tx.orderBatch.findUnique({
        where: { id: job.orderBatchId },
        select: { status: true, batchNumber: true },
      });
      if (batch?.status === 'ON_HOLD')
        throw new ConflictException(`${batch.batchNumber} is on hold`);
    }
    const open = await tx.blocker.count({
      where: { jobId: job.id, jobStageId: null, status: 'OPEN' },
    });
    if (open > 0)
      throw new ConflictException(
        `${job.jobNumber} is blocked: resolve the job-level blocker first`,
      );
  }

  assertStageActionable(stage: JobStage): void {
    if (stage.supersededAt)
      throw new ConflictException(
        'This stage occurrence has been replaced by rework',
      );
    if (stage.isOnHold)
      throw new ConflictException(`This stage is on hold: ${stage.holdReason}`);
  }

  /** Apply a stage action through the state machine; returns the status it moved to. */
  transitionOrThrow(stage: JobStage, action: JobStageAction): JobStageStatus {
    const check = checkStageTransition(
      action,
      stage.status,
      stage.blockedFromStatus,
    );
    if (check.ok) return check.to;
    const hint: Partial<Record<JobStageStatus, string>> = {
      WAITING: 'its dependencies are not complete yet',
      BLOCKED: 'it is blocked: resolve the blocker first',
      IN_PROGRESS: 'it is already in progress',
      COMPLETED: 'it is already completed',
      SKIPPED: 'it was skipped',
      FAILED: 'it failed QC (see rework)',
      CANCELLED: 'it was cancelled',
      READY: 'it has not been started',
    };
    throw new ConflictException(
      `Cannot ${action.replace(/-/g, ' ')} stage ${stage.stageName}: ${hint[stage.status] ?? stage.status}`,
    );
  }

  /** Make a stage READY now and start its due-date clock. */
  async markReady(
    tx: Tx,
    stage: JobStage,
    actor: AuthUser | null,
  ): Promise<void> {
    const now = new Date();
    const dueAt =
      stage.expectedDurationMinutes != null
        ? new Date(now.getTime() + stage.expectedDurationMinutes * 60_000)
        : null;
    await tx.jobStage.update({
      where: { id: stage.id },
      data: { status: 'READY', readyAt: now, dueAt },
    });
    await this.activity(
      tx,
      stage.jobId,
      stage.id,
      actor?.id ?? null,
      'STAGE_READY',
      `${stage.stageName} is ready`,
      {
        dueAt,
        attempt: stage.attempt,
      },
    );
  }

  /** After a stage is done, release every waiting stage whose dependencies are now all satisfied. */
  async unlockDependents(
    tx: Tx,
    finished: JobStage,
    actor: AuthUser | null,
  ): Promise<void> {
    const edges = await tx.jobStageDependency.findMany({
      where: { dependsOnJobStageId: finished.id },
      select: { jobStageId: true },
    });
    for (const { jobStageId } of edges) {
      const dependent = await tx.jobStage.findUniqueOrThrow({
        where: { id: jobStageId },
      });
      if (dependent.status !== 'WAITING' || dependent.supersededAt) continue;
      const deps = await tx.jobStageDependency.findMany({
        where: { jobStageId },
        include: { dependsOn: { select: { status: true } } },
      });
      if (
        deps.every((d) => SATISFIED_STAGE_STATUSES.includes(d.dependsOn.status))
      ) {
        await this.markReady(tx, dependent, actor);
      }
    }
  }

  /** Release the stages that have no unsatisfied dependency (job creation / release). */
  async releaseRoots(
    tx: Tx,
    jobId: string,
    actor: AuthUser | null,
  ): Promise<number> {
    const waiting = await tx.jobStage.findMany({
      where: { jobId, status: 'WAITING', supersededAt: null },
      include: {
        dependsOn: { include: { dependsOn: { select: { status: true } } } },
      },
    });
    let released = 0;
    for (const stage of waiting) {
      if (
        stage.dependsOn.every((d) =>
          SATISFIED_STAGE_STATUSES.includes(d.dependsOn.status),
        )
      ) {
        await this.markReady(tx, stage, actor);
        released += 1;
      }
    }
    return released;
  }

  /**
   * Finish a stage (complete / force-complete / skip), unlock what depends on it and
   * refresh the job. `completionNote` is stored on completion only.
   */
  async finishStage(
    tx: Tx,
    stage: JobStage,
    action: 'complete' | 'force-complete' | 'skip',
    actor: AuthUser,
    completionNote: string | null,
  ): Promise<void> {
    const to = this.transitionOrThrow(stage, action);
    const now = new Date();
    await tx.jobStage.update({
      where: { id: stage.id },
      data:
        to === 'COMPLETED'
          ? { status: to, completedAt: now, completionNote }
          : { status: to, completionNote },
    });
    await this.unlockDependents(tx, { ...stage, status: to }, actor);
    await this.recompute(tx, stage.jobId, actor);
  }

  /** Refresh the job's high-level status from its stages. Hold/cancel/complete are explicit actions and are left alone. */
  async recompute(
    tx: Tx,
    jobId: string,
    actor: AuthUser | null,
  ): Promise<FactoryJob> {
    const job = await tx.factoryJob.findUniqueOrThrow({ where: { id: jobId } });
    if (
      job.status === 'CANCELLED' ||
      job.status === 'COMPLETED' ||
      job.status === 'ON_HOLD'
    )
      return job;
    const [stages, openJobBlockers] = await Promise.all([
      tx.jobStage.findMany({
        where: { jobId },
        select: { status: true, isRequired: true, supersededAt: true },
      }),
      tx.blocker.count({ where: { jobId, jobStageId: null, status: 'OPEN' } }),
    ]);
    const { status } = deriveJobStatus({
      stages,
      openJobBlockers,
      hasStarted: !!job.startedAt,
    });
    if (status === job.status) {
      // stage movement (e.g. packaging starting) can still change the order's status
      await this.syncOrder(tx, job, actor);
      return job;
    }
    const now = new Date();
    const updated = await tx.factoryJob.update({
      where: { id: jobId },
      data: {
        status,
        ...(status === 'COMPLETED' && { completedAt: now }),
        ...(status === 'IN_PROGRESS' && !job.startedAt && { startedAt: now }),
      },
    });
    if (status === 'IN_PROGRESS' && !job.startedAt)
      await this.outbox.emit(tx, {
        eventType: 'JOB_STARTED',
        aggregateType: 'FactoryJob',
        aggregateId: jobId,
        payload: { jobId },
        deduplicationKey: `JOB_STARTED:${jobId}`,
      });
    if (status === 'COMPLETED') {
      await this.activity(
        tx,
        jobId,
        null,
        actor?.id ?? null,
        'JOB_COMPLETED',
        `${job.jobNumber} is complete`,
      );
      await this.onJobCompleted(tx, updated, actor);
    }
    await this.syncOrder(tx, updated, actor);
    return updated;
  }

  /**
   * A finished SAMPLE_PRODUCTION job means the physical sample exists: the sample moves to
   * AWAITING_APPROVAL so the customer can review it. It is never approved automatically.
   */
  async onJobCompleted(
    tx: Tx,
    job: FactoryJob,
    actor: AuthUser | null,
  ): Promise<void> {
    if (job.sourceType !== 'SAMPLE_PRODUCTION' || !job.sampleId) return;
    const sample = await tx.sample.findUnique({
      where: { id: job.sampleId },
      select: { status: true },
    });
    // Held, cancelled or already moved on by hand: leave the sample alone.
    if (sample?.status !== 'IN_PRODUCTION') return;
    await this.samples.apply(tx, job.sampleId, 'finish-production', {
      actor,
      auditMetadata: { factoryJobId: job.id, jobNumber: job.jobNumber },
    });
  }

  /** The caller must be an active assignee of the stage. */
  async activeAssignment(tx: Tx, stageId: string, userId: string) {
    return tx.stageAssignment.findFirst({
      where: { jobStageId: stageId, userId, removedAt: null },
    });
  }

  /**
   * Holders of stages.override (ADMIN, SUPER_ADMIN) may run any stage without being assigned to it. Only the
   * assignment gate is lifted: state machine, QC, checklist and quantity rules still apply to them.
   */
  canActOnAnyStage(actor: AuthUser): boolean {
    return actor.permissions.has('stages.override');
  }

  async requireAssignment(tx: Tx, stageId: string, actor: AuthUser) {
    if (this.canActOnAnyStage(actor)) return null;
    const assignment = await this.activeAssignment(tx, stageId, actor.id);
    if (!assignment)
      throw new ForbiddenException('You are not assigned to this stage');
    return assignment;
  }

  assertText(value: string | undefined | null, field: string): string {
    const trimmed = value?.trim();
    if (!trimmed) throw new BadRequestException(`${field} is required`);
    return trimmed;
  }
}
