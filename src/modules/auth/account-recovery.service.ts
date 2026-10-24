import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AccountTokensService,
  INVALID_TOKEN_MESSAGE,
} from './account-tokens.service.js';
import { PasswordService } from './password.service.js';
import { TokenDelivery } from './token-delivery.js';

export const FORGOT_PASSWORD_MESSAGE =
  'If an active account exists for that email, a password reset link has been sent.';

@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly accountTokens: AccountTokensService,
    private readonly delivery: TokenDelivery,
    private readonly audit: AuditService,
  ) {}

  /** Same response whether or not the email exists; delivery happens out of band. */
  async forgotPassword(
    email: string,
    meta: RequestMeta,
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null, isActive: true, status: 'ACTIVE' },
    });
    if (user) {
      const issued = await this.prisma.$transaction(async (tx) => {
        const token = await this.accountTokens.issue(
          tx,
          user.id,
          'PASSWORD_RESET',
          null,
        );
        await this.audit.record(
          {
            actorUserId: null,
            action: AuditAction.PASSWORD_RESET_REQUESTED,
            entityType: 'User',
            entityId: user.id,
            metadata: { expiresAt: token.expiresAt },
            meta,
          },
          tx,
        );
        return token;
      });
      await this.delivery.deliver({
        type: 'PASSWORD_RESET',
        user: { id: user.id, email: user.email, name: user.name },
        token: issued.token,
        expiresAt: issued.expiresAt,
      });
    } else {
      // Spend comparable time so response latency does not reveal existence.
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
      const { userId } = await this.accountTokens.consume(
        tx,
        token,
        'PASSWORD_RESET',
      );
      const user = await tx.user.findFirst({
        where: {
          id: userId,
          deletedAt: null,
          isActive: true,
          status: 'ACTIVE',
        },
      });
      if (!user) {
        // Account was suspended/archived after the link was issued.
        throw new BadRequestException(INVALID_TOKEN_MESSAGE);
      }
      const now = new Date();
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: now },
      });
      const { count } = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.accountTokens.revokeOpen(tx, userId, 'PASSWORD_RESET');
      await this.audit.record(
        {
          actorUserId: userId,
          action: AuditAction.PASSWORD_RESET_COMPLETED,
          entityType: 'User',
          entityId: userId,
          metadata: { revokedSessions: count },
          meta,
        },
        tx,
      );
    });
  }

  async acceptInvitation(
    token: string,
    password: string,
    meta: RequestMeta,
  ): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      const { userId } = await this.accountTokens.consume(
        tx,
        token,
        'INVITATION',
      );
      const user = await tx.user.findFirst({
        where: { id: userId, deletedAt: null, status: 'INVITED' },
      });
      if (!user) {
        throw new BadRequestException(INVALID_TOKEN_MESSAGE);
      }
      const now = new Date();
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: now,
          status: 'ACTIVE',
          isActive: true,
        },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          actorUserId: userId,
          action: AuditAction.INVITATION_ACCEPTED,
          entityType: 'User',
          entityId: userId,
          meta,
        },
        tx,
      );
    });
  }
}
