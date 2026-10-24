import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { JobCardsModule } from '../jobcards/jobcards.module.js';
import {
  TechPacksAdminController,
  TechPacksStaffController,
} from './techpacks.controller.js';
import { TechPacksService } from './techpacks.service.js';

@Module({
  imports: [AuthModule, AssetsModule, JobCardsModule],
  controllers: [TechPacksAdminController, TechPacksStaffController],
  providers: [TechPacksService],
  exports: [TechPacksService],
})
export class TechPacksModule {}
