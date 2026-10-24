import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../../common/types/auth-user.js';
import type { FactoryJob, Prisma } from '../../../generated/prisma/client.js';
import { OrderActivityService } from './order-activity.service.js';
import { OrderTransitionsService } from './order-transitions.service.js';
import { deriveOrderStatus } from '../pure/order-fulfillment.js';
import {
  deriveBatchProduction,
  deriveOrderProduction,
} from '../pure/order-production.js';
import { PRODUCTION_PHASE_STATUSES } from '../pure/order-state-machine.js';

type Tx = Prisma.TransactionClient;

/**
 * Keeps batch and order status in step with their factory jobs. Called by the job engine after
 * every job change, with the order lock already held (`JobEngineService.lockJob`).
 */
@Injectable()
export class OrderSyncService {
  constructor(
    private readonly transitions: OrderTransitionsService,
    private readonly activity: OrderActivityService,
  ) {}

  async refreshForJob(
    tx: Tx,
    job: Pick<FactoryJob, 'orderId' | 'orderBatchId'>,
    actor: AuthUser | null,
  ): Promise<void> {
    if (!job.orderId) return;
    if (job.orderBatchId) await this.refreshBatch(tx, job.orderBatchId, actor);
    await this.refreshOrder(tx, job.orderId, actor);
  }

  async refreshBatch(
    tx: Tx,
    batchId: string,
    actor: AuthUser | null,
  ): Promise<void> {
    const batch = await tx.orderBatch.findUnique({ where: { id: batchId } });
    if (!batch || ['CANCELLED', 'ON_HOLD', 'PLANNED'].includes(batch.status))
      return;
    const job = await tx.factoryJob.findFirst({
      where: { orderBatchId: batchId, status: { not: 'CANCELLED' } },
    });
    const next = deriveBatchProduction({
      jobStatus: job?.status ?? null,
      started: !!job?.startedAt,
      completedQuantity: job?.completedQuantity ?? 0,
    });
    if (next === batch.status) return;
    const now = new Date();
    await tx.orderBatch.update({
      where: { id: batchId },
      data: {
        status: next,
        startedAt: next === 'READY' ? null : (batch.startedAt ?? now),
        completedAt: next === 'COMPLETED' ? now : null,
      },
    });
    if (!batch.startedAt && next !== 'READY') {
      await this.activity.log(
        tx,
        batch.orderId,
        actor?.id ?? null,
        'BATCH_STARTED',
        `${batch.batchNumber} started production`,
        { batchId },
      );
    }
  }

  /**
   * Re-derive the order's production / packaging / delivery status from the facts and move it
   * there through the state machine. The caller holds the order lock.
   */
  async refreshOrder(
    tx: Tx,
    orderId: string,
    actor: AuthUser | null,
  ): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { variants: { select: { quantity: true } } } },
        batches: { select: { status: true, quantity: true, id: true } },
      },
    });
    if (!order || !PRODUCTION_PHASE_STATUSES.includes(order.status)) return;
    const [jobs, spec, packed, packagingStages, shipments] = await Promise.all([
      tx.factoryJob.findMany({ where: { orderId } }),
      tx.orderPackagingSpec.count({ where: { orderId } }),
      tx.stageProductionReport.aggregate({
        where: {
          jobStage: {
            job: { orderId, status: { not: 'CANCELLED' } },
            departmentType: 'PACKAGING',
            isQcStage: false,
          },
        },
        _sum: { producedQuantity: true },
      }),
      tx.jobStage.findMany({
        where: {
          job: { orderId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
          departmentType: 'PACKAGING',
          isQcStage: false,
          supersededAt: null,
          status: { in: ['READY', 'IN_PROGRESS'] },
        },
        select: { status: true },
      }),
      tx.shipment.findMany({
        where: {
          orderId,
          status: { in: ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED'] },
        },
        select: { status: true, lines: { select: { quantity: true } } },
      }),
    ]);
    const total = order.items.reduce(
      (sum, i) => sum + i.variants.reduce((s, v) => s + v.quantity, 0),
      0,
    );
    const liveBatches = order.batches.filter((b) => b.status !== 'CANCELLED');
    const completedBatchCount = liveBatches.filter((b) =>
      jobs.some((j) => j.orderBatchId === b.id && j.status === 'COMPLETED'),
    ).length;
    const production = deriveOrderProduction({
      totalQuantity: total,
      jobs,
      batches: order.batches,
      completedBatchCount,
    });
    const qty = (status: string[]) =>
      shipments
        .filter((sh) => status.includes(sh.status))
        .reduce(
          (sum, sh) => sum + sh.lines.reduce((x, l) => x + l.quantity, 0),
          0,
        );
    const derived = deriveOrderStatus({
      production,
      completedQuantity: jobs
        .filter((j) => j.status !== 'CANCELLED')
        .reduce((sum, j) => sum + j.completedQuantity, 0),
      packedQuantity: packed._sum.producedQuantity ?? 0,
      hasPackagingSpec: spec > 0,
      packagingStageActive: packagingStages.some(
        (x) => x.status === 'IN_PROGRESS',
      ),
      packagingStageReady: packagingStages.some((x) => x.status === 'READY'),
      deliveredQuantity: qty(['DELIVERED']),
      inFlightQuantity: qty(['DISPATCHED', 'IN_TRANSIT']),
    });
    // The moment every unit has been produced is recorded once, even when packaging facts
    // carry the order straight on to READY_FOR_DELIVERY.
    if (production === 'PRODUCTION_COMPLETED' && !order.completedAt) {
      await tx.order.update({
        where: { id: orderId },
        data: { completedAt: new Date() },
      });
      await this.activity.log(
        tx,
        orderId,
        actor?.id ?? null,
        'PRODUCTION_COMPLETED',
        `${order.orderNumber}: all units are produced`,
        { derived: true },
      );
    }
    if (derived === order.status) return;
    await this.transitions.apply(tx, orderId, 'fulfillment-sync', {
      actor,
      derivedTarget: derived,
      message: `${order.orderNumber} is now ${derived.replace(/_/g, ' ').toLowerCase()}`,
      metadata: { derived: true },
    });
  }
}
