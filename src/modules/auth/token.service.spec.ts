import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service.js';

const jwtConfig = {
  secret: 'unit-test-secret-unit-test-secret-123456',
  accessTtlSeconds: 60,
  refreshTtlDays: 1,
  issuer: 'benue-print',
  audience: 'benue-print-staff',
};

function make(overrides: Partial<typeof jwtConfig> = {}) {
  const cfg = { ...jwtConfig, ...overrides };
  const jwt = new JwtService({
    secret: cfg.secret,
    signOptions: {
      algorithm: 'HS256',
      expiresIn: cfg.accessTtlSeconds,
      issuer: cfg.issuer,
      audience: cfg.audience,
    },
    verifyOptions: {
      algorithms: ['HS256'],
      issuer: cfg.issuer,
      audience: cfg.audience,
    },
  });
  const config = {
    getOrThrow: () => ({ jwt: cfg }),
  } as unknown as ConfigService;
  return new TokenService(jwt, config);
}

describe('TokenService', () => {
  const tokens = make();

  it('round-trips access tokens', async () => {
    const sid = tokens.newSessionId();
    const uid = tokens.newSessionId();
    const claims = await tokens.verifyAccessToken(
      await tokens.signAccessToken(uid, sid),
    );
    expect(claims).toMatchObject({ sub: uid, sid });
  });

  it('rejects tokens signed with another secret or tampered with', async () => {
    const other = make({ secret: 'another-secret-another-secret-123456789' });
    const token = await other.signAccessToken(
      tokens.newSessionId(),
      tokens.newSessionId(),
    );
    await expect(tokens.verifyAccessToken(token)).rejects.toThrow();
    await expect(tokens.verifyAccessToken('a.b.c')).rejects.toThrow();
  });

  it('formats and parses refresh tokens, rejecting malformed input', () => {
    const sid = tokens.newSessionId();
    const secret = tokens.newRefreshSecret();
    const parsed = tokens.parseRefreshToken(
      tokens.formatRefreshToken(sid, secret),
    );
    expect(parsed).toEqual({ sessionId: sid, secret });
    expect(tokens.parseRefreshToken('nodot')).toBeNull();
    expect(tokens.parseRefreshToken('not-a-uuid.' + secret)).toBeNull();
    expect(tokens.parseRefreshToken(`${sid}.short`)).toBeNull();
  });

  it('hashes secrets (never plaintext) and compares them', () => {
    const secret = tokens.newRefreshSecret();
    const hash = tokens.hashSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secret);
    expect(tokens.secretMatches(secret, hash)).toBe(true);
    expect(tokens.secretMatches(tokens.newRefreshSecret(), hash)).toBe(false);
  });
});
