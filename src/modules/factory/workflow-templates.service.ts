import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated, type Paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateStageDefinitionDto,
  CreateWorkflowTemplateDto,
  CreateWorkflowVersionDto,
  ListWorkflowTemplatesQueryDto,
  ReplaceWorkflowStagesDto,
  StageDefinitionResponseDto,
  UpdateStageDefinitionDto,
  UpdateWorkflowTemplateDto,
  WorkflowStageInputDto,
  WorkflowTemplateResponseDto,
  WorkflowVersionResponseDto,
} from './dto/workflow.dto.js';
import {
  resolveDependencies,
  validateWorkflow,
} from './pure/workflow-graph.js';

type Tx = Prisma.TransactionClient;

const versionInclude = {
  stages: {
    orderBy: { sequence: 'asc' },
    include: {
      stageDefinition: true,
      dependsOn: { include: { dependsOn: { select: { sequence: true } } } },
    },
  },
} satisfies Prisma.WorkflowTemplateVersionInclude;
const templateInclude = {
  versions: { orderBy: { version: 'desc' }, include: versionInclude },
} satisfies Prisma.WorkflowTemplateInclude;

type VersionRow = Prisma.WorkflowTemplateVersionGetPayload<{
  include: typeof versionInclude;
}>;
type TemplateRow = Prisma.WorkflowTemplateGetPayload<{
  include: typeof templateInclude;
}>;

const toVersion = (v: VersionRow): WorkflowVersionResponseDto => ({
  id: v.id,
  templateId: v.templateId,
  version: v.version,
  status: v.status,
  notes: v.notes,
  activatedAt: v.activatedAt,
  createdAt: v.createdAt,
  stages: v.stages.map((s) => ({
    id: s.id,
    sequence: s.sequence,
    stageCode: s.stageDefinition.code,
    stageName: s.stageDefinition.name,
    departmentType: s.stageDefinition.departmentType,
    isRequired: s.isRequired,
    isQcStage: s.stageDefinition.isQcStage,
    expectedDurationMinutes:
      s.expectedDurationMinutes ?? s.stageDefinition.expectedDurationMinutes,
    canRunInParallel: s.canRunInParallel,
    dependsOnSequences: s.dependsOn
      .map((d) => d.dependsOn.sequence)
      .sort((a, b) => a - b),
    config: (s.config as Record<string, unknown> | null) ?? null,
  })),
});

const toTemplate = (t: TemplateRow): WorkflowTemplateResponseDto => ({
  id: t.id,
  code: t.code,
  name: t.name,
  description: t.description,
  isDefault: t.isDefault,
  activeVersion: t.versions.find((v) => v.status === 'ACTIVE')?.version ?? null,
  versions: t.versions.map(toVersion),
  createdAt: t.createdAt,
  archivedAt: t.archivedAt,
});

const toDefinition = (
  d: Prisma.ProductionStageDefinitionGetPayload<object>,
): StageDefinitionResponseDto => ({
  id: d.id,
  code: d.code,
  name: d.name,
  description: d.description,
  departmentType: d.departmentType,
  defaultSequence: d.defaultSequence,
  expectedDurationMinutes: d.expectedDurationMinutes,
  requiresAssignment: d.requiresAssignment,
  requiresCompletionNote: d.requiresCompletionNote,
  requiresAttachment: d.requiresAttachment,
  isQcStage: d.isQcStage,
  eligibleRoleCodes: d.eligibleRoleCodes,
  isActive: d.isActive,
});

/**
 * Workflow templates define which stages a job gets. A version is editable only while DRAFT;
 * activation freezes it (also enforced by triggers), and a job pins the exact version it was
 * created from, so changing a workflow means publishing a new version.
 */
@Injectable()
export class WorkflowTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- templates ----------------------------------------------------------------

  async list(
    query: ListWorkflowTemplatesQueryDto,
  ): Promise<Paginated<WorkflowTemplateResponseDto>> {
    const where: Prisma.WorkflowTemplateWhereInput = {
      archivedAt: null,
      ...(query.search && {
        OR: [
          { code: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workflowTemplate.findMany({
        where,
        include: templateInclude,
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.workflowTemplate.count({ where }),
    ]);
    return paginated(rows.map(toTemplate), query.page, query.pageSize, total);
  }

  async get(id: string): Promise<WorkflowTemplateResponseDto> {
    return toTemplate(await this.findTemplate(id));
  }

  async create(
    dto: CreateWorkflowTemplateDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<WorkflowTemplateResponseDto> {
    if (
      await this.prisma.workflowTemplate.findUnique({
        where: { code: dto.code },
      })
    ) {
      throw new ConflictException(
        `Workflow code ${dto.code} is already in use`,
      );
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const template = await tx.workflowTemplate.create({
        data: { code: dto.code, name: dto.name, description: dto.description },
      });
      const version = await tx.workflowTemplateVersion.create({
        data: {
          templateId: template.id,
          version: 1,
          notes: dto.notes,
          createdByUserId: actor.id,
        },
      });
      await this.writeStages(tx, version.id, dto.stages);
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.WORKFLOW_TEMPLATE_CREATED,
          entityType: 'WorkflowTemplate',
          entityId: template.id,
          metadata: {
            code: template.code,
            versionId: version.id,
            stages: dto.stages.length,
          },
          meta,
        },
        tx,
      );
      return template;
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateWorkflowTemplateDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<WorkflowTemplateResponseDto> {
    const existing = await this.findTemplate(id);
    if (
      dto.isDefault &&
      !existing.versions.some((v) => v.status === 'ACTIVE')
    ) {
      throw new ConflictException(
        'Only a template with an ACTIVE version can be the default',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault)
        await tx.workflowTemplate.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      await tx.workflowTemplate.update({
        where: { id },
        data: {
          name: dto.name ?? undefined,
          description: dto.description,
          isDefault: dto.isDefault,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.WORKFLOW_TEMPLATE_UPDATED,
          entityType: 'WorkflowTemplate',
          entityId: id,
          metadata: { code: existing.code, fields: Object.keys(dto) },
          meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ---- versions ------------------------------------------------------------------

  /** A new DRAFT version (copying the latest unless stages are given). Existing jobs stay on their version. */
  async createVersion(
    templateId: string,
    dto: CreateWorkflowVersionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<WorkflowVersionResponseDto> {
    const created = await this.prisma.$transaction(async (tx) => {
      const template = await tx.workflowTemplate.findUnique({
        where: { id: templateId },
        include: templateInclude,
      });
      if (!template) throw new NotFoundException('Workflow template not found');
      if (template.archivedAt)
        throw new ConflictException('Template is archived');
      const draft = template.versions.find((v) => v.status === 'DRAFT');
      if (draft)
        throw new ConflictException(
          `Version ${draft.version} is still a DRAFT; edit or activate it first`,
        );
      const latest = template.versions[0]!;
      const stages: WorkflowStageInputDto[] =
        dto.stages ??
        latest.stages.map((s) => ({
          stageCode: s.stageDefinition.code,
          sequence: s.sequence,
          isRequired: s.isRequired,
          expectedDurationMinutes: s.expectedDurationMinutes,
          canRunInParallel: s.canRunInParallel,
          dependsOnSequences: s.dependsOn.map((d) => d.dependsOn.sequence),
          config: (s.config as Record<string, unknown> | null) ?? undefined,
        }));
      const version = await tx.workflowTemplateVersion.create({
        data: {
          templateId,
          version: latest.version + 1,
          notes: dto.notes,
          createdByUserId: actor.id,
        },
      });
      await this.writeStages(tx, version.id, stages);
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.WORKFLOW_VERSION_CREATED,
          entityType: 'WorkflowTemplateVersion',
          entityId: version.id,
          metadata: {
            templateId,
            code: template.code,
            version: version.version,
            copiedFrom: dto.stages ? null : latest.version,
          },
          meta,
        },
        tx,
      );
      return version;
    });
    return this.getVersion(created.id);
  }

  async getVersion(id: string): Promise<WorkflowVersionResponseDto> {
    const v = await this.prisma.workflowTemplateVersion.findUnique({
      where: { id },
      include: versionInclude,
    });
    if (!v) throw new NotFoundException('Workflow version not found');
    return toVersion(v);
  }

  /** Replace the stages of a DRAFT version. Active/archived versions are immutable. */
  async replaceStages(
    versionId: string,
    dto: ReplaceWorkflowStagesDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<WorkflowVersionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const version = await tx.workflowTemplateVersion.findUnique({
        where: { id: versionId },
        include: { template: true },
      });
      if (!version) throw new NotFoundException('Workflow version not found');
      if (version.status !== 'DRAFT') {
        throw new ConflictException(
          `A ${version.status} workflow version is immutable; create a new version`,
        );
      }
      const stageIds = (
        await tx.workflowTemplateStage.findMany({
          where: { versionId },
          select: { id: true },
        })
      ).map((s) => s.id);
      await tx.workflowTemplateStageDependency.deleteMany({
        where: { stageId: { in: stageIds } },
      });
      await tx.workflowTemplateStage.deleteMany({ where: { versionId } });
      await this.writeStages(tx, versionId, dto.stages);
      if (dto.notes !== undefined)
        await tx.workflowTemplateVersion.update({
          where: { id: versionId },
          data: { notes: dto.notes },
        });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.WORKFLOW_VERSION_UPDATED,
          entityType: 'WorkflowTemplateVersion',
          entityId: versionId,
          metadata: {
            code: version.template.code,
            version: version.version,
            stages: dto.stages.length,
          },
          meta,
        },
        tx,
      );
    });
    return this.getVersion(versionId);
  }

  /** DRAFT → ACTIVE; the previously active version is archived (it keeps serving the jobs that use it). */
  async activate(
    versionId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<WorkflowVersionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const version = await tx.workflowTemplateVersion.findUnique({
        where: { id: versionId },
        include: { ...versionInclude, template: true },
      });
      if (!version) throw new NotFoundException('Workflow version not found');
      await tx.$queryRaw`SELECT id FROM workflow_templates WHERE id = ${version.templateId}::uuid FOR UPDATE`;
      const current = await tx.workflowTemplateVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      if (current.status !== 'DRAFT')
        throw new ConflictException(`Version is already ${current.status}`);
      if (version.template.archivedAt)
        throw new ConflictException('Template is archived');

      const problems = validateWorkflow(
        version.stages.map((s) => ({
          sequence: s.sequence,
          stageCode: s.stageDefinition.code,
          isQcStage: s.stageDefinition.isQcStage,
          dependsOnSequences: s.dependsOn.map((d) => d.dependsOn.sequence),
        })),
      );
      const inactive = version.stages.filter(
        (s) => !s.stageDefinition.isActive || s.stageDefinition.archivedAt,
      );
      if (inactive.length)
        problems.push(
          `inactive stage definitions: ${inactive.map((s) => s.stageDefinition.code).join(', ')}`,
        );
      if (!version.stages.some((s) => s.isRequired))
        problems.push('at least one stage must be required');
      if (problems.length) throw new BadRequestException(problems);

      await tx.workflowTemplateVersion.updateMany({
        where: { templateId: version.templateId, status: 'ACTIVE' },
        data: { status: 'ARCHIVED' },
      });
      await tx.workflowTemplateVersion.update({
        where: { id: versionId },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.WORKFLOW_VERSION_ACTIVATED,
          entityType: 'WorkflowTemplateVersion',
          entityId: versionId,
          metadata: {
            templateId: version.templateId,
            code: version.template.code,
            version: version.version,
          },
          meta,
        },
        tx,
      );
    });
    return this.getVersion(versionId);
  }

  // ---- stage definitions -----------------------------------------------------------

  async listDefinitions(): Promise<StageDefinitionResponseDto[]> {
    const rows = await this.prisma.productionStageDefinition.findMany({
      where: { archivedAt: null },
      orderBy: [{ defaultSequence: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDefinition);
  }

  async createDefinition(
    dto: CreateStageDefinitionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<StageDefinitionResponseDto> {
    if (
      await this.prisma.productionStageDefinition.findUnique({
        where: { code: dto.code },
      })
    ) {
      throw new ConflictException(`Stage code ${dto.code} is already in use`);
    }
    await this.assertRoleCodes(dto.eligibleRoleCodes);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productionStageDefinition.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description,
          departmentType: dto.departmentType,
          defaultSequence: dto.defaultSequence,
          expectedDurationMinutes: dto.expectedDurationMinutes,
          requiresAssignment: dto.requiresAssignment,
          requiresCompletionNote: dto.requiresCompletionNote,
          requiresAttachment: dto.requiresAttachment,
          isQcStage: dto.isQcStage,
          eligibleRoleCodes: dto.eligibleRoleCodes ?? [],
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.STAGE_DEFINITION_CREATED,
          entityType: 'ProductionStageDefinition',
          entityId: created.id,
          metadata: {
            code: created.code,
            departmentType: created.departmentType,
          },
          meta,
        },
        tx,
      );
      return created;
    });
    return toDefinition(row);
  }

  /** Definitions can change freely: running jobs hold their own snapshot of the flags. */
  async updateDefinition(
    id: string,
    dto: UpdateStageDefinitionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<StageDefinitionResponseDto> {
    const existing = await this.prisma.productionStageDefinition.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Stage definition not found');
    await this.assertRoleCodes(dto.eligibleRoleCodes);
    const data = Object.fromEntries(
      Object.entries(dto).filter(
        ([k, v]) => v !== undefined && !(v === null && k === 'name'),
      ),
    );
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.productionStageDefinition.update({
        where: { id },
        data,
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.STAGE_DEFINITION_UPDATED,
          entityType: 'ProductionStageDefinition',
          entityId: id,
          metadata: { code: existing.code, fields: Object.keys(data) },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toDefinition(row);
  }

  // ---- helpers ---------------------------------------------------------------------

  private async assertRoleCodes(codes?: string[]): Promise<void> {
    if (!codes?.length) return;
    const found = await this.prisma.role.findMany({
      where: { code: { in: codes }, deletedAt: null },
      select: { code: true },
    });
    const missing = codes.filter((c) => !found.some((f) => f.code === c));
    if (missing.length)
      throw new BadRequestException(
        `Unknown role codes: ${missing.join(', ')}`,
      );
  }

  private async findTemplate(id: string): Promise<TemplateRow> {
    const t = await this.prisma.workflowTemplate.findUnique({
      where: { id },
      include: templateInclude,
    });
    if (!t) throw new NotFoundException('Workflow template not found');
    return t;
  }

  /** Validate and persist stage entries and their dependency edges for a DRAFT version. */
  private async writeStages(
    tx: Tx,
    versionId: string,
    inputs: WorkflowStageInputDto[],
  ): Promise<void> {
    const codes = [...new Set(inputs.map((s) => s.stageCode))];
    const definitions = await tx.productionStageDefinition.findMany({
      where: { code: { in: codes }, archivedAt: null },
    });
    const byCode = new Map(definitions.map((d) => [d.code, d]));
    const unknown = codes.filter((c) => !byCode.has(c));
    if (unknown.length)
      throw new BadRequestException(
        `Unknown stage codes: ${unknown.join(', ')}`,
      );

    const graph = inputs.map((s) => ({
      sequence: s.sequence,
      stageCode: s.stageCode,
      isQcStage: byCode.get(s.stageCode)!.isQcStage,
      dependsOnSequences: s.dependsOnSequences,
    }));
    const problems = validateWorkflow(graph);
    if (problems.length) throw new BadRequestException(problems);

    const resolved = new Map(
      resolveDependencies(graph).map((r) => [r.sequence, r.dependsOnSequences]),
    );
    const rows = new Map<number, string>();
    for (const input of [...inputs].sort((a, b) => a.sequence - b.sequence)) {
      const row = await tx.workflowTemplateStage.create({
        data: {
          versionId,
          stageDefinitionId: byCode.get(input.stageCode)!.id,
          sequence: input.sequence,
          isRequired: input.isRequired ?? true,
          expectedDurationMinutes: input.expectedDurationMinutes ?? null,
          canRunInParallel: input.canRunInParallel ?? false,
          config: (input.config ?? undefined) as
            Prisma.InputJsonValue | undefined,
        },
      });
      rows.set(input.sequence, row.id);
    }
    for (const [sequence, deps] of resolved) {
      for (const dep of deps) {
        await tx.workflowTemplateStageDependency.create({
          data: {
            stageId: rows.get(sequence)!,
            dependsOnStageId: rows.get(dep)!,
          },
        });
      }
    }
  }
}
