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
  Put,
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
import { FabricsService } from './fabrics.service.js';
import {
  CreateFabricColorDto,
  CreateFabricDto,
  FabricColorResponseDto,
  ProductFabricResponseDto,
  SetProductFabricDto,
  UpdateFabricColorDto,
  ListFabricColorsQueryDto,
  ListFabricsQueryDto,
  PaginatedFabricsDto,
  FabricResponseDto,
  UpdateFabricDto,
} from './fabric.dto.js';

@ApiTags('Master Data')
@Controller('admin/fabrics')
export class FabricsController {
  constructor(private readonly service: FabricsService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'List fabrics (archived hidden by default)' })
  @ApiOkResponse({ type: PaginatedFabricsDto })
  list(@Query() query: ListFabricsQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Get a fabric' })
  @ApiOkResponse({ type: FabricResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Create a fabric' })
  @ApiCreatedResponse({ type: FabricResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Code already in use',
  })
  create(
    @Body() dto: CreateFabricDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Update a fabric (code is immutable)' })
  @ApiOkResponse({ type: FabricResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFabricDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Archive a fabric (soft delete)' })
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

  @Get(':id/colors')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: "List a fabric's colours/swatches" })
  @ApiOkResponse({ type: [FabricColorResponseDto] })
  listColors(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListFabricColorsQueryDto,
  ) {
    return this.service.listColors(id, query.includeArchived);
  }

  @Post(':id/colors')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Add a predefined colour to a fabric' })
  @ApiCreatedResponse({ type: FabricColorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Colour name already exists for this fabric',
  })
  createColor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFabricColorDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.createColor(id, dto, actor, meta);
  }
}

@ApiTags('Master Data')
@Controller('admin/fabric-colors')
export class FabricColorsController {
  constructor(private readonly service: FabricsService) {}

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Update a fabric colour' })
  @ApiOkResponse({ type: FabricColorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFabricColorDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.updateColor(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Archive a fabric colour' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.archiveColor(id, actor, meta);
  }
}

@ApiTags('Master Data')
@Controller('admin/product-types/:productTypeId/fabrics')
export class ProductFabricsController {
  constructor(private readonly service: FabricsService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Fabrics recommended/allowed for a product type' })
  @ApiOkResponse({ type: [ProductFabricResponseDto] })
  list(@Param('productTypeId', ParseUUIDPipe) productTypeId: string) {
    return this.service.listProductFabrics(productTypeId);
  }

  @Put(':fabricId')
  @RequirePermissions('master_data.manage')
  @ApiOperation({
    summary: 'Set (create or update) product ↔ fabric compatibility',
    description:
      'Guidance for the future configurator: recommended / allowed flags and notes. Not a hard restriction.',
  })
  @ApiOkResponse({ type: ProductFabricResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  set(
    @Param('productTypeId', ParseUUIDPipe) productTypeId: string,
    @Param('fabricId', ParseUUIDPipe) fabricId: string,
    @Body() dto: SetProductFabricDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.setProductFabric(
      productTypeId,
      fabricId,
      dto,
      actor,
      meta,
    );
  }

  @Delete(':fabricId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Remove a compatibility entry' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  remove(
    @Param('productTypeId', ParseUUIDPipe) productTypeId: string,
    @Param('fabricId', ParseUUIDPipe) fabricId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.removeProductFabric(
      productTypeId,
      fabricId,
      actor,
      meta,
    );
  }
}
