import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  NotificationSeverity,
  OperationalAlert,
  OutboxEvent,
} from '../../generated/prisma/client.js';
import { businessDayKey } from '../management/pure/business-time.js';
import { ManagementContext } from '../management/management-context.service.js';
import { MILESTONE_LABELS } from './template-catalog.js';

export interface ResolvedContext {
  entityType: string;
  entityId: string;
  ids: {
    orderId?: string;
    sampleId?: string;
    jobId?: string;
    stageId?: string;
    customerId?: string;
    salesUserId?: string | null;
  };
  alert?: OperationalAlert;
  assigneeUserId?: string;
  responsibleUserIds: string[];
  severity?: NotificationSeverity;
  /** Template variables for a locale (milestone labels are localised, everything else is data). */
  vars(locale: string): Record<string, string>;
}

type Payload = Record<string, string | undefined>;

/**
 * Turns an outbox event into the facts a message needs, always read fresh at processing time (so a name
 * corrected after the event is what the customer sees) and never persisted beyond the rendered text.
 */
@Injectable()
export class EventContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
  ) {}

  private day(d: Date | null | undefined): string {
    return d ? businessDayKey(d, this.ctx.timezone) : '';
  }

  async resolve(event: OutboxEvent): Promise<ResolvedContext> {
    const p = event.payload as Payload;
    let orderId = p.orderId;
    let sampleId = p.sampleId;
    const jobId = p.jobId;
    const stageId = p.stageId;
    const base: Record<string, string> = {};

    const job = jobId
      ? await this.prisma.factoryJob.findUnique({
          where: { id: jobId },
          select: {
            id: true,
            jobNumber: true,
            productName: true,
            orderId: true,
            sampleId: true,
            customerId: true,
            brandId: true,
          },
        })
      : null;
    if (job) {
      base.jobNumber = job.jobNumber;
      base.productName = job.productName;
      orderId ??= job.orderId ?? undefined;
      sampleId ??= job.sampleId ?? undefined;
    }
    const stage = stageId
      ? await this.prisma.jobStage.findUnique({
          where: { id: stageId },
          select: { stageName: true, stageCode: true },
        })
      : null;
    if (stage) {
      base.stageName = stage.stageName;
      base.currentStage = stage.stageName;
    }
    if (p.shipmentId) {
      const sh = await this.prisma.shipment.findUnique({
        where: { id: p.shipmentId },
        select: { shipmentNumber: true, orderId: true, failureReason: true },
      });
      if (sh) {
        base.shipmentNumber = sh.shipmentNumber;
        orderId ??= sh.orderId;
        if (sh.failureReason) base.reason = sh.failureReason;
      }
    }
    if (p.reason) base.reason = p.reason;
    if (p.quotationNumber) base.quotationNumber = p.quotationNumber;

    let customerId = job?.customerId;
    let salesUserId: string | null | undefined;
    let brandId = job?.brandId;
    let targetDate = '';
    if (orderId) {
      const o = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          orderNumber: true,
          customerId: true,
          brandId: true,
          assignedSalesUserId: true,
          targetDeliveryDate: true,
        },
      });
      if (o) {
        base.orderNumber = o.orderNumber;
        customerId = o.customerId;
        brandId = o.brandId;
        salesUserId = o.assignedSalesUserId;
        targetDate = this.day(o.targetDeliveryDate);
      }
    }
    if (sampleId) {
      const s = await this.prisma.sample.findUnique({
        where: { id: sampleId },
        select: {
          sampleNumber: true,
          customerId: true,
          brandId: true,
          assignedSalesUserId: true,
        },
      });
      if (s) {
        base.sampleNumber = s.sampleNumber;
        customerId ??= s.customerId;
        brandId ??= s.brandId;
        salesUserId ??= s.assignedSalesUserId;
      }
    }
    if (job && !targetDate) {
      const j = await this.prisma.factoryJob.findUnique({
        where: { id: job.id },
        select: { targetCompletionDate: true },
      });
      targetDate = this.day(j?.targetCompletionDate);
    }
    if (targetDate) base.targetDate = targetDate;
    if (customerId) {
      const c = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { displayName: true },
      });
      if (c) base.customerName = c.displayName;
    }
    if (brandId) {
      const b = await this.prisma.brand.findUnique({
        where: { id: brandId },
        select: { name: true },
      });
      if (b) base.brandName = b.name;
    }

    let alert: OperationalAlert | undefined;
    let responsibleUserIds: string[] = [];
    let severity: NotificationSeverity | undefined;
    if (p.alertId) {
      alert =
        (await this.prisma.operationalAlert.findUnique({
          where: { id: p.alertId },
        })) ?? undefined;
      if (alert) {
        base.alertTitle = alert.title;
        base.alertReason = alert.reason;
        base.severity = alert.severity;
        base.reference = alert.reference;
        severity = alert.severity;
        const c = (alert.context ?? {}) as {
          responsibleUserIds?: string[];
          orderId?: string;
          jobId?: string;
        };
        responsibleUserIds = c.responsibleUserIds ?? [];
        if (!orderId && c.orderId) {
          const o = await this.prisma.order.findUnique({
            where: { id: c.orderId },
            select: {
              customerId: true,
              assignedSalesUserId: true,
              orderNumber: true,
            },
          });
          if (o) {
            salesUserId = o.assignedSalesUserId;
            base.orderNumber = o.orderNumber;
          }
        }
      }
    }
    if (p.level) base.escalationLevel = String(p.level);

    return {
      entityType: event.aggregateType,
      entityId: event.aggregateId,
      ids: { orderId, sampleId, jobId, stageId, customerId, salesUserId },
      alert,
      assigneeUserId: p.assigneeUserId,
      responsibleUserIds,
      severity,
      vars: (locale: string) => {
        const out: Record<string, string> = { ...base, trackingLink: '' };
        if (p.milestone) {
          const labels = MILESTONE_LABELS[p.milestone];
          out.milestone = labels
            ? (labels[locale as 'en' | 'ar'] ?? labels.en)
            : p.milestone;
        }
        return out;
      },
    };
  }
}
