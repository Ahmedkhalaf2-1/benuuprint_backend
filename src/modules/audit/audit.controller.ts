import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import { PrismaService } from '../../database/prisma.service.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AuditLogResponseDto,
  ListAuditLogsQueryDto,
  PaginatedAuditLogsDto,
} from './dto/audit-log.dto.js';

@ApiTags('admin / audit')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'List audit log entries (newest first)' })
  @ApiOkResponse({ type: PaginatedAuditLogsDto })
  async list(
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<Paginated<AuditLogResponseDto>> {
    const where: Prisma.AuditLogWhereInput = {
      actorUserId: query.actorUserId,
      action: query.action,
      entityType: query.entityType,
      createdAt:
        query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const data = rows.map((row) => ({
      ...row,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    }));
    return paginated(data, query.page, query.pageSize, total);
  }
}
