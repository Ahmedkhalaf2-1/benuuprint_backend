import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountTokensService } from './account-tokens.service.js';
import { AuthContextService } from './auth-context.service.js';
import type {
  AuthProfileDto,
  LoginResponseDto,
  SessionResponseDto,
  TokenPairDto,
} from './dto/auth.dto.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const INVALID_LOGIN = 'Invalid email or password';
const INVALID_REFRESH = 'Invalid or expired refresh token';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly authContext: AuthContextService,
    private readonly audit: AuditService,
    private readonly accountTokens: AccountTokensService,
  ) {}

  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<LoginResponseDto> {
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });

    let failure: 'unknown_user' | 'bad_password' | 'inactive' | null = null;
    if (!user) {
      await this.passwords.verifyDummy(password);
      failure = 'unknown_user';
    } else if (!(await this.passwords.verify(user.passwordHash, password))) {
      failure = 'bad_password';
    } else if (!user.isActive || user.status !== 'ACTIVE') {
      failure = 'inactive';
    }

    if (failure || !user) {
      // The client always gets the same response; the reason is audit-only.
      await this.audit.record({
        actorUserId: user?.id ?? null,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user?.id ?? null,
        metadata: { reason: failure, attemptedEmail: email.slice(0, 254) },
        meta,
      });
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    const pair = await this.prisma.$transaction(async (tx) => {
      const sessionId = this.tokens.newSessionId();
      const secret = this.tokens.newRefreshSecret();
      const now = new Date();
      await tx.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          refreshTokenHash: this.tokens.hashSecret(secret),
          userAgent: meta.userAgent,
          ipAddress: meta.ipAddress,
          expiresAt: new Date(now.getTime() + this.tokens.refreshTtlMs),
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now },
      });
      await this.audit.record(
        {
          actorUserId: user.id,
          action: AuditAction.LOGIN_SUCCESS,
          entityType: 'Session',
          entityId: sessionId,
          meta,
        },
        tx,
      );
      return this.issuePair(user.id, sessionId, secret);
    });

    const access = await this.authContext.loadAccess(user.id);
    return Object.assign(pair, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles: access.roleCodes,
        permissions: [...access.permissions].sort(),
      },
    });
  }

  async refresh(
    refreshToken: string,
    meta: RequestMeta,
  ): Promise<TokenPairDto> {
    const parts = this.tokens.parseRefreshToken(refreshToken);
    if (!parts) throw new UnauthorizedException(INVALID_REFRESH);

    const session = await this.prisma.session.findUnique({
      where: { id: parts.sessionId },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.deletedAt ||
      !session.user.isActive ||
      session.user.status !== 'ACTIVE'
    ) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    // Rotation: swap the stored hash only if it still matches the presented secret.
    // A mismatch means an old (already-rotated) token was replayed: treat as theft.
    const newSecret = this.tokens.newRefreshSecret();
    const matches = this.tokens.secretMatches(
      parts.secret,
      session.refreshTokenHash,
    );
    const rotated = matches
      ? await this.prisma.session.updateMany({
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
        await tx.session.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.record(
          {
            actorUserId: session.userId,
            action: AuditAction.REFRESH_REUSE_DETECTED,
            entityType: 'Session',
            entityId: session.id,
            meta,
          },
          tx,
        );
      });
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    return this.issuePair(session.userId, session.id, newSecret);
  }

  async logout(user: AuthUser, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { id: user.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: user.id,
          action: AuditAction.LOGOUT,
          entityType: 'Session',
          entityId: user.sessionId,
          meta,
        },
        tx,
      );
    });
  }

  async logoutAll(user: AuthUser, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: user.id,
          action: AuditAction.LOGOUT_ALL,
          entityType: 'User',
          entityId: user.id,
          metadata: { revokedSessions: count },
          meta,
        },
        tx,
      );
    });
  }

  async changePassword(
    user: AuthUser,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const record = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    if (!(await this.passwords.verify(record.passwordHash, currentPassword))) {
      // 400, not 401: the caller is authenticated and a 401 would trigger client token refresh loops.
      throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: now },
      });
      // Existing sessions may belong to whoever knew the old password: revoke them all.
      const { count } = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.accountTokens.revokeOpen(tx, user.id, 'PASSWORD_RESET');
      await this.audit.record(
        {
          actorUserId: user.id,
          action: AuditAction.PASSWORD_CHANGED,
          entityType: 'User',
          entityId: user.id,
          metadata: { revokedSessions: count },
          meta,
        },
        tx,
      );
    });
  }

  async profile(user: AuthUser): Promise<AuthProfileDto> {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      roles: user.roleCodes,
      permissions: [...user.permissions].sort(),
    };
  }

  async listSessions(user: AuthUser): Promise<SessionResponseDto[]> {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      current: s.id === user.sessionId,
    }));
  }

  async revokeSession(
    user: AuthUser,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Scoped to the caller's own sessions; someone else's id looks like "not found".
      const { count } = await tx.session.updateMany({
        where: { id: sessionId, userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count !== 1) throw new NotFoundException('Session not found');
      await this.audit.record(
        {
          actorUserId: user.id,
          action: AuditAction.SESSION_REVOKED,
          entityType: 'Session',
          entityId: sessionId,
          meta,
        },
        tx,
      );
    });
  }

  private async issuePair(
    userId: string,
    sessionId: string,
    secret: string,
  ): Promise<TokenPairDto> {
    return {
      accessToken: await this.tokens.signAccessToken(userId, sessionId),
      refreshToken: this.tokens.formatRefreshToken(sessionId, secret),
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }
}
