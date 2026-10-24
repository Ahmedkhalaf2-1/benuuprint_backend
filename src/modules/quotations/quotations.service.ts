import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '../../common/enums/audit-actions.js';
import {
  auditActor,
  type ActorRef,
  type AuthUser,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ReferenceService } from '../../database/reference-sequence.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { CommercialService } from '../commercial/commercial.service.js';
import { D, computeTotals, fmt } from '../commercial/money.js';
import { OutboxService } from '../notifications/outbox.service.js';
import { OrderActivityService } from '../orders/core/order-activity.service.js';
import { OrderTransitionsService } from '../orders/core/order-transitions.service.js';
import { SampleTransitionsService } from '../samples/sample-transitions.service.js';
import type {
  CreateQuotationDto,
  CreateQuotationVersionDto,
  QuotationLineItemDto,
  QuotationLineItemResponseDto,
  QuotationResponseDto,
  QuotationVersionResponseDto,
  UpdateQuotationVersionDto,
} from './dto/quotation.dto.js';

const versionInclude = {
  lineItems: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  quotation: { select: { currency: true } },
} satisfies Prisma.QuotationVersionInclude;
type VersionRow = Prisma.QuotationVersionGetPayload<{
  include: typeof versionInclude;
}>;
type QuotationRow = Prisma.QuotationGetPayload<{
  include: { versions: { include: typeof versionInclude } };
}>;

const toLine = (
  l: VersionRow['lineItems'][number],
): QuotationLineItemResponseDto => ({
  id: l.id,
  type: l.type,
  description: l.description,
  quantity: fmt(D(l.quantity)),
  unitPrice: fmt(D(l.unitPrice)),
  amount: fmt(D(l.amount)),
  sortOrder: l.sortOrder,
  metadata: (l.metadata as Record<string, unknown> | null) ?? null,
});

export const toQuotationVersion = (
  v: VersionRow,
): QuotationVersionResponseDto => ({
  id: v.id,
  quotationId: v.quotationId,
  versionNumber: v.versionNumber,
  status: v.status,
  currency: v.quotation.currency,
  subtotal: fmt(D(v.subtotal)),
  discount: fmt(D(v.discount)),
  taxPercent: fmt(D(v.taxPercent)),
  tax: fmt(D(v.tax)),
  total: fmt(D(v.total)),
  notes: v.notes,
  customerNotes: v.customerNotes,
  validUntil: v.validUntil,
  createdAt: v.createdAt,
  sentAt: v.sentAt,
  acceptedAt: v.acceptedAt,
  rejectedAt: v.rejectedAt,
  expiredAt: v.expiredAt,
  supersededAt: v.supersededAt,
  orderRevision: v.orderRevision,
  invalidatedAt: v.invalidatedAt,
  invalidatedByRevision: v.invalidatedByRevision,
  invalidationReason: v.invalidationReason,
  lineItems: v.lineItems.map(toLine),
});

const toQuotation = (q: QuotationRow): QuotationResponseDto => {
  const versions = [...q.versions]
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map(toQuotationVersion);
  return {
    id: q.id,
    quotationNumber: q.quotationNumber,
    sampleId: q.sampleId,
    orderId: q.orderId,
    status: q.status,
    currency: q.currency,
    createdAt: q.createdAt,
    currentVersion: versions[0]!,
    versions,
  };
};

const quotationInclude = {
  versions: { include: versionInclude },
} satisfies Prisma.QuotationInclude;
const LIVE = ['DRAFT', 'SENT', 'ACCEPTED'] as const;

@Injectable()
export class QuotationsService {
  private readonly defaultCurrency: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
    private readonly transitions: SampleTransitionsService,
    private readonly commercial: CommercialService,
    private readonly orderTransitions: OrderTransitionsService,
    private readonly orderActivity: OrderActivityService,
    private readonly outbox: OutboxService,
    config: ConfigService,
  ) {
    this.defaultCurrency = config.getOrThrow<AppConfig>('app').defaultCurrency;
  }

  // ---- reads -----------------------------------------------------------------------

  async listForSample(sampleId: string): Promise<QuotationResponseDto[]> {
    await this.assertSample(sampleId);
    const rows = await this.prisma.quotation.findMany({
      where: { sampleId, archivedAt: null },
      include: quotationInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toQuotation);
  }

  async get(id: string): Promise<QuotationResponseDto> {
    const row = await this.prisma.quotation.findUnique({
      where: { id },
      include: quotationInclude,
    });
    if (!row) throw new NotFoundException('Quotation not found');
    return toQuotation(row);
  }

  async getVersion(versionId: string): Promise<QuotationVersionResponseDto> {
    const v = await this.prisma.quotationVersion.findUnique({
      where: { id: versionId },
      include: versionInclude,
    });
    if (!v) throw new NotFoundException('Quotation version not found');
    return toQuotationVersion(v);
  }

  // ---- writes ----------------------------------------------------------------------

  /** First quotation for a sample under review (one live quotation per sample at a time). */
  async create(
    sampleId: string,
    dto: CreateQuotationDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<QuotationResponseDto> {
    this.assertValidUntil(dto.validUntil);
    const totals = computeTotals(
      dto.lineItems ?? [],
      dto.discount,
      dto.taxPercent,
    );
    const created = await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, sampleId);
      const sample = await tx.sample.findUnique({ where: { id: sampleId } });
      if (!sample) throw new NotFoundException('Sample not found');
      if (sample.archivedAt) throw new ConflictException('Sample is archived');
      if (sample.status !== 'UNDER_REVIEW') {
        throw new ConflictException(
          `A quotation can only be created while the sample is UNDER_REVIEW (it is ${sample.status})`,
        );
      }
      const live = await tx.quotation.findFirst({
        where: { sampleId, status: { in: [...LIVE] } },
      });
      if (live) {
        throw new ConflictException(
          `${live.quotationNumber} is still ${live.status}; create a new version instead`,
        );
      }
      const quotationNumber = await this.references.next('QTN', tx);
      const quotation = await tx.quotation.create({
        data: {
          quotationNumber,
          sampleId,
          currency: dto.currency ?? this.defaultCurrency,
          createdByUserId: actor.id,
        },
      });
      const version = await this.insertVersion(
        tx,
        quotation.id,
        1,
        dto.lineItems ?? [],
        totals,
        dto,
        actor,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QUOTATION_CREATED,
          entityType: 'Quotation',
          entityId: quotation.id,
          metadata: {
            quotationNumber,
            sampleId,
            sampleNumber: sample.sampleNumber,
            currency: quotation.currency,
          },
          meta,
        },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QUOTATION_VERSION_CREATED,
          entityType: 'QuotationVersion',
          entityId: version.id,
          metadata: {
            quotationId: quotation.id,
            versionNumber: 1,
            total: fmt(totals.total),
          },
          meta,
        },
        tx,
      );
      return quotation;
    });
    return this.get(created.id);
  }

  /**
   * New version = new offer. A SENT predecessor is superseded immediately (only the
   * latest version is ever live); an ACCEPTED quotation is final and cannot be
   * versioned; an open DRAFT must be edited or sent instead.
   */
  async createVersion(
    quotationId: string,
    dto: CreateQuotationVersionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<QuotationVersionResponseDto> {
    this.assertValidUntil(dto.validUntil);
    const created = await this.prisma.$transaction(async (tx) => {
      const head = await tx.quotation.findUnique({
        where: { id: quotationId },
      });
      if (!head) throw new NotFoundException('Quotation not found');
      const { sample, order } = await this.lockTarget(tx, head);
      if (sample && !['UNDER_REVIEW', 'QUOTED'].includes(sample.status)) {
        throw new ConflictException(
          `A new version cannot be created while the sample is ${sample.status}`,
        );
      }
      if (order) this.assertOrderQuotable(order);
      const latest = await tx.quotationVersion.findFirst({
        where: { quotationId },
        orderBy: { versionNumber: 'desc' },
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!latest) throw new ConflictException('Quotation has no versions');
      if (latest.status === 'ACCEPTED') {
        throw new ConflictException(
          'An accepted quotation is final; revise the sample to change commercial terms',
        );
      }
      if (latest.status === 'DRAFT') {
        throw new ConflictException(
          `Version ${latest.versionNumber} is still a DRAFT; edit or send it`,
        );
      }
      if (latest.status === 'SENT') {
        await tx.quotationVersion.update({
          where: { id: latest.id },
          data: { status: 'SUPERSEDED', supersededAt: new Date() },
        });
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.QUOTATION_VERSION_SUPERSEDED,
            entityType: 'QuotationVersion',
            entityId: latest.id,
            metadata: { quotationId, versionNumber: latest.versionNumber },
            meta,
          },
          tx,
        );
      }
      const lines: QuotationLineItemDto[] =
        dto.lineItems ??
        latest.lineItems.map((l) => ({
          type: l.type,
          description: l.description,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          sortOrder: l.sortOrder,
          metadata: (l.metadata as Record<string, unknown> | null) ?? undefined,
        }));
      const discount = dto.discount ?? Number(latest.discount);
      const taxPercent = dto.taxPercent ?? Number(latest.taxPercent);
      const totals = computeTotals(lines, discount, taxPercent);
      const version = await this.insertVersion(
        tx,
        quotationId,
        latest.versionNumber + 1,
        lines,
        totals,
        {
          notes: dto.notes ?? latest.notes ?? undefined,
          customerNotes: dto.customerNotes ?? latest.customerNotes ?? undefined,
          validUntil: dto.validUntil,
        },
        actor,
        order?.revisionNumber,
      );
      await tx.quotation.update({
        where: { id: quotationId },
        data: { status: 'DRAFT' },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QUOTATION_VERSION_CREATED,
          entityType: 'QuotationVersion',
          entityId: version.id,
          metadata: {
            quotationId,
            versionNumber: version.versionNumber,
            total: fmt(totals.total),
          },
          meta,
        },
        tx,
      );
      return version;
    });
    return this.getVersion(created.id);
  }

  /** Edit a DRAFT in place. Sent/accepted/rejected/expired/superseded versions are immutable. */
  async updateVersion(
    versionId: string,
    dto: UpdateQuotationVersionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<QuotationVersionResponseDto> {
    if (dto.validUntil) this.assertValidUntil(dto.validUntil);
    await this.prisma.$transaction(async (tx) => {
      const version = await tx.quotationVersion.findUnique({
        where: { id: versionId },
        include: { quotation: true, lineItems: true },
      });
      if (!version) throw new NotFoundException('Quotation version not found');
      await this.lockTarget(tx, version.quotation);
      const current = await tx.quotationVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      if (current.status !== 'DRAFT') {
        throw new ConflictException(
          `A ${current.status} quotation version is immutable; create a new version`,
        );
      }
      const lines: QuotationLineItemDto[] =
        dto.lineItems ??
        version.lineItems.map((l) => ({
          type: l.type,
          description: l.description,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          sortOrder: l.sortOrder,
          metadata: (l.metadata as Record<string, unknown> | null) ?? undefined,
        }));
      const totals = computeTotals(
        lines,
        dto.discount ?? Number(current.discount),
        dto.taxPercent ?? Number(current.taxPercent),
      );
      if (dto.lineItems) {
        await tx.quotationLineItem.deleteMany({
          where: { quotationVersionId: versionId },
        });
        await tx.quotationLineItem.createMany({
          data: this.lineData(versionId, lines, totals),
        });
      }
      await tx.quotationVersion.update({
        where: { id: versionId },
        data: {
          subtotal: totals.subtotal,
          discount: totals.discount,
          taxPercent: totals.taxPercent,
          tax: totals.tax,
          total: totals.total,
          notes: dto.notes,
          customerNotes: dto.customerNotes,
          validUntil: dto.validUntil,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QUOTATION_VERSION_UPDATED,
          entityType: 'QuotationVersion',
          entityId: versionId,
          metadata: {
            quotationId: version.quotationId,
            versionNumber: version.versionNumber,
            fields: Object.keys(dto),
            total: fmt(totals.total),
          },
          meta,
        },
        tx,
      );
    });
    return this.getVersion(versionId);
  }

  /** DRAFT → SENT. The first send moves the sample UNDER_REVIEW → QUOTED. */
  async send(
    versionId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<QuotationVersionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const version = await tx.quotationVersion.findUnique({
        where: { id: versionId },
        include: { quotation: true, lineItems: true },
      });
      if (!version) throw new NotFoundException('Quotation version not found');
      const { sample, order } = await this.lockTarget(tx, version.quotation);
      const current = await tx.quotationVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      if (current.status !== 'DRAFT')
        throw new ConflictException(`Version is already ${current.status}`);
      if (version.lineItems.length === 0)
        throw new BadRequestException(
          'Add at least one line item before sending',
        );
      if (current.validUntil && current.validUntil <= new Date()) {
        throw new BadRequestException(
          'validUntil is in the past; extend it before sending',
        );
      }
      if (order) {
        this.assertOrderQuotable(order);
        await this.orderActivity.log(
          tx,
          order.id,
          actor.id,
          'QUOTATION_SENT',
          `Quotation ${version.quotation.quotationNumber} v${version.versionNumber} sent`,
          { quotationVersionId: versionId },
        );
      } else if (sample!.status === 'UNDER_REVIEW') {
        await this.transitions.apply(tx, sample!.id, 'quote-sent', {
          actor,
          meta,
          auditMetadata: { quotationVersionId: versionId },
        });
      } else if (sample!.status !== 'QUOTED') {
        throw new ConflictException(
          `A quotation cannot be sent while the sample is ${sample!.status}`,
        );
      }
      await tx.quotationVersion.update({
        where: { id: versionId },
        data: { status: 'SENT', sentAt: new Date() },
      });
      await tx.quotation.update({
        where: { id: version.quotationId },
        data: { status: 'SENT' },
      });
      await this.outbox.emit(tx, {
        eventType: 'QUOTATION_SENT',
        aggregateType: 'Quotation',
        aggregateId: version.quotationId,
        payload: {
          quotationNumber: version.quotation.quotationNumber,
          ...(order ? { orderId: order.id } : { sampleId: sample!.id }),
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QUOTATION_VERSION_SENT,
          entityType: 'QuotationVersion',
          entityId: versionId,
          metadata: {
            quotationId: version.quotationId,
            quotationNumber: version.quotation.quotationNumber,
            versionNumber: version.versionNumber,
            total: fmt(D(current.total)),
            validUntil: current.validUntil,
          },
          meta,
        },
        tx,
      );
    });
    return this.getVersion(versionId);
  }

  // ---- decision effects (called by the approvals module inside its transaction) -------------

  /** If the offer's validity has lapsed, record EXPIRED (committed on its own) and report it. */
  async expireIfDue(
    versionId: string,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<boolean> {
    const version = await this.prisma.quotationVersion.findUnique({
      where: { id: versionId },
    });
    if (
      !version ||
      version.status !== 'SENT' ||
      !version.validUntil ||
      version.validUntil > new Date()
    ) {
      return false;
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.quotationVersion.updateMany({
        where: { id: versionId, status: 'SENT' },
        data: { status: 'EXPIRED', expiredAt: new Date() },
      });
      if (updated.count === 1) {
        await tx.quotation.update({
          where: { id: version.quotationId },
          data: { status: 'EXPIRED' },
        });
        await this.audit.record(
          {
            ...auditActor(actor),
            action: AuditAction.QUOTATION_VERSION_EXPIRED,
            entityType: 'QuotationVersion',
            entityId: versionId,
            metadata: {
              quotationId: version.quotationId,
              versionNumber: version.versionNumber,
              validUntil: version.validUntil,
            },
            meta,
          },
          tx,
        );
      }
    });
    return true;
  }

  async applyAcceptance(
    tx: Prisma.TransactionClient,
    versionId: string,
    actor: ActorRef,
    meta: RequestMeta,
    approvalId: string,
  ): Promise<void> {
    const version = await this.lockedSentVersion(tx, versionId, 'accepted');
    const sampleId = this.sampleIdOf(version.quotation);
    await tx.quotationVersion.update({
      where: { id: versionId },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    await tx.quotation.update({
      where: { id: version.quotationId },
      data: { status: 'ACCEPTED' },
    });
    await this.outbox.emit(tx, {
      eventType: 'QUOTATION_ACCEPTED',
      aggregateType: 'Quotation',
      aggregateId: version.quotationId,
      payload: { quotationNumber: version.quotation.quotationNumber, sampleId },
    });
    await this.transitions.apply(tx, sampleId, 'quote-accepted', {
      actor,
      meta,
      auditMetadata: { quotationVersionId: versionId, approvalId },
    });
    const state = await this.commercial.recomputePaymentState(tx, sampleId);
    // A zero-value quotation needs no payment: the sample is immediately ready.
    if (state === 'PAID') {
      await this.transitions.apply(tx, sampleId, 'payment-covered', {
        actor,
        meta,
        auditMetadata: {
          quotationVersionId: versionId,
          reason: 'zero-value quotation',
        },
      });
    }
    await this.audit.record(
      {
        ...auditActor(actor),
        action: AuditAction.QUOTATION_VERSION_ACCEPTED,
        entityType: 'QuotationVersion',
        entityId: versionId,
        metadata: {
          quotationId: version.quotationId,
          quotationNumber: version.quotation.quotationNumber,
          versionNumber: version.versionNumber,
          total: fmt(D(version.total)),
          approvalId,
        },
        meta,
      },
      tx,
    );
  }

  async applyRejection(
    tx: Prisma.TransactionClient,
    versionId: string,
    reason: string | null,
    actor: ActorRef,
    meta: RequestMeta,
    approvalId: string,
  ): Promise<void> {
    const version = await this.lockedSentVersion(tx, versionId, 'rejected');
    await tx.quotationVersion.update({
      where: { id: versionId },
      data: { status: 'REJECTED', rejectedAt: new Date() },
    });
    await tx.quotation.update({
      where: { id: version.quotationId },
      data: { status: 'REJECTED' },
    });
    await this.transitions.apply(
      tx,
      this.sampleIdOf(version.quotation),
      'quote-rejected',
      {
        actor,
        meta,
        reason,
        auditMetadata: { quotationVersionId: versionId, approvalId },
      },
    );
    await this.audit.record(
      {
        ...auditActor(actor),
        action: AuditAction.QUOTATION_VERSION_REJECTED,
        entityType: 'QuotationVersion',
        entityId: versionId,
        metadata: {
          quotationId: version.quotationId,
          quotationNumber: version.quotation.quotationNumber,
          versionNumber: version.versionNumber,
          reason,
          approvalId,
        },
        meta,
      },
      tx,
    );
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** Locks the sample, then returns the version only if it is still the live SENT offer. */
  private async lockedSentVersion(
    tx: Prisma.TransactionClient,
    versionId: string,
    verb: string,
  ) {
    const version = await tx.quotationVersion.findUnique({
      where: { id: versionId },
      include: { quotation: true },
    });
    if (!version) throw new NotFoundException('Quotation version not found');
    await this.lockTarget(tx, version.quotation);
    const current = await tx.quotationVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: { quotation: true },
    });
    if (current.status !== 'SENT') {
      throw new ConflictException(
        current.status === 'SUPERSEDED'
          ? 'This quotation version has been superseded by a newer version and can no longer be decided'
          : `This quotation version cannot be ${verb}: it is ${current.status}`,
      );
    }
    if (current.validUntil && current.validUntil <= new Date()) {
      throw new ConflictException('This quotation version has expired');
    }
    return current;
  }

  /** Sample-only paths (approvals-driven decisions) refuse quotations that belong to an order. */
  private sampleIdOf(q: { sampleId: string | null }): string {
    if (!q.sampleId)
      throw new ConflictException(
        'This quotation belongs to an order; use the order quotation endpoints',
      );
    return q.sampleId;
  }

  /** Lock the quotation's owner (sample, or the order — the root lock) and load it. */
  private async lockTarget(
    tx: Prisma.TransactionClient,
    q: { sampleId: string | null; orderId: string | null },
  ) {
    if (q.sampleId) {
      await this.transitions.lock(tx, q.sampleId);
      return {
        sample: await tx.sample.findUniqueOrThrow({
          where: { id: q.sampleId },
        }),
        order: null,
      };
    }
    await this.orderTransitions.lock(tx, q.orderId!);
    return {
      sample: null,
      order: await tx.order.findUniqueOrThrow({ where: { id: q.orderId! } }),
    };
  }

  /** Commercial documents of an order are negotiated before production is released. */
  private assertOrderQuotable(order: { status: string; orderNumber: string }) {
    if (
      ![
        'DRAFT',
        'PENDING_CONFIRMATION',
        'CONFIRMED',
        'READY_FOR_PRODUCTION',
        'ON_HOLD',
      ].includes(order.status)
    ) {
      throw new ConflictException(
        `${order.orderNumber} is ${order.status}; its quotation can no longer change`,
      );
    }
  }

  // ---- orders ---------------------------------------------------------------------------------

  async listForOrder(orderId: string): Promise<QuotationResponseDto[]> {
    if (
      !(await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Order not found');
    const rows = await this.prisma.quotation.findMany({
      where: { orderId, archivedAt: null },
      include: quotationInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toQuotation);
  }

  async createForOrder(
    orderId: string,
    dto: CreateQuotationDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<QuotationResponseDto> {
    this.assertValidUntil(dto.validUntil);
    const totals = computeTotals(
      dto.lineItems ?? [],
      dto.discount,
      dto.taxPercent,
    );
    const created = await this.prisma.$transaction(async (tx) => {
      await this.orderTransitions.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      this.assertOrderQuotable(order);
      const live = await tx.quotation.findFirst({
        where: { orderId, status: { in: [...LIVE] } },
      });
      if (live) {
        throw new ConflictException(
          `${live.quotationNumber} is still ${live.status}; create a new version instead`,
        );
      }
      const quotationNumber = await this.references.next('QTN', tx);
      const quotation = await tx.quotation.create({
        data: {
          quotationNumber,
          orderId,
          currency: dto.currency ?? this.defaultCurrency,
          createdByUserId: actor.id,
        },
      });
      const version = await this.insertVersion(
        tx,
        quotation.id,
        1,
        dto.lineItems ?? [],
        totals,
        dto,
        actor,
        order.revisionNumber,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QUOTATION_CREATED,
          entityType: 'Quotation',
          entityId: quotation.id,
          metadata: {
            quotationNumber,
            orderId,
            orderNumber: order.orderNumber,
            currency: quotation.currency,
          },
          meta,
        },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QUOTATION_VERSION_CREATED,
          entityType: 'QuotationVersion',
          entityId: version.id,
          metadata: {
            quotationId: quotation.id,
            versionNumber: 1,
            total: fmt(totals.total),
          },
          meta,
        },
        tx,
      );
      return quotation;
    });
    return this.get(created.id);
  }

  /**
   * Orders: the customer's decision is recorded by staff on their behalf, with evidence
   * (`sourceNote`). Accepting is final, moves nothing else, and recomputes the payment state.
   */
  async decideForOrder(
    versionId: string,
    decision: 'accept' | 'reject',
    note: string,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<QuotationVersionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const version = await this.lockedSentVersion(
        tx,
        versionId,
        decision === 'accept' ? 'accepted' : 'rejected',
      );
      if (!version.quotation.orderId)
        throw new ConflictException(
          'This quotation belongs to a sample; use the approvals flow',
        );
      const orderId = version.quotation.orderId;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      this.assertOrderQuotable(order);
      // Defence in depth: a revision supersedes every live version under the same order lock,
      // so a version priced before the last commercial change cannot normally get here.
      if (
        decision === 'accept' &&
        (version.orderRevision ?? 0) < order.commercialRevision
      )
        throw new ConflictException(
          `This version priced revision ${version.orderRevision}; the order's commercial terms changed in revision ${order.commercialRevision}. Create a new version`,
        );
      const now = new Date();
      await tx.quotationVersion.update({
        where: { id: versionId },
        data:
          decision === 'accept'
            ? {
                status: 'ACCEPTED',
                acceptedAt: now,
                decisionNote: note,
                decidedByUserId: actor.customer ? null : actor.id,
                decidedByCustomerId: actor.customer ? actor.id : null,
              }
            : {
                status: 'REJECTED',
                rejectedAt: now,
                decisionNote: note,
                decidedByUserId: actor.customer ? null : actor.id,
                decidedByCustomerId: actor.customer ? actor.id : null,
              },
      });
      await tx.quotation.update({
        where: { id: version.quotationId },
        data: { status: decision === 'accept' ? 'ACCEPTED' : 'REJECTED' },
      });
      if (decision === 'accept')
        await this.outbox.emit(tx, {
          eventType: 'QUOTATION_ACCEPTED',
          aggregateType: 'Quotation',
          aggregateId: version.quotationId,
          payload: {
            quotationNumber: version.quotation.quotationNumber,
            orderId,
          },
        });
      const state = await this.commercial.recomputeFor(tx, { orderId });
      await this.orderActivity.log(
        tx,
        orderId,
        actor,
        decision === 'accept' ? 'QUOTATION_ACCEPTED' : 'QUOTATION_SENT',
        `Quotation ${version.quotation.quotationNumber} v${version.versionNumber} ${decision === 'accept' ? 'accepted' : 'rejected'} (${actor.customer ? 'by the customer' : 'recorded on behalf of the customer'})`,
        { quotationVersionId: versionId, decision, paymentState: state },
      );
      await this.audit.record(
        {
          ...auditActor(actor),
          action:
            decision === 'accept'
              ? AuditAction.QUOTATION_VERSION_ACCEPTED
              : AuditAction.QUOTATION_VERSION_REJECTED,
          entityType: 'QuotationVersion',
          entityId: versionId,
          metadata: {
            quotationId: version.quotationId,
            quotationNumber: version.quotation.quotationNumber,
            versionNumber: version.versionNumber,
            orderId,
            total: fmt(D(version.total)),
            recordedOnBehalfOfCustomer: !actor.customer,
          },
          meta,
        },
        tx,
      );
    });
    return this.getVersion(versionId);
  }

  /**
   * The signed-in customer decides on an order quotation of THEIR order (anything else is a plain 404).
   * Same transaction, same rules as the staff-recorded decision: only the live SENT version, never a
   * superseded, expired or invalidated one.
   */
  async decideForOrderAsCustomer(
    customerId: string,
    versionId: string,
    decision: 'accept' | 'reject',
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<string> {
    const version = await this.prisma.quotationVersion.findFirst({
      where: {
        id: versionId,
        quotation: { order: { is: { customerId } } },
      },
      include: { quotation: true },
    });
    if (!version) throw new NotFoundException('Quotation not found');
    await this.decideForOrder(
      versionId,
      decision,
      reason?.trim() || 'Decided by the customer in the portal',
      { id: customerId, customer: true },
      meta,
    );
    return version.quotation.orderId!;
  }

  private lineData(
    versionId: string,
    lines: QuotationLineItemDto[],
    totals: ReturnType<typeof computeTotals>,
  ) {
    return lines.map((l, i) => ({
      quotationVersionId: versionId,
      type: l.type,
      description: l.description,
      quantity: D(l.quantity),
      unitPrice: D(l.unitPrice),
      amount: totals.lineAmounts[i]!,
      sortOrder: l.sortOrder ?? i,
      metadata: (l.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    }));
  }

  private async insertVersion(
    tx: Prisma.TransactionClient,
    quotationId: string,
    versionNumber: number,
    lines: QuotationLineItemDto[],
    totals: ReturnType<typeof computeTotals>,
    extra: { notes?: string; customerNotes?: string; validUntil?: Date },
    actor: AuthUser,
    orderRevision?: number,
  ) {
    const version = await tx.quotationVersion.create({
      data: {
        quotationId,
        versionNumber,
        subtotal: totals.subtotal,
        discount: totals.discount,
        taxPercent: totals.taxPercent,
        tax: totals.tax,
        total: totals.total,
        notes: extra.notes,
        customerNotes: extra.customerNotes,
        validUntil: extra.validUntil,
        createdByUserId: actor.id,
        orderRevision,
      },
    });
    if (lines.length) {
      await tx.quotationLineItem.createMany({
        data: this.lineData(version.id, lines, totals),
      });
    }
    return version;
  }

  private assertValidUntil(validUntil?: Date | null): void {
    if (validUntil && validUntil <= new Date()) {
      throw new BadRequestException('validUntil must be in the future');
    }
  }

  private async assertSample(id: string): Promise<void> {
    if (
      !(await this.prisma.sample.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Sample not found');
    }
  }
}
