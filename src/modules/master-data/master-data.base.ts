import { ConflictException, NotFoundException } from '@nestjs/common';
import { crudAudit } from '../../common/enums/audit-actions.js';
import { ToBoolean } from '../../common/transforms.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditService } from '../audit/audit.service.js';

export const MASTER_SORT_FIELDS = [
  'sortOrder',
  'name',
  'code',
  'createdAt',
] as const;

export class MasterDataListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches code or name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by active flag' })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Include archived records (excluded by default)',
  })
  @IsOptional()
  @ToBoolean()
  @IsIn([true, false])
  includeArchived?: boolean;

  @ApiPropertyOptional({ enum: MASTER_SORT_FIELDS, default: 'sortOrder' })
  @IsOptional()
  @IsIn(MASTER_SORT_FIELDS)
  sortBy: (typeof MASTER_SORT_FIELDS)[number] = 'sortOrder';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';
}

/** The slice of a Prisma delegate the base service needs. */
export interface CrudDelegate {
  findMany(args: unknown): Promise<unknown[]>;
  findFirst(args: unknown): Promise<unknown>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<unknown>;
  update(args: unknown): Promise<unknown>;
}

export interface MasterRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  archivedAt: Date | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Shared behaviour of code-addressed master data: unique immutable code,
 * isActive vs archived, paginated search, audited create/update/archive.
 * Subclasses add entity-specific fields via the hooks.
 */
export abstract class MasterDataService<
  TRow extends MasterRow,
  TResponse,
  TCreate extends { code: string },
  TUpdate extends object,
> {
  protected abstract readonly entityType: string;
  protected abstract readonly label: string;
  protected abstract readonly auditPrefix: string;

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly audit: AuditService,
  ) {}

  protected abstract delegate(client: PrismaService | Tx): CrudDelegate;
  protected abstract toResponse(row: TRow): TResponse;
  protected abstract createData(dto: TCreate): Record<string, unknown>;
  /** Fields present in the update DTO that should be written (undefined = untouched). */
  protected abstract updateData(dto: TUpdate): Record<string, unknown>;
  protected include(): Record<string, unknown> | undefined {
    return undefined;
  }
  /** Extra filters from a subclass query DTO. */
  protected extraWhere(
    _query: MasterDataListQueryDto,
  ): Record<string, unknown> {
    return {};
  }
  /** e.g. allocate a reference number; runs inside the create transaction. */
  protected async beforeCreate(
    _tx: Tx,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return data;
  }
  /** Cross-field validation on the merged state. */
  protected validate(_merged: Record<string, unknown>): void {}

  async list(query: MasterDataListQueryDto): Promise<Paginated<TResponse>> {
    const where = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.search && {
        OR: [
          { code: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
      ...this.extraWhere(query),
    };
    const delegate = this.delegate(this.prisma);
    const [rows, total] = await Promise.all([
      delegate.findMany({
        where,
        include: this.include(),
        orderBy: [
          { [query.sortBy]: query.sortOrder },
          { name: 'asc' },
          { id: 'asc' },
        ],
        skip: query.skip,
        take: query.pageSize,
      }),
      delegate.count({ where }),
    ]);
    return paginated(
      (rows as TRow[]).map((r) => this.toResponse(r)),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<TResponse> {
    return this.toResponse(await this.findOrThrow(id, true));
  }

  async create(
    dto: TCreate,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TResponse> {
    this.validate(this.createData(dto));
    const clash = await this.delegate(this.prisma).findFirst({
      where: { code: dto.code },
    });
    if (clash)
      throw new ConflictException(
        `${this.label} code ${dto.code} is already in use`,
      );
    const actions = crudAudit(this.auditPrefix);
    const row = await this.prisma.$transaction(async (tx) => {
      const data = await this.beforeCreate(tx, this.createData(dto));
      const created = (await this.delegate(tx).create({
        data,
        include: this.include(),
      })) as TRow;
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: actions.created,
          entityType: this.entityType,
          entityId: created.id,
          metadata: { code: created.code, name: created.name },
          meta,
        },
        tx,
      );
      return created;
    });
    return this.toResponse(row);
  }

  async update(
    id: string,
    dto: TUpdate,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TResponse> {
    const existing = await this.findOrThrow(id);
    const data = Object.fromEntries(
      Object.entries(this.updateData(dto)).filter(([, v]) => v !== undefined),
    );
    this.validate({
      ...(existing as unknown as Record<string, unknown>),
      ...data,
    });
    const actions = crudAudit(this.auditPrefix);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = (await this.delegate(tx).update({
        where: { id },
        data,
        include: this.include(),
      })) as TRow;
      if (Object.keys(data).length) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: actions.updated,
            entityType: this.entityType,
            entityId: id,
            metadata: { code: existing.code, fields: Object.keys(data) },
            meta,
          },
          tx,
        );
      }
      return updated;
    });
    return this.toResponse(row);
  }

  async archive(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const existing = await this.findOrThrow(id, true);
    if (existing.archivedAt)
      throw new ConflictException(`${this.label} is already archived`);
    const actions = crudAudit(this.auditPrefix);
    await this.prisma.$transaction(async (tx) => {
      await this.delegate(tx).update({
        where: { id },
        data: { archivedAt: new Date(), isActive: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: actions.archived,
          entityType: this.entityType,
          entityId: id,
          metadata: { code: existing.code, name: existing.name },
          meta,
        },
        tx,
      );
    });
  }

  /** Archived records are read-only; pass includeArchived to read them. */
  protected async findOrThrow(
    id: string,
    includeArchived = false,
  ): Promise<TRow> {
    const row = (await this.delegate(this.prisma).findFirst({
      where: { id, ...(includeArchived ? {} : { archivedAt: null }) },
      include: this.include(),
    })) as TRow | null;
    if (!row) throw new NotFoundException(`${this.label} not found`);
    return row;
  }
}
