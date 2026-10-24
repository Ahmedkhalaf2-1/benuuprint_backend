import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import { ALL_PERMISSION_CODES } from '../../common/enums/permissions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  AutomationRule,
  EscalationRule,
  NotificationChannel,
  Prisma,
} from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { TEMPLATE_CATALOG } from '../notifications/template-catalog.js';
import type {
  CreateAutomationRuleDto,
  CreateEscalationRuleDto,
  ListRulesQueryDto,
  UpdateAutomationRuleDto,
  UpdateEscalationRuleDto,
} from './dto/automation.dto.js';

/** Events a customer may be told about. Operational failures, rework, blockers and alerts are never in this list. */
export const CUSTOMER_SAFE_EVENTS = [
  'QUOTATION_SENT',
  'SAMPLE_READY_FOR_APPROVAL',
  'PAYMENT_VERIFIED',
  'PAYMENT_REJECTED',
  'SAMPLE_APPROVED',
  'SAMPLE_CHANGES_REQUESTED',
  'ORDER_CONFIRMED',
  'ORDER_READY_FOR_PRODUCTION',
  'ORDER_PRODUCTION_COMPLETED',
  'ORDER_MILESTONE',
  'ORDER_READY_FOR_DELIVERY',
  'SHIPMENT_DISPATCHED',
  'ORDER_DELIVERED',
] as const;

const ruleView = (r: AutomationRule) => ({
  id: r.id,
  code: r.code,
  eventType: r.eventType,
  alertType: r.alertType,
  minSeverity: r.minSeverity,
  audience: r.audience,
  audienceValue: r.audienceValue,
  channels: r.channels,
  templateCode: r.templateCode,
  severity: r.severity,
  critical: r.critical,
  active: r.active,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const escView = (r: EscalationRule) => ({
  id: r.id,
  code: r.code,
  alertType: r.alertType,
  minSeverity: r.minSeverity,
  level: r.level,
  afterMinutes: r.afterMinutes,
  recipientKind: r.recipientKind,
  recipientRoleCode: r.recipientRoleCode,
  channels: r.channels,
  critical: r.critical,
  active: r.active,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * A narrow configuration layer over supported event types: who is told, over which channels, with which
 * template. It is not a rules engine: no conditions language, no actions other than "notify".
 * Safety rails: customers can only receive customer-safe events with customer templates; staff audiences only
 * get staff templates; roles and permissions must exist; escalation levels are capped.
 */
@Injectable()
export class AutomationRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listRules(q: ListRulesQueryDto) {
    const rows = await this.prisma.automationRule.findMany({
      where: {
        eventType: q.eventType,
        active: q.activeOnly ? true : undefined,
      },
      orderBy: [{ eventType: 'asc' }, { code: 'asc' }],
    });
    return rows.map(ruleView);
  }

  async getRule(id: string) {
    const r = await this.prisma.automationRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Automation rule not found');
    return ruleView(r);
  }

  private async validateRule(
    tx: Prisma.TransactionClient,
    r: {
      eventType: string;
      alertType?: string | null;
      minSeverity?: string | null;
      audience: string;
      audienceValue?: string | null;
      channels: NotificationChannel[];
      templateCode: string;
    },
  ) {
    const isAlert = r.eventType.startsWith('ALERT_');
    if ((r.alertType || r.minSeverity) && !isAlert)
      throw new BadRequestException(
        'alertType / minSeverity only apply to ALERT_* events',
      );
    if (r.eventType === 'ALERT_ESCALATED')
      throw new BadRequestException(
        'Escalations are configured through escalation rules',
      );
    const entry = TEMPLATE_CATALOG.find((t) => t.code === r.templateCode);
    const hasTemplate =
      entry ||
      (await tx.notificationTemplate.findFirst({
        where: { code: r.templateCode },
        select: { id: true },
      }));
    if (!hasTemplate)
      throw new BadRequestException(`Unknown template code ${r.templateCode}`);
    const audienceKind =
      entry?.audience ?? (r.audience === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF');
    if (r.audience === 'CUSTOMER') {
      if (!(CUSTOMER_SAFE_EVENTS as readonly string[]).includes(r.eventType))
        throw new BadRequestException(
          `${r.eventType} is internal and cannot be sent to customers`,
        );
      if (audienceKind !== 'CUSTOMER')
        throw new BadRequestException(
          'Customers can only receive customer templates',
        );
      if (r.channels.includes('IN_APP'))
        throw new BadRequestException('Customers have no in-app inbox');
    } else if (audienceKind === 'CUSTOMER') {
      throw new BadRequestException(
        'A customer template cannot be sent to staff',
      );
    }
    if (r.audience === 'ROLE') {
      if (
        !r.audienceValue ||
        !(await tx.role.findUnique({ where: { code: r.audienceValue } }))
      )
        throw new BadRequestException(
          'audienceValue must be an existing role code',
        );
    } else if (r.audience === 'PERMISSION') {
      if (
        !r.audienceValue ||
        !(ALL_PERMISSION_CODES as string[]).includes(r.audienceValue)
      )
        throw new BadRequestException(
          'audienceValue must be a permission code',
        );
    } else if (r.audienceValue) {
      throw new BadRequestException(
        `audienceValue is not used by the ${r.audience} audience`,
      );
    }
    if (r.audience === 'ALERT_RESPONSIBLE' && !isAlert)
      throw new BadRequestException(
        'ALERT_RESPONSIBLE only applies to ALERT_* events',
      );
  }

  async createRule(
    dto: CreateAutomationRuleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      if (await tx.automationRule.findUnique({ where: { code: dto.code } }))
        throw new ConflictException(`Rule ${dto.code} already exists`);
      await this.validateRule(tx, dto);
      const r = await tx.automationRule.create({
        data: {
          code: dto.code,
          eventType: dto.eventType,
          alertType: dto.alertType,
          minSeverity: dto.minSeverity,
          audience: dto.audience,
          audienceValue: dto.audienceValue,
          channels: [...new Set(dto.channels)],
          templateCode: dto.templateCode,
          severity: dto.severity ?? 'INFO',
          critical: dto.critical ?? false,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.AUTOMATION_RULE_CREATED,
          entityType: 'AutomationRule',
          entityId: r.id,
          metadata: ruleView(r) as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return r;
    });
    return ruleView(created);
  }

  async updateRule(
    id: string,
    dto: UpdateAutomationRuleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.automationRule.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Automation rule not found');
      const next = {
        ...cur,
        channels: dto.channels ? [...new Set(dto.channels)] : cur.channels,
        templateCode: dto.templateCode ?? cur.templateCode,
        audienceValue: dto.audienceValue ?? cur.audienceValue,
        minSeverity:
          dto.minSeverity === undefined ? cur.minSeverity : dto.minSeverity,
      };
      await this.validateRule(tx, next);
      const data: Prisma.AutomationRuleUpdateInput = {};
      if (dto.channels) data.channels = next.channels;
      if (dto.templateCode) data.templateCode = dto.templateCode;
      if (dto.audienceValue) data.audienceValue = dto.audienceValue;
      if (dto.severity) data.severity = dto.severity;
      if (dto.minSeverity !== undefined) data.minSeverity = dto.minSeverity;
      if (dto.critical !== undefined) data.critical = dto.critical;
      if (dto.active !== undefined) data.active = dto.active;
      if (Object.keys(data).length === 0)
        throw new BadRequestException('Nothing to update');
      const r = await tx.automationRule.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.AUTOMATION_RULE_UPDATED,
          entityType: 'AutomationRule',
          entityId: id,
          metadata: {
            code: cur.code,
            before: ruleView(cur),
            after: ruleView(r),
          } as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return r;
    });
    return ruleView(updated);
  }

  // ───────────────────────── escalation ─────────────────────────

  async listEscalations(q: { alertType?: string; activeOnly?: boolean }) {
    const rows = await this.prisma.escalationRule.findMany({
      where: {
        alertType: q.alertType,
        active: q.activeOnly ? true : undefined,
      },
      orderBy: [{ alertType: 'asc' }, { level: 'asc' }],
    });
    return rows.map(escView);
  }

  private async assertRole(tx: Prisma.TransactionClient, code?: string | null) {
    if (!code || !(await tx.role.findUnique({ where: { code } })))
      throw new BadRequestException(
        'recipientRoleCode must be an existing role code',
      );
  }

  async createEscalation(
    dto: CreateEscalationRuleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      if (await tx.escalationRule.findUnique({ where: { code: dto.code } }))
        throw new ConflictException(`Rule ${dto.code} already exists`);
      if (dto.recipientKind === 'ROLE')
        await this.assertRole(tx, dto.recipientRoleCode);
      else if (dto.recipientRoleCode)
        throw new BadRequestException(
          'recipientRoleCode is only used with ROLE',
        );
      const twin = await tx.escalationRule.findFirst({
        where: { alertType: dto.alertType, level: dto.level, active: true },
      });
      if (twin)
        throw new ConflictException(
          `${twin.code} already is level ${dto.level} for ${dto.alertType}`,
        );
      const r = await tx.escalationRule.create({
        data: {
          code: dto.code,
          alertType: dto.alertType,
          minSeverity: dto.minSeverity,
          level: dto.level,
          afterMinutes: dto.afterMinutes,
          recipientKind: dto.recipientKind,
          recipientRoleCode:
            dto.recipientKind === 'ROLE' ? dto.recipientRoleCode : null,
          channels: [...new Set(dto.channels)],
          critical: dto.critical ?? false,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ESCALATION_RULE_CREATED,
          entityType: 'EscalationRule',
          entityId: r.id,
          metadata: escView(r) as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return r;
    });
    return escView(created);
  }

  async updateEscalation(
    id: string,
    dto: UpdateEscalationRuleDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.escalationRule.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Escalation rule not found');
      if (dto.recipientRoleCode !== undefined) {
        if (cur.recipientKind !== 'ROLE')
          throw new BadRequestException(
            'recipientRoleCode is only used with ROLE rules',
          );
        await this.assertRole(tx, dto.recipientRoleCode);
      }
      if (dto.active === true && !cur.active) {
        const twin = await tx.escalationRule.findFirst({
          where: {
            alertType: cur.alertType,
            level: cur.level,
            active: true,
            id: { not: id },
          },
        });
        if (twin)
          throw new ConflictException(
            `${twin.code} already is level ${cur.level} for ${cur.alertType}`,
          );
      }
      const data: Prisma.EscalationRuleUpdateInput = {};
      if (dto.afterMinutes !== undefined) data.afterMinutes = dto.afterMinutes;
      if (dto.minSeverity !== undefined) data.minSeverity = dto.minSeverity;
      if (dto.recipientRoleCode !== undefined)
        data.recipientRoleCode = dto.recipientRoleCode;
      if (dto.channels) data.channels = [...new Set(dto.channels)];
      if (dto.critical !== undefined) data.critical = dto.critical;
      if (dto.active !== undefined) data.active = dto.active;
      if (Object.keys(data).length === 0)
        throw new BadRequestException('Nothing to update');
      const r = await tx.escalationRule.update({ where: { id }, data });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.ESCALATION_RULE_UPDATED,
          entityType: 'EscalationRule',
          entityId: id,
          metadata: {
            code: cur.code,
            before: escView(cur),
            after: escView(r),
          } as unknown as Record<string, unknown>,
          meta,
        },
        tx,
      );
      return r;
    });
    return escView(updated);
  }

  // ───────────────────────── alerts (read) ─────────────────────────

  async listAlerts(q: {
    status?: string;
    type?: string;
    severity?: string;
    page: number;
    pageSize: number;
    skip: number;
  }) {
    const where: Prisma.OperationalAlertWhereInput = {
      ...(q.status && { status: q.status as never }),
      ...(q.type && { type: q.type }),
      ...(q.severity && { severity: q.severity as never }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.operationalAlert.findMany({
        where,
        orderBy: [{ firstDetectedAt: 'desc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.operationalAlert.count({ where }),
    ]);
    return {
      data: rows.map((a) => ({
        id: a.id,
        type: a.type,
        entityType: a.entityType,
        entityId: a.entityId,
        status: a.status,
        severity: a.severity,
        reference: a.reference,
        title: a.title,
        reason: a.reason,
        department: a.department,
        firstDetectedAt: a.firstDetectedAt,
        lastDetectedAt: a.lastDetectedAt,
        resolvedAt: a.resolvedAt,
        lastNotifiedAt: a.lastNotifiedAt,
        lastNotifiedSeverity: a.lastNotifiedSeverity,
        escalationLevel: a.escalationLevel,
      })),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  async getAlert(id: string) {
    const a = await this.prisma.operationalAlert.findUnique({
      where: { id },
      include: {
        notifications: {
          select: {
            id: true,
            type: true,
            channel: true,
            status: true,
            severity: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!a) throw new NotFoundException('Alert not found');
    return a;
  }
}
