import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import {
  CreateTermsDto,
  ListTermsQueryDto,
  RecordTermsAcceptanceDto,
  TermsResponseDto,
} from './dto/sample-spec.dto.js';
import { SampleTermsAcceptanceDto } from './dto/sample.dto.js';
import { SampleTermsService } from './sample-terms.service.js';

@ApiTags('Terms')
@Controller('admin/terms')
export class TermsController {
  constructor(private readonly terms: SampleTermsService) {}

  @Get()
  @RequirePermissions('samples.read')
  @ApiOperation({ summary: 'List terms versions (newest first)' })
  @ApiOkResponse({ type: [TermsResponseDto] })
  list(@Query() query: ListTermsQueryDto) {
    return this.terms.list(query.code);
  }

  @Get(':id')
  @RequirePermissions('samples.read')
  @ApiOperation({ summary: 'Get a terms version' })
  @ApiOkResponse({ type: TermsResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.terms.get(id);
  }

  @Post()
  @RequirePermissions('terms.manage')
  @ApiOperation({
    summary: 'Publish the next version of a terms document',
    description:
      'The text is immutable once published. Use activate: true (or the activate endpoint) to make it the version customers must accept.',
  })
  @ApiCreatedResponse({ type: TermsResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  create(
    @Body() dto: CreateTermsDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.terms.create(dto, actor, meta);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('terms.manage')
  @ApiOperation({
    summary: 'Make this the active version (deactivates the previous one)',
  })
  @ApiOkResponse({ type: TermsResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.terms.activate(id, actor, meta);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('terms.manage')
  @ApiOperation({
    summary:
      'Deactivate a version (samples can then be submitted without accepting terms)',
  })
  @ApiOkResponse({ type: TermsResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.terms.deactivate(id, actor, meta);
  }
}

@ApiTags('Terms')
@Controller('admin/samples/:sampleId/terms-acceptances')
export class SampleTermsController {
  constructor(private readonly terms: SampleTermsService) {}

  @Post()
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary:
      "Record the customer's acceptance of the active sample terms (staff-recorded)",
    description:
      'Stored as STAFF_RECORDED_ON_BEHALF with the recording staff member, the evidence note and the request origin; it is not an authenticated customer acceptance. DRAFT only; required before submit while terms are active.',
  })
  @ApiCreatedResponse({ type: SampleTermsAcceptanceDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Already accepted, inactive version, or sample not DRAFT',
  })
  record(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: RecordTermsAcceptanceDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.terms.recordAcceptance(sampleId, dto, actor, meta);
  }
}
