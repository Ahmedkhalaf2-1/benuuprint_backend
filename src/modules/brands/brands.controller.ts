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
import { BrandsService } from './brands.service.js';
import {
  BrandDetailResponseDto,
  CreateBrandDto,
  ListBrandsQueryDto,
  PaginatedBrandsDto,
  UpdateBrandDto,
} from './dto/brand.dto.js';

@ApiTags('Brands')
@Controller('admin')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get('customers/:customerId/brands')
  @RequirePermissions('customers.read')
  @ApiOperation({
    summary: "List a customer's brands (archived hidden by default)",
  })
  @ApiOkResponse({ type: PaginatedBrandsDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  list(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: ListBrandsQueryDto,
  ) {
    return this.brands.listForCustomer(customerId, query);
  }

  @Post('customers/:customerId/brands')
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Create a brand for a customer (brandNumber is generated)',
  })
  @ApiCreatedResponse({ type: BrandDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Customer not found',
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Duplicate brand name for this customer, or customer archived',
  })
  create(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateBrandDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.brands.create(customerId, dto, actor, meta);
  }

  @Get('brands/:id')
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'Get a brand with its customer' })
  @ApiOkResponse({ type: BrandDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.brands.get(id);
  }

  @Patch('brands/:id')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Update a brand (null clears optional fields)' })
  @ApiOkResponse({ type: BrandDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.brands.update(id, dto, actor, meta);
  }

  @Delete('brands/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Archive a brand (soft delete)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.brands.archive(id, actor, meta);
  }
}
