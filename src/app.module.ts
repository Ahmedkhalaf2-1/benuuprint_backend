import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import {
  AUTH_THROTTLE_KEY,
  CUSTOMER_ACTION_THROTTLE_KEY,
  TRACKING_THROTTLE_KEY,
} from './modules/auth/auth-throttle.decorator.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { AssetsModule } from './modules/assets/assets.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { MasterDataModule } from './modules/master-data/master-data.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OutboxModule } from './modules/notifications/outbox.module.js';
import { AutomationModule } from './modules/automation/automation.module.js';
import { JobCardsModule } from './modules/jobcards/jobcards.module.js';
import { TechPacksModule } from './modules/techpacks/techpacks.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { OperationsModule } from './modules/operations/operations.module.js';
import { ResponsibilitiesModule } from './modules/responsibilities/responsibilities.module.js';
import { ManagementModule } from './modules/management/management.module.js';
import { FactoryModule } from './modules/factory/factory.module.js';
import { SamplesModule } from './modules/samples/samples.module.js';
import { ArtworkModule } from './modules/artwork/artwork.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { ConfiguratorModule } from './modules/configurator/configurator.module.js';
import { CommercialModule } from './modules/commercial/commercial.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { QuotationsModule } from './modules/quotations/quotations.module.js';
import { BrandsModule } from './modules/brands/brands.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AppConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/app.config.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { CustomerPortalModule } from './modules/customer-portal/customer-portal.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { logLevel, isProduction } = config.getOrThrow<AppConfig>('app');
        return {
          pinoHttp: {
            level: logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            // Public tracking URLs carry a bearer token: keep it out of request logs.
            serializers: {
              req: (req: {
                id?: unknown;
                method?: string;
                url?: string;
                remoteAddress?: string;
              }) => ({
                id: req.id,
                method: req.method,
                url: req.url?.replace(/(\/track\/orders\/)[^/?]+/, '$1[token]'),
                remoteAddress: req.remoteAddress,
              }),
            },
            autoLogging: {
              ignore: (req) => req.url?.endsWith('/health') ?? false,
            },
            transport: isProduction
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
          },
        };
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { rateLimit } = config.getOrThrow<AppConfig>('app');
        const reflector = new Reflector();
        return {
          throttlers: [
            // Generous global ceiling per IP.
            {
              name: 'default',
              ttl: 60_000,
              limit: 300,
              skipIf: () => !rateLimit.enabled,
            },
            // Public order tracking: tagged with @TrackingThrottle().
            {
              name: 'tracking',
              ttl: 60_000,
              limit: rateLimit.trackingPerMinute,
              skipIf: (context) =>
                !rateLimit.enabled ||
                !reflector.get<boolean>(
                  TRACKING_THROTTLE_KEY,
                  context.getHandler(),
                ),
            },
            // Customer-portal uploads and submit, tagged with @CustomerActionThrottle().
            {
              name: 'customerAction',
              ttl: 60_000,
              limit: rateLimit.customerActionPerMinute,
              skipIf: (context) =>
                !rateLimit.enabled ||
                !reflector.get<boolean>(
                  CUSTOMER_ACTION_THROTTLE_KEY,
                  context.getHandler(),
                ),
            },
            // Strict limit, only on routes tagged with @AuthThrottle().
            {
              name: 'auth',
              ttl: 60_000,
              limit: rateLimit.authPerMinute,
              skipIf: (context) =>
                !rateLimit.enabled ||
                !reflector.get<boolean>(
                  AUTH_THROTTLE_KEY,
                  context.getHandler(),
                ),
            },
          ],
        };
      },
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
    CustomersModule,
    BrandsModule,
    StorageModule,
    AssetsModule,
    MasterDataModule,
    SamplesModule,
    FactoryModule,
    OrdersModule,
    CalendarModule,
    OutboxModule,
    NotificationsModule,
    AutomationModule,
    JobCardsModule,
    TechPacksModule,
    ManagementModule,
    ResponsibilitiesModule,
    OperationsModule,
    ArtworkModule,
    CommercialModule,
    QuotationsModule,
    PaymentsModule,
    ApprovalsModule,
    ConfiguratorModule,
    CustomerPortalModule,
    HealthModule,
  ],
  providers: [
    // Order matters: rate limit, then authenticate, then authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
