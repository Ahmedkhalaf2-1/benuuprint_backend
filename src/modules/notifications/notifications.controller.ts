import {
  Body,
  Controller,
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
import {
  AllowAuthenticated,
  RequirePermissions,
} from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import {
  ListMyNotificationsQueryDto,
  ListNotificationsQueryDto,
  ListTemplatesQueryDto,
  PublishTemplateDto,
  SetCustomerPreferencesDto,
  SetMyPreferencesDto,
} from './dto/notification.dto.js';
import { NotificationsService } from './notifications.service.js';
import { PreferencesService } from './preferences.service.js';
import { TemplatesService } from './templates.service.js';

const OK = (description: string) =>
  ApiOkResponse({
    description,
    schema: { type: 'object', additionalProperties: true },
  });

@ApiTags('Staff Notifications')
@Controller('staff')
export class StaffNotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly preferences: PreferencesService,
  ) {}

  @Get('notifications')
  @AllowAuthenticated()
  @ApiOperation({
    summary: 'My in-app notifications (own only)',
    description: 'Filters: unread, severity, type.',
  })
  @OK('Notifications')
  list(
    @CurrentUser() actor: AuthUser,
    @Query() q: ListMyNotificationsQueryDto,
  ) {
    return this.notifications.listMine(actor.id, q);
  }

  @Get('notifications/unread-count')
  @AllowAuthenticated()
  @OK('Unread count')
  unread(@CurrentUser() actor: AuthUser) {
    return this.notifications.unreadCount(actor.id);
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.OK)
  @AllowAuthenticated()
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  @OK('Marked')
  readAll(@CurrentUser() actor: AuthUser) {
    return this.notifications.readAll(actor.id);
  }

  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  @AllowAuthenticated()
  @ApiOperation({
    summary: "Mark one of my notifications as read (404 for anybody else's)",
  })
  @OK('Marked')
  read(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(actor.id, id);
  }

  @Get('notification-preferences')
  @AllowAuthenticated()
  @OK('My notification preferences')
  prefs(@CurrentUser() actor: AuthUser) {
    return this.preferences.mine(actor.id);
  }

  @Put('notification-preferences')
  @AllowAuthenticated()
  @ApiOperation({
    summary: 'Set my language and per-category channel preferences',
  })
  @OK('Updated preferences')
  setPrefs(@CurrentUser() actor: AuthUser, @Body() dto: SetMyPreferencesDto) {
    return this.preferences.setMine(actor.id, dto);
  }
}

@ApiTags('Admin Notifications')
@Controller('admin')
export class AdminNotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly templates: TemplatesService,
    private readonly preferences: PreferencesService,
  ) {}

  @Get('notifications')
  @RequirePermissions('notifications.read_all')
  @ApiOperation({
    summary:
      'Operational view of notification delivery (addresses masked, no message bodies)',
  })
  @OK('Notifications')
  list(@Query() q: ListNotificationsQueryDto) {
    return this.notifications.list(q);
  }

  @Get('notifications/summary')
  @RequirePermissions('notifications.read_all')
  @ApiOperation({
    summary:
      'Pending outbox, failed notifications, oldest pending event, open alerts, scheduler heartbeat',
  })
  @OK('Summary')
  summary() {
    return this.notifications.summary();
  }

  @Get('notifications/:id')
  @RequirePermissions('notifications.read_all')
  @OK('Notification with its rendered text')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.get(id);
  }

  @Post('notifications/:id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notifications.manage')
  @ApiOperation({ summary: 'Retry a FAILED notification (audited)' })
  @OK('Re-queued')
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.notifications.retry(id, a, m);
  }

  @Post('notifications/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notifications.manage')
  @ApiOperation({
    summary: 'Cancel a PENDING or FAILED notification (audited)',
  })
  @OK('Cancelled')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.notifications.cancel(id, a, m);
  }

  // ── templates ──
  @Get('notification-templates/variables')
  @RequirePermissions('notification_templates.read')
  @OK('Supported variables')
  variables() {
    return this.templates.variables();
  }

  @Get('notification-templates')
  @RequirePermissions('notification_templates.read')
  @OK('Templates')
  listTemplates(@Query() q: ListTemplatesQueryDto) {
    return this.templates.list(q);
  }

  @Get('notification-templates/:id')
  @RequirePermissions('notification_templates.read')
  @OK('Template')
  getTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(id);
  }

  @Post('notification-templates')
  @RequirePermissions('notification_templates.manage')
  @ApiOperation({
    summary: 'Publish a new template version (becomes the active one)',
    description:
      'Only {{variable}} placeholders from the supported list are accepted; anything else is rejected.',
  })
  @OK('Published')
  publish(
    @Body() dto: PublishTemplateDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.templates.publish(dto, a, m);
  }

  @Post('notification-templates/:id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notification_templates.manage')
  @OK('Activated')
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.templates.activate(id, a, m);
  }

  @Post('notification-templates/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notification_templates.manage')
  @OK('Deactivated')
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.templates.deactivate(id, a, m);
  }

  // ── customer preferences ──
  @Get('customers/:id/notification-preferences')
  @RequirePermissions('notifications.read_all')
  @OK('Customer notification preferences')
  customerPrefs(@Param('id', ParseUUIDPipe) id: string) {
    return this.preferences.forCustomer(id);
  }

  @Put('customers/:id/notification-preferences')
  @RequirePermissions('notifications.manage')
  @ApiOperation({
    summary: "Record a customer's language and optional-message preferences",
  })
  @OK('Updated')
  setCustomerPrefs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCustomerPreferencesDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.preferences.setForCustomer(id, dto, a, m);
  }
}
