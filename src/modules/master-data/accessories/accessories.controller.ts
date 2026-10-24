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
import { AccessoriesService } from './accessories.service.js';
import {
  CreateAccessoryDto,
  ListAccessoriesQueryDto,
  PaginatedAccessoriesDto,
  AccessoryResponseDto,
  UpdateAccessoryDto,
} from './accessory.dto.js';

@ApiTags('Master Data')
@Controller('admin/accessories')
export class AccessoriesController {
  constructor(private readonly service: AccessoriesService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'List accessories (archived hidden by default)' })
  @ApiOkResponse({ type: PaginatedAccessoriesDto })
  list(@Query() query: ListAccessoriesQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Get a accessory' })
  @ApiOkResponse({ type: AccessoryResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Create a accessory' })
  @ApiCreatedResponse({ type: AccessoryResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Code already in use',
  })
  create(
    @Body() dto: CreateAccessoryDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Update a accessory (code is immutable)' })
  @ApiOkResponse({ type: AccessoryResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccessoryDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Archive a accessory (soft delete)' })
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
