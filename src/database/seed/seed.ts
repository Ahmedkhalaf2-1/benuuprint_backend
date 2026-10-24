import { hash } from '@node-rs/argon2';
import {
  PERMISSION_CATALOG,
  ALL_PERMISSION_CODES,
} from '../../common/enums/permissions.js';
import { SUPER_ADMIN_ROLE_CODE } from '../../common/enums/system-roles.js';
import {
  isPasswordCompliant,
  PASSWORD_POLICY_MESSAGE,
} from '../../common/password-policy.js';
import {
  GRANT_BATCHES,
  SYSTEM_ROLES,
} from '../../modules/roles/catalog/system-roles.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { seedFactory } from './factory.js';
import { seedCalendar, seedManagement } from './management.js';
import { seedNotifications } from './notifications.js';
import { seedMasterData, seedSampleTerms } from './master-data.js';

export interface SeedOptions {
  superAdmin?: { email?: string; name?: string; password?: string };
  log?: (message: string) => void;
}

export interface SeedResult {
  permissions: number;
  rolesCreated: string[];
  superAdminCreated: boolean;
}

/**
 * Idempotent. Safe to run on every deploy:
 *  - permission catalogue is upserted (descriptions kept in sync with code)
 *  - system roles are created once; their default permissions are applied only
 *    at creation, so later admin edits survive. SUPER_ADMIN is always re-synced
 *    to every permission.
 *  - the initial super admin is created only if the email does not exist yet;
 *    an existing account is never modified (no password reset via seed).
 */
export async function seed(
  prisma: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const log = options.log ?? (() => undefined);

  for (const code of ALL_PERMISSION_CODES) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, description: PERMISSION_CATALOG[code] },
      update: { description: PERMISSION_CATALOG[code] },
    });
  }
  const permissions = await prisma.permission.findMany();
  const permissionId = new Map(permissions.map((p) => [p.code, p.id]));

  const appliedBatches = new Set(
    (await prisma.seedGrantBatch.findMany()).map((b) => b.key),
  );
  const rolesCreated: string[] = [];
  for (const def of SYSTEM_ROLES) {
    let role = await prisma.role.findUnique({ where: { code: def.code } });
    if (!role) {
      // New role: receives the union of every batch.
      role = await prisma.role.create({
        data: {
          code: def.code,
          name: def.name,
          description: def.description,
          isSystem: true,
          permissions: {
            create: def.permissions.map((code) => ({
              permissionId: permissionId.get(code)!,
            })),
          },
        },
      });
      rolesCreated.push(def.code);
    } else {
      // Self-heal flags, then apply only batches not yet delivered to this database.
      await prisma.role.update({
        where: { id: role.id },
        data: { isSystem: true, deletedAt: null, isActive: true },
      });
      for (const batch of GRANT_BATCHES) {
        if (appliedBatches.has(batch.key)) continue;
        const grants = batch.grants[def.code] ?? [];
        await prisma.rolePermission.createMany({
          data: grants.map((code) => ({
            roleId: role!.id,
            permissionId: permissionId.get(code)!,
          })),
          skipDuplicates: true,
        });
      }
    }
    if (def.code === SUPER_ADMIN_ROLE_CODE) {
      await prisma.rolePermission.createMany({
        data: ALL_PERMISSION_CODES.map((code) => ({
          roleId: role.id,
          permissionId: permissionId.get(code)!,
        })),
        skipDuplicates: true,
      });
    }
  }
  await prisma.seedGrantBatch.createMany({
    data: GRANT_BATCHES.map((b) => ({ key: b.key })),
    skipDuplicates: true,
  });
  log(
    `permissions synced: ${permissions.length}; roles created: ${rolesCreated.length}`,
  );

  await seedMasterData(prisma);
  await seedSampleTerms(prisma);
  await seedFactory(prisma);
  await seedManagement(prisma);
  await seedCalendar(prisma);
  await seedNotifications(prisma);

  const superAdminCreated = await seedSuperAdmin(
    prisma,
    options.superAdmin,
    log,
  );
  return { permissions: permissions.length, rolesCreated, superAdminCreated };
}

async function seedSuperAdmin(
  prisma: PrismaClient,
  input: SeedOptions['superAdmin'],
  log: (message: string) => void,
): Promise<boolean> {
  const email = input?.email?.trim().toLowerCase();
  const password = input?.password;
  if (!email || !password) {
    log(
      'SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD not set: skipping super admin creation',
    );
    return false;
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    log(`super admin ${email} already exists: left untouched`);
    return false;
  }
  if (!isPasswordCompliant(password)) {
    throw new Error(
      `SEED_SUPER_ADMIN_PASSWORD rejected. ${PASSWORD_POLICY_MESSAGE}`,
    );
  }
  const role = await prisma.role.findUniqueOrThrow({
    where: { code: SUPER_ADMIN_ROLE_CODE },
  });
  await prisma.user.create({
    data: {
      email,
      name: input?.name?.trim() || 'Super Admin',
      passwordHash: await hash(password, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
      status: 'ACTIVE',
      isActive: true,
      passwordChangedAt: new Date(),
      roles: { create: [{ roleId: role.id }] },
    },
  });
  log(`super admin ${email} created`);
  return true;
}
