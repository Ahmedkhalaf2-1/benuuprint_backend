import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/app.config.js';
import { AuditAction } from '../../../common/enums/audit-actions.js';
import type { RequestMeta } from '../../../common/types/auth-user.js';
import { ReferenceService } from '../../../database/reference-sequence.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { INVALID_TOKEN_MESSAGE } from '../../auth/account-tokens.service.js';
import { PasswordService } from '../../auth/password.service.js';
import type {
  RegisterCustomerDto,
  RegisterCustomerResponseDto,
  ResendVerificationResponseDto,
  VerifyEmailResponseDto,
} from '../dto/customer-signup.dto.js';
import { CustomerAccountTokensService } from './customer-account-tokens.service.js';
import { portalCustomerAllowed } from './customer-auth-context.service.js';
import { CustomerVerificationEmailService } from './customer-verification-email.service.js';

export const RESEND_VERIFICATION_MESSAGE =
  'If that email belongs to an account awaiting verification, a new verification link has been sent.';

/** A visitor may ask for a new link this often, and at most this many times per rolling hour. */
export const RESEND_COOLDOWN_MS = 60_000;
export const RESEND_MAX_PER_HOUR = 5;

const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

/** Public self-registration and email verification for portal accounts. */
@Injectable()
export class CustomerSignupService {
  private readonly verificationRequired: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly references: ReferenceService,
    private readonly accountTokens: CustomerAccountTokensService,
    private readonly mailer: CustomerVerificationEmailService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.verificationRequired =
      config.getOrThrow<AppConfig>(
        'app',
      ).customerAuth.emailVerificationRequired;
  }

  get emailVerificationRequired(): boolean {
    return this.verificationRequired;
  }

  async register(
    dto: RegisterCustomerDto,
    meta: RequestMeta,
  ): Promise<RegisterCustomerResponseDto> {
    // Registration answers 409 for a taken email (explicit UX choice, documented); recovery flows stay generic.
    if (
      await this.prisma.customerAccount.findUnique({
        where: { email: dto.email },
        select: { id: true },
      })
    ) {
      throw new ConflictException(
        'An account with this email already exists. Try signing in instead.',
      );
    }
    const passwordHash = await this.passwords.hash(dto.password);

    const { account, issued } = await this.prisma.$transaction(async (tx) => {
      const customerNumber = await this.references.next('CUS', tx);
      const customer = await tx.customer.create({
        data: {
          customerNumber,
          displayName: dto.name,
          email: dto.email,
          phone: dto.phone,
          source: 'SELF_SIGNUP',
          status: 'ACTIVE',
        },
      });
      const now = new Date();
      const account = await tx.customerAccount.create({
        data: {
          customerId: customer.id,
          email: dto.email,
          passwordHash,
          passwordChangedAt: now,
          status: this.verificationRequired ? 'PENDING_VERIFICATION' : 'ACTIVE',
          selfRegistered: true,
          termsAcceptedAt: now,
          privacyAcceptedAt: now,
        },
      });
      // With verification switched off no token is created (and nothing is emailed).
      const issued = this.verificationRequired
        ? await this.accountTokens.issue(tx, account.id, 'EMAIL_VERIFICATION')
        : null;
      await this.audit.record(
        {
          actorCustomerId: customer.id,
          action: AuditAction.CUSTOMER_SELF_REGISTERED,
          entityType: 'CustomerAccount',
          entityId: account.id,
          metadata: {
            customerNumber,
            acceptedTerms: true,
            acceptedPrivacy: true,
            verificationRequired: this.verificationRequired,
            ...(issued && { expiresAt: issued.expiresAt }),
          },
          meta,
        },
        tx,
      );
      return { account, issued };
    });

    if (issued) {
      await this.mailer.send({
        tokenId: issued.id,
        to: account.email,
        name: dto.name,
        token: issued.token,
        expiresAt: issued.expiresAt,
      });
    }
    return {
      status: issued ? 'verification_required' : 'registered',
      email: maskEmail(account.email),
      emailVerificationRequired: this.verificationRequired,
    };
  }

  /** One-time, replay-safe. Does not log the customer in: they sign in normally afterwards. */
  async verifyEmail(
    token: string,
    meta: RequestMeta,
  ): Promise<VerifyEmailResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { accountId } = await this.accountTokens.consume(
        tx,
        token,
        'EMAIL_VERIFICATION',
      );
      const account = await tx.customerAccount.findFirst({
        where: { id: accountId, status: 'PENDING_VERIFICATION' },
        include: { customer: true },
      });
      if (!account || !portalCustomerAllowed(account.customer)) {
        throw new BadRequestException(INVALID_TOKEN_MESSAGE);
      }
      await tx.customerAccount.update({
        where: { id: accountId },
        data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      });
      await this.accountTokens.revokeOpen(tx, accountId, 'EMAIL_VERIFICATION');
      await this.audit.record(
        {
          actorCustomerId: account.customerId,
          action: AuditAction.CUSTOMER_EMAIL_VERIFIED,
          entityType: 'CustomerAccount',
          entityId: accountId,
          meta,
        },
        tx,
      );
    });
    return { status: 'verified' };
  }

  /** Same response for every input; only an eligible, not recently served account actually gets a link. */
  async resend(
    email: string,
    meta: RequestMeta,
  ): Promise<ResendVerificationResponseDto> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { email },
      include: { customer: true },
    });
    if (
      account?.status === 'PENDING_VERIFICATION' &&
      portalCustomerAllowed(account.customer)
    ) {
      const issued = await this.prisma.$transaction(async (tx) => {
        const recent = await tx.customerAccountToken.findMany({
          where: {
            accountId: account.id,
            type: 'EMAIL_VERIFICATION',
            createdAt: { gt: new Date(Date.now() - 3_600_000) },
          },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
        });
        const last = recent[0]?.createdAt.getTime() ?? 0;
        if (
          recent.length >= RESEND_MAX_PER_HOUR ||
          Date.now() - last < RESEND_COOLDOWN_MS
        ) {
          return null;
        }
        const token = await this.accountTokens.issue(
          tx,
          account.id,
          'EMAIL_VERIFICATION',
        );
        await this.audit.record(
          {
            actorCustomerId: account.customerId,
            action: AuditAction.CUSTOMER_VERIFICATION_RESENT,
            entityType: 'CustomerAccount',
            entityId: account.id,
            metadata: { expiresAt: token.expiresAt },
            meta,
          },
          tx,
        );
        return token;
      });
      if (issued) {
        await this.mailer.send({
          tokenId: issued.id,
          to: account.email,
          name: account.customer.displayName,
          token: issued.token,
          expiresAt: issued.expiresAt,
        });
      }
    } else {
      await this.passwords.verifyDummy('resend-verification-timing');
    }
    return { message: RESEND_VERIFICATION_MESSAGE };
  }
}
