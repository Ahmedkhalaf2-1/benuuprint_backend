import { Module } from '@nestjs/common';
import { CommercialController } from './commercial.controller.js';
import { CommercialService } from './commercial.service.js';

@Module({
  controllers: [CommercialController],
  providers: [CommercialService],
  exports: [CommercialService],
})
export class CommercialModule {}
