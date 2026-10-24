import {
  ExecutionContext,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { IS_CUSTOMER_ROUTE_KEY } from '../../../common/decorators/access-control.decorators.js';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import type { CustomerPrincipal } from '../../../common/types/auth-user.js';
import { CustomerAuthGuard } from './customer-auth.guard.js';

export type CustomerRequest = Request & { customer?: CustomerPrincipal };

/** Swagger security scheme name of the customer bearer token (see app.setup). */
export const CUSTOMER_BEARER = 'customer-bearer';

/**
 * Class decorator for every customer-portal controller. The staff guards step aside and
 * CustomerAuthGuard authenticates the customer token. Methods marked @Public() stay open.
 */
export const CustomerRoute = () =>
  applyDecorators(
    SetMetadata(IS_CUSTOMER_ROUTE_KEY, true),
    UseGuards(CustomerAuthGuard),
    ApiBearerAuth(CUSTOMER_BEARER),
    ApiUnauthorizedResponse({ type: ErrorResponseDto }),
  );

/** The authenticated customer. Ownership of every resource is derived from this, never from the request. */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CustomerPrincipal => {
    const request = ctx.switchToHttp().getRequest<CustomerRequest>();
    if (!request.customer) {
      throw new Error(
        'CurrentCustomer used on a route without customer authentication',
      );
    }
    return request.customer;
  },
);
