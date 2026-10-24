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
import { ComponentOptionsService } from './component-options.service.js';
import {
  CreateComponentOptionDto,
  ListComponentOptionsQueryDto,
  PaginatedComponentOptionsDto,
  ComponentOptionResponseDto,
  UpdateComponentOptionDto,
} from './component-option.dto.js';

@ApiTags('Master Data')
@Controller('admin/component-options')
export class ComponentOptionsController {
  constructor(private readonly service: ComponentOptionsService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({
    summary: 'List label/packaging components (archived hidden by default)',
  })
  @ApiOkResponse({ type: PaginatedComponentOptionsDto })
  list(@Query() query: ListComponentOptionsQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Get a label/packaging component' })
  @ApiOkResponse({ type: ComponentOptionResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Create a label/packaging component' })
  @ApiCreatedResponse({ type: ComponentOptionResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Code already in use',
  })
  create(
    @Body() dto: CreateComponentOptionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({
    summary: 'Update a label/packaging component (code is immutable)',
  })
  @ApiOkResponse({ type: ComponentOptionResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateComponentOptionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({
    summary: 'Archive a label/packaging component (soft delete)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Already archived',
  })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.archive(id, actor, meta);
  }
}
