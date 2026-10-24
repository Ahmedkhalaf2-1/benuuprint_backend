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
import { SizesService } from './sizes.service.js';
import { MasterDataListQueryDto } from '../master-data.base.js';
import {
  CreateSizeOptionDto,
  CreateSizeScaleDto,
  SizeOptionResponseDto,
  PaginatedSizeScalesDto,
  SizeScaleResponseDto,
  UpdateSizeOptionDto,
  UpdateSizeScaleDto,
} from './size.dto.js';

@ApiTags('Master Data')
@Controller('admin/size-scales')
export class SizeScalesController {
  constructor(private readonly service: SizesService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'List size scales (archived hidden by default)' })
  @ApiOkResponse({ type: PaginatedSizeScalesDto })
  list(@Query() query: MasterDataListQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Get a size scale' })
  @ApiOkResponse({ type: SizeScaleResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Create a size scale' })
  @ApiCreatedResponse({ type: SizeScaleResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Code already in use',
  })
  create(
    @Body() dto: CreateSizeScaleDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Update a size scale (code is immutable)' })
  @ApiOkResponse({ type: SizeScaleResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSizeScaleDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Archive a size scale (soft delete)' })
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

  @Post(':id/sizes')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Add a size to a scale' })
  @ApiCreatedResponse({ type: SizeOptionResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Size code already exists in this scale',
  })
  createSize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSizeOptionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.createOption(id, dto, actor, meta);
  }
}

@ApiTags('Master Data')
@Controller('admin/size-options')
export class SizeOptionsController {
  constructor(private readonly service: SizesService) {}

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Update a size option (code is immutable)' })
  @ApiOkResponse({ type: SizeOptionResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSizeOptionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.updateOption(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Archive a size option' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.archiveOption(id, actor, meta);
  }
}
