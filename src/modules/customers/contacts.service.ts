import { toPlain } from '../../common/plain.js';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import {
  auditActor,
  type ActorRef,
  type AuthUser,
  type RequestMeta,
} from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateAddressDto,
  CreateContactDto,
  UpdateAddressDto,
  UpdateContactDto,
} from './dto/contact-address.dto.js';
import type {
  CustomerAddressResponseDto,
  CustomerContactResponseDto,
} from './dto/customer.dto.js';

type ContactRow = Prisma.CustomerContactGetPayload<object>;
type AddressRow = Prisma.CustomerAddressGetPayload<object>;

const toContact = ({
  customerId: _c,
  archivedAt: _a,
  ...rest
}: ContactRow): CustomerContactResponseDto => rest;
const toAddress = ({
  customerId: _c,
  archivedAt: _a,
  ...rest
}: AddressRow): CustomerAddressResponseDto => rest;

/** Strip undefined so Prisma leaves untouched fields alone; null passes through to clear. */
function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- contacts -----------------------------------------------------------

  async listContacts(
    customerId: string,
  ): Promise<CustomerContactResponseDto[]> {
    await this.assertCustomer(customerId);
    const rows = await this.prisma.customerContact.findMany({
      where: { customerId, archivedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toContact);
  }

  async createContact(
    customerId: string,
    dto: CreateContactDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CustomerContactResponseDto> {
    await this.assertLiveCustomer(customerId);
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) await this.demotePrimary(tx, customerId);
      const contact = await tx.customerContact.create({
        data: { ...defined(dto), customerId, name: dto.name },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CONTACT_CREATED,
          entityType: 'CustomerContact',
          entityId: contact.id,
          metadata: {
            customerId,
            role: contact.role,
            isPrimary: contact.isPrimary,
          },
          meta,
        },
        tx,
      );
      return contact;
    });
    return toContact(row);
  }

  async updateContact(
    id: string,
    dto: UpdateContactDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CustomerContactResponseDto> {
    const existing = await this.findContact(id);
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) await this.demotePrimary(tx, existing.customerId, id);
      const updated = await tx.customerContact.update({
        where: { id },
        data: defined(
          Object.assign(toPlain(dto), { name: dto.name ?? undefined }),
        ),
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CONTACT_UPDATED,
          entityType: 'CustomerContact',
          entityId: id,
          metadata: {
            customerId: existing.customerId,
            fields: Object.keys(defined(dto)),
          },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toContact(row);
  }

  async archiveContact(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.findContact(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.customerContact.update({
        where: { id },
        data: { archivedAt: new Date(), isPrimary: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CONTACT_ARCHIVED,
          entityType: 'CustomerContact',
          entityId: id,
          metadata: { customerId: existing.customerId },
          meta,
        },
        tx,
      );
    });
  }

  // ---- addresses ----------------------------------------------------------

  async listAddresses(
    customerId: string,
  ): Promise<CustomerAddressResponseDto[]> {
    await this.assertCustomer(customerId);
    const rows = await this.prisma.customerAddress.findMany({
      where: { customerId, archivedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map(toAddress);
  }

  async createAddress(
    customerId: string,
    dto: CreateAddressDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<CustomerAddressResponseDto> {
    await this.assertLiveCustomer(customerId);
    const row = await this.prisma.$transaction(async (tx) => {
      const type = dto.type ?? 'SHIPPING';
      if (dto.isDefault) await this.demoteDefault(tx, customerId, type);
      const address = await tx.customerAddress.create({
        data: {
          ...defined(dto),
          customerId,
          type,
          country: dto.country,
          city: dto.city,
          addressLine1: dto.addressLine1,
        },
      });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.ADDRESS_CREATED,
          entityType: 'CustomerAddress',
          entityId: address.id,
          metadata: {
            customerId,
            type,
            city: address.city,
            isDefault: address.isDefault,
          },
          meta,
        },
        tx,
      );
      return address;
    });
    return toAddress(row);
  }

  async updateAddress(
    id: string,
    dto: UpdateAddressDto,
    actor: ActorRef,
    meta: RequestMeta,
  ): Promise<CustomerAddressResponseDto> {
    const existing = await this.findAddress(id);
    const row = await this.prisma.$transaction(async (tx) => {
      const type = dto.type ?? existing.type;
      if (dto.isDefault ?? (existing.isDefault && dto.type !== undefined)) {
        await this.demoteDefault(tx, existing.customerId, type, id);
      }
      const updated = await tx.customerAddress.update({
        where: { id },
        data: defined(
          Object.assign(toPlain(dto), {
            country: dto.country ?? undefined,
            city: dto.city ?? undefined,
            addressLine1: dto.addressLine1 ?? undefined,
          }),
        ),
      });
      await this.audit.record(
        {
          ...auditActor(actor),
          action: AuditAction.ADDRESS_UPDATED,
          entityType: 'CustomerAddress',
          entityId: id,
          metadata: {
            customerId: existing.customerId,
            fields: Object.keys(defined(dto)),
          },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toAddress(row);
  }

  async archiveAddress(
    id: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const existing = await this.findAddress(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.customerAddress.update({
        where: { id },
        data: { archivedAt: new Date(), isDefault: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ADDRESS_ARCHIVED,
          entityType: 'CustomerAddress',
          entityId: id,
          metadata: { customerId: existing.customerId },
          meta,
        },
        tx,
      );
    });
  }

  // ---- helpers ------------------------------------------------------------

  private demotePrimary(
    tx: Prisma.TransactionClient,
    customerId: string,
    exceptId?: string,
  ) {
    return tx.customerContact.updateMany({
      where: {
        customerId,
        isPrimary: true,
        archivedAt: null,
        id: { not: exceptId },
      },
      data: { isPrimary: false },
    });
  }

  private demoteDefault(
    tx: Prisma.TransactionClient,
    customerId: string,
    type: AddressRow['type'],
    exceptId?: string,
  ) {
    return tx.customerAddress.updateMany({
      where: {
        customerId,
        type,
        isDefault: true,
        archivedAt: null,
        id: { not: exceptId },
      },
      data: { isDefault: false },
    });
  }

  private async assertCustomer(id: string): Promise<void> {
    if (
      !(await this.prisma.customer.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Customer not found');
    }
  }

  private async assertLiveCustomer(id: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.status === 'ARCHIVED') {
      throw new ConflictException('Customer is archived');
    }
  }

  private async findContact(id: string): Promise<ContactRow> {
    const row = await this.prisma.customerContact.findFirst({
      where: { id, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Contact not found');
    return row;
  }

  private async findAddress(id: string): Promise<AddressRow> {
    const row = await this.prisma.customerAddress.findFirst({
      where: { id, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Address not found');
    return row;
  }
}
