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
  CreateProductTypeDto,
  ListProductTypesQueryDto,
  ProductTypeResponseDto,
  UpdateProductTypeDto,
} from './product-type.dto.js';

type Row = Prisma.ProductTypeGetPayload<object>;

@Injectable()
export class ProductTypesService extends MasterDataService<
  Row,
  ProductTypeResponseDto,
  CreateProductTypeDto,
  UpdateProductTypeDto
> {
  protected readonly entityType = 'ProductType';
  protected readonly label = 'Product type';
  protected readonly auditPrefix = 'product_type';

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  protected delegate = (c: PrismaService | Prisma.TransactionClient) =>
    c.productType;

  protected toResponse(r: Row): ProductTypeResponseDto {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      category: r.category,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      defaultSampleFee: decimal(r.defaultSampleFee),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
    };
  }

  protected createData(d: CreateProductTypeDto) {
    return {
      code: d.code,
      name: d.name,
      description: d.description,
      category: d.category,
      isActive: d.isActive,
      sortOrder: d.sortOrder,
      defaultSampleFee: d.defaultSampleFee,
    };
  }

  protected updateData(d: UpdateProductTypeDto) {
    return {
      name: d.name ?? undefined,
      description: d.description,
      category: d.category,
      isActive: d.isActive,
      sortOrder: d.sortOrder,
      defaultSampleFee: d.defaultSampleFee,
    };
  }

  protected override extraWhere(query: MasterDataListQueryDto) {
    const { category } = query as ListProductTypesQueryDto;
    return category ? { category } : {};
  }
}
