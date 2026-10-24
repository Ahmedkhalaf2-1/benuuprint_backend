import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';

config({ quiet: true });

export const TEST_SUPER_ADMIN = {
  email: 'superadmin@test.benue.local',
  name: 'Test Super Admin',
  password: 'Test-Super-Passw0rd!',
};

/** e2e tests run against `<dev database>_test` so they never touch dev data. */
export function getTestDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL must be set (see .env.example)');
  const url = new URL(base);
  const dbName = url.pathname.replace(/^\//, '');
  url.pathname = `/${dbName.endsWith('_test') ? dbName : `${dbName}_test`}`;
  return url.toString();
}

export function applyTestEnv(): void {
  process.env.DATABASE_URL = getTestDatabaseUrl();
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
  process.env.RATE_LIMIT_ENABLED = 'false';
  // Phase 5A order tests release orders without commercial documents; the gate tests switch it on.
  process.env.ORDER_REQUIRE_ACCEPTED_QUOTATION = 'false';
  // Not UTC and not a whole-hour offset: day/week bucketing bugs show up in tests.
  process.env.BUSINESS_TIMEZONE = 'Asia/Kolkata';
  // The scheduler stays off in tests: they run its tasks explicitly and deterministically.
  process.env.SCHEDULER_ENABLED = 'false';
  // Signup tests expect the production default (verification required) whatever the dev .env says.
  process.env.CUSTOMER_EMAIL_VERIFICATION_REQUIRED = 'true';
  process.env.EMAIL_PROVIDER = 'log';
  process.env.WHATSAPP_PROVIDER = 'log';
  process.env.NOTIFICATION_QUIET_HOURS_START = '';
  process.env.NOTIFICATION_QUIET_HOURS_END = '';
  process.env.JWT_ACCESS_SECRET =
    'test-only-secret-test-only-secret-1234567890';
  process.env.SWAGGER_ENABLED = 'true';
  process.env.STORAGE_LOCAL_ROOT = join(tmpdir(), 'benue-print-test-storage');
  process.env.STORAGE_MAX_FILE_BYTES = String(64 * 1024);
  process.env.EXPOSE_ONE_TIME_TOKENS = 'true';
  process.env.PUBLIC_APP_URL = 'http://localhost:5173';
}
