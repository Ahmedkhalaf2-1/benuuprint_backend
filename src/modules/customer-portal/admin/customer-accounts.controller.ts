import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
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
  CreatePortalAccountDto,
  PortalAccountDto,
  PortalInvitationDto,
} from '../dto/customer-account-admin.dto.js';
import { CustomerAccountsAdminService } from './customer-accounts.service.js';

@ApiTags('Customers')
@Controller('admin/customers/:customerId/portal-account')
export class CustomerAccountsAdminController {
  constructor(private readonly accounts: CustomerAccountsAdminService) {}

  @Get()
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: "The customer's portal login (if any)" })
  @ApiOkResponse({ type: PortalAccountDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.accounts.get(customerId);
  }

  @Post()
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Create the portal login of a customer and invite them',
    description:
      'Exactly one portal account per customer. The account is INVITED until the customer accepts the single-use invitation (POST /customer/auth/activate) and sets a password.',
  })
  @ApiCreatedResponse({ type: PortalInvitationDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreatePortalAccountDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.accounts.create(customerId, dto.email, actor, meta);
  }

  @Post('reinvite')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Issue a fresh invitation (revokes the previous one)',
  })
  @ApiOkResponse({ type: PortalInvitationDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  reinvite(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.accounts.reinvite(customerId, actor, meta);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.manage')
  @ApiOperation({
    summary: 'Disable the portal login and revoke every session',
  })
  @ApiOkResponse({ type: PortalAccountDto })
  disable(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.accounts.setEnabled(customerId, false, actor, meta);
  }

  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.manage')
  @ApiOperation({ summary: 'Re-enable a disabled portal login' })
  @ApiOkResponse({ type: PortalAccountDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  enable(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.accounts.setEnabled(customerId, true, actor, meta);
  }
}
