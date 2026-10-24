import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import { SUPER_ADMIN_ROLE_CODE } from '../../common/enums/system-roles.js';
import { assertActorHoldsAll } from '../../common/permission-utils.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateRoleDto,
  ListPermissionsQueryDto,
  ListRolesQueryDto,
  PermissionResponseDto,
  RoleResponseDto,
  UpdateRoleDto,
} from './dto/role.dto.js';

const roleInclude = {
  permissions: { include: { permission: true } },
} satisfies Prisma.RoleInclude;

type RoleWithPermissions = Prisma.RoleGetPayload<{
  include: typeof roleInclude;
}>;

export function toRoleResponse(role: RoleWithPermissions): RoleResponseDto {
  return {
    id: role.id,
    name: role.name,
    code: role.code,
    description: role.description,
    isSystem: role.isSystem,
    isActive: role.isActive,
    permissions: role.permissions.map((rp) => rp.permission.code).sort(),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListRolesQueryDto): Promise<Paginated<RoleResponseDto>> {
    const where: Prisma.RoleWhereInput = {
      deletedAt: null,
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { code: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        include: roleInclude,
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.role.count({ where }),
    ]);
    return paginated(
      rows.map(toRoleResponse),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<RoleResponseDto> {
    return toRoleResponse(await this.findOrThrow(id));
  }

  async create(
    dto: CreateRoleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<RoleResponseDto> {
    const codes = [...new Set(dto.permissionCodes ?? [])];
    const permissions = await this.resolvePermissions(codes);
    assertActorHoldsAll(
      actor.permissions,
      codes,
      'You cannot grant permissions you do not hold',
    );
    if (await this.prisma.role.findUnique({ where: { code: dto.code } })) {
      throw new ConflictException(`Role code ${dto.code} is already in use`);
    }
    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          name: dto.name,
          code: dto.code,
          description: dto.description,
          isSystem: false,
          permissions: {
            create: permissions.map((p) => ({ permissionId: p.id })),
          },
        },
        include: roleInclude,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ROLE_CREATED,
          entityType: 'Role',
          entityId: created.id,
          metadata: {
            code: created.code,
            name: created.name,
            permissions: codes,
          },
          meta,
        },
        tx,
      );
      return created;
    });
    return toRoleResponse(role);
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<RoleResponseDto> {
    const existing = await this.findOrThrow(id);
    if (existing.isSystem && dto.isActive === false) {
      throw new ConflictException('System roles cannot be deactivated');
    }
    const role = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          isActive: dto.isActive,
        },
        include: roleInclude,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ROLE_UPDATED,
          entityType: 'Role',
          entityId: id,
          metadata: {
            code: existing.code,
            changes: {
              ...(dto.name !== undefined && {
                name: { from: existing.name, to: updated.name },
              }),
              ...(dto.description !== undefined && {
                description: {
                  from: existing.description,
                  to: updated.description,
                },
              }),
              ...(dto.isActive !== undefined && {
                isActive: { from: existing.isActive, to: updated.isActive },
              }),
            },
          },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toRoleResponse(role);
  }

  async remove(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const role = await this.findOrThrow(id);
    if (role.isSystem) {
      throw new ConflictException('System roles cannot be deleted');
    }
    const assigned = await this.prisma.userRole.count({
      where: { roleId: id, user: { deletedAt: null } },
    });
    if (assigned > 0) {
      throw new ConflictException(
        `Role is assigned to ${assigned} user(s); unassign it first`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ROLE_DELETED,
          entityType: 'Role',
          entityId: id,
          metadata: { code: role.code, name: role.name },
          meta,
        },
        tx,
      );
    });
  }

  async setPermissions(
    id: string,
    permissionCodes: string[],
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<RoleResponseDto> {
    const role = await this.findOrThrow(id);
    if (role.code === SUPER_ADMIN_ROLE_CODE) {
      throw new ConflictException(
        'SUPER_ADMIN permissions are managed by the seed and cannot be changed',
      );
    }
    const wanted = new Set(permissionCodes);
    const current = new Set(role.permissions.map((rp) => rp.permission.code));
    const added = [...wanted].filter((c) => !current.has(c));
    const removed = [...current].filter((c) => !wanted.has(c));
    const permissions = await this.resolvePermissions([...wanted]);
    assertActorHoldsAll(
      actor.permissions,
      [...added, ...removed],
      'You cannot grant or revoke permissions you do not hold',
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId: id, permissionId: p.id })),
      });
      if (added.length || removed.length) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.ROLE_PERMISSIONS_CHANGED,
            entityType: 'Role',
            entityId: id,
            metadata: { code: role.code, added, removed },
            meta,
          },
          tx,
        );
      }
      return tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude });
    });
    return toRoleResponse(updated);
  }

  async listPermissions(
    query: ListPermissionsQueryDto,
  ): Promise<Paginated<PermissionResponseDto>> {
    const [rows, total] = await Promise.all([
      this.prisma.permission.findMany({
        orderBy: { code: 'asc' },
        skip: query.skip,
        take: query.pageSize,
        select: { id: true, code: true, description: true },
      }),
      this.prisma.permission.count(),
    ]);
    return paginated(rows, query.page, query.pageSize, total);
  }

  private async findOrThrow(id: string): Promise<RoleWithPermissions> {
    const role = await this.prisma.role.findFirst({
      where: { id, deletedAt: null },
      include: roleInclude,
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private async resolvePermissions(codes: string[]) {
    if (codes.length === 0) return [];
    const found = await this.prisma.permission.findMany({
      where: { code: { in: codes } },
    });
    if (found.length !== codes.length) {
      const known = new Set(found.map((p) => p.code));
      throw new BadRequestException(
        `Unknown permissions: ${codes.filter((c) => !known.has(c)).join(', ')}`,
      );
    }
    return found;
  }
}
