import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/access-control.decorators.js';
import type { Response } from 'express';
import { HealthService, type HealthReport } from './health.service.js';

@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'API and database connectivity status' })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
