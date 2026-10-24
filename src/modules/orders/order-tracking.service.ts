import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrderActivityService } from './core/order-activity.service.js';
import { OrderTransitionsService } from './core/order-transitions.service.js';
import type {
  PublicTrackingDto,
  TrackingStatusDto,
  TrackingTokenResponseDto,
} from './dto/tracking.dto.js';
import { customerStatus } from './pure/order-fulfillment.js';
import { progressPercent } from './pure/order-production.js';

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
// 32 random bytes, base64url: 43 characters
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const STAGE_LABEL: Record<string, string> = {
  FABRIC: 'Fabric preparation',
  PATTERN: 'Pattern making',
  CUTTING: 'Cutting',
  PRINTING: 'Printing & embroidery',
  SEWING: 'Sewing',
  QC: 'Quality check',
  PACKAGING: 'Packaging',
  GENERAL: 'Finishing',
};
const SHIPMENT_LABEL: Record<string, string> = {
  READY: 'PREPARING',
  DISPATCHED: 'ON_THE_WAY',
  IN_TRANSIT: 'ON_THE_WAY',
  DELIVERED: 'DELIVERED',
  FAILED: 'DELIVERY_ATTEMPT_FAILED',
  RETURNED: 'RETURNED',
};

@Injectable()
export class OrderTrackingService {
  private readonly publicAppUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderTransitionsService,
    private readonly activity: OrderActivityService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.publicAppUrl = config.getOrThrow<AppConfig>('app').publicAppUrl;
  }

  async status(orderId: string): Promise<TrackingStatusDto> {
    if (
      !(await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Order not found');
    const t = await this.prisma.orderTrackingToken.findFirst({
      where: { orderId, revokedAt: null },
    });
    const live = !!t && (!t.expiresAt || t.expiresAt > new Date());
    return {
      enabled: live,
      tokenId: t?.id ?? null,
      createdAt: t?.createdAt ?? null,
      expiresAt: t?.expiresAt ?? null,
      lastUsedAt: t?.lastUsedAt ?? null,
    };
  }

  /**
   * Issue a tracking link. Regenerating revokes the previous token in the same transaction;
   * the order lock and the one-active-token index make concurrent calls safe. Only the hash is
   * stored, and neither the token nor its hash ever reaches the audit log or the timeline.
   */
  async issue(
    orderId: string,
    expiresInDays: number | undefined,
    regenerate: boolean,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<TrackingTokenResponseDto> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null;
    const created = await this.prisma.$transaction(async (tx) => {
      await this.orders.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status === 'CANCELLED')
        throw new ConflictException(`${order.orderNumber} is cancelled`);
      const active = await tx.orderTrackingToken.findFirst({
        where: { orderId, revokedAt: null },
      });
      if (active && !regenerate) {
        throw new ConflictException(
          'A tracking link already exists; regenerate it to replace it',
        );
      }
      if (active) {
        await tx.orderTrackingToken.update({
          where: { id: active.id },
          data: { revokedAt: new Date() },
        });
      }
      const row = await tx.orderTrackingToken.create({
        data: {
          orderId,
          tokenHash: hashToken(token),
          expiresAt,
          createdByUserId: actor.id,
        },
      });
      await this.activity.log(
        tx,
        orderId,
        actor.id,
        'TRACKING_UPDATED',
        active
          ? 'Customer tracking link regenerated'
          : 'Customer tracking link created',
        { tokenId: row.id, replaced: active?.id ?? null },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: active
            ? AuditAction.TRACKING_TOKEN_REGENERATED
            : AuditAction.TRACKING_TOKEN_GENERATED,
          entityType: 'Order',
          entityId: orderId,
          metadata: {
            orderNumber: order.orderNumber,
            tokenId: row.id,
            replacedTokenId: active?.id ?? null,
            expiresAt,
          },
          meta,
        },
        tx,
      );
      return row;
    });
    return {
      token,
      path: `/api/v1/track/orders/${token}`,
      url: this.publicAppUrl
        ? `${this.publicAppUrl.replace(/\/$/, '')}/track/${token}`
        : null,
      expiresAt: created.expiresAt,
      tokenId: created.id,
    };
  }

  async revoke(
    orderId: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<TrackingStatusDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.orders.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      const active = await tx.orderTrackingToken.findFirst({
        where: { orderId, revokedAt: null },
      });
      if (!active)
        throw new ConflictException('This order has no active tracking link');
      await tx.orderTrackingToken.update({
        where: { id: active.id },
        data: { revokedAt: new Date() },
      });
      await this.activity.log(
        tx,
        orderId,
        actor.id,
        'TRACKING_UPDATED',
        'Customer tracking link revoked',
        {
          tokenId: active.id,
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.TRACKING_TOKEN_REVOKED,
          entityType: 'Order',
          entityId: orderId,
          metadata: { orderNumber: order.orderNumber, tokenId: active.id },
          meta,
        },
        tx,
      );
    });
    return this.status(orderId);
  }

  /**
   * Public, unauthenticated lookup. Unknown, malformed, revoked and expired tokens all get the
   * same generic 404, so nothing reveals whether an order exists.
   */
  async publicView(token: string): Promise<PublicTrackingDto> {
    const notFound = () => new NotFoundException('Tracking link not found');
    const digest = hashToken(TOKEN_SHAPE.test(token) ? token : 'invalid');
    const row = await this.prisma.orderTrackingToken.findUnique({
      where: { tokenHash: digest },
    });
    const now = new Date();
    if (
      !TOKEN_SHAPE.test(token) ||
      !row ||
      row.revokedAt ||
      (row.expiresAt && row.expiresAt <= now)
    )
      throw notFound();
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
      await this.prisma.orderTrackingToken
        .update({ where: { id: row.id }, data: { lastUsedAt: now } })
        .catch(() => undefined);
    }
    const order = await this.prisma.order.findUnique({
      where: { id: row.orderId },
      include: {
        items: { include: { variants: { select: { quantity: true } } } },
        shipments: {
          where: { status: { not: 'DRAFT' } },
          include: { lines: { select: { quantity: true } } },
          orderBy: { createdAt: 'asc' },
        },
        jobs: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            completedQuantity: true,
            rejectedQuantity: true,
            stages: {
              where: {
                supersededAt: null,
                status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
              },
              select: { sequence: true, departmentType: true },
            },
          },
        },
      },
    });
    if (!order) throw notFound();
    const total = order.items.reduce(
      (s, i) => s + i.variants.reduce((x, v) => x + v.quantity, 0),
      0,
    );
    const completed = order.jobs.reduce((s, j) => s + j.completedQuantity, 0);
    const rejected = order.jobs.reduce((s, j) => s + j.rejectedQuantity, 0);
    const delivered = order.shipments
      .filter((s) => s.status === 'DELIVERED')
      .reduce((sum, s) => sum + s.lines.reduce((x, l) => x + l.quantity, 0), 0);
    const furthest = order.jobs
      .flatMap((j) => j.stages)
      .sort((a, b) => b.sequence - a.sequence)[0];
    const producing = [
      'IN_PRODUCTION',
      'PARTIALLY_COMPLETED',
      'READY_FOR_PACKAGING',
      'PACKAGING',
    ].includes(order.status);
    return {
      orderNumber: order.orderNumber,
      status: customerStatus(order.status),
      currentStage:
        producing && furthest
          ? (STAGE_LABEL[furthest.departmentType] ?? null)
          : null,
      progressPercent: progressPercent({
        totalQuantity: total,
        completedQuantity: completed,
        rejectedQuantity: rejected,
      }),
      totalQuantity: total,
      deliveredQuantity: delivered,
      remainingDeliveryQuantity: Math.max(0, total - rejected - delivered),
      targetDeliveryDate: order.targetDeliveryDate,
      shipments: order.shipments
        .filter((s) => s.status !== 'CANCELLED')
        .map((s) => ({
          shipmentNumber: s.shipmentNumber,
          status: SHIPMENT_LABEL[s.status] ?? 'PREPARING',
          quantity: s.lines.reduce((x, l) => x + l.quantity, 0),
          courierName: s.courierName,
          trackingUrl: s.trackingUrl,
          dispatchedAt: s.dispatchedAt,
          deliveredAt: s.deliveredAt,
        })),
      updatedAt: order.updatedAt,
    };
  }
}
