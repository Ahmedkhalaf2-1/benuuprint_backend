import { sanitizeAuditMetadata } from './audit.service.js';

describe('sanitizeAuditMetadata', () => {
  it('strips credential-looking keys at any depth', () => {
    const out = sanitizeAuditMetadata({
      email: 'a@b.co',
      password: 'x',
      newPassword: 'y',
      refreshToken: 'r',
      nested: { accessToken: 't', passwordHash: 'h', keep: 1 },
      list: [{ secret: 's', ok: true }],
    });
    expect(out).toEqual({
      email: 'a@b.co',
      nested: { keep: 1 },
      list: [{ ok: true }],
    });
  });
});
