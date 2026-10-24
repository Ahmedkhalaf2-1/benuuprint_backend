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
  uniq,
} from './support/app.js';

describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { accessToken: string; body: any };
  const http = () => request(app.getHttpServer());
  const actions = async (entityId: string) =>
    (await prisma.auditLog.findMany({ where: { entityId } })).map(
      (a) => a.action,
    );

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  it('records user, role and assignment changes with the actor', async () => {
    const adminId = admin.body.user.id;
    const email = `${uniq('aud')}@test.benue.local`;
    const user = await http()
      .post('/api/v1/admin/users')
      .set(auth(admin.accessToken))
      .send({ name: 'Aud Itee', email, password: TEST_PASSWORD })
      .expect(201);
    const uid = user.body.id;
    const sales = await prisma.role.findUniqueOrThrow({
      where: { code: 'SALES' },
    });

    await http()
      .patch(`/api/v1/admin/users/${uid}`)
      .set(auth(admin.accessToken))
      .send({ name: 'Renamed Person' })
      .expect(200);
    await http()
      .post(`/api/v1/admin/users/${uid}/roles`)
      .set(auth(admin.accessToken))
      .send({ roleIds: [sales.id] })
      .expect(200);
    await http()
      .patch(`/api/v1/admin/users/${uid}/status`)
      .set(auth(admin.accessToken))
      .send({ status: 'SUSPENDED' })
      .expect(200);
    await http()
      .delete(`/api/v1/admin/users/${uid}`)
      .set(auth(admin.accessToken))
      .expect(204);
    expect(await actions(uid)).toEqual(
      expect.arrayContaining([
        'user.created',
        'user.updated',
        'user.roles_changed',
        'user.status_changed',
        'user.archived',
      ]),
    );
    const created = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: uid, action: 'user.created' },
    });
    expect(created.actorUserId).toBe(adminId);

    const role = await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({
        name: 'Aud Role',
        code: uniq('AUD').toUpperCase().replace(/-/g, '_'),
      })
      .expect(201);
    await http()
      .patch(`/api/v1/admin/roles/${role.body.id}`)
      .set(auth(admin.accessToken))
      .send({ description: 'changed' })
      .expect(200);
    await http()
      .post(`/api/v1/admin/roles/${role.body.id}/permissions`)
      .set(auth(admin.accessToken))
      .send({ permissionCodes: ['reports.read'] })
      .expect(200);
    await http()
      .delete(`/api/v1/admin/roles/${role.body.id}`)
      .set(auth(admin.accessToken))
      .expect(204);
    expect(await actions(role.body.id)).toEqual(
      expect.arrayContaining([
        'role.created',
        'role.updated',
        'role.permissions_changed',
        'role.deleted',
      ]),
    );
  });

  it('records login success/failure, logout, logout-all and password change without secrets', async () => {
    const user = await createUser(app, { permissions: [] });
    await http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'Wrong-Passw0rd-999' })
      .expect(401);
    const a = await login(app, user.email, user.password);
    const b = await login(app, user.email, user.password);
    await http()
      .post('/api/v1/auth/logout')
      .set(auth(a.accessToken))
      .expect(204);
    await http()
      .post('/api/v1/auth/logout-all')
      .set(auth(b.accessToken))
      .expect(204);
    const c = await login(app, user.email, user.password);
    await http()
      .post('/api/v1/auth/change-password')
      .set(auth(c.accessToken))
      .send({
        currentPassword: user.password,
        newPassword: 'Another-Passw0rd-777',
      })
      .expect(204);

    const rows = await prisma.auditLog.findMany({
      where: { actorUserId: user.id },
    });
    const got = rows.map((r) => r.action);
    expect(got).toEqual(
      expect.arrayContaining([
        'auth.login_success',
        'auth.login_failed',
        'auth.logout',
        'auth.logout_all',
        'auth.password_changed',
      ]),
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('Wrong-Passw0rd-999');
    expect(dump).not.toContain('Another-Passw0rd-777');
    expect(dump).not.toContain(TEST_PASSWORD);
    expect(dump).not.toContain(a.accessToken);
    expect(dump).not.toContain(a.refreshToken);
  });

  it('exposes /admin/audit-logs only with audit.read and supports filters + pagination', async () => {
    const { accessToken: noPerm } = await createUserAndLogin(app, {
      permissions: ['users.read'],
    });
    await http().get('/api/v1/admin/audit-logs').set(auth(noPerm)).expect(403);
    const { accessToken: reader } = await createUserAndLogin(app, {
      permissions: ['audit.read'],
    });

    const adminId = admin.body.user.id;
    const byActor = await http()
      .get(
        `/api/v1/admin/audit-logs?actorUserId=${adminId}&action=user.created&pageSize=5`,
      )
      .set(auth(reader))
      .expect(200);
    expect(byActor.body.data.length).toBeGreaterThan(0);
    expect(
      byActor.body.data.every(
        (r: any) => r.actorUserId === adminId && r.action === 'user.created',
      ),
    ).toBe(true);
    expect(byActor.body.data.length).toBeLessThanOrEqual(5);

    const byEntity = await http()
      .get('/api/v1/admin/audit-logs?entityType=Role')
      .set(auth(reader))
      .expect(200);
    expect(byEntity.body.data.every((r: any) => r.entityType === 'Role')).toBe(
      true,
    );

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = await http()
      .get(`/api/v1/admin/audit-logs?from=${encodeURIComponent(future)}`)
      .set(auth(reader))
      .expect(200);
    expect(none.body.meta.total).toBe(0);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const some = await http()
      .get(
        `/api/v1/admin/audit-logs?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`,
      )
      .set(auth(reader));
    expect(some.body.meta.total).toBeGreaterThan(0);
    await http()
      .get('/api/v1/admin/audit-logs?from=not-a-date')
      .set(auth(reader))
      .expect(400);
  });

  it('is append-only at the database level', async () => {
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { action: 'x' } }),
    ).rejects.toThrow();
    await expect(
      prisma.auditLog.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
  });
});
