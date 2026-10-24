import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auth,
  createTestApp,
  createUser,
  createUserAndLogin,
  login,
  loginSuperAdmin,
  TEST_PASSWORD,
} from './support/app.js';
import { TEST_SUPER_ADMIN } from './support/env.js';

describe('Authentication (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  it('logs in with valid credentials and returns tokens and profile', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({
        email: TEST_SUPER_ADMIN.email,
        password: TEST_SUPER_ADMIN.password,
      })
      .expect(200);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.roles).toContain('SUPER_ADMIN');
    expect(res.body.user.permissions).toContain('users.manage');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$argon2/);
  });

  it('treats email case-insensitively', async () => {
    await http()
      .post('/api/v1/auth/login')
      .send({
        email: TEST_SUPER_ADMIN.email.toUpperCase(),
        password: TEST_SUPER_ADMIN.password,
      })
      .expect(200);
  });

  it('rejects an invalid password and an unknown email with the same response', async () => {
    const bad = await http()
      .post('/api/v1/auth/login')
      .send({ email: TEST_SUPER_ADMIN.email, password: 'wrong-password-123' })
      .expect(401);
    const unknown = await http()
      .post('/api/v1/auth/login')
      .send({
        email: 'nobody@test.benue.local',
        password: 'wrong-password-123',
      })
      .expect(401);
    expect(bad.body.message).toBe(unknown.body.message);
    expect(bad.body.message).toBe('Invalid email or password');
  });

  it.each(['SUSPENDED', 'DISABLED', 'INVITED'] as const)(
    'blocks a %s user from logging in with the generic error',
    async (status) => {
      const user = await createUser(app, { status });
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(401);
      expect(res.body.message).toBe('Invalid email or password');
    },
  );

  it('validates the login payload', async () => {
    await http()
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'x' })
      .expect(400);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: 'a@b.co', password: 'x', extra: 1 })
      .expect(400);
  });

  it('GET /auth/me returns the profile; missing or bad token is 401', async () => {
    const { accessToken } = await loginSuperAdmin(app);
    const me = await http()
      .get('/api/v1/auth/me')
      .set(auth(accessToken))
      .expect(200);
    expect(me.body.email).toBe(TEST_SUPER_ADMIN.email);
    await http().get('/api/v1/auth/me').expect(401);
    await http()
      .get('/api/v1/auth/me')
      .set(auth('garbage.token.here'))
      .expect(401);
  });

  it('refresh rotates the token; the old refresh token is rejected and kills the session', async () => {
    const { user, refreshToken, accessToken } = await createUserAndLogin(app, {
      permissions: [],
    });
    const first = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(first.body.refreshToken).not.toBe(refreshToken);
    await http()
      .get('/api/v1/auth/me')
      .set(auth(first.body.accessToken))
      .expect(200);

    // Replaying the already-rotated token is treated as theft: session is revoked.
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
      .expect(401);
    await http().get('/api/v1/auth/me').set(auth(accessToken)).expect(401);

    const audit = await prisma.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'auth.refresh_reuse_detected' },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects malformed refresh tokens', async () => {
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'nope' })
      .expect(401);
    await http().post('/api/v1/auth/refresh').send({}).expect(400);
  });

  it('logout revokes the current session only', async () => {
    const user = await createUser(app, { permissions: [] });
    const a = await login(app, user.email, user.password);
    const b = await login(app, user.email, user.password);
    await http()
      .post('/api/v1/auth/logout')
      .set(auth(a.accessToken))
      .expect(204);
    await http().get('/api/v1/auth/me').set(auth(a.accessToken)).expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: a.refreshToken })
      .expect(401);
    await http().get('/api/v1/auth/me').set(auth(b.accessToken)).expect(200);
  });

  it('logout-all revokes every session', async () => {
    const user = await createUser(app, { permissions: [] });
    const a = await login(app, user.email, user.password);
    const b = await login(app, user.email, user.password);
    await http()
      .post('/api/v1/auth/logout-all')
      .set(auth(a.accessToken))
      .expect(204);
    await http().get('/api/v1/auth/me').set(auth(a.accessToken)).expect(401);
    await http().get('/api/v1/auth/me').set(auth(b.accessToken)).expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: b.refreshToken })
      .expect(401);
  });

  it('change-password works, enforces policy, and invalidates all old sessions', async () => {
    const user = await createUser(app, { permissions: [] });
    const a = await login(app, user.email, user.password);
    const b = await login(app, user.email, user.password);
    const newPassword = 'Brand-New-Passw0rd-456';

    await http()
      .post('/api/v1/auth/change-password')
      .set(auth(a.accessToken))
      .send({ currentPassword: 'incorrect-Passw0rd', newPassword })
      .expect(400);
    await http()
      .post('/api/v1/auth/change-password')
      .set(auth(a.accessToken))
      .send({ currentPassword: user.password, newPassword: 'weakpass' })
      .expect(400);
    await http()
      .post('/api/v1/auth/change-password')
      .set(auth(a.accessToken))
      .send({ currentPassword: user.password, newPassword })
      .expect(204);

    await http().get('/api/v1/auth/me').set(auth(a.accessToken)).expect(401);
    await http().get('/api/v1/auth/me').set(auth(b.accessToken)).expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: b.refreshToken })
      .expect(401);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(401);
    await login(app, user.email, newPassword);
  });

  it("lists own sessions and lets a user terminate another of their own, but not someone else's", async () => {
    const user = await createUser(app, { permissions: [] });
    const other = await createUserAndLogin(app, { permissions: [] });
    const a = await login(app, user.email, user.password);
    const b = await login(app, user.email, user.password);

    const list = await http()
      .get('/api/v1/auth/sessions')
      .set(auth(a.accessToken))
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: any) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(
      /refreshTokenHash|refresh_token_hash/,
    );

    const bSession = (
      await http()
        .get('/api/v1/auth/sessions')
        .set(auth(b.accessToken))
        .expect(200)
    ).body.find((s: any) => s.current);
    await http()
      .delete(`/api/v1/auth/sessions/${bSession.id}`)
      .set(auth(a.accessToken))
      .expect(204);
    await http().get('/api/v1/auth/me').set(auth(b.accessToken)).expect(401);

    // Another user's session id looks like "not found".
    await http()
      .delete(`/api/v1/auth/sessions/${bSession.id}`)
      .set(auth(other.accessToken))
      .expect(404);
    await http()
      .delete('/api/v1/auth/sessions/not-a-uuid')
      .set(auth(a.accessToken))
      .expect(400);
  });

  it('a user suspended after login is rejected immediately', async () => {
    const { user, accessToken } = await createUserAndLogin(app, {
      permissions: [],
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'SUSPENDED', isActive: false },
    });
    await http().get('/api/v1/auth/me').set(auth(accessToken)).expect(401);
  });

  it('stores no plaintext passwords or tokens in the database', async () => {
    const user = await createUser(app, { permissions: [] });
    const tokens = await login(app, user.email, user.password);
    const secret = tokens.refreshToken.split('.')[1];

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored.passwordHash).not.toContain(TEST_PASSWORD);

    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
    });
    for (const s of sessions) {
      expect(s.refreshTokenHash).not.toContain(secret);
      expect(s.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM audit_logs
      WHERE metadata::text ILIKE ${'%' + TEST_PASSWORD + '%'}
         OR metadata::text ILIKE ${'%' + secret + '%'}
         OR metadata::text ILIKE ${'%' + tokens.accessToken + '%'}`;
    expect(Number(n)).toBe(0);
  });
});
