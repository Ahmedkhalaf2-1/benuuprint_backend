import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import {
  AssetResponseDto,
  DownloadUrlResponseDto,
} from '../assets/dto/asset.dto.js';
import type { UploadedFileInput } from '../assets/assets.service.js';
import {
  BlockerResponseDto,
  CreateJobNoteDto,
  JobNoteResponseDto,
  JobStageResponseDto,
  RaiseBlockerDto,
  ResolveBlockerDto,
} from './dto/factory-job.dto.js';
import {
  CompleteQcInspectionDto,
  QcInspectionResponseDto,
  SaveQcResultsDto,
} from './dto/qc.dto.js';
import { CompleteStageDto } from './dto/stage-ops.dto.js';
import {
  ListMyJobsQueryDto,
  ListMyStagesQueryDto,
  PaginatedStaffJobsDto,
  PaginatedStaffStagesDto,
  StaffStageDetailDto,
  UploadEvidenceDto,
} from './dto/staff-tasks.dto.js';
import { QcService } from './qc.service.js';
import {
  ReportQuantityDto,
  StageReportsResponseDto,
} from './dto/quantity.dto.js';
import { ReportPackagingDto } from './dto/packaging.dto.js';
import { PackagingReportsService } from './packaging-reports.service.js';
import { StageQuantityService } from './stage-quantity.service.js';
import { StaffTasksService } from './staff-tasks.service.js';
import { StageOperationsService } from './stage-operations.service.js';

const UPLOAD_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: { type: 'string', format: 'binary' },
      type: {
        type: 'string',
        enum: [
          'STAGE_PHOTO',
          'QC_PHOTO',
          'PATTERN_OUTPUT',
          'PRINT_PROOF',
          'PRODUCTION_REFERENCE',
          'OTHER',
        ],
      },
      description: { type: 'string' },
    },
  },
};

/** Floor-facing API: staff only ever see and touch stages they are assigned to. */
@ApiTags('Staff Factory Tasks')
@Controller('staff')
export class StaffTasksController {
  constructor(
    private readonly tasks: StaffTasksService,
    private readonly stages: StageOperationsService,
    private readonly qc: QcService,
    private readonly quantities: StageQuantityService,
    private readonly packaging: PackagingReportsService,
  ) {}

  @Get('my-jobs')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary: 'My Jobs: jobs where I am assigned to at least one stage',
  })
  @ApiOkResponse({ type: PaginatedStaffJobsDto })
  myJobs(@CurrentUser() actor: AuthUser, @Query() query: ListMyJobsQueryDto) {
    return this.tasks.myJobs(actor, query);
  }

  @Get('my-stages')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary: 'My Stages: the stages assigned to me (open ones by default)',
  })
  @ApiOkResponse({ type: PaginatedStaffStagesDto })
  myStages(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListMyStagesQueryDto,
  ) {
    return this.tasks.myStages(actor, query);
  }

  @Get('job-stages/:stageId')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary: 'Task view of one stage',
    description:
      'Shows the department-specific part of the frozen approved specification, blockers, notes, files and the actions the caller may take now. No prices, payments or customer contact details.',
  })
  @ApiOkResponse({ type: StaffStageDetailDto })
  detail(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tasks.stageDetail(stageId, actor);
  }

  @Get('my-stages/:stageId')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({ summary: 'Alias of GET /staff/job-stages/:stageId' })
  @ApiOkResponse({ type: StaffStageDetailDto })
  detailAlias(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tasks.stageDetail(stageId, actor);
  }

  @Get('job-stages/:stageId/files/:assetId/download-url')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary: 'Short-lived download URL for a file shown on this stage',
  })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  fileUrl(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tasks.fileDownloadUrl(stageId, assetId, actor);
  }

  @Post('job-stages/:stageId/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stages.start')
  @ApiOperation({ summary: 'Start a ready stage I am assigned to' })
  @ApiOkResponse({ type: JobStageResponseDto })
  start(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.stages.start(stageId, actor);
  }

  @Post('job-stages/:stageId/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stages.complete')
  @ApiOperation({
    summary: 'Complete a stage I started',
    description:
      "Enforces the stage's completion-note and attachment requirements. QC stages complete through their inspection.",
  })
  @ApiOkResponse({ type: JobStageResponseDto })
  complete(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: CompleteStageDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.stages.complete(stageId, dto, actor);
  }

  @Post('job-stages/:stageId/production-reports')
  @RequirePermissions('production_quantity.report')
  @ApiTags('Production Quantities')
  @ApiOperation({
    summary:
      'Report produced / rejected / rework units on my stage (bulk jobs)',
    description:
      'Append-only. A report can never push produced + rejected beyond what the stage must handle; the stage cannot be completed until every unit is accounted for.',
  })
  @ApiCreatedResponse({ type: StageReportsResponseDto })
  reportQuantity(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: ReportQuantityDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.quantities.report(stageId, dto, actor);
  }

  @Post('job-stages/:stageId/packaging-reports')
  @RequirePermissions('production_quantity.report')
  @ApiTags('Production Quantities', 'Order Packaging')
  @ApiOperation({
    summary: 'Report packed / damaged units and cartons on my packaging stage',
    description:
      'A packaging report is a quantity report (packed = produced, damaged = rejected) with carton details. Append-only; the order packaging specification must exist.',
  })
  @ApiCreatedResponse({ type: StageReportsResponseDto })
  reportPackaging(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: ReportPackagingDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.packaging.report(stageId, dto, actor);
  }

  @Get('job-stages/:stageId/production-reports')
  @RequirePermissions('jobs.read_assigned')
  @ApiTags('Production Quantities')
  @ApiOperation({ summary: 'Quantity reports of my stage' })
  @ApiOkResponse({ type: StageReportsResponseDto })
  listReports(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.quantities.listFor(stageId, actor);
  }

  @Post('job-stages/:stageId/notes')
  @RequirePermissions('production_notes.create')
  @ApiOperation({ summary: 'Add an internal note to my stage' })
  @ApiCreatedResponse({ type: JobNoteResponseDto })
  note(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: CreateJobNoteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tasks.addNote(stageId, dto.content, actor);
  }

  @Post('job-stages/:stageId/assets')
  @RequirePermissions('production_notes.create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_BODY)
  @ApiOperation({ summary: 'Upload a photo/file as evidence on my stage' })
  @ApiCreatedResponse({ type: AssetResponseDto })
  upload(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() dto: UploadEvidenceDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tasks.uploadStageEvidence(stageId, file, dto, actor, meta);
  }

  @Post('job-stages/:stageId/blockers')
  @RequirePermissions('stages.block')
  @ApiTags('Blockers')
  @ApiOperation({ summary: 'Report a blocker on my stage' })
  @ApiCreatedResponse({ type: BlockerResponseDto })
  block(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: RaiseBlockerDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.stages.raiseStageBlocker(stageId, dto, actor, { admin: false });
  }

  @Post('blockers/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stages.block')
  @ApiTags('Blockers')
  @ApiOperation({
    summary: 'Resolve a blocker I raised or that blocks my stage',
  })
  @ApiOkResponse({ type: BlockerResponseDto })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveBlockerDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.stages.resolveBlocker(id, dto, actor, { admin: false });
  }

  // ───────── QC ─────────

  @Post('job-stages/:stageId/qc/start')
  @RequirePermissions('qc.perform')
  @ApiTags('QC')
  @ApiOperation({ summary: 'Start the QC inspection of my QC stage' })
  @ApiCreatedResponse({ type: QcInspectionResponseDto })
  qcStart(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.qc.start(stageId, actor);
  }

  @Get('qc-inspections/:id')
  @RequirePermissions('qc.perform')
  @ApiTags('QC')
  @ApiOperation({ summary: 'My QC inspection with its checklist' })
  @ApiOkResponse({ type: QcInspectionResponseDto })
  async qcGet(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    const inspection = await this.qc.get(id);
    if (
      inspection.inspectorUserId !== actor.id &&
      !actor.permissions.has('qc.read')
    ) {
      throw new NotFoundException('QC inspection not found');
    }
    return inspection;
  }

  @Put('qc-inspections/:id/results')
  @RequirePermissions('qc.perform')
  @ApiTags('QC')
  @ApiOperation({
    summary:
      'Record checklist results (can be called repeatedly until completion)',
  })
  @ApiOkResponse({ type: QcInspectionResponseDto })
  qcResults(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveQcResultsDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.qc.saveResults(id, dto, actor);
  }

  @Post('qc-inspections/:id/photos')
  @RequirePermissions('qc.perform')
  @UseInterceptors(FileInterceptor('file'))
  @ApiTags('QC')
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_BODY)
  @ApiOperation({ summary: 'Attach a QC photo to my inspection' })
  @ApiCreatedResponse({ type: AssetResponseDto })
  qcPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() dto: UploadEvidenceDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tasks.uploadQcPhoto(id, file, dto, actor, meta);
  }

  @Post('qc-inspections/:id/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('qc.perform')
  @ApiTags('QC', 'Rework')
  @ApiOperation({
    summary: 'Complete the inspection (PASS, CONDITIONAL_PASS or FAIL)',
    description:
      'PASS / CONDITIONAL_PASS complete the QC stage; FAIL creates rework and a new re-check occurrence.',
  })
  @ApiOkResponse({ type: QcInspectionResponseDto })
  qcComplete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteQcInspectionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.qc.complete(id, dto, actor);
  }
}
