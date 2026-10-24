import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { JobStageStatus, Prisma } from '../../generated/prisma/client.js';
import type {
  BoardCardDto,
  BoardColumnDto,
  BoardQueryDto,
  ProductionBoardDto,
} from './dto/board.dto.js';
import { isStageDelayed } from './pure/job-stage-state-machine.js';

const OPEN_DEFAULT: JobStageStatus[] = ['READY', 'IN_PROGRESS', 'BLOCKED'];

const cardInclude = {
  job: true,
  assignments: {
    where: { removedAt: null },
    orderBy: { assignedAt: 'asc' },
    include: { user: { select: { id: true, name: true } } },
  },
} satisfies Prisma.JobStageInclude;

@Injectable()
export class ProductionBoardService {
  constructor(private readonly prisma: PrismaService) {}

  private where(q: BoardQueryDto, now: Date): Prisma.JobStageWhereInput {
    const status = q.blocked
      ? (['BLOCKED'] as JobStageStatus[])
      : q.status?.length
        ? q.status
        : OPEN_DEFAULT;
    const job: Prisma.FactoryJobWhereInput = {
      status: { notIn: ['CANCELLED', 'COMPLETED', 'PLANNED'] },
      ...(q.priority && { priority: q.priority }),
      ...(q.productTypeId && { productTypeId: q.productTypeId }),
      ...(q.customerId && { customerId: q.customerId }),
      ...(q.brandId && { brandId: q.brandId }),
      ...((q.createdFrom || q.createdTo) && {
        createdAt: {
          ...(q.createdFrom && { gte: q.createdFrom }),
          ...(q.createdTo && { lte: q.createdTo }),
        },
      }),
    };
    return {
      supersededAt: null,
      status: { in: status },
      job,
      ...(q.delayed && { dueAt: { lt: now } }),
      ...(q.assignedUserId && {
        assignments: { some: { userId: q.assignedUserId, removedAt: null } },
      }),
      ...(q.unassigned && { assignments: { none: { removedAt: null } } }),
    };
  }

  private async cards(
    where: Prisma.JobStageWhereInput,
    skip: number,
    take: number,
    now: Date,
  ): Promise<BoardCardDto[]> {
    const rows = await this.prisma.jobStage.findMany({
      where,
      include: cardInclude,
      orderBy: [
        { job: { priority: 'desc' } },
        { dueAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      skip,
      take,
    });
    const [customers, brands] = await Promise.all([
      this.prisma.customer.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.job.customerId))] } },
        select: { id: true, displayName: true },
      }),
      this.prisma.brand.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.job.brandId))] } },
        select: { id: true, name: true },
      }),
    ]);
    const cn = new Map(customers.map((c) => [c.id, c.displayName]));
    const bn = new Map(brands.map((b) => [b.id, b.name]));
    return rows.map((s) => ({
      stageId: s.id,
      jobId: s.jobId,
      jobNumber: s.job.jobNumber,
      productName: s.job.productName,
      brandName: bn.get(s.job.brandId) ?? '',
      customerName: cn.get(s.job.customerId) ?? '',
      priority: s.job.priority,
      status: s.status,
      attempt: s.attempt,
      isDelayed: isStageDelayed(s, now),
      isOnHold: s.isOnHold,
      dueAt: s.dueAt,
      readyAt: s.readyAt,
      startedAt: s.startedAt,
      blockReason: s.blockReason,
      assignees: s.assignments.map((a) => ({
        assignmentId: a.id,
        userId: a.userId,
        name: a.user.name,
        isPrimary: a.isPrimary,
        context: a.context,
        assignedAt: a.assignedAt,
      })),
    }));
  }

  async board(q: BoardQueryDto): Promise<ProductionBoardDto> {
    const now = new Date();
    const base = this.where(q, now);
    const defs = await this.prisma.productionStageDefinition.findMany({
      where: q.stageCode ? { code: q.stageCode } : { isActive: true },
      orderBy: [{ defaultSequence: 'asc' }, { code: 'asc' }],
    });
    const grouped = await this.prisma.jobStage.groupBy({
      by: ['stageCode', 'status'],
      where: base,
      _count: { _all: true },
    });
    const counts = new Map<string, Record<string, number>>();
    for (const g of grouped) {
      const c = counts.get(g.stageCode) ?? {};
      c[g.status] = g._count._all;
      counts.set(g.stageCode, c);
    }
    const limit = q.columnLimit ?? 20;
    const columns: BoardColumnDto[] = [];
    for (const d of defs) {
      const c = counts.get(d.code) ?? {};
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      const where = { ...base, stageCode: d.code };
      columns.push({
        stageCode: d.code,
        stageName: d.name,
        departmentType: d.departmentType,
        sequence: d.defaultSequence,
        counts: c,
        total,
        cards: q.stageCode
          ? await this.cards(where, q.skip, q.pageSize, now)
          : await this.cards(where, 0, limit, now),
      });
    }
    return q.stageCode
      ? {
          columns,
          meta: {
            page: q.page,
            pageSize: q.pageSize,
            total: columns[0]?.total ?? 0,
          },
        }
      : { columns };
  }
}
