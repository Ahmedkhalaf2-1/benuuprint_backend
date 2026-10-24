import { ResponsibilityRulesService } from '../responsibilities/responsibility-rules.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import { nextReference } from '../../database/reference-sequence.js';
import type {
  Order,
  OrderActivityType,
  Prisma,
  Shipment,
} from '../../generated/prisma/client.js';
import {
  AssetsService,
  type UploadedFileInput,
} from '../assets/assets.service.js';
import type { DownloadUrlResponseDto } from '../assets/dto/asset.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthContextService } from '../auth/auth-context.service.js';
import { OrderActivityService } from './core/order-activity.service.js';
import { OrderSyncService } from './core/order-sync.service.js';
import { OrderTransitionsService } from './core/order-transitions.service.js';
import type {
  CreateShipmentDto,
  DeliverShipmentDto,
  DispatchShipmentDto,
  ListMyDeliveriesQueryDto,
  ListShipmentsQueryDto,
  ShipmentAddressInputDto,
  ShipmentLineInputDto,
  ShipmentResponseDto,
  StaffDeliveryDto,
  UpdateShipmentDto,
} from './dto/shipment.dto.js';
import { variantNames } from './order-lookups.js';
import { OrderPackagingService } from './order-packaging.service.js';
import {
  COMMITTED_SHIPMENT_STATUSES,
  FINAL_SHIPMENT_STATUSES,
  SHIPMENT_TRANSITIONS,
  checkShipmentTransition,
  type ShipmentAction,
} from './pure/shipment-state-machine.js';

type Tx = Prisma.TransactionClient;

const SHIPPABLE_ORDER_STATUSES = [
  'PARTIALLY_COMPLETED',
  'PRODUCTION_COMPLETED',
  'READY_FOR_DELIVERY',
  'PARTIALLY_SHIPPED',
  'OUT_FOR_DELIVERY',
];

const include = {
  lines: true,
  order: { select: { orderNumber: true } },
} satisfies Prisma.ShipmentInclude;
type Row = Prisma.ShipmentGetPayload<{ include: typeof include }>;

const ACTIVITY: Record<ShipmentAction, OrderActivityType> = {
  ready: 'SHIPMENT_READY',
  dispatch: 'SHIPMENT_DISPATCHED',
  'in-transit': 'SHIPMENT_DISPATCHED',
  deliver: 'SHIPMENT_DELIVERED',
  fail: 'SHIPMENT_FAILED',
  return: 'SHIPMENT_RETURNED',
  cancel: 'ORDER_UPDATED',
};
const AUDIT: Record<ShipmentAction, string> = {
  ready: AuditAction.SHIPMENT_READY,
  dispatch: AuditAction.SHIPMENT_DISPATCHED,
  'in-transit': AuditAction.SHIPMENT_IN_TRANSIT,
  deliver: AuditAction.SHIPMENT_DELIVERED,
  fail: AuditAction.SHIPMENT_FAILED,
  return: AuditAction.SHIPMENT_RETURNED,
  cancel: AuditAction.SHIPMENT_CANCELLED,
};

export interface TransitionInput {
  reason?: string;
  dispatch?: DispatchShipmentDto;
  deliver?: DeliverShipmentDto;
}

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderTransitionsService,
    private readonly activity: OrderActivityService,
    private readonly sync: OrderSyncService,
    private readonly packaging: OrderPackagingService,
    private readonly access: AuthContextService,
    private readonly assets: AssetsService,
    private readonly audit: AuditService,
    private readonly responsibilities: ResponsibilityRulesService,
  ) {}

  // ───────────────────────── mapping ─────────────────────────

  private async toDtos(rows: Row[]): Promise<ShipmentResponseDto[]> {
    const variantIds = [
      ...new Set(rows.flatMap((r) => r.lines.map((l) => l.orderVariantId))),
    ];
    const variants = variantIds.length
      ? await this.prisma.orderVariant.findMany({
          where: { id: { in: variantIds } },
        })
      : [];
    const names = await variantNames(this.prisma, variants);
    const userIds = [
      ...new Set(
        rows
          .map((r) => r.assignedDeliveryUserId)
          .filter((x): x is string => !!x),
      ),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
    const userName = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      shipmentNumber: r.shipmentNumber,
      orderId: r.orderId,
      orderNumber: r.order.orderNumber,
      status: r.status,
      deliveryMethod: r.deliveryMethod,
      recipientName: r.recipientName,
      recipientPhone: r.recipientPhone,
      addressSnapshot: r.addressSnapshot as Record<string, unknown>,
      courierName: r.courierName,
      trackingNumber: r.trackingNumber,
      trackingUrl: r.trackingUrl,
      scheduledAt: r.scheduledAt,
      readyAt: r.readyAt,
      dispatchedAt: r.dispatchedAt,
      inTransitAt: r.inTransitAt,
      deliveredAt: r.deliveredAt,
      failedAt: r.failedAt,
      returnedAt: r.returnedAt,
      cancelledAt: r.cancelledAt,
      failureReason: r.failureReason,
      returnReason: r.returnReason,
      cancelReason: r.cancelReason,
      hasProof: !!r.proofAssetId,
      notes: r.notes,
      deliveryNotes: r.deliveryNotes,
      assignedDeliveryUserId: r.assignedDeliveryUserId,
      assignedDeliveryName: r.assignedDeliveryUserId
        ? (userName.get(r.assignedDeliveryUserId) ?? null)
        : null,
      totalQuantity: r.lines.reduce((s, l) => s + l.quantity, 0),
      lines: r.lines.map((l) => ({
        orderVariantId: l.orderVariantId,
        label: names.get(l.orderVariantId)?.label ?? 'Variant',
        quantity: l.quantity,
      })),
      createdAt: r.createdAt,
    }));
  }

  async get(id: string): Promise<ShipmentResponseDto> {
    const row = await this.prisma.shipment.findUnique({
      where: { id },
      include,
    });
    if (!row) throw new NotFoundException('Shipment not found');
    return (await this.toDtos([row]))[0]!;
  }

  async listForOrder(orderId: string): Promise<ShipmentResponseDto[]> {
    if (
      !(await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Order not found');
    const rows = await this.prisma.shipment.findMany({
      where: { orderId },
      include,
      orderBy: { createdAt: 'asc' },
    });
    return this.toDtos(rows);
  }

  async list(
    q: ListShipmentsQueryDto,
  ): Promise<Paginated<ShipmentResponseDto>> {
    const and: Prisma.ShipmentWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.orderId) and.push({ orderId: q.orderId });
    if (q.assignedDeliveryUserId)
      and.push({ assignedDeliveryUserId: q.assignedDeliveryUserId });
    if (q.open) and.push({ status: { notIn: [...FINAL_SHIPMENT_STATUSES] } });
    if (q.search?.trim()) {
      const s = q.search.trim();
      and.push({
        OR: [
          { shipmentNumber: { contains: s, mode: 'insensitive' } },
          { trackingNumber: { contains: s, mode: 'insensitive' } },
          { recipientName: { contains: s, mode: 'insensitive' } },
          { order: { orderNumber: { contains: s, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.ShipmentWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return paginated(await this.toDtos(rows), q.page, q.pageSize, total);
  }

  // ───────────────────────── creation ─────────────────────────

  private snapshotOf(a: ShipmentAddressInputDto, source: string) {
    return {
      source,
      country: a.country ?? null,
      state: a.state ?? null,
      city: a.city,
      area: a.area ?? null,
      addressLine1: a.addressLine1,
      addressLine2: a.addressLine2 ?? null,
      postalCode: a.postalCode ?? null,
      notes: a.notes ?? null,
    };
  }

  private async resolveAddress(
    tx: Tx,
    order: Order,
    dto: {
      deliveryMethod: string;
      customerAddressId?: string;
      address?: ShipmentAddressInputDto;
    },
  ): Promise<{
    snapshot: Record<string, unknown>;
    customerAddressId: string | null;
  }> {
    if (dto.customerAddressId && dto.address)
      throw new BadRequestException(
        'Give a saved address or a one-off address, not both',
      );
    if (dto.customerAddressId) {
      const a = await tx.customerAddress.findUnique({
        where: { id: dto.customerAddressId },
      });
      if (!a || a.customerId !== order.customerId || a.archivedAt)
        throw new BadRequestException(
          "customerAddressId: not an active address of the order's customer",
        );
      return {
        customerAddressId: a.id,
        snapshot: {
          source: 'CUSTOMER_ADDRESS',
          country: a.country,
          state: a.state,
          city: a.city,
          area: a.area,
          addressLine1: a.addressLine1,
          addressLine2: a.addressLine2,
          postalCode: a.postalCode,
          notes: a.notes,
        },
      };
    }
    if (dto.address)
      return {
        customerAddressId: null,
        snapshot: this.snapshotOf(dto.address, 'CUSTOM'),
      };
    if (dto.deliveryMethod !== 'CUSTOMER_PICKUP')
      throw new BadRequestException(
        'A destination (customerAddressId or address) is required for delivery',
      );
    return {
      customerAddressId: null,
      snapshot: { source: 'PICKUP', note: 'Customer pickup' },
    };
  }

  private async assertDeliveryUser(userId: string | null | undefined) {
    if (!userId) return;
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null, isActive: true, status: 'ACTIVE' },
    });
    if (!user)
      throw new BadRequestException(
        'assignedDeliveryUserId: active staff user not found',
      );
    const { permissions } = await this.access.loadAccess(userId);
    if (!permissions.has('shipments.dispatch'))
      throw new BadRequestException('That staff member cannot make deliveries');
  }

  /**
   * What can still go on a shipment, per variant and in total. Everything is computed from
   * stored production / packaging / shipment facts under the order lock; the database trigger on
   * shipment_lines is the concurrency-proof backstop.
   */
  private async assertAvailable(
    tx: Tx,
    order: Order,
    lines: ShipmentLineInputDto[],
    exceptShipmentId?: string,
  ) {
    const ids = lines.map((l) => l.orderVariantId);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException(
        'A variant can appear only once per shipment',
      );
    const variants = await tx.orderVariant.findMany({
      where: { id: { in: ids }, item: { orderId: order.id } },
    });
    if (variants.length !== ids.length)
      throw new BadRequestException('A variant does not belong to this order');
    const spec = await tx.orderPackagingSpec.count({
      where: { orderId: order.id },
    });
    if (spec === 0)
      throw new ConflictException(
        'Define the order packaging specification before shipping',
      );
    const figures = await this.packaging.figures(tx, order.id);
    const requested = lines.reduce((s, l) => s + l.quantity, 0);
    const mine = exceptShipmentId
      ? await tx.shipmentLine.aggregate({
          where: { shipmentId: exceptShipmentId },
          _sum: { quantity: true },
        })
      : null;
    const available = figures.shippableQuantity + (mine?._sum.quantity ?? 0);
    if (requested > available) {
      throw new ConflictException(
        `Over-shipping: ${requested} unit(s) requested but only ${available} are produced, packed and not yet on a shipment`,
      );
    }
    // Variant level: attributed completions when production reports name variants, ordered otherwise.
    const attributed = await tx.orderVariant.aggregate({
      where: { item: { orderId: order.id } },
      _sum: { completedQuantity: true },
    });
    const useAttributed = (attributed._sum.completedQuantity ?? 0) > 0;
    const committed = await tx.shipmentLine.groupBy({
      by: ['orderVariantId'],
      where: {
        orderVariantId: { in: ids },
        shipment: {
          status: { in: [...COMMITTED_SHIPMENT_STATUSES] },
          ...(exceptShipmentId && { id: { not: exceptShipmentId } }),
        },
      },
      _sum: { quantity: true },
    });
    const committedBy = new Map(
      committed.map((c) => [c.orderVariantId, c._sum.quantity ?? 0]),
    );
    for (const l of lines) {
      const v = variants.find((x) => x.id === l.orderVariantId)!;
      const cap = useAttributed
        ? v.completedQuantity
        : v.quantity - v.rejectedQuantity;
      const left = cap - (committedBy.get(v.id) ?? 0);
      if (l.quantity > left)
        throw new ConflictException(
          `Over-shipping: variant has ${cap} deliverable unit(s), ${committedBy.get(v.id) ?? 0} already on shipments, ${l.quantity} requested`,
        );
    }
  }

  private async writeLines(
    tx: Tx,
    shipmentId: string,
    lines: ShipmentLineInputDto[],
  ) {
    await tx.shipmentLine.deleteMany({ where: { shipmentId } });
    try {
      for (const l of lines)
        await tx.shipmentLine.create({
          data: {
            shipmentId,
            orderVariantId: l.orderVariantId,
            quantity: l.quantity,
          },
        });
    } catch (e) {
      if (e instanceof Error && /over-shipping/i.test(e.message))
        throw new ConflictException(
          'Over-shipping: another shipment just took those units',
        );
      throw e;
    }
  }

  async create(
    orderId: string,
    dto: CreateShipmentDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<ShipmentResponseDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.orders.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      if (!SHIPPABLE_ORDER_STATUSES.includes(order.status)) {
        throw new ConflictException(
          `${order.orderNumber} is ${order.status}: shipments need produced and packed units (and an order that is not on hold or finished)`,
        );
      }
      await this.assertDeliveryUser(dto.assignedDeliveryUserId);
      // No delivery person given: the default responsibility (customer override, else global) fills it.
      const deliveryUserId =
        dto.assignedDeliveryUserId ??
        (await this.responsibilities.defaultDeliveryUserId(order.customerId));
      await this.assertAvailable(tx, order, dto.lines);
      const { snapshot, customerAddressId } = await this.resolveAddress(
        tx,
        order,
        dto,
      );
      const shipmentNumber = await nextReference(tx, 'SHP');
      const shipment = await tx.shipment.create({
        data: {
          shipmentNumber,
          orderId,
          deliveryMethod: dto.deliveryMethod,
          recipientName: dto.recipientName,
          recipientPhone: dto.recipientPhone,
          addressSnapshot: snapshot as Prisma.InputJsonValue,
          customerAddressId,
          courierName: dto.courierName,
          trackingNumber: dto.trackingNumber,
          trackingUrl: dto.trackingUrl,
          scheduledAt: dto.scheduledAt,
          notes: dto.notes,
          deliveryNotes: dto.deliveryNotes,
          assignedDeliveryUserId: deliveryUserId,
          createdByUserId: actor.id,
        },
      });
      await this.writeLines(tx, shipment.id, dto.lines);
      const quantity = dto.lines.reduce((s, l) => s + l.quantity, 0);
      await this.activity.log(
        tx,
        orderId,
        actor.id,
        'SHIPMENT_CREATED',
        `${shipmentNumber} created (${quantity} units)`,
        {
          shipmentId: shipment.id,
          quantity,
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SHIPMENT_CREATED,
          entityType: 'Shipment',
          entityId: shipment.id,
          metadata: {
            shipmentNumber,
            orderNumber: order.orderNumber,
            deliveryMethod: dto.deliveryMethod,
            quantity,
            lines: dto.lines,
            addressSource: snapshot.source,
          },
          meta,
        },
        tx,
      );
      return shipment.id;
    });
    return this.get(id);
  }

  // ───────────────────────── edits ─────────────────────────

  /** Lock the order (root lock) then reload the shipment under it. */
  private async locked(
    tx: Tx,
    shipmentId: string,
  ): Promise<{ shipment: Shipment; order: Order }> {
    const found = await tx.shipment.findUnique({
      where: { id: shipmentId },
      select: { orderId: true },
    });
    if (!found) throw new NotFoundException('Shipment not found');
    await this.orders.lock(tx, found.orderId);
    return {
      shipment: await tx.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
      }),
      order: await tx.order.findUniqueOrThrow({ where: { id: found.orderId } }),
    };
  }

  async update(
    id: string,
    dto: UpdateShipmentDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<ShipmentResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { shipment, order } = await this.locked(tx, id);
      if (FINAL_SHIPMENT_STATUSES.includes(shipment.status))
        throw new ConflictException(
          `${shipment.shipmentNumber} is ${shipment.status} and final`,
        );
      const early = ['DRAFT', 'READY'].includes(shipment.status);
      if (!early && (dto.recipientName || dto.recipientPhone))
        throw new ConflictException(
          'The recipient can only change before dispatch',
        );
      if (dto.lines && shipment.status !== 'DRAFT')
        throw new ConflictException(
          'Quantities can only change while the shipment is DRAFT',
        );
      if (dto.assignedDeliveryUserId)
        await this.assertDeliveryUser(dto.assignedDeliveryUserId);
      if (dto.lines) {
        await this.assertAvailable(tx, order, dto.lines, id);
        await this.writeLines(tx, id, dto.lines);
      }
      const { lines: _lines, ...fields } = dto;
      const data = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(data).length)
        await tx.shipment.update({
          where: { id },
          data: data as Prisma.ShipmentUncheckedUpdateInput,
        });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SHIPMENT_UPDATED,
          entityType: 'Shipment',
          entityId: id,
          metadata: {
            shipmentNumber: shipment.shipmentNumber,
            fields: Object.keys(dto),
            ...(dto.lines && { lines: dto.lines }),
            ...(dto.assignedDeliveryUserId !== undefined && {
              assignedDeliveryUserId: {
                from: shipment.assignedDeliveryUserId,
                to: dto.assignedDeliveryUserId,
              },
            }),
          },
          meta,
        },
        tx,
      );
      await this.sync.refreshOrder(tx, order.id, actor);
    });
    return this.get(id);
  }

  // ───────────────────────── transitions ─────────────────────────

  private async assertProof(tx: Tx, assetId: string, shipmentId: string) {
    const asset = await tx.asset.findFirst({
      where: { id: assetId, archivedAt: null },
    });
    if (!asset) throw new BadRequestException('proofAssetId: asset not found');
    if (asset.type !== 'DELIVERY_PROOF')
      throw new BadRequestException(
        'proofAssetId: the file must be an asset of type DELIVERY_PROOF',
      );
    const used = await tx.shipment.findFirst({
      where: { proofAssetId: assetId, id: { not: shipmentId } },
    });
    if (used)
      throw new ConflictException(
        'This proof file belongs to another shipment',
      );
  }

  async transition(
    id: string,
    action: ShipmentAction,
    input: TransitionInput,
    actor: AuthUser,
    meta?: RequestMeta,
    opts: { assigneeOnly?: boolean } = {},
  ): Promise<ShipmentResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { shipment, order } = await this.locked(tx, id);
      // delivery staff never see drafts or other people's deliveries
      if (
        opts.assigneeOnly &&
        (shipment.assignedDeliveryUserId !== actor.id ||
          shipment.status === 'DRAFT')
      )
        throw new NotFoundException('Delivery not found');
      const check = checkShipmentTransition(action, shipment.status);
      if (!check.ok) {
        throw new ConflictException(
          `Cannot ${action.replace('-', ' ')} ${shipment.shipmentNumber}: it is ${shipment.status}`,
        );
      }
      const reason = input.reason?.trim();
      if (SHIPMENT_TRANSITIONS[action].reasonRequired && !reason)
        throw new BadRequestException(
          `A reason is required to ${action} a shipment`,
        );
      if (['dispatch', 'in-transit', 'deliver'].includes(action)) {
        if (order.status === 'ON_HOLD' || order.status === 'CANCELLED')
          throw new ConflictException(
            `${order.orderNumber} is ${order.status}`,
          );
      }
      const now = new Date();
      const data: Prisma.ShipmentUncheckedUpdateInput = { status: check.to };
      if (action === 'ready') {
        const lines = await tx.shipmentLine.findMany({
          where: { shipmentId: id },
        });
        if (lines.length === 0)
          throw new ConflictException('The shipment has no lines');
        // quantities, packaging and the destination must all still be valid
        await this.assertAvailable(
          tx,
          order,
          lines.map((l) => ({
            orderVariantId: l.orderVariantId,
            quantity: l.quantity,
          })),
          id,
        );
        data.readyAt = now;
      }
      if (action === 'dispatch') {
        const courier = input.dispatch?.courierName ?? shipment.courierName;
        if (shipment.deliveryMethod === 'COURIER' && !courier)
          throw new BadRequestException(
            'A courier name is required to dispatch a courier shipment',
          );
        if (
          shipment.deliveryMethod === 'OWN_DELIVERY' &&
          !shipment.assignedDeliveryUserId
        )
          throw new BadRequestException(
            'Assign a delivery person before dispatching',
          );
        data.dispatchedAt = shipment.dispatchedAt ?? now;
        if (input.dispatch?.courierName)
          data.courierName = input.dispatch.courierName;
        if (input.dispatch?.trackingNumber)
          data.trackingNumber = input.dispatch.trackingNumber;
        if (input.dispatch?.trackingUrl)
          data.trackingUrl = input.dispatch.trackingUrl;
        if (input.dispatch?.notes) data.deliveryNotes = input.dispatch.notes;
        data.failedAt = null;
        data.failureReason = null;
      }
      if (action === 'in-transit') data.inTransitAt = now;
      if (action === 'deliver') {
        data.deliveredAt = now;
        if (input.deliver?.notes) data.deliveryNotes = input.deliver.notes;
        if (input.deliver?.proofAssetId) {
          await this.assertProof(tx, input.deliver.proofAssetId, id);
          data.proofAssetId = input.deliver.proofAssetId;
        }
      }
      if (action === 'fail') {
        data.failedAt = now;
        data.failureReason = reason;
      }
      if (action === 'return') {
        data.returnedAt = now;
        data.returnReason = reason;
      }
      if (action === 'cancel') {
        data.cancelledAt = now;
        data.cancelReason = reason;
      }
      await tx.shipment.update({ where: { id }, data });
      await this.activity.log(
        tx,
        order.id,
        actor.id,
        ACTIVITY[action],
        `${shipment.shipmentNumber} ${action === 'in-transit' ? 'in transit' : check.to.toLowerCase()}${reason ? `: ${reason}` : ''}`,
        { shipmentId: id, action, reason: reason ?? null },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AUDIT[action],
          entityType: 'Shipment',
          entityId: id,
          metadata: {
            shipmentNumber: shipment.shipmentNumber,
            orderNumber: order.orderNumber,
            from: shipment.status,
            to: check.to,
            ...(reason && { reason }),
            ...(input.deliver?.proofAssetId && { hasProof: true }),
          },
          meta,
        },
        tx,
      );
      await this.sync.refreshOrder(tx, order.id, actor);
    });
    return this.get(id);
  }

  // ───────────────────────── delivery proof ─────────────────────────

  async uploadProof(
    id: string,
    file: UploadedFileInput | undefined,
    actor: AuthUser,
    meta: RequestMeta,
    opts: { assigneeOnly?: boolean } = {},
  ): Promise<ShipmentResponseDto> {
    const pre = await this.prisma.shipment.findUnique({ where: { id } });
    if (!pre || (opts.assigneeOnly && pre.assignedDeliveryUserId !== actor.id))
      throw new NotFoundException('Shipment not found');
    if (!['DISPATCHED', 'IN_TRANSIT'].includes(pre.status))
      throw new ConflictException(
        'Proof can be attached while the shipment is on its way',
      );
    const asset = await this.assets.upload(
      file,
      {
        type: 'DELIVERY_PROOF',
        description: `Delivery proof for ${pre.shipmentNumber}`,
      },
      actor,
      meta,
    );
    await this.prisma.$transaction(async (tx) => {
      const { shipment, order } = await this.locked(tx, id);
      if (!['DISPATCHED', 'IN_TRANSIT'].includes(shipment.status))
        throw new ConflictException(
          'Proof can be attached while the shipment is on its way',
        );
      await tx.shipment.update({
        where: { id },
        data: { proofAssetId: asset.id },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SHIPMENT_PROOF_ATTACHED,
          entityType: 'Shipment',
          entityId: id,
          metadata: {
            shipmentNumber: shipment.shipmentNumber,
            orderNumber: order.orderNumber,
            assetId: asset.id,
            replaced: !!shipment.proofAssetId,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async proofUrl(
    id: string,
    actor: AuthUser,
    opts: { assigneeOnly?: boolean } = {},
  ): Promise<DownloadUrlResponseDto> {
    const s = await this.prisma.shipment.findUnique({ where: { id } });
    if (!s || (opts.assigneeOnly && s.assignedDeliveryUserId !== actor.id))
      throw new NotFoundException('Shipment not found');
    if (!s.proofAssetId)
      throw new NotFoundException('This shipment has no delivery proof');
    return this.assets.downloadUrl(s.proofAssetId, 'attachment');
  }

  // ───────────────────────── delivery staff ─────────────────────────

  private async staffDtos(rows: Row[]): Promise<StaffDeliveryDto[]> {
    const full = await this.toDtos(rows);
    return full.map((f) => ({
      id: f.id,
      shipmentNumber: f.shipmentNumber,
      status: f.status,
      deliveryMethod: f.deliveryMethod,
      recipientName: f.recipientName,
      recipientPhone: f.recipientPhone,
      address: f.addressSnapshot,
      packages: f.lines,
      totalQuantity: f.totalQuantity,
      deliveryNotes: f.deliveryNotes,
      courierName: f.courierName,
      trackingNumber: f.trackingNumber,
      scheduledAt: f.scheduledAt,
      dispatchedAt: f.dispatchedAt,
      deliveredAt: f.deliveredAt,
      hasProof: f.hasProof,
    }));
  }

  async myDeliveries(
    actor: AuthUser,
    q: ListMyDeliveriesQueryDto,
  ): Promise<Paginated<StaffDeliveryDto>> {
    const where: Prisma.ShipmentWhereInput = {
      assignedDeliveryUserId: actor.id,
      // a delivery person never sees drafts being prepared
      status: q.status
        ? q.status
        : q.includeFinished
          ? { not: 'DRAFT' }
          : { in: ['READY', 'DISPATCHED', 'IN_TRANSIT', 'FAILED'] },
    };
    const [rows, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include,
        orderBy: [
          { scheduledAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return paginated(await this.staffDtos(rows), q.page, q.pageSize, total);
  }

  async myDelivery(id: string, actor: AuthUser): Promise<StaffDeliveryDto> {
    const row = await this.prisma.shipment.findFirst({
      where: { id, assignedDeliveryUserId: actor.id, status: { not: 'DRAFT' } },
      include,
    });
    if (!row) throw new NotFoundException('Delivery not found');
    return (await this.staffDtos([row]))[0]!;
  }

  assertAssignee(
    shipment: { assignedDeliveryUserId: string | null },
    actor: AuthUser,
  ) {
    if (shipment.assignedDeliveryUserId !== actor.id)
      throw new ForbiddenException('This delivery is not assigned to you');
  }
}
