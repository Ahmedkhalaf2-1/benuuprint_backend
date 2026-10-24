import { HealthService } from './health.service.js';
import type { PrismaService } from '../../database/prisma.service.js';

function makeService(queryRaw: () => Promise<unknown>) {
  return new HealthService({ $queryRaw: queryRaw } as unknown as PrismaService);
}

describe('HealthService', () => {
  it('reports ok when the database responds', async () => {
    const report = await makeService(async () => [{ '?column?': 1 }]).check();
    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({ api: 'up', database: 'up' });
  });

  it('reports degraded when the database is unreachable', async () => {
    const report = await makeService(async () => {
      throw new Error('connection refused');
    }).check();
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ api: 'up', database: 'down' });
  });
});
