import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ManagementModule } from '../management/management.module.js';
import { ResponsibilitiesModule } from '../responsibilities/responsibilities.module.js';
import { OperationsController } from './operations.controller.js';

/** Admin operational views (customer operations, order/sample/job process). Kept apart so it can use the ETA service. */
@Module({
  imports: [AuthModule, ManagementModule, ResponsibilitiesModule],
  controllers: [OperationsController],
})
export class OperationsModule {}
