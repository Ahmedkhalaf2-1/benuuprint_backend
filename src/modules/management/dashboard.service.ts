import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import type { PermissionCode } from '../../common/enums/permissions.js';
import { AttentionService } from './attention.service.js';
import { KpiService } from './kpi.service.js';
import { ManagementContext } from './management-context.service.js';
import {
  ORDER_PIPELINE,
  SAMPLE_PIPELINE,
  groupCounts,
} from './pure/pipeline.js';
import { WorkloadService } from './workload.service.js';

/**
 * One concise payload for the management landing page. Every section is built from the same
 * aggregate services as the dedicated endpoints, and a section the caller may not see is simply
 * absent (never empty-but-present), so commercial figures cannot leak to production roles.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
    private readonly attention: AttentionService,
    private readonly kpis: KpiService,
    private readonly workload: WorkloadService,
  ) {}

  async get(actor: AuthUser, q: { from?: string; to?: string }) {
    const can = (p: PermissionCode) => actor.permissions.has(p);
    const range = q;
    const [
      attention,
      pipeline,
      production,
      orders,
      quality,
      commercial,
      delivery,
      workload,
    ] = await Promise.all([
      this.attention.list({ limit: 10 }, actor),
      this.pipeline(),
      can('management_kpis.read') ? this.kpis.production(range) : null,
      can('management_kpis.read') ? this.kpis.orders(range) : null,
      can('quality_kpis.read') ? this.kpis.quality(range) : null,
      can('commercial_kpis.read') ? this.kpis.commercial(range) : null,
      can('management_kpis.read') ? this.kpis.delivery(range) : null,
      can('workload.read') ? this.workload.departments() : null,
    ]);
    return {
      generatedAt: this.ctx.now(),
      timezone: this.ctx.timezone,
      needsAttention: attention,
      pipeline,
      ...(production && {
        production: {
          range: production.range,
          activeJobs: production.activeJobs,
          plannedJobs: production.plannedJobs,
          blockedJobs: production.blockedJobs,
          delayedJobs: production.delayedJobs,
          completedToday: production.completedToday,
          completedThisWeek: production.completedThisWeek,
          onTimeCompletionRatePercent: production.onTimeCompletion.ratePercent,
        },
      }),
      ...(orders && {
        orders: {
          ...orders.current,
          onTimeDeliveryRatePercent: orders.onTimeDelivery.ratePercent,
          averageCycleTimeMinutes: orders.averageCycleTimeMinutes,
        },
      }),
      ...(quality && {
        quality: {
          passRatePercent: quality.inspections.passRatePercent,
          failRatePercent: quality.inspections.failRatePercent,
          openRework: quality.rework.open,
          rejectedUnits: quality.rejectedUnits,
        },
      }),
      ...(workload && {
        workload: workload.departments.map((d) => ({
          department: d.department,
          ready: d.readyStages,
          inProgress: d.inProgressStages,
          blocked: d.blockedStages,
          overdue: d.overdueStages,
          unassignedReady: d.unassignedReadyStages,
        })),
      }),
      ...(commercial && {
        commercial: {
          byCurrency: commercial.byCurrency,
          orders: commercial.orders,
        },
      }),
      ...(delivery && { delivery: delivery.shipments }),
    };
  }

  private async pipeline() {
    const [samples, orders] = await Promise.all([
      this.prisma.sample.groupBy({
        by: ['status'],
        where: { archivedAt: null },
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { archivedAt: null },
        _count: { _all: true },
      }),
    ]);
    return {
      samples: groupCounts(
        SAMPLE_PIPELINE,
        new Map(samples.map((s) => [s.status, s._count._all])),
      ),
      orders: groupCounts(
        ORDER_PIPELINE,
        new Map(orders.map((s) => [s.status, s._count._all])),
      ),
    };
  }
}
