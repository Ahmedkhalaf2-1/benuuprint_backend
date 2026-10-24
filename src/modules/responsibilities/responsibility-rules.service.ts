import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthContextService } from '../auth/auth-context.service.js';
import type {
  CustomerResponsibilityItemDto,
  ResponsibilityAreaDto,
  ResponsibilityOverviewItemDto,
  ResponsibilityRuleDto,
  SetResponsibilityDto,
  UserRefDto,
} from './dto/responsibility.dto.js';

type Tx = Prisma.TransactionClient;

export const DELIVERY_KEY = 'DELIVERY';

/** Stage statuses that count as "open work" for an owner. */
export const OPEN_STAGE_STATUSES = [
  'WAITING',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
] as const;
export const LIVE_SHIPMENT_STATUSES = [
  'DRAFT',
  'READY',
  'DISPATCHED',
  'IN_TRANSIT',
] as const;

export type Eligibility =
  | { ok: true }
  | {
      ok: false;
      reason: 'ASSIGNEE_DISABLED' | 'ASSIGNEE_INELIGIBLE';
      detail: string;
    };

export interface RuleView {
  id: string;
  scope: 'GLOBAL' | 'CUSTOMER';
  customerId: string | null;
  stageKey: string;
  primaryUserId: string;
  additionalUserIds: string[];
  updatedAt: Date;
  health: 'OK' | 'NEEDS_ATTENTION';
  reason: 'ASSIGNEE_DISABLED' | 'ASSIGNEE_INELIGIBLE' | null;
  /** Additional workers that are still eligible (the only ones auto-assignment will use). */
  usableAdditionalUserIds: string[];
}

export interface Resolution {
  stageKey: string;
  source: 'CUSTOMER_OVERRIDE' | 'GLOBAL_DEFAULT' | 'UNASSIGNED';
  customerOverride: RuleView | null;
  globalDefault: RuleView | null;
  /** The rule that wins by precedence (customer override, else global), healthy or not. */
  winning: RuleView | null;
  /** Who future work goes to: the winning rule's primary owner, only if that rule is healthy. */
  effectiveUserId: string | null;
  usableAdditionalUserIds: string[];
  health: 'OK' | 'NEEDS_ATTENTION' | 'NOT_CONFIGURED';
  reason: string | null;
}

interface AreaInfo extends ResponsibilityAreaDto {
  stageDefinitionId: string | null;
  requiredPermission: 'stages.start' | 'shipments.dispatch';
}

const ruleSelect = {
  id: true,
  scope: true,
  customerId: true,
  stageKey: true,
  primaryUserId: true,
  additionalUserIds: true,
  updatedAt: true,
} as const;

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * Default responsibilities. A rule says who owns an operational area (a production stage definition code,
 * or DELIVERY for shipments) by default, globally or for one customer. Resolution is always done here:
 * customer override, then global default, then nobody. Rules only drive future work; nothing here
 * rewrites assignments that already exist (see StageAutoAssignService for that).
 */
@Injectable()
export class ResponsibilityRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AuthContextService,
  ) {}

  // ───────────────────────── areas ─────────────────────────

  /** Every area a rule can exist for: assignable stage definitions plus DELIVERY. */
  async areas(): Promise<AreaInfo[]> {
    const defs = await this.prisma.productionStageDefinition.findMany({
      where: { isActive: true, archivedAt: null, requiresAssignment: true },
      orderBy: [{ defaultSequence: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, eligibleRoleCodes: true },
    });
    return [
      ...defs.map((d): AreaInfo => ({
        stageKey: d.code,
        label: d.name,
        group: 'FACTORY',
        eligibleRoleCodes: d.eligibleRoleCodes,
        stageDefinitionId: d.id,
        requiredPermission: 'stages.start',
      })),
      {
        stageKey: DELIVERY_KEY,
        label: 'Delivery',
        group: 'FULFILLMENT',
        eligibleRoleCodes: [],
        stageDefinitionId: null,
        requiredPermission: 'shipments.dispatch',
      },
    ];
  }

  private async area(stageKey: string): Promise<AreaInfo> {
    const found = (await this.areas()).find((a) => a.stageKey === stageKey);
    if (!found) {
      throw new NotFoundException(
        `Unknown responsibility area "${stageKey}"; use a stage definition code or DELIVERY`,
      );
    }
    return found;
  }

  // ───────────────────────── eligibility ─────────────────────────

  /**
   * Same rules as assigning a stage by hand: an active staff user who holds the permission to run stages
   * (or make deliveries) and, when the stage lists eligible roles, one of those roles. No role-name bypass.
   */
  async eligibility(
    userId: string,
    area: AreaInfo,
    cache?: Map<string, Awaited<ReturnType<AuthContextService['loadAccess']>>>,
  ): Promise<Eligibility> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true, status: true, deletedAt: true, name: true },
    });
    if (!user || user.deletedAt || !user.isActive || user.status !== 'ACTIVE') {
      return {
        ok: false,
        reason: 'ASSIGNEE_DISABLED',
        detail: 'The staff member is not an active user',
      };
    }
    let access = cache?.get(userId);
    if (!access) {
      access = await this.access.loadAccess(userId);
      cache?.set(userId, access);
    }
    if (!access.permissions.has(area.requiredPermission)) {
      return {
        ok: false,
        reason: 'ASSIGNEE_INELIGIBLE',
        detail:
          area.requiredPermission === 'stages.start'
            ? `${user.name} cannot work on production stages`
            : `${user.name} cannot make deliveries`,
      };
    }
    if (
      area.eligibleRoleCodes.length > 0 &&
      !access.roleCodes.some((r) => area.eligibleRoleCodes.includes(r))
    ) {
      return {
        ok: false,
        reason: 'ASSIGNEE_INELIGIBLE',
        detail: `${user.name} does not hold a role eligible for ${area.label} (${area.eligibleRoleCodes.join(', ')})`,
      };
    }
    return { ok: true };
  }

  // ───────────────────────── rules (read) ─────────────────────────

  private async hydrate(
    rows: Array<{
      id: string;
      scope: 'GLOBAL' | 'CUSTOMER';
      customerId: string | null;
      stageKey: string;
      primaryUserId: string;
      additionalUserIds: string[];
      updatedAt: Date;
    }>,
    areas: AreaInfo[],
  ): Promise<RuleView[]> {
    const byKey = new Map(areas.map((a) => [a.stageKey, a]));
    const cache = new Map<
      string,
      Awaited<ReturnType<AuthContextService['loadAccess']>>
    >();
    const out: RuleView[] = [];
    for (const r of rows) {
      const area = byKey.get(r.stageKey);
      const primary = area
        ? await this.eligibility(r.primaryUserId, area, cache)
        : ({
            ok: false,
            reason: 'ASSIGNEE_INELIGIBLE',
            detail: 'The area no longer exists',
          } as const);
      const usable: string[] = [];
      for (const id of r.additionalUserIds) {
        if (area && (await this.eligibility(id, area, cache)).ok) {
          usable.push(id);
        }
      }
      out.push({
        ...r,
        health: primary.ok ? 'OK' : 'NEEDS_ATTENTION',
        reason: primary.ok ? null : primary.reason,
        usableAdditionalUserIds: usable,
      });
    }
    return out;
  }

  async globalRules(): Promise<RuleView[]> {
    const rows = await this.prisma.responsibilityRule.findMany({
      where: { scope: 'GLOBAL' },
      select: ruleSelect,
    });
    return this.hydrate(rows, await this.areas());
  }

  async customerRules(customerIds: string[]): Promise<RuleView[]> {
    if (customerIds.length === 0) return [];
    const rows = await this.prisma.responsibilityRule.findMany({
      where: { scope: 'CUSTOMER', customerId: { in: customerIds } },
      select: ruleSelect,
    });
    return this.hydrate(rows, await this.areas());
  }

  /** Precedence, health and the effective owner for each area, for each customer, in two rule queries. */
  async resolveMany(
    customerIds: string[],
    areas?: AreaInfo[],
  ): Promise<Map<string, Map<string, Resolution>>> {
    const allAreas = areas ?? (await this.areas());
    const [globals, customers] = await Promise.all([
      this.globalRules(),
      this.customerRules(customerIds),
    ]);
    const globalByKey = new Map(globals.map((g) => [g.stageKey, g]));
    const customerRule = new Map(
      customers.map((c) => [`${c.customerId}:${c.stageKey}`, c]),
    );
    const out = new Map<string, Map<string, Resolution>>();
    for (const customerId of customerIds) {
      const perArea = new Map<string, Resolution>();
      for (const a of allAreas) {
        const override =
          customerRule.get(`${customerId}:${a.stageKey}`) ?? null;
        const global = globalByKey.get(a.stageKey) ?? null;
        const winning = override ?? global;
        perArea.set(a.stageKey, {
          stageKey: a.stageKey,
          source: override
            ? 'CUSTOMER_OVERRIDE'
            : global
              ? 'GLOBAL_DEFAULT'
              : 'UNASSIGNED',
          customerOverride: override,
          globalDefault: global,
          winning,
          effectiveUserId:
            winning && winning.health === 'OK' ? winning.primaryUserId : null,
          usableAdditionalUserIds:
            winning && winning.health === 'OK'
              ? winning.usableAdditionalUserIds
              : [],
          health: winning ? winning.health : 'NOT_CONFIGURED',
          reason: winning?.reason ?? null,
        });
      }
      out.set(customerId, perArea);
    }
    return out;
  }

  async resolveForCustomer(
    customerId: string,
  ): Promise<Map<string, Resolution>> {
    return (await this.resolveMany([customerId])).get(customerId)!;
  }

  /** The delivery person a new shipment of this customer gets by default (null: leave it unassigned). */
  async defaultDeliveryUserId(customerId: string): Promise<string | null> {
    const r = (await this.resolveForCustomer(customerId)).get(DELIVERY_KEY);
    return r?.effectiveUserId ?? null;
  }

  // ───────────────────────── presentation helpers ─────────────────────────

  async userRefs(ids: string[]): Promise<Map<string, UserRefDto>> {
    const rows = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: unique(ids) } },
          select: { id: true, name: true },
        })
      : [];
    return new Map(rows.map((u) => [u.id, u]));
  }

  /** Open stages (and live shipments for DELIVERY) per user and area. */
  async activeWork(userIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (userIds.length === 0) return out;
    const [assignments, shipments] = await Promise.all([
      this.prisma.stageAssignment.findMany({
        where: {
          removedAt: null,
          userId: { in: userIds },
          jobStage: {
            supersededAt: null,
            status: { in: [...OPEN_STAGE_STATUSES] },
            job: { status: { notIn: ['CANCELLED', 'COMPLETED'] } },
          },
        },
        select: { userId: true, jobStage: { select: { stageCode: true } } },
      }),
      this.prisma.shipment.groupBy({
        by: ['assignedDeliveryUserId'],
        where: {
          assignedDeliveryUserId: { in: userIds },
          status: { in: [...LIVE_SHIPMENT_STATUSES] },
        },
        _count: { _all: true },
      }),
    ]);
    for (const a of assignments) {
      const k = `${a.userId}:${a.jobStage.stageCode}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    for (const s of shipments) {
      out.set(`${s.assignedDeliveryUserId}:${DELIVERY_KEY}`, s._count._all);
    }
    return out;
  }

  private async toRuleDto(rule: RuleView): Promise<ResponsibilityRuleDto> {
    const users = await this.userRefs([
      rule.primaryUserId,
      ...rule.additionalUserIds,
    ]);
    return {
      scope: rule.scope,
      customerId: rule.customerId,
      stageKey: rule.stageKey,
      primaryUser: users.get(rule.primaryUserId)!,
      additionalUsers: rule.additionalUserIds
        .map((id) => users.get(id))
        .filter((u): u is UserRefDto => !!u),
      health: rule.health,
      reason: rule.reason,
      updatedAt: rule.updatedAt,
    };
  }

  // ───────────────────────── global defaults ─────────────────────────

  async overview(): Promise<ResponsibilityOverviewItemDto[]> {
    const areas = await this.areas();
    const globals = await this.globalRules();
    const byKey = new Map(globals.map((g) => [g.stageKey, g]));
    const userIds = unique(
      globals.flatMap((g) => [g.primaryUserId, ...g.additionalUserIds]),
    );
    const [users, work] = await Promise.all([
      this.userRefs(userIds),
      this.activeWork(unique(globals.map((g) => g.primaryUserId))),
    ]);
    return areas.map((a) => {
      const g = byKey.get(a.stageKey) ?? null;
      const effective = g && g.health === 'OK' ? g.primaryUserId : null;
      return {
        stageKey: a.stageKey,
        label: a.label,
        group: a.group,
        eligibleRoleCodes: a.eligibleRoleCodes,
        globalDefault: g && {
          scope: g.scope,
          customerId: null,
          stageKey: g.stageKey,
          primaryUser: users.get(g.primaryUserId)!,
          additionalUsers: g.additionalUserIds
            .map((id) => users.get(id))
            .filter((u): u is UserRefDto => !!u),
          health: g.health,
          reason: g.reason,
          updatedAt: g.updatedAt,
        },
        effectiveUser: effective ? (users.get(effective) ?? null) : null,
        source: g ? 'GLOBAL_DEFAULT' : 'UNASSIGNED',
        health: g ? g.health : 'NOT_CONFIGURED',
        reason: g?.reason ?? null,
        activeWork: g ? (work.get(`${g.primaryUserId}:${a.stageKey}`) ?? 0) : 0,
      };
    });
  }

  // ───────────────────────── rule changes ─────────────────────────

  private async validateAssignees(
    area: AreaInfo,
    dto: { userId: string; additionalUserIds?: string[] },
  ) {
    const additional = unique(dto.additionalUserIds ?? []);
    if (additional.includes(dto.userId)) {
      throw new BadRequestException(
        'additionalUserIds must not repeat the primary owner',
      );
    }
    const cache = new Map<
      string,
      Awaited<ReturnType<AuthContextService['loadAccess']>>
    >();
    for (const id of [dto.userId, ...additional]) {
      const e = await this.eligibility(id, area, cache);
      if (!e.ok) throw new BadRequestException(e.detail);
    }
    return additional;
  }

  /** Create or change one rule; a no-op change is not audited. */
  async setRule(
    scope: 'GLOBAL' | 'CUSTOMER',
    customerId: string | null,
    stageKey: string,
    dto: SetResponsibilityDto,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<ResponsibilityRuleDto> {
    const area = await this.area(stageKey);
    if (scope === 'CUSTOMER') await this.assertCustomer(customerId);
    const additional = await this.validateAssignees(area, dto);
    await this.prisma.$transaction(async (tx) => {
      await this.upsert(
        tx,
        scope,
        customerId,
        stageKey,
        dto.userId,
        additional,
        actor,
        meta,
      );
    });
    const rule = await this.findOne(scope, customerId, stageKey);
    return this.toRuleDto(rule!);
  }

  private async upsert(
    tx: Tx,
    scope: 'GLOBAL' | 'CUSTOMER',
    customerId: string | null,
    stageKey: string,
    userId: string,
    additional: string[],
    actor: AuthUser,
    meta?: RequestMeta,
    audit = true,
  ): Promise<{ changed: boolean; previousUserId: string | null }> {
    const existing = await tx.responsibilityRule.findFirst({
      where: { scope, customerId, stageKey },
    });
    const same =
      existing &&
      existing.primaryUserId === userId &&
      [...existing.additionalUserIds].sort().join() ===
        [...additional].sort().join();
    if (same) return { changed: false, previousUserId: userId };
    if (existing) {
      await tx.responsibilityRule.update({
        where: { id: existing.id },
        data: {
          primaryUserId: userId,
          additionalUserIds: additional,
          updatedByUserId: actor.id,
        },
      });
    } else {
      try {
        await tx.responsibilityRule.create({
          data: {
            scope,
            customerId,
            stageKey,
            primaryUserId: userId,
            additionalUserIds: additional,
            createdByUserId: actor.id,
            updatedByUserId: actor.id,
          },
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'PrismaClientKnownRequestError') {
          throw new ConflictException('Concurrent change, please retry');
        }
        throw e;
      }
    }
    if (audit) {
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.RESPONSIBILITY_SET,
          entityType: 'ResponsibilityRule',
          entityId: customerId ?? stageKey,
          metadata: {
            scope,
            customerId,
            stageKey,
            created: !existing,
            oldUserId: existing?.primaryUserId ?? null,
            newUserId: userId,
            additionalUserIds: additional,
          },
          meta,
        },
        tx,
      );
    }
    return { changed: true, previousUserId: existing?.primaryUserId ?? null };
  }

  async clearRule(
    scope: 'GLOBAL' | 'CUSTOMER',
    customerId: string | null,
    stageKey: string,
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<void> {
    await this.area(stageKey);
    if (scope === 'CUSTOMER') await this.assertCustomer(customerId);
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.responsibilityRule.findFirst({
        where: { scope, customerId, stageKey },
      });
      if (!existing) throw new NotFoundException('No such responsibility rule');
      await tx.responsibilityRule.delete({ where: { id: existing.id } });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.RESPONSIBILITY_CLEARED,
          entityType: 'ResponsibilityRule',
          entityId: customerId ?? stageKey,
          metadata: {
            scope,
            customerId,
            stageKey,
            oldUserId: existing.primaryUserId,
            newUserId: null,
          },
          meta,
        },
        tx,
      );
    });
  }

  /** Set or clear one customer override for many customers; one audit entry with the affected count. */
  async bulkCustomerOverrides(
    p: {
      customerIds: string[];
      stageKey: string;
      userId?: string;
      additionalUserIds?: string[];
      clear?: boolean;
    },
    actor: AuthUser,
    meta?: RequestMeta,
  ): Promise<{
    stageKey: string;
    requested: number;
    changed: number;
    unchanged: number;
  }> {
    const area = await this.area(p.stageKey);
    const customerIds = unique(p.customerIds);
    const found = await this.prisma.customer.findMany({
      where: { id: { in: customerIds }, archivedAt: null },
      select: { id: true },
    });
    if (found.length !== customerIds.length) {
      throw new BadRequestException(
        'Some customers do not exist or are archived',
      );
    }
    let additional: string[] = [];
    if (!p.clear) {
      if (!p.userId) {
        throw new BadRequestException(
          'userId is required unless clear is true',
        );
      }
      additional = await this.validateAssignees(area, {
        userId: p.userId,
        additionalUserIds: p.additionalUserIds,
      });
    }
    let changed = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const customerId of customerIds) {
        if (p.clear) {
          const { count } = await tx.responsibilityRule.deleteMany({
            where: { scope: 'CUSTOMER', customerId, stageKey: p.stageKey },
          });
          changed += count;
        } else {
          const r = await this.upsert(
            tx,
            'CUSTOMER',
            customerId,
            p.stageKey,
            p.userId!,
            additional,
            actor,
            meta,
            false,
          );
          if (r.changed) changed += 1;
        }
      }
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.RESPONSIBILITY_BULK_OVERRIDES,
          entityType: 'ResponsibilityRule',
          entityId: p.stageKey,
          metadata: {
            scope: 'CUSTOMER',
            stageKey: p.stageKey,
            cleared: !!p.clear,
            newUserId: p.clear ? null : p.userId,
            customerIds,
            affectedCount: changed,
          },
          meta,
        },
        tx,
      );
    });
    return {
      stageKey: p.stageKey,
      requested: customerIds.length,
      changed,
      unchanged: customerIds.length - changed,
    };
  }

  private async findOne(
    scope: 'GLOBAL' | 'CUSTOMER',
    customerId: string | null,
    stageKey: string,
  ): Promise<RuleView | null> {
    const row = await this.prisma.responsibilityRule.findFirst({
      where: { scope, customerId, stageKey },
      select: ruleSelect,
    });
    return row ? (await this.hydrate([row], await this.areas()))[0]! : null;
  }

  async assertCustomer(customerId: string | null): Promise<void> {
    const c = customerId
      ? await this.prisma.customer.findUnique({
          where: { id: customerId },
          select: { archivedAt: true },
        })
      : null;
    if (!c) throw new NotFoundException('Customer not found');
    if (c.archivedAt) throw new ConflictException('The customer is archived');
  }

  // ───────────────────────── customer matrix ─────────────────────────

  async customerMatrix(customerId: string): Promise<{
    customerId: string;
    commercial: {
      salesOwner: (UserRefDto & { referenceNumber: string }) | null;
    };
    areas: CustomerResponsibilityItemDto[];
  }> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const areas = await this.areas();
    const resolution = (await this.resolveMany([customerId], areas)).get(
      customerId,
    )!;
    const items = [...resolution.values()];
    const userIds = unique(
      items.flatMap((r) =>
        [
          r.globalDefault?.primaryUserId,
          r.customerOverride?.primaryUserId,
        ].filter((x): x is string => !!x),
      ),
    );
    const [users, work, salesOwner] = await Promise.all([
      this.userRefs(userIds),
      this.activeWork(
        unique(
          items.map((r) => r.effectiveUserId).filter((x): x is string => !!x),
        ),
      ),
      this.salesOwners([customerId]),
    ]);
    return {
      customerId,
      commercial: { salesOwner: salesOwner.get(customerId) ?? null },
      areas: areas.map((a) => {
        const r = resolution.get(a.stageKey)!;
        return {
          stageKey: a.stageKey,
          label: a.label,
          group: a.group,
          eligibleRoleCodes: a.eligibleRoleCodes,
          source: r.source,
          effectiveUser: r.effectiveUserId
            ? (users.get(r.effectiveUserId) ?? null)
            : null,
          globalDefaultUser: r.globalDefault
            ? (users.get(r.globalDefault.primaryUserId) ?? null)
            : null,
          customerOverrideUser: r.customerOverride
            ? (users.get(r.customerOverride.primaryUserId) ?? null)
            : null,
          health: r.health,
          reason: r.reason,
          activeWork: r.effectiveUserId
            ? (work.get(`${r.effectiveUserId}:${a.stageKey}`) ?? 0)
            : 0,
        };
      }),
    };
  }

  /**
   * The customer's sales owner is not a customer field: it lives on samples and orders. Take the owner of
   * the most recent live sample/order that has one.
   */
  async salesOwners(
    customerIds: string[],
  ): Promise<Map<string, UserRefDto & { referenceNumber: string }>> {
    const out = new Map<string, UserRefDto & { referenceNumber: string }>();
    if (customerIds.length === 0) return out;
    const [orders, samples] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          customerId: { in: customerIds },
          assignedSalesUserId: { not: null },
          status: { notIn: ['CANCELLED', 'COMPLETED', 'DELIVERED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          customerId: true,
          orderNumber: true,
          createdAt: true,
          assignedSalesUserId: true,
        },
      }),
      this.prisma.sample.findMany({
        where: {
          customerId: { in: customerIds },
          assignedSalesUserId: { not: null },
          status: { notIn: ['CANCELLED', 'COMPLETED', 'REJECTED', 'APPROVED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          customerId: true,
          sampleNumber: true,
          createdAt: true,
          assignedSales: { select: { id: true, name: true } },
        },
      }),
    ]);
    const orderOwners = await this.userRefs(
      orders.map((o) => o.assignedSalesUserId).filter((x): x is string => !!x),
    );
    const candidates = [
      ...orders.map((o) => ({
        customerId: o.customerId,
        at: o.createdAt,
        ref: o.orderNumber,
        user: orderOwners.get(o.assignedSalesUserId ?? '') ?? null,
      })),
      ...samples.map((s) => ({
        customerId: s.customerId,
        at: s.createdAt,
        ref: s.sampleNumber,
        user: s.assignedSales,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    for (const c of candidates) {
      if (c.user && !out.has(c.customerId)) {
        out.set(
          c.customerId,
          Object.assign({}, c.user, { referenceNumber: c.ref }),
        );
      }
    }
    return out;
  }

  // ───────────────────────── command centre ─────────────────────────

  /** What needs attention: rules pointing at people who can no longer do the work, and open stages nobody owns. */
  async attention() {
    const areas = await this.areas();
    const [globals, customers] = await Promise.all([
      this.globalRules(),
      this.prisma.responsibilityRule
        .findMany({ where: { scope: 'CUSTOMER' }, select: ruleSelect })
        .then((rows) => this.hydrate(rows, areas)),
    ]);
    const bad = [...globals, ...customers].filter((r) => r.health !== 'OK');
    const users = await this.userRefs(bad.map((r) => r.primaryUserId));
    const unassigned = await this.prisma.jobStage.groupBy({
      by: ['stageCode'],
      where: {
        supersededAt: null,
        requiresAssignment: true,
        status: { in: ['READY', 'IN_PROGRESS', 'BLOCKED'] },
        job: { status: { notIn: ['CANCELLED', 'COMPLETED', 'PLANNED'] } },
        assignments: { none: { removedAt: null } },
      },
      _count: { _all: true },
    });
    const label = new Map(areas.map((a) => [a.stageKey, a.label]));
    return {
      rulesNeedingAttention: {
        count: bad.length,
        items: bad.map((r) => ({
          scope: r.scope,
          customerId: r.customerId,
          stageKey: r.stageKey,
          label: label.get(r.stageKey) ?? r.stageKey,
          configuredUser: users.get(r.primaryUserId) ?? null,
          effectiveUser: null,
          health: r.health,
          reason: r.reason,
        })),
      },
      unassignedActiveStages: {
        count: unassigned.reduce((s, g) => s + g._count._all, 0),
        byStageKey: unassigned.map((g) => ({
          stageKey: g.stageCode,
          label: label.get(g.stageCode) ?? g.stageCode,
          count: g._count._all,
        })),
      },
    };
  }
}
