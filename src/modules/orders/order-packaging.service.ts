import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { OrderActivityService } from './core/order-activity.service.js';
import { OrderSyncService } from './core/order-sync.service.js';
import { OrderTransitionsService } from './core/order-transitions.service.js';
import type {
  PackagingSpecResponseDto,
  UpdatePackagingSpecDto,
} from './dto/packaging.dto.js';
import { shippableQuantity } from './pure/order-fulfillment.js';
import { COMMITTED_SHIPMENT_STATUSES } from './pure/shipment-state-machine.js';

type Tx = Prisma.TransactionClient;

@Injectable()
export class OrderPackagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: OrderTransitionsService,
    private readonly activity: OrderActivityService,
    private readonly sync: OrderSyncService,
    private readonly audit: AuditService,
  ) {}

  /** Packed / produced / committed figures shared by the packaging summary and shipment checks. */
  async figures(client: PrismaService | Tx, orderId: string) {
    const [completed, packed, shipped] = await Promise.all([
      client.factoryJob.aggregate({
        where: { orderId, status: { not: 'CANCELLED' } },
        _sum: { completedQuantity: true },
      }),
      client.stageProductionReport.aggregate({
        where: {
          jobStage: {
            job: { orderId, status: { not: 'CANCELLED' } },
            departmentType: 'PACKAGING',
            isQcStage: false,
          },
        },
        _sum: { producedQuantity: true, rejectedQuantity: true },
      }),
      client.shipmentLine.aggregate({
        where: {
          shipment: {
            orderId,
            status: { in: [...COMMITTED_SHIPMENT_STATUSES] },
          },
        },
        _sum: { quantity: true },
      }),
    ]);
    const completedQuantity = completed._sum.completedQuantity ?? 0;
    const packedQuantity = packed._sum.producedQuantity ?? 0;
    const committedQuantity = shipped._sum.quantity ?? 0;
    return {
      completedQuantity,
      packedQuantity,
      damagedQuantity: packed._sum.rejectedQuantity ?? 0,
      committedQuantity,
      shippableQuantity: shippableQuantity({
        completedQuantity,
        packedQuantity,
        committedQuantity,
      }),
    };
  }

  async get(orderId: string): Promise<PackagingSpecResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const spec = await this.prisma.orderPackagingSpec.findUnique({
      where: { orderId },
      include: {
        components: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            componentOption: {
              select: { code: true, name: true, category: true },
            },
          },
        },
      },
    });
    const figures = await this.figures(this.prisma, orderId);
    const reportRows = await this.prisma.packagingReport.findMany({
      where: { jobStage: { job: { orderId } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(reportRows.map((r) => r.reportedByUserId))] },
      },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    const cartons = reportRows.reduce((s, r) => s + r.cartonCount, 0);
    return {
      id: spec?.id ?? null,
      defined: !!spec,
      foldingInstructions: spec?.foldingInstructions ?? null,
      polybagRequired: spec?.polybagRequired ?? false,
      labelsRequired: spec?.labelsRequired ?? false,
      hangTagsRequired: spec?.hangTagsRequired ?? false,
      stickersRequired: spec?.stickersRequired ?? false,
      stickerNotes: spec?.stickerNotes ?? null,
      unitsPerCarton: spec?.unitsPerCarton ?? null,
      cartonNotes: spec?.cartonNotes ?? null,
      specialInstructions: spec?.specialInstructions ?? null,
      components: (spec?.components ?? []).map((c) => ({
        id: c.id,
        componentOptionId: c.componentOptionId,
        componentCode: c.componentOption?.code ?? null,
        name: c.componentOption?.name ?? c.customName ?? '',
        category: c.componentOption?.category ?? null,
        quantityPerUnit: c.quantityPerUnit,
        notes: c.notes,
      })),
      reconciliation: {
        completedQuantity: figures.completedQuantity,
        packedQuantity: figures.packedQuantity,
        damagedQuantity: figures.damagedQuantity,
        cartonCount: cartons,
        packagingComplete:
          figures.completedQuantity > 0 &&
          figures.packedQuantity >= figures.completedQuantity,
        shippableQuantity: figures.shippableQuantity,
      },
      reports: reportRows.map((r) => ({
        id: r.id,
        jobStageId: r.jobStageId,
        packedQuantity: r.packedQuantity,
        damagedQuantity: r.damagedQuantity,
        cartonCount: r.cartonCount,
        notes: r.notes,
        reportedByName: names.get(r.reportedByUserId) ?? null,
        createdAt: r.createdAt,
      })),
      updatedAt: spec?.updatedAt ?? null,
    };
  }

  /** Create or edit the packaging specification; not once packaging work has started. */
  async upsert(
    orderId: string,
    dto: UpdatePackagingSpecDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<PackagingSpecResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      if (['CANCELLED', 'COMPLETED', 'DELIVERED'].includes(order.status))
        throw new ConflictException(`${order.orderNumber} is ${order.status}`);
      const packagingStages = await tx.jobStage.findMany({
        where: {
          job: { orderId, status: { not: 'CANCELLED' } },
          departmentType: 'PACKAGING',
          isQcStage: false,
          supersededAt: null,
          status: { in: ['IN_PROGRESS', 'COMPLETED'] },
        },
        select: { status: true },
      });
      const existingSpec = await tx.orderPackagingSpec.count({
        where: { orderId },
      });
      // Not while packers are working from it. A specification that was never defined can still
      // be added after packaging finished (so the order can ship); an existing one is then final.
      if (
        packagingStages.some((x) => x.status === 'IN_PROGRESS') ||
        (packagingStages.length > 0 && existingSpec > 0)
      ) {
        throw new ConflictException(
          'Packaging has started: its specification can no longer change',
        );
      }
      if (dto.components) await this.validateComponents(tx, dto.components);
      const existing = await tx.orderPackagingSpec.findUnique({
        where: { orderId },
        include: { components: true },
      });
      const { components, ...fields } = dto;
      const data = {
        foldingInstructions: fields.foldingInstructions,
        polybagRequired: fields.polybagRequired,
        labelsRequired: fields.labelsRequired,
        hangTagsRequired: fields.hangTagsRequired,
        stickersRequired: fields.stickersRequired,
        stickerNotes: fields.stickerNotes,
        unitsPerCarton: fields.unitsPerCarton,
        cartonNotes: fields.cartonNotes,
        specialInstructions: fields.specialInstructions,
        updatedByUserId: actor.id,
      };
      const spec = existing
        ? await tx.orderPackagingSpec.update({ where: { orderId }, data })
        : await tx.orderPackagingSpec.create({ data: { orderId, ...data } });
      if (components) {
        await tx.orderPackagingComponent.deleteMany({
          where: { packagingSpecId: spec.id },
        });
        await tx.orderPackagingComponent.createMany({
          data: components.map((c, i) => ({
            packagingSpecId: spec.id,
            componentOptionId: c.componentOptionId ?? null,
            customName: c.customName ?? null,
            quantityPerUnit: c.quantityPerUnit ?? null,
            notes: c.notes ?? null,
            sortOrder: i,
          })),
        });
      }
      await this.activity.log(
        tx,
        orderId,
        actor.id,
        'ORDER_UPDATED',
        `${order.orderNumber} packaging specification ${existing ? 'updated' : 'defined'}`,
        { components: components?.length ?? existing?.components.length ?? 0 },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.PACKAGING_SPEC_UPDATED,
          entityType: 'Order',
          entityId: orderId,
          metadata: {
            orderNumber: order.orderNumber,
            created: !existing,
            fields: Object.keys(dto),
            components: components?.length,
            polybagRequired: spec.polybagRequired,
            unitsPerCarton: spec.unitsPerCarton,
          },
          meta,
        },
        tx,
      );
      // an order whose production is finished may now be ready for delivery
      await this.sync.refreshOrder(tx, orderId, actor);
    });
    return this.get(orderId);
  }

  private async validateComponents(
    tx: Tx,
    components: NonNullable<UpdatePackagingSpecDto['components']>,
  ) {
    const ids: string[] = [];
    for (const [i, c] of components.entries()) {
      if (!!c.componentOptionId === !!c.customName) {
        throw new BadRequestException(
          `components[${i}]: give a master-data component or a custom name, not both or neither`,
        );
      }
      if (c.componentOptionId) ids.push(c.componentOptionId);
    }
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('A component can be listed only once');
    if (ids.length) {
      const found = await tx.componentOption.count({
        where: { id: { in: ids }, isActive: true, archivedAt: null },
      });
      if (found !== ids.length)
        throw new BadRequestException(
          'A packaging component does not exist or is inactive',
        );
    }
  }
}
