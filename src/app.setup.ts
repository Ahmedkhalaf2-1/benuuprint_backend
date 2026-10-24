import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import type { AppConfig } from './config/app.config.js';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and e2e tests so tests exercise the real HTTP setup. */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService).getOrThrow<AppConfig>('app');

  app.useLogger(app.get(Logger));
  if (config.trustProxy) {
    (app as NestExpressApplication).set('trust proxy', 1);
  }
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Benue Print API')
        .setDescription('Factory operations and customer portal backend')
        .setVersion('0.1.0')
        .addBearerAuth()
        // customer-portal tokens are a different principal: they only work on /customer/* routes
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'customer-bearer')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }
}
