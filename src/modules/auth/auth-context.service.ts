import { Injectable } from '@nestjs/common';
import {
  ALL_PERMISSION_CODES,
  type PermissionCode,
} from '../../common/enums/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';

const VALID_CODES = new Set<string>(ALL_PERMISSION_CODES);

/**
 * Resolves who a (user, session) pair is right now. Hits the database on every
 * request so revocation, suspension and role changes take effect immediately.
 */
@Injectable()
export class AuthContextService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(userId: string, sessionId: string): Promise<AuthUser | null> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });
    if (!session) return null;
    const user = session.user;
    if (user.deletedAt || !user.isActive || user.status !== 'ACTIVE') {
      return null;
    }
    const { roleCodes, permissions } = await this.loadAccess(user.id);
    return {
      id: user.id,
      sessionId,
      name: user.name,
      email: user.email,
      roleCodes,
      permissions,
    };
  }

  /** Union of permissions across all of a user's active, non-deleted roles. */
  async loadAccess(
    userId: string,
  ): Promise<{ roleCodes: string[]; permissions: Set<PermissionCode> }> {
    const links = await this.prisma.userRole.findMany({
      where: { userId, role: { isActive: true, deletedAt: null } },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });
    const permissions = new Set<PermissionCode>();
    for (const link of links) {
      for (const rp of link.role.permissions) {
        if (VALID_CODES.has(rp.permission.code)) {
          permissions.add(rp.permission.code as PermissionCode);
        }
      }
    }
    return { roleCodes: links.map((l) => l.role.code).sort(), permissions };
  }
}
