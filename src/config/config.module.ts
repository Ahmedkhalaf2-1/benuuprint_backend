import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './app.config.js';
import { validateEnv } from './env.validation.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig],
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
