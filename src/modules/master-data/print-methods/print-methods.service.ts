import { toPlain } from '../../../common/plain.js';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import {
  MasterDataService,
  type MasterDataListQueryDto,
} from '../master-data.base.js';
import { decimal } from '../master-data.responses.js';
import type {
  CreatePrintMethodDto,
  ListPrintMethodsQueryDto,
  PrintMethodResponseDto,
  UpdatePrintMethodDto,
} from './print-method.dto.js';

type Row = Prisma.PrintMethodGetPayload<object>;

@Injectable()
export class PrintMethodsService extends MasterDataService<
  Row,
  PrintMethodResponseDto,
  CreatePrintMethodDto,
  UpdatePrintMethodDto
> {
  protected readonly entityType = 'PrintMethod';
  protected readonly label = 'Print method';
  protected readonly auditPrefix = 'print_method';

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  protected delegate = (c: PrismaService | Prisma.TransactionClient) =>
    c.printMethod;

  protected toResponse(r: Row): PrintMethodResponseDto {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      description: r.description,
      minQuantity: r.minQuantity,
      maxColors: r.maxColors,
      supportsFullColor: r.supportsFullColor,
      setupFee: decimal(r.setupFee),
      notes: r.notes,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
    };
  }

  protected createData(d: CreatePrintMethodDto) {
    return toPlain(d);
  }

  protected updateData(d: UpdatePrintMethodDto) {
    return Object.assign(toPlain(d), { name: d.name ?? undefined });
  }

  protected override extraWhere(query: MasterDataListQueryDto) {
    const { type } = query as ListPrintMethodsQueryDto;
    return type ? { type } : {};
  }
}
