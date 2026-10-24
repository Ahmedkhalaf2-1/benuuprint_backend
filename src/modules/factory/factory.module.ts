import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { ResponsibilitiesModule } from '../responsibilities/responsibilities.module.js';
import { ResponsibilityApplyController } from './responsibility-apply.controller.js';
import { StageAutoAssignService } from './stage-auto-assign.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { OrderCoreModule } from '../orders/core/order-core.module.js';
import { SamplesModule } from '../samples/samples.module.js';
import { BulkJobsService } from './bulk-jobs.service.js';
import { PackagingReportsService } from './packaging-reports.service.js';
import { StageQuantityService } from './stage-quantity.service.js';
import {
  BlockersAdminController,
  FactoryJobsAdminController,
  ProductionBoardController,
  QcAdminController,
  StagesAdminController,
} from './factory-admin.controller.js';
import { FactoryJobsService } from './factory-jobs.service.js';
import { JobEngineService } from './job-engine.service.js';
import { ProductionBoardService } from './production-board.service.js';
import { QcService } from './qc.service.js';
import { ReworkService } from './rework.service.js';
import { StageOperationsService } from './stage-operations.service.js';
import { StaffTasksController } from './staff-tasks.controller.js';
import { StaffTasksService } from './staff-tasks.service.js';
import {
  StageDefinitionsController,
  WorkflowTemplatesController,
} from './workflow-templates.controller.js';
import { WorkflowTemplatesService } from './workflow-templates.service.js';

@Module({
  imports: [
    AuthModule,
    AssetsModule,
    SamplesModule,
    OrderCoreModule,
    ResponsibilitiesModule,
  ],
  controllers: [
    WorkflowTemplatesController,
    StageDefinitionsController,
    FactoryJobsAdminController,
    BlockersAdminController,
    StagesAdminController,
    QcAdminController,
    ProductionBoardController,
    StaffTasksController,
    ResponsibilityApplyController,
  ],
  providers: [
    JobEngineService,
    WorkflowTemplatesService,
    FactoryJobsService,
    StageOperationsService,
    ReworkService,
    QcService,
    ProductionBoardService,
    StaffTasksService,
    StageQuantityService,
    BulkJobsService,
    PackagingReportsService,
    StageAutoAssignService,
  ],
  exports: [
    StaffTasksService,
    JobEngineService,
    FactoryJobsService,
    BulkJobsService,
    StageQuantityService,
  ],
})
export class FactoryModule {}
