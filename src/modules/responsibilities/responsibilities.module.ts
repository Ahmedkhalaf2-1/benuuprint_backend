import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProcessProjectionService } from './process-projection.service.js';
import {
  CustomerResponsibilitiesController,
  ResponsibilitiesController,
} from './responsibilities.controller.js';
import { ResponsibilityRulesService } from './responsibility-rules.service.js';

/**
 * Default responsibilities (who owns which factory area, globally or per customer) and the read-only
 * operational projections built on real production data. Deliberately free of the factory engine so the
 * factory, orders and customers modules can all depend on it.
 */
@Module({
  imports: [AuthModule],
  controllers: [ResponsibilitiesController, CustomerResponsibilitiesController],
  providers: [ResponsibilityRulesService, ProcessProjectionService],
  exports: [ResponsibilityRulesService, ProcessProjectionService],
})
export class ResponsibilitiesModule {}
