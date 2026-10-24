/* oxlint-disable typescript/unbound-method -- handlers are passed as metadata keys, never called */
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import {
  AllowAuthenticated,
  IS_CUSTOMER_ROUTE_KEY,
  Public,
  RequirePermissions,
} from '../decorators/access-control.decorators.js';
import type { AuthUser } from '../types/auth-user.js';
import { PermissionsGuard } from './permissions.guard.js';

class Routes {
  @RequirePermissions('users.manage', 'roles.read')
  both() {}
  @AllowAuthenticated()
  anyone() {}
  @Public()
  open() {}
  undeclared() {}
}

/** A customer-portal controller: the staff guards must leave it to CustomerAuthGuard. */
@SetMetadata(IS_CUSTOMER_ROUTE_KEY, true)
class PortalRoutes {
  anything() {}
}

function ctx(handler: () => void, user?: Partial<AuthUser>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector());
  const routes = new Routes();
  const user = (...perms: string[]) =>
    ({ permissions: new Set(perms) }) as unknown as Partial<AuthUser>;

  it('allows when the user holds all required permissions', () => {
    expect(
      guard.canActivate(
        ctx(routes.both, user('users.manage', 'roles.read', 'x')),
      ),
    ).toBe(true);
  });

  it('denies when any required permission is missing', () => {
    expect(() =>
      guard.canActivate(ctx(routes.both, user('users.manage'))),
    ).toThrow(ForbiddenException);
  });

  it('allows @AllowAuthenticated and @Public routes', () => {
    expect(guard.canActivate(ctx(routes.anyone, user()))).toBe(true);
    expect(guard.canActivate(ctx(routes.open))).toBe(true);
  });

  it('denies by default routes that declare nothing', () => {
    expect(() =>
      guard.canActivate(ctx(routes.undeclared, user('users.manage'))),
    ).toThrow(ForbiddenException);
  });

  it('steps aside for customer-portal controllers (authenticated by their own guard)', () => {
    const portalCtx = {
      getHandler: () => PortalRoutes.prototype.anything,
      getClass: () => PortalRoutes,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(portalCtx)).toBe(true);
    // ...while an undeclared staff route is still denied by default
    expect(() => guard.canActivate(ctx(routes.undeclared))).toThrow(
      ForbiddenException,
    );
  });
});
