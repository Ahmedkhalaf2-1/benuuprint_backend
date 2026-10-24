import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Order, Prisma } from '../../generated/prisma/client.js';
import { CommercialService } from '../commercial/commercial.service.js';
import { D, ZERO, fmt, round2 } from '../commercial/money.js';
import type {
  OrderCommercialSummaryDto,
  ReleaseGateDto,
} from './dto/commercial.dto.js';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Commercial figures and the production release gate of an order. Source of truth is the
 * accepted quotation version plus VERIFIED payments (the same rule as samples); the stored
 * `Order.paymentState` is a cache refreshed with every change.
 *
 * Release gate (configurable, never hard-coded): ORDER_REQUIRE_ACCEPTED_QUOTATION (default on)
 * and ORDER_REQUIRED_PAID_PERCENT (default 100 = full payment). A deposit rule is a config
 * change, not a code change.
 */
@Injectable()
export class OrderCommercialService {
  private readonly cfg: AppConfig['orders'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly commercial: CommercialService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app').orders;
  }

  async gate(client: Client, orderId: string): Promise<ReleaseGateDto> {
    const accepted = await this.commercial.acceptedVersionFor(client, {
      orderId,
    });
    const pct = this.cfg.requiredPaidPercent;
    const reasons: string[] = [];
    let required: string | null = null;
    if (accepted) {
      const total = D(accepted.total);
      const needed = round2(total.mul(D(pct)).div(100));
      required = fmt(needed);
      const verified = await this.commercial.verifiedTotalFor(
        client,
        { orderId },
        accepted.id,
      );
      if (verified.lt(needed))
        reasons.push(
          `${fmt(needed)} ${accepted.quotation.currency} (${pct}% of ${fmt(total)}) must be verified; ${fmt(verified)} is`,
        );
    } else if (await this.commercial.reapprovalRequired(client, orderId)) {
      const order = await client.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { commercialRevision: true },
      });
      reasons.push(
        `The accepted quotation no longer applies: revision ${order.commercialRevision} changed the commercial terms; a new quotation must be accepted`,
      );
    } else if (this.cfg.requireAcceptedQuotation) {
      reasons.push('The order has no accepted quotation');
    }
    return {
      requireAcceptedQuotation: this.cfg.requireAcceptedQuotation,
      requiredPaidPercent: pct,
      requiredPaidAmount: required,
      satisfied: reasons.length === 0,
      reasons,
    };
  }

  /** The gate in force: only when quotations are required (or one has been accepted). */
  async assertReleasable(
    client: Client,
    order: Pick<Order, 'id' | 'orderNumber'>,
  ) {
    const accepted = await this.commercial.acceptedVersionFor(client, {
      orderId: order.id,
    });
    // A quotation that was accepted and then ended by a revision is never optional again.
    if (
      !accepted &&
      !this.cfg.requireAcceptedQuotation &&
      !(await this.commercial.reapprovalRequired(client, order.id))
    )
      return;
    const gate = await this.gate(client, order.id);
    if (!gate.satisfied)
      throw new ConflictException(
        `${order.orderNumber} cannot be released for production: ${gate.reasons.join('; ')}`,
      );
  }

  /**
   * Called by `OrdersService.revise` inside its transaction, with the order row locked.
   *
   * A commercially relevant revision ends the validity of every live quotation version (draft, sent
   * or accepted). Nothing is deleted or edited: terms, acceptance and decision stay readable, the
   * version becomes SUPERSEDED with the revision that ended it. Verified payments are untouched and
   * keep counting toward the next accepted quotation.
   */
  async invalidateForRevision(
    tx: Prisma.TransactionClient,
    order: Pick<Order, 'id' | 'orderNumber'>,
    revision: number,
    reasons: string[],
  ) {
    const live = await tx.quotationVersion.findMany({
      where: {
        quotation: { orderId: order.id },
        status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] },
      },
      include: { quotation: true },
    });
    const now = new Date();
    for (const v of live) {
      await tx.quotationVersion.update({
        where: { id: v.id },
        data: {
          status: 'SUPERSEDED',
          supersededAt: now,
          invalidatedAt: now,
          invalidatedByRevision: revision,
          invalidationReason: reasons.join('; ').slice(0, 1000),
        },
      });
      await tx.quotation.update({
        where: { id: v.quotationId },
        data: { status: 'SUPERSEDED' },
      });
    }
    await tx.order.update({
      where: { id: order.id },
      data: { commercialRevision: revision },
    });
    await this.commercial.recomputeFor(tx, { orderId: order.id });
    return live;
  }

  async summary(orderId: string): Promise<OrderCommercialSummaryDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, paymentState: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const [accepted, latest, payments] = await Promise.all([
      this.commercial.acceptedVersionFor(this.prisma, { orderId }),
      this.prisma.quotationVersion.findFirst({
        where: { quotation: { orderId }, status: { in: ['SENT', 'ACCEPTED'] } },
        orderBy: [
          { quotation: { createdAt: 'desc' } },
          { versionNumber: 'desc' },
        ],
        include: { quotation: true },
      }),
      this.prisma.payment.groupBy({
        by: ['status'],
        where: { orderId },
        _sum: { amount: true },
        _count: true,
      }),
    ]);
    const sumOf = (s: string) => {
      const row = payments.find((p) => p.status === s);
      return row?._sum.amount ? D(row._sum.amount) : ZERO;
    };
    const countOf = (s: string) =>
      payments.find((p) => p.status === s)?._count ?? 0;
    const verified = accepted
      ? await this.commercial.verifiedTotalFor(
          this.prisma,
          { orderId },
          accepted.id,
        )
      : sumOf('VERIFIED');
    const head = accepted ?? latest;
    const total = accepted ? D(accepted.total) : null;
    return {
      orderId,
      orderNumber: order.orderNumber,
      currency: head?.quotation.currency ?? null,
      quotationNumber: head?.quotation.quotationNumber ?? null,
      quotationVersionId: head?.id ?? null,
      quotationStatus: head?.status ?? null,
      quotedTotal: head ? fmt(D(head.total)) : null,
      acceptedTotal: total ? fmt(total) : null,
      verifiedPaid: fmt(verified),
      pendingPayments: fmt(sumOf('SUBMITTED').add(sumOf('UNDER_REVIEW'))),
      remaining: total
        ? fmt(total.sub(verified).lt(0) ? ZERO : total.sub(verified))
        : null,
      overpaid: total && verified.gt(total) ? fmt(verified.sub(total)) : '0.00',
      reapprovalRequired: await this.commercial.reapprovalRequired(
        this.prisma,
        orderId,
      ),
      paymentState: order.paymentState,
      counts: {
        verified: countOf('VERIFIED'),
        pending: countOf('SUBMITTED') + countOf('UNDER_REVIEW'),
        rejected: countOf('REJECTED'),
        cancelled: countOf('CANCELLED'),
      },
      releaseGate: await this.gate(this.prisma, orderId),
    };
  }
}
