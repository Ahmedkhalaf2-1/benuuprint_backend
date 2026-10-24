import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { seed } from '../../src/database/seed/seed.js';
import { applyTestEnv, getTestDatabaseUrl, TEST_SUPER_ADMIN } from './env.js';

export default async function setup(): Promise<void> {
  const adminUrl = new URL(process.env.DATABASE_URL ?? getTestDatabaseUrl());
  applyTestEnv();
  const testUrl = new URL(process.env.DATABASE_URL!);
  const dbName = testUrl.pathname.slice(1);

  // Create the test database if needed (connect to the maintenance DB).
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  // Fresh database every run: no leftovers from earlier runs, so tests are
  // deterministic. (Only ever the `<db>_test` database, never the dev one.)
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset ${dbName}`);
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
  });

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testUrl.toString() }),
  });
  try {
    await seed(prisma, { superAdmin: TEST_SUPER_ADMIN });
  } finally {
    await prisma.$disconnect();
  }
}
