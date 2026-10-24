import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { NotificationTemplate } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  ListTemplatesQueryDto,
  PublishTemplateDto,
} from './dto/notification.dto.js';
import {
  MAX_BODY,
  MAX_SUBJECT,
  TEMPLATE_VARIABLES,
  checkTemplate,
} from './template-renderer.js';

const view = (t: NotificationTemplate) => ({
  id: t.id,
  code: t.code,
  channel: t.channel,
  locale: t.locale,
  version: t.version,
  subject: t.subject,
  bodyTemplate: t.bodyTemplate,
  active: t.active,
  createdAt: t.createdAt,
});

/** Versioned message text. Published versions never change; a new version replaces the active one. */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  variables() {
    return {
      variables: [...TEMPLATE_VARIABLES],
      note: 'Only {{variableName}} placeholders from this list are allowed.',
    };
  }

  async list(q: ListTemplatesQueryDto) {
    const rows = await this.prisma.notificationTemplate.findMany({
      where: {
        code: q.code,
        channel: q.channel,
        locale: q.locale,
        active: q.activeOnly ? true : undefined,
      },
      orderBy: [
        { code: 'asc' },
        { channel: 'asc' },
        { locale: 'asc' },
        { version: 'desc' },
      ],
    });
    return rows.map(view);
  }

  async get(id: string) {
    const t = await this.prisma.notificationTemplate.findUnique({
      where: { id },
    });
    if (!t) throw new NotFoundException('Template not found');
    return view(t);
  }

  async publish(dto: PublishTemplateDto, actor: AuthUser, meta: RequestMeta) {
    if (dto.channel !== 'WHATSAPP' && !dto.subject?.trim())
      throw new BadRequestException(`${dto.channel} templates need a subject`);
    const errors = [
      ...(dto.subject
        ? checkTemplate(dto.subject, MAX_SUBJECT).errors.map(
            (e) => `subject: ${e}`,
          )
        : []),
      ...checkTemplate(dto.bodyTemplate, MAX_BODY).errors.map(
        (e) => `body: ${e}`,
      ),
    ];
    if (errors.length) throw new BadRequestException(errors);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`template:${dto.code}:${dto.channel}:${dto.locale}`}))`;
      const known = await tx.notificationTemplate.findFirst({
        where: { code: dto.code },
      });
      if (!known)
        throw new BadRequestException(
          `Unknown template code ${dto.code}; templates are versions of the seeded codes`,
        );
      const latest = await tx.notificationTemplate.aggregate({
        where: { code: dto.code, channel: dto.channel, locale: dto.locale },
        _max: { version: true },
      });
      await tx.notificationTemplate.updateMany({
        where: {
          code: dto.code,
          channel: dto.channel,
          locale: dto.locale,
          active: true,
        },
        data: { active: false },
      });
      const t = await tx.notificationTemplate.create({
        data: {
          code: dto.code,
          channel: dto.channel,
          locale: dto.locale,
          version: (latest._max.version ?? 0) + 1,
          subject: dto.channel === 'WHATSAPP' ? null : dto.subject!.trim(),
          bodyTemplate: dto.bodyTemplate,
          active: true,
          createdByUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.NOTIFICATION_TEMPLATE_PUBLISHED,
          entityType: 'NotificationTemplate',
          entityId: t.id,
          metadata: {
            code: t.code,
            channel: t.channel,
            locale: t.locale,
            version: t.version,
          },
          meta,
        },
        tx,
      );
      return t;
    });
    return view(created);
  }

  /** Make an older version the active one again (rollback) or switch a version on. */
  async activate(id: string, actor: AuthUser, meta: RequestMeta) {
    const t = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.notificationTemplate.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Template not found');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`template:${cur.code}:${cur.channel}:${cur.locale}`}))`;
      if (cur.active)
        throw new ConflictException('This version is already active');
      await tx.notificationTemplate.updateMany({
        where: {
          code: cur.code,
          channel: cur.channel,
          locale: cur.locale,
          active: true,
        },
        data: { active: false },
      });
      const next = await tx.notificationTemplate.update({
        where: { id },
        data: { active: true },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.NOTIFICATION_TEMPLATE_ACTIVATED,
          entityType: 'NotificationTemplate',
          entityId: id,
          metadata: {
            code: cur.code,
            channel: cur.channel,
            locale: cur.locale,
            version: cur.version,
          },
          meta,
        },
        tx,
      );
      return next;
    });
    return view(t);
  }

  async deactivate(id: string, actor: AuthUser, meta: RequestMeta) {
    const t = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.notificationTemplate.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Template not found');
      if (!cur.active)
        throw new ConflictException('This version is not active');
      const next = await tx.notificationTemplate.update({
        where: { id },
        data: { active: false },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.NOTIFICATION_TEMPLATE_DEACTIVATED,
          entityType: 'NotificationTemplate',
          entityId: id,
          metadata: {
            code: cur.code,
            channel: cur.channel,
            locale: cur.locale,
            version: cur.version,
            note: 'messages using this template are skipped until another version is active',
          },
          meta,
        },
        tx,
      );
      return next;
    });
    return view(t);
  }
}
