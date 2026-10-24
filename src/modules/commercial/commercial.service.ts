import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  D,
  ZERO,
  derivePaymentState,
  fmt,
  type Decimal,
  type PaymentStateValue,
} from './money.js';

export interface CommercialSummary {
  sampleId: string;
  sampleNumber: string;
  currency: string | null;
  quotation: {
    quotationId: string;
    quotationNumber: string;
    versionId: string;
    versionNumber: string | number;
    status: string;
    total: string;
  } | null;
  quotedTotal: string | null;
  acceptedTotal: string | null;
  verifiedPaid: string;
  pendingPayments: string;
  remaining: string | null;
  paymentState: PaymentStateValue;
  counts: {
    verified: number;
    pending: number;
    rejected: number;
    cancelled: number;
  };
}

type Client = Prisma.TransactionClient | PrismaService;

/** Quotations and payments belong to a sample OR an order. */
export type CommercialTarget = { sampleId: string } | { orderId: string };
const targetWhere = (t: CommercialTarget) =>
  'sampleId' in t ? { sampleId: t.sampleId } : { orderId: t.orderId };

/**
 * Backend-computed commercial figures. Clients never send totals or balances.
 * Source of truth = accepted quotation version + VERIFIED payments; the stored
 * `Sample.paymentState` is a cache of derivePaymentState(), refreshed in the
 * same transaction as every change that can affect it.
 */
@Injectable()
export class CommercialService {
  constructor(private readonly prisma: PrismaService) {}

  async acceptedVersion(client: Client, sampleId: string) {
    return this.acceptedVersionFor(client, { sampleId });
  }

  async acceptedVersionFor(client: Client, target: CommercialTarget) {
    return client.quotationVersion.findFirst({
      where: { status: 'ACCEPTED', quotation: targetWhere(target) },
      include: { quotation: true },
    });
  }

  /**
   * True when an accepted quotation of the order was ended by a commercially relevant revision and
   * no newer one has been accepted: production needs a fresh quotation and decision.
   */
  async reapprovalRequired(client: Client, orderId: string): Promise<boolean> {
    if (await this.acceptedVersionFor(client, { orderId })) return false;
    const ended = await client.quotationVersion.count({
      where: {
        quotation: { orderId },
        acceptedAt: { not: null },
        invalidatedAt: { not: null },
      },
    });
    return ended > 0;
  }

  async verifiedTotalFor(
    client: Client,
    target: CommercialTarget,
    quotationVersionId?: string,
  ): Promise<Decimal> {
    // Orders carry money forward: verified payments stay credited when a commercially relevant
    // revision replaces the accepted quotation, so they are never scoped to one version.
    const version = 'orderId' in target ? undefined : quotationVersionId;
    const sum = await client.payment.aggregate({
      where: {
        ...targetWhere(target),
        status: 'VERIFIED',
        quotationVersionId: version,
      },
      _sum: { amount: true },
    });
    return sum._sum.amount ? D(sum._sum.amount) : ZERO;
  }

  /** Refresh the cached payment state of a sample or an order. */
  async recomputeFor(
    tx: Prisma.TransactionClient,
    target: CommercialTarget,
  ): Promise<PaymentStateValue> {
    const accepted = await this.acceptedVersionFor(tx, target);
    const verified = await this.verifiedTotalFor(tx, target, accepted?.id);
    const state = derivePaymentState(
      accepted ? D(accepted.total) : null,
      verified,
    );
    if ('sampleId' in target) {
      await tx.sample.update({
        where: { id: target.sampleId },
        data: { paymentState: state },
      });
    } else {
      await tx.order.update({
        where: { id: target.orderId },
        data: { paymentState: state },
      });
    }
    return state;
  }

  async verifiedTotal(
    client: Client,
    sampleId: string,
    quotationVersionId?: string,
  ): Promise<Decimal> {
    const sum = await client.payment.aggregate({
      where: { sampleId, status: 'VERIFIED', quotationVersionId },
      _sum: { amount: true },
    });
    return sum._sum.amount ? D(sum._sum.amount) : ZERO;
  }

  /** Refresh the cached payment state; returns the new value. */
  async recomputePaymentState(
    tx: Prisma.TransactionClient,
    sampleId: string,
  ): Promise<PaymentStateValue> {
    const accepted = await this.acceptedVersion(tx, sampleId);
    const verified = await this.verifiedTotal(tx, sampleId, accepted?.id);
    const state = derivePaymentState(
      accepted ? D(accepted.total) : null,
      verified,
    );
    await tx.sample.update({
      where: { id: sampleId },
      data: { paymentState: state },
    });
    return state;
  }

  async summary(sampleId: string): Promise<CommercialSummary> {
    const sample = await this.prisma.sample.findUnique({
      where: { id: sampleId },
      select: { id: true, sampleNumber: true },
    });
    if (!sample) throw new NotFoundException('Sample not found');

    const [latest, accepted, payments] = await Promise.all([
      this.prisma.quotationVersion.findFirst({
        where: {
          quotation: { sampleId },
          status: { in: ['SENT', 'ACCEPTED'] },
        },
        orderBy: [
          { quotation: { createdAt: 'desc' } },
          { versionNumber: 'desc' },
        ],
        include: { quotation: true },
      }),
      this.acceptedVersion(this.prisma, sampleId),
      this.prisma.payment.groupBy({
        by: ['status'],
        where: { sampleId },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const sumOf = (status: string) => {
      const row = payments.find((p) => p.status === status);
      return row?._sum.amount ? D(row._sum.amount) : ZERO;
    };
    const countOf = (status: string) =>
      payments.find((p) => p.status === status)?._count ?? 0;
    // Only payments recorded against the accepted version count toward its balance.
    const verifiedForAccepted = await this.verifiedTotal(
      this.prisma,
      sampleId,
      accepted?.id,
    );
    const verifiedPaid = accepted ? verifiedForAccepted : sumOf('VERIFIED');
    const acceptedTotal = accepted ? D(accepted.total) : null;
    const remaining = acceptedTotal
      ? Decimal0(acceptedTotal.sub(verifiedPaid))
      : null;

    const head = accepted ?? latest;
    return {
      sampleId,
      sampleNumber: sample.sampleNumber,
      currency: head?.quotation.currency ?? null,
      quotation: head
        ? {
            quotationId: head.quotationId,
            quotationNumber: head.quotation.quotationNumber,
            versionId: head.id,
            versionNumber: head.versionNumber,
            status: head.status,
            total: fmt(D(head.total)),
          }
        : null,
      quotedTotal: head ? fmt(D(head.total)) : null,
      acceptedTotal: acceptedTotal ? fmt(acceptedTotal) : null,
      verifiedPaid: fmt(verifiedPaid),
      pendingPayments: fmt(sumOf('SUBMITTED').add(sumOf('UNDER_REVIEW'))),
      remaining: remaining ? fmt(remaining) : null,
      paymentState: derivePaymentState(acceptedTotal, verifiedPaid),
      counts: {
        verified: countOf('VERIFIED'),
        pending: countOf('SUBMITTED') + countOf('UNDER_REVIEW'),
        rejected: countOf('REJECTED'),
        cancelled: countOf('CANCELLED'),
      },
    };
  }
}

const Decimal0 = (value: Decimal): Decimal => (value.lt(0) ? ZERO : value);
