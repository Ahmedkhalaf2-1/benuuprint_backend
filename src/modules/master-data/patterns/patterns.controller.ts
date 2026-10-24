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
import { RequirePermissions } from '../../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../../common/types/auth-user.js';
import {
  CreatePatternDto,
  CreatePatternVersionDto,
  ListPatternsQueryDto,
  PaginatedPatternsDto,
  PatternDetailResponseDto,
  PatternVersionResponseDto,
  UpdatePatternDto,
  UpdatePatternVersionDto,
} from './pattern.dto.js';
import { PatternsService } from './patterns.service.js';

@ApiTags('Patterns')
@Controller('admin/patterns')
export class PatternsController {
  constructor(private readonly patterns: PatternsService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'List patterns (archived hidden by default)' })
  @ApiOkResponse({ type: PaginatedPatternsDto })
  list(@Query() query: ListPatternsQueryDto) {
    return this.patterns.list(query);
  }

  @Get(':id')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Get a pattern with all of its versions' })
  @ApiOkResponse({ type: PatternDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.patterns.get(id);
  }

  @Post()
  @RequirePermissions('patterns.manage')
  @ApiOperation({ summary: 'Create a pattern (starts with DRAFT version 1)' })
  @ApiCreatedResponse({ type: PatternDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Code already in use',
  })
  create(
    @Body() dto: CreatePatternDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.patterns.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('patterns.manage')
  @ApiOperation({ summary: 'Update pattern details (code is immutable)' })
  @ApiOkResponse({ type: PatternDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePatternDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.patterns.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('patterns.manage')
  @ApiOperation({ summary: 'Archive a pattern (versions and files are kept)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.patterns.archive(id, actor, meta);
  }

  @Post(':id/versions')
  @RequirePermissions('patterns.manage')
  @ApiOperation({
    summary: 'Start a new DRAFT version (only one draft at a time)',
  })
  @ApiCreatedResponse({ type: PatternVersionResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'A draft version already exists',
  })
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePatternVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.patterns.createVersion(id, dto, actor, meta);
  }

  @Patch(':id/versions/:versionId')
  @RequirePermissions('patterns.manage')
  @ApiOperation({
    summary: 'Edit a DRAFT version (approved versions are immutable)',
  })
  @ApiOkResponse({ type: PatternVersionResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Version is not a draft',
  })
  updateVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: UpdatePatternVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.patterns.updateVersion(id, versionId, dto, actor, meta);
  }

  @Post(':id/versions/:versionId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('patterns.manage')
  @ApiOperation({
    summary: 'Approve a DRAFT version',
    description:
      "Makes it the pattern's current version, supersedes the previous one and freezes its files.",
  })
  @ApiOkResponse({ type: PatternDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Version is not a draft',
  })
  approveVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.patterns.approveVersion(id, versionId, actor, meta);
  }
}
