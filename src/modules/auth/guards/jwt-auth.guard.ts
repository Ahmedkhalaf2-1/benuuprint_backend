import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_CUSTOMER_ROUTE_KEY,
  IS_PUBLIC_KEY,
} from '../../../common/decorators/access-control.decorators.js';
import type { AuthenticatedRequest } from '../../../common/decorators/request-context.decorators.js';
import { AuthContextService } from '../auth-context.service.js';
import { TokenService } from '../token.service.js';

/** Global guard: every route requires a valid bearer token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly authContext: AuthContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      // customer-portal routes are authenticated by CustomerAuthGuard (different audience and sessions)
      this.reflector.getAllAndOverride<boolean>(IS_CUSTOMER_ROUTE_KEY, targets)
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Authentication required');
    }
    const claims = await this.tokens.verifyAccessToken(token);
    const user = await this.authContext.resolve(claims.sub, claims.sid);
    if (!user) {
      throw new UnauthorizedException('Session is no longer valid');
    }
    request.user = user;
    return true;
  }
}
