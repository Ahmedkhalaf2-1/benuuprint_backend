import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  SetCustomerPreferencesDto,
  SetMyPreferencesDto,
} from './dto/notification.dto.js';
import {
  NOTIFICATION_CATEGORIES,
  OPTIONAL_CUSTOMER_CATEGORIES,
} from './events.js';

@Injectable()
export class PreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertLocale(locale: string) {
    const any = await this.prisma.notificationTemplate.findFirst({
      where: { locale, active: true },
      select: { id: true },
    });
    if (!any)
      throw new BadRequestException(
        `No notification templates exist for locale ${locale}`,
      );
  }

  // ───────────────────────── staff ─────────────────────────

  async mine(userId: string) {
    const [user, rows] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { notificationLocale: true },
      }),
      this.prisma.userNotificationPreference.findMany({ where: { userId } }),
    ]);
    return {
      locale: user.notificationLocale,
      categories: NOTIFICATION_CATEGORIES.map((category) => {
        const r = rows.find((x) => x.category === category);
        return {
          category,
          inApp: r?.inApp ?? true,
          email: r?.email ?? true,
          whatsapp: r?.whatsapp ?? false,
        };
      }),
      note: 'Critical notifications (failed deliveries, commercial re-approval, escalations to ADMIN) ignore these preferences.',
    };
  }

  async setMine(userId: string, dto: SetMyPreferencesDto) {
    if (dto.locale) await this.assertLocale(dto.locale);
    await this.prisma.$transaction(async (tx) => {
      if (dto.locale)
        await tx.user.update({
          where: { id: userId },
          data: { notificationLocale: dto.locale },
        });
      for (const c of dto.categories ?? []) {
        const data = { inApp: c.inApp, email: c.email, whatsapp: c.whatsapp };
        await tx.userNotificationPreference.upsert({
          where: { userId_category: { userId, category: c.category } },
          create: {
            userId,
            category: c.category,
            ...Object.fromEntries(
              Object.entries(data).filter(([, v]) => v !== undefined),
            ),
          },
          update: Object.fromEntries(
            Object.entries(data).filter(([, v]) => v !== undefined),
          ),
        });
      }
    });
    return this.mine(userId);
  }

  // ───────────────────────── customers (recorded by staff until a portal exists) ─────────────────────────

  async forCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { preferredLocale: true, notificationPreferences: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return {
      preferredLocale: customer.preferredLocale,
      categories: NOTIFICATION_CATEGORIES.map((category) => {
        const r = customer.notificationPreferences.find(
          (x) => x.category === category,
        );
        return {
          category,
          optional: OPTIONAL_CUSTOMER_CATEGORIES.includes(category),
          email: r?.email ?? true,
          whatsapp: r?.whatsapp ?? true,
        };
      }),
      note: 'Only optional categories can be switched off; document, payment and delivery messages are transactional.',
    };
  }

  async setForCustomer(
    customerId: string,
    dto: SetCustomerPreferencesDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    for (const c of dto.categories ?? []) {
      if (
        !OPTIONAL_CUSTOMER_CATEGORIES.includes(c.category as never) &&
        (!c.email || !c.whatsapp)
      )
        throw new BadRequestException(
          `${c.category} is a transactional category and cannot be switched off`,
        );
    }
    if (dto.preferredLocale) await this.assertLocale(dto.preferredLocale);
    await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
      if (dto.preferredLocale)
        await tx.customer.update({
          where: { id: customerId },
          data: { preferredLocale: dto.preferredLocale },
        });
      for (const c of dto.categories ?? [])
        await tx.customerNotificationPreference.upsert({
          where: { customerId_category: { customerId, category: c.category } },
          create: {
            customerId,
            category: c.category,
            email: c.email,
            whatsapp: c.whatsapp,
          },
          update: { email: c.email, whatsapp: c.whatsapp },
        });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.CUSTOMER_NOTIFICATION_PREFERENCE_CHANGED,
          entityType: 'Customer',
          entityId: customerId,
          metadata: {
            preferredLocale: dto.preferredLocale,
            categories: dto.categories,
          },
          meta,
        },
        tx,
      );
    });
    return this.forCustomer(customerId);
  }
}
