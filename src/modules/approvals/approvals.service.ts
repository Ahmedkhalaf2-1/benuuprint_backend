import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import {
  auditActor,
  type ActorRef,
  type AuthUser,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  Approval,
  ApprovalMode,
  ApprovalType,
  Prisma,
} from '../../generated/prisma/client.js';
import { ArtworkService } from '../artwork/artwork.service.js';
import { AuditService } from '../audit/audit.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { SampleProductionSpecService } from '../samples/sample-production-spec.service.js';
import { SampleTransitionsService } from '../samples/sample-transitions.service.js';
import type {
  ApprovalResponseDto,
  RecordedAs,
  RequestApprovalDto,
  RespondApprovalDto,
} from './dto/approval.dto.js';

export type Decision = 'APPROVED' | 'REJECTED';

const toApproval = (a: Approval): ApprovalResponseDto => ({
  id: a.id,
  type: a.type,
  sampleId: a.sampleId,
  quotationVersionId: a.quotationVersionId,
  artworkVersionId: a.artworkVersionId,
  productionSpecId: a.productionSpecId,
  status: a.status,
  mode: a.mode,
  staffRecorded:
    a.mode === 'STAFF_RECORDED_ON_BEHALF' || a.mode === 'STAFF_INTERNAL',
  requestedByUserId: a.requestedByUserId,
  requestedByCustomerId: a.requestedByCustomerId,
  respondedByCustomerId: a.respondedByCustomerId,
  requestedAt: a.requestedAt,
  expiresAt: a.expiresAt,
  respondedAt: a.respondedAt,
  respondedByUserId: a.respondedByUserId,
  responseNote: a.responseNote,
  sourceNote: a.sourceNote,
  createdAt: a.createdAt,
});

/** Types whose decision belongs to the customer: staff may only record it on their behalf. */
const CUSTOMER_DECISION_TYPES: ApprovalType[] = ['QUOTATION', 'SAMPLE'];
/** Types that additionally need the samples.approve permission. */
const SAMPLE_LEVEL_TYPES: ApprovalType[] = ['SAMPLE', 'PRODUCTION_SPEC'];

/**
 * Pure rules for recording a decision. Staff-recorded customer decisions always carry
 * their evidence; they are never presented as authenticated customer actions.
 */
export function resolveDecision(
  type: ApprovalType,
  decision: Decision,
  dto: RespondApprovalDto,
  byCustomer = false,
): {
  mode: ApprovalMode;
  sourceNote: string | null;
  responseNote: string | null;
} {
  const recordedAs: RecordedAs = dto.recordedAs ?? 'ON_BEHALF_OF_CUSTOMER';
  const sourceNote = dto.sourceNote?.trim() || null;
  const responseNote = dto.responseNote?.trim() || null;
  if (byCustomer) {
    // The authenticated customer decides for themselves: no staff evidence is needed or accepted.
    if (decision === 'REJECTED' && type === 'SAMPLE' && !responseNote) {
      throw new BadRequestException(
        'Tell us what you would like changed (it becomes the rework reason)',
      );
    }
    return { mode: 'CUSTOMER_AUTHENTICATED', sourceNote: null, responseNote };
  }
  if (recordedAs === 'INTERNAL' && CUSTOMER_DECISION_TYPES.includes(type)) {
    throw new BadRequestException(
      `A ${type} decision belongs to the customer and cannot be recorded as INTERNAL`,
    );
  }
  if (recordedAs === 'ON_BEHALF_OF_CUSTOMER' && !sourceNote) {
    throw new BadRequestException(
      'sourceNote is required: say how the customer communicated this decision (e.g. "WhatsApp, 21 Oct 14:05")',
    );
  }
  if (decision === 'REJECTED' && type === 'SAMPLE' && !responseNote) {
    throw new BadRequestException(
      'responseNote is required when rejecting a sample (it becomes the rework reason)',
    );
  }
  return {
    mode:
      recordedAs === 'INTERNAL' ? 'STAFF_INTERNAL' : 'STAFF_RECORDED_ON_BEHALF',
    sourceNote,
    responseNote,
  };
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quotations: QuotationsService,
    private readonly artwork: ArtworkService,
    private readonly transitions: SampleTransitionsService,
    private readonly specs: SampleProductionSpecService,
  ) {}

  async listForSample(sampleId: string): Promise<ApprovalResponseDto[]> {
    if (
      !(await this.prisma.sample.findUnique({
        where: { id: sampleId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Sample not found');
    }
    const rows = await this.prisma.approval.findMany({
      where: { sampleId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toApproval);
  }

  async get(id: string): Promise<ApprovalResponseDto> {
    const row = await this.prisma.approval.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Approval not found');
    return toApproval(row);
  }

  async request(
    sampleId: string,
    dto: RequestApprovalDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ApprovalResponseDto> {
    this.assertTypePermission(dto.type, actor);
    if (dto.expiresAt && dto.expiresAt <= new Date()) {
      throw new BadRequestException('expiresAt must be in the future');
    }
    const created = await this.prisma.$transaction(async (tx) =>
      this.createPending(tx, sampleId, dto, actor, meta),
    );
    return toApproval(created);
  }

  approve(
    id: string,
    dto: RespondApprovalDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    return this.respond(id, 'APPROVED', dto, actor, meta);
  }

  reject(
    id: string,
    dto: RespondApprovalDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    return this.respond(id, 'REJECTED', dto, actor, meta);
  }

  async cancel(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ApprovalResponseDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM approvals WHERE id = ${id}::uuid FOR UPDATE`;
      const approval = await tx.approval.findUnique({ where: { id } });
      if (!approval) throw new NotFoundException('Approval not found');
      this.assertTypePermission(approval.type, actor);
      if (approval.status !== 'PENDING')
        throw new ConflictException(`Approval is already ${approval.status}`);
      const updated = await tx.approval.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.APPROVAL_CANCELLED,
          entityType: 'Approval',
          entityId: id,
          metadata: { type: approval.type, sampleId: approval.sampleId },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toApproval(row);
  }

  /**
   * Convenience for the quotation accept/reject endpoints: finds (or opens) the pending
   * QUOTATION approval for the version and answers it, in one transaction.
   */
  async recordQuotationDecision(
    versionId: string,
    decision: Decision,
    dto: RespondApprovalDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ApprovalResponseDto> {
    this.assertTypePermission('QUOTATION', actor);
    const version = await this.prisma.quotationVersion.findUnique({
      where: { id: versionId },
      include: { quotation: true },
    });
    if (!version) throw new NotFoundException('Quotation version not found');
    const sampleId = version.quotation.sampleId;
    if (!sampleId) {
      throw new ConflictException(
        'This quotation belongs to an order; record the decision with the order quotation endpoints',
      );
    }
    if (await this.quotations.expireIfDue(versionId, actor, meta)) {
      throw new ConflictException('This quotation version has expired');
    }
    resolveDecision('QUOTATION', decision, dto);

    const approvalId = await this.prisma.$transaction(async (tx) => {
      let pending = await tx.approval.findFirst({
        where: { quotationVersionId: versionId, status: 'PENDING' },
      });
      if (!pending) {
        pending = await this.createPending(
          tx,
          sampleId,
          { type: 'QUOTATION', quotationVersionId: versionId },
          actor,
          meta,
        );
      }
      await this.respondInTx(tx, pending.id, decision, dto, actor, meta);
      return pending.id;
    });
    return this.get(approvalId);
  }

  // ---- customer portal ------------------------------------------------------------------------

  /**
   * The signed-in customer accepts or rejects a quotation version of THEIR sample. Ownership is proven
   * through the sample (foreign or unknown ids are a plain 404); everything else (SENT only, not
   * superseded, not expired, not invalidated) is the staff rule, enforced by the same transaction.
   */
  async customerQuotationDecision(
    customerId: string,
    versionId: string,
    decision: Decision,
    responseNote: string | undefined,
    meta: RequestMeta,
  ): Promise<ApprovalResponseDto> {
    const version = await this.prisma.quotationVersion.findFirst({
      where: {
        id: versionId,
        quotation: { sample: { is: { customerId, archivedAt: null } } },
      },
      include: { quotation: true },
    });
    if (!version) throw new NotFoundException('Quotation not found');
    const sampleId = version.quotation.sampleId!;
    const actor: ActorRef = { id: customerId, customer: true };
    if (await this.quotations.expireIfDue(versionId, actor, meta)) {
      throw new ConflictException('This quotation has expired');
    }
    const dto = { responseNote } as RespondApprovalDto;
    const approvalId = await this.prisma.$transaction(async (tx) => {
      let pending = await tx.approval.findFirst({
        where: { quotationVersionId: versionId, status: 'PENDING' },
      });
      if (!pending) {
        pending = await this.createPending(
          tx,
          sampleId,
          { type: 'QUOTATION', quotationVersionId: versionId },
          actor,
          meta,
        );
      }
      await this.respondInTx(tx, pending.id, decision, dto, actor, meta);
      return pending.id;
    });
    return this.get(approvalId);
  }

  /** The signed-in customer approves the finished physical sample, or sends it back with their changes. */
  async customerSampleDecision(
    customerId: string,
    sampleId: string,
    decision: Decision,
    responseNote: string | undefined,
    meta: RequestMeta,
  ): Promise<ApprovalResponseDto> {
    const owned = await this.prisma.sample.findFirst({
      where: { id: sampleId, customerId, archivedAt: null },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Request not found');
    const actor: ActorRef = { id: customerId, customer: true };
    const dto = { responseNote } as RespondApprovalDto;
    resolveDecision('SAMPLE', decision, dto, true);
    const approvalId = await this.prisma.$transaction(async (tx) => {
      let pending = await tx.approval.findFirst({
        where: { sampleId, type: 'SAMPLE', status: 'PENDING' },
      });
      if (!pending) {
        pending = await this.createPending(
          tx,
          sampleId,
          { type: 'SAMPLE' },
          actor,
          meta,
        );
      }
      await this.respondInTx(tx, pending.id, decision, dto, actor, meta);
      return pending.id;
    });
    return this.get(approvalId);
  }

  // ---- internals ----------------------------------------------------------------------------

  private async respond(
    id: string,
    decision: Decision,
    dto: RespondApprovalDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ApprovalResponseDto> {
    const approval = await this.prisma.approval.findUnique({ where: { id } });
    if (!approval) throw new NotFoundException('Approval not found');
    this.assertTypePermission(approval.type, actor);
    resolveDecision(approval.type, decision, dto);

    if (
      approval.status === 'PENDING' &&
      approval.expiresAt &&
      approval.expiresAt <= new Date()
    ) {
      await this.expire(approval, actor, meta);
      throw new ConflictException('This approval request has expired');
    }
    if (approval.type === 'QUOTATION' && approval.quotationVersionId) {
      if (
        await this.quotations.expireIfDue(
          approval.quotationVersionId,
          actor,
          meta,
        )
      ) {
        throw new ConflictException('The quotation version has expired');
      }
    }
    await this.prisma.$transaction((tx) =>
      this.respondInTx(tx, id, decision, dto, actor, meta),
    );
    return this.get(id);
  }

  private async respondInTx(
    tx: Prisma.TransactionClient,
    id: string,
    decision: Decision,
    dto: RespondApprovalDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM approvals WHERE id = ${id}::uuid FOR UPDATE`;
    const approval = await tx.approval.findUniqueOrThrow({ where: { id } });
    if (approval.status !== 'PENDING') {
      throw new ConflictException(`Approval is already ${approval.status}`);
    }
    const { mode, sourceNote, responseNote } = resolveDecision(
      approval.type,
      decision,
      dto,
      !!actor.customer,
    );
    const updated = await tx.approval.update({
      where: { id },
      data: {
        status: decision,
        mode,
        respondedAt: new Date(),
        respondedByUserId: actor.customer ? null : actor.id,
        respondedByCustomerId: actor.customer ? actor.id : null,
        responseNote,
        sourceNote,
      },
    });

    // Artwork and specification sign-offs are staff business: a customer actor only ever reaches
    // QUOTATION and SAMPLE (the customer-portal entry points), and this keeps it that way.
    if (
      actor.customer &&
      (approval.type === 'ARTWORK' || approval.type === 'PRODUCTION_SPEC')
    ) {
      throw new ForbiddenException(
        `A customer cannot decide a ${approval.type} approval`,
      );
    }
    const staff = actor as AuthUser;

    switch (approval.type) {
      case 'QUOTATION':
        if (decision === 'APPROVED') {
          await this.quotations.applyAcceptance(
            tx,
            approval.quotationVersionId!,
            actor,
            meta,
            id,
          );
        } else {
          await this.quotations.applyRejection(
            tx,
            approval.quotationVersionId!,
            responseNote,
            actor,
            meta,
            id,
          );
        }
        break;
      case 'ARTWORK':
        if (decision === 'APPROVED')
          await this.artwork.approveVersion(
            tx,
            approval.artworkVersionId!,
            staff,
            meta,
          );
        else
          await this.artwork.rejectVersion(
            tx,
            approval.artworkVersionId!,
            responseNote,
            staff,
            meta,
          );
        break;
      case 'SAMPLE':
        if (decision === 'APPROVED') {
          await this.specs.freezeApprovedSample(
            tx,
            approval.sampleId,
            updated,
            actor,
            meta,
          );
        } else {
          await this.transitions.apply(
            tx,
            approval.sampleId,
            'sample-rejected',
            {
              actor,
              meta,
              reason: responseNote,
              auditMetadata: { approvalId: id },
            },
          );
        }
        break;
      case 'PRODUCTION_SPEC':
        // A recorded sign-off only; Phase 4 may require it before releasing a factory job.
        break;
    }

    await this.audit.record(
      {
        ...auditActor(actor),
        action:
          decision === 'APPROVED'
            ? AuditAction.APPROVAL_APPROVED
            : AuditAction.APPROVAL_REJECTED,
        entityType: 'Approval',
        entityId: id,
        metadata: {
          type: approval.type,
          sampleId: approval.sampleId,
          mode,
          // true = recorded by staff (on the customer's behalf or internally); false = the customer decided.
          staffRecorded: !actor.customer,
          sourceNote,
          responseNote,
          quotationVersionId: approval.quotationVersionId,
          artworkVersionId: approval.artworkVersionId,
          productionSpecId: approval.productionSpecId,
        },
        meta,
      },
      tx,
    );
  }

  private async createPending(
    tx: Prisma.TransactionClient,
    sampleId: string,
    dto: Pick<
      RequestApprovalDto,
      | 'type'
      | 'quotationVersionId'
      | 'artworkVersionId'
      | 'productionSpecId'
      | 'expiresAt'
    >,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<Approval> {
    await this.transitions.lock(tx, sampleId);
    const sample = await tx.sample.findUnique({ where: { id: sampleId } });
    if (!sample) throw new NotFoundException('Sample not found');
    if (sample.archivedAt) throw new ConflictException('Sample is archived');

    const targets = [
      dto.quotationVersionId,
      dto.artworkVersionId,
      dto.productionSpecId,
    ].filter(Boolean).length;
    const expected: Record<ApprovalType, boolean> = {
      QUOTATION: !!dto.quotationVersionId,
      ARTWORK: !!dto.artworkVersionId,
      PRODUCTION_SPEC: !!dto.productionSpecId,
      SAMPLE: targets === 0,
    };
    if (!expected[dto.type] || targets > 1) {
      throw new BadRequestException(
        dto.type === 'SAMPLE'
          ? 'A SAMPLE approval takes no target id'
          : `A ${dto.type} approval needs exactly its own target id (${
              {
                QUOTATION: 'quotationVersionId',
                ARTWORK: 'artworkVersionId',
                PRODUCTION_SPEC: 'productionSpecId',
              }[dto.type]
            })`,
      );
    }

    if (dto.type === 'QUOTATION') {
      const version = await tx.quotationVersion.findUnique({
        where: { id: dto.quotationVersionId! },
        include: { quotation: true },
      });
      if (!version || version.quotation.sampleId !== sampleId)
        throw new NotFoundException(
          'Quotation version not found for this sample',
        );
      if (version.status !== 'SENT') {
        throw new ConflictException(
          version.status === 'SUPERSEDED'
            ? 'This quotation version has been superseded; approve the latest version'
            : `Only a SENT quotation version can be approved (this one is ${version.status})`,
        );
      }
    } else if (dto.type === 'ARTWORK') {
      const version = await tx.artworkVersion.findUnique({
        where: { id: dto.artworkVersionId! },
        include: { artwork: true },
      });
      if (!version) throw new NotFoundException('Artwork version not found');
      const { artwork } = version;
      if (artwork.archivedAt)
        throw new ConflictException('Artwork is archived');
      if (
        artwork.brandId !== sample.brandId &&
        artwork.sampleId !== sample.id
      ) {
        throw new BadRequestException(
          'This artwork belongs to a different brand or sample',
        );
      }
      if (version.status !== 'DRAFT') {
        throw new ConflictException(
          `Only a DRAFT artwork version can be approved (this one is ${version.status})`,
        );
      }
    } else if (dto.type === 'PRODUCTION_SPEC') {
      const spec = await tx.sampleProductionSpec.findUnique({
        where: { id: dto.productionSpecId! },
      });
      if (
        !spec ||
        spec.sampleId !== sampleId ||
        spec.kind !== 'APPROVED_REFERENCE'
      )
        throw new NotFoundException(
          'Production specification not found for this sample',
        );
    } else if (sample.status !== 'AWAITING_APPROVAL') {
      throw new ConflictException(
        `A sample can only be approved while AWAITING_APPROVAL (it is ${sample.status})`,
      );
    }

    const pending = await tx.approval.findFirst({
      where: {
        sampleId,
        status: 'PENDING',
        type: dto.type,
        quotationVersionId: dto.quotationVersionId ?? undefined,
        artworkVersionId: dto.artworkVersionId ?? undefined,
        productionSpecId: dto.productionSpecId ?? undefined,
      },
    });
    if (pending)
      throw new ConflictException(
        'A pending approval request already exists for this target',
      );

    const created = await tx.approval.create({
      data: {
        type: dto.type,
        sampleId,
        quotationVersionId: dto.quotationVersionId,
        artworkVersionId: dto.artworkVersionId,
        productionSpecId: dto.productionSpecId,
        requestedByUserId: actor.customer ? null : actor.id,
        requestedByCustomerId: actor.customer ? actor.id : null,
        expiresAt: dto.expiresAt,
      },
    });
    await this.audit.record(
      {
        ...auditActor(actor),
        action: AuditAction.APPROVAL_REQUESTED,
        entityType: 'Approval',
        entityId: created.id,
        metadata: {
          type: dto.type,
          sampleId,
          quotationVersionId: dto.quotationVersionId,
          artworkVersionId: dto.artworkVersionId,
          productionSpecId: dto.productionSpecId,
        },
        meta,
      },
      tx,
    );
    return created;
  }

  private async expire(
    approval: Approval,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.approval.updateMany({
        where: { id: approval.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      if (updated.count === 1) {
        await this.audit.record(
          {
            ...auditActor(actor),
            action: AuditAction.APPROVAL_EXPIRED,
            entityType: 'Approval',
            entityId: approval.id,
            metadata: {
              type: approval.type,
              sampleId: approval.sampleId,
              expiresAt: approval.expiresAt,
            },
            meta,
          },
          tx,
        );
      }
    });
  }

  private assertTypePermission(type: ApprovalType, actor: AuthUser): void {
    if (
      SAMPLE_LEVEL_TYPES.includes(type) &&
      !actor.permissions.has('samples.approve')
    ) {
      throw new ForbiddenException(
        `Recording a ${type} approval requires samples.approve`,
      );
    }
  }
}
