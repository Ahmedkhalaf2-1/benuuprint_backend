import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auth,
  createTestApp,
  createUserAndLogin,
  loginSuperAdmin,
} from './support/app.js';

describe('Authorization (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  it('returns 401 for unauthenticated requests to protected routes', async () => {
    for (const path of [
      '/admin/users',
      '/admin/roles',
      '/admin/permissions',
      '/admin/audit-logs',
    ]) {
      await http().get(`/api/v1${path}`).expect(401);
    }
  });

  it('keeps health public', async () => {
    await http().get('/api/v1/health').expect(200);
  });

  it('returns 403 for an authenticated user without the permission', async () => {
    const { accessToken } = await createUserAndLogin(app, {
      permissions: ['customers.read'],
    });
    const res = await http()
      .get('/api/v1/admin/users')
      .set(auth(accessToken))
      .expect(403);
    expect(res.body.statusCode).toBe(403);
    await http().get('/api/v1/auth/me').set(auth(accessToken)).expect(200);
  });

  it('allows access with the required permission', async () => {
    const { accessToken } = await createUserAndLogin(app, {
      permissions: ['users.read'],
    });
    await http().get('/api/v1/admin/users').set(auth(accessToken)).expect(200);
    // read permission does not allow writes
    await http()
      .post('/api/v1/admin/users')
      .set(auth(accessToken))
      .send({ name: 'X Y', email: 'x@test.benue.local' })
      .expect(403);
  });

  it('unions permissions across multiple roles', async () => {
    const { accessToken, user } = await createUserAndLogin(app, {
      permissions: ['users.read'],
      roleCodes: ['FINANCE'],
    });
    expect(user.roleCodes).toContain('FINANCE');
    const me = await http()
      .get('/api/v1/auth/me')
      .set(auth(accessToken))
      .expect(200);
    expect(me.body.permissions).toEqual(
      expect.arrayContaining(['users.read', 'payments.verify']),
    );
    await http().get('/api/v1/admin/users').set(auth(accessToken)).expect(200);
    await http().get('/api/v1/admin/roles').set(auth(accessToken)).expect(403);
  });

  it('applies role permission changes on the very next request', async () => {
    const admin = await loginSuperAdmin(app);
    const { accessToken, user } = await createUserAndLogin(app, {
      permissions: ['users.read'],
    });
    await http().get('/api/v1/admin/users').set(auth(accessToken)).expect(200);

    const custom = await prisma.role.findUniqueOrThrow({
      where: { code: user.roleCodes[0] },
    });
    await http()
      .post(`/api/v1/admin/roles/${custom.id}/permissions`)
      .set(auth(admin.accessToken))
      .send({ permissionCodes: [] })
      .expect(200);
    await http().get('/api/v1/admin/users').set(auth(accessToken)).expect(403);
  });

  it('ignores inactive roles when resolving permissions', async () => {
    const admin = await loginSuperAdmin(app);
    const { accessToken, user } = await createUserAndLogin(app, {
      permissions: ['users.read'],
    });
    const custom = await prisma.role.findUniqueOrThrow({
      where: { code: user.roleCodes[0] },
    });
    await http()
      .patch(`/api/v1/admin/roles/${custom.id}`)
      .set(auth(admin.accessToken))
      .send({ isActive: false })
      .expect(200);
    await http().get('/api/v1/admin/users').set(auth(accessToken)).expect(403);
  });

  it('serves a Swagger document that includes the Phase 1 endpoints and bearer auth', async () => {
    const res = await http().get('/api/docs-json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/admin/users',
        '/api/v1/admin/roles/{id}/permissions',
        '/api/v1/admin/audit-logs',
      ]),
    );
    expect(res.body.components.securitySchemes.bearer).toBeDefined();
  });
});
