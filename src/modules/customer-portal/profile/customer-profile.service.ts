import { BrandsService } from '../../brands/brands.service.js';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../../common/enums/audit-actions.js';
import type {
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { CustomerAddressResponseDto } from '../../customers/dto/customer.dto.js';
import type {
  CreateAddressDto,
  UpdateAddressDto,
} from '../../customers/dto/contact-address.dto.js';
import { ContactsService } from '../../customers/contacts.service.js';
import type {
  CustomerBrandDto,
  CustomerCreateBrandDto,
  CustomerUpdateBrandDto,
  CustomerProfileDto,
  UpdateCustomerProfileDto,
} from '../dto/customer-profile.dto.js';

const EDITABLE = [
  'phone',
  'whatsapp',
  'country',
  'city',
  'instagram',
  'preferredLocale',
] as const;

const brandSelect = {
  id: true,
  brandNumber: true,
  name: true,
  instagram: true,
  website: true,
  description: true,
  primaryColor: true,
  secondaryColor: true,
} as const;

/** Profile, brands and addresses of the signed-in customer. Ownership is always the session's customer id. */
@Injectable()
export class CustomerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contacts: ContactsService,
    private readonly brandsService: BrandsService,
  ) {}

  async profile(me: CustomerPrincipal): Promise<CustomerProfileDto> {
    const c = await this.prisma.customer.findUniqueOrThrow({
      where: { id: me.customerId },
    });
    return {
      id: c.id,
      customerNumber: c.customerNumber,
      name: c.displayName,
      email: me.email,
      phone: c.phone,
      whatsapp: c.whatsapp,
      country: c.country,
      city: c.city,
      instagram: c.instagram,
      preferredLocale: c.preferredLocale,
    };
  }

  async updateProfile(
    me: CustomerPrincipal,
    dto: UpdateCustomerProfileDto,
    meta: RequestMeta,
  ): Promise<CustomerProfileDto> {
    const data: Record<string, string | null> = {};
    for (const key of EDITABLE) {
      const value = dto[key];
      if (value !== undefined) data[key] = value;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.customer.update({ where: { id: me.customerId }, data });
        await this.audit.record(
          {
            actorCustomerId: me.customerId,
            action: AuditAction.CUSTOMER_PROFILE_UPDATED_BY_CUSTOMER,
            entityType: 'Customer',
            entityId: me.customerId,
            metadata: { fields: Object.keys(data) },
            meta,
          },
          tx,
        );
      });
    }
    return this.profile(me);
  }

  // ---- brands -------------------------------------------------------------------------------

  async brands(me: CustomerPrincipal): Promise<CustomerBrandDto[]> {
    return this.prisma.brand.findMany({
      where: { customerId: me.customerId, archivedAt: null },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: brandSelect,
    });
  }

  async brand(me: CustomerPrincipal, id: string): Promise<CustomerBrandDto> {
    const brand = await this.prisma.brand.findFirst({
      where: { id, customerId: me.customerId, archivedAt: null },
      select: brandSelect,
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  /**
   * Creates a brand for the signed-in customer through the same BrandsService staff use (same numbering,
   * duplicate-name rule and audit), always ACTIVE so it is usable for samples immediately.
   */
  async createBrand(
    me: CustomerPrincipal,
    dto: CustomerCreateBrandDto,
    meta: RequestMeta,
  ): Promise<CustomerBrandDto> {
    const created = await this.brandsService.create(
      me.customerId,
      Object.assign({}, dto, { status: 'ACTIVE' as const }),
      { id: me.customerId, customer: true },
      meta,
    );
    return this.brand(me, created.id);
  }

  async updateBrand(
    me: CustomerPrincipal,
    id: string,
    dto: CustomerUpdateBrandDto,
    meta: RequestMeta,
  ): Promise<CustomerBrandDto> {
    await this.brand(me, id); // 404 for foreign or archived brands
    await this.brandsService.update(
      id,
      Object.assign({}, dto),
      { id: me.customerId, customer: true },
      meta,
    );
    return this.brand(me, id);
  }

  // ---- addresses ---------------------------------------------------------------------------

  async addresses(
    me: CustomerPrincipal,
  ): Promise<CustomerAddressResponseDto[]> {
    return this.contacts.listAddresses(me.customerId);
  }

  async createAddress(
    me: CustomerPrincipal,
    dto: CreateAddressDto,
    meta: RequestMeta,
  ): Promise<CustomerAddressResponseDto> {
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: me.customerId },
      select: { status: true },
    });
    if (customer.status === 'ARCHIVED' || customer.status === 'BLOCKED')
      throw new ConflictException('This account cannot add addresses');
    return this.contacts.createAddress(
      me.customerId,
      dto,
      { id: me.customerId, customer: true },
      meta,
    );
  }

  async updateAddress(
    me: CustomerPrincipal,
    id: string,
    dto: UpdateAddressDto,
    meta: RequestMeta,
  ): Promise<CustomerAddressResponseDto> {
    const own = await this.prisma.customerAddress.findFirst({
      where: { id, customerId: me.customerId, archivedAt: null },
      select: { id: true },
    });
    if (!own) throw new NotFoundException('Address not found');
    return this.contacts.updateAddress(
      id,
      dto,
      { id: me.customerId, customer: true },
      meta,
    );
  }
}
