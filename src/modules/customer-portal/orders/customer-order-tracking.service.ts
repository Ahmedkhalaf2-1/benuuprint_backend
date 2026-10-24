import { Injectable, NotFoundException } from '@nestjs/common';
import type { CustomerPrincipal } from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { EtaService } from '../../management/eta.service.js';
import { variantNames } from '../../orders/order-lookups.js';
import { progressPercent } from '../../orders/pure/order-production.js';
import {
  byTime,
  projectPaymentEvents,
} from '../samples/customer-sample-status.js';
import type {
  CustomerOrderActivityDto,
  CustomerOrderProductionDto,
  CustomerOrderShipmentsDto,
  CustomerShipmentDetailDto,
  CustomerShipmentDto,
} from '../dto/customer-order.dto.js';
import { projectOrderActivity } from './customer-order-status.js';
import {
  SHIPMENT_STATE,
  etaView,
  projectOrderProduction,
} from './customer-order-production.js';

const PRODUCING_DONE = [
  'PRODUCTION_COMPLETED',
  'READY_FOR_PACKAGING',
  'PACKAGING',
  'READY_FOR_DELIVERY',
  'PARTIALLY_SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'COMPLETED',
];

type ShipmentRow = {
  id: string;
  orderId: string;
  shipmentNumber: string;
  status: string;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  scheduledAt: Date | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  addressSnapshot: unknown;
  lines: { quantity: number }[];
};

/** City and country only: the customer knows the street; staff notes and recipient details stay out. */
function destination(snapshot: unknown): string | null {
  const a = (snapshot ?? {}) as { city?: string; country?: string };
  const text = [a.city, a.country].filter(Boolean).join(', ');
  return text || null;
}

const toShipment = (s: ShipmentRow): CustomerShipmentDto => ({
  id: s.id,
  orderId: s.orderId,
  shipmentNumber: s.shipmentNumber,
  status: SHIPMENT_STATE[s.status] ?? 'PREPARING',
  quantity: s.lines.reduce((n, l) => n + l.quantity, 0),
  destination: destination(s.addressSnapshot),
  courierName: s.courierName,
  trackingNumber: s.trackingNumber,
  trackingUrl: s.trackingUrl,
  scheduledAt: s.scheduledAt,
  dispatchedAt: s.dispatchedAt,
  deliveredAt: s.deliveredAt,
});

/** Production, shipments and the timeline of the customer's own orders, in customer language only. */
@Injectable()
export class CustomerOrderTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eta: EtaService,
  ) {}

  private async owned(me: CustomerPrincipal, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, customerId: me.customerId, archivedAt: null },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async production(
    me: CustomerPrincipal,
    id: string,
  ): Promise<CustomerOrderProductionDto> {
    const order = await this.owned(me, id);
    const [jobs, total] = await Promise.all([
      this.prisma.factoryJob.findMany({
        where: { orderId: id, status: { not: 'CANCELLED' } },
        select: {
          status: true,
          completedQuantity: true,
          rejectedQuantity: true,
          stages: {
            select: { stageCode: true, status: true, supersededAt: true },
          },
        },
      }),
      this.prisma.orderVariant.aggregate({
        where: { item: { orderId: id } },
        _sum: { quantity: true },
      }),
    ]);
    const projection = projectOrderProduction(
      jobs.map((j) => ({
        status: j.status,
        stages: j.stages.map((s) => ({
          stageCode: s.stageCode,
          status: s.status,
          superseded: !!s.supersededAt,
        })),
      })),
    );
    const done = PRODUCING_DONE.includes(order.status);
    let eta = null;
    if (!done && jobs.length > 0) {
      const view = await this.eta.order(id).catch(() => null);
      eta = view
        ? etaView(
            view.production.estimatedCompletionAt,
            view.production.dataQuality,
          )
        : null;
    }
    return {
      ...projection,
      progressPercent: progressPercent({
        totalQuantity: total._sum.quantity ?? 0,
        completedQuantity: jobs.reduce((n, j) => n + j.completedQuantity, 0),
        rejectedQuantity: jobs.reduce((n, j) => n + j.rejectedQuantity, 0),
      }),
      packaging:
        order.status === 'READY_FOR_PACKAGING' || order.status === 'PACKAGING'
          ? 'IN_PACKAGING'
          : [
                'READY_FOR_DELIVERY',
                'PARTIALLY_SHIPPED',
                'OUT_FOR_DELIVERY',
                'DELIVERED',
                'COMPLETED',
              ].includes(order.status)
            ? 'READY_FOR_SHIPMENT'
            : 'NOT_STARTED',
      eta,
    };
  }

  async shipments(
    me: CustomerPrincipal,
    id: string,
  ): Promise<CustomerOrderShipmentsDto> {
    await this.owned(me, id);
    const [rows, total, rejected] = await Promise.all([
      this.prisma.shipment.findMany({
        where: { orderId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { lines: { select: { quantity: true } } },
      }),
      this.prisma.orderVariant.aggregate({
        where: { item: { orderId: id } },
        _sum: { quantity: true },
      }),
      this.prisma.factoryJob.aggregate({
        where: { orderId: id, status: { not: 'CANCELLED' } },
        _sum: { rejectedQuantity: true },
      }),
    ]);
    const shipments = rows.map(toShipment);
    const left = new Set(['ON_THE_WAY', 'DELIVERED']);
    const shippedUnits = shipments
      .filter((s) => left.has(s.status))
      .reduce((n, s) => n + s.quantity, 0);
    const deliveredUnits = shipments
      .filter((s) => s.status === 'DELIVERED')
      .reduce((n, s) => n + s.quantity, 0);
    const totalUnits = total._sum.quantity ?? 0;
    const remainingUnits = Math.max(
      0,
      totalUnits - (rejected._sum.rejectedQuantity ?? 0) - shippedUnits,
    );
    return {
      summary: {
        totalUnits,
        shippedUnits,
        deliveredUnits,
        remainingUnits,
        partiallyShipped: shippedUnits > 0 && remainingUnits > 0,
      },
      shipments,
    };
  }

  async shipment(
    me: CustomerPrincipal,
    shipmentId: string,
  ): Promise<CustomerShipmentDetailDto> {
    const row = await this.prisma.shipment.findFirst({
      where: {
        id: shipmentId,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        order: { is: { customerId: me.customerId, archivedAt: null } },
      },
      include: {
        lines: {
          select: {
            quantity: true,
            variant: {
              select: {
                id: true,
                sizeOptionId: true,
                customSizeName: true,
                fabricColorId: true,
                customColorName: true,
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Shipment not found');
    const names = await variantNames(
      this.prisma,
      row.lines.map((l) => l.variant),
    );
    return Object.assign(toShipment(row), {
      lines: row.lines.map((l) => ({
        size: names.get(l.variant.id)?.size ?? null,
        color: names.get(l.variant.id)?.color ?? null,
        quantity: l.quantity,
      })),
    });
  }

  async activity(
    me: CustomerPrincipal,
    id: string,
  ): Promise<CustomerOrderActivityDto[]> {
    await this.owned(me, id);
    const [rows, payments] = await Promise.all([
      this.prisma.orderActivity.findMany({
        where: { orderId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true, createdAt: true, metadata: true },
      }),
      this.prisma.payment.findMany({
        where: { orderId: id },
        select: {
          status: true,
          createdAt: true,
          verifiedAt: true,
          updatedAt: true,
          customerMessage: true,
        },
      }),
    ]);
    return [
      ...projectOrderActivity(rows).map((e) => ({
        at: e.at,
        kind: e.kind,
        title: e.title,
        message: null,
      })),
      ...projectPaymentEvents(payments)
        // "Payment verified" is already on the order timeline; keep the payment steps the order log lacks
        .filter((e) => e.title !== 'Payment verified')
        .map((e) => ({
          at: e.at,
          kind: 'PAYMENT' as const,
          title: e.title,
          message: e.message,
        })),
    ].sort(byTime);
  }
}
