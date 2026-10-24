import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/access-control.decorators.js';
import { CustomerAuthContextService } from './customer-auth-context.service.js';
import { CustomerTokenService } from './customer-token.service.js';
import type { CustomerRequest } from './customer-route.decorators.js';

/** Authenticates customer-portal routes. A staff token fails here (different key and audience). */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: CustomerTokenService,
    private readonly context: CustomerAuthContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<CustomerRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Authentication required');
    }
    const claims = await this.tokens.verifyAccessToken(token);
    const customer = await this.context.resolve(claims.sub, claims.sid);
    if (!customer) {
      throw new UnauthorizedException('Session is no longer valid');
    }
    request.customer = customer;
    return true;
  }
}
