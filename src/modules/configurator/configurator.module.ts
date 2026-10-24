import { Module } from '@nestjs/common';
import { ConfiguratorController } from './configurator.controller.js';
import { ConfiguratorService } from './configurator.service.js';

@Module({
  controllers: [ConfiguratorController],
  providers: [ConfiguratorService],
  exports: [ConfiguratorService],
})
export class ConfiguratorModule {}
