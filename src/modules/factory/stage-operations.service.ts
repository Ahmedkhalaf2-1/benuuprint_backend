import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { JobStage, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthContextService } from '../auth/auth-context.service.js';
import type {
  BlockerResponseDto,
  ManualReworkDto,
  RaiseBlockerDto,
  ResolveBlockerDto,
  UnblockStageDto,
} from './dto/factory-job.dto.js';
import type {
  AssignStageDto,
  CompleteStageDto,
  OverrideStageDto,
} from './dto/stage-ops.dto.js';
import { toStageDto } from './factory-jobs.service.js';
import { JobEngineService } from './job-engine.service.js';
import { ReworkService } from './rework.service.js';
import { StageQuantityService } from './stage-quantity.service.js';

type Tx = Prisma.TransactionClient;

const stageDtoInclude = {
  dependsOn: { select: { dependsOnJobStageId: true } },
  assignments: {
    where: { removedAt: null },
    orderBy: { assignedAt: 'asc' },
    include: { user: { select: { id: true, name: true } } },
  },
} satisfies Prisma.JobStageInclude;

type BlockerRow = Prisma.BlockerGetPayload<{
  include: { jobStage: { select: { stageName: true } } };
}>;
export const toBlockerDto = (b: BlockerRow): BlockerResponseDto => ({
  id: b.id,
  jobId: b.jobId,
  jobStageId: b.jobStageId,
  stageName: b.jobStage?.stageName ?? null,
  type: b.type,
  description: b.description,
  status: b.status,
  createdByUserId: b.createdByUserId,
  resolvedByUserId: b.resolvedByUserId,
  resolutionNote: b.resolutionNote,
  createdAt: b.createdAt,
  resolvedAt: b.resolvedAt,
});

/** Everything that moves a stage: assignment, start/complete, blockers, hold, override, manual rework. */
@Injectable()
export class StageOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: JobEngineService,
    private readonly rework: ReworkService,
    private readonly quantity: StageQuantityService,
    private readonly audit: AuditService,
    private readonly access: AuthContextService,
  ) {}

  async getStage(stageId: string) {
    const stage = await this.prisma.jobStage.findUnique({
      where: { id: stageId },
      include: stageDtoInclude,
    });
    if (!stage) throw new NotFoundException('Job stage not found');
    return toStageDto(stage);
  }

  // ───────────────────────── assignments ─────────────────────────

  async assign(
    stageId: string,
    dto: AssignStageDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(`${job.jobNumber} is ${job.status}`);
      if (
        stage.supersededAt ||
        !['WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED'].includes(stage.status)
      ) {
        throw new ConflictException('This stage is no longer open');
      }
      const user = await tx.user.findUnique({ where: { id: dto.userId } });
      if (!user || user.deletedAt)
        throw new BadRequestException('Staff member not found');
      if (!user.isActive || user.status !== 'ACTIVE')
        throw new BadRequestException('Staff member is not active');
      const { roleCodes, permissions } = await this.access.loadAccess(user.id);
      if (!permissions.has('stages.start')) {
        throw new BadRequestException(
          'This staff member cannot work on production stages',
        );
      }
      const def = await tx.productionStageDefinition.findUniqueOrThrow({
        where: { id: stage.stageDefinitionId },
        select: { eligibleRoleCodes: true, name: true },
      });
      if (
        def.eligibleRoleCodes.length > 0 &&
        !roleCodes.some((r) => def.eligibleRoleCodes.includes(r))
      ) {
        throw new BadRequestException(
          `${user.name} does not hold a role eligible for ${def.name} (${def.eligibleRoleCodes.join(', ')})`,
        );
      }
      if (await this.engine.activeAssignment(tx, stageId, user.id)) {
        throw new ConflictException('Already assigned to this stage');
      }
      const existing = await tx.stageAssignment.count({
        where: { jobStageId: stageId, removedAt: null },
      });
      const wantPrimary = dto.isPrimary === true || existing === 0;
      if (wantPrimary && existing > 0) {
        await tx.stageAssignment.updateMany({
          where: { jobStageId: stageId, removedAt: null, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      const created = await tx.stageAssignment.create({
        data: {
          jobStageId: stageId,
          userId: user.id,
          assignedByUserId: actor.id,
          isPrimary: wantPrimary,
          context: dto.context,
        },
      });
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'STAGE_ASSIGNED',
        `${user.name} assigned to ${stage.stageName}`,
        { userId: user.id, assignmentId: created.id, primary: wantPrimary },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.STAGE_ASSIGNED,
          entityType: 'JobStage',
          entityId: stageId,
          metadata: {
            jobNumber: job.jobNumber,
            stage: stage.stageName,
            userId: user.id,
          },
          meta,
        },
        tx,
      );
    });
    return this.getStage(stageId);
  }

  async unassign(
    stageId: string,
    assignmentId: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      const assignment = await tx.stageAssignment.findFirst({
        where: { id: assignmentId, jobStageId: stageId, removedAt: null },
        include: { user: { select: { name: true } } },
      });
      if (!assignment) throw new NotFoundException('Assignment not found');
      const active = await tx.stageAssignment.findMany({
        where: { jobStageId: stageId, removedAt: null },
        orderBy: { assignedAt: 'asc' },
      });
      if (stage.status === 'IN_PROGRESS' && active.length === 1) {
        throw new ConflictException(
          'Cannot remove the last assignee of a stage that is in progress',
        );
      }
      await tx.stageAssignment.update({
        where: { id: assignmentId },
        data: {
          removedAt: new Date(),
          removedByUserId: actor.id,
          isPrimary: false,
        },
      });
      if (assignment.isPrimary) {
        const next = active.find((a) => a.id !== assignmentId);
        if (next)
          await tx.stageAssignment.update({
            where: { id: next.id },
            data: { isPrimary: true },
          });
      }
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'STAGE_UNASSIGNED',
        `${assignment.user.name} removed from ${stage.stageName}`,
        { userId: assignment.userId },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.STAGE_UNASSIGNED,
          entityType: 'JobStage',
          entityId: stageId,
          metadata: {
            jobNumber: job.jobNumber,
            stage: stage.stageName,
            userId: assignment.userId,
          },
          meta,
        },
        tx,
      );
    });
    return this.getStage(stageId);
  }

  // ───────────────────────── start / complete ─────────────────────────

  /** Staff must be assigned; an unassigned-by-design stage (e.g. READY) is claimed by the first eligible starter. */
  private async authoriseWorker(tx: Tx, stage: JobStage, actor: AuthUser) {
    const mine = await this.engine.activeAssignment(tx, stage.id, actor.id);
    if (mine || this.engine.canActOnAnyStage(actor)) return;
    if (stage.requiresAssignment) {
      throw new ForbiddenException('You are not assigned to this stage');
    }
    const def = await tx.productionStageDefinition.findUniqueOrThrow({
      where: { id: stage.stageDefinitionId },
      select: { eligibleRoleCodes: true },
    });
    if (
      def.eligibleRoleCodes.length > 0 &&
      !actor.roleCodes.some((r) => def.eligibleRoleCodes.includes(r))
    ) {
      throw new ForbiddenException('Your role cannot work on this stage');
    }
    const existing = await tx.stageAssignment.count({
      where: { jobStageId: stage.id, removedAt: null },
    });
    await tx.stageAssignment.create({
      data: {
        jobStageId: stage.id,
        userId: actor.id,
        assignedByUserId: actor.id,
        isPrimary: existing === 0,
        context: 'self-assigned',
      },
    });
  }

  async start(stageId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      await this.engine.assertOperable(tx, job);
      this.engine.assertStageActionable(stage);
      this.engine.transitionOrThrow(stage, 'start');
      await this.authoriseWorker(tx, stage, actor);
      await tx.jobStage.update({
        where: { id: stageId },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
      await this.rework.onStageStarted(tx, stage);
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'STAGE_STARTED',
        `${actor.name} started ${stage.stageName}`,
      );
      await this.engine.recompute(tx, job.id, actor);
    });
    return this.getStage(stageId);
  }

  async complete(stageId: string, dto: CompleteStageDto, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      await this.engine.assertOperable(tx, job);
      this.engine.assertStageActionable(stage);
      this.engine.transitionOrThrow(stage, 'complete');
      if (stage.isQcStage) {
        throw new ConflictException(
          'QC stages are completed by submitting the QC inspection',
        );
      }
      await this.engine.requireAssignment(tx, stageId, actor);
      const note = dto.note?.trim() || null;
      if (stage.requiresCompletionNote && !note) {
        throw new BadRequestException(
          `${stage.stageName} requires a completion note`,
        );
      }
      if (stage.requiresAttachment) {
        const files = await tx.assetAttachment.count({
          where: { jobStageId: stageId, asset: { archivedAt: null } },
        });
        if (files === 0) {
          throw new ConflictException(
            `${stage.stageName} requires at least one photo or file before it can be completed`,
          );
        }
      }
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'STAGE_COMPLETED',
        `${actor.name} completed ${stage.stageName}`,
        { note },
      );
      await this.quantity.assertAccounted(tx, stage, job);
      await this.engine.finishStage(tx, stage, 'complete', actor, note);
      await this.rework.onStageCompleted(tx, stage, actor);
    });
    return this.getStage(stageId);
  }

  // ───────────────────────── blockers ─────────────────────────

  async raiseStageBlocker(
    stageId: string,
    dto: RaiseBlockerDto,
    actor: AuthUser,
    opts: { admin: boolean },
    meta?: RequestMeta,
  ): Promise<BlockerResponseDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(`${job.jobNumber} is ${job.status}`);
      this.engine.assertStageActionable(stage);
      if (!opts.admin) await this.engine.requireAssignment(tx, stageId, actor);
      if (!['READY', 'IN_PROGRESS', 'BLOCKED'].includes(stage.status)) {
        throw new ConflictException(
          `Cannot block a stage that is ${stage.status}`,
        );
      }
      const blocker = await tx.blocker.create({
        data: {
          jobId: job.id,
          jobStageId: stageId,
          type: dto.type,
          description: dto.description,
          createdByUserId: actor.id,
        },
      });
      if (stage.status !== 'BLOCKED') {
        this.engine.transitionOrThrow(stage, 'block');
        await tx.jobStage.update({
          where: { id: stageId },
          data: {
            status: 'BLOCKED',
            blockedFromStatus: stage.status,
            blockedAt: new Date(),
            blockReason: dto.description,
          },
        });
      }
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'STAGE_BLOCKED',
        `${stage.stageName} blocked: ${dto.description}`,
        { blockerId: blocker.id, type: dto.type },
      );
      if (opts.admin) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.BLOCKER_RAISED_BY_ADMIN,
            entityType: 'Blocker',
            entityId: blocker.id,
            metadata: {
              jobNumber: job.jobNumber,
              stage: stage.stageName,
              type: dto.type,
            },
            meta,
          },
          tx,
        );
      }
      await this.engine.recompute(tx, job.id, actor);
      return blocker.id;
    });
    return this.getBlocker(id);
  }

  async raiseJobBlocker(
    jobId: string,
    dto: RaiseBlockerDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<BlockerResponseDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, jobId);
      const job = await tx.factoryJob.findUnique({ where: { id: jobId } });
      if (!job) throw new NotFoundException('Factory job not found');
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(`${job.jobNumber} is ${job.status}`);
      const blocker = await tx.blocker.create({
        data: {
          jobId,
          type: dto.type,
          description: dto.description,
          createdByUserId: actor.id,
        },
      });
      await this.engine.activity(
        tx,
        jobId,
        null,
        actor.id,
        'STAGE_BLOCKED',
        `Job blocked: ${dto.description}`,
        { blockerId: blocker.id, type: dto.type },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.BLOCKER_RAISED_BY_ADMIN,
          entityType: 'Blocker',
          entityId: blocker.id,
          metadata: {
            jobNumber: job.jobNumber,
            jobLevel: true,
            type: dto.type,
          },
          meta,
        },
        tx,
      );
      await this.engine.recompute(tx, jobId, actor);
      return blocker.id;
    });
    return this.getBlocker(id);
  }

  async getBlocker(id: string): Promise<BlockerResponseDto> {
    const b = await this.prisma.blocker.findUnique({
      where: { id },
      include: { jobStage: { select: { stageName: true } } },
    });
    if (!b) throw new NotFoundException('Blocker not found');
    return toBlockerDto(b);
  }

  async listBlockers(
    jobId: string,
    status?: 'OPEN' | 'RESOLVED' | 'CANCELLED',
  ) {
    const job = await this.prisma.factoryJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (!job) throw new NotFoundException('Factory job not found');
    const rows = await this.prisma.blocker.findMany({
      where: { jobId, ...(status && { status }) },
      orderBy: { createdAt: 'asc' },
      include: { jobStage: { select: { stageName: true } } },
    });
    return rows.map(toBlockerDto);
  }

  /** Close a blocker; the stage returns to where it was once its last open blocker is gone. */
  private async closeBlocker(
    blockerId: string,
    how: 'RESOLVED' | 'CANCELLED',
    note: string | undefined,
    actor: AuthUser,
    opts: { admin: boolean },
    meta?: RequestMeta,
  ): Promise<BlockerResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.blocker.findUnique({
        where: { id: blockerId },
        select: { jobId: true },
      });
      if (!found) throw new NotFoundException('Blocker not found');
      await this.engine.lockJob(tx, found.jobId);
      const blocker = await tx.blocker.findUniqueOrThrow({
        where: { id: blockerId },
      });
      if (blocker.status !== 'OPEN')
        throw new ConflictException(`The blocker is already ${blocker.status}`);
      const job = await tx.factoryJob.findUniqueOrThrow({
        where: { id: blocker.jobId },
      });
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(`${job.jobNumber} is ${job.status}`);
      if (!opts.admin) {
        const mine =
          this.engine.canActOnAnyStage(actor) ||
          blocker.createdByUserId === actor.id ||
          (blocker.jobStageId &&
            (await this.engine.activeAssignment(
              tx,
              blocker.jobStageId,
              actor.id,
            )));
        if (!mine)
          throw new ForbiddenException(
            'Only the person who raised the blocker or an assignee can resolve it',
          );
      }
      const now = new Date();
      await tx.blocker.update({
        where: { id: blockerId },
        data:
          how === 'RESOLVED'
            ? {
                status: 'RESOLVED',
                resolvedAt: now,
                resolvedByUserId: actor.id,
                resolutionNote: note,
              }
            : { status: 'CANCELLED', cancelledAt: now, resolutionNote: note },
      });
      if (blocker.jobStageId) {
        const stage = await tx.jobStage.findUniqueOrThrow({
          where: { id: blocker.jobStageId },
        });
        const stillOpen = await tx.blocker.count({
          where: { jobStageId: stage.id, status: 'OPEN' },
        });
        if (stillOpen === 0 && stage.status === 'BLOCKED') {
          const to = this.engine.transitionOrThrow(stage, 'unblock');
          await tx.jobStage.update({
            where: { id: stage.id },
            data: {
              status: to,
              blockedFromStatus: null,
              blockedAt: null,
              blockReason: null,
            },
          });
        }
      }
      await this.engine.activity(
        tx,
        job.id,
        blocker.jobStageId,
        actor.id,
        how === 'RESOLVED' ? 'BLOCKER_RESOLVED' : 'BLOCKER_CANCELLED',
        `Blocker ${how.toLowerCase()}: ${blocker.description}`,
        { blockerId, note },
      );
      if (opts.admin) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.BLOCKER_RESOLVED_BY_ADMIN,
            entityType: 'Blocker',
            entityId: blockerId,
            metadata: { jobNumber: job.jobNumber, outcome: how },
            meta,
          },
          tx,
        );
      }
      await this.engine.recompute(tx, job.id, actor);
    });
    return this.getBlocker(blockerId);
  }

  resolveBlocker(
    blockerId: string,
    dto: ResolveBlockerDto,
    actor: AuthUser,
    opts: { admin: boolean },
    meta?: RequestMeta,
  ) {
    return this.closeBlocker(
      blockerId,
      'RESOLVED',
      dto.note,
      actor,
      opts,
      meta,
    );
  }

  cancelBlocker(
    blockerId: string,
    dto: ResolveBlockerDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    return this.closeBlocker(
      blockerId,
      'CANCELLED',
      dto.note,
      actor,
      { admin: true },
      meta,
    );
  }

  /** Admin "unblock stage": resolve one or all open blockers of a stage. */
  async unblockStage(
    stageId: string,
    dto: UnblockStageDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    const open = await this.prisma.blocker.findMany({
      where: {
        jobStageId: stageId,
        status: 'OPEN',
        ...(dto.blockerId && { id: dto.blockerId }),
      },
      select: { id: true },
    });
    if (open.length === 0)
      throw new ConflictException('The stage has no open blockers');
    for (const b of open) {
      await this.closeBlocker(
        b.id,
        'RESOLVED',
        dto.note,
        actor,
        { admin: true },
        meta,
      );
    }
    return this.getStage(stageId);
  }

  // ───────────────────────── hold / override / rework ─────────────────────────

  async holdStage(
    stageId: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(`${job.jobNumber} is ${job.status}`);
      if (
        stage.supersededAt ||
        !['WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED'].includes(stage.status)
      )
        throw new ConflictException('This stage is no longer open');
      if (stage.isOnHold)
        throw new ConflictException('The stage is already on hold');
      await tx.jobStage.update({
        where: { id: stageId },
        data: { isOnHold: true, holdReason: reason, heldAt: new Date() },
      });
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'STAGE_HELD',
        `${stage.stageName} on hold: ${reason}`,
        { reason },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.STAGE_HELD,
          entityType: 'JobStage',
          entityId: stageId,
          metadata: {
            jobNumber: job.jobNumber,
            stage: stage.stageName,
            reason,
          },
          meta,
        },
        tx,
      );
    });
    return this.getStage(stageId);
  }

  async resumeStage(stageId: string, actor: AuthUser, meta?: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      if (!stage.isOnHold)
        throw new ConflictException('The stage is not on hold');
      await tx.jobStage.update({
        where: { id: stageId },
        data: { isOnHold: false, holdReason: null, heldAt: null },
      });
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'STAGE_RESUMED',
        `${stage.stageName} resumed`,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.STAGE_RESUMED,
          entityType: 'JobStage',
          entityId: stageId,
          metadata: { jobNumber: job.jobNumber, stage: stage.stageName },
          meta,
        },
        tx,
      );
    });
    return this.getStage(stageId);
  }

  async override(
    stageId: string,
    dto: OverrideStageDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(`${job.jobNumber} is ${job.status}`);
      if (job.status === 'PLANNED')
        throw new ConflictException(
          `${job.jobNumber} has not been released yet`,
        );
      if (stage.supersededAt)
        throw new ConflictException(
          'This stage occurrence was replaced by rework',
        );
      if (stage.isQcStage && !actor.permissions.has('qc.manage')) {
        throw new ForbiddenException('Overriding a QC gate requires qc.manage');
      }
      await this.engine.finishStage(
        tx,
        stage,
        dto.action === 'complete' ? 'force-complete' : 'skip',
        actor,
        `Override: ${dto.reason}`,
      );
      if (dto.action === 'complete')
        await this.rework.onStageCompleted(tx, stage, actor);
      // An override on a stage with a running inspection ends that inspection.
      await tx.qcInspection.updateMany({
        where: { jobStageId: stageId, status: 'IN_PROGRESS' },
        data: { status: 'CANCELLED' },
      });
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'ADMIN_OVERRIDE',
        `${stage.stageName} ${dto.action === 'complete' ? 'force-completed' : 'skipped'} by admin: ${dto.reason}`,
        { action: dto.action, reason: dto.reason, qc: stage.isQcStage },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: stage.isQcStage
            ? AuditAction.QC_OVERRIDE
            : AuditAction.STAGE_OVERRIDDEN,
          entityType: 'JobStage',
          entityId: stageId,
          metadata: {
            jobNumber: job.jobNumber,
            stage: stage.stageName,
            action: dto.action,
            reason: dto.reason,
          },
          meta,
        },
        tx,
      );
    });
    return this.getStage(stageId);
  }

  async manualRework(
    stageId: string,
    dto: ManualReworkDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    const reworkId = await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      await this.engine.assertOperable(tx, job);
      this.engine.assertStageActionable(stage);
      if (stage.status !== 'IN_PROGRESS') {
        throw new ConflictException(
          'Work can only be sent back from a stage that is in progress',
        );
      }
      await tx.qcInspection.updateMany({
        where: { jobStageId: stageId, status: 'IN_PROGRESS' },
        data: { status: 'CANCELLED' },
      });
      const { rework } = await this.rework.create(tx, {
        job,
        failedStage: stage,
        qcInspectionId: null,
        targetStageCode: dto.targetStageCode,
        affectedQuantity: dto.affectedQuantity,
        reason: dto.reason,
        actor,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.REWORK_CREATED_MANUALLY,
          entityType: 'JobStage',
          entityId: stageId,
          metadata: {
            jobNumber: job.jobNumber,
            stage: stage.stageName,
            reworkId: rework.id,
            reason: dto.reason,
          },
          meta,
        },
        tx,
      );
      await this.engine.recompute(tx, job.id, actor);
      return rework.id;
    });
    return { reworkId, stage: await this.getStage(stageId) };
  }
}
