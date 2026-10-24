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
  ComponentOptionResponseDto,
  CreateComponentOptionDto,
  ListComponentOptionsQueryDto,
  UpdateComponentOptionDto,
} from './component-option.dto.js';

type Row = Prisma.ComponentOptionGetPayload<object>;

@Injectable()
export class ComponentOptionsService extends MasterDataService<
  Row,
  ComponentOptionResponseDto,
  CreateComponentOptionDto,
  UpdateComponentOptionDto
> {
  protected readonly entityType = 'ComponentOption';
  protected readonly label = 'Component option';
  protected readonly auditPrefix = 'component_option';

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  protected delegate = (c: PrismaService | Prisma.TransactionClient) =>
    c.componentOption;

  protected toResponse(r: Row): ComponentOptionResponseDto {
    return {
      id: r.id,
      category: r.category,
      code: r.code,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
    };
  }

  protected createData(d: CreateComponentOptionDto) {
    return toPlain(d);
  }

  protected updateData(d: UpdateComponentOptionDto) {
    return Object.assign(toPlain(d), { name: d.name ?? undefined });
  }

  protected override extraWhere(query: MasterDataListQueryDto) {
    const { category } = query as ListComponentOptionsQueryDto;
    return category ? { category } : {};
  }
}
