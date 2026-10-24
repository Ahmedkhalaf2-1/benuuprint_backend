import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import type { AppConfig } from '../../config/app.config.js';
import { AssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // In-memory buffers are fine at this size cap; swap to streaming for very large files.
        limits: {
          fileSize: config.getOrThrow<AppConfig>('app').storage.maxFileBytes,
          files: 1,
          fields: 10,
        },
      }),
    }),
  ],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
