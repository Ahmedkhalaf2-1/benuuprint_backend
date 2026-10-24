import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AppConfig } from '../../config/app.config.js';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
}

export interface RefreshTokenParts {
  sessionId: string;
  secret: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TokenService {
  private readonly config: AppConfig['jwt'];

  constructor(
    private readonly jwt: JwtService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig>('app').jwt;
  }

  get accessTtlSeconds(): number {
    return this.config.accessTtlSeconds;
  }

  get refreshTtlMs(): number {
    return this.config.refreshTtlDays * 24 * 60 * 60 * 1000;
  }

  signAccessToken(userId: string, sessionId: string): Promise<string> {
    const claims: AccessTokenClaims = { sub: userId, sid: sessionId };
    return this.jwt.signAsync(claims);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
      if (!UUID_RE.test(claims.sub) || !UUID_RE.test(claims.sid)) {
        throw new Error('malformed claims');
      }
      return claims;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  newSessionId(): string {
    return randomUUID();
  }

  /** Refresh token = `<session id>.<256-bit secret>`; only a hash of the secret is persisted. */
  newRefreshSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  formatRefreshToken(sessionId: string, secret: string): string {
    return `${sessionId}.${secret}`;
  }

  parseRefreshToken(token: string): RefreshTokenParts | null {
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const sessionId = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    if (!UUID_RE.test(sessionId) || secret.length < 20 || secret.length > 200) {
      return null;
    }
    return { sessionId, secret };
  }

  hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  secretMatches(secret: string, storedHash: string): boolean {
    const a = Buffer.from(this.hashSecret(secret));
    const b = Buffer.from(storedHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
