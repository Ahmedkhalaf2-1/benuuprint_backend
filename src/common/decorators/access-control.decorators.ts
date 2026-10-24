import { SetMetadata, applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { PermissionCode } from '../enums/permissions.js';
import { ErrorResponseDto } from '../dto/error-response.dto.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ALLOW_AUTHENTICATED_KEY = 'auth:allowAuthenticated';
export const PERMISSIONS_KEY = 'auth:permissions';
/**
 * Marks a controller as customer-portal. The staff guards (JwtAuthGuard, PermissionsGuard) step aside
 * for it and CustomerAuthGuard (customer audience, customer sessions) authenticates instead.
 */
export const IS_CUSTOMER_ROUTE_KEY = 'auth:isCustomerRoute';

/** Route needs no authentication (login, refresh, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Any authenticated staff user may call this route (e.g. /auth/me). */
export const AllowAuthenticated = () =>
  applyDecorators(
    SetMetadata(ALLOW_AUTHENTICATED_KEY, true),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ type: ErrorResponseDto }),
  );

/**
 * Route requires ALL listed permissions. Routes with neither this nor
 * @Public()/@AllowAuthenticated() are denied (deny by default).
 */
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ type: ErrorResponseDto }),
    ApiForbiddenResponse({
      type: ErrorResponseDto,
      description: `Missing permission. Requires: ${permissions.join(', ')}`,
    }),
  );
