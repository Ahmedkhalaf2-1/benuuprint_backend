import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { paginated } from '../../common/types/paginated.js';
import type { ManagementBoardQueryDto } from './dto/management.dto.js';
import { DelayService } from './delay.service.js';
import { EtaService } from './eta.service.js';
import { ManagementContext } from './management-context.service.js';
import { delayedJobWhere, JOB_TERMINAL } from './queries.js';

const RELEASED = ['READY', 'IN_PROGRESS', 'BLOCKED'] as const;

/** Management view of production: one row per job with its current stage(s), progress, delay and ETA. */
@Injectable()
export class ManagementBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
    private readonly delays: DelayService,
    private readonly eta: EtaService,
  ) {}

  private where(
    q: ManagementBoardQueryDto,
    now: Date,
  ): Prisma.FactoryJobWhereInput {
    const and: Prisma.FactoryJobWhereInput[] = [
      { status: { notIn: [...JOB_TERMINAL] } },
    ];
    if (q.priority) and.push({ priority: q.priority });
    if (q.customerId) and.push({ customerId: q.customerId });
    if (q.brandId) and.push({ brandId: q.brandId });
    if (q.kind === 'SAMPLE') and.push({ sourceType: 'SAMPLE_PRODUCTION' });
    if (q.kind === 'BULK')
      and.push({ sourceType: { in: ['BULK_ORDER', 'ORDER_BATCH'] } });
    const stage: Prisma.JobStageWhereInput = {
      supersededAt: null,
      status: { in: [...RELEASED] },
      ...(q.stageCode && { stageCode: q.stageCode }),
      ...(q.department && { departmentType: q.department }),
      ...(q.assignedUserId && {
        assignments: { some: { userId: q.assignedUserId, removedAt: null } },
      }),
    };
    if (q.stageCode || q.department || q.assignedUserId)
      and.push({ stages: { some: stage } });
    if (q.blocked)
      and.push({
        OR: [{ status: 'BLOCKED' }, { blockers: { some: { status: 'OPEN' } } }],
      });
    if (q.delayed) and.push(delayedJobWhere(now));
    return { AND: and };
  }

  async board(q: ManagementBoardQueryDto, opts: { includeEta: boolean }) {
    const now = this.ctx.now();
    const where = this.where(q, now);
    const [total, jobs] = await Promise.all([
      this.prisma.factoryJob.count({ where }),
      this.prisma.factoryJob.findMany({
        where,
        orderBy: [
          { priority: 'desc' },
          { targetCompletionDate: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        skip: q.skip,
        take: q.pageSize,
        include: {
          stages: {
            where: { supersededAt: null },
            orderBy: { sequence: 'asc' },
            include: {
              assignments: {
                where: { removedAt: null },
                select: {
                  isPrimary: true,
                  user: { select: { id: true, name: true } },
                },
              },
            },
          },
          blockers: { where: { status: 'OPEN' } },
          order: { select: { id: true, orderNumber: true } },
          sample: { select: { id: true, sampleNumber: true } },
          orderBatch: { select: { batchNumber: true } },
        },
      }),
    ]);
    const [customers, brands, etas] = await Promise.all([
      this.prisma.customer.findMany({
        where: { id: { in: [...new Set(jobs.map((j) => j.customerId))] } },
        select: { id: true, displayName: true },
      }),
      this.prisma.brand.findMany({
        where: { id: { in: [...new Set(jobs.map((j) => j.brandId))] } },
        select: { id: true, name: true },
      }),
      opts.includeEta
        ? this.eta.forJobs(
            jobs.map((j) => j.id),
            now,
          )
        : new Map(),
    ]);
    const cn = new Map(customers.map((c) => [c.id, c.displayName]));
    const bn = new Map(brands.map((b) => [b.id, b.name]));
    const rows = jobs.map((j) => {
      const delay = this.delays.jobDelayFor(j, now);
      const required = j.stages.filter(
        (s) => s.isRequired && s.status !== 'SKIPPED',
      );
      const done = required.filter((s) => s.status === 'COMPLETED').length;
      const current = j.stages.filter((s) =>
        (RELEASED as readonly string[]).includes(s.status),
      );
      const people = new Map<string, string>();
      for (const s of current)
        for (const a of s.assignments) people.set(a.user.id, a.user.name);
      const e = etas.get(j.id);
      return {
        jobId: j.id,
        jobNumber: j.jobNumber,
        kind:
          j.sourceType === 'SAMPLE_PRODUCTION'
            ? ('SAMPLE' as const)
            : ('BULK' as const),
        orderId: j.order?.id ?? null,
        orderNumber: j.order?.orderNumber ?? null,
        sampleId: j.sample?.id ?? null,
        sampleNumber: j.sample?.sampleNumber ?? null,
        batchNumber: j.orderBatch?.batchNumber ?? null,
        customerName: cn.get(j.customerId) ?? '',
        brandName: bn.get(j.brandId) ?? '',
        productName: j.productName,
        priority: j.priority,
        status: j.status,
        currentStages: current.map((s) => ({
          stageId: s.id,
          stageCode: s.stageCode,
          stageName: s.stageName,
          department: s.departmentType,
          status: s.status,
          dueAt: s.dueAt,
          assignees: s.assignments.map((a) => a.user),
        })),
        progress: {
          stagesCompleted: done,
          stagesRequired: required.length,
          percent: required.length
            ? Math.round((done / required.length) * 100)
            : 0,
          completedQuantity: j.completedQuantity,
          plannedQuantity: j.plannedQuantity,
        },
        assignees: [...people].map(([id, name]) => ({ id, name })),
        blocked: j.status === 'BLOCKED' || j.blockers.length > 0,
        delayed: delay.isDelayed,
        delayReasons: [...new Set(delay.reasons.map((r) => r.code))],
        delayMinutes: delay.delayMinutes,
        targetCompletionDate: j.targetCompletionDate,
        estimatedCompletionAt: opts.includeEta
          ? (e?.estimatedCompletionAt ?? null)
          : null,
        etaDataQuality: opts.includeEta ? (e?.dataQuality ?? null) : null,
        projectedLate: opts.includeEta ? (e?.projectedLate ?? false) : null,
      };
    });
    return {
      ...paginated(rows, q.page, q.pageSize, total),
      generatedAt: now,
      etaIncluded: opts.includeEta,
    };
  }
}
