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
import { ProductTypesService } from './product-types.service.js';
import {
  CreateProductTypeDto,
  ListProductTypesQueryDto,
  PaginatedProductTypesDto,
  ProductTypeResponseDto,
  UpdateProductTypeDto,
} from './product-type.dto.js';

@ApiTags('Master Data')
@Controller('admin/product-types')
export class ProductTypesController {
  constructor(private readonly service: ProductTypesService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'List product types (archived hidden by default)' })
  @ApiOkResponse({ type: PaginatedProductTypesDto })
  list(@Query() query: ListProductTypesQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Get a product type' })
  @ApiOkResponse({ type: ProductTypeResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Create a product type' })
  @ApiCreatedResponse({ type: ProductTypeResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Code already in use',
  })
  create(
    @Body() dto: CreateProductTypeDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Update a product type (code is immutable)' })
  @ApiOkResponse({ type: ProductTypeResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductTypeDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Archive a product type (soft delete)' })
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
