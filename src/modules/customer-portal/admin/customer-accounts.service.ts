import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '../../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../../common/types/auth-user.js';
import type { AppConfig } from '../../../config/app.config.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { CustomerAccount } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { TokenDelivery } from '../../auth/token-delivery.js';
import { CustomerAccountTokensService } from '../auth/customer-account-tokens.service.js';
import type {
  PortalAccountDto,
  PortalInvitationDto,
} from '../dto/customer-account-admin.dto.js';

const toDto = (a: CustomerAccount): PortalAccountDto => ({
  id: a.id,
  customerId: a.customerId,
  email: a.email,
  status: a.status,
  lastLoginAt: a.lastLoginAt,
  createdAt: a.createdAt,
});

/** Staff provisioning of customer portal logins (the only way an account comes into existence). */
@Injectable()
export class CustomerAccountsAdminService {
  private readonly publicAppUrl: string | undefined;
  private readonly verificationRequired: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountTokens: CustomerAccountTokensService,
    private readonly delivery: TokenDelivery,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.publicAppUrl = app.publicAppUrl;
    this.verificationRequired = app.customerAuth.emailVerificationRequired;
  }

  async get(customerId: string): Promise<PortalAccountDto> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { customerId },
    });
    if (!account) throw new NotFoundException('No portal account');
    return toDto(account);
  }

  async create(
    customerId: string,
    email: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PortalInvitationDto> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (
      customer.archivedAt ||
      customer.status === 'ARCHIVED' ||
      customer.status === 'BLOCKED'
    ) {
      throw new ConflictException(
        `A ${customer.status.toLowerCase()} customer cannot get a portal account`,
      );
    }
    const [forCustomer, forEmail] = await Promise.all([
      this.prisma.customerAccount.findUnique({ where: { customerId } }),
      this.prisma.customerAccount.findUnique({ where: { email } }),
    ]);
    if (forCustomer)
      throw new ConflictException('This customer already has a portal account');
    if (forEmail)
      throw new ConflictException(
        'That email is already used by another portal account',
      );

    const { account, issued } = await this.prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.create({
        data: { customerId, email, createdByUserId: actor.id },
      });
      const issued = await this.accountTokens.issue(
        tx,
        account.id,
        'INVITATION',
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CUSTOMER_PORTAL_ACCOUNT_CREATED,
          entityType: 'CustomerAccount',
          entityId: account.id,
          metadata: {
            customerId,
            customerNumber: customer.customerNumber,
            tokenExposedToAdmin: this.accountTokens.exposeTokens,
          },
          meta,
        },
        tx,
      );
      return { account, issued };
    });
    return this.deliverInvitation(account, customer.displayName, issued);
  }

  /** A fresh invitation for an account that has not been activated yet. */
  async reinvite(
    customerId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PortalInvitationDto> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { customerId },
      include: { customer: true },
    });
    if (!account) throw new NotFoundException('No portal account');
    if (account.status !== 'INVITED') {
      throw new ConflictException(
        'Only accounts awaiting activation (INVITED) can be invited again',
      );
    }
    const issued = await this.prisma.$transaction(async (tx) => {
      const token = await this.accountTokens.issue(
        tx,
        account.id,
        'INVITATION',
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CUSTOMER_PORTAL_INVITATION_CREATED,
          entityType: 'CustomerAccount',
          entityId: account.id,
          metadata: {
            customerId,
            tokenExposedToAdmin: this.accountTokens.exposeTokens,
          },
          meta,
        },
        tx,
      );
      return token;
    });
    return this.deliverInvitation(
      account,
      account.customer.displayName,
      issued,
    );
  }

  /** Disabling revokes every session and open token; enabling needs an activated account. */
  async setEnabled(
    customerId: string,
    enabled: boolean,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<PortalAccountDto> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { customerId },
    });
    if (!account) throw new NotFoundException('No portal account');
    if (enabled && !account.passwordHash) {
      throw new ConflictException(
        'The customer has not activated this account yet; send an invitation instead',
      );
    }
    if (enabled && !account.emailVerifiedAt && this.verificationRequired) {
      throw new ConflictException(
        'The customer has not verified their email yet; they must use the verification link',
      );
    }
    const target = enabled ? 'ACTIVE' : 'DISABLED';
    if (account.status === target) return toDto(account);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.customerAccount.update({
        where: { id: account.id },
        data: { status: target },
      });
      if (!enabled) {
        await tx.customerSession.updateMany({
          where: { accountId: account.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.accountTokens.revokeOpen(tx, account.id);
      }
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CUSTOMER_PORTAL_ACCOUNT_STATUS_CHANGED,
          entityType: 'CustomerAccount',
          entityId: account.id,
          metadata: { customerId, from: account.status, to: target },
          meta,
        },
        tx,
      );
      return row;
    });
    return toDto(updated);
  }

  private async deliverInvitation(
    account: CustomerAccount,
    name: string,
    issued: { token: string; expiresAt: Date },
  ): Promise<PortalInvitationDto> {
    await this.delivery.deliver({
      type: 'INVITATION',
      user: { id: account.id, email: account.email, name },
      token: issued.token,
      expiresAt: issued.expiresAt,
    });
    const expose = this.accountTokens.exposeTokens;
    return Object.assign(toDto(account), {
      expiresAt: issued.expiresAt,
      ...(expose && {
        inviteToken: issued.token,
        ...(this.publicAppUrl && {
          inviteUrl: `${this.publicAppUrl.replace(/\/$/, '')}/portal/activate?token=${encodeURIComponent(issued.token)}`,
        }),
      }),
    });
  }
}
