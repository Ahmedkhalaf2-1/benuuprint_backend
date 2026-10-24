import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import { nextReference } from '../../database/reference-sequence.js';
import type {
  Order,
  OrderBatch,
  Prisma,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { FactoryJobsService } from '../factory/factory-jobs.service.js';
import { OrderActivityService } from './core/order-activity.service.js';
import { OrderTransitionsService } from './core/order-transitions.service.js';
import type {
  BatchAllocationInputDto,
  CreateOrderBatchDto,
  OrderBatchResponseDto,
  ReplaceBatchAllocationsDto,
} from './dto/order.dto.js';
import { OrderSummaryService } from './order-summary.service.js';

type Tx = Prisma.TransactionClient;

const BATCHABLE = [
  'CONFIRMED',
  'READY_FOR_PRODUCTION',
  'IN_PRODUCTION',
  'PARTIALLY_COMPLETED',
];

@Injectable()
export class OrderBatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: OrderTransitionsService,
    private readonly activity: OrderActivityService,
    private readonly summaries: OrderSummaryService,
    private readonly jobs: FactoryJobsService,
    private readonly audit: AuditService,
  ) {}

  private include = { allocations: true } satisfies Prisma.OrderBatchInclude;

  async get(id: string): Promise<OrderBatchResponseDto> {
    const batch = await this.prisma.orderBatch.findUnique({
      where: { id },
      include: this.include,
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return (await this.summaries.batchDtos([batch]))[0]!;
  }

  async listForOrder(orderId: string): Promise<OrderBatchResponseDto[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const batches = await this.prisma.orderBatch.findMany({
      where: { orderId },
      include: this.include,
      orderBy: { createdAt: 'asc' },
    });
    return this.summaries.batchDtos(batches);
  }

  /** Validate allocations with clear messages; the database trigger is the concurrency-proof backstop. */
  private async checkAllocations(
    tx: Tx,
    orderId: string,
    allocations: BatchAllocationInputDto[],
    exceptBatchId?: string,
  ): Promise<number> {
    const ids = allocations.map((a) => a.orderVariantId);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('A variant can appear only once per batch');
    const variants = await tx.orderVariant.findMany({
      where: { id: { in: ids }, item: { orderId } },
    });
    if (variants.length !== ids.length)
      throw new BadRequestException('A variant does not belong to this order');
    const used = await tx.orderBatchVariant.groupBy({
      by: ['orderVariantId'],
      where: {
        orderVariantId: { in: ids },
        batch: {
          status: { not: 'CANCELLED' },
          ...(exceptBatchId && { id: { not: exceptBatchId } }),
        },
      },
      _sum: { quantity: true },
    });
    const usedBy = new Map(
      used.map((u) => [u.orderVariantId, u._sum.quantity ?? 0]),
    );
    for (const a of allocations) {
      const v = variants.find((x) => x.id === a.orderVariantId)!;
      const left = v.quantity - (usedBy.get(v.id) ?? 0);
      if (a.quantity > left)
        throw new ConflictException(
          `Over-allocation: variant has ${v.quantity} units, ${usedBy.get(v.id) ?? 0} already in other batches, ${left} left, ${a.quantity} requested`,
        );
    }
    return allocations.reduce((s, a) => s + a.quantity, 0);
  }

  private async writeAllocations(
    tx: Tx,
    batchId: string,
    allocations: BatchAllocationInputDto[],
  ) {
    await tx.orderBatchVariant.deleteMany({ where: { batchId } });
    try {
      for (const a of allocations) {
        await tx.orderBatchVariant.create({
          data: {
            batchId,
            orderVariantId: a.orderVariantId,
            quantity: a.quantity,
          },
        });
      }
    } catch (e) {
      // two concurrent allocations race: the trigger serialises them and rejects the loser
      if (e instanceof Error && /over-allocation/i.test(e.message))
        throw new ConflictException(
          'Over-allocation: another batch just took those units',
        );
      throw e;
    }
  }

  async create(
    orderId: string,
    dto: CreateOrderBatchDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<OrderBatchResponseDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.transitions.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      this.assertBatchable(order);
      const bulk = await tx.factoryJob.findFirst({
        where: {
          orderId,
          sourceType: 'BULK_ORDER',
          status: { not: 'CANCELLED' },
        },
        select: { jobNumber: true },
      });
      if (bulk)
        throw new ConflictException(
          `${bulk.jobNumber} already produces the whole order`,
        );
      const quantity = await this.checkAllocations(
        tx,
        orderId,
        dto.allocations,
      );
      const batchNumber = await nextReference(tx, 'BAT');
      const batch = await tx.orderBatch.create({
        data: {
          batchNumber,
          orderId,
          quantity,
          targetStartDate: dto.targetStartDate,
          targetCompletionDate: dto.targetCompletionDate,
          createdByUserId: actor.id,
        },
      });
      await this.writeAllocations(tx, batch.id, dto.allocations);
      await this.activity.log(
        tx,
        orderId,
        actor.id,
        'BATCH_CREATED',
        `${batchNumber} planned (${quantity} units)`,
        {
          batchId: batch.id,
          quantity,
          allocations: dto.allocations.length,
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_BATCH_CREATED,
          entityType: 'OrderBatch',
          entityId: batch.id,
          metadata: {
            batchNumber,
            orderNumber: order.orderNumber,
            quantity,
            allocations: dto.allocations,
          },
          meta,
        },
        tx,
      );
      return batch.id;
    });
    return this.get(id);
  }

  private assertBatchable(order: Order) {
    if (!order.currentSpecId || !BATCHABLE.includes(order.status))
      throw new ConflictException(
        `Batches can be planned for a confirmed order that is not on hold or finished (${order.orderNumber} is ${order.status})`,
      );
  }

  /** Lock the order (root lock), then reload the batch. */
  private async lockedBatch(
    tx: Tx,
    batchId: string,
  ): Promise<{ batch: OrderBatch; order: Order }> {
    const found = await tx.orderBatch.findUnique({
      where: { id: batchId },
      select: { orderId: true },
    });
    if (!found) throw new NotFoundException('Batch not found');
    await this.transitions.lock(tx, found.orderId);
    const batch = await tx.orderBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: found.orderId },
    });
    return { batch, order };
  }

  async replaceAllocations(
    id: string,
    dto: ReplaceBatchAllocationsDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<OrderBatchResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { batch, order } = await this.lockedBatch(tx, id);
      if (batch.status !== 'PLANNED')
        throw new ConflictException(
          `Allocations can only change while the batch is PLANNED (${batch.batchNumber} is ${batch.status})`,
        );
      this.assertBatchable(order);
      const quantity = await this.checkAllocations(
        tx,
        order.id,
        dto.allocations,
        id,
      );
      await this.writeAllocations(tx, id, dto.allocations);
      await tx.orderBatch.update({
        where: { id },
        data: {
          quantity,
          ...(dto.targetStartDate && { targetStartDate: dto.targetStartDate }),
          ...(dto.targetCompletionDate && {
            targetCompletionDate: dto.targetCompletionDate,
          }),
        },
      });
      await this.activity.log(
        tx,
        order.id,
        actor.id,
        'BATCH_UPDATED',
        `${batch.batchNumber} allocation changed (${batch.quantity} → ${quantity} units)`,
        {
          batchId: id,
          from: batch.quantity,
          to: quantity,
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_BATCH_ALLOCATED,
          entityType: 'OrderBatch',
          entityId: id,
          metadata: {
            batchNumber: batch.batchNumber,
            from: batch.quantity,
            to: quantity,
            allocations: dto.allocations,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async markReady(
    id: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<OrderBatchResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { batch, order } = await this.lockedBatch(tx, id);
      if (batch.status !== 'PLANNED')
        throw new ConflictException(
          `${batch.batchNumber} is ${batch.status}, not PLANNED`,
        );
      if (
        ![
          'READY_FOR_PRODUCTION',
          'IN_PRODUCTION',
          'PARTIALLY_COMPLETED',
        ].includes(order.status)
      )
        throw new ConflictException(
          `${order.orderNumber} must be READY_FOR_PRODUCTION before batches can start (it is ${order.status})`,
        );
      const allocations = await tx.orderBatchVariant.findMany({
        where: { batchId: id },
      });
      const sum = allocations.reduce((s, a) => s + a.quantity, 0);
      if (sum <= 0 || sum !== batch.quantity)
        throw new ConflictException(
          `${batch.batchNumber} has an invalid allocation (${sum} of ${batch.quantity})`,
        );
      await tx.orderBatch.update({ where: { id }, data: { status: 'READY' } });
      await this.activity.log(
        tx,
        order.id,
        actor.id,
        'BATCH_UPDATED',
        `${batch.batchNumber} is ready for production`,
        { batchId: id },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_BATCH_READY,
          entityType: 'OrderBatch',
          entityId: id,
          metadata: {
            batchNumber: batch.batchNumber,
            quantity: batch.quantity,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async hold(
    id: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<OrderBatchResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { batch, order } = await this.lockedBatch(tx, id);
      if (
        !['PLANNED', 'READY', 'IN_PRODUCTION', 'PARTIALLY_COMPLETED'].includes(
          batch.status,
        )
      )
        throw new ConflictException(
          `Cannot hold a batch that is ${batch.status}`,
        );
      await tx.orderBatch.update({
        where: { id },
        data: {
          status: 'ON_HOLD',
          holdReason: reason,
          holdPreviousStatus: batch.status,
        },
      });
      await this.activity.log(
        tx,
        order.id,
        actor.id,
        'BATCH_UPDATED',
        `${batch.batchNumber} put on hold: ${reason}`,
        { batchId: id, reason },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_BATCH_HELD,
          entityType: 'OrderBatch',
          entityId: id,
          metadata: {
            batchNumber: batch.batchNumber,
            reason,
            previousStatus: batch.status,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async resume(
    id: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<OrderBatchResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { batch, order } = await this.lockedBatch(tx, id);
      if (batch.status !== 'ON_HOLD')
        throw new ConflictException(`${batch.batchNumber} is not on hold`);
      await tx.orderBatch.update({
        where: { id },
        data: {
          status: batch.holdPreviousStatus ?? 'PLANNED',
          holdReason: null,
          holdPreviousStatus: null,
        },
      });
      await this.activity.log(
        tx,
        order.id,
        actor.id,
        'BATCH_UPDATED',
        `${batch.batchNumber} resumed`,
        { batchId: id },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_BATCH_RESUMED,
          entityType: 'OrderBatch',
          entityId: id,
          metadata: { batchNumber: batch.batchNumber },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async cancel(
    id: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<OrderBatchResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { batch, order } = await this.lockedBatch(tx, id);
      if (['CANCELLED', 'COMPLETED'].includes(batch.status))
        throw new ConflictException(
          `${batch.batchNumber} is already ${batch.status}`,
        );
      const live = await tx.factoryJob.findFirst({
        where: {
          orderBatchId: id,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      });
      if (live)
        await this.jobs.cancelInTx(
          tx,
          live.id,
          `${batch.batchNumber} cancelled: ${reason}`,
          actor,
          meta,
        );
      await tx.orderBatch.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: reason,
          holdReason: null,
          holdPreviousStatus: null,
        },
      });
      await this.activity.log(
        tx,
        order.id,
        actor.id,
        'BATCH_UPDATED',
        `${batch.batchNumber} cancelled: ${reason}`,
        { batchId: id, reason },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ORDER_BATCH_CANCELLED,
          entityType: 'OrderBatch',
          entityId: id,
          metadata: {
            batchNumber: batch.batchNumber,
            reason,
            previousStatus: batch.status,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }
}
