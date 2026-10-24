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
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { AttentionService } from './attention.service.js';
import { CapacityService } from './capacity.service.js';
import { DashboardService } from './dashboard.service.js';
import { DelayService } from './delay.service.js';
import {
  AttentionQueryDto,
  CreateDepartmentCapacityDto,
  CreateSlaRuleDto,
  CreateStaffCapacityDto,
  ManagementBoardQueryDto,
  RangeQueryDto,
  StaffWorkloadQueryDto,
  UpdateDepartmentCapacityDto,
  UpdateSlaRuleDto,
  UpdateStaffCapacityDto,
  UtilizationQueryDto,
} from './dto/management.dto.js';
import { EtaService } from './eta.service.js';
import { KpiService } from './kpi.service.js';
import { ManagementBoardService } from './management-board.service.js';
import { SlaService } from './sla.service.js';
import { WorkloadService } from './workload.service.js';
import { SlaTargetType } from '../../generated/prisma/client.js';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ToBoolean } from '../../common/transforms.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DepartmentType } from '../../generated/prisma/client.js';

const OK = (description: string) =>
  ApiOkResponse({
    description,
    schema: { type: 'object', additionalProperties: true },
  });

@ApiTags('Management Dashboard')
@Controller('admin')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly attention: AttentionService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('dashboard.read')
  @ApiOperation({
    summary: 'Management dashboard',
    description:
      'Needs Attention (top 10), sample/order pipelines and, where the caller holds the matching permission, production / orders / quality / workload / commercial / delivery summaries. Sections the caller may not see are absent.',
  })
  @OK('Dashboard')
  get(@CurrentUser() actor: AuthUser, @Query() q: RangeQueryDto) {
    return this.dashboard.get(actor, q);
  }

  @Get('management/needs-attention')
  @RequirePermissions('dashboard.read')
  @ApiOperation({
    summary: 'Prioritised list of operational problems',
    description:
      'Deterministic ranking (see docs). Commercial categories need commercial_kpis.read, QC categories need quality_kpis.read; others are filtered out for callers without them.',
  })
  @OK('Needs attention')
  list(@CurrentUser() actor: AuthUser, @Query() q: AttentionQueryDto) {
    return this.attention.list(q, actor);
  }
}

@ApiTags('Management KPIs')
@Controller('admin/management')
export class KpiController {
  constructor(private readonly kpis: KpiService) {}

  @Get('kpis/production')
  @RequirePermissions('management_kpis.read')
  @ApiOperation({ summary: 'Production KPIs (date range, business time zone)' })
  @OK('Production KPIs')
  production(@Query() q: RangeQueryDto) {
    return this.kpis.production(q);
  }

  @Get('kpis/orders')
  @RequirePermissions('management_kpis.read')
  @ApiOperation({ summary: 'Order KPIs' })
  @OK('Order KPIs')
  orders(@Query() q: RangeQueryDto) {
    return this.kpis.orders(q);
  }

  @Get('kpis/quality')
  @RequirePermissions('quality_kpis.read')
  @ApiOperation({
    summary: 'Quality KPIs: QC pass/fail, rework, rejected units',
  })
  @OK('Quality KPIs')
  quality(@Query() q: RangeQueryDto) {
    return this.kpis.quality(q);
  }

  @Get('kpis/commercial')
  @RequirePermissions('commercial_kpis.read')
  @ApiOperation({ summary: 'Commercial KPIs (Decimal, per currency)' })
  @OK('Commercial KPIs')
  commercial(@Query() q: RangeQueryDto) {
    return this.kpis.commercial(q);
  }

  @Get('kpis/delivery')
  @RequirePermissions('management_kpis.read')
  @ApiOperation({ summary: 'Delivery KPIs' })
  @OK('Delivery KPIs')
  delivery(@Query() q: RangeQueryDto) {
    return this.kpis.delivery(q);
  }

  @Get('bottlenecks')
  @RequirePermissions('management_kpis.read')
  @ApiOperation({
    summary:
      'Bottleneck analysis by stage, ordered by accumulated waiting time',
    description: 'Descriptive: shows where work waits, not why.',
  })
  @OK('Bottlenecks')
  bottlenecks(@Query() q: RangeQueryDto) {
    return this.kpis.bottlenecks(q);
  }
}

@ApiTags('Management Workload')
@Controller('admin/management')
export class WorkloadController {
  constructor(
    private readonly workload: WorkloadService,
    private readonly board: ManagementBoardService,
    private readonly delays: DelayService,
    private readonly eta: EtaService,
  ) {}

  @Get('workload/departments')
  @RequirePermissions('workload.read')
  @ApiOperation({
    summary:
      'Workload per department (ready / in progress / blocked / overdue / units / staff)',
  })
  @OK('Department workload')
  departments() {
    return this.workload.departments();
  }

  @Get('workload/staff')
  @RequirePermissions('workload.read')
  @ApiOperation({
    summary: 'Operational workload and delivery performance per staff member',
    description: 'Planning data only: no score, no ranking; ordered by name.',
  })
  @OK('Staff workload')
  staff(@Query() q: StaffWorkloadQueryDto) {
    return this.workload.staff(q);
  }

  @Get('wip')
  @RequirePermissions('workload.read')
  @ApiOperation({
    summary:
      'Work in progress per stage: queued, active, blocked, completed today',
  })
  @OK('WIP')
  wip() {
    return this.workload.wip();
  }

  @Get('production-board')
  @RequirePermissions('production_board.read')
  @ApiOperation({
    summary: 'Management production board: one row per live job',
    description:
      'Filters: stage, department, staff, priority, blocked, delayed, sample/bulk, customer, brand. ETA is included only for callers with eta.read.',
  })
  @OK('Production board')
  productionBoard(
    @CurrentUser() actor: AuthUser,
    @Query() q: ManagementBoardQueryDto,
  ) {
    return this.board.board(q, {
      includeEta: actor.permissions.has('eta.read'),
    });
  }

  @Get('jobs/:id/delay')
  @RequirePermissions('sla.read')
  @ApiOperation({
    summary: 'Delay reasons and SLA state of a job and of each current stage',
  })
  @OK('Job delay')
  jobDelay(@Param('id', ParseUUIDPipe) id: string) {
    return this.delays.jobDelay(id);
  }

  @Get('orders/:id/delay')
  @RequirePermissions('sla.read')
  @ApiOperation({ summary: 'Delay reasons and SLA state of an order' })
  @OK('Order delay')
  orderDelay(@Param('id', ParseUUIDPipe) id: string) {
    return this.delays.orderDelay(id);
  }

  @Get('jobs/:id/eta')
  @RequirePermissions('eta.read')
  @ApiOperation({
    summary: 'Estimated completion of a job, with its basis and data quality',
  })
  @OK('Job ETA')
  jobEta(@Param('id', ParseUUIDPipe) id: string) {
    return this.eta.job(id);
  }

  @Get('orders/:id/eta')
  @RequirePermissions('eta.read')
  @ApiOperation({
    summary: 'Production ETA and (separately) delivery ETA of an order',
    description: 'Delivery ETA is only given when shipment data supports it.',
  })
  @OK('Order ETA')
  orderEta(@Param('id', ParseUUIDPipe) id: string) {
    return this.eta.order(id);
  }
}

class SlaListQueryDto {
  @ApiPropertyOptional({ enum: SlaTargetType })
  @IsOptional()
  @IsEnum(SlaTargetType)
  targetType?: SlaTargetType;
  @ApiPropertyOptional()
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  active?: boolean;
}

class DepartmentCapacityListDto {
  @ApiPropertyOptional({ enum: DepartmentType })
  @IsOptional()
  @IsEnum(DepartmentType)
  department?: DepartmentType;
  @ApiPropertyOptional()
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  activeOnly?: boolean;
}

class StaffCapacityListDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

@ApiTags('Management Configuration')
@Controller('admin/management')
export class ManagementConfigController {
  constructor(
    private readonly sla: SlaService,
    private readonly capacity: CapacityService,
  ) {}

  // ── SLA rules ──
  @Get('sla-rules')
  @RequirePermissions('sla.read')
  @ApiOperation({ summary: 'List SLA rules' })
  @OK('SLA rules')
  listSla(@Query() q: SlaListQueryDto) {
    return this.sla.list(q);
  }

  @Get('sla-rules/:id')
  @RequirePermissions('sla.read')
  @OK('SLA rule')
  getSla(@Param('id', ParseUUIDPipe) id: string) {
    return this.sla.get(id);
  }

  @Post('sla-rules')
  @RequirePermissions('sla.manage')
  @ApiOperation({ summary: 'Create an SLA rule (audited)' })
  @OK('Created')
  createSla(
    @Body() dto: CreateSlaRuleDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.sla.create(dto, a, m);
  }

  @Put('sla-rules/:id')
  @RequirePermissions('sla.manage')
  @ApiOperation({ summary: 'Update an SLA rule (audited)' })
  @OK('Updated')
  updateSla(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSlaRuleDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.sla.update(id, dto, a, m);
  }

  @Post('sla-rules/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('sla.manage')
  @ApiOperation({ summary: 'Deactivate an SLA rule (never deleted; audited)' })
  @OK('Deactivated')
  deactivateSla(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.sla.deactivate(id, a, m);
  }

  // ── department capacity ──
  @Get('capacity/departments')
  @RequirePermissions('capacity.read')
  @ApiOperation({ summary: 'Configured department capacity' })
  @OK('Capacity')
  listDepartments(@Query() q: DepartmentCapacityListDto) {
    return this.capacity.listDepartments(q);
  }

  @Post('capacity/departments')
  @RequirePermissions('capacity.manage')
  @ApiOperation({
    summary: 'Configure department capacity for a date range (audited)',
  })
  @OK('Created')
  createDepartment(
    @Body() dto: CreateDepartmentCapacityDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.capacity.createDepartment(dto, a, m);
  }

  @Put('capacity/departments/:id')
  @RequirePermissions('capacity.manage')
  @OK('Updated')
  updateDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentCapacityDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.capacity.updateDepartment(id, dto, a, m);
  }

  @Post('capacity/departments/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('capacity.manage')
  @OK('Deactivated')
  deactivateDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.capacity.deactivateDepartment(id, a, m);
  }

  // ── staff capacity (optional) ──
  @Get('capacity/staff')
  @RequirePermissions('capacity.read')
  @OK('Staff capacity')
  listStaff(@Query() q: StaffCapacityListDto) {
    return this.capacity.listStaff(q);
  }

  @Post('capacity/staff')
  @RequirePermissions('capacity.manage')
  @OK('Created')
  createStaff(
    @Body() dto: CreateStaffCapacityDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.capacity.createStaff(dto, a, m);
  }

  @Put('capacity/staff/:id')
  @RequirePermissions('capacity.manage')
  @OK('Updated')
  updateStaff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffCapacityDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.capacity.updateStaff(id, dto, a, m);
  }

  @Post('capacity/staff/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('capacity.manage')
  @OK('Deactivated')
  deactivateStaff(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.capacity.deactivateStaff(id, a, m);
  }

  // ── utilization ──
  @Get('capacity/utilization')
  @RequirePermissions('capacity.read')
  @ApiOperation({
    summary: 'Planned demand vs configured capacity per department and day',
    description:
      'Up to 31 days. A day without configured capacity has no utilization.',
  })
  @ApiQuery({ name: 'department', required: false })
  @OK('Utilization')
  utilization(@Query() q: UtilizationQueryDto) {
    return this.capacity.utilization(q);
  }
}

@ApiTags('Staff Workload')
@Controller('staff')
export class StaffWorkloadController {
  constructor(private readonly workload: WorkloadService) {}

  @Get('my-workload')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary:
      'My own workload: ready, in progress, overdue, due soon, completed today',
    description: 'Only the caller’s own numbers; no team-wide data.',
  })
  @OK('My workload')
  mine(@CurrentUser() actor: AuthUser) {
    return this.workload.mine(actor.id);
  }
}
