import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/app.config.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  Prisma,
  UserTokenType,
} from '../../../generated/prisma/client.js';
import {
  INVALID_TOKEN_MESSAGE,
  type IssuedToken,
} from '../../auth/account-tokens.service.js';
import { TokenService } from '../../auth/token.service.js';

/**
 * Single-use, expiring, hashed tokens for customer invitations and password resets. Same format and
 * guarantees as the staff AccountTokensService (`<id>.<secret>`, constant-time compare, atomic single
 * use) but stored in customer_account_tokens, so a staff token can never be consumed here or vice versa.
 */
@Injectable()
export class CustomerAccountTokensService {
  private readonly ttl: AppConfig['accountTokens'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    config: ConfigService,
  ) {
    this.ttl = config.getOrThrow<AppConfig>('app').accountTokens;
  }

  get exposeTokens(): boolean {
    return this.ttl.exposeTokens;
  }

  async issue(
    tx: Prisma.TransactionClient,
    accountId: string,
    type: UserTokenType,
  ): Promise<IssuedToken> {
    await this.revokeOpen(tx, accountId, type);
    const ttlMs =
      type === 'INVITATION'
        ? this.ttl.invitationTtlHours * 3_600_000
        : type === 'EMAIL_VERIFICATION'
          ? this.ttl.emailVerificationTtlHours * 3_600_000
          : this.ttl.passwordResetTtlMinutes * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const secret = randomBytes(32).toString('base64url');
    const row = await tx.customerAccountToken.create({
      data: {
        accountId,
        type,
        tokenHash: this.tokens.hashSecret(secret),
        expiresAt,
      },
    });
    return { id: row.id, token: `${row.id}.${secret}`, expiresAt };
  }

  /** Every failure (malformed, unknown, wrong type, expired, used, revoked) gives the same error. */
  async consume(
    tx: Prisma.TransactionClient,
    presented: string,
    type: UserTokenType,
  ): Promise<{ accountId: string }> {
    const dot = presented.indexOf('.');
    const id = dot > 0 ? presented.slice(0, dot) : '';
    const secret = dot > 0 ? presented.slice(dot + 1) : '';
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(id) || secret.length < 20 || secret.length > 200) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    const row = await tx.customerAccountToken.findUnique({ where: { id } });
    if (
      !row ||
      row.type !== type ||
      !this.tokens.secretMatches(secret, row.tokenHash) ||
      row.consumedAt ||
      row.revokedAt ||
      row.expiresAt <= new Date()
    ) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    const { count } = await tx.customerAccountToken.updateMany({
      where: { id, consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count !== 1) throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    return { accountId: row.accountId };
  }

  revokeOpen(
    tx: Prisma.TransactionClient,
    accountId: string,
    type?: UserTokenType,
  ) {
    return tx.customerAccountToken.updateMany({
      where: {
        accountId,
        ...(type && { type }),
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }
}
