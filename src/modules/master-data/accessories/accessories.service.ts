import { toPlain } from '../../../common/plain.js';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import {
  MasterDataService,
  type MasterDataListQueryDto,
} from '../master-data.base.js';
import type {
  AccessoryResponseDto,
  CreateAccessoryDto,
  ListAccessoriesQueryDto,
  UpdateAccessoryDto,
} from './accessory.dto.js';

type Row = Prisma.AccessoryGetPayload<object>;

@Injectable()
export class AccessoriesService extends MasterDataService<
  Row,
  AccessoryResponseDto,
  CreateAccessoryDto,
  UpdateAccessoryDto
> {
  protected readonly entityType = 'Accessory';
  protected readonly label = 'Accessory';
  protected readonly auditPrefix = 'accessory';

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  protected delegate = (c: PrismaService | Prisma.TransactionClient) =>
    c.accessory;

  protected toResponse(r: Row): AccessoryResponseDto {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      category: r.category,
      description: r.description,
      unit: r.unit,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
    };
  }

  protected createData(d: CreateAccessoryDto) {
    return toPlain(d);
  }

  protected updateData(d: UpdateAccessoryDto) {
    return Object.assign(toPlain(d), { name: d.name ?? undefined });
  }

  protected override extraWhere(query: MasterDataListQueryDto) {
    const { category } = query as ListAccessoriesQueryDto;
    return category
      ? { category: { equals: category, mode: 'insensitive' } }
      : {};
  }
}
