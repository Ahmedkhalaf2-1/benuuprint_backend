import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ALLOW_AUTHENTICATED_KEY,
  IS_CUSTOMER_ROUTE_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from '../decorators/access-control.decorators.js';
import type { AuthenticatedRequest } from '../decorators/request-context.decorators.js';
import type { PermissionCode } from '../enums/permissions.js';

/**
 * Runs after JwtAuthGuard. Compares the union of the user's role permissions
 * with what the route declares. Deny by default: an authenticated route must
 * declare @RequirePermissions(...) or @AllowAuthenticated().
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(IS_CUSTOMER_ROUTE_KEY, targets)
    ) {
      return true;
    }
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      PERMISSIONS_KEY,
      targets,
    );
    if (!required) {
      if (
        this.reflector.getAllAndOverride<boolean>(
          ALLOW_AUTHENTICATED_KEY,
          targets,
        )
      ) {
        return true;
      }
      throw new ForbiddenException('Route does not declare its permissions');
    }
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user || !required.every((code) => user.permissions.has(code))) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
