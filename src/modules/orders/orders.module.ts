import { ResponsibilitiesModule } from '../responsibilities/responsibilities.module.js';
import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommercialModule } from '../commercial/commercial.module.js';
import { FactoryModule } from '../factory/factory.module.js';
import { OrderCoreModule } from './core/order-core.module.js';
import { OrderBatchesService } from './order-batches.service.js';
import { OrderCommercialService } from './order-commercial.service.js';
import {
  OrderCommercialController,
  OrderPackagingController,
  OrderTrackingAdminController,
  PublicTrackingController,
  ShipmentsAdminController,
  StaffDeliveriesController,
} from './order-fulfillment.controller.js';
import { OrderItemsService } from './order-items.service.js';
import { OrderPackagingService } from './order-packaging.service.js';
import { OrderSummaryService } from './order-summary.service.js';
import { OrderTrackingService } from './order-tracking.service.js';
import {
  OrderBatchesController,
  OrdersController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ShipmentsService } from './shipments.service.js';

@Module({
  imports: [
    OrderCoreModule,
    FactoryModule,
    ResponsibilitiesModule,
    CommercialModule,
    AssetsModule,
    AuthModule,
  ],
  controllers: [
    OrdersController,
    OrderBatchesController,
    OrderPackagingController,
    OrderCommercialController,
    ShipmentsAdminController,
    StaffDeliveriesController,
    OrderTrackingAdminController,
    PublicTrackingController,
  ],
  providers: [
    OrdersService,
    OrderBatchesService,
    OrderItemsService,
    OrderSummaryService,
    OrderCommercialService,
    OrderPackagingService,
    OrderTrackingService,
    ShipmentsService,
  ],
  exports: [OrdersService, OrderCommercialService],
})
export class OrdersModule {}
