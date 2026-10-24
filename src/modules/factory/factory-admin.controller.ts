import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
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
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { BoardQueryDto, ProductionBoardDto } from './dto/board.dto.js';
import {
  BlockerResponseDto,
  ChangePriorityDto,
  CreateFactoryJobDto,
  CreateJobNoteDto,
  FactoryJobDetailDto,
  JobNoteResponseDto,
  JobStageResponseDto,
  ListFactoryJobsQueryDto,
  ManualReworkDto,
  PaginatedActivitiesDto,
  PaginatedFactoryJobsDto,
  RaiseBlockerDto,
  ReasonBodyDto,
  ReworkResponseDto,
  ResolveBlockerDto,
  UnblockStageDto,
  TimelineQueryDto,
  UpdateInternalNotesDto,
} from './dto/factory-job.dto.js';
import {
  CreateQcTemplateVersionDto,
  ListQcTemplatesQueryDto,
  PaginatedQcTemplatesDto,
  QcInspectionResponseDto,
  QcTemplateResponseDto,
} from './dto/qc.dto.js';
import { AssignStageDto, OverrideStageDto } from './dto/stage-ops.dto.js';
import { FactoryJobsService } from './factory-jobs.service.js';
import { ProductionBoardService } from './production-board.service.js';
import { StageReportsResponseDto } from './dto/quantity.dto.js';
import { StageQuantityService } from './stage-quantity.service.js';
import { QcService } from './qc.service.js';
import { ReworkService } from './rework.service.js';
import { StageOperationsService } from './stage-operations.service.js';

@ApiTags('Factory Jobs')
@Controller('admin')
export class FactoryJobsAdminController {
  constructor(
    private readonly jobs: FactoryJobsService,
    private readonly stages: StageOperationsService,
  ) {}

  @Post('samples/:sampleId/create-factory-job')
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({
    summary: 'Create a factory job from an approved, paid sample',
    description:
      "Pins the sample's immutable production specification and the active workflow version, then instantiates the stages. Rejects unapproved/unpaid samples, a missing or tampered specification, and a sample that already has a live job.",
  })
  @ApiCreatedResponse({ type: FactoryJobDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateFactoryJobDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.createFromSample(sampleId, dto, actor, meta);
  }

  @Get('factory-jobs')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({ summary: 'List factory jobs (paginated, filterable)' })
  @ApiOkResponse({ type: PaginatedFactoryJobsDto })
  list(@Query() query: ListFactoryJobsQueryDto) {
    return this.jobs.list(query);
  }

  @Get('factory-jobs/:id')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({ summary: 'Get a job with its stages' })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(id);
  }

  @Get('factory-jobs/:id/stages')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({
    summary: 'List the stages of a job (rework occurrences included)',
  })
  @ApiOkResponse({ type: [JobStageResponseDto] })
  async listStages(@Param('id', ParseUUIDPipe) id: string) {
    return (await this.jobs.get(id)).stages;
  }

  @Post('factory-jobs/:id/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Release a PLANNED job to the factory floor' })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  release(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.release(id, actor, meta);
  }

  @Patch('factory-jobs/:id/priority')
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Change job priority' })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  priority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangePriorityDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.changePriority(id, dto.priority, dto.reason, actor, meta);
  }

  @Patch('factory-jobs/:id/internal-notes')
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: "Update the job's internal remarks" })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  internalNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInternalNotesDto,
  ) {
    return this.jobs.updateInternalNotes(id, dto.internalNotes);
  }

  @Post('factory-jobs/:id/hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Put a job on hold (reason required)' })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  hold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonBodyDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.hold(id, dto.reason, actor, meta);
  }

  @Post('factory-jobs/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Resume a held job' })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.resume(id, actor, meta);
  }

  @Post('factory-jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Cancel a job (reason required; history is kept)' })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonBodyDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.cancel(id, dto.reason, actor, meta);
  }

  @Post('factory-jobs/:id/force-complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stages.override')
  @ApiOperation({
    summary: 'Admin override: finish a job without completing every stage',
    description:
      'Open stages are skipped/cancelled, the reason is mandatory and the action is audited.',
  })
  @ApiOkResponse({ type: FactoryJobDetailDto })
  forceComplete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonBodyDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.forceComplete(id, dto.reason, actor, meta);
  }

  @ApiTags('Production Timeline')
  @Get('factory-jobs/:id/timeline')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({ summary: 'Operational timeline of a job (oldest first)' })
  @ApiOkResponse({ type: PaginatedActivitiesDto })
  timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TimelineQueryDto,
  ) {
    return this.jobs.timeline(id, query.page, query.pageSize, query.jobStageId);
  }

  @Get('factory-jobs/:id/notes')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({ summary: 'Internal production notes of a job' })
  @ApiOkResponse({ type: [JobNoteResponseDto] })
  listNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('jobStageId') jobStageId?: string,
  ) {
    return this.jobs.listNotes(id, jobStageId);
  }

  @Post('factory-jobs/:id/notes')
  @RequirePermissions('production_notes.create')
  @ApiOperation({
    summary: 'Add an internal production note (never customer-visible)',
  })
  @ApiCreatedResponse({ type: JobNoteResponseDto })
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateJobNoteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jobs.addNote(id, dto, actor);
  }

  @Delete('factory-jobs/:id/notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Archive a note (kept in the database)' })
  archiveNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.archiveNote(id, noteId, actor, meta);
  }
}

@ApiTags('Blockers')
@Controller('admin')
export class BlockersAdminController {
  constructor(private readonly stages: StageOperationsService) {}

  @Get('factory-jobs/:id/blockers')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({ summary: 'Blockers of a job' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['OPEN', 'RESOLVED', 'CANCELLED'],
  })
  @ApiOkResponse({ type: [BlockerResponseDto] })
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: 'OPEN' | 'RESOLVED' | 'CANCELLED',
  ) {
    return this.stages.listBlockers(id, status);
  }

  @Post('factory-jobs/:id/blockers')
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Block the whole job' })
  @ApiCreatedResponse({ type: BlockerResponseDto })
  raiseForJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RaiseBlockerDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.raiseJobBlocker(id, dto, actor, meta);
  }

  @Post('job-stages/:stageId/blockers')
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Block a stage (admin)' })
  @ApiCreatedResponse({ type: BlockerResponseDto })
  raiseForStage(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: RaiseBlockerDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.raiseStageBlocker(
      stageId,
      dto,
      actor,
      { admin: true },
      meta,
    );
  }

  @Post('job-stages/:stageId/unblock')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Resolve the open blockers of a stage' })
  @ApiOkResponse({ type: JobStageResponseDto })
  unblock(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: UnblockStageDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.unblockStage(stageId, dto, actor, meta);
  }

  @Post('blockers/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Resolve a blocker (admin)' })
  @ApiOkResponse({ type: BlockerResponseDto })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveBlockerDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.resolveBlocker(id, dto, actor, { admin: true }, meta);
  }

  @Post('blockers/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Cancel a blocker raised in error' })
  @ApiOkResponse({ type: BlockerResponseDto })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveBlockerDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.cancelBlocker(id, dto, actor, meta);
  }
}

@ApiTags('Production Stages', 'Stage Assignments', 'Rework')
@Controller('admin')
export class StagesAdminController {
  constructor(
    private readonly stages: StageOperationsService,
    private readonly rework: ReworkService,
    private readonly quantities: StageQuantityService,
  ) {}

  @Get('job-stages/:stageId')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({ summary: 'Get one job stage with assignees' })
  @ApiOkResponse({ type: JobStageResponseDto })
  get(@Param('stageId', ParseUUIDPipe) stageId: string) {
    return this.stages.getStage(stageId);
  }

  @Get('job-stages/:stageId/production-reports')
  @RequirePermissions('jobs.read_all')
  @ApiTags('Production Quantities')
  @ApiOperation({
    summary: 'Quantity reports and totals of a stage (bulk jobs)',
  })
  @ApiOkResponse({ type: StageReportsResponseDto })
  reports(@Param('stageId', ParseUUIDPipe) stageId: string) {
    return this.quantities.list(stageId);
  }

  @Post('job-stages/:stageId/assignments')
  @RequirePermissions('jobs.assign')
  @ApiOperation({
    summary: 'Assign a staff member to a stage (several assignees allowed)',
    description:
      'The assignee must be active, hold stages.start and have a role eligible for the stage definition.',
  })
  @ApiCreatedResponse({ type: JobStageResponseDto })
  assign(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: AssignStageDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.assign(stageId, dto, actor, meta);
  }

  @Delete('job-stages/:stageId/assignments/:assignmentId')
  @RequirePermissions('jobs.assign')
  @ApiOperation({ summary: 'Remove an assignee (history kept)' })
  @ApiOkResponse({ type: JobStageResponseDto })
  unassign(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.unassign(stageId, assignmentId, actor, meta);
  }

  @Post('job-stages/:stageId/hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Put one stage on hold' })
  @ApiOkResponse({ type: JobStageResponseDto })
  hold(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: ReasonBodyDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.holdStage(stageId, dto.reason, actor, meta);
  }

  @Post('job-stages/:stageId/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('factory_jobs.manage')
  @ApiOperation({ summary: 'Resume a held stage' })
  @ApiOkResponse({ type: JobStageResponseDto })
  resume(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.resumeStage(stageId, actor, meta);
  }

  @Post('job-stages/:stageId/override')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stages.override')
  @ApiOperation({
    summary: 'Admin override: force-complete or skip a stage',
    description:
      'Reason mandatory; audited. Overriding a QC gate additionally needs qc.manage.',
  })
  @ApiOkResponse({ type: JobStageResponseDto })
  override(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: OverrideStageDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.override(stageId, dto, actor, meta);
  }

  @Post('job-stages/:stageId/rework')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rework.manage')
  @ApiOperation({
    summary:
      'Send work back to an earlier stage (creates new occurrences; history kept)',
  })
  manualRework(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: ManualReworkDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stages.manualRework(stageId, dto, actor, meta);
  }

  @Get('factory-jobs/:id/rework')
  @RequirePermissions('jobs.read_all')
  @ApiOperation({ summary: 'Rework history of a job' })
  @ApiOkResponse({ type: [ReworkResponseDto] })
  listRework(@Param('id', ParseUUIDPipe) id: string) {
    return this.rework.list(id);
  }
}

@ApiTags('QC')
@Controller('admin')
export class QcAdminController {
  constructor(private readonly qc: QcService) {}

  @Get('qc-templates')
  @RequirePermissions('qc.read')
  @ApiOperation({ summary: 'List QC checklist templates (all versions)' })
  @ApiOkResponse({ type: PaginatedQcTemplatesDto })
  list(@Query() query: ListQcTemplatesQueryDto) {
    return this.qc.listTemplates(query);
  }

  @Get('qc-templates/:id')
  @RequirePermissions('qc.read')
  @ApiOperation({ summary: 'Get a QC template with its checklist' })
  @ApiOkResponse({ type: QcTemplateResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.qc.getTemplate(id);
  }

  @Post('qc-templates')
  @RequirePermissions('qc.manage')
  @ApiOperation({
    summary: 'Publish a new version of a QC checklist',
    description:
      'Checklists are immutable; this creates version N+1 and retires the active one. Running jobs keep the version they started with.',
  })
  @ApiCreatedResponse({ type: QcTemplateResponseDto })
  create(
    @Body() dto: CreateQcTemplateVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.qc.createVersion(dto, actor, meta);
  }

  @Get('factory-jobs/:id/qc-inspections')
  @RequirePermissions('qc.read')
  @ApiOperation({ summary: 'QC inspections of a job (every attempt)' })
  @ApiOkResponse({ type: [QcInspectionResponseDto] })
  listForJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.qc.listForJob(id);
  }

  @Get('qc-inspections/:id')
  @RequirePermissions('qc.read')
  @ApiOperation({ summary: 'Get a QC inspection with results' })
  @ApiOkResponse({ type: QcInspectionResponseDto })
  getInspection(@Param('id', ParseUUIDPipe) id: string) {
    return this.qc.get(id);
  }
}

@ApiTags('Production Board')
@Controller('admin/production')
export class ProductionBoardController {
  constructor(private readonly board: ProductionBoardService) {}

  @Get('board')
  @RequirePermissions('production_board.read')
  @ApiOperation({
    summary:
      'Production board: one column per stage with counts and a page of cards',
    description:
      'Cards are the current (non-superseded) stage occurrences, ordered by job priority then due date. Pass stageCode (+page/pageSize) to page through one column.',
  })
  @ApiOkResponse({ type: ProductionBoardDto })
  get(@Query() query: BoardQueryDto) {
    return this.board.board(query);
  }
}
