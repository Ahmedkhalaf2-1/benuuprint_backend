import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import { normalizePhone } from '../../common/transforms.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ReferenceService } from '../../database/reference-sequence.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateCustomerDto,
  CustomerDetailResponseDto,
  CustomerResponseDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto.js';

type CustomerRow = Prisma.CustomerGetPayload<object>;

export function toCustomerResponse(c: CustomerRow): CustomerResponseDto {
  return {
    id: c.id,
    customerNumber: c.customerNumber,
    displayName: c.displayName,
    email: c.email,
    phone: c.phone,
    whatsapp: c.whatsapp,
    country: c.country,
    city: c.city,
    instagram: c.instagram,
    source: c.source,
    notes: c.notes,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    archivedAt: c.archivedAt,
  };
}

const EDITABLE_FIELDS = [
  'displayName',
  'email',
  'phone',
  'whatsapp',
  'country',
  'city',
  'instagram',
  'source',
  'notes',
] as const;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListCustomersQueryDto,
  ): Promise<Paginated<CustomerResponseDto>> {
    const search = query.search?.trim();
    const phoneSearch = search ? normalizePhone(search) : undefined;
    const where: Prisma.CustomerWhereInput = {
      status:
        query.status ??
        (query.includeArchived ? undefined : { not: 'ARCHIVED' }),
      ...(search && {
        OR: [
          { customerNumber: { contains: search, mode: 'insensitive' } },
          { displayName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: phoneSearch ?? search } },
          { whatsapp: { contains: phoneSearch ?? search } },
          {
            brands: {
              some: {
                archivedAt: null,
                name: { contains: search, mode: 'insensitive' },
              },
            },
          },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);
    return paginated(
      rows.map(toCustomerResponse),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string): Promise<CustomerDetailResponseDto> {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        brands: {
          where: { archivedAt: null },
          orderBy: { name: 'asc' },
          select: { id: true, brandNumber: true, name: true, status: true },
        },
        contacts: {
          where: { archivedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        },
        addresses: {
          where: { archivedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!c) throw new NotFoundException('Customer not found');
    return Object.assign(toCustomerResponse(c), {
      brands: c.brands,
      contacts: c.contacts.map(
        ({ customerId: _c, archivedAt: _a, ...rest }) => rest,
      ),
      addresses: c.addresses.map(
        ({ customerId: _c, archivedAt: _a, ...rest }) => rest,
      ),
    });
  }

  async create(
    dto: CreateCustomerDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CustomerDetailResponseDto> {
    const created = await this.prisma.$transaction(async (tx) => {
      const customerNumber = await this.references.next('CUS', tx);
      const customer = await tx.customer.create({
        data: {
          customerNumber,
          displayName: dto.displayName,
          email: dto.email,
          phone: dto.phone,
          whatsapp: dto.whatsapp,
          country: dto.country,
          city: dto.city,
          instagram: dto.instagram,
          source: dto.source,
          notes: dto.notes,
          status: dto.status ?? 'ACTIVE',
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CUSTOMER_CREATED,
          entityType: 'Customer',
          entityId: customer.id,
          metadata: {
            customerNumber,
            displayName: customer.displayName,
            status: customer.status,
          },
          meta,
        },
        tx,
      );
      return customer;
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CustomerDetailResponseDto> {
    const existing = await this.findOrThrow(id);
    if (existing.status === 'ARCHIVED') {
      throw new ConflictException(
        'Archived customers cannot be edited; restore it first',
      );
    }
    const data: Prisma.CustomerUpdateInput = {};
    const changed: string[] = [];
    for (const field of EDITABLE_FIELDS) {
      const value = dto[field];
      if (value === undefined) continue;
      if (value === null && field === 'displayName') continue;
      (data as Record<string, unknown>)[field] = value;
      if (existing[field] !== value) changed.push(field);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id }, data });
      if (changed.length) {
        await this.audit.record(
          {
            actorUserId: actor.id,
            action: AuditAction.CUSTOMER_UPDATED,
            entityType: 'Customer',
            entityId: id,
            metadata: {
              customerNumber: existing.customerNumber,
              fields: changed,
            },
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
    status: 'ACTIVE' | 'LEAD' | 'INACTIVE' | 'BLOCKED',
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CustomerDetailResponseDto> {
    const existing = await this.findOrThrow(id);
    await this.prisma.$transaction(async (tx) => {
      // Restoring an archived customer clears archivedAt; its brands stay archived until restored individually.
      await tx.customer.update({
        where: { id },
        data: { status, archivedAt: null },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CUSTOMER_STATUS_CHANGED,
          entityType: 'Customer',
          entityId: id,
          metadata: {
            customerNumber: existing.customerNumber,
            from: existing.status,
            to: status,
            restored: existing.status === 'ARCHIVED',
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Soft archive: the row, its history and references are kept. Active brands are archived with it. */
  async archive(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const existing = await this.findOrThrow(id);
    if (existing.status === 'ARCHIVED') {
      throw new ConflictException('Customer is already archived');
    }
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.customer.update({
        where: { id },
        data: { status: 'ARCHIVED', archivedAt: now },
      });
      const { count } = await tx.brand.updateMany({
        where: { customerId: id, archivedAt: null },
        data: { status: 'ARCHIVED', archivedAt: now },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CUSTOMER_ARCHIVED,
          entityType: 'Customer',
          entityId: id,
          metadata: {
            customerNumber: existing.customerNumber,
            previousStatus: existing.status,
            archivedBrands: count,
          },
          meta,
        },
        tx,
      );
    });
  }

  private async findOrThrow(id: string): Promise<CustomerRow> {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }
}
