import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auth,
  createTestApp,
  createUser,
  login,
  loginSuperAdmin,
  uniq,
} from './support/app.js';

describe('Roles admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { accessToken: string };
  const http = () => request(app.getHttpServer());
  const newCode = () => uniq('CUSTOM').toUpperCase().replace(/-/g, '_');

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  it('lists the seeded system roles and the permission catalogue', async () => {
    const roles = await http()
      .get('/api/v1/admin/roles?pageSize=100')
      .set(auth(admin.accessToken))
      .expect(200);
    const codes = roles.body.data.map((r: any) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'SUPER_ADMIN',
        'ADMIN',
        'SALES',
        'FABRIC',
        'PATTERN_MAKER',
        'CUTTING',
        'PRINTING',
        'SEWING',
        'QC',
        'PACKAGING',
        'DELIVERY',
        'FINANCE',
      ]),
    );
    const perms = await http()
      .get('/api/v1/admin/permissions')
      .set(auth(admin.accessToken))
      .expect(200);
    expect(perms.body.meta.total).toBeGreaterThanOrEqual(23);
    const superAdmin = roles.body.data.find(
      (r: any) => r.code === 'SUPER_ADMIN',
    );
    expect(superAdmin.permissions).toHaveLength(perms.body.meta.total);
    const adminRole = roles.body.data.find((r: any) => r.code === 'ADMIN');
    expect(adminRole.permissions).not.toContain('roles.manage');
  });

  it('creates a custom role with permissions and reads it back', async () => {
    const code = newCode();
    const created = await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({
        name: 'Custom Role',
        code,
        description: 'x',
        permissionCodes: ['customers.read', 'samples.read'],
      })
      .expect(201);
    expect(created.body.isSystem).toBe(false);
    expect(created.body.permissions).toEqual([
      'customers.read',
      'samples.read',
    ]);
    const got = await http()
      .get(`/api/v1/admin/roles/${created.body.id}`)
      .set(auth(admin.accessToken))
      .expect(200);
    expect(got.body.code).toBe(code);
  });

  it('rejects duplicate codes, bad codes and unknown permissions', async () => {
    const code = newCode();
    await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({ name: 'One', code })
      .expect(201);
    await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({ name: 'Two', code })
      .expect(409);
    await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({ name: 'Sales again', code: 'sales' })
      .expect(409);
    await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({ name: 'Bad', code: 'bad code!' })
      .expect(400);
    await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({
        name: 'Unknown',
        code: newCode(),
        permissionCodes: ['nope.nothing'],
      })
      .expect(400);
  });

  it('assigns permissions (replace) and validates against the catalogue', async () => {
    const role = await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({ name: 'Perm Role', code: newCode() });
    const ok = await http()
      .post(`/api/v1/admin/roles/${role.body.id}/permissions`)
      .set(auth(admin.accessToken))
      .send({ permissionCodes: ['reports.read', 'payments.read'] })
      .expect(200);
    expect(ok.body.permissions).toEqual(['payments.read', 'reports.read']);
    await http()
      .post(`/api/v1/admin/roles/${role.body.id}/permissions`)
      .set(auth(admin.accessToken))
      .send({ permissionCodes: ['made.up'] })
      .expect(400);
  });

  it('protects system roles: no delete, no deactivate, SUPER_ADMIN permissions immutable', async () => {
    const sales = await prisma.role.findUniqueOrThrow({
      where: { code: 'SALES' },
    });
    const superAdmin = await prisma.role.findUniqueOrThrow({
      where: { code: 'SUPER_ADMIN' },
    });
    await http()
      .delete(`/api/v1/admin/roles/${sales.id}`)
      .set(auth(admin.accessToken))
      .expect(409);
    await http()
      .patch(`/api/v1/admin/roles/${sales.id}`)
      .set(auth(admin.accessToken))
      .send({ isActive: false })
      .expect(409);
    await http()
      .post(`/api/v1/admin/roles/${superAdmin.id}/permissions`)
      .set(auth(admin.accessToken))
      .send({ permissionCodes: [] })
      .expect(409);
    // code is immutable: unknown property rejected by the validation pipe
    await http()
      .patch(`/api/v1/admin/roles/${sales.id}`)
      .set(auth(admin.accessToken))
      .send({ code: 'HACK' })
      .expect(400);
    expect(
      await prisma.role.findUnique({ where: { id: sales.id } }),
    ).not.toBeNull();
  });

  it('deletes custom roles (soft) but not while assigned to users', async () => {
    const role = await http()
      .post('/api/v1/admin/roles')
      .set(auth(admin.accessToken))
      .send({ name: 'Temp', code: newCode() });
    const user = await createUser(app, { permissions: [] });
    await http()
      .post(`/api/v1/admin/users/${user.id}/roles`)
      .set(auth(admin.accessToken))
      .send({ roleIds: [role.body.id] })
      .expect(200);
    await http()
      .delete(`/api/v1/admin/roles/${role.body.id}`)
      .set(auth(admin.accessToken))
      .expect(409);
    await http()
      .post(`/api/v1/admin/users/${user.id}/roles`)
      .set(auth(admin.accessToken))
      .send({ roleIds: [] })
      .expect(200);
    await http()
      .delete(`/api/v1/admin/roles/${role.body.id}`)
      .set(auth(admin.accessToken))
      .expect(204);
    const row = await prisma.role.findUniqueOrThrow({
      where: { id: role.body.id },
    });
    expect(row.deletedAt).not.toBeNull();
    await http()
      .get(`/api/v1/admin/roles/${role.body.id}`)
      .set(auth(admin.accessToken))
      .expect(404);
  });

  it('blocks granting permissions the actor does not hold', async () => {
    const actor = await createUser(app, {
      permissions: ['roles.manage', 'roles.read', 'customers.read'],
    });
    const { accessToken } = await login(app, actor.email, actor.password);
    await http()
      .post('/api/v1/admin/roles')
      .set(auth(accessToken))
      .send({
        name: 'Esc',
        code: newCode(),
        permissionCodes: ['payments.verify'],
      })
      .expect(403);
    await http()
      .post('/api/v1/admin/roles')
      .set(auth(accessToken))
      .send({
        name: 'Ok',
        code: newCode(),
        permissionCodes: ['customers.read'],
      })
      .expect(201);
  });
});
