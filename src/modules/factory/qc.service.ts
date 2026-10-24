import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, QcItemResult } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CompleteQcInspectionDto,
  CreateQcTemplateVersionDto,
  ListQcTemplatesQueryDto,
  QcInspectionResponseDto,
  QcTemplateResponseDto,
  SaveQcResultsDto,
} from './dto/qc.dto.js';
import { JobEngineService } from './job-engine.service.js';
import { ReworkService } from './rework.service.js';
import { StageQuantityService } from './stage-quantity.service.js';

type TemplateRow = Prisma.QcTemplateGetPayload<{
  include: { items: true; stageDefinition: { select: { code: true } } };
}>;
const toTemplate = (t: TemplateRow): QcTemplateResponseDto => ({
  id: t.id,
  code: t.code,
  name: t.name,
  description: t.description,
  version: t.version,
  isActive: t.isActive,
  stageDefinitionId: t.stageDefinitionId,
  stageCode: t.stageDefinition.code,
  items: [...t.items]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map((i) => ({
      id: i.id,
      code: i.code,
      label: i.label,
      description: i.description,
      resultType: i.resultType,
      required: i.required,
      sortOrder: i.sortOrder,
      config: (i.config as Record<string, unknown> | null) ?? null,
    })),
  createdAt: t.createdAt,
});

const inspectionInclude = {
  jobStage: { select: { stageName: true } },
  template: { select: { code: true, items: true } },
  inspector: { select: { name: true } },
  results: true,
  rework: { select: { id: true } },
} satisfies Prisma.QcInspectionInclude;

@Injectable()
export class QcService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: JobEngineService,
    private readonly rework: ReworkService,
    private readonly quantity: StageQuantityService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── templates ─────────────────────────

  async listTemplates(
    q: ListQcTemplatesQueryDto,
  ): Promise<Paginated<QcTemplateResponseDto>> {
    const where: Prisma.QcTemplateWhereInput = {
      ...(q.stageCode && { stageDefinition: { code: q.stageCode } }),
      ...(q.activeOnly && { isActive: true }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.qcTemplate.findMany({
        where,
        orderBy: [{ code: 'asc' }, { version: 'desc' }],
        skip: q.skip,
        take: q.pageSize,
        include: { items: true, stageDefinition: { select: { code: true } } },
      }),
      this.prisma.qcTemplate.count({ where }),
    ]);
    return paginated(rows.map(toTemplate), q.page, q.pageSize, total);
  }

  async getTemplate(id: string): Promise<QcTemplateResponseDto> {
    const t = await this.prisma.qcTemplate.findUnique({
      where: { id },
      include: { items: true, stageDefinition: { select: { code: true } } },
    });
    if (!t) throw new NotFoundException('QC template not found');
    return toTemplate(t);
  }

  /** Checklists are immutable: changing one publishes a new version and retires the old active one. */
  async createVersion(
    dto: CreateQcTemplateVersionDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<QcTemplateResponseDto> {
    const codes = dto.items.map((i) => i.code);
    if (new Set(codes).size !== codes.length)
      throw new BadRequestException('Checklist item codes must be unique');
    const id = await this.prisma.$transaction(async (tx) => {
      const def = await tx.productionStageDefinition.findUnique({
        where: { code: dto.stageCode },
      });
      if (!def) throw new BadRequestException('Unknown stage code');
      if (!def.isQcStage)
        throw new BadRequestException(`${def.name} is not a QC stage`);
      await tx.$queryRaw`SELECT id FROM production_stage_definitions WHERE id = ${def.id}::uuid FOR UPDATE`;
      const previous = await tx.qcTemplate.findFirst({
        where: { stageDefinitionId: def.id },
        orderBy: { version: 'desc' },
      });
      const code = previous?.code ?? `${def.code}_CHECKLIST`;
      await tx.qcTemplate.updateMany({
        where: { stageDefinitionId: def.id, isActive: true },
        data: { isActive: false },
      });
      const created = await tx.qcTemplate.create({
        data: {
          code,
          name: dto.name,
          description: dto.description,
          stageDefinitionId: def.id,
          version: (previous?.version ?? 0) + 1,
          createdByUserId: actor.id,
          items: {
            create: dto.items.map((i, idx) => ({
              code: i.code,
              label: i.label,
              description: i.description,
              resultType: i.resultType,
              required: i.required ?? true,
              sortOrder: i.sortOrder ?? idx,
              config: i.config as Prisma.InputJsonValue | undefined,
            })),
          },
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.QC_TEMPLATE_CREATED,
          entityType: 'QcTemplate',
          entityId: created.id,
          metadata: {
            code,
            version: created.version,
            stage: def.code,
            items: dto.items.length,
          },
          meta,
        },
        tx,
      );
      return created.id;
    });
    return this.getTemplate(id);
  }

  // ───────────────────────── inspections ─────────────────────────

  private async load(id: string): Promise<QcInspectionResponseDto> {
    const i = await this.prisma.qcInspection.findUnique({
      where: { id },
      include: inspectionInclude,
    });
    if (!i) throw new NotFoundException('QC inspection not found');
    const photos = await this.prisma.assetAttachment.count({
      where: { qcInspectionId: id, asset: { archivedAt: null } },
    });
    const byItem = new Map(i.results.map((r) => [r.checklistItemId, r]));
    return {
      id: i.id,
      jobId: i.jobId,
      jobStageId: i.jobStageId,
      stageName: i.jobStage.stageName,
      templateCode: i.template.code,
      templateVersion: i.templateVersion,
      status: i.status,
      overallResult: i.overallResult,
      inspectorUserId: i.inspectorUserId,
      inspectorName: i.inspector.name,
      notes: i.notes,
      startedAt: i.startedAt,
      completedAt: i.completedAt,
      photoCount: photos,
      reworkId: i.rework?.id ?? null,
      inspectedQuantity: i.inspectedQuantity,
      passedQuantity: i.passedQuantity,
      failedQuantity: i.failedQuantity,
      results: [...i.template.items]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => {
          const r = byItem.get(item.id);
          return {
            itemId: item.id,
            itemCode: item.code,
            label: item.label,
            resultType: item.resultType,
            required: item.required,
            result: r?.result ?? null,
            numericValue:
              r?.numericValue != null ? Number(r.numericValue) : null,
            textValue: r?.textValue ?? null,
            notes: r?.notes ?? null,
          };
        }),
    };
  }

  get(id: string) {
    return this.load(id);
  }

  async listForJob(jobId: string): Promise<QcInspectionResponseDto[]> {
    const job = await this.prisma.factoryJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (!job) throw new NotFoundException('Factory job not found');
    const rows = await this.prisma.qcInspection.findMany({
      where: { jobId },
      orderBy: { startedAt: 'asc' },
      select: { id: true },
    });
    return Promise.all(rows.map((r) => this.load(r.id)));
  }

  async start(
    stageId: string,
    actor: AuthUser,
  ): Promise<QcInspectionResponseDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      const { stage, job } = await this.engine.lockedStage(tx, stageId);
      await this.engine.assertOperable(tx, job);
      this.engine.assertStageActionable(stage);
      if (!stage.isQcStage)
        throw new ConflictException('This is not a QC stage');
      if (stage.status !== 'IN_PROGRESS')
        throw new ConflictException(
          'Start the QC stage before starting its inspection',
        );
      await this.engine.requireAssignment(tx, stageId, actor);
      const existing = await tx.qcInspection.findFirst({
        where: {
          jobStageId: stageId,
          status: { in: ['IN_PROGRESS', 'COMPLETED'] },
        },
      });
      if (existing)
        throw new ConflictException('This stage already has an inspection');
      const template = await tx.qcTemplate.findFirst({
        where: { stageDefinitionId: stage.stageDefinitionId, isActive: true },
      });
      if (!template)
        throw new ConflictException('No active QC checklist for this stage');
      const inspection = await tx.qcInspection.create({
        data: {
          jobId: job.id,
          jobStageId: stageId,
          qcTemplateId: template.id,
          templateVersion: template.version,
          inspectorUserId: actor.id,
        },
      });
      await this.engine.activity(
        tx,
        job.id,
        stageId,
        actor.id,
        'QC_STARTED',
        `${actor.name} started ${stage.stageName} inspection`,
        {
          inspectionId: inspection.id,
          template: template.code,
          version: template.version,
        },
      );
      return inspection.id;
    });
    return this.load(id);
  }

  /** Lock the job through the inspection, then re-read everything under the lock. */
  private async lockedInspection(tx: Prisma.TransactionClient, id: string) {
    const found = await tx.qcInspection.findUnique({
      where: { id },
      select: { jobId: true },
    });
    if (!found) throw new NotFoundException('QC inspection not found');
    await this.engine.lockJob(tx, found.jobId);
    const inspection = await tx.qcInspection.findUniqueOrThrow({
      where: { id },
      include: { template: { include: { items: true } } },
    });
    const stage = await tx.jobStage.findUniqueOrThrow({
      where: { id: inspection.jobStageId },
    });
    const job = await tx.factoryJob.findUniqueOrThrow({
      where: { id: inspection.jobId },
    });
    return { inspection, stage, job };
  }

  async saveResults(
    id: string,
    dto: SaveQcResultsDto,
    actor: AuthUser,
  ): Promise<QcInspectionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { inspection, stage, job } = await this.lockedInspection(tx, id);
      await this.engine.assertOperable(tx, job);
      if (inspection.status !== 'IN_PROGRESS')
        throw new ConflictException(`The inspection is ${inspection.status}`);
      if (inspection.inspectorUserId !== actor.id)
        throw new ForbiddenException('Only the inspector can record results');
      this.engine.assertStageActionable(stage);
      const items = new Map(inspection.template.items.map((i) => [i.code, i]));
      for (const input of dto.results) {
        const item = items.get(input.itemCode);
        if (!item)
          throw new BadRequestException(
            `Unknown checklist item ${input.itemCode}`,
          );
        let result: QcItemResult | null = input.result ?? null;
        const cfg = (item.config ?? {}) as {
          target?: number;
          tolerance?: number;
        };
        switch (item.resultType) {
          case 'PASS_FAIL':
          case 'PHOTO_REQUIRED':
            if (!result)
              throw new BadRequestException(
                `${item.code}: a result (PASS/FAIL/NA) is required`,
              );
            break;
          case 'TEXT':
            if (!input.textValue?.trim() && result !== 'NA')
              throw new BadRequestException(
                `${item.code}: a text value is required`,
              );
            result = result ?? null;
            break;
          case 'NUMBER':
          case 'MEASUREMENT':
            if (input.numericValue == null && result !== 'NA')
              throw new BadRequestException(
                `${item.code}: a numeric value is required`,
              );
            if (
              input.numericValue != null &&
              typeof cfg.target === 'number' &&
              typeof cfg.tolerance === 'number'
            ) {
              result =
                Math.abs(input.numericValue - cfg.target) <= cfg.tolerance
                  ? 'PASS'
                  : 'FAIL';
            } else if (
              item.resultType === 'MEASUREMENT' &&
              input.numericValue != null &&
              !result
            ) {
              throw new BadRequestException(
                `${item.code}: record PASS or FAIL for the measurement`,
              );
            }
            break;
        }
        const data = {
          result,
          numericValue: input.numericValue ?? null,
          textValue: input.textValue?.trim() || null,
          notes: input.notes?.trim() || null,
        };
        await tx.qcInspectionResult.upsert({
          where: {
            inspectionId_checklistItemId: {
              inspectionId: id,
              checklistItemId: item.id,
            },
          },
          create: { inspectionId: id, checklistItemId: item.id, ...data },
          update: data,
        });
      }
    });
    return this.load(id);
  }

  async complete(
    id: string,
    dto: CompleteQcInspectionDto,
    actor: AuthUser,
  ): Promise<QcInspectionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const { inspection, stage, job } = await this.lockedInspection(tx, id);
      await this.engine.assertOperable(tx, job);
      if (inspection.status !== 'IN_PROGRESS')
        throw new ConflictException(`The inspection is ${inspection.status}`);
      if (inspection.inspectorUserId !== actor.id)
        throw new ForbiddenException('Only the inspector can complete it');
      this.engine.assertStageActionable(stage);
      if (stage.status !== 'IN_PROGRESS')
        throw new ConflictException('The QC stage is not in progress');

      const results = await tx.qcInspectionResult.findMany({
        where: { inspectionId: id },
      });
      const byItem = new Map(results.map((r) => [r.checklistItemId, r]));
      const answered = (itemId: string, type: string) => {
        const r = byItem.get(itemId);
        if (!r) return false;
        if (r.result === 'NA') return true;
        if (type === 'TEXT') return !!r.textValue;
        if (type === 'NUMBER' || type === 'MEASUREMENT')
          return r.numericValue != null;
        return r.result != null;
      };
      const missing = inspection.template.items
        .filter((i) => i.required && !answered(i.id, i.resultType))
        .map((i) => i.code);
      if (missing.length) {
        throw new ConflictException(
          `Required checklist items are unanswered: ${missing.join(', ')}`,
        );
      }
      const photosNeeded = inspection.template.items.filter(
        (i) =>
          i.required &&
          i.resultType === 'PHOTO_REQUIRED' &&
          byItem.get(i.id)?.result !== 'NA',
      ).length;
      if (photosNeeded > 0) {
        const photos = await tx.assetAttachment.count({
          where: { qcInspectionId: id, asset: { archivedAt: null } },
        });
        if (photos < photosNeeded) {
          throw new ConflictException(
            `The checklist requires ${photosNeeded} photo(s); ${photos} attached`,
          );
        }
      }
      const anyFail = results.some((r) => r.result === 'FAIL');
      if (dto.overallResult === 'PASS' && anyFail) {
        throw new ConflictException(
          'The inspection has failed items and cannot be a plain PASS',
        );
      }
      const notes = dto.notes?.trim() || null;
      if (dto.overallResult !== 'PASS' && !notes) {
        throw new BadRequestException(
          `Notes are required for a ${dto.overallResult.replace('_', ' ')} result`,
        );
      }
      // Bulk jobs: the inspection accounts for every unit the gate must handle.
      let quantities: {
        inspectedQuantity: number;
        passedQuantity: number;
        failedQuantity: number;
      } | null = null;
      const given = [
        dto.inspectedQuantity,
        dto.passedQuantity,
        dto.failedQuantity,
      ];
      if (job.plannedQuantity != null) {
        if (given.some((q) => q == null)) {
          throw new BadRequestException(
            'inspectedQuantity, passedQuantity and failedQuantity are required for bulk jobs',
          );
        }
        const [inspected, passed, failed] = given as number[];
        const required = await this.quantity.required(tx, stage, job);
        if (passed + failed !== inspected) {
          throw new BadRequestException(
            'passedQuantity + failedQuantity must equal inspectedQuantity',
          );
        }
        if (inspected !== required) {
          throw new ConflictException(
            `${stage.stageName} must inspect ${required} unit(s); ${inspected} given`,
          );
        }
        if (failed > 0 && dto.overallResult !== 'FAIL') {
          throw new ConflictException(
            `${failed} unit(s) failed: the result must be FAIL so they are reworked`,
          );
        }
        if (dto.overallResult === 'FAIL' && failed === 0) {
          throw new ConflictException(
            'A FAIL result needs at least one failed unit (failedQuantity)',
          );
        }
        quantities = {
          inspectedQuantity: inspected,
          passedQuantity: passed,
          failedQuantity: failed,
        };
      } else if (given.some((q) => q != null)) {
        throw new BadRequestException(
          'Inspection quantities apply to bulk production jobs only',
        );
      }
      const now = new Date();
      await tx.qcInspection.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          overallResult: dto.overallResult,
          notes,
          completedAt: now,
          ...quantities,
        },
      });
      if (dto.overallResult === 'FAIL') {
        await this.engine.activity(
          tx,
          job.id,
          stage.id,
          actor.id,
          'QC_FAILED',
          `${stage.stageName} failed: ${notes}`,
          { inspectionId: id },
        );
        await this.rework.create(tx, {
          job,
          failedStage: stage,
          qcInspectionId: id,
          targetStageCode: dto.reworkTargetStageCode,
          reason: notes!,
          affectedQuantity: quantities?.failedQuantity ?? null,
          actor,
        });
        await this.engine.recompute(tx, job.id, actor);
      } else {
        await this.engine.activity(
          tx,
          job.id,
          stage.id,
          actor.id,
          dto.overallResult === 'PASS' ? 'QC_PASSED' : 'QC_CONDITIONAL_PASS',
          `${stage.stageName} ${dto.overallResult === 'PASS' ? 'passed' : 'passed conditionally'}`,
          { inspectionId: id, notes },
        );
        await this.engine.activity(
          tx,
          job.id,
          stage.id,
          actor.id,
          'STAGE_COMPLETED',
          `${stage.stageName} completed`,
        );
        await this.engine.finishStage(tx, stage, 'complete', actor, notes);
      }
    });
    return this.load(id);
  }
}
