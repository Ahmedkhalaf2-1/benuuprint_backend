import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ReqMeta } from '../../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import type {
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import {
  CreateAddressDto,
  UpdateAddressDto,
} from '../../customers/dto/contact-address.dto.js';
import { CustomerAddressResponseDto } from '../../customers/dto/customer.dto.js';
import {
  CurrentCustomer,
  CustomerRoute,
} from '../auth/customer-route.decorators.js';
import {
  CustomerBrandDto,
  CustomerCreateBrandDto,
  CustomerUpdateBrandDto,
  CustomerProfileDto,
  UpdateCustomerProfileDto,
} from '../dto/customer-profile.dto.js';
import { CustomerProfileService } from './customer-profile.service.js';

@ApiTags('Customer Profile')
@CustomerRoute()
@Controller('customer')
export class CustomerProfileController {
  constructor(private readonly profile: CustomerProfileService) {}

  @Get('profile')
  @ApiOperation({ summary: 'My profile' })
  @ApiOkResponse({ type: CustomerProfileDto })
  get(@CurrentCustomer() me: CustomerPrincipal) {
    return this.profile.profile(me);
  }

  @Patch('profile')
  @ApiOperation({
    summary: 'Update my contact details',
    description:
      'Phone, WhatsApp, country, city, Instagram and preferred language only. Name and login email are managed by Benue Print.',
  })
  @ApiOkResponse({ type: CustomerProfileDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  update(
    @CurrentCustomer() me: CustomerPrincipal,
    @Body() dto: UpdateCustomerProfileDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.profile.updateProfile(me, dto, meta);
  }

  @Get('addresses')
  @ApiOperation({ summary: 'My addresses' })
  @ApiOkResponse({ type: [CustomerAddressResponseDto] })
  addresses(@CurrentCustomer() me: CustomerPrincipal) {
    return this.profile.addresses(me);
  }

  @Post('addresses')
  @ApiOperation({ summary: 'Add an address' })
  @ApiCreatedResponse({ type: CustomerAddressResponseDto })
  createAddress(
    @CurrentCustomer() me: CustomerPrincipal,
    @Body() dto: CreateAddressDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.profile.createAddress(me, dto, meta);
  }

  @Patch('addresses/:id')
  @ApiOperation({ summary: 'Edit one of my addresses' })
  @ApiOkResponse({ type: CustomerAddressResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateAddress(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.profile.updateAddress(me, id, dto, meta);
  }
}

@ApiTags('Customer Profile')
@CustomerRoute()
@Controller('customer/brands')
export class CustomerBrandsController {
  constructor(private readonly profile: CustomerProfileService) {}

  @Get()
  @ApiOperation({
    summary: 'My brands',
    description: 'Archived brands are not listed.',
  })
  @ApiOkResponse({ type: [CustomerBrandDto] })
  list(@CurrentCustomer() me: CustomerPrincipal) {
    return this.profile.brands(me);
  }

  @Post()
  @ApiOperation({
    summary: 'Create my brand',
    description:
      'Creates a brand for the signed-in customer (always ACTIVE, usable for samples at once). Only public brand fields are accepted; the owner always comes from the session. A brand name already used by one of your brands answers 409.',
  })
  @ApiCreatedResponse({ type: CustomerBrandDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @CurrentCustomer() me: CustomerPrincipal,
    @Body() dto: CustomerCreateBrandDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.profile.createBrand(me, dto, meta);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit one of my brands' })
  @ApiOkResponse({ type: CustomerBrandDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CustomerUpdateBrandDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.profile.updateBrand(me, id, dto, meta);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my brands' })
  @ApiOkResponse({ type: CustomerBrandDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentCustomer() me: CustomerPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profile.brand(me, id);
  }
}
