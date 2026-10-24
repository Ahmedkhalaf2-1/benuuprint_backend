import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FactoryModule } from '../factory/factory.module.js';
import { ManagementModule } from '../management/management.module.js';
import { JobCardService } from './job-card.service.js';
import {
  JobCardsAdminController,
  QrScanController,
} from './jobcards.controller.js';
import { QrService } from './qr.service.js';

@Module({
  imports: [AuthModule, FactoryModule, ManagementModule],
  controllers: [JobCardsAdminController, QrScanController],
  providers: [QrService, JobCardService],
  exports: [QrService, JobCardService],
})
export class JobCardsModule {}
