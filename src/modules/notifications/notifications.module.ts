import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { AuthModule } from '../auth/auth.module.js';
import { ManagementModule } from '../management/management.module.js';
import { EventContextService } from './event-context.service.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';
import { NotificationPlannerService } from './notification-planner.service.js';
import {
  AdminNotificationsController,
  StaffNotificationsController,
} from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { OutboxProcessorService } from './outbox-processor.service.js';
import { PreferencesService } from './preferences.service.js';
import {
  DisabledEmailProvider,
  DisabledWhatsAppProvider,
  LogEmailProvider,
  LogWhatsAppProvider,
} from './providers/dev-providers.js';
import { EmailProvider, WhatsAppProvider } from './providers/provider.ports.js';
import { TemplatesService } from './templates.service.js';

/**
 * Providers are chosen by configuration. Adding a vendor = one more class implementing the port and one more
 * case in these factories; nothing in the business or planning code changes.
 */
@Module({
  imports: [AuthModule, ManagementModule],
  controllers: [StaffNotificationsController, AdminNotificationsController],
  providers: [
    {
      provide: EmailProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailProvider =>
        config.getOrThrow<AppConfig>('app').notifications.emailProvider ===
        'log'
          ? new LogEmailProvider()
          : new DisabledEmailProvider(),
    },
    {
      provide: WhatsAppProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): WhatsAppProvider =>
        config.getOrThrow<AppConfig>('app').notifications.whatsappProvider ===
        'log'
          ? new LogWhatsAppProvider()
          : new DisabledWhatsAppProvider(),
    },
    EventContextService,
    NotificationPlannerService,
    NotificationDispatcherService,
    OutboxProcessorService,
    NotificationsService,
    TemplatesService,
    PreferencesService,
  ],
  exports: [
    NotificationPlannerService,
    NotificationDispatcherService,
    OutboxProcessorService,
    EmailProvider,
    WhatsAppProvider,
  ],
})
export class NotificationsModule {}
