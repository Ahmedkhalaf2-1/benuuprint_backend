import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auth,
  createTestApp,
  createUser,
  login,
  loginSuperAdmin,
  TEST_PASSWORD,
  uniq,
} from './support/app.js';

describe('Users admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { accessToken: string };
  const http = () => request(app.getHttpServer());
  const roleId = async (code: string) =>
    (await prisma.role.findUniqueOrThrow({ where: { code } })).id;
  const newEmail = () => `${uniq('new')}@test.benue.local`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  it('creates a staff user with roles and never returns passwordHash', async () => {
    const email = newEmail();
    const res = await http()
      .post('/api/v1/admin/users')
      .set(auth(admin.accessToken))
      .send({
        name: 'Sam Sales',
        email: email.toUpperCase(),
        password: TEST_PASSWORD,
        roleIds: [await roleId('SALES')],
      })
      .expect(201);
    expect(res.body.email).toBe(email);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.roles.map((r: any) => r.code)).toEqual(['SALES']);
    expect(res.body.permissions).toContain('samples.manage');
    expect(JSON.stringify(res.body)).not.toMatch(
      /passwordHash|password_hash|\$argon2/,
    );
    await login(app, email, TEST_PASSWORD);

    const list = await http()
      .get(`/api/v1/admin/users?search=${email.slice(0, 12)}`)
      .set(auth(admin.accessToken))
      .expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|\$argon2/);
  });

  it('creates an INVITED user without a password who cannot log in until a password is set', async () => {
    const email = newEmail();
    const res = await http()
      .post('/api/v1/admin/users')
      .set(auth(admin.accessToken))
      .send({ name: 'Inv Ited', email })
      .expect(201);
    expect(res.body.status).toBe('INVITED');
    await http()
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(401);
    const upd = await http()
      .patch(`/api/v1/admin/users/${res.body.id}`)
      .set(auth(admin.accessToken))
      .send({ password: TEST_PASSWORD })
      .expect(200);
    expect(upd.body.status).toBe('ACTIVE');
    await login(app, email, TEST_PASSWORD);
  });

  it('rejects duplicate emails, weak passwords and unknown roles', async () => {
    const email = newEmail();
    await http()
      .post('/api/v1/admin/users')
      .set(auth(admin.accessToken))
      .send({ name: 'Dup One', email })
      .expect(201);
    await http()
      .post('/api/v1/admin/users')
      .set(auth(admin.accessToken))
      .send({ name: 'Dup Two', email })
      .expect(409);
    await http()
      .post('/api/v1/admin/users')
      .set(auth(admin.accessToken))
      .send({ name: 'Weak Pw', email: newEmail(), password: 'short' })
      .expect(400);
    await http()
      .post('/api/v1/admin/users')
      .set(auth(admin.accessToken))
      .send({
        name: 'Bad Role',
        email: newEmail(),
        roleIds: ['3f2b1c0e-0000-4000-8000-000000000000'],
      })
      .expect(400);
  });

  it('assigns roles (replace semantics) and the union is reflected', async () => {
    const target = await createUser(app, { permissions: [] });
    const res = await http()
      .post(`/api/v1/admin/users/${target.id}/roles`)
      .set(auth(admin.accessToken))
      .send({ roleIds: [await roleId('SALES'), await roleId('FINANCE')] })
      .expect(200);
    expect(
      res.body.roles
        .map((r: any) => r.code)
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual(['FINANCE', 'SALES']);
    expect(res.body.permissions).toEqual(
      expect.arrayContaining(['payments.verify', 'samples.manage']),
    );
    const res2 = await http()
      .post(`/api/v1/admin/users/${target.id}/roles`)
      .set(auth(admin.accessToken))
      .send({ roleIds: [await roleId('FINANCE')] })
      .expect(200);
    expect(res2.body.roles.map((r: any) => r.code)).toEqual(['FINANCE']);
  });

  it('prevents privilege escalation: ADMIN cannot grant SUPER_ADMIN or manage a SUPER_ADMIN', async () => {
    const adminUser = await createUser(app, { roleCodes: ['ADMIN'] });
    const { accessToken } = await login(
      app,
      adminUser.email,
      adminUser.password,
    );
    const target = await createUser(app, { permissions: [] });
    await http()
      .post(`/api/v1/admin/users/${target.id}/roles`)
      .set(auth(accessToken))
      .send({ roleIds: [await roleId('SUPER_ADMIN')] })
      .expect(403);
    // ADMIN may assign roles within its own permissions.
    await http()
      .post(`/api/v1/admin/users/${target.id}/roles`)
      .set(auth(accessToken))
      .send({ roleIds: [await roleId('SALES')] })
      .expect(200);
    const sa = await prisma.user.findFirstOrThrow({
      where: { email: 'superadmin@test.benue.local' },
    });
    await http()
      .patch(`/api/v1/admin/users/${sa.id}/status`)
      .set(auth(accessToken))
      .send({ status: 'SUSPENDED' })
      .expect(403);
    await http()
      .delete(`/api/v1/admin/users/${sa.id}`)
      .set(auth(accessToken))
      .expect(403);
  });

  it('suspending a user blocks them immediately and revokes sessions; reactivation restores login', async () => {
    const target = await createUser(app, { permissions: [] });
    const session = await login(app, target.email, target.password);
    await http()
      .patch(`/api/v1/admin/users/${target.id}/status`)
      .set(auth(admin.accessToken))
      .send({ status: 'SUSPENDED' })
      .expect(200);
    await http()
      .get('/api/v1/auth/me')
      .set(auth(session.accessToken))
      .expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: target.password })
      .expect(401);
    await http()
      .patch(`/api/v1/admin/users/${target.id}/status`)
      .set(auth(admin.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);
    await login(app, target.email, target.password);
    await http()
      .patch(`/api/v1/admin/users/${target.id}/status`)
      .set(auth(admin.accessToken))
      .send({ status: 'NOPE' })
      .expect(400);
  });

  it('archives users with soft delete (row kept, hidden from API, cannot log in)', async () => {
    const target = await createUser(app, { permissions: [] });
    await http()
      .delete(`/api/v1/admin/users/${target.id}`)
      .set(auth(admin.accessToken))
      .expect(204);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.isActive).toBe(false);
    await http()
      .get(`/api/v1/admin/users/${target.id}`)
      .set(auth(admin.accessToken))
      .expect(404);
    await http()
      .delete(`/api/v1/admin/users/${target.id}`)
      .set(auth(admin.accessToken))
      .expect(404);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: target.password })
      .expect(401);
    const list = await http()
      .get(`/api/v1/admin/users?search=${target.email}`)
      .set(auth(admin.accessToken))
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('refuses self-deletion and self-status change', async () => {
    const me = await http().get('/api/v1/auth/me').set(auth(admin.accessToken));
    await http()
      .delete(`/api/v1/admin/users/${me.body.id}`)
      .set(auth(admin.accessToken))
      .expect(409);
    await http()
      .patch(`/api/v1/admin/users/${me.body.id}/status`)
      .set(auth(admin.accessToken))
      .send({ status: 'DISABLED' })
      .expect(409);
  });

  it('protects the last active SUPER_ADMIN (status, archive and role removal)', async () => {
    const saRole = await roleId('SUPER_ADMIN');
    const sa1 = await prisma.user.findFirstOrThrow({
      where: { email: 'superadmin@test.benue.local' },
    });
    // A second super admin acts; sa1 is then the only OTHER one... first make sa2 the actor.
    const sa2 = await createUser(app, { roleCodes: ['SUPER_ADMIN'] });
    const actor = await login(app, sa2.email, sa2.password);
    try {
      // Two active SAs: removing sa2's rival is allowed -> disable sa1, leaving sa2 as the last.
      await http()
        .patch(`/api/v1/admin/users/${sa1.id}/status`)
        .set(auth(actor.accessToken))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      // Now another actor (an admin-level SA created fresh) tries to disable the last active SA (sa2).
      const sa3 = await createUser(app, {
        roleCodes: ['SUPER_ADMIN'],
        status: 'SUSPENDED',
      });
      expect(sa3.id).toBeTruthy();
      // sa2 is the only active SA: archiving/suspending/de-roling sa2 must be refused.
      // Use a temporary extra actor with full permissions that is NOT a SUPER_ADMIN holder.
      const allPerms = (await prisma.permission.findMany()).map((p) => p.code);
      const op = await createUser(app, { permissions: allPerms });
      const opTok = await login(app, op.email, op.password);
      await http()
        .patch(`/api/v1/admin/users/${sa2.id}/status`)
        .set(auth(opTok.accessToken))
        .send({ status: 'DISABLED' })
        .expect(409);
      await http()
        .delete(`/api/v1/admin/users/${sa2.id}`)
        .set(auth(opTok.accessToken))
        .expect(409);
      const r = await http()
        .post(`/api/v1/admin/users/${sa2.id}/roles`)
        .set(auth(opTok.accessToken))
        .send({ roleIds: [] })
        .expect(409);
      expect(r.body.message).toMatch(/last active SUPER_ADMIN/);
      expect(saRole).toBeTruthy();
    } finally {
      await prisma.user.update({
        where: { id: sa1.id },
        data: { status: 'ACTIVE', isActive: true },
      });
      await prisma.user.updateMany({
        where: { id: sa2.id },
        data: { status: 'DISABLED', isActive: false, deletedAt: new Date() },
      });
      // Suspending sa1 revoked its sessions: obtain a fresh admin token for later tests.
      admin = await loginSuperAdmin(app);
    }
  });

  it('paginates, searches and filters by role and status', async () => {
    const marker = uniq('zz').replace(/-/g, '');
    for (let i = 0; i < 3; i++) {
      await http()
        .post('/api/v1/admin/users')
        .set(auth(admin.accessToken))
        .send({
          name: `Filter ${marker} ${i}`,
          email: `${marker}${i}@test.benue.local`,
          roleIds: i === 0 ? [await roleId('QC')] : [],
        })
        .expect(201);
    }
    const page1 = await http()
      .get(`/api/v1/admin/users?search=${marker}&pageSize=2&page=1`)
      .set(auth(admin.accessToken))
      .expect(200);
    expect(page1.body.meta).toEqual({ page: 1, pageSize: 2, total: 3 });
    expect(page1.body.data).toHaveLength(2);
    const page2 = await http()
      .get(`/api/v1/admin/users?search=${marker}&pageSize=2&page=2`)
      .set(auth(admin.accessToken));
    expect(page2.body.data).toHaveLength(1);
    const byRole = await http()
      .get(`/api/v1/admin/users?search=${marker}&role=QC`)
      .set(auth(admin.accessToken));
    expect(byRole.body.meta.total).toBe(1);
    const byStatus = await http()
      .get(`/api/v1/admin/users?search=${marker}&status=INVITED`)
      .set(auth(admin.accessToken));
    expect(byStatus.body.meta.total).toBe(3);
    await http()
      .get('/api/v1/admin/users?pageSize=1000')
      .set(auth(admin.accessToken))
      .expect(400);
  });
});
