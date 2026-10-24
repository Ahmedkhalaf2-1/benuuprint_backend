import { Module } from '@nestjs/common';
import { ArtworkModule } from '../artwork/artwork.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { SamplesModule } from '../samples/samples.module.js';
import {
  ApprovalsController,
  QuotationDecisionController,
} from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';

@Module({
  imports: [SamplesModule, QuotationsModule, ArtworkModule],
  controllers: [ApprovalsController, QuotationDecisionController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
