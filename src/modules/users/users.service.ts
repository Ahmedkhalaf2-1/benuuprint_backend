import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import { SUPER_ADMIN_ROLE_CODE } from '../../common/enums/system-roles.js';
import { assertActorHoldsAll } from '../../common/permission-utils.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { AccountTokensService } from '../auth/account-tokens.service.js';
import { TokenDelivery } from '../auth/token-delivery.js';
import { AuthContextService } from '../auth/auth-context.service.js';
import { PasswordService } from '../auth/password.service.js';
import type {
  CreateUserDto,
  ListUsersQueryDto,
  InvitationResponseDto,
  UpdateUserDto,
  UserDetailResponseDto,
  UserResponseDto,
} from './dto/user.dto.js';

const userInclude = {
  roles: {
    where: { role: { deletedAt: null } },
    include: { role: true },
    orderBy: { assignedAt: 'asc' },
  },
} satisfies Prisma.UserInclude;

type UserWithRoles = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** Explicit mapping: passwordHash can never leak because it is never copied. */
export function toUserResponse(user: UserWithRoles): UserResponseDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    passwordChangedAt: user.passwordChangedAt,
    roles: user.roles.map(({ role }) => ({
      id: role.id,
      code: role.code,
      name: role.name,
    })),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

const ACTIVE_SUPER_ADMIN_ROLE = {
  code: SUPER_ADMIN_ROLE_CODE,
  isActive: true,
  deletedAt: null,
} satisfies Prisma.RoleWhereInput;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly authContext: AuthContextService,
    private readonly audit: AuditService,
    private readonly accountTokens: AccountTokensService,
    private readonly delivery: TokenDelivery,
    private readonly config: ConfigService,
  ) {}

  async list(query: ListUsersQueryDto): Promise<Paginated<UserResponseDto>> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status: query.status,
      ...(query.role && { roles: { some: { role: { code: query.role } } } }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(
      rows.map(toUserResponse),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<UserDetailResponseDto> {
    const user = await this.findOrThrow(id);
    const access = await this.authContext.loadAccess(id);
    return Object.assign(toUserResponse(user), {
      permissions: [...access.permissions].sort(),
    });
  }

  async create(
    dto: CreateUserDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<UserDetailResponseDto> {
    const roleIds = [...new Set(dto.roleIds ?? [])];
    const roles = await this.resolveAssignableRoles(roleIds, actor);
    if (await this.prisma.user.findUnique({ where: { email: dto.email } })) {
      throw new ConflictException('A user with this email already exists');
    }

    const hasPassword = dto.password !== undefined;
    // INVITED users get an unusable random hash until an admin sets a password.
    const passwordHash = await this.passwords.hash(
      dto.password ?? randomBytes(32).toString('base64url'),
    );
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          status: hasPassword ? 'ACTIVE' : 'INVITED',
          isActive: hasPassword,
          passwordChangedAt: hasPassword ? new Date() : null,
          roles: {
            create: roleIds.map((roleId) => ({ roleId, assignedBy: actor.id })),
          },
        },
        include: userInclude,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.USER_CREATED,
          entityType: 'User',
          entityId: user.id,
          metadata: {
            email: user.email,
            status: user.status,
            roles: roles.map((r) => r.code),
          },
          meta,
        },
        tx,
      );
      return user;
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<UserDetailResponseDto> {
    const existing = await this.findOrThrow(id);
    await this.assertCanManage(actor, id);
    if (dto.email && dto.email !== existing.email) {
      const taken = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (taken)
        throw new ConflictException('A user with this email already exists');
    }
    const passwordHash = dto.password
      ? await this.passwords.hash(dto.password)
      : undefined;

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const activates =
        passwordHash !== undefined && existing.status === 'INVITED';
      await tx.user.update({
        where: { id },
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          ...(passwordHash && { passwordHash, passwordChangedAt: now }),
          ...(activates && { status: 'ACTIVE' as const, isActive: true }),
        },
      });
      const fields = (['name', 'email', 'phone'] as const).filter(
        (key) => dto[key] !== undefined,
      );
      if (fields.length) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.USER_UPDATED,
            entityType: 'User',
            entityId: id,
            metadata: {
              fields,
              ...(dto.email !== undefined && {
                emailChange: { from: existing.email, to: dto.email },
              }),
            },
            meta,
          },
          tx,
        );
      }
      if (passwordHash) {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: now },
        });
        await this.accountTokens.revokeOpen(tx, id);
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.USER_PASSWORD_RESET,
            entityType: 'User',
            entityId: id,
            metadata: { activatedInvitedUser: activates },
            meta,
          },
          tx,
        );
      }
    });
    return this.get(id);
  }

  async updateStatus(
    id: string,
    status: UserStatus,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<UserDetailResponseDto> {
    if (id === actor.id) {
      throw new ConflictException('You cannot change your own status');
    }
    const existing = await this.findOrThrow(id);
    await this.assertCanManage(actor, id);

    await this.serializable(async (tx) => {
      if (status !== 'ACTIVE') {
        await this.assertNotLastActiveSuperAdmin(tx, id, 'deactivate');
      }
      await tx.user.update({
        where: { id },
        data: { status, isActive: status === 'ACTIVE' },
      });
      if (status !== 'ACTIVE') {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.USER_STATUS_CHANGED,
          entityType: 'User',
          entityId: id,
          metadata: { from: existing.status, to: status },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async remove(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    if (id === actor.id) {
      throw new ConflictException('You cannot archive your own account');
    }
    const existing = await this.findOrThrow(id);
    await this.assertCanManage(actor, id);

    await this.serializable(async (tx) => {
      await this.assertNotLastActiveSuperAdmin(tx, id, 'archive');
      const now = new Date();
      await tx.user.update({
        where: { id },
        data: { deletedAt: now, status: 'DISABLED', isActive: false },
      });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.USER_ARCHIVED,
          entityType: 'User',
          entityId: id,
          metadata: { email: existing.email },
          meta,
        },
        tx,
      );
    });
  }

  async setRoles(
    id: string,
    roleIds: string[],
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<UserDetailResponseDto> {
    const existing = await this.findOrThrow(id);
    await this.assertCanManage(actor, id);
    const wanted = [...new Set(roleIds)];
    const roles = await this.resolveAssignableRoles(wanted, actor);

    const before = new Map(
      existing.roles.map(({ role }) => [role.id, role.code]),
    );
    const after = new Map(roles.map((role) => [role.id, role.code]));
    const added = [...after]
      .filter(([rid]) => !before.has(rid))
      .map(([, code]) => code);
    const removed = [...before]
      .filter(([rid]) => !after.has(rid))
      .map(([, code]) => code);

    await this.serializable(async (tx) => {
      if (removed.includes(SUPER_ADMIN_ROLE_CODE)) {
        await this.assertNotLastActiveSuperAdmin(
          tx,
          id,
          'remove the SUPER_ADMIN role from',
        );
      }
      await tx.userRole.deleteMany({
        where: { userId: id, roleId: { notIn: wanted } },
      });
      await tx.userRole.createMany({
        data: wanted
          .filter((rid) => !before.has(rid))
          .map((roleId) => ({ userId: id, roleId, assignedBy: actor.id })),
      });
      if (added.length || removed.length) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.USER_ROLES_CHANGED,
            entityType: 'User',
            entityId: id,
            metadata: { added, removed },
            meta,
          },
          tx,
        );
      }
    });
    return this.get(id);
  }

  /**
   * Issue a single-use invitation for a user who has no usable password yet.
   * The raw token is handed to the delivery hook and, only when configured
   * (EXPOSE_ONE_TIME_TOKENS, default on outside production), returned to the admin.
   */
  async invite(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<InvitationResponseDto> {
    const user = await this.findOrThrow(id);
    if (user.status !== 'INVITED') {
      throw new ConflictException(
        'Only users awaiting an invitation (status INVITED) can be invited',
      );
    }
    await this.assertCanManage(actor, id);

    const issued = await this.prisma.$transaction(async (tx) => {
      const token = await this.accountTokens.issue(
        tx,
        id,
        'INVITATION',
        actor.id,
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.INVITATION_CREATED,
          entityType: 'User',
          entityId: id,
          metadata: {
            expiresAt: token.expiresAt,
            tokenExposedToAdmin: this.accountTokens.exposeTokens,
          },
          meta,
        },
        tx,
      );
      return token;
    });
    await this.delivery.deliver({
      type: 'INVITATION',
      user: { id: user.id, email: user.email, name: user.name },
      token: issued.token,
      expiresAt: issued.expiresAt,
    });

    const baseUrl = this.config.getOrThrow<AppConfig>('app').publicAppUrl;
    const expose = this.accountTokens.exposeTokens;
    return {
      userId: id,
      expiresAt: issued.expiresAt,
      inviteToken: expose ? issued.token : undefined,
      inviteUrl:
        expose && baseUrl
          ? `${baseUrl.replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(issued.token)}`
          : undefined,
    };
  }

  private async findOrThrow(id: string): Promise<UserWithRoles> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: userInclude,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Roles must exist and be active, and the actor must hold every permission they carry. */
  private async resolveAssignableRoles(roleIds: string[], actor: AuthUser) {
    if (roleIds.length === 0) return [];
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, deletedAt: null, isActive: true },
      include: { permissions: { include: { permission: true } } },
    });
    if (roles.length !== roleIds.length) {
      throw new BadRequestException(
        'One or more roles do not exist or are inactive',
      );
    }
    for (const role of roles) {
      assertActorHoldsAll(
        actor.permissions,
        role.permissions.map((rp) => rp.permission.code),
        `You cannot assign role ${role.code}: it carries permissions you do not hold`,
      );
    }
    return roles;
  }

  /** An actor may only manage users whose effective permissions they fully hold. */
  private async assertCanManage(
    actor: AuthUser,
    targetId: string,
  ): Promise<void> {
    if (targetId === actor.id) return;
    const target = await this.authContext.loadAccess(targetId);
    try {
      assertActorHoldsAll(actor.permissions, target.permissions, '');
    } catch {
      throw new ForbiddenException(
        'You cannot manage a user who holds permissions you do not have',
      );
    }
  }

  /** Keep at least one active SUPER_ADMIN so the system can never be locked out. */
  private async assertNotLastActiveSuperAdmin(
    tx: Prisma.TransactionClient,
    userId: string,
    verb: string,
  ): Promise<void> {
    const target = await tx.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        isActive: true,
        status: 'ACTIVE',
        roles: { some: { role: ACTIVE_SUPER_ADMIN_ROLE } },
      },
      select: { id: true },
    });
    if (!target) return;
    const others = await tx.user.count({
      where: {
        id: { not: userId },
        deletedAt: null,
        isActive: true,
        status: 'ACTIVE',
        roles: { some: { role: ACTIVE_SUPER_ADMIN_ROLE } },
      },
    });
    if (others === 0) {
      throw new ConflictException(`Cannot ${verb} the last active SUPER_ADMIN`);
    }
  }

  private serializable<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(fn, { isolationLevel: 'Serializable' });
  }
}
