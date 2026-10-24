import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditAction } from '../../../common/enums/audit-actions.js';
import type { RequestMeta } from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { FORGOT_PASSWORD_MESSAGE } from '../../auth/account-recovery.service.js';
import { INVALID_TOKEN_MESSAGE } from '../../auth/account-tokens.service.js';
import { PasswordService } from '../../auth/password.service.js';
import { TokenDelivery } from '../../auth/token-delivery.js';
import { CustomerAccountTokensService } from './customer-account-tokens.service.js';
import { portalCustomerAllowed } from './customer-auth-context.service.js';

/** Invitation acceptance and password reset for portal accounts. */
@Injectable()
export class CustomerRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly accountTokens: CustomerAccountTokensService,
    private readonly delivery: TokenDelivery,
    private readonly audit: AuditService,
  ) {}

  /** Same response whether or not the email exists; delivery happens out of band. */
  async forgotPassword(
    email: string,
    meta: RequestMeta,
  ): Promise<{ message: string }> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { email },
      include: { customer: true },
    });
    if (
      account &&
      account.status === 'ACTIVE' &&
      portalCustomerAllowed(account.customer)
    ) {
      const issued = await this.prisma.$transaction(async (tx) => {
        const token = await this.accountTokens.issue(
          tx,
          account.id,
          'PASSWORD_RESET',
        );
        await this.audit.record(
          {
            actorCustomerId: account.customerId,
            action: AuditAction.CUSTOMER_PASSWORD_RESET_REQUESTED,
            entityType: 'CustomerAccount',
            entityId: account.id,
            metadata: { expiresAt: token.expiresAt },
            meta,
          },
          tx,
        );
        return token;
      });
      await this.delivery.deliver({
        type: 'PASSWORD_RESET',
        user: {
          id: account.id,
          email: account.email,
          name: account.customer.displayName,
        },
        token: issued.token,
        expiresAt: issued.expiresAt,
      });
    } else {
      await this.passwords.verifyDummy('forgot-password-timing-equalisation');
    }
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  async resetPassword(
    token: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const { accountId } = await this.accountTokens.consume(
        tx,
        token,
        'PASSWORD_RESET',
      );
      const account = await tx.customerAccount.findFirst({
        where: { id: accountId, status: 'ACTIVE' },
        include: { customer: true },
      });
      if (!account || !portalCustomerAllowed(account.customer)) {
        throw new BadRequestException(INVALID_TOKEN_MESSAGE);
      }
      const now = new Date();
      await tx.customerAccount.update({
        where: { id: accountId },
        data: { passwordHash, passwordChangedAt: now },
      });
      const { count } = await tx.customerSession.updateMany({
        where: { accountId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.accountTokens.revokeOpen(tx, accountId, 'PASSWORD_RESET');
      await this.audit.record(
        {
          actorCustomerId: account.customerId,
          action: AuditAction.CUSTOMER_PASSWORD_RESET_COMPLETED,
          entityType: 'CustomerAccount',
          entityId: accountId,
          metadata: { revokedSessions: count },
          meta,
        },
        tx,
      );
    });
  }

  /** Activates an INVITED account with the chosen password; the customer then logs in normally. */
  async acceptInvitation(
    token: string,
    password: string,
    meta: RequestMeta,
  ): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      const { accountId } = await this.accountTokens.consume(
        tx,
        token,
        'INVITATION',
      );
      const account = await tx.customerAccount.findFirst({
        where: { id: accountId, status: 'INVITED' },
        include: { customer: true },
      });
      if (!account || !portalCustomerAllowed(account.customer)) {
        throw new BadRequestException(INVALID_TOKEN_MESSAGE);
      }
      await tx.customerAccount.update({
        where: { id: accountId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          emailVerifiedAt: new Date(),
          status: 'ACTIVE',
        },
      });
      await this.audit.record(
        {
          actorCustomerId: account.customerId,
          action: AuditAction.CUSTOMER_PORTAL_INVITATION_ACCEPTED,
          entityType: 'CustomerAccount',
          entityId: accountId,
          meta,
        },
        tx,
      );
    });
  }
}
