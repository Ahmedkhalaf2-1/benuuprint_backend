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
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { AutomationRulesService } from './automation-rules.service.js';
import {
  CreateAutomationRuleDto,
  CreateEscalationRuleDto,
  ListAlertsQueryDto,
  ListRulesQueryDto,
  RunTasksDto,
  UpdateAutomationRuleDto,
  UpdateEscalationRuleDto,
} from './dto/automation.dto.js';
import { SCHEDULER_TASKS, SchedulerService } from './scheduler.service.js';

const OK = (description: string) =>
  ApiOkResponse({
    description,
    schema: { type: 'object', additionalProperties: true },
  });

@ApiTags('Automation')
@Controller('admin/automation')
export class AutomationController {
  constructor(
    private readonly rules: AutomationRulesService,
    private readonly scheduler: SchedulerService,
  ) {}

  @Get('rules')
  @RequirePermissions('automation.read')
  @ApiOperation({
    summary: 'Who is told about which event, over which channel',
  })
  @OK('Rules')
  listRules(@Query() q: ListRulesQueryDto) {
    return this.rules.listRules(q);
  }

  @Get('rules/:id')
  @RequirePermissions('automation.read')
  @OK('Rule')
  getRule(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.getRule(id);
  }

  @Post('rules')
  @RequirePermissions('automation.manage')
  @ApiOperation({
    summary: 'Add a notification rule for a supported event (audited)',
    description:
      'Customers only receive customer-safe events with customer templates; staff audiences only get staff templates.',
  })
  @OK('Created')
  createRule(
    @Body() dto: CreateAutomationRuleDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.rules.createRule(dto, a, m);
  }

  @Put('rules/:id')
  @RequirePermissions('automation.manage')
  @OK('Updated')
  updateRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAutomationRuleDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.rules.updateRule(id, dto, a, m);
  }

  @Get('escalation-rules')
  @RequirePermissions('automation.read')
  @OK('Escalation rules')
  listEscalations(@Query('alertType') alertType?: string) {
    return this.rules.listEscalations({ alertType });
  }

  @Post('escalation-rules')
  @RequirePermissions('automation.manage')
  @ApiOperation({
    summary:
      'Add an escalation level (audited); at most 5 levels, each fires once per alert',
  })
  @OK('Created')
  createEscalation(
    @Body() dto: CreateEscalationRuleDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.rules.createEscalation(dto, a, m);
  }

  @Put('escalation-rules/:id')
  @RequirePermissions('automation.manage')
  @OK('Updated')
  updateEscalation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEscalationRuleDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.rules.updateEscalation(id, dto, a, m);
  }

  @Get('alerts')
  @RequirePermissions('automation.read')
  @ApiOperation({ summary: 'Operational alerts (open and resolved history)' })
  @OK('Alerts')
  alerts(@Query() q: ListAlertsQueryDto) {
    return this.rules.listAlerts(q);
  }

  @Get('alerts/:id')
  @RequirePermissions('automation.read')
  @OK('Alert with the notifications it produced')
  alert(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.getAlert(id);
  }

  @Get('scheduler')
  @RequirePermissions('automation.read')
  @OK('Scheduler configuration')
  schedulerStatus() {
    return this.scheduler.status();
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('automation.manage')
  @ApiOperation({
    summary: 'Run scheduler tasks now (outbox → dispatch → alerts)',
    description:
      'The same idempotent tasks the scheduler runs; useful after configuration changes and for operations.',
  })
  @OK('Results per task')
  async run(@Body() dto: RunTasksDto) {
    const tasks = dto.tasks?.length ? dto.tasks : [...SCHEDULER_TASKS];
    const out: Record<string, unknown> = {};
    for (const t of SCHEDULER_TASKS)
      if (tasks.includes(t)) out[t] = await this.scheduler.run(t);
    return out;
  }
}
