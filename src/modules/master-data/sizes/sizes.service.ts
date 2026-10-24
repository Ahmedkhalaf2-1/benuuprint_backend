import { toPlain } from '../../../common/plain.js';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser, RequestMeta } from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { MasterDataService } from '../master-data.base.js';
import type {
  CreateSizeOptionDto,
  CreateSizeScaleDto,
  SizeOptionResponseDto,
  SizeScaleResponseDto,
  UpdateSizeOptionDto,
  UpdateSizeScaleDto,
} from './size.dto.js';

const scaleInclude = {
  sizes: {
    where: { archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  },
} satisfies Prisma.SizeScaleInclude;

type ScaleRow = Prisma.SizeScaleGetPayload<{ include: typeof scaleInclude }>;
type OptionRow = Prisma.SizeOptionGetPayload<object>;

const toOption = (o: OptionRow): SizeOptionResponseDto => ({
  id: o.id,
  scaleId: o.scaleId,
  code: o.code,
  name: o.name,
  sortOrder: o.sortOrder,
  isActive: o.isActive,
  archivedAt: o.archivedAt,
});

@Injectable()
export class SizesService extends MasterDataService<
  ScaleRow,
  SizeScaleResponseDto,
  CreateSizeScaleDto,
  UpdateSizeScaleDto
> {
  protected readonly entityType = 'SizeScale';
  protected readonly label = 'Size scale';
  protected readonly auditPrefix = 'size_scale';

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  protected delegate = (c: PrismaService | Prisma.TransactionClient) =>
    c.sizeScale;
  protected override include() {
    return scaleInclude;
  }

  protected toResponse(r: ScaleRow): SizeScaleResponseDto {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      sizes: r.sizes.map(toOption),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
    };
  }

  protected createData(d: CreateSizeScaleDto) {
    return toPlain(d);
  }

  protected updateData(d: UpdateSizeScaleDto) {
    return Object.assign(toPlain(d), { name: d.name ?? undefined });
  }

  async createOption(
    scaleId: string,
    dto: CreateSizeOptionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SizeOptionResponseDto> {
    await this.findOrThrow(scaleId);
    if (
      await this.prisma.sizeOption.findUnique({
        where: { scaleId_code: { scaleId, code: dto.code } },
      })
    ) {
      throw new ConflictException(
        `Size ${dto.code} already exists in this scale`,
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const option = await tx.sizeOption.create({
        data: Object.assign(toPlain(dto), { scaleId }),
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'size_option.created',
          entityType: 'SizeOption',
          entityId: option.id,
          metadata: { scaleId, code: option.code, name: option.name },
          meta,
        },
        tx,
      );
      return option;
    });
    return toOption(row);
  }

  async updateOption(
    id: string,
    dto: UpdateSizeOptionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SizeOptionResponseDto> {
    const existing = await this.findOption(id);
    const data = Object.fromEntries(
      Object.entries(
        Object.assign(toPlain(dto), { name: dto.name ?? undefined }),
      ).filter(([, v]) => v !== undefined),
    );
    const row = await this.prisma.$transaction(async (tx) => {
      const option = await tx.sizeOption.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'size_option.updated',
          entityType: 'SizeOption',
          entityId: id,
          metadata: {
            scaleId: existing.scaleId,
            code: existing.code,
            fields: Object.keys(data),
          },
          meta,
        },
        tx,
      );
      return option;
    });
    return toOption(row);
  }

  async archiveOption(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.findOption(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.sizeOption.update({
        where: { id },
        data: { archivedAt: new Date(), isActive: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'size_option.archived',
          entityType: 'SizeOption',
          entityId: id,
          metadata: { scaleId: existing.scaleId, code: existing.code },
          meta,
        },
        tx,
      );
    });
  }

  private async findOption(id: string): Promise<OptionRow> {
    const row = await this.prisma.sizeOption.findFirst({
      where: { id, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Size option not found');
    return row;
  }
}
