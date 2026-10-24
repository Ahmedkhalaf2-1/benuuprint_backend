import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SampleNotesService } from './sample-notes.service.js';
import {
  SampleAssetsController,
  SampleDecorationsController,
  SampleNotesController,
  SamplePartsController,
} from './sample-parts.controller.js';
import { SampleProductionSpecService } from './sample-production-spec.service.js';
import { SampleSpecService } from './sample-spec.service.js';
import {
  SampleTermsController,
  TermsController,
} from './sample-terms.controller.js';
import { SampleTermsService } from './sample-terms.service.js';
import { SampleTransitionsService } from './sample-transitions.service.js';
import { SampleWorkflowController } from './sample-workflow.controller.js';
import { SampleWorkflowService } from './sample-workflow.service.js';
import { SamplesController } from './samples.controller.js';
import { SamplesService } from './samples.service.js';

@Module({
  imports: [AuthModule, AssetsModule],
  controllers: [
    SamplesController,
    SampleWorkflowController,
    SampleDecorationsController,
    SamplePartsController,
    SampleAssetsController,
    SampleNotesController,
    TermsController,
    SampleTermsController,
  ],
  providers: [
    SamplesService,
    SampleWorkflowService,
    SampleTransitionsService,
    SampleSpecService,
    SampleNotesService,
    SampleTermsService,
    SampleProductionSpecService,
  ],
  // Quotations, payments and approvals drive status changes through these.
  exports: [
    SamplesService,
    SampleTransitionsService,
    SampleProductionSpecService,
    // the customer portal runs the same specification, terms and submit rules
    SampleSpecService,
    SampleTermsService,
    SampleWorkflowService,
  ],
})
export class SamplesModule {}
