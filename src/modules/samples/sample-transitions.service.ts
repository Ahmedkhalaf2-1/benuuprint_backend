import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import {
  auditActor,
  type ActorRef,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import type { Prisma, Sample } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../notifications/outbox.service.js';
import {
  SAMPLE_TRANSITIONS,
  checkTransition,
  type SampleAction,
} from './sample-state-machine.js';

export interface TransitionContext {
  /** The staff member whose request caused this transition (also for SYSTEM consequences). */
  actor: ActorRef | null;
  /** The portal customer whose request caused this transition (set instead of actor). */
  actorCustomerId?: string | null;
  reason?: string | null;
  meta?: RequestMeta;
  /** Extra metadata for the audit entry. */
  auditMetadata?: Record<string, unknown>;
}

/**
 * The only place a sample's status changes. Takes a row lock, validates the
 * action against the state machine, updates status + timestamps, appends the
 * history row and writes the audit entry, all inside the caller's transaction.
 */
@Injectable()
export class SampleTransitionsService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Serialise concurrent changes to one sample (released at commit). */
  async lock(tx: Prisma.TransactionClient, sampleId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM samples WHERE id = ${sampleId}::uuid FOR UPDATE`;
  }

  async apply(
    tx: Prisma.TransactionClient,
    sampleId: string,
    action: SampleAction,
    ctx: TransitionContext,
  ): Promise<Sample> {
    await this.lock(tx, sampleId);
    const sample = await tx.sample.findUnique({ where: { id: sampleId } });
    if (!sample) throw new NotFoundException('Sample not found');
    if (sample.archivedAt) throw new ConflictException('Sample is archived');

    const rule = SAMPLE_TRANSITIONS[action];
    const check = checkTransition(
      action,
      sample.status,
      sample.holdPreviousStatus,
    );
    if (!check.ok) {
      throw new ConflictException(
        check.reason === 'NO_PREVIOUS_STATUS'
          ? 'The sample has no status to resume to'
          : `Cannot ${action} a sample that is ${sample.status}`,
      );
    }
    const reason = ctx.reason?.trim() || null;
    if (rule.reasonRequired && !reason) {
      throw new BadRequestException(
        `A reason is required to ${action.replace(/-/g, ' ')}`,
      );
    }

    // a customer decision (quotation, approval) arrives as an ActorRef; the portal submit passes actorCustomerId
    const fromActor = auditActor(ctx.actor);
    const who = {
      actorUserId: fromActor.actorUserId,
      actorCustomerId: fromActor.actorCustomerId ?? ctx.actorCustomerId ?? null,
    };
    const now = new Date();
    const data: Prisma.SampleUncheckedUpdateInput = {
      status: check.to,
      holdPreviousStatus: check.to === 'ON_HOLD' ? sample.status : null,
    };
    if (action === 'submit') data.submittedAt = now;
    if (action === 'start-review') data.reviewedAt = now;
    if (action === 'sample-approved') data.approvedAt = now;
    if (action === 'complete') data.completedAt = now;

    const updated = await tx.sample.update({ where: { id: sampleId }, data });
    await tx.sampleStatusHistory.create({
      data: {
        sampleId,
        fromStatus: sample.status,
        toStatus: check.to,
        action,
        reason,
        ...who,
        source: who.actorCustomerId ? 'CUSTOMER' : rule.origin,
      },
    });
    const sampleEvent =
      check.to === 'SUBMITTED'
        ? 'SAMPLE_SUBMITTED'
        : check.to === 'AWAITING_APPROVAL'
          ? 'SAMPLE_READY_FOR_APPROVAL'
          : check.to === 'APPROVED'
            ? 'SAMPLE_APPROVED'
            : null;
    if (sampleEvent && sample.status !== check.to)
      await this.outbox.emit(tx, {
        eventType: sampleEvent,
        aggregateType: 'Sample',
        aggregateId: sampleId,
        payload: { sampleId },
      });
    // the reviewed sample was sent back for changes: the customer is told we have it, staff are told why
    if (action === 'sample-rejected')
      await this.outbox.emit(tx, {
        eventType: 'SAMPLE_CHANGES_REQUESTED',
        aggregateType: 'Sample',
        aggregateId: sampleId,
        payload: { sampleId, ...(reason && { reason }) },
      });

    // Money already verified matters when a sample is cancelled/rejected: record it.
    let verifiedPaid: string | undefined;
    if (action === 'cancel' || action === 'reject') {
      const sum = await tx.payment.aggregate({
        where: { sampleId, status: 'VERIFIED' },
        _sum: { amount: true },
      });
      verifiedPaid = sum._sum.amount?.toFixed(2) ?? '0.00';
    }
    await this.audit.record(
      {
        ...who,
        action: AuditAction.SAMPLE_STATUS_CHANGED,
        entityType: 'Sample',
        entityId: sampleId,
        metadata: {
          sampleNumber: sample.sampleNumber,
          action,
          from: sample.status,
          to: check.to,
          reason,
          source: who.actorCustomerId ? 'CUSTOMER' : rule.origin,
          ...(verifiedPaid !== undefined && { verifiedPaid }),
          ...ctx.auditMetadata,
        },
        meta: ctx.meta,
      },
      tx,
    );
    return updated;
  }
}
