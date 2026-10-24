import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    // Tests share one seeded database and exercise global invariants
    // (e.g. "last SUPER_ADMIN"), so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
