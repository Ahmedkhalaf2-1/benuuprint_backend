import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { FORGOT_PASSWORD_MESSAGE } from '../src/modules/auth/account-recovery.service.js';
import {
  auditActions,
  auth,
  createTestApp,
  createUser,
  createUserAndLogin,
  deliveredTokens,
  lastDeliveredToken,
  login,
  loginSuperAdmin,
  TEST_PASSWORD,
  uniq,
} from './support/app.js';

const NEW_PASSWORD = 'Fresh-Passw0rd-789';

describe('Staff invitations and password reset (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { accessToken: string };
  const http = () => request(app.getHttpServer());
  const A = () => auth(admin.accessToken);

  const newInvitee = async (roleIds: string[] = []) => {
    const email = `${uniq('inv')}@test.benue.local`;
    const res = await http()
      .post('/api/v1/admin/users')
      .set(A())
      .send({ name: 'Invited Person', email, roleIds })
      .expect(201);
    expect(res.body.status).toBe('INVITED');
    return { id: res.body.id as string, email };
  };
  const invite = (id: string, token = admin.accessToken) =>
    http().post(`/api/v1/admin/users/${id}/invite`).set(auth(token));

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  describe('invitations', () => {
    it('invites, accepts with a password, activates the user and consumes the token', async () => {
      const u = await newInvitee();
      const inv = await invite(u.id).expect(201);
      expect(inv.body.userId).toBe(u.id);
      expect(inv.body.inviteToken).toMatch(/^[0-9a-f-]{36}\..{20,}$/);
      expect(inv.body.inviteUrl).toBe(
        `http://localhost:5173/accept-invitation?token=${encodeURIComponent(inv.body.inviteToken)}`,
      );
      expect(new Date(inv.body.expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 71 * 3_600_000,
      );
      expect(lastDeliveredToken(u.email, 'INVITATION')).toBe(
        inv.body.inviteToken,
      ); // delivery hook got it too

      // cannot log in before accepting
      await http()
        .post('/api/v1/auth/login')
        .send({ email: u.email, password: NEW_PASSWORD })
        .expect(401);

      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token: inv.body.inviteToken, password: NEW_PASSWORD })
        .expect(204);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row).toMatchObject({ status: 'ACTIVE', isActive: true });
      expect(row.passwordChangedAt).not.toBeNull();
      await login(app, u.email, NEW_PASSWORD);

      // single use
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token: inv.body.inviteToken, password: 'Another-Passw0rd-1' })
        .expect(400);
      await login(app, u.email, NEW_PASSWORD); // password unchanged by the replay
      expect(await auditActions(app, u.id)).toEqual(
        expect.arrayContaining([
          'user.invitation_created',
          'user.invitation_accepted',
        ]),
      );
    });

    it('stores only a hash of the token and never logs or audits it', async () => {
      const u = await newInvitee();
      const inv = await invite(u.id).expect(201);
      const secret = inv.body.inviteToken.split('.')[1];
      const rows = await prisma.userToken.findMany({ where: { userId: u.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toContain(secret);
      const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_logs WHERE metadata::text ILIKE ${'%' + secret + '%'}`;
      expect(Number(n)).toBe(0);
    });

    it('rejects expired, invalid, wrong-type and tampered invitation tokens with one generic error', async () => {
      const u = await newInvitee();
      const inv = await invite(u.id).expect(201);
      const token: string = inv.body.inviteToken;
      const accept = (t: string, password = NEW_PASSWORD) =>
        http()
          .post('/api/v1/auth/accept-invitation')
          .send({ token: t, password });

      const [id, secret] = token.split('.');
      const bad = await Promise.all([
        accept('garbage'),
        accept(`${id}.${secret}x`),
        accept(`${id}.${'a'.repeat(43)}`),
        accept(`3f2b1c0e-0000-4000-8000-000000000000.${secret}`),
      ]);
      for (const res of bad) {
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Invalid or expired token');
      }

      await prisma.userToken.update({
        where: { id: id! },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await accept(token).expect(400);
      expect(expired.body.message).toBe('Invalid or expired token');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status,
      ).toBe('INVITED');

      // a reset token cannot be used as an invitation
      const active = await createUser(app, { permissions: [] });
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: active.email })
        .expect(200);
      await accept(lastDeliveredToken(active.email, 'PASSWORD_RESET')!).expect(
        400,
      );
    });

    it('re-inviting revokes the previous invitation', async () => {
      const u = await newInvitee();
      const first = (await invite(u.id).expect(201)).body.inviteToken;
      const second = (await invite(u.id).expect(201)).body.inviteToken;
      expect(second).not.toBe(first);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token: first, password: NEW_PASSWORD })
        .expect(400);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token: second, password: NEW_PASSWORD })
        .expect(204);
    });

    it('enforces the password policy and keeps the token usable after a weak attempt', async () => {
      const u = await newInvitee();
      const token = (await invite(u.id).expect(201)).body.inviteToken;
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token, password: 'weak' })
        .expect(400);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token, password: 'nouppercase1234' })
        .expect(400);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token })
        .expect(400);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token, password: NEW_PASSWORD, extra: 1 })
        .expect(400);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);
    });

    it('only invites users awaiting an invitation, and archived/suspended users cannot accept', async () => {
      const active = await createUser(app, { permissions: [] });
      await invite(active.id).expect(409);
      await invite('3f2b1c0e-0000-4000-8000-000000000000').expect(404);
      await invite('nope').expect(400);

      const u = await newInvitee();
      const token = (await invite(u.id).expect(201)).body.inviteToken;
      await http()
        .patch(`/api/v1/admin/users/${u.id}/status`)
        .set(A())
        .send({ status: 'SUSPENDED' })
        .expect(200);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token, password: NEW_PASSWORD })
        .expect(400);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status,
      ).toBe('SUSPENDED');

      const archived = await newInvitee();
      const t2 = (await invite(archived.id).expect(201)).body.inviteToken;
      await http()
        .delete(`/api/v1/admin/users/${archived.id}`)
        .set(A())
        .expect(204);
      await http()
        .post('/api/v1/auth/accept-invitation')
        .send({ token: t2, password: NEW_PASSWORD })
        .expect(400);
    });

    it('requires users.manage and blocks inviting users with more privilege than the actor', async () => {
      const u = await newInvitee();
      await http().post(`/api/v1/admin/users/${u.id}/invite`).expect(401);
      const reader = await createUserAndLogin(app, {
        permissions: ['users.read'],
      });
      await invite(u.id, reader.accessToken).expect(403);

      const roles = await prisma.role.findMany({
        where: { code: { in: ['SUPER_ADMIN', 'ADMIN'] } },
      });
      const saRole = roles.find((r) => r.code === 'SUPER_ADMIN')!;
      const target = await newInvitee([saRole.id]);
      const adminUser = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
      await invite(target.id, adminUser.accessToken).expect(403); // would be a privilege takeover
      await invite(u.id, adminUser.accessToken).expect(201);
    });

    it('does not return tokens when exposure is disabled, but still delivers them', async () => {
      const prev = process.env.EXPOSE_ONE_TIME_TOKENS;
      process.env.EXPOSE_ONE_TIME_TOKENS = 'false';
      const strictApp = await createTestApp();
      try {
        const tok = (
          await request(strictApp.getHttpServer())
            .post('/api/v1/auth/login')
            .send({
              email: 'superadmin@test.benue.local',
              password: 'Test-Super-Passw0rd!',
            })
        ).body.accessToken;
        const email = `${uniq('prod')}@test.benue.local`;
        const created = await request(strictApp.getHttpServer())
          .post('/api/v1/admin/users')
          .set(auth(tok))
          .send({ name: 'Prod Like', email })
          .expect(201);
        const res = await request(strictApp.getHttpServer())
          .post(`/api/v1/admin/users/${created.body.id}/invite`)
          .set(auth(tok))
          .expect(201);
        expect(res.body.inviteToken).toBeUndefined();
        expect(res.body.inviteUrl).toBeUndefined();
        expect(res.body.expiresAt).toBeDefined();
        const delivered = lastDeliveredToken(email, 'INVITATION');
        expect(delivered).toBeTruthy();
        expect(JSON.stringify(res.body)).not.toContain(delivered!);
      } finally {
        await strictApp.close();
        process.env.EXPOSE_ONE_TIME_TOKENS = prev;
      }
    });
  });

  describe('password reset', () => {
    it('returns the same generic response for existing, unknown, inactive and invited accounts', async () => {
      const active = await createUser(app, { permissions: [] });
      const suspended = await createUser(app, {
        permissions: [],
        status: 'SUSPENDED',
      });
      const invited = await newInvitee();
      const before = deliveredTokens.length;
      const responses = await Promise.all(
        [
          active.email,
          'nobody@test.benue.local',
          suspended.email,
          invited.email,
        ].map((email) =>
          http().post('/api/v1/auth/forgot-password').send({ email }),
        ),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      }
      expect(deliveredTokens.length - before).toBe(1); // only the active account got a token
      expect(JSON.stringify(responses.map((r) => r.body))).not.toMatch(
        /token/i,
      );
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'not-an-email' })
        .expect(400);
      await http().post('/api/v1/auth/forgot-password').send({}).expect(400);
    });

    it('resets the password with a valid token, revokes all sessions and audits completion', async () => {
      const user = await createUser(app, { permissions: [] });
      const s1 = await login(app, user.email, user.password);
      const s2 = await login(app, user.email, user.password);
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      const token = lastDeliveredToken(user.email, 'PASSWORD_RESET')!;

      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(204);
      await http().get('/api/v1/auth/me').set(auth(s1.accessToken)).expect(401);
      await http().get('/api/v1/auth/me').set(auth(s2.accessToken)).expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: s1.refreshToken })
        .expect(401);
      await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(401);
      await login(app, user.email, NEW_PASSWORD);

      const actions = await auditActions(app, user.id);
      expect(actions).toEqual(
        expect.arrayContaining([
          'auth.password_reset_requested',
          'auth.password_reset_completed',
        ]),
      );
      const rows = await prisma.auditLog.findMany({
        where: { entityId: user.id },
      });
      expect(JSON.stringify(rows)).not.toContain(token.split('.')[1]);
      expect(JSON.stringify(rows)).not.toContain(NEW_PASSWORD);
    });

    it('rejects a used token, an expired token, a superseded token and weak passwords', async () => {
      const user = await createUser(app, { permissions: [] });
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      const first = lastDeliveredToken(user.email, 'PASSWORD_RESET')!;
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      const second = lastDeliveredToken(user.email, 'PASSWORD_RESET')!;
      expect(second).not.toBe(first);

      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: first, newPassword: NEW_PASSWORD })
        .expect(400); // superseded
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: second, newPassword: 'weak' })
        .expect(400);
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: second, newPassword: NEW_PASSWORD })
        .expect(204);
      const used = await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: second, newPassword: 'Yet-Another-Passw0rd' })
        .expect(400);
      expect(used.body.message).toBe('Invalid or expired token');
      await login(app, user.email, NEW_PASSWORD);

      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      const third = lastDeliveredToken(user.email, 'PASSWORD_RESET')!;
      await prisma.userToken.update({
        where: { id: third.split('.')[0]! },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: third, newPassword: 'Yet-Another-Passw0rd' })
        .expect(400);
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: 'garbage', newPassword: NEW_PASSWORD })
        .expect(400);
    });

    it('stores only a hash and expires after the configured window', async () => {
      const user = await createUser(app, { permissions: [] });
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      const token = lastDeliveredToken(user.email, 'PASSWORD_RESET')!;
      const row = await prisma.userToken.findUniqueOrThrow({
        where: { id: token.split('.')[0]! },
      });
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokenHash).not.toContain(token.split('.')[1]);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 60 * 60_000 + 5000,
      );
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
      expect(row.type).toBe('PASSWORD_RESET');
    });

    it('a password change or admin reset invalidates outstanding reset links', async () => {
      const user = await createUserAndLogin(app, { permissions: [] });
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.user.email })
        .expect(200);
      const token = lastDeliveredToken(user.user.email, 'PASSWORD_RESET')!;
      await http()
        .post('/api/v1/auth/change-password')
        .set(auth(user.accessToken))
        .send({
          currentPassword: user.user.password,
          newPassword: NEW_PASSWORD,
        })
        .expect(204);
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'Yet-Another-Passw0rd' })
        .expect(400);

      const target = await createUser(app, { permissions: [] });
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: target.email })
        .expect(200);
      const t2 = lastDeliveredToken(target.email, 'PASSWORD_RESET')!;
      await http()
        .patch(`/api/v1/admin/users/${target.id}`)
        .set(A())
        .send({ password: NEW_PASSWORD })
        .expect(200);
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: t2, newPassword: 'Yet-Another-Passw0rd' })
        .expect(400);
    });

    it('does not let suspended or archived accounts reset', async () => {
      const user = await createUser(app, { permissions: [] });
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      const token = lastDeliveredToken(user.email, 'PASSWORD_RESET')!;
      await http()
        .patch(`/api/v1/admin/users/${user.id}/status`)
        .set(A())
        .send({ status: 'SUSPENDED' })
        .expect(200);
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(400);
      await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(401);
    });

    it('rate-limits the recovery endpoints like login', async () => {
      process.env.RATE_LIMIT_ENABLED = 'true';
      process.env.AUTH_RATE_LIMIT_PER_MINUTE = '3';
      const limited = await createTestApp();
      try {
        const post = () =>
          request(limited.getHttpServer())
            .post('/api/v1/auth/forgot-password')
            .send({ email: 'x@test.benue.local' });
        for (let i = 0; i < 3; i++) await post().expect(200);
        await post().expect(429);
        const reset = () =>
          request(limited.getHttpServer())
            .post('/api/v1/auth/reset-password')
            .send({ token: 'x', newPassword: NEW_PASSWORD });
        for (let i = 0; i < 3; i++) await reset().expect(400);
        await reset().expect(429);
      } finally {
        await limited.close();
        process.env.RATE_LIMIT_ENABLED = 'false';
        delete process.env.AUTH_RATE_LIMIT_PER_MINUTE;
      }
    });
  });

  it('keeps TEST_PASSWORD users able to log in (sanity)', async () => {
    const u = await createUser(app, { permissions: [] });
    await login(app, u.email, TEST_PASSWORD);
  });
});
