import { Module } from '@nestjs/common';
import { OrderActivityService } from './order-activity.service.js';
import { OrderSyncService } from './order-sync.service.js';
import { OrderTransitionsService } from './order-transitions.service.js';

/** Order status machinery shared by the factory (production drives order status) and the orders module. */
@Module({
  providers: [OrderActivityService, OrderTransitionsService, OrderSyncService],
  exports: [OrderActivityService, OrderTransitionsService, OrderSyncService],
})
export class OrderCoreModule {}
