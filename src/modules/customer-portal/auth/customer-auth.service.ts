import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/app.config.js';
import { AuditAction } from '../../../common/enums/audit-actions.js';
import type {
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { TokenPairDto } from '../../auth/dto/auth.dto.js';
import { PasswordService } from '../../auth/password.service.js';
import type {
  CustomerLoginResponseDto,
  CustomerMeDto,
} from '../dto/customer-auth.dto.js';
import { CustomerAccountTokensService } from './customer-account-tokens.service.js';
import { portalCustomerAllowed } from './customer-auth-context.service.js';
import { CustomerTokenService } from './customer-token.service.js';

const INVALID_LOGIN = 'Invalid email or password';
const INVALID_REFRESH = 'Invalid or expired refresh token';

@Injectable()
export class CustomerAuthService {
  private readonly verificationRequired: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: CustomerTokenService,
    private readonly accountTokens: CustomerAccountTokensService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.verificationRequired =
      config.getOrThrow<AppConfig>(
        'app',
      ).customerAuth.emailVerificationRequired;
  }

  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<CustomerLoginResponseDto> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { email },
      include: { customer: true },
    });

    let failure: 'unknown_account' | 'bad_password' | 'inactive' | null = null;
    if (!account) {
      await this.passwords.verifyDummy(password);
      failure = 'unknown_account';
    } else if (
      !account.passwordHash ||
      !(await this.passwords.verify(account.passwordHash, password))
    ) {
      if (!account.passwordHash) await this.passwords.verifyDummy(password);
      failure = 'bad_password';
    } else if (
      (account.status !== 'ACTIVE' &&
        account.status !== 'PENDING_VERIFICATION') ||
      !portalCustomerAllowed(account.customer)
    ) {
      failure = 'inactive';
    }

    // Correct password on a self-registered account that has not verified yet: say so (the caller has
    // proven they own the credentials, so nothing about other accounts leaks). No session is issued.
    if (
      !failure &&
      account?.status === 'PENDING_VERIFICATION' &&
      this.verificationRequired
    ) {
      await this.audit.record({
        actorCustomerId: account.customerId,
        action: AuditAction.CUSTOMER_LOGIN_FAILED,
        entityType: 'CustomerAccount',
        entityId: account.id,
        metadata: { reason: 'email_not_verified' },
        meta,
      });
      throw new ForbiddenException({
        message: 'Please verify your email address before signing in',
        error: 'EMAIL_NOT_VERIFIED',
      });
    }

    if (failure || !account) {
      // The client always gets the same response; the reason is audit-only.
      await this.audit.record({
        actorCustomerId: account?.customerId ?? null,
        action: AuditAction.CUSTOMER_LOGIN_FAILED,
        entityType: 'CustomerAccount',
        entityId: account?.id ?? null,
        metadata: { reason: failure, attemptedEmail: email.slice(0, 254) },
        meta,
      });
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    const pair = await this.prisma.$transaction(async (tx) => {
      // Verification switched off: an account that registered while it was on is let in (still unverified).
      if (account.status === 'PENDING_VERIFICATION') {
        await tx.customerAccount.update({
          where: { id: account.id },
          data: { status: 'ACTIVE' },
        });
      }
      const sessionId = this.tokens.newSessionId();
      const secret = this.tokens.newRefreshSecret();
      const now = new Date();
      await tx.customerSession.create({
        data: {
          id: sessionId,
          accountId: account.id,
          refreshTokenHash: this.tokens.hashSecret(secret),
          userAgent: meta.userAgent,
          ipAddress: meta.ipAddress,
          expiresAt: new Date(now.getTime() + this.tokens.refreshTtlMs),
        },
      });
      await tx.customerAccount.update({
        where: { id: account.id },
        data: { lastLoginAt: now },
      });
      await this.audit.record(
        {
          actorCustomerId: account.customerId,
          action: AuditAction.CUSTOMER_LOGIN_SUCCESS,
          entityType: 'CustomerSession',
          entityId: sessionId,
          meta,
        },
        tx,
      );
      return this.issuePair(account.id, sessionId, secret);
    });

    return Object.assign(pair, {
      customer: {
        id: account.customerId,
        customerNumber: account.customer.customerNumber,
        name: account.customer.displayName,
        email: account.email,
      },
    });
  }

  async refresh(
    refreshToken: string,
    meta: RequestMeta,
  ): Promise<TokenPairDto> {
    const parts = this.tokens.parseRefreshToken(refreshToken);
    if (!parts) throw new UnauthorizedException(INVALID_REFRESH);

    const session = await this.prisma.customerSession.findUnique({
      where: { id: parts.sessionId },
      include: { account: { include: { customer: true } } },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.account.status !== 'ACTIVE' ||
      !portalCustomerAllowed(session.account.customer)
    ) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    // Rotation: swap the stored hash only if it still matches the presented secret. A mismatch means an
    // old (already rotated) token was replayed: treat it as theft and revoke the session.
    const newSecret = this.tokens.newRefreshSecret();
    const matches = this.tokens.secretMatches(
      parts.secret,
      session.refreshTokenHash,
    );
    const rotated = matches
      ? await this.prisma.customerSession.updateMany({
          where: {
            id: session.id,
            refreshTokenHash: session.refreshTokenHash,
            revokedAt: null,
          },
          data: {
            refreshTokenHash: this.tokens.hashSecret(newSecret),
            lastUsedAt: new Date(),
            ipAddress: meta.ipAddress ?? session.ipAddress,
            userAgent: meta.userAgent ?? session.userAgent,
          },
        })
      : { count: 0 };

    if (rotated.count !== 1) {
      await this.prisma.$transaction(async (tx) => {
        await tx.customerSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.record(
          {
            actorCustomerId: session.account.customerId,
            action: AuditAction.CUSTOMER_REFRESH_REUSE_DETECTED,
            entityType: 'CustomerSession',
            entityId: session.id,
            meta,
          },
          tx,
        );
      });
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    return this.issuePair(session.accountId, session.id, newSecret);
  }

  async logout(me: CustomerPrincipal, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.customerSession.updateMany({
        where: { id: me.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        {
          actorCustomerId: me.customerId,
          action: AuditAction.CUSTOMER_LOGOUT,
          entityType: 'CustomerSession',
          entityId: me.sessionId,
          meta,
        },
        tx,
      );
    });
  }

  async me(me: CustomerPrincipal): Promise<CustomerMeDto> {
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: me.customerId },
      select: {
        id: true,
        customerNumber: true,
        displayName: true,
        phone: true,
        whatsapp: true,
      },
    });
    return {
      id: customer.id,
      customerNumber: customer.customerNumber,
      name: customer.displayName,
      email: me.email,
      phone: customer.phone,
      whatsapp: customer.whatsapp,
      accountStatus: 'ACTIVE',
    };
  }

  async changePassword(
    me: CustomerPrincipal,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const account = await this.prisma.customerAccount.findUniqueOrThrow({
      where: { id: me.accountId },
    });
    if (
      !account.passwordHash ||
      !(await this.passwords.verify(account.passwordHash, currentPassword))
    ) {
      // 400, not 401: a 401 would make clients attempt a token refresh loop.
      throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.customerAccount.update({
        where: { id: me.accountId },
        data: { passwordHash, passwordChangedAt: now },
      });
      const { count } = await tx.customerSession.updateMany({
        where: { accountId: me.accountId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.accountTokens.revokeOpen(tx, me.accountId, 'PASSWORD_RESET');
      await this.audit.record(
        {
          actorCustomerId: me.customerId,
          action: AuditAction.CUSTOMER_PASSWORD_CHANGED,
          entityType: 'CustomerAccount',
          entityId: me.accountId,
          metadata: { revokedSessions: count },
          meta,
        },
        tx,
      );
    });
  }

  private async issuePair(
    accountId: string,
    sessionId: string,
    secret: string,
  ): Promise<TokenPairDto> {
    return {
      accessToken: await this.tokens.signAccessToken(accountId, sessionId),
      refreshToken: this.tokens.formatRefreshToken(sessionId, secret),
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }
}
