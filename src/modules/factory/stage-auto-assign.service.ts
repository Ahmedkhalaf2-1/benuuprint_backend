import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type { ApplyMode } from '../responsibilities/dto/responsibility.dto.js';
import {
  DELIVERY_KEY,
  ResponsibilityRulesService,
  type Resolution,
} from '../responsibilities/responsibility-rules.service.js';
import { JobEngineService } from './job-engine.service.js';

type Tx = Prisma.TransactionClient;

const OPEN = ['WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED'] as const;

export interface ApplyResult {
  stageKey: string;
  mode: ApplyMode;
  customerId: string | null;
  considered: number;
  assigned: number;
  replaced: number;
  skipped: {
    alreadyAssigned: number;
    started: number;
    unchanged: number;
    noResponsibleUser: number;
  };
}

/**
 * Turns responsibility rules into REAL stage assignments (the same stage_assignments rows manual assignment
 * writes, tagged with where they came from), both for new jobs and, on explicit request, for work that is
 * already open. A rule never overwrites an existing assignment on its own, and completed, cancelled or
 * superseded stages and closed jobs are never touched.
 */
@Injectable()
export class StageAutoAssignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: JobEngineService,
    private readonly rules: ResponsibilityRulesService,
    private readonly audit: AuditService,
  ) {}

  /** New job: give every assignable stage its default owner. Runs inside the job-creation transaction. */
  async autoAssignJob(
    tx: Tx,
    jobId: string,
    customerId: string,
  ): Promise<number> {
    const job = await tx.factoryJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { id: true, jobNumber: true },
    });
    const stages = await tx.jobStage.findMany({
      where: {
        jobId,
        supersededAt: null,
        requiresAssignment: true,
        status: { in: [...OPEN] },
        assignments: { none: { removedAt: null } },
      },
      orderBy: { sequence: 'asc' },
    });
    if (stages.length === 0) return 0;
    const resolution = await this.rules.resolveForCustomer(customerId);
    let n = 0;
    for (const stage of stages) {
      const r = resolution.get(stage.stageCode);
      if (!r?.effectiveUserId) continue;
      await this.assignFromRule(tx, job, stage, r, null);
      n += 1;
    }
    return n;
  }

  private async assignFromRule(
    tx: Tx,
    job: { id: string; jobNumber: string },
    stage: { id: string; stageName: string; stageCode: string },
    r: Resolution,
    actor: AuthUser | null,
  ): Promise<void> {
    const source =
      r.source === 'CUSTOMER_OVERRIDE' ? 'CUSTOMER_OVERRIDE' : 'GLOBAL_DEFAULT';
    const primaryId = r.effectiveUserId!;
    const extras = r.usableAdditionalUserIds.filter((id) => id !== primaryId);
    const users = await this.rules.userRefs([primaryId, ...extras]);
    const context =
      source === 'CUSTOMER_OVERRIDE'
        ? 'customer override'
        : 'default responsibility';
    const created = await tx.stageAssignment.create({
      data: {
        jobStageId: stage.id,
        userId: primaryId,
        assignedByUserId: actor?.id ?? null,
        isPrimary: true,
        context,
        source,
      },
    });
    for (const id of extras) {
      await tx.stageAssignment.create({
        data: {
          jobStageId: stage.id,
          userId: id,
          assignedByUserId: actor?.id ?? null,
          isPrimary: false,
          context,
          source,
        },
      });
    }
    await this.engine.activity(
      tx,
      job.id,
      stage.id,
      actor?.id ?? null,
      'STAGE_ASSIGNED',
      `${users.get(primaryId)?.name ?? 'Staff'} assigned to ${stage.stageName} (${context})`,
      { userId: primaryId, assignmentId: created.id, primary: true, source },
    );
    await this.audit.record(
      {
        actorUserId: actor?.id ?? null,
        action: AuditAction.STAGE_ASSIGNED,
        entityType: 'JobStage',
        entityId: stage.id,
        metadata: {
          jobNumber: job.jobNumber,
          stage: stage.stageName,
          stageKey: stage.stageCode,
          userId: primaryId,
          auto: true,
          source,
        },
      },
      tx,
    );
  }

  /**
   * Apply the current rules to work that already exists. Global scope resolves each stage through its own
   * customer (so overrides still win); customer scope only looks at that customer.
   */
  async applyActive(
    stageKey: string,
    mode: ApplyMode,
    customerId: string | null,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<ApplyResult> {
    const areas = await this.rules.areas();
    if (!areas.some((a) => a.stageKey === stageKey)) {
      throw new NotFoundException(`Unknown responsibility area "${stageKey}"`);
    }
    if (customerId) await this.rules.assertCustomer(customerId);
    const result: ApplyResult = {
      stageKey,
      mode,
      customerId,
      considered: 0,
      assigned: 0,
      replaced: 0,
      skipped: {
        alreadyAssigned: 0,
        started: 0,
        unchanged: 0,
        noResponsibleUser: 0,
      },
    };
    const newUsers = new Set<string>();

    if (stageKey === DELIVERY_KEY) {
      await this.applyShipments(mode, customerId, result, newUsers);
    } else {
      await this.applyStages(
        stageKey,
        mode,
        customerId,
        actor,
        result,
        newUsers,
      );
    }
    await this.audit.record({
      actorUserId: actor.id,
      action: AuditAction.RESPONSIBILITY_APPLIED_TO_ACTIVE,
      entityType: 'ResponsibilityRule',
      entityId: customerId ?? stageKey,
      metadata: {
        scope: customerId ? 'CUSTOMER' : 'GLOBAL',
        customerId,
        stageKey,
        mode,
        newUserIds: [...newUsers],
        affectedCount: result.assigned + result.replaced,
        ...result.skipped,
      },
      meta,
    });
    return result;
  }

  private async applyStages(
    stageKey: string,
    mode: ApplyMode,
    customerId: string | null,
    actor: AuthUser,
    result: ApplyResult,
    newUsers: Set<string>,
  ) {
    const targets = await this.prisma.jobStage.findMany({
      where: {
        stageCode: stageKey,
        supersededAt: null,
        requiresAssignment: true,
        status: { in: [...OPEN] },
        job: {
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
          ...(customerId && { customerId }),
        },
      },
      select: { id: true, job: { select: { customerId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    result.considered = targets.length;
    const resolutions = await this.rules.resolveMany([
      ...new Set(targets.map((t) => t.job.customerId)),
    ]);
    for (const t of targets) {
      const r = resolutions.get(t.job.customerId)?.get(stageKey);
      if (!r?.effectiveUserId) {
        result.skipped.noResponsibleUser += 1;
        continue;
      }
      const outcome = await this.prisma.$transaction(async (tx) => {
        // lock + re-read: the stage may have moved since the scan
        const { stage, job } = await this.engine.lockedStage(tx, t.id);
        if (
          stage.supersededAt ||
          !(OPEN as readonly string[]).includes(stage.status) ||
          job.status === 'CANCELLED' ||
          job.status === 'COMPLETED'
        ) {
          return 'skip' as const;
        }
        const active = await tx.stageAssignment.findMany({
          where: { jobStageId: stage.id, removedAt: null },
          include: { user: { select: { name: true } } },
        });
        if (mode === 'UNASSIGNED_ONLY') {
          if (active.length > 0) return 'alreadyAssigned' as const;
          await this.assignFromRule(tx, job, stage, r, actor);
          return 'assigned' as const;
        }
        if (stage.status === 'IN_PROGRESS') return 'started' as const;
        const wanted = [r.effectiveUserId!, ...r.usableAdditionalUserIds]
          .sort()
          .join();
        if (
          active
            .map((a) => a.userId)
            .sort()
            .join() === wanted
        ) {
          return 'unchanged' as const;
        }
        for (const a of active) {
          await tx.stageAssignment.update({
            where: { id: a.id },
            data: { removedAt: new Date(), removedByUserId: actor.id },
          });
          await this.engine.activity(
            tx,
            job.id,
            stage.id,
            actor.id,
            'STAGE_UNASSIGNED',
            `${a.user.name} removed from ${stage.stageName} (default responsibility applied)`,
            { userId: a.userId },
          );
        }
        await this.assignFromRule(tx, job, stage, r, actor);
        return active.length > 0
          ? ('replaced' as const)
          : ('assigned' as const);
      });
      if (outcome === 'assigned' || outcome === 'replaced') {
        result[outcome] += 1;
        newUsers.add(r.effectiveUserId);
      } else if (
        outcome === 'alreadyAssigned' ||
        outcome === 'started' ||
        outcome === 'unchanged'
      ) {
        result.skipped[outcome] += 1;
      }
    }
  }

  /** Delivery lives on the shipment: a live shipment without a delivery person gets the default one. */
  private async applyShipments(
    mode: ApplyMode,
    customerId: string | null,
    result: ApplyResult,
    newUsers: Set<string>,
  ) {
    const shipments = await this.prisma.shipment.findMany({
      where: {
        status: { in: ['DRAFT', 'READY', 'DISPATCHED', 'IN_TRANSIT'] },
        ...(customerId && { order: { customerId } }),
      },
      select: {
        id: true,
        status: true,
        assignedDeliveryUserId: true,
        order: { select: { customerId: true } },
      },
    });
    result.considered = shipments.length;
    const resolutions = await this.rules.resolveMany([
      ...new Set(shipments.map((s) => s.order.customerId)),
    ]);
    for (const s of shipments) {
      const r = resolutions.get(s.order.customerId)?.get(DELIVERY_KEY);
      if (!r?.effectiveUserId) {
        result.skipped.noResponsibleUser += 1;
        continue;
      }
      if (s.assignedDeliveryUserId === r.effectiveUserId) {
        result.skipped.unchanged += 1;
        continue;
      }
      if (s.assignedDeliveryUserId) {
        if (mode === 'UNASSIGNED_ONLY') {
          result.skipped.alreadyAssigned += 1;
          continue;
        }
        if (s.status === 'DISPATCHED' || s.status === 'IN_TRANSIT') {
          result.skipped.started += 1; // already on the road with its driver
          continue;
        }
      }
      const { count } = await this.prisma.shipment.updateMany({
        where: {
          id: s.id,
          assignedDeliveryUserId: s.assignedDeliveryUserId,
          status: s.status,
        },
        data: { assignedDeliveryUserId: r.effectiveUserId },
      });
      if (count === 1) {
        if (s.assignedDeliveryUserId) result.replaced += 1;
        else result.assigned += 1;
        newUsers.add(r.effectiveUserId);
      }
    }
  }
}
