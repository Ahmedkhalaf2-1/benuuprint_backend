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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { ProductionSpecResponseDto } from './dto/sample-spec.dto.js';
import {
  CreateSampleDto,
  ListSamplesQueryDto,
  PaginatedSamplesDto,
  SampleDetailResponseDto,
  SampleStatusHistoryDto,
  UpdateSampleDto,
} from './dto/sample.dto.js';
import { SampleProductionSpecService } from './sample-production-spec.service.js';
import { SamplesService } from './samples.service.js';

@ApiTags('Samples')
@Controller('admin/samples')
export class SamplesController {
  constructor(
    private readonly samples: SamplesService,
    private readonly specs: SampleProductionSpecService,
  ) {}

  @Get()
  @RequirePermissions('samples.read')
  @ApiOperation({
    summary: 'List samples',
    description:
      'Search by sample number, customer number/name/email/phone or brand. Filter by status (one or several), sales owner, product, fabric, payment state, approval state and created/submitted date ranges. Archived samples are hidden by default.',
  })
  @ApiOkResponse({ type: PaginatedSamplesDto })
  list(@Query() query: ListSamplesQueryDto) {
    return this.samples.list(query);
  }

  @Get(':id')
  @RequirePermissions('samples.read')
  @ApiOperation({
    summary:
      'Get a sample with its full specification and the actions currently allowed',
  })
  @ApiOkResponse({ type: SampleDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.samples.get(id);
  }

  @Post()
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Create a DRAFT sample',
    description:
      'Only customerId and brandId are required; everything else can be filled in later. SMP-… number is generated. Use productTypeId OR customProductName, fabricId OR customFabricName, fabricColorId OR custom colour fields.',
  })
  @ApiCreatedResponse({ type: SampleDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Customer is archived or blocked',
  })
  create(
    @Body() dto: CreateSampleDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Edit a sample',
    description:
      'DRAFT: every field. SUBMITTED / UNDER_REVIEW: only the free-text note fields. Later statuses: locked (create a revision). Omitted = unchanged, null = clear. Mutually exclusive pairs must be switched explicitly.',
  })
  @ApiOkResponse({ type: SampleDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The specification is locked in this status',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSampleDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Archive a DRAFT, CANCELLED or REJECTED sample (soft delete)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.archive(id, actor, meta);
  }

  @Post(':id/revise')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Create a revision of a submitted/approved sample',
    description:
      'Approved samples are never edited. This creates a new DRAFT sample (new SMP number, revisionNumber + 1, revisionOfId set) that copies the specification, decorations, accessories, components and files. Quotations, payments, approvals, notes and terms acceptance are not copied.',
  })
  @ApiCreatedResponse({ type: SampleDetailResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Sample is a DRAFT or already has an open revision',
  })
  revise(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.samples.revise(id, actor, meta);
  }

  @Get(':id/status-history')
  @RequirePermissions('samples.read')
  @ApiOperation({ summary: 'Append-only timeline of status changes' })
  @ApiOkResponse({ type: [SampleStatusHistoryDto] })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.samples.history(id);
  }

  @Get(':id/production-spec')
  @RequirePermissions('samples.read')
  @ApiOperation({
    summary:
      'The frozen production specification of an approved sample (latest revision)',
    description:
      'Immutable snapshot created when the sample was approved. Factory jobs read this, never live master data.',
  })
  @ApiOkResponse({ type: ProductionSpecResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Not approved yet',
  })
  productionSpec(@Param('id', ParseUUIDPipe) id: string) {
    return this.specs.latest(id);
  }

  @Get(':id/production-specs')
  @RequirePermissions('samples.read')
  @ApiOperation({
    summary: 'All frozen production specification revisions, newest first',
  })
  @ApiOkResponse({ type: [ProductionSpecResponseDto] })
  productionSpecs(@Param('id', ParseUUIDPipe) id: string) {
    return this.specs.list(id);
  }
}
