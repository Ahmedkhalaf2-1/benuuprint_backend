import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import {
  auditActor,
  type ActorRef,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ReferenceService } from '../../database/reference-sequence.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  BrandDetailResponseDto,
  BrandResponseDto,
  CreateBrandDto,
  ListBrandsQueryDto,
  UpdateBrandDto,
} from './dto/brand.dto.js';

type BrandRow = Prisma.BrandGetPayload<object>;

export function toBrandResponse(b: BrandRow): BrandResponseDto {
  return {
    id: b.id,
    brandNumber: b.brandNumber,
    customerId: b.customerId,
    name: b.name,
    instagram: b.instagram,
    website: b.website,
    description: b.description,
    primaryColor: b.primaryColor,
    secondaryColor: b.secondaryColor,
    status: b.status,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    archivedAt: b.archivedAt,
  };
}

const EDITABLE = [
  'name',
  'instagram',
  'website',
  'description',
  'primaryColor',
  'secondaryColor',
] as const;

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
  ) {}

  async listForCustomer(
    customerId: string,
    query: ListBrandsQueryDto,
  ): Promise<Paginated<BrandResponseDto>> {
    if (
      !(await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Customer not found');
    }
    const where: Prisma.BrandWhereInput = {
      customerId,
      status:
        query.status ??
        (query.includeArchived ? undefined : { not: 'ARCHIVED' }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { brandNumber: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.brand.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.brand.count({ where }),
    ]);
    return paginated(
      rows.map(toBrandResponse),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<BrandDetailResponseDto> {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, customerNumber: true, displayName: true },
        },
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return Object.assign(toBrandResponse(brand), { customer: brand.customer });
  }

  async create(
    customerId: string,
    dto: CreateBrandDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<BrandDetailResponseDto> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.status === 'ARCHIVED') {
      throw new ConflictException('Cannot add a brand to an archived customer');
    }
    await this.assertNameFree(customerId, dto.name);
    const created = await this.prisma.$transaction(async (tx) => {
      const brandNumber = await this.references.next('BRD', tx);
      const brand = await tx.brand.create({
        data: {
          brandNumber,
          customerId,
          name: dto.name,
          instagram: dto.instagram,
          website: dto.website,
          description: dto.description,
          primaryColor: dto.primaryColor,
          secondaryColor: dto.secondaryColor,
          status: dto.status ?? 'ACTIVE',
        },
      });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.BRAND_CREATED,
          entityType: 'Brand',
          entityId: brand.id,
          metadata: { brandNumber, customerId, name: brand.name },
          meta,
        },
        tx,
      );
      return brand;
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateBrandDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<BrandDetailResponseDto> {
    const existing = await this.findOrThrow(id);
    const restoring = existing.status === 'ARCHIVED';
    if (restoring && !dto.status) {
      throw new ConflictException(
        'Archived brands cannot be edited; set a status to restore it',
      );
    }
    if (restoring) {
      const customer = await this.prisma.customer.findUniqueOrThrow({
        where: { id: existing.customerId },
      });
      if (customer.status === 'ARCHIVED') {
        throw new ConflictException(
          'Restore the customer before restoring its brands',
        );
      }
    }
    if ((dto.name && dto.name !== existing.name) || restoring) {
      await this.assertNameFree(
        existing.customerId,
        dto.name ?? existing.name,
        id,
      );
    }
    const data: Prisma.BrandUpdateInput = {};
    const changed: string[] = [];
    for (const field of EDITABLE) {
      const value = dto[field];
      if (value === undefined || (value === null && field === 'name')) continue;
      (data as Record<string, unknown>)[field] = value;
      if (existing[field] !== value) changed.push(field);
    }
    if (dto.status) {
      data.status = dto.status;
      if (dto.status !== existing.status) changed.push('status');
      if (restoring) data.archivedAt = null;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.brand.update({ where: { id }, data });
      if (changed.length || restoring) {
        await this.audit.record(
          {
            ...auditActor(actor),
            action: AuditAction.BRAND_UPDATED,
            entityType: 'Brand',
            entityId: id,
            metadata: {
              brandNumber: existing.brandNumber,
              fields: changed,
              restored: restoring,
            },
            meta,
          },
          tx,
        );
      }
    });
    return this.get(id);
  }

  async archive(id: string, actor: ActorRef, meta: RequestMeta): Promise<void> {
    const existing = await this.findOrThrow(id);
    if (existing.status === 'ARCHIVED')
      throw new ConflictException('Brand is already archived');
    await this.prisma.$transaction(async (tx) => {
      await tx.brand.update({
        where: { id },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.BRAND_ARCHIVED,
          entityType: 'Brand',
          entityId: id,
          metadata: {
            brandNumber: existing.brandNumber,
            customerId: existing.customerId,
          },
          meta,
        },
        tx,
      );
    });
  }

  /** Same customer cannot have two live brands with the same name (also enforced by a partial unique index). */
  private async assertNameFree(
    customerId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.brand.findFirst({
      where: {
        customerId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        id: { not: exceptId },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        `This customer already has a brand named "${name}"`,
      );
    }
  }

  private async findOrThrow(id: string): Promise<BrandRow> {
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }
}
