import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../../auth/token.service.js';

export interface CustomerAccessClaims {
  sub: string;
  sid: string;
  typ: 'customer';
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Access tokens of the customer portal. Signed with a different key and a different audience than staff
 * tokens (this class owns its own JwtService), and tagged `typ: customer`; refresh tokens reuse the
 * staff `<session id>.<secret>` format but live in customer_sessions.
 */
@Injectable()
export class CustomerTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly shared: TokenService,
  ) {}

  get accessTtlSeconds(): number {
    return this.shared.accessTtlSeconds;
  }

  get refreshTtlMs(): number {
    return this.shared.refreshTtlMs;
  }

  signAccessToken(accountId: string, sessionId: string): Promise<string> {
    const claims: CustomerAccessClaims = {
      sub: accountId,
      sid: sessionId,
      typ: 'customer',
    };
    return this.jwt.signAsync(claims);
  }

  async verifyAccessToken(token: string): Promise<CustomerAccessClaims> {
    try {
      const claims = await this.jwt.verifyAsync<CustomerAccessClaims>(token);
      if (
        claims.typ !== 'customer' ||
        !UUID_RE.test(claims.sub) ||
        !UUID_RE.test(claims.sid)
      ) {
        throw new Error('malformed claims');
      }
      return claims;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  newSessionId = () => this.shared.newSessionId();
  newRefreshSecret = () => this.shared.newRefreshSecret();
  formatRefreshToken = (sessionId: string, secret: string) =>
    this.shared.formatRefreshToken(sessionId, secret);
  parseRefreshToken = (token: string) => this.shared.parseRefreshToken(token);
  hashSecret = (secret: string) => this.shared.hashSecret(secret);
  secretMatches = (secret: string, hash: string) =>
    this.shared.secretMatches(secret, hash);
}
