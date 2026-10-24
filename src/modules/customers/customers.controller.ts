import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { ProcessProjectionService } from '../responsibilities/process-projection.service.js';
import { ContactsService } from './contacts.service.js';
import { CustomersService } from './customers.service.js';
import {
  CreateAddressDto,
  CreateContactDto,
  UpdateAddressDto,
  UpdateContactDto,
} from './dto/contact-address.dto.js';
import {
  CreateCustomerDto,
  CustomerAddressResponseDto,
  CustomerContactResponseDto,
  CustomerDetailResponseDto,
  ListCustomersQueryDto,
  PaginatedCustomersDto,
  UpdateCustomerDto,
  UpdateCustomerStatusDto,
} from './dto/customer.dto.js';

@ApiTags('Customers')
@Controller('admin/customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly projection: ProcessProjectionService,
  ) {}

  @Get()
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'List customers (archived hidden by default)' })
  @ApiOkResponse({ type: PaginatedCustomersDto })
  async list(
    @Query() query: ListCustomersQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const page = await this.customers.list(query);
    if (!query.includeOperations) return page;
    this.requireResponsibilities(user);
    const summaries = await this.projection.customerSummaries(
      page.data.map((c) => c.id),
    );
    return {
      ...page,
      data: page.data.map((c) => Object.assign({}, c, summaries.get(c.id))),
    };
  }

  private requireResponsibilities(user: AuthUser) {
    if (!user.permissions.has('responsibilities.read')) {
      throw new ForbiddenException(
        'includeOperations needs the responsibilities.read permission',
      );
    }
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  @ApiOperation({
    summary: 'Get a customer with brands, contacts and addresses',
  })
  @ApiOkResponse({ type: CustomerDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeOperations') includeOperations: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const customer = await this.customers.get(id);
    if (includeOperations !== 'true') return customer;
    this.requireResponsibilities(user);
    const summary = (await this.projection.customerSummaries([id])).get(id);
    return Object.assign({}, customer, summary);
  }

  @Post()
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Create a customer (customerNumber is generated)' })
  @ApiCreatedResponse({ type: CustomerDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.customers.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Update customer details (null clears optional fields)',
  })
  @ApiOkResponse({ type: CustomerDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Customer is archived',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.customers.update(id, dto, actor, meta);
  }

  @Patch(':id/status')
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Change status; also restores an archived customer',
  })
  @ApiOkResponse({ type: CustomerDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerStatusDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.customers.updateStatus(id, dto.status, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Archive a customer (soft delete; also archives its brands)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.customers.archive(id, actor, meta);
  }
}

@ApiTags('Customers')
@Controller('admin')
export class CustomerContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get('customers/:customerId/contacts')
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: "List a customer's contacts" })
  @ApiOkResponse({ type: [CustomerContactResponseDto] })
  listContacts(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.contacts.listContacts(customerId);
  }

  @Post('customers/:customerId/contacts')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Add a contact person' })
  @ApiCreatedResponse({ type: CustomerContactResponseDto })
  createContact(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateContactDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.contacts.createContact(customerId, dto, actor, meta);
  }

  @Patch('customer-contacts/:id')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Update a contact person' })
  @ApiOkResponse({ type: CustomerContactResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContactDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.contacts.updateContact(id, dto, actor, meta);
  }

  @Delete('customer-contacts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Archive a contact person' })
  @ApiNoContentResponse()
  archiveContact(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.contacts.archiveContact(id, actor, meta);
  }

  @Get('customers/:customerId/addresses')
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: "List a customer's addresses" })
  @ApiOkResponse({ type: [CustomerAddressResponseDto] })
  listAddresses(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.contacts.listAddresses(customerId);
  }

  @Post('customers/:customerId/addresses')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Add an address' })
  @ApiCreatedResponse({ type: CustomerAddressResponseDto })
  createAddress(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateAddressDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.contacts.createAddress(customerId, dto, actor, meta);
  }

  @Patch('customer-addresses/:id')
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Update an address' })
  @ApiOkResponse({ type: CustomerAddressResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  updateAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.contacts.updateAddress(id, dto, actor, meta);
  }

  @Delete('customer-addresses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Archive an address' })
  @ApiNoContentResponse()
  archiveAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.contacts.archiveAddress(id, actor, meta);
  }
}
