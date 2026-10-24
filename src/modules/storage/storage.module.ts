import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { StorageController } from './storage.controller.js';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  controllers: [StorageController],
  providers: [
    {
      provide: StorageService,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageService => {
        const { storage, jwt } = config.getOrThrow<AppConfig>('app');
        switch (storage.provider) {
          case 'local':
            return new LocalStorageProvider({
              root: storage.localRoot,
              signingSecret: jwt.secret,
              defaultTtlSeconds: storage.signedUrlTtlSeconds,
            });
        }
      },
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
