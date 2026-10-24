import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  Prisma,
  SlaRule,
  SlaTargetType,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateSlaRuleDto,
  UpdateSlaRuleDto,
} from './dto/management.dto.js';
import { validatePriorityMultipliers, type SlaRuleLike } from './pure/sla.js';

type Client = PrismaService | Prisma.TransactionClient;

export interface ActiveSlaRules {
  stage(definitionId: string): SlaRuleLike | null;
  job: SlaRuleLike | null;
  order: SlaRuleLike | null;
  shipment: SlaRuleLike | null;
}

export const toRuleLike = (r: SlaRule): SlaRuleLike => ({
  thresholdMinutes: r.thresholdMinutes,
  warningBeforeMinutes: r.warningBeforeMinutes,
  priorityMultipliers:
    (r.priorityMultipliers as Record<string, number> | null) ?? null,
});

const view = (r: SlaRule) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  targetType: r.targetType,
  stageDefinitionId: r.stageDefinitionId,
  thresholdMinutes: r.thresholdMinutes,
  warningBeforeMinutes: r.warningBeforeMinutes,
  priorityMultipliers: r.priorityMultipliers as Record<string, number> | null,
  active: r.active,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** SLA rule configuration. Evaluation itself lives in pure/sla.ts; rules are only ever deactivated, never deleted. */
@Injectable()
export class SlaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(filter: { targetType?: SlaTargetType; active?: boolean }) {
    const rows = await this.prisma.slaRule.findMany({
      where: { targetType: filter.targetType, active: filter.active },
      orderBy: [{ targetType: 'asc' }, { code: 'asc' }],
    });
    return rows.map(view);
  }

  async get(id: string) {
    const r = await this.prisma.slaRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('SLA rule not found');
    return view(r);
  }

  /** One lookup per request: the active rules by target. */
  async activeRules(client: Client = this.prisma): Promise<ActiveSlaRules> {
    const rows = await client.slaRule.findMany({ where: { active: true } });
    const stage = new Map<string, SlaRuleLike>();
    let stageDefault: SlaRuleLike | null = null;
    const one = (t: SlaTargetType) => {
      const r = rows.find((x) => x.targetType === t && !x.stageDefinitionId);
      return r ? toRuleLike(r) : null;
    };
    for (const r of rows.filter((x) => x.targetType === 'STAGE')) {
      if (r.stageDefinitionId) stage.set(r.stageDefinitionId, toRuleLike(r));
      else stageDefault = toRuleLike(r);
    }
    return {
      stage: (id) => stage.get(id) ?? stageDefault,
      job: one('JOB'),
      order: one('ORDER'),
      shipment: one('SHIPMENT'),
    };
  }

  private validate(
    warning: number | null | undefined,
    threshold: number,
    multipliers: unknown,
  ) {
    if (warning != null && warning >= threshold)
      throw new BadRequestException(
        'warningBeforeMinutes must be smaller than thresholdMinutes',
      );
    const bad = validatePriorityMultipliers(multipliers);
    if (bad) throw new BadRequestException(bad);
  }

  async create(dto: CreateSlaRuleDto, actor: AuthUser, meta: RequestMeta) {
    if (dto.stageDefinitionId && dto.targetType !== 'STAGE')
      throw new BadRequestException(
        'stageDefinitionId is only valid for STAGE rules',
      );
    this.validate(
      dto.warningBeforeMinutes,
      dto.thresholdMinutes,
      dto.priorityMultipliers,
    );
    const active = dto.active ?? true;
    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.stageDefinitionId) {
        const def = await tx.productionStageDefinition.findUnique({
          where: { id: dto.stageDefinitionId },
        });
        if (!def) throw new BadRequestException('Unknown stage definition');
      }
      if (await tx.slaRule.findUnique({ where: { code: dto.code } }))
        throw new ConflictException(`SLA rule ${dto.code} already exists`);
      if (active)
        await this.assertNoActiveTwin(
          tx,
          dto.targetType,
          dto.stageDefinitionId ?? null,
        );
      const rule = await tx.slaRule.create({
        data: {
          code: dto.code,
          name: dto.name,
          targetType: dto.targetType,
          stageDefinitionId: dto.stageDefinitionId,
          thresholdMinutes: dto.thresholdMinutes,
          warningBeforeMinutes: dto.warningBeforeMinutes,
          priorityMultipliers: dto.priorityMultipliers as
            Prisma.InputJsonValue | undefined,
          active,
          createdByUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SLA_RULE_CREATED,
          entityType: 'SlaRule',
          entityId: rule.id,
          metadata: view(rule) as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return rule;
    });
    return view(created);
  }

  private async assertNoActiveTwin(
    tx: Client,
    targetType: SlaTargetType,
    stageDefinitionId: string | null,
    exceptId?: string,
  ) {
    const twin = await tx.slaRule.findFirst({
      where: {
        active: true,
        targetType,
        stageDefinitionId,
        id: exceptId ? { not: exceptId } : undefined,
      },
    });
    if (twin)
      throw new ConflictException(
        `${twin.code} is already the active ${targetType}${stageDefinitionId ? ' stage' : ''} rule; deactivate it first`,
      );
  }

  async update(
    id: string,
    dto: UpdateSlaRuleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.slaRule.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('SLA rule not found');
      const threshold = dto.thresholdMinutes ?? current.thresholdMinutes;
      const warning =
        dto.warningBeforeMinutes === undefined
          ? current.warningBeforeMinutes
          : dto.warningBeforeMinutes;
      this.validate(
        warning,
        threshold,
        dto.priorityMultipliers === undefined
          ? current.priorityMultipliers
          : dto.priorityMultipliers,
      );
      if (dto.active === true && !current.active)
        await this.assertNoActiveTwin(
          tx,
          current.targetType,
          current.stageDefinitionId,
          id,
        );
      const data: Prisma.SlaRuleUncheckedUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.thresholdMinutes !== undefined)
        data.thresholdMinutes = dto.thresholdMinutes;
      if (dto.warningBeforeMinutes !== undefined)
        data.warningBeforeMinutes = dto.warningBeforeMinutes;
      // null clears the multipliers (stored as an empty map)
      if (dto.priorityMultipliers !== undefined)
        data.priorityMultipliers = (dto.priorityMultipliers ??
          {}) as Prisma.InputJsonValue;
      if (dto.active !== undefined) data.active = dto.active;
      if (Object.keys(data).length === 0)
        throw new BadRequestException('Nothing to update');
      const next = await tx.slaRule.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action:
            dto.active === false
              ? AuditAction.SLA_RULE_DEACTIVATED
              : AuditAction.SLA_RULE_UPDATED,
          entityType: 'SlaRule',
          entityId: id,
          metadata: {
            code: current.code,
            before: view(current),
            after: view(next),
          } as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return next;
    });
    return view(updated);
  }

  deactivate(id: string, actor: AuthUser, meta: RequestMeta) {
    return this.update(id, { active: false }, actor, meta);
  }
}
