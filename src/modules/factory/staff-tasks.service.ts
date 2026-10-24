import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { toPlain } from '../../common/plain.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AssetsService,
  FACTORY_ATTACHABLE_TYPES,
  type UploadedFileInput,
} from '../assets/assets.service.js';
import type { DownloadUrlResponseDto } from '../assets/dto/asset.dto.js';
import type {
  ListMyJobsQueryDto,
  ListMyStagesQueryDto,
  StageFileDto,
  StaffJobListItemDto,
  StaffJobSummaryDto,
  StaffStageDetailDto,
  StaffStageListItemDto,
  UploadEvidenceDto,
} from './dto/staff-tasks.dto.js';
import { toStageDto } from './factory-jobs.service.js';
import { JobEngineService } from './job-engine.service.js';
import { buildTaskView } from './pure/task-view.js';
import { QcService } from './qc.service.js';
import { StageQuantityService } from './stage-quantity.service.js';
import { toBlockerDto } from './stage-operations.service.js';

const stageInclude = {
  dependsOn: { select: { dependsOnJobStageId: true } },
  assignments: {
    where: { removedAt: null },
    orderBy: { assignedAt: 'asc' },
    include: { user: { select: { id: true, name: true } } },
  },
  job: true,
} satisfies Prisma.JobStageInclude;

type Action = StaffStageDetailDto['allowedActions'][number];

@Injectable()
export class StaffTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: JobEngineService,
    private readonly assets: AssetsService,
    private readonly qc: QcService,
    private readonly quantities: StageQuantityService,
  ) {}

  private async brandNames(ids: string[]) {
    const brands = await this.prisma.brand.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(brands.map((b) => [b.id, b.name]));
  }

  private summary(
    job: Prisma.FactoryJobGetPayload<object>,
    brands: Map<string, string>,
  ): StaffJobSummaryDto {
    return {
      id: job.id,
      jobNumber: job.jobNumber,
      productName: job.productName,
      brandName: brands.get(job.brandId) ?? '',
      priority: job.priority,
      status: job.status,
      targetCompletionDate: job.targetCompletionDate,
    };
  }

  async myStages(
    actor: AuthUser,
    q: ListMyStagesQueryDto,
  ): Promise<Paginated<StaffStageListItemDto>> {
    const now = new Date();
    const status = q.status?.length
      ? q.status
      : (['READY', 'IN_PROGRESS', 'BLOCKED'] as const);
    const where: Prisma.JobStageWhereInput = {
      supersededAt: null,
      status: { in: [...status] },
      assignments: { some: { userId: actor.id, removedAt: null } },
      job: {
        status: { notIn: ['CANCELLED', 'COMPLETED', 'PLANNED'] },
        ...(q.search?.trim() && {
          OR: [
            { jobNumber: { contains: q.search.trim(), mode: 'insensitive' } },
            { productName: { contains: q.search.trim(), mode: 'insensitive' } },
          ],
        }),
      },
      ...(q.delayed && {
        dueAt: { lt: now },
        status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.jobStage.findMany({
        where,
        include: stageInclude,
        orderBy: [
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.jobStage.count({ where }),
    ]);
    const brands = await this.brandNames(rows.map((r) => r.job.brandId));
    return paginated(
      rows.map((r) =>
        Object.assign(toPlain(toStageDto(r, now)), {
          job: this.summary(r.job, brands),
        }),
      ),
      q.page,
      q.pageSize,
      total,
    );
  }

  async myJobs(
    actor: AuthUser,
    q: ListMyJobsQueryDto,
  ): Promise<Paginated<StaffJobListItemDto>> {
    const now = new Date();
    const search = q.search?.trim();
    const where: Prisma.FactoryJobWhereInput = {
      status: q.includeClosed
        ? undefined
        : { notIn: ['CANCELLED', 'COMPLETED', 'PLANNED'] },
      stages: {
        some: {
          supersededAt: null,
          assignments: { some: { userId: actor.id, removedAt: null } },
        },
      },
      ...(search && {
        OR: [
          { jobNumber: { contains: search, mode: 'insensitive' } },
          { productName: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.factoryJob.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.pageSize,
        include: {
          stages: {
            where: {
              supersededAt: null,
              assignments: { some: { userId: actor.id, removedAt: null } },
            },
            include: stageInclude,
            orderBy: { sequence: 'asc' },
          },
        },
      }),
      this.prisma.factoryJob.count({ where }),
    ]);
    const brands = await this.brandNames(rows.map((r) => r.brandId));
    return paginated(
      rows.map((j) =>
        Object.assign(toPlain(this.summary(j, brands)), {
          myStages: j.stages.map((s) => toStageDto(s, now)),
        }),
      ),
      q.page,
      q.pageSize,
      total,
    );
  }

  /** Staff see a stage only if they are assigned; broad readers (jobs.read_all) may look too. */
  private async visibleStage(stageId: string, actor: AuthUser) {
    const stage = await this.prisma.jobStage.findUnique({
      where: { id: stageId },
      include: stageInclude,
    });
    if (!stage) throw new NotFoundException('Job stage not found');
    const mine = stage.assignments.some((a) => a.userId === actor.id);
    if (!mine && !actor.permissions.has('jobs.read_all')) {
      // Do not reveal that the stage exists to people it is not assigned to.
      throw new NotFoundException('Job stage not found');
    }
    return { stage, mine };
  }

  private allowed(
    stage: Prisma.JobStageGetPayload<{ include: typeof stageInclude }>,
    mine: boolean,
    actor: AuthUser,
    jobBlocked: boolean,
  ): Action[] {
    const out: Action[] = [];
    const job = stage.job;
    const runnable =
      !stage.supersededAt &&
      !stage.isOnHold &&
      !jobBlocked &&
      !['CANCELLED', 'COMPLETED', 'PLANNED', 'ON_HOLD'].includes(job.status);
    if (!runnable) return out;
    const can = (p: Parameters<typeof actor.permissions.has>[0]) =>
      actor.permissions.has(p);
    // stages.override holders act on any stage; everyone else needs the assignment
    mine = mine || this.engine.canActOnAnyStage(actor);
    const worker =
      mine || (!stage.requiresAssignment && stage.assignments.length === 0);
    if (stage.status === 'READY' && worker && can('stages.start'))
      out.push('START');
    if (stage.status === 'IN_PROGRESS' && mine) {
      if (stage.isQcStage) {
        if (can('qc.perform')) out.push('START_QC');
      } else if (can('stages.complete')) out.push('COMPLETE');
    }
    if (
      ['READY', 'IN_PROGRESS'].includes(stage.status) &&
      mine &&
      can('stages.block')
    )
      out.push('RAISE_BLOCKER');
    if (
      ['READY', 'IN_PROGRESS', 'BLOCKED'].includes(stage.status) &&
      mine &&
      can('production_notes.create')
    ) {
      out.push('ADD_NOTE', 'ATTACH_FILE');
    }
    return out;
  }

  async stageDetail(
    stageId: string,
    actor: AuthUser,
  ): Promise<StaffStageDetailDto> {
    const { stage, mine } = await this.visibleStage(stageId, actor);
    const [
      spec,
      brands,
      blockers,
      notes,
      attachments,
      inspection,
      jobBlockers,
    ] = await Promise.all([
      this.prisma.sampleProductionSpec.findUniqueOrThrow({
        where: { id: stage.job.sampleProductionSpecId },
        select: { snapshot: true },
      }),
      this.brandNames([stage.job.brandId]),
      this.prisma.blocker.findMany({
        where: { jobStageId: stageId },
        orderBy: { createdAt: 'asc' },
        include: { jobStage: { select: { stageName: true } } },
      }),
      this.prisma.jobNote.findMany({
        where: { jobStageId: stageId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { name: true } } },
      }),
      this.prisma.assetAttachment.findMany({
        where: {
          asset: { archivedAt: null },
          OR: [
            { jobStageId: stageId },
            { qcInspection: { jobStageId: stageId } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        include: { asset: true },
      }),
      this.prisma.qcInspection.findFirst({
        where: {
          jobStageId: stageId,
          status: { in: ['IN_PROGRESS', 'COMPLETED'] },
        },
        select: { id: true },
      }),
      this.prisma.blocker.count({
        where: { jobId: stage.jobId, jobStageId: null, status: 'OPEN' },
      }),
    ]);
    const files: StageFileDto[] = attachments.map((a) => ({
      attachmentId: a.id,
      assetId: a.assetId,
      type: a.asset.type,
      originalName: a.asset.originalName,
      mimeType: a.asset.mimeType,
      sizeBytes: a.asset.sizeBytes,
      description: a.asset.description,
      createdAt: a.createdAt,
    }));
    return {
      stage: toStageDto(stage),
      job: this.summary(stage.job, brands),
      taskView: buildTaskView(
        stage.departmentType,
        spec.snapshot as Record<string, unknown>,
      ),
      allowedActions: this.allowed(stage, mine, actor, jobBlockers > 0),
      blockers: blockers.map(toBlockerDto),
      notes: notes.map((n) => ({
        id: n.id,
        jobId: n.jobId,
        jobStageId: n.jobStageId,
        visibility: 'INTERNAL' as const,
        content: n.content,
        authorUserId: n.authorUserId,
        authorName: n.author.name,
        createdAt: n.createdAt,
      })),
      files,
      quantity: await this.quantities.summary(this.prisma, stage, stage.job),
      orderView: await this.orderView(stage.job, stage),
      qcInspection: inspection ? await this.qc.get(inspection.id) : null,
    };
  }

  /** What a bulk job must produce: the frozen order breakdown, narrowed to the batch allocation. */
  private async orderView(
    job: Prisma.FactoryJobGetPayload<object>,
    stage: { departmentType: string; isQcStage: boolean },
  ): Promise<Record<string, unknown> | null> {
    if (!job.orderProductionSpecId || !job.orderId) return null;
    const [spec, order, alloc] = await Promise.all([
      this.prisma.orderProductionSpec.findUniqueOrThrow({
        where: { id: job.orderProductionSpecId },
        select: { snapshot: true },
      }),
      this.prisma.order.findUniqueOrThrow({
        where: { id: job.orderId },
        select: { orderNumber: true },
      }),
      job.orderBatchId
        ? this.prisma.orderBatchVariant.findMany({
            where: { batchId: job.orderBatchId },
            select: { orderVariantId: true, quantity: true },
          })
        : Promise.resolve(null),
    ]);
    const snapshot = spec.snapshot as {
      items?: {
        productName: string;
        notes: string | null;
        variants: {
          variantId: string;
          size: unknown;
          color: unknown;
          quantity: number;
          notes: string | null;
        }[];
      }[];
    };
    const allowed = alloc
      ? new Map(alloc.map((a) => [a.orderVariantId, a.quantity]))
      : null;
    const packagingSpec =
      stage.departmentType === 'PACKAGING' && !stage.isQcStage
        ? await this.prisma.orderPackagingSpec.findUnique({
            where: { orderId: job.orderId },
            include: {
              components: {
                orderBy: { sortOrder: 'asc' },
                include: { componentOption: { select: { name: true } } },
              },
            },
          })
        : null;
    return {
      orderNumber: order.orderNumber,
      plannedQuantity: job.plannedQuantity,
      ...(packagingSpec && {
        packaging: {
          foldingInstructions: packagingSpec.foldingInstructions,
          polybagRequired: packagingSpec.polybagRequired,
          labelsRequired: packagingSpec.labelsRequired,
          hangTagsRequired: packagingSpec.hangTagsRequired,
          stickersRequired: packagingSpec.stickersRequired,
          stickerNotes: packagingSpec.stickerNotes,
          unitsPerCarton: packagingSpec.unitsPerCarton,
          cartonNotes: packagingSpec.cartonNotes,
          specialInstructions: packagingSpec.specialInstructions,
          components: packagingSpec.components.map((c) => ({
            name: c.componentOption?.name ?? c.customName,
            quantityPerUnit: c.quantityPerUnit,
            notes: c.notes,
          })),
        },
      }),
      batch: job.orderBatchId ? true : false,
      items: (snapshot.items ?? []).map((i) => ({
        productName: i.productName,
        notes: i.notes,
        variants: i.variants
          .filter((v) => !allowed || allowed.has(v.variantId))
          .map((v) => ({
            variantId: v.variantId,
            size: v.size,
            color: v.color,
            quantity: allowed ? allowed.get(v.variantId) : v.quantity,
            notes: v.notes,
          })),
      })),
    };
  }

  /** Short-lived URL for a file the stage legitimately shows (frozen reference file or this stage's own evidence). */
  async fileDownloadUrl(
    stageId: string,
    assetId: string,
    actor: AuthUser,
  ): Promise<DownloadUrlResponseDto> {
    const detail = await this.stageDetail(stageId, actor);
    const referenced =
      JSON.stringify(detail.taskView).includes(assetId) ||
      detail.files.some((f) => f.assetId === assetId);
    if (!referenced)
      throw new NotFoundException('File not found for this stage');
    return this.assets.downloadUrl(assetId, 'attachment');
  }

  // ───────────────────────── evidence ─────────────────────────

  async uploadStageEvidence(
    stageId: string,
    file: UploadedFileInput | undefined,
    dto: UploadEvidenceDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const type = dto.type ?? 'STAGE_PHOTO';
    if (
      !(FACTORY_ATTACHABLE_TYPES as readonly string[]).includes(type) ||
      type === 'QC_PHOTO'
    ) {
      throw new BadRequestException('Unsupported evidence type for a stage');
    }
    await this.assertStageEvidenceAllowed(stageId, actor);
    const asset = await this.assets.upload(
      file,
      { type, description: dto.description },
      actor,
      meta,
    );
    await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      this.assertEvidenceState(stage.status, !!stage.supersededAt, job.status);
      await tx.assetAttachment.create({
        data: {
          assetId: asset.id,
          jobStageId: stageId,
          createdByUserId: actor.id,
        },
      });
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'ASSET_ATTACHED',
        `${actor.name} attached ${asset.originalName}`,
        { assetId: asset.id, type },
      );
    });
    return asset;
  }

  async uploadQcPhoto(
    inspectionId: string,
    file: UploadedFileInput | undefined,
    dto: UploadEvidenceDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    if (!actor.permissions.has('production_notes.create'))
      throw new ForbiddenException('Missing production_notes.create');
    const pre = await this.prisma.qcInspection.findUnique({
      where: { id: inspectionId },
    });
    if (!pre) throw new NotFoundException('QC inspection not found');
    if (pre.inspectorUserId !== actor.id)
      throw new ForbiddenException('Only the inspector can add photos');
    if (pre.status !== 'IN_PROGRESS')
      throw new ConflictException('The inspection is already finished');
    const asset = await this.assets.upload(
      file,
      { type: 'QC_PHOTO', description: dto.description },
      actor,
      meta,
    );
    await this.prisma.$transaction(async (tx) => {
      await this.engine.lockJob(tx, pre.jobId);
      const current = await tx.qcInspection.findUniqueOrThrow({
        where: { id: inspectionId },
      });
      if (current.status !== 'IN_PROGRESS')
        throw new ConflictException('The inspection is already finished');
      await tx.assetAttachment.create({
        data: {
          assetId: asset.id,
          qcInspectionId: inspectionId,
          createdByUserId: actor.id,
        },
      });
      await this.engine.activity(
        tx,
        pre.jobId,
        pre.jobStageId,
        actor.id,
        'ASSET_ATTACHED',
        `${actor.name} added a QC photo`,
        { assetId: asset.id, inspectionId },
      );
    });
    return asset;
  }

  async addNote(stageId: string, content: string, actor: AuthUser) {
    if (!actor.permissions.has('production_notes.create'))
      throw new ForbiddenException('Missing production_notes.create');
    return this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      await this.engine.requireAssignment(tx, stageId, actor);
      this.assertEvidenceState(stage.status, !!stage.supersededAt, job.status);
      const note = await tx.jobNote.create({
        data: {
          jobId: job.id,
          jobStageId: stageId,
          authorUserId: actor.id,
          content,
        },
      });
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'NOTE_ADDED',
        'Note added',
        { noteId: note.id },
      );
      return {
        id: note.id,
        jobId: job.id,
        jobStageId: stageId,
        visibility: 'INTERNAL' as const,
        content: note.content,
        authorUserId: actor.id,
        authorName: actor.name,
        createdAt: note.createdAt,
      };
    });
  }

  private assertEvidenceState(
    status: string,
    superseded: boolean,
    jobStatus: string,
  ) {
    if (superseded || !['READY', 'IN_PROGRESS', 'BLOCKED'].includes(status))
      throw new ConflictException(
        'Evidence can only be added to an active stage',
      );
    if (['CANCELLED', 'COMPLETED'].includes(jobStatus))
      throw new ConflictException(`The job is ${jobStatus}`);
  }

  private async assertStageEvidenceAllowed(stageId: string, actor: AuthUser) {
    if (!actor.permissions.has('production_notes.create'))
      throw new ForbiddenException('Missing production_notes.create');
    const stage = await this.prisma.jobStage.findUnique({
      where: { id: stageId },
      include: { job: { select: { status: true } } },
    });
    if (!stage) throw new NotFoundException('Job stage not found');
    if (
      !this.engine.canActOnAnyStage(actor) &&
      !(await this.engine.activeAssignment(this.prisma, stageId, actor.id))
    )
      throw new ForbiddenException('You are not assigned to this stage');
    this.assertEvidenceState(
      stage.status,
      !!stage.supersededAt,
      stage.job.status,
    );
  }
}
