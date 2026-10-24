import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial/commercial.module.js';
import { OrderCoreModule } from '../orders/core/order-core.module.js';
import { SamplesModule } from '../samples/samples.module.js';
import { QuotationsController } from './quotations.controller.js';
import { QuotationsService } from './quotations.service.js';

@Module({
  imports: [SamplesModule, CommercialModule, OrderCoreModule],
  controllers: [QuotationsController],
  providers: [QuotationsService],
  exports: [QuotationsService],
})
export class QuotationsModule {}
