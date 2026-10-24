import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Not env(): `prisma generate` must work without a database URL (CI, Docker build).
    url: process.env.DATABASE_URL ?? '',
  },
});
