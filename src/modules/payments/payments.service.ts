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
import { ReferenceService } from '../../database/reference-sequence.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { CommercialService } from '../commercial/commercial.service.js';
import { D, ZERO, fmt, looksLikeCardNumber } from '../commercial/money.js';
import { OutboxService } from '../notifications/outbox.service.js';
import { OrderActivityService } from '../orders/core/order-activity.service.js';
import { OrderTransitionsService } from '../orders/core/order-transitions.service.js';
import { SampleTransitionsService } from '../samples/sample-transitions.service.js';
import type {
  CreatePaymentDto,
  PaymentResponseDto,
  UpdatePaymentDto,
} from './dto/payment.dto.js';

const paymentInclude = {
  proofAsset: {
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
  },
} satisfies Prisma.PaymentInclude;
type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

/** Samples in these statuses can receive payments (after a quotation has been accepted). */
const PAYABLE_STATUSES = [
  'AWAITING_PAYMENT',
  'READY_FOR_PRODUCTION',
  'IN_PRODUCTION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'ON_HOLD',
];

export const MAX_PENDING_CUSTOMER_PAYMENTS = 5;

const toPayment = (p: PaymentRow): PaymentResponseDto => ({
  id: p.id,
  paymentNumber: p.paymentNumber,
  sampleId: p.sampleId,
  orderId: p.orderId,
  quotationVersionId: p.quotationVersionId,
  amount: fmt(D(p.amount)),
  currency: p.currency,
  method: p.method,
  status: p.status,
  transactionReference: p.transactionReference,
  proof: p.proofAsset
    ? {
        assetId: p.proofAsset.id,
        originalName: p.proofAsset.originalName,
        mimeType: p.proofAsset.mimeType,
        sizeBytes: p.proofAsset.sizeBytes,
      }
    : null,
  receivedAt: p.receivedAt,
  verifiedAt: p.verifiedAt,
  verifiedByUserId: p.verifiedByUserId,
  rejectionReason: p.rejectionReason,
  customerMessage: p.customerMessage,
  createdByUserId: p.createdByUserId,
  createdByCustomerId: p.createdByCustomerId,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/**
 * Records payments against a sample's ACCEPTED quotation and lets finance verify them.
 * There is no gateway and no card data. Verified money is what counts: the sample moves
 * to READY_FOR_PRODUCTION automatically once verified payments cover the accepted total.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
    private readonly transitions: SampleTransitionsService,
    private readonly commercial: CommercialService,
    private readonly orderTransitions: OrderTransitionsService,
    private readonly orderActivity: OrderActivityService,
    private readonly outbox: OutboxService,
  ) {}

  async listForSample(sampleId: string): Promise<PaymentResponseDto[]> {
    if (
      !(await this.prisma.sample.findUnique({
        where: { id: sampleId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Sample not found');
    }
    const rows = await this.prisma.payment.findMany({
      where: { sampleId },
      include: paymentInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toPayment);
  }

  async get(id: string): Promise<PaymentResponseDto> {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: paymentInclude,
    });
    if (!row) throw new NotFoundException('Payment not found');
    return toPayment(row);
  }

  async create(
    sampleId: string,
    dto: CreatePaymentDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    return this.createFor(sampleId, dto, actor, meta);
  }

  /**
   * Shared by staff (AuthUser) and the customer portal (customer actor). A customer's submission is a
   * normal SUBMITTED payment in the same table and queue; only staff can verify it, and a customer may
   * have at most MAX_PENDING_CUSTOMER_PAYMENTS awaiting review.
   */
  async createFor(
    sampleId: string,
    dto: CreatePaymentDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    this.assertReference(dto.transactionReference);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, sampleId);
      const sample = await tx.sample.findUnique({ where: { id: sampleId } });
      if (!sample) throw new NotFoundException('Sample not found');
      if (sample.archivedAt) throw new ConflictException('Sample is archived');
      if (!PAYABLE_STATUSES.includes(sample.status)) {
        throw new ConflictException(
          `Payments cannot be recorded while the sample is ${sample.status}`,
        );
      }
      const accepted = await this.commercial.acceptedVersion(tx, sampleId);
      if (!accepted)
        throw new ConflictException(
          'The sample has no accepted quotation to pay against',
        );
      const currency = accepted.quotation.currency;
      if (dto.currency && dto.currency !== currency) {
        throw new BadRequestException(
          `currency must match the quotation currency (${currency})`,
        );
      }
      const amount = D(dto.amount);
      const remaining = D(accepted.total).sub(
        await this.commercial.verifiedTotal(tx, sampleId, accepted.id),
      );
      if (amount.gt(remaining)) {
        throw new BadRequestException(
          `amount ${fmt(amount)} exceeds the remaining balance of ${fmt(remaining.lt(0) ? ZERO : remaining)} ${currency}`,
        );
      }
      if (dto.proofAssetId) await this.assertProof(tx, dto.proofAssetId);
      if (actor.customer) {
        const pending = await tx.payment.count({
          where: {
            sampleId,
            createdByCustomerId: actor.id,
            status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
          },
        });
        if (pending >= MAX_PENDING_CUSTOMER_PAYMENTS) {
          throw new ConflictException(
            'You already have payments waiting for review; please wait for them to be checked',
          );
        }
      }

      const paymentNumber = await this.references.next('PAY', tx);
      const payment = await tx.payment.create({
        data: {
          paymentNumber,
          sampleId,
          quotationVersionId: accepted.id,
          amount,
          currency,
          method: dto.method,
          transactionReference: dto.transactionReference,
          proofAssetId: dto.proofAssetId,
          receivedAt: dto.receivedAt,
          createdByUserId: actor.customer ? null : actor.id,
          createdByCustomerId: actor.customer ? actor.id : null,
        },
      });
      await this.outbox.emit(tx, {
        eventType: 'PAYMENT_SUBMITTED',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        payload: { paymentId: payment.id, sampleId },
      });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.PAYMENT_CREATED,
          entityType: 'Payment',
          entityId: payment.id,
          metadata: {
            paymentNumber,
            sampleId,
            amount: fmt(amount),
            currency,
            method: dto.method,
            hasProof: !!dto.proofAssetId,
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
      return payment;
    });
    return this.get(created.id);
  }

  /**
   * The customer adds or replaces the proof file of THEIR OWN payment while it is still SUBMITTED
   * (staff have not started reviewing it). Verification stays staff-only.
   */
  async attachProofAsCustomer(
    id: string,
    customerId: string,
    assetId: string,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await this.lockedPayment(tx, id);
      if (payment.createdByCustomerId !== customerId)
        throw new NotFoundException('Payment not found');
      if (payment.status !== 'SUBMITTED') {
        throw new ConflictException(
          `This payment is ${payment.status.toLowerCase().replace('_', ' ')} and its proof can no longer be changed`,
        );
      }
      await this.assertProof(tx, assetId, id);
      await tx.payment.update({
        where: { id },
        data: { proofAssetId: assetId },
      });
      await this.audit.record(
        {
          actorCustomerId: customerId,
          action: AuditAction.CUSTOMER_PAYMENT_PROOF_SUBMITTED,
          entityType: 'Payment',
          entityId: id,
          metadata: {
            paymentNumber: payment.paymentNumber,
            sampleId: payment.sampleId,
            orderId: payment.orderId,
            assetId,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Orders can be paid for in any live status once a quotation has been accepted. */
  async createForOrder(
    orderId: string,
    dto: CreatePaymentDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    this.assertReference(dto.transactionReference);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.orderTransitions.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status === 'CANCELLED')
        throw new ConflictException('The order is cancelled');
      const target = { orderId };
      const accepted = await this.commercial.acceptedVersionFor(tx, target);
      if (!accepted)
        throw new ConflictException(
          'The order has no accepted quotation to pay against',
        );
      const currency = accepted.quotation.currency;
      if (dto.currency && dto.currency !== currency) {
        throw new BadRequestException(
          `currency must match the quotation currency (${currency})`,
        );
      }
      const amount = D(dto.amount);
      const remaining = D(accepted.total).sub(
        await this.commercial.verifiedTotalFor(tx, target, accepted.id),
      );
      // Overpayment policy: a payment can never exceed the remaining balance.
      if (amount.gt(remaining)) {
        throw new BadRequestException(
          `amount ${fmt(amount)} exceeds the remaining balance of ${fmt(remaining.lt(0) ? ZERO : remaining)} ${currency}`,
        );
      }
      if (dto.proofAssetId) await this.assertProof(tx, dto.proofAssetId);
      if (actor.customer) {
        if (order.customerId !== actor.id)
          throw new NotFoundException('Order not found');
        const pending = await tx.payment.count({
          where: {
            orderId,
            createdByCustomerId: actor.id,
            status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
          },
        });
        if (pending >= MAX_PENDING_CUSTOMER_PAYMENTS) {
          throw new ConflictException(
            'You already have payments waiting for review; please wait for them to be checked',
          );
        }
      }
      const paymentNumber = await this.references.next('PAY', tx);
      const payment = await tx.payment.create({
        data: {
          paymentNumber,
          orderId,
          quotationVersionId: accepted.id,
          amount,
          currency,
          method: dto.method,
          transactionReference: dto.transactionReference,
          proofAssetId: dto.proofAssetId,
          receivedAt: dto.receivedAt,
          createdByUserId: actor.customer ? null : actor.id,
          createdByCustomerId: actor.customer ? actor.id : null,
        },
      });
      await this.outbox.emit(tx, {
        eventType: 'PAYMENT_SUBMITTED',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        payload: { paymentId: payment.id, orderId },
      });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.PAYMENT_CREATED,
          entityType: 'Payment',
          entityId: payment.id,
          metadata: {
            paymentNumber,
            orderId,
            orderNumber: order.orderNumber,
            amount: fmt(amount),
            currency,
            method: dto.method,
            hasProof: !!dto.proofAssetId,
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
      return payment;
    });
    return this.get(created.id);
  }

  async listForOrder(orderId: string): Promise<PaymentResponseDto[]> {
    if (
      !(await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Order not found');
    const rows = await this.prisma.payment.findMany({
      where: { orderId },
      include: paymentInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPayment);
  }

  async update(
    id: string,
    dto: UpdatePaymentDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    if (dto.transactionReference)
      this.assertReference(dto.transactionReference);
    await this.prisma.$transaction(async (tx) => {
      const payment = await this.lockedPayment(tx, id);
      if (payment.status !== 'SUBMITTED') {
        throw new ConflictException(
          `A ${payment.status} payment can no longer be edited`,
        );
      }
      if (dto.amount !== undefined) {
        const target = this.targetOf(payment);
        const accepted = await this.commercial.acceptedVersionFor(tx, target);
        const remaining = accepted
          ? D(accepted.total).sub(
              await this.commercial.verifiedTotalFor(tx, target, accepted.id),
            )
          : ZERO;
        if (D(dto.amount).gt(remaining)) {
          throw new BadRequestException(
            `amount exceeds the remaining balance of ${fmt(remaining.lt(0) ? ZERO : remaining)}`,
          );
        }
      }
      if (dto.proofAssetId) await this.assertProof(tx, dto.proofAssetId, id);
      const data = Object.fromEntries(
        Object.entries(dto).filter(([, v]) => v !== undefined),
      );
      await tx.payment.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PAYMENT_UPDATED,
          entityType: 'Payment',
          entityId: id,
          metadata: {
            paymentNumber: payment.paymentNumber,
            fields: Object.keys(data),
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async startReview(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await this.lockedPayment(tx, id);
      if (payment.status !== 'SUBMITTED')
        throw new ConflictException(`Payment is already ${payment.status}`);
      await tx.payment.update({
        where: { id },
        data: { status: 'UNDER_REVIEW' },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PAYMENT_REVIEW_STARTED,
          entityType: 'Payment',
          entityId: id,
          metadata: { paymentNumber: payment.paymentNumber },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Verify under the sample's row lock, so two payments verified at once cannot together
   * overshoot the quotation total. The person who recorded a payment cannot verify it.
   */
  async verify(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await this.lockedPayment(tx, id);
      if (!['SUBMITTED', 'UNDER_REVIEW'].includes(payment.status)) {
        throw new ConflictException(`Payment is already ${payment.status}`);
      }
      if (payment.createdByUserId === actor.id) {
        throw new ForbiddenException(
          'A payment cannot be verified by the person who recorded it',
        );
      }
      const target = this.targetOf(payment);
      const accepted = await this.commercial.acceptedVersionFor(tx, target);
      // Orders: a payment recorded against a quotation that a revision has since replaced is
      // still real money. It is capped by the quotation in force, or by its own when none is.
      const ceiling = payment.orderId
        ? (accepted ??
          (payment.quotationVersionId
            ? await tx.quotationVersion.findUnique({
                where: { id: payment.quotationVersionId },
              })
            : null))
        : accepted;
      if (
        !ceiling ||
        (!payment.orderId && accepted?.id !== payment.quotationVersionId)
      ) {
        throw new ConflictException(
          'The payment does not match the accepted quotation',
        );
      }
      const verified = await this.commercial.verifiedTotalFor(
        tx,
        target,
        ceiling.id,
      );
      if (verified.add(D(payment.amount)).gt(D(ceiling.total))) {
        throw new ConflictException(
          `Verifying this payment would exceed the quotation total (${fmt(D(ceiling.total))} ${payment.currency}); already verified: ${fmt(verified)}`,
        );
      }
      await tx.payment.update({
        where: { id },
        data: {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedByUserId: actor.id,
        },
      });
      const state = await this.commercial.recomputeFor(tx, target);
      let movedToReady = false;
      if (payment.sampleId) {
        const sample = await tx.sample.findUniqueOrThrow({
          where: { id: payment.sampleId },
        });
        if (state === 'PAID' && sample.status === 'AWAITING_PAYMENT') {
          await this.transitions.apply(
            tx,
            payment.sampleId,
            'payment-covered',
            {
              actor,
              meta,
              auditMetadata: {
                paymentId: id,
                paymentNumber: payment.paymentNumber,
              },
            },
          );
          movedToReady = true;
        }
      } else if (payment.orderId) {
        await this.orderActivity.log(
          tx,
          payment.orderId,
          actor.id,
          'PAYMENT_VERIFIED',
          `Payment ${payment.paymentNumber} verified (${state.replace('_', ' ').toLowerCase()})`,
          { paymentId: id, paymentState: state },
        );
      }
      await this.outbox.emit(tx, {
        eventType: 'PAYMENT_VERIFIED',
        aggregateType: 'Payment',
        aggregateId: id,
        payload: {
          paymentId: id,
          ...(payment.sampleId
            ? { sampleId: payment.sampleId }
            : { orderId: payment.orderId! }),
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PAYMENT_VERIFIED,
          entityType: 'Payment',
          entityId: id,
          metadata: {
            paymentNumber: payment.paymentNumber,
            sampleId: payment.sampleId,
            orderId: payment.orderId,
            amount: fmt(D(payment.amount)),
            currency: payment.currency,
            paymentState: state,
            sampleReady: movedToReady,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async reject(
    id: string,
    reason: string,
    actor: AuthUser,
    meta: RequestMeta,
    customerMessage?: string,
  ): Promise<PaymentResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await this.lockedPayment(tx, id);
      if (!['SUBMITTED', 'UNDER_REVIEW'].includes(payment.status)) {
        throw new ConflictException(`Payment is already ${payment.status}`);
      }
      await tx.payment.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          customerMessage: customerMessage?.trim() || null,
        },
      });
      // customers hear about it; the text they get is customerMessage only, never the internal reason
      await this.outbox.emit(tx, {
        eventType: 'PAYMENT_REJECTED',
        aggregateType: 'Payment',
        aggregateId: id,
        payload: {
          paymentId: id,
          ...(payment.sampleId
            ? { sampleId: payment.sampleId }
            : { orderId: payment.orderId! }),
          ...(customerMessage?.trim() && { reason: customerMessage.trim() }),
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PAYMENT_REJECTED,
          entityType: 'Payment',
          entityId: id,
          metadata: {
            paymentNumber: payment.paymentNumber,
            sampleId: payment.sampleId,
            orderId: payment.orderId,
            reason,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async cancel(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PaymentResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await this.lockedPayment(tx, id);
      if (!['SUBMITTED', 'UNDER_REVIEW'].includes(payment.status)) {
        throw new ConflictException(`Payment is already ${payment.status}`);
      }
      await tx.payment.update({ where: { id }, data: { status: 'CANCELLED' } });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PAYMENT_CANCELLED,
          entityType: 'Payment',
          entityId: id,
          metadata: {
            paymentNumber: payment.paymentNumber,
            sampleId: payment.sampleId,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** Lock the owning sample first (consistent order), then re-read the payment under the lock. */
  private async lockedPayment(tx: Prisma.TransactionClient, id: string) {
    const found = await tx.payment.findUnique({
      where: { id },
      select: { sampleId: true, orderId: true },
    });
    if (!found) throw new NotFoundException('Payment not found');
    if (found.sampleId) await this.transitions.lock(tx, found.sampleId);
    else await this.orderTransitions.lock(tx, found.orderId!);
    return tx.payment.findUniqueOrThrow({ where: { id } });
  }

  private targetOf(p: { sampleId: string | null; orderId: string | null }) {
    return p.sampleId ? { sampleId: p.sampleId } : { orderId: p.orderId! };
  }

  private assertReference(reference?: string | null): void {
    if (reference && looksLikeCardNumber(reference)) {
      throw new BadRequestException(
        'transactionReference looks like a card number; never record card details here',
      );
    }
  }

  private async assertProof(
    tx: Prisma.TransactionClient,
    assetId: string,
    exceptPaymentId?: string,
  ): Promise<void> {
    const asset = await tx.asset.findFirst({
      where: { id: assetId, archivedAt: null },
    });
    if (!asset) throw new BadRequestException('proofAssetId: asset not found');
    if (asset.type !== 'PAYMENT_PROOF') {
      throw new BadRequestException(
        'proofAssetId: the file must be an asset of type PAYMENT_PROOF',
      );
    }
    const used = await tx.payment.findFirst({
      where: { proofAssetId: assetId, id: { not: exceptPaymentId } },
    });
    if (used)
      throw new ConflictException(
        'This proof file is already attached to another payment',
      );
  }
}
