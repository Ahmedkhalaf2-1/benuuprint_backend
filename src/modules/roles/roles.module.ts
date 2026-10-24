import { Module } from '@nestjs/common';
import { PermissionsController, RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';

@Module({
  controllers: [RolesController, PermissionsController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
