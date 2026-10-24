import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import { toPlain } from '../../common/plain.js';
import {
  auditActor,
  type ActorRef,
  type AuthUser,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import { nextReference } from '../../database/reference-sequence.js';
import type { Order, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { FactoryJobsService } from '../factory/factory-jobs.service.js';
import { OrderActivityService } from './core/order-activity.service.js';
import { OrderSyncService } from './core/order-sync.service.js';
import { OrderTransitionsService } from './core/order-transitions.service.js';
import type {
  CreateOrderDto,
  ListOrdersQueryDto,
  OrderActivityResponseDto,
  OrderDetailDto,
  OrderItemInputDto,
  OrderListItemDto,
  OrderRevisionResponseDto,
  ReorderDto,
  ReviseOrderDto,
  UpdateOrderDto,
} from './dto/order.dto.js';
import { variantNames } from './order-lookups.js';
import {
  OrderItemsService,
  type ReferenceInfo,
} from './order-items.service.js';
import { OrderCommercialService } from './order-commercial.service.js';
import { OrderPackagingService } from './order-packaging.service.js';
import { OrderSummaryService, toJobSummary } from './order-summary.service.js';
import {
  classifyOrderRevision,
  snapshotFromRows,
  type RevisionSnapshot,
} from './pure/order-revision-impact.js';
import { progressPercent } from './pure/order-production.js';
import {
  PRODUCTION_STARTED_STATUSES,
  type OrderAction,
} from './pure/order-state-machine.js';

type Tx = Prisma.TransactionClient;

/** No further edits. */
const TERMINAL = ['CANCELLED', 'COMPLETED'];
/** Past its target date this does not count as delayed any more. */
const DONE_FOR_DELAY = ['CANCELLED', 'DELIVERED', 'COMPLETED'];

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: OrderTransitionsService,
    private readonly activity: OrderActivityService,
    private readonly sync: OrderSyncService,
    private readonly items: OrderItemsService,
    private readonly summaries: OrderSummaryService,
    private readonly jobs: FactoryJobsService,
    private readonly audit: AuditService,
    private readonly commercial: OrderCommercialService,
    private readonly packaging: OrderPackagingService,
  ) {}

  // ───────────────────────── creation ─────────────────────────

  /** The customer and brand must still be in good standing to place a bulk order. */
  private async assertParties(tx: Tx, customerId: string, brandId: string) {
    const [customer, brand] = await Promise.all([
      tx.customer.findUnique({ where: { id: customerId } }),
      tx.brand.findUnique({ where: { id: brandId } }),
    ]);
    if (!customer || customer.archivedAt || customer.status !== 'ACTIVE')
      throw new ConflictException('The customer is not active');
    if (!brand || brand.archivedAt || brand.status !== 'ACTIVE')
      throw new ConflictException('The brand is not active');
    if (brand.customerId !== customer.id)
      throw new ConflictException('The brand does not belong to the customer');
  }

  private async assertSalesUser(tx: Tx, userId: string | null | undefined) {
    if (!userId) return;
    const user = await tx.user.findFirst({
      where: { id: userId, deletedAt: null, isActive: true, status: 'ACTIVE' },
    });
    if (!user)
      throw new BadRequestException(
        'assignedSalesUserId: active staff user not found',
      );
  }

  async createFromSample(
    sampleId: string,
    dto: CreateOrderDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<OrderDetailDto> {
    const id = await this.createFor(sampleId, dto, actor, meta);
    return this.get(id);
  }

  /**
   * Shared by staff and the customer portal (customer actor): the same approved-reference, party and item
   * rules. A customer order is a DRAFT owned by that customer; staff confirmation stays a separate step.
   * Returns the new order id.
   */
  async createFor(
    sampleId: string,
    dto: CreateOrderDto,
    actor: ActorRef,
    meta?: RequestMeta,
    extra: { customerNotes?: string; preferredAddressId?: string } = {},
  ): Promise<string> {
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM samples WHERE id = ${sampleId}::uuid FOR UPDATE`;
      const sample = await tx.sample.findUnique({ where: { id: sampleId } });
      if (!sample || (actor.customer && sample.customerId !== actor.id))
        throw new NotFoundException('Sample not found');
      if (sample.archivedAt) throw new ConflictException('Sample is archived');
      if (!['APPROVED', 'COMPLETED'].includes(sample.status)) {
        throw new ConflictException(
          `A bulk order needs an approved sample (this one is ${sample.status})`,
        );
      }
      const reference = await tx.sampleProductionSpec.findFirst({
        where: { sampleId, kind: 'APPROVED_REFERENCE' },
        orderBy: { revision: 'desc' },
      });
      if (!reference) {
        throw new ConflictException(
          'The sample has no approved production reference',
        );
      }
      const ref = await this.items.reference(tx, reference.id);
      await this.assertParties(tx, sample.customerId, sample.brandId);
      await this.assertSalesUser(tx, dto.assignedSalesUserId);
      if (extra.preferredAddressId)
        await this.assertOwnAddress(
          tx,
          sample.customerId,
          extra.preferredAddressId,
        );
      if (dto.items) await this.items.validate(tx, ref, dto.items);
      const orderNumber = await nextReference(tx, 'ORD');
      const order = await tx.order.create({
        data: {
          orderNumber,
          customerId: sample.customerId,
          brandId: sample.brandId,
          sourceSampleId: sampleId,
          approvedProductionSpecId: reference.id,
          priority: dto.priority ?? 'NORMAL',
          targetDeliveryDate: dto.targetDeliveryDate,
          assignedSalesUserId:
            dto.assignedSalesUserId ?? sample.assignedSalesUserId,
          internalNotes: dto.internalNotes,
          customerNotes: extra.customerNotes,
          preferredAddressId: extra.preferredAddressId,
          createdByUserId: actor.customer ? null : actor.id,
          createdByCustomerId: actor.customer ? actor.id : null,
        },
      });
      if (dto.items) await this.items.replace(tx, order, ref, dto.items);
      await this.activity.log(
        tx,
        order.id,
        actor,
        'ORDER_CREATED',
        `${orderNumber} created from ${sample.sampleNumber}`,
        { sampleId, approvedProductionSpecId: reference.id },
      );
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.ORDER_CREATED,
          entityType: 'Order',
          entityId: order.id,
          metadata: {
            orderNumber,
            sampleNumber: sample.sampleNumber,
            approvedProductionSpecId: reference.id,
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
      return order.id;
    });
    return id;
  }

  /** A chosen delivery address must be an active address of the order's own customer. */
  private async assertOwnAddress(
    tx: Tx,
    customerId: string,
    addressId: string,
  ) {
    const address = await tx.customerAddress.findFirst({
      where: { id: addressId, customerId, archivedAt: null },
      select: { id: true },
    });
    if (!address)
      throw new BadRequestException(['preferredAddressId: address not found']);
  }

  // ───────────────────────── reads ─────────────────────────

  private async mustFind(tx: Tx | PrismaService, id: string): Promise<Order> {
    const order = await tx.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private listInclude = {
    sourceSample: { select: { sampleNumber: true, revisionNumber: true } },
    reorderOf: { select: { orderNumber: true } },
    items: { include: { variants: { select: { quantity: true } } } },
  } satisfies Prisma.OrderInclude;

  private async parties(rows: { customerId: string; brandId: string }[]) {
    const [customers, brands] = await Promise.all([
      this.prisma.customer.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.customerId))] } },
        select: { id: true, displayName: true, customerNumber: true },
      }),
      this.prisma.brand.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.brandId))] } },
        select: { id: true, name: true, brandNumber: true },
      }),
    ]);
    return {
      customers: new Map(customers.map((c) => [c.id, c])),
      brands: new Map(brands.map((b) => [b.id, b])),
    };
  }

  private async listItems(
    rows: Prisma.OrderGetPayload<{ include: OrdersService['listInclude'] }>[],
  ): Promise<OrderListItemDto[]> {
    const now = new Date();
    const p = await this.parties(rows);
    const jobs = await this.prisma.factoryJob.findMany({
      where: {
        orderId: { in: rows.map((r) => r.id) },
        status: { not: 'CANCELLED' },
      },
      select: {
        orderId: true,
        completedQuantity: true,
        rejectedQuantity: true,
        stages: {
          where: {
            supersededAt: null,
            status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
            dueAt: { lt: now },
          },
          select: { id: true },
        },
      },
    });
    return rows.map((o) => {
      const total = o.items.reduce(
        (s, i) => s + i.variants.reduce((x, v) => x + v.quantity, 0),
        0,
      );
      const own = jobs.filter((j) => j.orderId === o.id);
      const completed = own.reduce((s, j) => s + j.completedQuantity, 0);
      const rejected = own.reduce((s, j) => s + j.rejectedQuantity, 0);
      const customer = p.customers.get(o.customerId);
      const brand = p.brands.get(o.brandId);
      const pastTarget =
        !!o.targetDeliveryDate &&
        o.targetDeliveryDate < now &&
        !DONE_FOR_DELAY.includes(o.status);
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        priority: o.priority,
        customer: {
          id: o.customerId,
          name: customer?.displayName ?? '',
          number: customer?.customerNumber ?? null,
        },
        brand: {
          id: o.brandId,
          name: brand?.name ?? '',
          number: brand?.brandNumber ?? null,
        },
        sampleNumber: o.sourceSample.sampleNumber,
        reorderOfOrderNumber: o.reorderOf?.orderNumber ?? null,
        totalQuantity: total,
        completedQuantity: completed,
        rejectedQuantity: rejected,
        progressPercent: progressPercent({
          totalQuantity: total,
          completedQuantity: completed,
          rejectedQuantity: rejected,
        }),
        revisionNumber: o.revisionNumber,
        targetDeliveryDate: o.targetDeliveryDate,
        assignedSalesUserId: o.assignedSalesUserId,
        isDelayed: pastTarget || own.some((j) => j.stages.length > 0),
        paymentState: o.paymentState,
        createdAt: o.createdAt,
      };
    });
  }

  async list(q: ListOrdersQueryDto): Promise<Paginated<OrderListItemDto>> {
    const now = new Date();
    const and: Prisma.OrderWhereInput[] = [{ archivedAt: null }];
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.assignedSalesUserId)
      and.push({ assignedSalesUserId: q.assignedSalesUserId });
    if (q.priority) and.push({ priority: q.priority });
    if (q.customerId) and.push({ customerId: q.customerId });
    if (q.brandId) and.push({ brandId: q.brandId });
    if (q.sourceSampleId) and.push({ sourceSampleId: q.sourceSampleId });
    if (q.createdFrom) and.push({ createdAt: { gte: q.createdFrom } });
    if (q.createdTo) and.push({ createdAt: { lte: q.createdTo } });
    if (q.targetBefore)
      and.push({ targetDeliveryDate: { lte: q.targetBefore } });
    if (q.readyForDelivery) and.push({ status: 'READY_FOR_DELIVERY' });
    if (q.delivered) and.push({ status: { in: ['DELIVERED', 'COMPLETED'] } });
    if (q.shipmentStatus)
      and.push({ shipments: { some: { status: q.shipmentStatus } } });
    if (q.paymentState) and.push({ paymentState: q.paymentState });
    if (q.packagingComplete !== undefined) {
      const packed = [
        'READY_FOR_DELIVERY',
        'PARTIALLY_SHIPPED',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'COMPLETED',
      ] as const;
      const unpacked = [
        'READY_FOR_PRODUCTION',
        'IN_PRODUCTION',
        'PARTIALLY_COMPLETED',
        'PRODUCTION_COMPLETED',
        'READY_FOR_PACKAGING',
        'PACKAGING',
      ] as const;
      and.push({
        status: { in: [...(q.packagingComplete ? packed : unpacked)] },
      });
    }
    if (q.productionStatus === 'NOT_STARTED')
      and.push({
        status: {
          in: [
            'DRAFT',
            'PENDING_CONFIRMATION',
            'CONFIRMED',
            'READY_FOR_PRODUCTION',
          ],
        },
      });
    if (q.productionStatus === 'IN_PRODUCTION')
      and.push({
        status: {
          in: [
            'IN_PRODUCTION',
            'PARTIALLY_COMPLETED',
            'READY_FOR_PACKAGING',
            'PACKAGING',
          ],
        },
      });
    if (q.productionStatus === 'COMPLETED')
      and.push({
        status: {
          in: [
            'PRODUCTION_COMPLETED',
            'READY_FOR_DELIVERY',
            'PARTIALLY_SHIPPED',
            'OUT_FOR_DELIVERY',
            'DELIVERED',
            'COMPLETED',
          ],
        },
      });
    if (q.delayed) {
      and.push({
        status: { notIn: ['CANCELLED', 'DELIVERED', 'COMPLETED'] },
        OR: [
          { targetDeliveryDate: { lt: now } },
          {
            jobs: {
              some: {
                status: { notIn: ['CANCELLED', 'COMPLETED'] },
                stages: {
                  some: {
                    supersededAt: null,
                    status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
                    dueAt: { lt: now },
                  },
                },
              },
            },
          },
        ],
      });
    }
    const search = q.search?.trim();
    if (search) {
      const [customers, brands] = await Promise.all([
        this.prisma.customer.findMany({
          where: {
            OR: [
              { displayName: { contains: search, mode: 'insensitive' } },
              { customerNumber: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { whatsapp: { contains: search } },
            ],
          },
          select: { id: true },
          take: 200,
        }),
        this.prisma.brand.findMany({
          where: { name: { contains: search, mode: 'insensitive' } },
          select: { id: true },
          take: 200,
        }),
      ]);
      and.push({
        OR: [
          { orderNumber: { contains: search, mode: 'insensitive' } },
          {
            sourceSample: {
              sampleNumber: { contains: search, mode: 'insensitive' },
            },
          },
          { customerId: { in: customers.map((c) => c.id) } },
          { brandId: { in: brands.map((b) => b.id) } },
        ],
      });
    }
    const where: Prisma.OrderWhereInput = { AND: and };
    const orderBy: Prisma.OrderOrderByWithRelationInput[] =
      q.sort === 'oldest'
        ? [{ createdAt: 'asc' }]
        : q.sort === 'target'
          ? [
              { targetDeliveryDate: { sort: 'asc', nulls: 'last' } },
              { createdAt: 'asc' },
            ]
          : q.sort === 'priority'
            ? [{ priority: 'desc' }, { createdAt: 'asc' }]
            : q.sort === 'orderNumber'
              ? [{ orderNumber: 'asc' }]
              : [{ createdAt: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: [...orderBy, { id: 'asc' }],
        skip: q.skip,
        take: q.pageSize,
        include: this.listInclude,
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginated(await this.listItems(rows), q.page, q.pageSize, total);
  }

  async get(id: string, actor?: AuthUser): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        ...this.listInclude,
        approvedSpec: true,
        specs: { orderBy: { revision: 'desc' }, take: 1 },
        batches: {
          include: { allocations: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const [listItem] = await this.listItems([order]);
    const rows = await this.prisma.orderItem.findMany({
      where: { orderId: id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        variants: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    const allVariants = rows.flatMap((i) => i.variants);
    const names = await variantNames(this.prisma, allVariants);
    const allocated = await this.prisma.orderBatchVariant.groupBy({
      by: ['orderVariantId'],
      where: {
        orderVariantId: { in: allVariants.map((v) => v.id) },
        batch: { status: { not: 'CANCELLED' } },
      },
      _sum: { quantity: true },
    });
    const allocatedBy = new Map(
      allocated.map((a) => [a.orderVariantId, a._sum.quantity ?? 0]),
    );
    const sizeIds = [
      ...new Set(
        allVariants.map((v) => v.sizeOptionId).filter((x): x is string => !!x),
      ),
    ];
    const colorIds = [
      ...new Set(
        allVariants.map((v) => v.fabricColorId).filter((x): x is string => !!x),
      ),
    ];
    const [sizes, colors, jobs, summary, activities, builtBy] =
      await Promise.all([
        this.prisma.sizeOption.findMany({
          where: { id: { in: sizeIds } },
          select: { id: true, name: true },
        }),
        this.prisma.fabricColor.findMany({
          where: { id: { in: colorIds } },
          select: { id: true, name: true },
        }),
        this.prisma.factoryJob.findMany({
          where: { orderId: id },
          include: { orderBatch: { select: { batchNumber: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.summaries.build(id),
        this.recentActivities(id, 20),
        order.approvedSpec.sourceFactoryJobId
          ? this.prisma.factoryJob.findUnique({
              where: { id: order.approvedSpec.sourceFactoryJobId },
              select: { jobNumber: true },
            })
          : null,
      ]);
    const sizeName = new Map(sizes.map((s) => [s.id, s.name]));
    const colorName = new Map(colors.map((c) => [c.id, c.name]));
    const spec = order.specs[0];
    const [shipments, figures, tracking, packagingSpec, commercial] =
      await Promise.all([
        this.prisma.shipment.findMany({
          where: { orderId: id },
          include: { lines: { select: { quantity: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.packaging.figures(this.prisma, id),
        this.prisma.orderTrackingToken.findFirst({
          where: { orderId: id, revokedAt: null },
          select: { expiresAt: true },
        }),
        this.prisma.orderPackagingSpec.count({ where: { orderId: id } }),
        actor?.permissions.has('orders.commercial.read')
          ? this.commercial.summary(id)
          : undefined,
      ]);
    const shipped = (statuses: string[]) =>
      shipments
        .filter((sh) => statuses.includes(sh.status))
        .reduce(
          (sum, sh) => sum + sh.lines.reduce((x, l) => x + l.quantity, 0),
          0,
        );
    const delivered = shipped(['DELIVERED']);

    return Object.assign(toPlain(listItem), {
      sourceSampleId: order.sourceSampleId,
      sampleRevision: order.sourceSample.revisionNumber,
      approvedReference: {
        id: order.approvedSpec.id,
        revision: order.approvedSpec.revision,
        kind: order.approvedSpec.kind,
        specHash: order.approvedSpec.specHash,
        sourceFactoryJobId: order.approvedSpec.sourceFactoryJobId,
        sourceFactoryJobNumber: builtBy?.jobNumber ?? null,
        createdAt: order.approvedSpec.createdAt,
      },
      currentSpec: spec
        ? {
            id: spec.id,
            revision: spec.revision,
            totalQuantity: spec.totalQuantity,
            specHash: spec.specHash,
            createdAt: spec.createdAt,
          }
        : null,
      reorderOfOrderId: order.reorderOfOrderId,
      confirmedAt: order.confirmedAt,
      productionStartDate: order.productionStartDate,
      completedAt: order.completedAt,
      deliveredAt: order.deliveredAt,
      closedAt: order.closedAt,
      cancelledAt: order.cancelledAt,
      cancellationReason: order.cancellationReason,
      holdReason: order.holdReason,
      internalNotes: order.internalNotes,
      items: rows.map((i) => ({
        id: i.id,
        productName: i.productNameSnapshot,
        productTypeId: i.productTypeId,
        quantity: i.quantity,
        variantTotal: i.variants.reduce((s, v) => s + v.quantity, 0),
        notes: i.notes,
        variants: i.variants.map((v) => ({
          id: v.id,
          sizeOptionId: v.sizeOptionId,
          sizeName: v.sizeOptionId
            ? (sizeName.get(v.sizeOptionId) ?? null)
            : null,
          customSizeName: v.customSizeName,
          fabricColorId: v.fabricColorId,
          colorName: v.fabricColorId
            ? (colorName.get(v.fabricColorId) ?? null)
            : null,
          customColorName: v.customColorName,
          pantone: v.pantone,
          hex: v.hex,
          quantity: v.quantity,
          completedQuantity: v.completedQuantity,
          rejectedQuantity: v.rejectedQuantity,
          allocatedQuantity: allocatedBy.get(v.id) ?? 0,
          notes: v.notes,
          label: names.get(v.id)?.label,
        })),
      })),
      batches: summary.batches,
      factoryJobs: jobs.map(toJobSummary),
      productionSummary: summary,
      fulfillment: {
        deliveredQuantity: delivered,
        inFlightQuantity: shipped(['DISPATCHED', 'IN_TRANSIT']),
        shippableQuantity: figures.shippableQuantity,
        remainingDeliveryQuantity: Math.max(
          0,
          summary.totalQuantity - summary.rejectedQuantity - delivered,
        ),
        packagingDefined: packagingSpec > 0,
        packedQuantity: figures.packedQuantity,
        packagingComplete:
          figures.completedQuantity > 0 &&
          figures.packedQuantity >= figures.completedQuantity,
        trackingEnabled:
          !!tracking &&
          (!tracking.expiresAt || tracking.expiresAt > new Date()),
      },
      shipments: shipments.map((sh) => ({
        id: sh.id,
        shipmentNumber: sh.shipmentNumber,
        status: sh.status,
        quantity: sh.lines.reduce((x, l) => x + l.quantity, 0),
        dispatchedAt: sh.dispatchedAt,
        deliveredAt: sh.deliveredAt,
      })),
      ...(commercial && { commercial }),
      recentActivities: activities,
    }) as OrderDetailDto;
  }

  private async recentActivities(orderId: string, take: number) {
    const rows = await this.prisma.orderActivity.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return this.mapActivities(rows);
  }

  private async mapActivities(
    rows: Prisma.OrderActivityGetPayload<object>[],
  ): Promise<OrderActivityResponseDto[]> {
    const users = await this.prisma.user.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              rows.map((r) => r.actorUserId).filter((x): x is string => !!x),
            ),
          ],
        },
      },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((a) => ({
      id: a.id,
      type: a.type,
      message: a.message,
      actorUserId: a.actorUserId,
      actorName: a.actorUserId ? (names.get(a.actorUserId) ?? null) : null,
      metadata: (a.metadata as Record<string, unknown> | null) ?? null,
      createdAt: a.createdAt,
    }));
  }

  async activities(
    id: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<OrderActivityResponseDto>> {
    await this.mustFind(this.prisma, id);
    const [rows, total] = await Promise.all([
      this.prisma.orderActivity.findMany({
        where: { orderId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.orderActivity.count({ where: { orderId: id } }),
    ]);
    return paginated(await this.mapActivities(rows), page, pageSize, total);
  }

  async revisions(id: string): Promise<OrderRevisionResponseDto[]> {
    await this.mustFind(this.prisma, id);
    const rows = await this.prisma.orderRevision.findMany({
      where: { orderId: id },
      orderBy: { revisionNumber: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      revisionNumber: r.revisionNumber,
      reason: r.reason,
      previousSnapshot: r.previousSnapshot as Record<string, unknown>,
      specId: r.specId,
      createdByUserId: r.createdByUserId,
      commercialImpact: r.commercialImpact,
      commercialChanges: (r.commercialChanges as string[] | null) ?? [],
      createdAt: r.createdAt,
    }));
  }

  async productionSpecs(id: string) {
    await this.mustFind(this.prisma, id);
    const rows = await this.prisma.orderProductionSpec.findMany({
      where: { orderId: id },
      orderBy: { revision: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      revision: s.revision,
      approvedProductionSpecId: s.approvedProductionSpecId,
      totalQuantity: s.totalQuantity,
      specHash: s.specHash,
      snapshot: s.snapshot as Record<string, unknown>,
      createdAt: s.createdAt,
    }));
  }

  productionSummary(id: string) {
    return this.summaries.build(id);
  }

  // ───────────────────────── edits ─────────────────────────

  async update(
    id: string,
    dto: UpdateOrderDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      if (TERMINAL.includes(order.status))
        throw new ConflictException(`${order.orderNumber} is ${order.status}`);
      await this.assertSalesUser(tx, dto.assignedSalesUserId);
      const data: Prisma.OrderUncheckedUpdateInput = {};
      if (dto.targetDeliveryDate !== undefined)
        data.targetDeliveryDate = dto.targetDeliveryDate;
      if (dto.assignedSalesUserId !== undefined)
        data.assignedSalesUserId = dto.assignedSalesUserId;
      if (dto.internalNotes !== undefined)
        data.internalNotes = dto.internalNotes;
      if (Object.keys(data).length === 0) return;
      await tx.order.update({ where: { id }, data });
      await this.activity.log(
        tx,
        id,
        actor.id,
        'ORDER_UPDATED',
        `${order.orderNumber} details updated`,
        {
          fields: Object.keys(data),
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_UPDATED,
          entityType: 'Order',
          entityId: id,
          metadata: {
            orderNumber: order.orderNumber,
            changed: Object.keys(data),
            ...(dto.targetDeliveryDate !== undefined && {
              targetDeliveryDate: {
                from: order.targetDeliveryDate,
                to: dto.targetDeliveryDate,
              },
            }),
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  private itemTotals(
    items: { quantity: number; variants: { quantity: number }[] }[],
  ) {
    return {
      itemQuantity: items.reduce((s, i) => s + i.quantity, 0),
      variantQuantity: items.reduce(
        (s, i) => s + i.variants.reduce((x, v) => x + v.quantity, 0),
        0,
      ),
      variants: items.reduce((s, i) => s + i.variants.length, 0),
    };
  }

  async replaceItems(
    id: string,
    items: OrderItemInputDto[],
    actor: ActorRef,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      if (order.status !== 'DRAFT') {
        throw new ConflictException(
          `Items can only be replaced while the order is DRAFT (${order.orderNumber} is ${order.status}); confirmed orders are revised`,
        );
      }
      const ref = await this.items.reference(
        tx,
        order.approvedProductionSpecId,
      );
      await this.items.validate(tx, ref, items);
      const rowsBefore = await this.items.loadItems(tx, id);
      const before = this.itemTotals(rowsBefore);
      await this.items.replace(tx, order, ref, items);
      const rowsAfter = await this.items.loadItems(tx, id);
      const after = this.itemTotals(rowsAfter);
      // Quoted before the items changed? The same classification as a confirmed-order revision.
      const impact = classifyOrderRevision(
        snapshotFromRows(order.approvedProductionSpecId, rowsBefore),
        snapshotFromRows(order.approvedProductionSpecId, rowsAfter),
      );
      if (impact.commercial)
        await this.endCommercialValidity(
          tx,
          order,
          order.revisionNumber,
          impact.reasons,
          actor,
          meta,
        );
      await this.activity.log(
        tx,
        id,
        actor,
        'ORDER_UPDATED',
        `${order.orderNumber} items updated`,
        { before, after },
      );
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.ORDER_ITEMS_CHANGED,
          entityType: 'Order',
          entityId: id,
          metadata: { orderNumber: order.orderNumber, before, after },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async changePriority(
    id: string,
    priority: Order['priority'],
    reason: string | undefined,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      if (TERMINAL.includes(order.status))
        throw new ConflictException(`${order.orderNumber} is ${order.status}`);
      if (order.priority === priority) return;
      await tx.order.update({ where: { id }, data: { priority } });
      // Factory jobs inherit the order's priority when it changes.
      const live = await tx.factoryJob.findMany({
        where: { orderId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        select: { id: true },
      });
      for (const job of live) {
        await tx.factoryJob.update({
          where: { id: job.id },
          data: { priority },
        });
        await tx.jobActivity.create({
          data: {
            jobId: job.id,
            actorUserId: actor.id,
            type: 'PRIORITY_CHANGED',
            message: `Priority ${order.priority} → ${priority} (from ${order.orderNumber})`,
            metadata: { from: order.priority, to: priority, reason },
          },
        });
      }
      await this.activity.log(
        tx,
        id,
        actor.id,
        'PRIORITY_CHANGED',
        `Priority ${order.priority} → ${priority}`,
        {
          from: order.priority,
          to: priority,
          reason,
          jobsUpdated: live.length,
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_PRIORITY_CHANGED,
          entityType: 'Order',
          entityId: id,
          metadata: {
            orderNumber: order.orderNumber,
            from: order.priority,
            to: priority,
            reason,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  private async run(
    id: string,
    action: OrderAction,
    actor: AuthUser,
    meta: RequestMeta | undefined,
    audit: string | null,
    reason?: string,
    before?: (tx: Tx, order: Order) => Promise<void>,
    after?: (tx: Tx, order: Order) => Promise<void>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      await before?.(tx, order);
      const updated = await this.transitions.apply(tx, id, action, {
        actor,
        reason,
      });
      await after?.(tx, updated);
      if (audit) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: audit,
            entityType: 'Order',
            entityId: id,
            metadata: {
              orderNumber: order.orderNumber,
              from: order.status,
              to: updated.status,
              ...(reason && { reason }),
            },
            meta,
          },
          tx,
        );
      }
    });
    return this.get(id);
  }

  submit(id: string, actor: AuthUser, meta?: RequestMeta) {
    return this.run(id, 'submit', actor, meta, AuditAction.ORDER_SUBMITTED);
  }

  /**
   * The customer hands a DRAFT to Benue Print. Completeness is verified from the stored rows (variants must
   * add up to the item quantity) before the normal `submit` transition; confirmation stays staff-only.
   */
  async submitFor(
    id: string,
    actor: ActorRef,
    meta?: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      if (actor.customer && order.customerId !== actor.id)
        throw new NotFoundException('Order not found');
      if (order.status !== 'DRAFT')
        throw new ConflictException(
          `${order.orderNumber} is ${order.status} and cannot be submitted`,
        );
      this.items.assertConfirmable(await this.items.loadItems(tx, id));
      await this.transitions.apply(tx, id, 'submit', { actor });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.ORDER_SUBMITTED,
          entityType: 'Order',
          entityId: id,
          metadata: {
            orderNumber: order.orderNumber,
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
    });
  }

  /**
   * Customer-editable order details while it is still a DRAFT. Nothing commercial or internal can be
   * set here; items go through `replaceItems`.
   */
  async updateDraftDetails(
    id: string,
    changes: {
      targetDeliveryDate?: Date | null;
      customerNotes?: string | null;
      preferredAddressId?: string | null;
    },
    actor: ActorRef,
    meta?: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      if (actor.customer && order.customerId !== actor.id)
        throw new NotFoundException('Order not found');
      if (order.status !== 'DRAFT')
        throw new ConflictException(
          `${order.orderNumber} has been submitted and can no longer be edited`,
        );
      if (changes.preferredAddressId)
        await this.assertOwnAddress(
          tx,
          order.customerId,
          changes.preferredAddressId,
        );
      const data: Prisma.OrderUncheckedUpdateInput = {};
      if (changes.targetDeliveryDate !== undefined)
        data.targetDeliveryDate = changes.targetDeliveryDate;
      if (changes.customerNotes !== undefined)
        data.customerNotes = changes.customerNotes;
      if (changes.preferredAddressId !== undefined)
        data.preferredAddressId = changes.preferredAddressId;
      if (Object.keys(data).length === 0) return;
      await tx.order.update({ where: { id }, data });
      await this.activity.log(
        tx,
        id,
        actor,
        'ORDER_UPDATED',
        `${order.orderNumber} details updated`,
        { fields: Object.keys(data) },
      );
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.ORDER_UPDATED,
          entityType: 'Order',
          entityId: id,
          metadata: {
            orderNumber: order.orderNumber,
            changed: Object.keys(data),
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
    });
  }

  requestChanges(
    id: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    return this.run(
      id,
      'request-changes',
      actor,
      meta,
      AuditAction.ORDER_UPDATED,
      reason,
    );
  }

  async confirm(id: string, actor: AuthUser, meta?: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      if (!['DRAFT', 'PENDING_CONFIRMATION'].includes(order.status)) {
        throw new ConflictException(
          `Cannot confirm an order that is ${order.status}`,
        );
      }
      const ref = await this.items.reference(
        tx,
        order.approvedProductionSpecId,
      );
      await this.assertParties(tx, order.customerId, order.brandId);
      const rows = await this.items.loadItems(tx, id);
      const spec = await this.items.freeze(tx, order, ref, rows, actor);
      await tx.order.update({
        where: { id },
        data: { currentSpecId: spec.id, revisionNumber: spec.revision },
      });
      await this.transitions.apply(tx, id, 'confirm', {
        actor,
        message: `${order.orderNumber} confirmed (${spec.totalQuantity} units); production specification frozen`,
        metadata: {
          orderProductionSpecId: spec.id,
          totalQuantity: spec.totalQuantity,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_CONFIRMED,
          entityType: 'Order',
          entityId: id,
          metadata: {
            orderNumber: order.orderNumber,
            orderProductionSpecId: spec.id,
            revision: spec.revision,
            specHash: spec.specHash,
            totalQuantity: spec.totalQuantity,
            approvedProductionSpecId: ref.spec.id,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async markReady(id: string, actor: AuthUser, meta?: RequestMeta) {
    return this.run(
      id,
      'mark-ready',
      actor,
      meta,
      AuditAction.ORDER_MARKED_READY,
      undefined,
      async (tx, order) => {
        if (!order.currentSpecId)
          throw new ConflictException(
            'The order has no frozen production specification',
          );
        await this.items.reference(tx, order.approvedProductionSpecId);
        // commercial gate: accepted quotation + the configured share of it verified
        await this.commercial.assertReleasable(tx, order);
      },
    );
  }

  /**
   * Close a fully delivered order. Delivered means every deliverable unit was delivered; closing
   * additionally needs no open shipment and, when a quotation was accepted, full payment.
   */
  async complete(id: string, actor: AuthUser, meta?: RequestMeta) {
    return this.run(
      id,
      'complete',
      actor,
      meta,
      AuditAction.ORDER_COMPLETED,
      undefined,
      async (tx, order) => {
        const open = await tx.shipment.count({
          where: {
            orderId: id,
            status: {
              in: ['DRAFT', 'READY', 'DISPATCHED', 'IN_TRANSIT', 'FAILED'],
            },
          },
        });
        if (open > 0)
          throw new ConflictException(
            `${order.orderNumber} still has ${open} open shipment(s)`,
          );
        const accepted = await tx.quotationVersion.count({
          where: { status: 'ACCEPTED', quotation: { orderId: id } },
        });
        if (accepted > 0 && order.paymentState !== 'PAID')
          throw new ConflictException(
            `${order.orderNumber} is not fully paid (${order.paymentState}); finish the payments or use the override`,
          );
      },
    );
  }

  /** Admin override for orders that did not follow the normal path; reason mandatory, audited. */
  forceComplete(
    id: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    return this.run(
      id,
      'force-complete',
      actor,
      meta,
      AuditAction.ORDER_FORCE_COMPLETED,
      reason,
    );
  }

  hold(id: string, reason: string, actor: AuthUser, meta?: RequestMeta) {
    return this.run(id, 'hold', actor, meta, AuditAction.ORDER_HELD, reason);
  }

  resume(id: string, actor: AuthUser, meta?: RequestMeta) {
    return this.run(
      id,
      'resume',
      actor,
      meta,
      AuditAction.ORDER_RESUMED,
      undefined,
      undefined,
      async (tx, order) => {
        // production state may have moved while the order was held
        await this.sync.refreshOrder(tx, order.id, actor);
      },
    );
  }

  /** Cancelling never deletes production history: live jobs and batches are cancelled, everything stays on record. */
  cancel(id: string, reason: string, actor: AuthUser, meta?: RequestMeta) {
    return this.run(
      id,
      'cancel',
      actor,
      meta,
      AuditAction.ORDER_CANCELLED,
      reason,
      async (tx, order) => {
        if (order.status === 'CANCELLED') return;
        const shipped = await tx.shipment.count({
          where: {
            orderId: id,
            status: { in: ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED'] },
          },
        });
        if (shipped > 0)
          throw new ConflictException(
            `${order.orderNumber} has shipments that left the building; resolve them (deliver or return) before cancelling`,
          );
        await tx.shipment.updateMany({
          where: { orderId: id, status: { in: ['DRAFT', 'READY'] } },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: `Order cancelled: ${reason}`,
          },
        });
        const live = await tx.factoryJob.findMany({
          where: { orderId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          select: { id: true },
        });
        for (const job of live) {
          await this.jobs.cancelInTx(
            tx,
            job.id,
            `Order ${order.orderNumber} cancelled: ${reason}`,
            actor,
            meta,
          );
        }
        const now = new Date();
        await tx.orderBatch.updateMany({
          where: { orderId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancelReason: `Order cancelled: ${reason}`,
          },
        });
      },
    );
  }

  // ───────────────────────── revision ─────────────────────────

  async revise(
    id: string,
    dto: ReviseOrderDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, id);
      const order = await this.mustFind(tx, id);
      if (
        ![
          'CONFIRMED',
          'READY_FOR_PRODUCTION',
          'IN_PRODUCTION',
          'PARTIALLY_COMPLETED',
          'PRODUCTION_COMPLETED',
          'READY_FOR_PACKAGING',
          'PACKAGING',
          'READY_FOR_DELIVERY',
          'PARTIALLY_SHIPPED',
          'OUT_FOR_DELIVERY',
        ].includes(order.status)
      ) {
        throw new ConflictException(
          order.status === 'ON_HOLD'
            ? 'Resume the order before revising it'
            : `A ${order.status} order cannot be revised${order.status === 'DRAFT' || order.status === 'PENDING_CONFIRMATION' ? ' (edit it directly)' : ''}`,
        );
      }
      if (!order.currentSpecId)
        throw new ConflictException(
          'The order has no frozen production specification',
        );
      const changesItems = dto.items !== undefined;
      if (changesItems) {
        if (PRODUCTION_STARTED_STATUSES.includes(order.status)) {
          throw new ConflictException(
            'Production has started: quantities and variants are locked. Only the target date and notes can be revised.',
          );
        }
        const live = await tx.factoryJob.count({
          where: { orderId: id, status: { not: 'CANCELLED' } },
        });
        const batches = await tx.orderBatch.count({
          where: { orderId: id, status: { not: 'CANCELLED' } },
        });
        if (live > 0 || batches > 0) {
          throw new ConflictException(
            'The order already has batches or factory jobs; cancel them before changing quantities or variants',
          );
        }
      }
      if (
        !changesItems &&
        dto.targetDeliveryDate === undefined &&
        dto.internalNotes === undefined
      ) {
        throw new BadRequestException('Nothing to revise');
      }
      const current = await tx.orderProductionSpec.findUniqueOrThrow({
        where: { id: order.currentSpecId },
      });
      const ref = await this.items.reference(
        tx,
        order.approvedProductionSpecId,
      );
      if (changesItems) {
        await this.items.validate(tx, ref, dto.items!);
        await this.items.replace(tx, order, ref, dto.items!);
      }
      const header: Prisma.OrderUncheckedUpdateInput = {};
      if (dto.targetDeliveryDate !== undefined)
        header.targetDeliveryDate = dto.targetDeliveryDate;
      if (dto.internalNotes !== undefined)
        header.internalNotes = dto.internalNotes;
      const updatedOrder = Object.keys(header).length
        ? await tx.order.update({ where: { id }, data: header })
        : order;
      const rows = await this.items.loadItems(tx, id);
      const spec = await this.items.freeze(tx, updatedOrder, ref, rows, actor);
      const impact = classifyOrderRevision(
        current.snapshot as RevisionSnapshot,
        spec.snapshot as RevisionSnapshot,
      );
      await tx.orderRevision.create({
        data: {
          orderId: id,
          revisionNumber: spec.revision,
          reason: dto.reason,
          previousSnapshot: current.snapshot as Prisma.InputJsonValue,
          specId: spec.id,
          createdByUserId: actor.id,
          commercialImpact: impact.commercial,
          commercialChanges: impact.commercial ? impact.reasons : undefined,
        },
      });
      await tx.order.update({
        where: { id },
        data: { currentSpecId: spec.id, revisionNumber: spec.revision },
      });
      if (impact.commercial)
        await this.endCommercialValidity(
          tx,
          order,
          spec.revision,
          impact.reasons,
          actor,
          meta,
        );
      await this.activity.log(
        tx,
        id,
        actor.id,
        'ORDER_REVISED',
        `${order.orderNumber} revised to revision ${spec.revision}: ${dto.reason}`,
        {
          revision: spec.revision,
          reason: dto.reason,
          itemsChanged: changesItems,
          commercialImpact: impact.commercial,
          quantity: { from: current.totalQuantity, to: spec.totalQuantity },
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_REVISED,
          entityType: 'Order',
          entityId: id,
          metadata: {
            orderNumber: order.orderNumber,
            revision: spec.revision,
            reason: dto.reason,
            itemsChanged: changesItems,
            commercialImpact: impact.commercial,
            totalQuantity: {
              from: current.totalQuantity,
              to: spec.totalQuantity,
            },
            specHash: spec.specHash,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * The revision changed what the customer was quoted for: the quotation in force no longer applies.
   * Runs inside the revise transaction under the order lock, so it cannot interleave with a
   * quotation decision, a payment verification or `mark-ready`.
   */
  private async endCommercialValidity(
    tx: Prisma.TransactionClient,
    order: Order,
    revision: number,
    reasons: string[],
    actor: ActorRef,
    meta?: RequestMeta,
  ) {
    const ended = await this.commercial.invalidateForRevision(
      tx,
      order,
      revision,
      reasons,
    );
    if (ended.length === 0) return;
    const hadAccepted = ended.some((v) => v.status === 'ACCEPTED');
    const message = `${order.orderNumber} revision ${revision} changed commercial terms (${reasons.join('; ')}): ${ended.map((v) => `${v.quotation.quotationNumber} v${v.versionNumber}`).join(', ')} no longer apply; a new quotation must be accepted`;
    const metadata = {
      revision,
      reasons,
      endedVersionIds: ended.map((v) => v.id),
      hadAcceptedQuotation: hadAccepted,
    };
    const gate = await this.commercial.gate(tx, order.id);
    if (order.status === 'READY_FOR_PRODUCTION' && !gate.satisfied) {
      // released on the old quotation: pull it back until the new one is accepted
      await this.transitions.apply(tx, order.id, 'commercial-reapproval', {
        actor,
        message,
        metadata,
      });
    } else {
      await this.activity.log(
        tx,
        order.id,
        actor,
        'COMMERCIAL_REAPPROVAL_REQUIRED',
        message,
        metadata,
      );
    }
    for (const v of ended) {
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.QUOTATION_VERSION_INVALIDATED,
          entityType: 'QuotationVersion',
          entityId: v.id,
          metadata: {
            quotationNumber: v.quotation.quotationNumber,
            versionNumber: v.versionNumber,
            wasStatus: v.status,
            orderId: order.id,
            invalidatedByRevision: revision,
          },
          meta,
        },
        tx,
      );
    }
    await this.audit.record(
      {
        ...auditActor(actor),
        action: AuditAction.ORDER_COMMERCIAL_REAPPROVAL_REQUIRED,
        entityType: 'Order',
        entityId: order.id,
        metadata: { orderNumber: order.orderNumber, ...metadata },
        meta,
      },
      tx,
    );
  }

  // ───────────────────────── reorder ─────────────────────────

  /**
   * A reorder is a NEW draft that pins the same approved reference. It never copies jobs, QC,
   * payments, batches or reports. Anything that would change the product (fabric, construction,
   * fit, pattern, print method, artwork) is not part of the order API: it needs a new sample.
   */
  async reorder(
    id: string,
    dto: ReorderDto,
    actor: ActorRef,
    meta?: RequestMeta,
    extra: { customerNotes?: string } = {},
  ) {
    const newId = await this.prisma.$transaction(async (tx) => {
      const source = await this.mustFind(tx, id);
      if (actor.customer && source.customerId !== actor.id)
        throw new NotFoundException('Order not found');
      if (!source.currentSpecId)
        throw new ConflictException(
          `${source.orderNumber} was never confirmed; only a confirmed order can be reordered`,
        );
      const ref = await this.items.reference(
        tx,
        source.approvedProductionSpecId,
      );
      await this.assertParties(tx, source.customerId, source.brandId);
      const orderNumber = await nextReference(tx, 'ORD');
      const order = await tx.order.create({
        data: {
          orderNumber,
          customerId: source.customerId,
          brandId: source.brandId,
          sourceSampleId: source.sourceSampleId,
          approvedProductionSpecId: source.approvedProductionSpecId,
          reorderOfOrderId: source.id,
          priority: dto.priority ?? source.priority,
          targetDeliveryDate: dto.targetDeliveryDate,
          assignedSalesUserId: source.assignedSalesUserId,
          internalNotes: dto.internalNotes,
          customerNotes: extra.customerNotes,
          createdByUserId: actor.customer ? null : actor.id,
          createdByCustomerId: actor.customer ? actor.id : null,
        },
      });
      if (dto.cloneItems !== false) {
        const rows = await this.items.loadItems(tx, source.id);
        const input: OrderItemInputDto[] = rows.map((i) => ({
          quantity: i.quantity,
          notes: i.notes ?? undefined,
          variants: i.variants.map((v) => ({
            sizeOptionId: v.sizeOptionId ?? undefined,
            customSizeName: v.customSizeName ?? undefined,
            fabricColorId: v.fabricColorId ?? undefined,
            customColorName: v.customColorName ?? undefined,
            pantone: v.pantone ?? undefined,
            hex: v.hex ?? undefined,
            quantity: v.quantity,
            notes: v.notes ?? undefined,
          })),
        }));
        await this.items.validate(tx, ref, input);
        await this.items.replace(tx, order, ref, input);
      }
      await this.activity.log(
        tx,
        order.id,
        actor,
        'ORDER_CREATED',
        `${orderNumber} created as a reorder of ${source.orderNumber}`,
        {
          reorderOf: source.orderNumber,
        },
      );
      await this.activity.log(
        tx,
        source.id,
        actor,
        'REORDER_CREATED',
        `${orderNumber} was created as a reorder`,
        {
          reorder: orderNumber,
        },
      );
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.ORDER_REORDERED,
          entityType: 'Order',
          entityId: order.id,
          metadata: {
            orderNumber,
            reorderOf: source.orderNumber,
            cloneItems: dto.cloneItems !== false,
            approvedProductionSpecId: source.approvedProductionSpecId,
            ...(actor.customer && { via: 'customer_portal' }),
          },
          meta,
        },
        tx,
      );
      return order.id;
    });
    return this.get(newId);
  }

  // used by the batches service
  async lockAndLoad(tx: Tx, id: string): Promise<Order> {
    await this.transitions.lock(tx, id);
    return this.mustFind(tx, id);
  }
}

export type { ReferenceInfo };
