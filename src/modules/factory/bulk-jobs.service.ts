import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../../common/canonical-json.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { OrderActivityService } from '../orders/core/order-activity.service.js';
import { OrderTransitionsService } from '../orders/core/order-transitions.service.js';
import type {
  CreateFactoryJobDto,
  FactoryJobDetailDto,
} from './dto/factory-job.dto.js';
import { FactoryJobsService } from './factory-jobs.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Bulk production jobs. A whole order runs as one BULK_ORDER job, or as one ORDER_BATCH job per
 * batch: never both. Every bulk job pins the order's APPROVED_REFERENCE (never a pre-production
 * spec) plus the order specification frozen at confirmation; the database enforces both.
 */
@Injectable()
export class BulkJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: FactoryJobsService,
    private readonly orders: OrderTransitionsService,
    private readonly activity: OrderActivityService,
  ) {}

  /** Verify the frozen references the job will pin; returns what the job copies from them. */
  private async verifiedSpecs(
    tx: Tx,
    order: {
      id: string;
      currentSpecId: string | null;
      approvedProductionSpecId: string;
      orderNumber: string;
    },
  ) {
    if (!order.currentSpecId) {
      throw new ConflictException(
        `${order.orderNumber} has no frozen production specification (confirm the order first)`,
      );
    }
    const [reference, orderSpec] = await Promise.all([
      tx.sampleProductionSpec.findUniqueOrThrow({
        where: { id: order.approvedProductionSpecId },
      }),
      tx.orderProductionSpec.findUniqueOrThrow({
        where: { id: order.currentSpecId },
      }),
    ]);
    if (reference.kind !== 'APPROVED_REFERENCE') {
      throw new ConflictException(
        'Bulk production needs the APPROVED_REFERENCE of the sample',
      );
    }
    if (sha256Hex(canonicalJson(reference.snapshot)) !== reference.specHash) {
      throw new ConflictException(
        'The approved reference failed its integrity check',
      );
    }
    if (sha256Hex(canonicalJson(orderSpec.snapshot)) !== orderSpec.specHash) {
      throw new ConflictException(
        'The order production specification failed its integrity check',
      );
    }
    const snapshot = orderSpec.snapshot as {
      items?: { productName?: string }[];
    };
    return {
      reference,
      orderSpec,
      productName: snapshot.items?.[0]?.productName ?? order.orderNumber,
    };
  }

  async createForOrder(
    orderId: string,
    dto: CreateFactoryJobDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<FactoryJobDetailDto> {
    const jobId = await this.prisma.$transaction(async (tx) => {
      await this.orders.lock(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== 'READY_FOR_PRODUCTION') {
        throw new ConflictException(
          `A bulk job needs an order that is READY_FOR_PRODUCTION (${order.orderNumber} is ${order.status})`,
        );
      }
      const batches = await tx.orderBatch.count({
        where: { orderId, status: { not: 'CANCELLED' } },
      });
      if (batches > 0) {
        throw new ConflictException(
          `${order.orderNumber} is split into batches; create jobs per batch (or cancel the batches)`,
        );
      }
      const existing = await tx.factoryJob.findFirst({
        where: {
          orderId,
          sourceType: 'BULK_ORDER',
          status: { not: 'CANCELLED' },
        },
        select: { jobNumber: true },
      });
      if (existing) {
        throw new ConflictException(
          `${existing.jobNumber} already produces this order`,
        );
      }
      const { reference, orderSpec, productName } = await this.verifiedSpecs(
        tx,
        order,
      );
      const job = await this.jobs.instantiate(tx, {
        sourceType: 'BULK_ORDER',
        orderId,
        orderProductionSpecId: orderSpec.id,
        plannedQuantity: orderSpec.totalQuantity,
        pinnedSpecId: reference.id,
        customerId: order.customerId,
        brandId: order.brandId,
        productTypeId: reference.productTypeId,
        productName,
        assignedSalesUserId: order.assignedSalesUserId,
        priority: dto.priority ?? order.priority,
        requestedStartDate: dto.requestedStartDate,
        targetCompletionDate:
          dto.targetCompletionDate ?? order.targetDeliveryDate,
        internalNotes: dto.internalNotes,
        workflowTemplateCode: dto.workflowTemplateCode,
        release: dto.release ?? true,
        activityMessage: (n) =>
          `${n} created for ${order.orderNumber} (${orderSpec.totalQuantity} units)`,
        auditMetadata: {
          orderId,
          orderNumber: order.orderNumber,
          orderProductionSpecId: orderSpec.id,
          approvedProductionSpecId: reference.id,
        },
        actor,
        meta,
      });
      await this.activity.log(
        tx,
        orderId,
        actor.id,
        'JOB_CREATED',
        `${job.jobNumber} created for the whole order`,
        { jobId: job.id, quantity: orderSpec.totalQuantity },
      );
      return job.id;
    });
    return this.jobs.get(jobId);
  }

  async createForBatch(
    batchId: string,
    dto: CreateFactoryJobDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<FactoryJobDetailDto> {
    const found = await this.prisma.orderBatch.findUnique({
      where: { id: batchId },
      select: { orderId: true },
    });
    if (!found) throw new NotFoundException('Batch not found');
    const jobId = await this.prisma.$transaction(async (tx) => {
      await this.orders.lock(tx, found.orderId);
      const order = await tx.order.findUniqueOrThrow({
        where: { id: found.orderId },
      });
      const batch = await tx.orderBatch.findUniqueOrThrow({
        where: { id: batchId },
        include: { allocations: true },
      });
      if (
        ![
          'READY_FOR_PRODUCTION',
          'IN_PRODUCTION',
          'PARTIALLY_COMPLETED',
        ].includes(order.status)
      ) {
        throw new ConflictException(
          `A batch job needs a released order (${order.orderNumber} is ${order.status})`,
        );
      }
      if (batch.status !== 'READY') {
        throw new ConflictException(
          `${batch.batchNumber} must be READY to start production (it is ${batch.status})`,
        );
      }
      const allocated = batch.allocations.reduce((s, a) => s + a.quantity, 0);
      if (allocated <= 0 || allocated !== batch.quantity) {
        throw new ConflictException(
          `${batch.batchNumber} has an invalid allocation (${allocated} allocated, ${batch.quantity} planned)`,
        );
      }
      const bulk = await tx.factoryJob.findFirst({
        where: {
          orderId: order.id,
          sourceType: 'BULK_ORDER',
          status: { not: 'CANCELLED' },
        },
        select: { jobNumber: true },
      });
      if (bulk) {
        throw new ConflictException(
          `${bulk.jobNumber} already produces the whole order`,
        );
      }
      const existing = await tx.factoryJob.findFirst({
        where: { orderBatchId: batchId, status: { not: 'CANCELLED' } },
        select: { jobNumber: true },
      });
      if (existing) {
        throw new ConflictException(
          `${existing.jobNumber} already produces ${batch.batchNumber}`,
        );
      }
      const { reference, orderSpec, productName } = await this.verifiedSpecs(
        tx,
        order,
      );
      const job = await this.jobs.instantiate(tx, {
        sourceType: 'ORDER_BATCH',
        orderId: order.id,
        orderBatchId: batchId,
        orderProductionSpecId: orderSpec.id,
        plannedQuantity: batch.quantity,
        pinnedSpecId: reference.id,
        customerId: order.customerId,
        brandId: order.brandId,
        productTypeId: reference.productTypeId,
        productName,
        assignedSalesUserId: order.assignedSalesUserId,
        priority: dto.priority ?? order.priority,
        requestedStartDate: dto.requestedStartDate,
        targetCompletionDate:
          dto.targetCompletionDate ??
          batch.targetCompletionDate ??
          order.targetDeliveryDate,
        internalNotes: dto.internalNotes,
        workflowTemplateCode: dto.workflowTemplateCode,
        release: dto.release ?? true,
        activityMessage: (n) =>
          `${n} created for ${batch.batchNumber} of ${order.orderNumber} (${batch.quantity} units)`,
        auditMetadata: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          batchId,
          batchNumber: batch.batchNumber,
          orderProductionSpecId: orderSpec.id,
          approvedProductionSpecId: reference.id,
        },
        actor,
        meta,
      });
      await this.activity.log(
        tx,
        order.id,
        actor.id,
        'JOB_CREATED',
        `${job.jobNumber} created for ${batch.batchNumber}`,
        { jobId: job.id, batchId, quantity: batch.quantity },
      );
      return job.id;
    });
    return this.jobs.get(jobId);
  }
}
