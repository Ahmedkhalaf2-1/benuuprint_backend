import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { AppConfig } from './config/app.config.js';

const app = await NestFactory.create(AppModule, { bufferLogs: true });
configureApp(app);
const { port } = app.get(ConfigService).getOrThrow<AppConfig>('app');
await app.listen(port);
