import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { CalendarService } from './calendar.service.js';
import {
  CalendarPreviewQueryDto,
  CreateWorkingCalendarDto,
  SetCalendarExceptionDto,
  SetWeeklyScheduleDto,
  UpdateWorkingCalendarDto,
} from './dto/calendar.dto.js';

const OK = (description: string) =>
  ApiOkResponse({
    description,
    schema: { type: 'object', additionalProperties: true },
  });

@ApiTags('Working Calendar')
@Controller('admin/working-calendars')
export class CalendarController {
  constructor(private readonly calendars: CalendarService) {}

  @Get()
  @RequirePermissions('working_calendar.read')
  @ApiOperation({ summary: 'List working calendars (the default first)' })
  @OK('Calendars')
  list() {
    return this.calendars.list();
  }

  @Get(':id')
  @RequirePermissions('working_calendar.read')
  @OK('Calendar with weekly hours and exceptions')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.calendars.get(id);
  }

  @Get(':id/preview')
  @RequirePermissions('working_calendar.read')
  @ApiOperation({ summary: 'Working hours day by day for a range (≤ 62 days)' })
  @OK('Preview')
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CalendarPreviewQueryDto,
  ) {
    return this.calendars.preview(id, q);
  }

  @Post()
  @RequirePermissions('working_calendar.manage')
  @ApiOperation({
    summary: 'Create a calendar (the first one becomes the default)',
  })
  @OK('Created')
  create(
    @Body() dto: CreateWorkingCalendarDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.calendars.create(dto, a, m);
  }

  @Put(':id')
  @RequirePermissions('working_calendar.manage')
  @OK('Updated')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkingCalendarDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.calendars.update(id, dto, a, m);
  }

  @Post(':id/make-default')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('working_calendar.manage')
  @ApiOperation({ summary: 'Use this calendar for SLA, ETA and escalation' })
  @OK('Default changed')
  makeDefault(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.calendars.makeDefault(id, a, m);
  }

  @Put(':id/weekly')
  @RequirePermissions('working_calendar.manage')
  @ApiOperation({ summary: 'Set weekly hours (weekday 0 = Sunday)' })
  @OK('Updated')
  weekly(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetWeeklyScheduleDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.calendars.setWeekly(id, dto.days, a, m);
  }

  @Put(':id/exceptions')
  @RequirePermissions('working_calendar.manage')
  @ApiOperation({
    summary:
      'Add or change a holiday, exceptional working day or shortened day',
  })
  @OK('Updated')
  setException(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCalendarExceptionDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.calendars.setException(id, dto, a, m);
  }

  @Delete(':id/exceptions/:date')
  @RequirePermissions('working_calendar.manage')
  @OK('Updated')
  removeException(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('date') date: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.calendars.removeException(id, date, a, m);
  }
}
