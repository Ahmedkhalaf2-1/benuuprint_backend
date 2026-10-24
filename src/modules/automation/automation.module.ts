import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { ManagementModule } from '../management/management.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AlertsService } from './alerts.service.js';
import { AutomationController } from './automation.controller.js';
import { AutomationRulesService } from './automation-rules.service.js';
import { SchedulerService } from './scheduler.service.js';

@Module({
  imports: [AuthModule, CalendarModule, ManagementModule, NotificationsModule],
  controllers: [AutomationController],
  providers: [AlertsService, AutomationRulesService, SchedulerService],
  exports: [AlertsService, SchedulerService],
})
export class AutomationModule {}
