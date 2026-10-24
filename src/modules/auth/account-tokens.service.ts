import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, UserTokenType } from '../../generated/prisma/client.js';
import { TokenService } from './token.service.js';

export const INVALID_TOKEN_MESSAGE = 'Invalid or expired token';

export interface IssuedToken {
  id: string;
  token: string;
  expiresAt: Date;
}

/**
 * Single-use, expiring, hashed tokens for invitations and password resets.
 * Format `<id>.<secret>`: lookup by primary key, constant-time hash compare,
 * only sha256(secret) is stored.
 */
@Injectable()
export class AccountTokensService {
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

  /** Issue a token, revoking any still-open token of the same type for that user. */
  async issue(
    tx: Prisma.TransactionClient,
    userId: string,
    type: UserTokenType,
    createdById: string | null,
  ): Promise<IssuedToken> {
    await this.revokeOpen(tx, userId, type);
    const ttlMs =
      type === 'INVITATION'
        ? this.ttl.invitationTtlHours * 3_600_000
        : this.ttl.passwordResetTtlMinutes * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const secret = randomBytes(32).toString('base64url');
    const row = await tx.userToken.create({
      data: {
        userId,
        type,
        tokenHash: this.tokens.hashSecret(secret),
        expiresAt,
        createdById,
      },
    });
    return { id: row.id, token: `${row.id}.${secret}`, expiresAt };
  }

  /**
   * Validate a presented token and mark it consumed inside `tx`. Every failure
   * (malformed, unknown, wrong type, expired, used, revoked) gives the same error.
   */
  async consume(
    tx: Prisma.TransactionClient,
    presented: string,
    type: UserTokenType,
  ): Promise<{ userId: string }> {
    const dot = presented.indexOf('.');
    const id = dot > 0 ? presented.slice(0, dot) : '';
    const secret = dot > 0 ? presented.slice(dot + 1) : '';
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(id) || secret.length < 20 || secret.length > 200) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    const row = await tx.userToken.findUnique({ where: { id } });
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
    // Atomic single use: only one concurrent request can flip consumedAt.
    const { count } = await tx.userToken.updateMany({
      where: { id, consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count !== 1) throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    return { userId: row.userId };
  }

  /** Invalidate outstanding tokens (e.g. reset links after the password changed). */
  revokeOpen(
    tx: Prisma.TransactionClient,
    userId: string,
    type?: UserTokenType,
  ) {
    return tx.userToken.updateMany({
      where: {
        userId,
        ...(type && { type }),
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }
}
