import { StageAutoAssignService } from './stage-auto-assign.service.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../../common/canonical-json.js';
import { AuditAction } from '../../common/enums/audit-actions.js';
import { toPlain } from '../../common/plain.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { nextReference } from '../../database/reference-sequence.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { FactoryJob, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { SampleProductionSpecService } from '../samples/sample-production-spec.service.js';
import { SampleTransitionsService } from '../samples/sample-transitions.service.js';
import type {
  ActivityResponseDto,
  CreateFactoryJobDto,
  CreateJobNoteDto,
  FactoryJobDetailDto,
  FactoryJobListItemDto,
  JobNoteResponseDto,
  JobStageResponseDto,
  ListFactoryJobsQueryDto,
} from './dto/factory-job.dto.js';
import { JobEngineService } from './job-engine.service.js';
import { isStageDelayed } from './pure/job-stage-state-machine.js';

type Tx = Prisma.TransactionClient;

export interface InstantiateJobInput {
  sourceType: FactoryJob['sourceType'];
  sampleId?: string;
  orderId?: string;
  orderBatchId?: string;
  orderProductionSpecId?: string;
  plannedQuantity?: number;
  /** SAMPLE_PRODUCTION: the PRE_PRODUCTION spec. Bulk jobs: the APPROVED_REFERENCE. */
  pinnedSpecId: string;
  customerId: string;
  brandId: string;
  productTypeId: string | null;
  productName: string;
  assignedSalesUserId: string | null;
  priority: FactoryJob['priority'];
  requestedStartDate?: Date;
  targetCompletionDate?: Date | null;
  internalNotes?: string;
  workflowTemplateCode?: string;
  release: boolean;
  activityMessage: (jobNumber: string) => string;
  auditMetadata: Record<string, unknown>;
  actor: AuthUser;
  meta?: RequestMeta;
  beforeRelease?: (job: FactoryJob) => Promise<void>;
}

const stageInclude = {
  dependsOn: { select: { dependsOnJobStageId: true } },
  assignments: {
    where: { removedAt: null },
    orderBy: { assignedAt: 'asc' },
    include: { user: { select: { id: true, name: true } } },
  },
} satisfies Prisma.JobStageInclude;
type StageRow = Prisma.JobStageGetPayload<{ include: typeof stageInclude }>;

export const toStageDto = (
  s: StageRow,
  now = new Date(),
): JobStageResponseDto => ({
  id: s.id,
  jobId: s.jobId,
  stageCode: s.stageCode,
  stageName: s.stageName,
  departmentType: s.departmentType,
  sequence: s.sequence,
  attempt: s.attempt,
  status: s.status,
  isRequired: s.isRequired,
  isQcStage: s.isQcStage,
  requiresAssignment: s.requiresAssignment,
  requiresCompletionNote: s.requiresCompletionNote,
  requiresAttachment: s.requiresAttachment,
  superseded: !!s.supersededAt,
  dependsOnStageIds: s.dependsOn.map((d) => d.dependsOnJobStageId),
  readyAt: s.readyAt,
  dueAt: s.dueAt,
  startedAt: s.startedAt,
  completedAt: s.completedAt,
  isDelayed: isStageDelayed(s, now),
  isOnHold: s.isOnHold,
  holdReason: s.holdReason,
  blockedAt: s.blockedAt,
  blockReason: s.blockReason,
  completionNote: s.completionNote,
  reworkRecordId: s.reworkRecordId,
  assignees: s.assignments.map((a) => ({
    assignmentId: a.id,
    userId: a.userId,
    name: a.user.name,
    isPrimary: a.isPrimary,
    context: a.context,
    assignedAt: a.assignedAt,
  })),
});

const listInclude = {
  sample: { select: { sampleNumber: true } },
  order: { select: { orderNumber: true } },
  orderBatch: { select: { batchNumber: true } },
  workflowTemplateVersion: {
    select: { version: true, template: { select: { code: true } } },
  },
  stages: {
    select: { status: true, isRequired: true, supersededAt: true, dueAt: true },
  },
} satisfies Prisma.FactoryJobInclude;
type ListRow = Prisma.FactoryJobGetPayload<{ include: typeof listInclude }>;

@Injectable()
export class FactoryJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: JobEngineService,
    private readonly audit: AuditService,
    private readonly samples: SampleTransitionsService,
    private readonly specs: SampleProductionSpecService,
    private readonly autoAssign: StageAutoAssignService,
  ) {}

  // ───────────────────────── creation ─────────────────────────

  async createFromSample(
    sampleId: string,
    dto: CreateFactoryJobDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<FactoryJobDetailDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.samples.lock(tx, sampleId);
      const sample = await tx.sample.findUnique({ where: { id: sampleId } });
      if (!sample) throw new NotFoundException('Sample not found');
      if (sample.archivedAt) throw new ConflictException('Sample is archived');
      // The factory builds the PHYSICAL sample, so the customer's final approval comes later.
      // READY_FOR_PRODUCTION = reviewed, quoted, accepted and paid. IN_PRODUCTION is allowed only
      // when no job is live (the previous job was cancelled, or the customer sent the sample back).
      if (!['READY_FOR_PRODUCTION', 'IN_PRODUCTION'].includes(sample.status)) {
        throw new ConflictException(
          `A sample-production job needs a paid sample that is READY_FOR_PRODUCTION (this one is ${sample.status})`,
        );
      }
      if (sample.paymentState !== 'PAID') {
        throw new ConflictException('The sample has not been paid for');
      }
      const live = await tx.factoryJob.findFirst({
        where: { sampleId, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
        select: { jobNumber: true },
      });
      if (live) {
        throw new ConflictException(
          `${live.jobNumber} already exists for this sample`,
        );
      }

      // Freeze the production-ready specification now; the job never reads live master data.
      const spec = await this.specs.freezePreProduction(
        tx,
        sampleId,
        actor,
        meta,
      );
      if (sha256Hex(canonicalJson(spec.snapshot)) !== spec.specHash) {
        throw new ConflictException(
          'The production specification failed its integrity check',
        );
      }
      const snapshot = spec.snapshot as { product?: { name?: string } };
      const job = await this.instantiate(tx, {
        sourceType: 'SAMPLE_PRODUCTION',
        sampleId,
        pinnedSpecId: spec.id,
        customerId: spec.customerId,
        brandId: spec.brandId,
        productTypeId: spec.productTypeId,
        productName: snapshot.product?.name ?? sample.sampleNumber,
        assignedSalesUserId: sample.assignedSalesUserId,
        priority: dto.priority ?? 'NORMAL',
        requestedStartDate: dto.requestedStartDate,
        targetCompletionDate: dto.targetCompletionDate,
        internalNotes: dto.internalNotes,
        workflowTemplateCode: dto.workflowTemplateCode,
        release: dto.release ?? true,
        activityMessage: (n) => `${n} created from ${sample.sampleNumber}`,
        auditMetadata: {
          sampleId,
          sampleNumber: sample.sampleNumber,
          productionSpecId: spec.id,
        },
        actor,
        meta,
        beforeRelease: async (created) => {
          if (sample.status === 'READY_FOR_PRODUCTION') {
            await this.samples.apply(tx, sampleId, 'start-production', {
              actor,
              meta,
              auditMetadata: {
                factoryJobId: created.id,
                jobNumber: created.jobNumber,
              },
            });
          }
        },
      });
      return job.id;
    });
    return this.get(id);
  }

  /**
   * Shared job instantiation (sample, whole-order and batch jobs): resolves the workflow version,
   * creates the job, its stages and dependency edges, the first activity, releases and audits.
   * Runs inside the caller's transaction, which already holds the source row lock.
   */
  async instantiate(tx: Tx, p: InstantiateJobInput): Promise<FactoryJob> {
    const template = await tx.workflowTemplate.findFirst({
      where: p.workflowTemplateCode
        ? { code: p.workflowTemplateCode, archivedAt: null }
        : { isDefault: true, archivedAt: null },
    });
    if (!template) {
      throw new BadRequestException(
        p.workflowTemplateCode
          ? 'Workflow template not found or archived'
          : 'There is no default workflow template',
      );
    }
    const version = await tx.workflowTemplateVersion.findFirst({
      where: { templateId: template.id, status: 'ACTIVE' },
      include: {
        stages: {
          include: { stageDefinition: true, dependsOn: true },
          orderBy: { sequence: 'asc' },
        },
      },
    });
    if (!version || version.stages.length === 0) {
      throw new ConflictException(
        'The workflow template has no active version with stages',
      );
    }
    const jobNumber = await nextReference(tx, 'JOB');
    const job = await tx.factoryJob.create({
      data: {
        jobNumber,
        sourceType: p.sourceType,
        sampleId: p.sampleId,
        orderId: p.orderId,
        orderBatchId: p.orderBatchId,
        orderProductionSpecId: p.orderProductionSpecId,
        plannedQuantity: p.plannedQuantity,
        sampleProductionSpecId: p.pinnedSpecId,
        workflowTemplateVersionId: version.id,
        status: 'PLANNED',
        priority: p.priority,
        assignedSalesUserId: p.assignedSalesUserId,
        customerId: p.customerId,
        brandId: p.brandId,
        productTypeId: p.productTypeId,
        productName: p.productName,
        requestedStartDate: p.requestedStartDate,
        targetCompletionDate: p.targetCompletionDate,
        internalNotes: p.internalNotes,
        createdByUserId: p.actor.id,
      },
    });
    const idByTemplateStage = new Map<string, string>();
    for (const ts of version.stages) {
      const d = ts.stageDefinition;
      const stage = await tx.jobStage.create({
        data: {
          jobId: job.id,
          stageDefinitionId: d.id,
          templateStageId: ts.id,
          sequence: ts.sequence,
          stageCode: d.code,
          stageName: d.name,
          departmentType: d.departmentType,
          isRequired: ts.isRequired,
          isQcStage: d.isQcStage,
          requiresAssignment: d.requiresAssignment,
          requiresCompletionNote: d.requiresCompletionNote,
          requiresAttachment: d.requiresAttachment,
          expectedDurationMinutes:
            ts.expectedDurationMinutes ?? d.expectedDurationMinutes,
        },
      });
      idByTemplateStage.set(ts.id, stage.id);
    }
    for (const ts of version.stages) {
      for (const dep of ts.dependsOn) {
        await tx.jobStageDependency.create({
          data: {
            jobStageId: idByTemplateStage.get(ts.id)!,
            dependsOnJobStageId: idByTemplateStage.get(dep.dependsOnStageId)!,
          },
        });
      }
    }
    await this.engine.activity(
      tx,
      job.id,
      null,
      p.actor.id,
      'JOB_CREATED',
      p.activityMessage(jobNumber),
      { workflow: template.code, workflowVersion: version.version },
    );
    await this.autoAssign.autoAssignJob(tx, job.id, p.customerId);
    await p.beforeRelease?.(job);
    if (p.release) await this.releaseInTx(tx, job.id, p.actor);
    await this.audit.record(
      {
        actorUserId: p.actor.id,
        action: AuditAction.FACTORY_JOB_CREATED,
        entityType: 'FactoryJob',
        entityId: job.id,
        metadata: {
          jobNumber,
          sourceType: p.sourceType,
          plannedQuantity: p.plannedQuantity ?? null,
          workflow: template.code,
          workflowVersion: version.version,
          released: p.release,
          ...p.auditMetadata,
        },
        meta: p.meta,
      },
      tx,
    );
    return job;
  }

  private async releaseInTx(tx: Tx, jobId: string, actor: AuthUser) {
    await tx.factoryJob.update({
      where: { id: jobId },
      data: { status: 'READY' },
    });
    await this.engine.releaseRoots(tx, jobId, actor);
    await this.engine.activity(
      tx,
      jobId,
      null,
      actor.id,
      'JOB_RELEASED',
      'Released to the factory floor',
    );
  }

  async release(id: string, actor: AuthUser, meta?: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, id);
      const job = await this.mustFind(tx, id);
      if (job.status !== 'PLANNED') {
        throw new ConflictException(
          `${job.jobNumber} is already ${job.status}`,
        );
      }
      await this.releaseInTx(tx, id, actor);
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.FACTORY_JOB_RELEASED,
          entityType: 'FactoryJob',
          entityId: id,
          metadata: { jobNumber: job.jobNumber },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ───────────────────────── reads ─────────────────────────

  private async mustFind(tx: Tx | PrismaService, id: string) {
    const job = await tx.factoryJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Factory job not found');
    return job;
  }

  private async parties(rows: { customerId: string; brandId: string }[]) {
    const [customers, brands] = await Promise.all([
      this.prisma.customer.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.customerId))] } },
        select: { id: true, displayName: true, customerNumber: true },
      }),
      this.prisma.brand.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.brandId))] } },
        select: { id: true, name: true },
      }),
    ]);
    return {
      customers: new Map(customers.map((c) => [c.id, c])),
      brands: new Map(brands.map((b) => [b.id, b])),
    };
  }

  private toListItem(
    j: ListRow,
    p: Awaited<ReturnType<FactoryJobsService['parties']>>,
    openBlockers: number,
    now: Date,
  ): FactoryJobListItemDto {
    const current = j.stages.filter((s) => !s.supersededAt);
    const customer = p.customers.get(j.customerId);
    const brand = p.brands.get(j.brandId);
    return {
      id: j.id,
      jobNumber: j.jobNumber,
      sourceType: j.sourceType,
      status: j.status,
      priority: j.priority,
      sampleNumber: j.sample?.sampleNumber ?? null,
      orderId: j.orderId,
      orderNumber: j.order?.orderNumber ?? null,
      orderBatchId: j.orderBatchId,
      batchNumber: j.orderBatch?.batchNumber ?? null,
      plannedQuantity: j.plannedQuantity,
      completedQuantity: j.completedQuantity,
      rejectedQuantity: j.rejectedQuantity,
      customer: {
        id: j.customerId,
        name: customer?.displayName ?? '',
        number: customer?.customerNumber ?? null,
      },
      brand: { id: j.brandId, name: brand?.name ?? '', number: null },
      productName: j.productName,
      workflowCode: j.workflowTemplateVersion.template.code,
      workflowVersion: j.workflowTemplateVersion.version,
      targetCompletionDate: j.targetCompletionDate,
      progress: {
        completedStages: current.filter(
          (s) => s.status === 'COMPLETED' || s.status === 'SKIPPED',
        ).length,
        totalStages: current.length,
      },
      delayedStages: current.filter((s) => isStageDelayed(s, now)).length,
      openBlockers,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      createdAt: j.createdAt,
    };
  }

  async list(
    q: ListFactoryJobsQueryDto,
  ): Promise<Paginated<FactoryJobListItemDto>> {
    const now = new Date();
    const and: Prisma.FactoryJobWhereInput[] = [{ archivedAt: null }];
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.priority) and.push({ priority: q.priority });
    if (q.sourceType) and.push({ sourceType: q.sourceType });
    if (q.orderId) and.push({ orderId: q.orderId });
    if (q.customerId) and.push({ customerId: q.customerId });
    if (q.brandId) and.push({ brandId: q.brandId });
    if (q.productTypeId) and.push({ productTypeId: q.productTypeId });
    if (q.createdFrom) and.push({ createdAt: { gte: q.createdFrom } });
    if (q.createdTo) and.push({ createdAt: { lte: q.createdTo } });
    if (q.targetBefore)
      and.push({ targetCompletionDate: { lte: q.targetBefore } });
    if (q.delayed) {
      and.push({
        stages: {
          some: {
            supersededAt: null,
            status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
            dueAt: { lt: now },
          },
        },
      });
    }
    if (q.search?.trim()) {
      const s = q.search.trim();
      const [customers, brands] = await Promise.all([
        this.prisma.customer.findMany({
          where: {
            OR: [
              { displayName: { contains: s, mode: 'insensitive' } },
              { customerNumber: { contains: s, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
          take: 100,
        }),
        this.prisma.brand.findMany({
          where: { name: { contains: s, mode: 'insensitive' } },
          select: { id: true },
          take: 100,
        }),
      ]);
      and.push({
        OR: [
          { jobNumber: { contains: s, mode: 'insensitive' } },
          { productName: { contains: s, mode: 'insensitive' } },
          { sample: { sampleNumber: { contains: s, mode: 'insensitive' } } },
          { customerId: { in: customers.map((c) => c.id) } },
          { brandId: { in: brands.map((b) => b.id) } },
        ],
      });
    }
    const where: Prisma.FactoryJobWhereInput = { AND: and };
    const orderBy: Prisma.FactoryJobOrderByWithRelationInput[] =
      q.sort === 'oldest'
        ? [{ createdAt: 'asc' }]
        : q.sort === 'priority'
          ? [{ priority: 'desc' }, { createdAt: 'asc' }]
          : q.sort === 'target'
            ? [
                { targetCompletionDate: { sort: 'asc', nulls: 'last' } },
                { createdAt: 'asc' },
              ]
            : [{ createdAt: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.factoryJob.findMany({
        where,
        orderBy: [...orderBy, { id: 'asc' }],
        skip: q.skip,
        take: q.pageSize,
        include: listInclude,
      }),
      this.prisma.factoryJob.count({ where }),
    ]);
    const blockers = await this.prisma.blocker.groupBy({
      by: ['jobId'],
      where: { jobId: { in: rows.map((r) => r.id) }, status: 'OPEN' },
      _count: { _all: true },
    });
    const blockerCount = new Map(blockers.map((b) => [b.jobId, b._count._all]));
    const p = await this.parties(rows);
    return paginated(
      rows.map((r) => this.toListItem(r, p, blockerCount.get(r.id) ?? 0, now)),
      q.page,
      q.pageSize,
      total,
    );
  }

  async get(id: string): Promise<FactoryJobDetailDto> {
    const now = new Date();
    const job = await this.prisma.factoryJob.findUnique({
      where: { id },
      include: {
        ...listInclude,
        productionSpec: { select: { revision: true, specHash: true } },
        stages: {
          include: stageInclude,
          orderBy: [{ sequence: 'asc' }, { attempt: 'asc' }],
        },
      },
    });
    if (!job) throw new NotFoundException('Factory job not found');
    const [openBlockers, p] = await Promise.all([
      this.prisma.blocker.count({ where: { jobId: id, status: 'OPEN' } }),
      this.parties([job]),
    ]);
    return Object.assign(toPlain(this.toListItem(job, p, openBlockers, now)), {
      sampleId: job.sampleId,
      sampleProductionSpecId: job.sampleProductionSpecId,
      specRevision: job.productionSpec.revision,
      specHash: job.productionSpec.specHash,
      assignedSalesUserId: job.assignedSalesUserId,
      requestedStartDate: job.requestedStartDate,
      holdReason: job.holdReason,
      heldAt: job.heldAt,
      cancelReason: job.cancelReason,
      cancelledAt: job.cancelledAt,
      internalNotes: job.internalNotes,
      stages: job.stages.map((s) => toStageDto(s, now)),
    });
  }

  async timeline(
    id: string,
    page: number,
    pageSize: number,
    jobStageId?: string,
  ): Promise<Paginated<ActivityResponseDto>> {
    await this.mustFind(this.prisma, id);
    const where: Prisma.JobActivityWhereInput = {
      jobId: id,
      ...(jobStageId && { jobStageId }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.jobActivity.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { actor: { select: { name: true } } },
      }),
      this.prisma.jobActivity.count({ where }),
    ]);
    return paginated(
      rows.map((a) => ({
        id: a.id,
        type: a.type,
        message: a.message,
        jobStageId: a.jobStageId,
        actorUserId: a.actorUserId,
        actorName: a.actor?.name ?? null,
        metadata: (a.metadata as Record<string, unknown> | null) ?? null,
        createdAt: a.createdAt,
      })),
      page,
      pageSize,
      total,
    );
  }

  // ───────────────────────── job-level actions ─────────────────────────

  async changePriority(
    id: string,
    priority: FactoryJobDetailDto['priority'],
    reason: string | undefined,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, id);
      const job = await this.mustFind(tx, id);
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(`${job.jobNumber} is ${job.status}`);
      if (job.priority === priority) return;
      await tx.factoryJob.update({ where: { id }, data: { priority } });
      await this.engine.activity(
        tx,
        id,
        null,
        actor.id,
        'PRIORITY_CHANGED',
        `Priority ${job.priority} → ${priority}`,
        { from: job.priority, to: priority, reason },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.FACTORY_JOB_PRIORITY_CHANGED,
          entityType: 'FactoryJob',
          entityId: id,
          metadata: {
            jobNumber: job.jobNumber,
            from: job.priority,
            to: priority,
            reason,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async updateInternalNotes(
    id: string,
    internalNotes: string | null | undefined,
  ) {
    const job = await this.mustFind(this.prisma, id);
    if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
      throw new ConflictException(`${job.jobNumber} is ${job.status}`);
    await this.prisma.factoryJob.update({
      where: { id },
      data: { internalNotes: internalNotes ?? null },
    });
    return this.get(id);
  }

  async hold(id: string, reason: string, actor: AuthUser, meta?: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, id);
      const job = await this.mustFind(tx, id);
      if (!['PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED'].includes(job.status))
        throw new ConflictException(`Cannot hold a job that is ${job.status}`);
      await tx.factoryJob.update({
        where: { id },
        data: {
          status: 'ON_HOLD',
          holdReason: reason,
          heldAt: new Date(),
          holdPreviousStatus: job.status,
        },
      });
      await this.engine.activity(
        tx,
        id,
        null,
        actor.id,
        'JOB_HOLD',
        `Job put on hold: ${reason}`,
        { reason },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.FACTORY_JOB_HELD,
          entityType: 'FactoryJob',
          entityId: id,
          metadata: {
            jobNumber: job.jobNumber,
            reason,
            previousStatus: job.status,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async resume(id: string, actor: AuthUser, meta?: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, id);
      const job = await this.mustFind(tx, id);
      if (job.status !== 'ON_HOLD')
        throw new ConflictException(`${job.jobNumber} is not on hold`);
      await tx.factoryJob.update({
        where: { id },
        data: {
          status: job.holdPreviousStatus ?? 'READY',
          holdReason: null,
          heldAt: null,
          holdPreviousStatus: null,
        },
      });
      await this.engine.recompute(tx, id, actor);
      await this.engine.activity(
        tx,
        id,
        null,
        actor.id,
        'JOB_RESUMED',
        'Job resumed',
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.FACTORY_JOB_RESUMED,
          entityType: 'FactoryJob',
          entityId: id,
          metadata: { jobNumber: job.jobNumber },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async cancel(
    id: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction((tx) =>
      this.cancelInTx(tx, id, reason, actor, meta),
    );
    return this.get(id);
  }

  /** Cancel inside the caller's transaction (order cancellation cancels its live jobs this way). */
  async cancelInTx(
    tx: Tx,
    id: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<void> {
    {
      await this.engine.lockJob(tx, id);
      const job = await this.mustFind(tx, id);
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(
          `${job.jobNumber} is already ${job.status}`,
        );
      const now = new Date();
      await tx.jobStage.updateMany({
        where: {
          jobId: id,
          status: { in: ['WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED'] },
        },
        data: { status: 'CANCELLED' },
      });
      await tx.blocker.updateMany({
        where: { jobId: id, status: 'OPEN' },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      await tx.reworkRecord.updateMany({
        where: { jobId: id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      await tx.qcInspection.updateMany({
        where: { jobId: id, status: { in: ['IN_PROGRESS'] } },
        data: { status: 'CANCELLED' },
      });
      await tx.stageAssignment.updateMany({
        where: { removedAt: null, jobStage: { jobId: id } },
        data: { removedAt: now, removedByUserId: actor.id },
      });
      await tx.factoryJob.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: now,
          holdReason: null,
          heldAt: null,
          holdPreviousStatus: null,
        },
      });
      await this.engine.activity(
        tx,
        id,
        null,
        actor.id,
        'JOB_CANCELLED',
        `Job cancelled: ${reason}`,
        { reason },
      );
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.FACTORY_JOB_CANCELLED,
          entityType: 'FactoryJob',
          entityId: id,
          metadata: {
            jobNumber: job.jobNumber,
            reason,
            previousStatus: job.status,
          },
          meta,
        },
        tx,
      );
      await this.engine.syncOrder(tx, await this.mustFind(tx, id), actor);
    }
  }

  /** Admin override: mark every open required stage skipped-complete and finish the job. */
  async forceComplete(
    id: string,
    reason: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, id);
      const job = await this.mustFind(tx, id);
      if (job.status === 'CANCELLED' || job.status === 'COMPLETED')
        throw new ConflictException(
          `${job.jobNumber} is already ${job.status}`,
        );
      if (job.status === 'PLANNED')
        throw new ConflictException(
          `${job.jobNumber} has not been released yet`,
        );
      const now = new Date();
      const open = await tx.jobStage.findMany({
        where: {
          jobId: id,
          supersededAt: null,
          status: { in: ['WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED'] },
        },
        select: { id: true, stageName: true },
      });
      // Stage transitions are whitelisted: only untouched stages can be SKIPPED.
      await tx.jobStage.updateMany({
        where: {
          id: { in: open.map((s) => s.id) },
          status: { in: ['WAITING', 'READY'] },
        },
        data: {
          status: 'SKIPPED',
          completionNote: `Force-completed: ${reason}`,
        },
      });
      await tx.jobStage.updateMany({
        where: {
          id: { in: open.map((s) => s.id) },
          status: { in: ['IN_PROGRESS', 'BLOCKED'] },
        },
        data: {
          status: 'CANCELLED',
          completionNote: `Force-completed: ${reason}`,
        },
      });
      await tx.qcInspection.updateMany({
        where: { jobId: id, status: 'IN_PROGRESS' },
        data: { status: 'CANCELLED' },
      });
      await tx.blocker.updateMany({
        where: { jobId: id, status: 'OPEN' },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      await tx.factoryJob.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          startedAt: job.startedAt ?? now,
          holdReason: null,
          heldAt: null,
          holdPreviousStatus: null,
        },
      });
      await this.engine.activity(
        tx,
        id,
        null,
        actor.id,
        'ADMIN_OVERRIDE',
        `Job force-completed: ${reason}`,
        { reason, skippedStages: open.map((s) => s.stageName) },
      );
      await this.engine.activity(
        tx,
        id,
        null,
        actor.id,
        'JOB_COMPLETED',
        `${job.jobNumber} is complete`,
      );
      const completed = await tx.factoryJob.findUniqueOrThrow({
        where: { id },
      });
      await this.engine.onJobCompleted(tx, completed, actor);
      await this.engine.syncOrder(tx, completed, actor);
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.FACTORY_JOB_FORCE_COMPLETED,
          entityType: 'FactoryJob',
          entityId: id,
          metadata: {
            jobNumber: job.jobNumber,
            reason,
            skippedStages: open.length,
          },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ───────────────────────── notes ─────────────────────────

  async addNote(
    id: string,
    dto: CreateJobNoteDto,
    actor: AuthUser,
  ): Promise<JobNoteResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, id);
      const job = await this.mustFind(tx, id);
      if (job.status === 'CANCELLED')
        throw new ConflictException(`${job.jobNumber} is cancelled`);
      if (dto.jobStageId) {
        const stage = await tx.jobStage.findUnique({
          where: { id: dto.jobStageId },
        });
        if (!stage || stage.jobId !== id)
          throw new BadRequestException(
            'The stage does not belong to this job',
          );
      }
      const note = await tx.jobNote.create({
        data: {
          jobId: id,
          jobStageId: dto.jobStageId,
          authorUserId: actor.id,
          content: dto.content,
        },
      });
      await this.engine.activity(
        tx,
        id,
        dto.jobStageId ?? null,
        actor.id,
        'NOTE_ADDED',
        'Note added',
        { noteId: note.id },
      );
      return {
        id: note.id,
        jobId: id,
        jobStageId: note.jobStageId,
        visibility: 'INTERNAL' as const,
        content: note.content,
        authorUserId: actor.id,
        authorName: actor.name,
        createdAt: note.createdAt,
      };
    });
  }

  async listNotes(
    id: string,
    jobStageId?: string,
  ): Promise<JobNoteResponseDto[]> {
    await this.mustFind(this.prisma, id);
    const rows = await this.prisma.jobNote.findMany({
      where: { jobId: id, archivedAt: null, ...(jobStageId && { jobStageId }) },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { name: true } } },
    });
    return rows.map((n) => ({
      id: n.id,
      jobId: n.jobId,
      jobStageId: n.jobStageId,
      visibility: 'INTERNAL' as const,
      content: n.content,
      authorUserId: n.authorUserId,
      authorName: n.author.name,
      createdAt: n.createdAt,
    }));
  }

  async archiveNote(
    jobId: string,
    noteId: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ) {
    const note = await this.prisma.jobNote.findUnique({
      where: { id: noteId },
    });
    if (!note || note.jobId !== jobId)
      throw new NotFoundException('Note not found');
    if (note.archivedAt) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.jobNote.update({
        where: { id: noteId },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.FACTORY_JOB_NOTE_ARCHIVED,
          entityType: 'FactoryJob',
          entityId: jobId,
          metadata: { noteId },
          meta,
        },
        tx,
      );
    });
  }
}
