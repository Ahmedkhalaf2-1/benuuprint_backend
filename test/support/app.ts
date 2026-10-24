import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PasswordService } from '../../src/modules/auth/password.service.js';
import {
  TokenDelivery,
  type TokenDeliveryRequest,
} from '../../src/modules/auth/token-delivery.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { TEST_SUPER_ADMIN } from './env.js';

/** Tokens "delivered" during a test, newest last, so flows can be driven without email. */
export const deliveredTokens: TokenDeliveryRequest[] = [];

export const lastDeliveredToken = (
  email: string,
  type: TokenDeliveryRequest['type'],
) =>
  [...deliveredTokens]
    .reverse()
    .find((d) => d.user.email === email && d.type === type)?.token;

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(TokenDelivery)
    .useValue({
      deliver: async (request: TokenDeliveryRequest) => {
        deliveredTokens.push(request);
      },
    })
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return app;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export async function login(
  app: INestApplication,
  email: string,
  password: string,
): Promise<Tokens & { body: any }> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    body: res.body,
  };
}

export const loginSuperAdmin = (app: INestApplication) =>
  login(app, TEST_SUPER_ADMIN.email, TEST_SUPER_ADMIN.password);

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
export const uniq = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export const TEST_PASSWORD = 'Valid-Passw0rd-123';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  roleCodes: string[];
}

/**
 * Create an active staff user directly in the DB, holding a fresh custom role
 * with exactly `permissions`, plus any existing roles in `roleCodes`.
 */
export async function createUser(
  app: INestApplication,
  opts: {
    permissions?: string[];
    roleCodes?: string[];
    status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' | 'INVITED';
  } = {},
): Promise<TestUser> {
  const prisma = app.get(PrismaService);
  const passwords = app.get(PasswordService);
  const email = `${uniq('user')}@test.benue.local`;
  const roleIds: string[] = [];
  const roleCodes = [...(opts.roleCodes ?? [])];
  if (roleCodes.length) {
    const roles = await prisma.role.findMany({
      where: { code: { in: roleCodes } },
    });
    roleIds.push(...roles.map((r) => r.id));
  }
  if (opts.permissions) {
    const perms = await prisma.permission.findMany({
      where: { code: { in: opts.permissions } },
    });
    const code = uniq('TEST_ROLE').toUpperCase().replace(/-/g, '_');
    const role = await prisma.role.create({
      data: {
        code,
        name: code,
        permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
      },
    });
    roleIds.push(role.id);
    roleCodes.push(code);
  }
  const status = opts.status ?? 'ACTIVE';
  const user = await prisma.user.create({
    data: {
      email,
      name: 'Test User',
      passwordHash: await passwords.hash(TEST_PASSWORD),
      status,
      isActive: status === 'ACTIVE',
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
  return { id: user.id, email, password: TEST_PASSWORD, roleCodes };
}

export async function createUserAndLogin(
  app: INestApplication,
  opts: Parameters<typeof createUser>[1] = {},
) {
  const user = await createUser(app, opts);
  const tokens = await login(app, user.email, user.password);
  return { user, ...tokens };
}

/** Audit actions recorded for an entity id, oldest first. */
export async function auditActions(
  app: INestApplication,
  entityId: string,
): Promise<string[]> {
  const rows = await app
    .get(PrismaService)
    .auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => r.action);
}
