import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { seed } from './seed.js';

// Reads process.env only (no dotenv): in dev use `pnpm db:seed` (--env-file=.env);
// in production inject variables through the platform.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
try {
  await seed(prisma, {
    superAdmin: {
      email: process.env.SEED_SUPER_ADMIN_EMAIL,
      name: process.env.SEED_SUPER_ADMIN_NAME,
      password: process.env.SEED_SUPER_ADMIN_PASSWORD,
    },
    log: (message) => console.log(`[seed] ${message}`),
  });
} catch (error) {
  console.error(
    '[seed] failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
