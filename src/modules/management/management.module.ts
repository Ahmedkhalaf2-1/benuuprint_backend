import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { AttentionService } from './attention.service.js';
import { CapacityService } from './capacity.service.js';
import { DashboardService } from './dashboard.service.js';
import { DelayService } from './delay.service.js';
import { EtaService } from './eta.service.js';
import { KpiService } from './kpi.service.js';
import { ManagementBoardService } from './management-board.service.js';
import {
  DashboardController,
  KpiController,
  ManagementConfigController,
  StaffWorkloadController,
  WorkloadController,
} from './management.controller.js';
import { ManagementContext } from './management-context.service.js';
import { SlaService } from './sla.service.js';
import { WorkloadService } from './workload.service.js';

/**
 * Phase 6A management intelligence. Read-models over the operational tables plus three small
 * configuration tables (SLA rules, department / staff capacity). Nothing here writes operational
 * data and nothing talks to a delivery channel (that is Phase 6B).
 */
@Module({
  imports: [AuthModule, OrdersModule, CalendarModule],
  controllers: [
    DashboardController,
    KpiController,
    WorkloadController,
    ManagementConfigController,
    StaffWorkloadController,
  ],
  providers: [
    ManagementContext,
    SlaService,
    CapacityService,
    DelayService,
    EtaService,
    KpiService,
    WorkloadService,
    AttentionService,
    DashboardService,
    ManagementBoardService,
  ],
  exports: [
    ManagementContext,
    AttentionService,
    DelayService,
    EtaService,
    SlaService,
  ],
})
export class ManagementModule {}
