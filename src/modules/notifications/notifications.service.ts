import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { paginated } from '../../common/types/paginated.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Notification, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ManagementContext } from '../management/management-context.service.js';
import { DAY_KEY, dayBounds } from '../management/pure/business-time.js';
import type {
  ListMyNotificationsQueryDto,
  ListNotificationsQueryDto,
} from './dto/notification.dto.js';
import { EmailProvider, WhatsAppProvider } from './providers/provider.ports.js';

const mask = (a: string | null) =>
  !a
    ? null
    : a.includes('@')
      ? `${a.slice(0, 2)}***@${a.split('@')[1]}`
      : `${a.slice(0, 3)}***${a.slice(-2)}`;

const mine = (n: Notification) => ({
  id: n.id,
  type: n.type,
  severity: n.severity,
  title: n.title,
  body: n.body,
  entityType: n.entityType,
  entityId: n.entityId,
  read: n.readAt !== null,
  readAt: n.readAt,
  createdAt: n.createdAt,
});

const admin = (n: Notification, withBody = false) => ({
  id: n.id,
  type: n.type,
  severity: n.severity,
  recipientKind: n.recipientKind,
  recipientUserId: n.recipientUserId,
  customerId: n.customerId,
  channel: n.channel,
  /** Masked: the destination is never shown in full outside the delivery worker. */
  recipientAddress: mask(n.recipientAddress),
  locale: n.locale,
  templateCode: n.templateCode,
  templateVersion: n.templateVersion,
  title: n.title,
  ...(withBody && { body: n.body }),
  entityType: n.entityType,
  entityId: n.entityId,
  status: n.status,
  critical: n.critical,
  scheduledAt: n.scheduledAt,
  nextAttemptAt: n.nextAttemptAt,
  attempts: n.attempts,
  sentAt: n.sentAt,
  readAt: n.readAt,
  failedAt: n.failedAt,
  failureReason: n.failureReason,
  providerMessageId: n.providerMessageId,
  outboxEventId: n.outboxEventId,
  alertId: n.alertId,
  createdAt: n.createdAt,
});

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ctx: ManagementContext,
    private readonly email: EmailProvider,
    private readonly whatsapp: WhatsAppProvider,
  ) {}

  // ───────────────────────── staff inbox ─────────────────────────

  async listMine(userId: string, q: ListMyNotificationsQueryDto) {
    const where: Prisma.NotificationWhereInput = {
      recipientUserId: userId,
      channel: 'IN_APP',
      ...(q.unread ? { readAt: null } : {}),
      ...(q.severity && { severity: q.severity }),
      ...(q.type && { type: q.type }),
    };
    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: { recipientUserId: userId, channel: 'IN_APP', readAt: null },
      }),
    ]);
    return {
      ...paginated(rows.map(mine), q.page, q.pageSize, total),
      unreadCount: unread,
    };
  }

  async unreadCount(userId: string) {
    return {
      unreadCount: await this.prisma.notification.count({
        where: { recipientUserId: userId, channel: 'IN_APP', readAt: null },
      }),
    };
  }

  async markRead(userId: string, id: string) {
    const n = await this.prisma.notification.findFirst({
      where: { id, recipientUserId: userId, channel: 'IN_APP' },
    });
    if (!n) throw new NotFoundException('Notification not found'); // someone else's notification looks the same
    if (!n.readAt)
      await this.prisma.notification.update({
        where: { id },
        data: { readAt: this.ctx.now() },
      });
    return mine({ ...n, readAt: n.readAt ?? this.ctx.now() });
  }

  async readAll(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { recipientUserId: userId, channel: 'IN_APP', readAt: null },
      data: { readAt: this.ctx.now() },
    });
    return { marked: count };
  }

  // ───────────────────────── admin ─────────────────────────

  async list(q: ListNotificationsQueryDto) {
    const tz = this.ctx.timezone;
    const bound = (v: string, kind: 'from' | 'to') => {
      if (DAY_KEY.test(v)) {
        const { start, end } = dayBounds(v, tz);
        return kind === 'from' ? start : end;
      }
      const d = new Date(v);
      if (Number.isNaN(d.getTime()))
        throw new BadRequestException(`${kind} is not a valid date`);
      return d;
    };
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = bound(q.from, 'from');
    if (q.to) createdAt.lt = bound(q.to, 'to');
    const where: Prisma.NotificationWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.channel && { channel: q.channel }),
      ...(q.type && { type: q.type }),
      ...(q.recipientKind && { recipientKind: q.recipientKind }),
      ...(Object.keys(createdAt).length && { createdAt }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return paginated(
      rows.map((n) => admin(n)),
      q.page,
      q.pageSize,
      total,
    );
  }

  async get(id: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new NotFoundException('Notification not found');
    return admin(n, true);
  }

  async retry(id: string, actor: AuthUser, meta: RequestMeta) {
    const n = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.notification.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Notification not found');
      if (cur.status !== 'FAILED')
        throw new ConflictException(
          `Only FAILED notifications can be retried (this one is ${cur.status})`,
        );
      const next = await tx.notification.update({
        where: { id },
        data: {
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: this.ctx.now(),
          failedAt: null,
          failureReason: null,
          lockedAt: null,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.NOTIFICATION_RETRIED,
          entityType: 'Notification',
          entityId: id,
          metadata: { type: cur.type, channel: cur.channel },
          meta,
        },
        tx,
      );
      return next;
    });
    return admin(n);
  }

  async cancel(id: string, actor: AuthUser, meta: RequestMeta) {
    const n = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.notification.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Notification not found');
      if (!['PENDING', 'FAILED'].includes(cur.status))
        throw new ConflictException(
          `A ${cur.status} notification cannot be cancelled`,
        );
      const next = await tx.notification.update({
        where: { id },
        data: { status: 'CANCELLED', lockedAt: null },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.NOTIFICATION_CANCELLED,
          entityType: 'Notification',
          entityId: id,
          metadata: { type: cur.type, channel: cur.channel, was: cur.status },
          meta,
        },
        tx,
      );
      return next;
    });
    return admin(n);
  }

  /** Operational health: queue depth, failures, open alerts, scheduler heartbeat. Admin only. */
  async summary() {
    const now = this.ctx.now();
    const [outbox, oldest, notes, sent24, alerts, runs] = await Promise.all([
      this.prisma.outboxEvent.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.outboxEvent.findFirst({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true, eventType: true },
      }),
      this.prisma.notification.groupBy({
        by: ['status'],
        where: { channel: { not: 'IN_APP' } },
        _count: { _all: true },
      }),
      this.prisma.notification.count({
        where: {
          status: 'SENT',
          sentAt: { gte: new Date(now.getTime() - 86_400_000) },
        },
      }),
      this.prisma.operationalAlert.groupBy({
        by: ['severity'],
        where: { status: 'OPEN' },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<
        {
          task: string;
          status: string;
          started_at: Date;
          finished_at: Date | null;
          error: string | null;
        }[]
      >`
        SELECT DISTINCT ON (task) task, status, started_at, finished_at, error
        FROM scheduler_runs WHERE task NOT LIKE '%:run' ORDER BY task, started_at DESC`,
    ]);
    const o = (s: string) =>
      outbox.find((x) => x.status === s)?._count._all ?? 0;
    const n = (s: string) =>
      notes.find((x) => x.status === s)?._count._all ?? 0;
    return {
      generatedAt: now,
      outbox: {
        pending: o('PENDING'),
        processing: o('PROCESSING'),
        failed: o('FAILED'),
        oldestUnprocessedAt: oldest?.occurredAt ?? null,
        oldestUnprocessedAgeSeconds: oldest
          ? Math.max(
              0,
              Math.round((now.getTime() - oldest.occurredAt.getTime()) / 1000),
            )
          : 0,
      },
      externalNotifications: {
        pending: n('PENDING'),
        processing: n('PROCESSING'),
        failed: n('FAILED'),
        cancelled: n('CANCELLED'),
        sentLast24h: sent24,
      },
      openAlerts: {
        total: alerts.reduce((s, a) => s + a._count._all, 0),
        bySeverity: Object.fromEntries(
          alerts.map((a) => [a.severity, a._count._all]),
        ),
      },
      scheduler: runs.map((r) => ({
        task: r.task,
        lastStatus: r.status,
        lastStartedAt: r.started_at,
        lastFinishedAt: r.finished_at,
        lastError: r.error,
      })),
      providers: {
        email: { name: this.email.name, enabled: this.email.enabled },
        whatsapp: { name: this.whatsapp.name, enabled: this.whatsapp.enabled },
      },
    };
  }
}
