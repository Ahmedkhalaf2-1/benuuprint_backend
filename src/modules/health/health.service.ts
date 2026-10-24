import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

export type ComponentStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptimeSeconds: number;
  checks: { api: ComponentStatus; database: ComponentStatus };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthReport> {
    const database = await this.checkDatabase();
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { api: 'up', database },
    };
  }

  private async checkDatabase(): Promise<ComponentStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch (error) {
      this.logger.error(
        'Database health check failed',
        error instanceof Error ? error.stack : String(error),
      );
      return 'down';
    }
  }
}
