import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial/commercial.module.js';
import { OrderCoreModule } from '../orders/core/order-core.module.js';
import { SamplesModule } from '../samples/samples.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [SamplesModule, CommercialModule, OrderCoreModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
