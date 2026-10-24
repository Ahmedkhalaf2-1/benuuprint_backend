import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
