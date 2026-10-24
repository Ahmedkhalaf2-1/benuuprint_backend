import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ActorRef,
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../../common/types/paginated.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { OrderStatus, Prisma } from '../../../generated/prisma/client.js';
import {
  AssetsService,
  type UploadedFileInput,
} from '../../assets/assets.service.js';
import { MAX_PENDING_CUSTOMER_PAYMENTS } from '../../payments/payments.service.js';
import { PaymentsService } from '../../payments/payments.service.js';
import { QuotationsService } from '../../quotations/quotations.service.js';
import type {
  CreateOrderDto,
  OrderItemInputDto,
  ReorderDto,
} from '../../orders/dto/order.dto.js';
import { OrderCommercialService } from '../../orders/order-commercial.service.js';
import { variantNames } from '../../orders/order-lookups.js';
import { OrdersService } from '../../orders/orders.service.js';
import { progressPercent } from '../../orders/pure/order-production.js';
import { D } from '../../commercial/money.js';
import { paymentStatus } from '../commercial/customer-commercial.js';
import {
  paymentSelect,
  toCustomerPayment,
} from '../commercial/customer-payment-projection.js';
import {
  projectQuotations,
  type QuotationRow,
} from '../commercial/quotation-projection.js';
import type {
  CustomerPaymentDto,
  CustomerPaymentsDto,
  CustomerQuotationsDto,
  CustomerSubmitPaymentDto,
} from '../dto/customer-commercial.dto.js';
import type {
  CustomerCreateOrderDto,
  CustomerOrderCommercialDto,
  CustomerOrderDetailDto,
  CustomerOrderItemsDto,
  CustomerOrderListItemDto,
  CustomerReorderDto,
  CustomerUpdateOrderDto,
  ListCustomerOrdersQueryDto,
} from '../dto/customer-order.dto.js';
import {
  ORDER_NEXT_STEP,
  ORDER_STATUS_LABEL,
  REORDERABLE_STATUSES,
  orderAllowedActions,
  toCustomerOrderStatus,
  type CustomerOrderAction,
  type CustomerOrderStatus,
} from './customer-order-status.js';

const OPEN_PAYMENT = ['SUBMITTED', 'UNDER_REVIEW'] as const;
const QUOTABLE = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'READY_FOR_PRODUCTION',
  'ON_HOLD',
];

const listInclude = {
  brand: { select: { id: true, name: true } },
  items: {
    select: {
      productNameSnapshot: true,
      variants: { select: { quantity: true } },
    },
    orderBy: { sortOrder: 'asc' },
  },
  quotations: {
    where: { archivedAt: null },
    select: {
      versions: {
        where: { status: { in: ['SENT', 'ACCEPTED'] } },
        select: { status: true, validUntil: true, invalidatedAt: true },
      },
    },
  },
  payments: {
    where: { status: { in: [...OPEN_PAYMENT] } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.OrderInclude;
type ListRow = Prisma.OrderGetPayload<{ include: typeof listInclude }>;

const asActor = (me: CustomerPrincipal): ActorRef => ({
  id: me.customerId,
  customer: true,
});

const total = (r: ListRow) =>
  r.items.reduce(
    (s, i) => s + i.variants.reduce((x, v) => x + v.quantity, 0),
    0,
  );

function facts(r: ListRow) {
  const now = new Date();
  const versions = r.quotations.flatMap((q) => q.versions);
  return {
    openQuotation: versions.some(
      (v) =>
        v.status === 'SENT' &&
        !v.invalidatedAt &&
        !(v.validUntil && v.validUntil <= now),
    ),
    accepted: versions.some((v) => v.status === 'ACCEPTED'),
    pendingPayment: r.payments.length > 0,
  };
}

const statusOf = (r: ListRow): CustomerOrderStatus =>
  toCustomerOrderStatus({
    status: r.status,
    holdPreviousStatus: r.holdPreviousStatus,
    paymentState: r.paymentState,
    ...facts(r),
  });

function toListItem(r: ListRow): CustomerOrderListItemDto {
  const status = statusOf(r);
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    status,
    statusLabel: ORDER_STATUS_LABEL[status],
    nextStep: ORDER_NEXT_STEP[status],
    brand: r.brand,
    productName: r.items[0]?.productNameSnapshot ?? null,
    totalQuantity: total(r),
    targetDeliveryDate: r.targetDeliveryDate,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Same unit and date rules for create, edit and reorder. */
function assertFutureDate(date: Date | null | undefined) {
  if (!date) return;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  if (date < startOfToday)
    throw new BadRequestException([
      'targetDeliveryDate: must not be in the past',
    ]);
}

/** A customer's single product line, as the staff domain's item input. Totals must be consistent. */
function toItemInput(items: CustomerOrderItemsDto): OrderItemInputDto {
  const sum = items.variants.reduce((s, v) => s + v.quantity, 0);
  if (sum !== items.quantity)
    throw new BadRequestException([
      `items: the size / colour lines add up to ${sum} but the quantity is ${items.quantity}`,
    ]);
  return {
    quantity: items.quantity,
    notes: items.notes,
    variants: items.variants.map((v) => ({
      sizeOptionId: v.sizeOptionId,
      fabricColorId: v.fabricColorId,
      quantity: v.quantity,
      notes: v.notes,
    })),
  } as OrderItemInputDto;
}

/**
 * Everything a customer does with their bulk orders. The Order domain is the staff one (creation from the
 * approved reference, items, submit, reorder, quotation decisions, payments); this class proves ownership,
 * limits what a customer may set, and projects customer-safe views.
 */
@Injectable()
export class CustomerOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly orderCommercial: OrderCommercialService,
    private readonly quotations: QuotationsService,
    private readonly payments: PaymentsService,
    private readonly assets: AssetsService,
  ) {}

  // ---- ownership ---------------------------------------------------------------------------------

  private async owned(me: CustomerPrincipal, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, customerId: me.customerId, archivedAt: null },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ---- list --------------------------------------------------------------------------------------

  async list(
    me: CustomerPrincipal,
    query: ListCustomerOrdersQueryDto,
  ): Promise<Paginated<CustomerOrderListItemDto>> {
    const search = query.search?.trim();
    const where: Prisma.OrderWhereInput = {
      customerId: me.customerId,
      archivedAt: null,
      brandId: query.brandId,
      ...(query.status?.length && {
        AND: [{ OR: query.status.map((s) => this.whereForStatus(s)) }],
      }),
      ...(search && {
        OR: [
          { orderNumber: { contains: search, mode: 'insensitive' } },
          {
            brand: { is: { name: { contains: search, mode: 'insensitive' } } },
          },
          {
            items: {
              some: {
                productNameSnapshot: { contains: search, mode: 'insensitive' },
              },
            },
          },
        ],
      }),
    };
    const sorts: Record<string, Prisma.OrderOrderByWithRelationInput> = {
      newest: { createdAt: 'desc' },
      oldest: { createdAt: 'asc' },
      updated: { updatedAt: 'desc' },
      orderNumber: { orderNumber: 'asc' },
      targetDate: { targetDeliveryDate: { sort: 'asc', nulls: 'last' } },
    };
    const [rows, count] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: listInclude,
        orderBy: [sorts[query.sort]!, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginated(rows.map(toListItem), query.page, query.pageSize, count);
  }

  /** The internal statuses behind a customer status; a hold keeps the status it interrupted. */
  private internal(statuses: OrderStatus[]): Prisma.OrderWhereInput {
    return {
      OR: [
        { status: { in: statuses } },
        { status: 'ON_HOLD', holdPreviousStatus: { in: statuses } },
      ],
    };
  }

  private whereForStatus(status: CustomerOrderStatus): Prisma.OrderWhereInput {
    const now = new Date();
    const Q_OPEN: Prisma.OrderWhereInput = {
      quotations: {
        some: {
          archivedAt: null,
          versions: {
            some: {
              status: 'SENT',
              invalidatedAt: null,
              OR: [{ validUntil: null }, { validUntil: { gt: now } }],
            },
          },
        },
      },
    };
    const ACC: Prisma.OrderWhereInput = {
      quotations: { some: { versions: { some: { status: 'ACCEPTED' } } } },
    };
    const PP: Prisma.OrderWhereInput = {
      payments: { some: { status: { in: [...OPEN_PAYMENT] } } },
    };
    const st = (...s: OrderStatus[]) => this.internal(s);
    switch (status) {
      case 'DRAFT':
        return { status: 'DRAFT' };
      case 'PENDING_CONFIRMATION':
        return { AND: [st('PENDING_CONFIRMATION'), { NOT: Q_OPEN }] };
      case 'QUOTATION_READY':
        return {
          OR: [
            { AND: [st('PENDING_CONFIRMATION'), Q_OPEN] },
            { AND: [st('CONFIRMED'), Q_OPEN, { NOT: ACC }] },
          ],
        };
      case 'QUOTATION_PENDING':
        return { AND: [st('CONFIRMED'), { NOT: ACC }, { NOT: Q_OPEN }] };
      case 'PAYMENT_REQUIRED':
        return {
          AND: [
            st('CONFIRMED'),
            ACC,
            { paymentState: { not: 'PAID' } },
            { NOT: PP },
          ],
        };
      case 'PAYMENT_UNDER_REVIEW':
        return {
          AND: [st('CONFIRMED'), ACC, { paymentState: { not: 'PAID' } }, PP],
        };
      case 'READY_FOR_PRODUCTION':
        return {
          OR: [
            st('READY_FOR_PRODUCTION'),
            { AND: [st('CONFIRMED'), ACC, { paymentState: 'PAID' }] },
          ],
        };
      case 'IN_PRODUCTION':
        return st(
          'IN_PRODUCTION',
          'PARTIALLY_COMPLETED',
          'PRODUCTION_COMPLETED',
        );
      case 'PACKAGING':
        return st('READY_FOR_PACKAGING', 'PACKAGING');
      case 'READY_TO_SHIP':
        return st('READY_FOR_DELIVERY');
      case 'PARTIALLY_SHIPPED':
        return st('PARTIALLY_SHIPPED');
      case 'SHIPPED':
        return st('OUT_FOR_DELIVERY');
      case 'DELIVERED':
        return st('DELIVERED');
      case 'COMPLETED':
        return { status: 'COMPLETED' };
      case 'CANCELLED':
        return { status: 'CANCELLED' };
    }
  }

  // ---- detail ------------------------------------------------------------------------------------

  async get(
    me: CustomerPrincipal,
    id: string,
  ): Promise<CustomerOrderDetailDto> {
    const row = await this.prisma.order.findFirst({
      where: { id, customerId: me.customerId, archivedAt: null },
      include: {
        ...listInclude,
        items: {
          orderBy: { sortOrder: 'asc' },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        },
        sourceSample: { select: { id: true, sampleNumber: true } },
        approvedSpec: { select: { snapshot: true } },
        reorderOf: { select: { orderNumber: true } },
        shipments: {
          where: { status: { in: ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED'] } },
          select: { status: true, lines: { select: { quantity: true } } },
        },
        jobs: {
          where: { status: { not: 'CANCELLED' } },
          select: { completedQuantity: true, rejectedQuantity: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Order not found');

    const [commercial, pendingMine] = await Promise.all([
      this.orderCommercial.summary(id),
      this.prisma.payment.count({
        where: {
          orderId: id,
          createdByCustomerId: me.customerId,
          status: { in: [...OPEN_PAYMENT] },
        },
      }),
    ]);
    const pay = paymentStatus({
      acceptedTotal: commercial.acceptedTotal,
      verified: commercial.verifiedPaid,
      pending: commercial.pendingPayments,
    });
    const f = facts(row);
    const status = statusOf(row);
    const canSubmitPayment =
      f.accepted &&
      !!pay.remaining &&
      D(pay.remaining).gt(0) &&
      pendingMine < MAX_PENDING_CUSTOMER_PAYMENTS;
    const allowedActions: CustomerOrderAction[] = orderAllowedActions({
      status: row.status,
      openQuotation: f.openQuotation,
      canSubmitPayment,
      reorderable:
        !!row.currentSpecId && REORDERABLE_STATUSES.includes(row.status),
    });

    const flat = row.items.flatMap((i) => i.variants);
    const names = await variantNames(this.prisma, flat);
    const totalUnits = flat.reduce((s, v) => s + v.quantity, 0);
    const lineSum = (s: { lines: { quantity: number }[] }) =>
      s.lines.reduce((x, l) => x + l.quantity, 0);
    const shipped = row.shipments.reduce((n, s) => n + lineSum(s), 0);
    const delivered = row.shipments
      .filter((s) => s.status === 'DELIVERED')
      .reduce((n, s) => n + lineSum(s), 0);
    const completed = row.jobs.reduce((n, j) => n + j.completedQuantity, 0);
    const rejected = row.jobs.reduce((n, j) => n + j.rejectedQuantity, 0);
    const snapshot = row.approvedSpec.snapshot as {
      product?: { name?: string };
    };
    const base = toListItem(row);
    return Object.assign(base, {
      productName:
        row.items[0]?.productNameSnapshot ?? snapshot.product?.name ?? null,
      allowedActions,
      reference: {
        sampleId: row.sourceSample.id,
        sampleNumber: row.sourceSample.sampleNumber,
        productName: snapshot.product?.name ?? base.productName ?? 'Product',
      },
      items: row.items.map((i) => ({
        id: i.id,
        productName: i.productNameSnapshot,
        quantity: i.quantity,
        notes: i.notes,
        variants: i.variants.map((v) => ({
          id: v.id,
          size: names.get(v.id)?.size ?? null,
          color: names.get(v.id)?.color ?? null,
          sizeOptionId: v.sizeOptionId,
          fabricColorId: v.fabricColorId,
          quantity: v.quantity,
          notes: v.notes,
        })),
      })),
      quantities: {
        total: totalUnits,
        shipped,
        delivered,
        remaining: Math.max(0, totalUnits - rejected - shipped),
      },
      customerNotes: row.customerNotes,
      preferredAddressId: row.preferredAddressId,
      confirmedAt: row.confirmedAt,
      deliveredAt: row.deliveredAt,
      reorderOf: row.reorderOf?.orderNumber ?? null,
      commercial: {
        paymentStatus: pay.status,
        currency: commercial.acceptedTotal ? commercial.currency : null,
        requiredAmount: commercial.acceptedTotal,
        remainingAmount: pay.remaining,
        requiresReview: commercial.reapprovalRequired,
      },
      progressPercent: progressPercent({
        totalQuantity: totalUnits,
        completedQuantity: completed,
        rejectedQuantity: rejected,
      }),
      // the list item above already carries the customer status, label and next step
      status,
    }) as CustomerOrderDetailDto;
  }

  // ---- create / edit / submit / reorder ---------------------------------------------------------------

  /**
   * A DRAFT order from an approved sample the customer owns. The approved reference, party checks and item
   * rules are the staff ones; confirmation stays with staff.
   */
  async create(
    me: CustomerPrincipal,
    sampleId: string,
    dto: CustomerCreateOrderDto,
    meta: RequestMeta,
  ): Promise<CustomerOrderDetailDto> {
    assertFutureDate(dto.targetDeliveryDate);
    const input = dto.items ? [toItemInput(dto.items)] : undefined;
    const id = await this.orders.createFor(
      sampleId,
      {
        targetDeliveryDate: dto.targetDeliveryDate,
        items: input,
      } as CreateOrderDto,
      asActor(me),
      meta,
      {
        customerNotes: dto.customerNotes,
        preferredAddressId: dto.preferredAddressId,
      },
    );
    return this.get(me, id);
  }

  async update(
    me: CustomerPrincipal,
    id: string,
    dto: CustomerUpdateOrderDto,
    meta: RequestMeta,
  ): Promise<CustomerOrderDetailDto> {
    await this.owned(me, id);
    assertFutureDate(dto.targetDeliveryDate);
    await this.orders.updateDraftDetails(id, dto, asActor(me), meta);
    return this.get(me, id);
  }

  async replaceItems(
    me: CustomerPrincipal,
    id: string,
    dto: CustomerOrderItemsDto,
    meta: RequestMeta,
  ): Promise<CustomerOrderDetailDto> {
    await this.owned(me, id);
    await this.orders.replaceItems(id, [toItemInput(dto)], asActor(me), meta);
    return this.get(me, id);
  }

  async submit(
    me: CustomerPrincipal,
    id: string,
    meta: RequestMeta,
  ): Promise<CustomerOrderDetailDto> {
    await this.owned(me, id);
    await this.orders.submitFor(id, asActor(me), meta);
    return this.get(me, id);
  }

  async reorder(
    me: CustomerPrincipal,
    id: string,
    dto: CustomerReorderDto,
    meta: RequestMeta,
  ): Promise<CustomerOrderDetailDto> {
    const order = await this.owned(me, id);
    if (!REORDERABLE_STATUSES.includes(order.status))
      throw new ConflictException(
        'Only a delivered or completed order can be reordered',
      );
    assertFutureDate(dto.targetDeliveryDate);
    const created = await this.orders.reorder(
      id,
      {
        targetDeliveryDate: dto.targetDeliveryDate,
        cloneItems: dto.cloneItems,
      } as ReorderDto,
      asActor(me),
      meta,
      { customerNotes: dto.customerNotes },
    );
    return this.get(me, created.id);
  }

  // ---- commercial ---------------------------------------------------------------------------------

  async quotationsOf(
    me: CustomerPrincipal,
    orderId: string,
  ): Promise<CustomerQuotationsDto> {
    const order = await this.owned(me, orderId);
    const [rows, summary] = await Promise.all([
      this.prisma.quotation.findMany({
        where: {
          orderId,
          archivedAt: null,
          versions: { some: { sentAt: { not: null } } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          versions: {
            where: { sentAt: { not: null } },
            orderBy: { versionNumber: 'asc' },
            include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      }),
      this.orderCommercial.summary(orderId),
    ]);
    return projectQuotations(
      rows as unknown as QuotationRow[],
      (v, now) =>
        QUOTABLE.includes(order.status) &&
        v.status === 'SENT' &&
        !v.invalidatedAt &&
        !(v.validUntil && v.validUntil <= now),
      summary.reapprovalRequired,
    );
  }

  /** Accept or reject: the version id is the target; the order is returned refreshed. */
  async decide(
    me: CustomerPrincipal,
    versionId: string,
    decision: 'accept' | 'reject',
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<CustomerOrderDetailDto> {
    const orderId = await this.quotations.decideForOrderAsCustomer(
      me.customerId,
      versionId,
      decision,
      reason,
      meta,
    );
    return this.get(me, orderId);
  }

  private async paymentSummary(orderId: string) {
    const s = await this.orderCommercial.summary(orderId);
    const state = paymentStatus({
      acceptedTotal: s.acceptedTotal,
      verified: s.verifiedPaid,
      pending: s.pendingPayments,
    });
    return {
      summary: {
        status: state.status,
        currency: s.acceptedTotal === null ? null : s.currency,
        requiredAmount: s.acceptedTotal,
        verifiedAmount: s.verifiedPaid,
        pendingAmount: s.pendingPayments,
        remainingAmount: state.remaining,
      },
      commercial: s,
    };
  }

  async commercialOf(
    me: CustomerPrincipal,
    orderId: string,
  ): Promise<CustomerOrderCommercialDto> {
    await this.owned(me, orderId);
    const [{ summary, commercial }, quotes, detail] = await Promise.all([
      this.paymentSummary(orderId),
      this.quotationsOf(me, orderId),
      this.get(me, orderId),
    ]);
    const actions = detail.allowedActions;
    return {
      orderId,
      quotationNumber: commercial.quotationNumber,
      actionableVersionId: quotes.actionableVersionId,
      // true while a change to the order has made the earlier quotation obsolete and a new one is not yet accepted
      requiresReview: quotes.requiresReview || commercial.reapprovalRequired,
      notice: quotes.notice,
      payment: summary,
      readyForProduction: commercial.releaseGate.satisfied,
      nextAction: actions.includes('ACCEPT_QUOTATION')
        ? 'REVIEW_QUOTATION'
        : actions.includes('UPLOAD_PAYMENT_PROOF')
          ? 'PAY'
          : 'NONE',
      allowedActions: actions,
    };
  }

  async paymentsOf(
    me: CustomerPrincipal,
    orderId: string,
  ): Promise<CustomerPaymentsDto> {
    await this.owned(me, orderId);
    const [{ summary }, rows] = await Promise.all([
      this.paymentSummary(orderId),
      this.prisma.payment.findMany({
        where: { orderId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: paymentSelect,
      }),
    ]);
    return {
      summary,
      payments: rows.map((p) => toCustomerPayment(p, me.customerId)),
    };
  }

  async submitPayment(
    me: CustomerPrincipal,
    orderId: string,
    file: UploadedFileInput | undefined,
    dto: CustomerSubmitPaymentDto,
    meta: RequestMeta,
  ): Promise<CustomerPaymentDto> {
    await this.owned(me, orderId);
    if (!file) throw new BadRequestException('A proof file is required');
    const proof = await this.assets.uploadForCustomer(
      file,
      { type: 'PAYMENT_PROOF' },
      me.customerId,
      meta,
    );
    try {
      const created = await this.payments.createForOrder(
        orderId,
        {
          amount: dto.amount,
          method: dto.method,
          transactionReference: dto.transactionReference,
          receivedAt: dto.receivedAt,
          proofAssetId: proof.id,
        },
        asActor(me),
        meta,
      );
      const row = await this.prisma.payment.findUniqueOrThrow({
        where: { id: created.id },
        select: paymentSelect,
      });
      return toCustomerPayment(row, me.customerId);
    } catch (error) {
      await this.prisma.asset
        .update({ where: { id: proof.id }, data: { archivedAt: new Date() } })
        .catch(() => undefined);
      throw error;
    }
  }
}
