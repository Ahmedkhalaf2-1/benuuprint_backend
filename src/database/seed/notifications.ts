import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  DEFAULT_AUTOMATION_RULES,
  DEFAULT_ESCALATION_RULES,
} from '../../modules/notifications/default-rules.js';
import {
  TEMPLATE_CATALOG,
  TEMPLATE_LOCALES,
} from '../../modules/notifications/template-catalog.js';

const CHANNELS = ['IN_APP', 'EMAIL', 'WHATSAPP'] as const;

/**
 * Default templates (English + Arabic), automation rules and escalation rules. Create-if-missing:
 * a published newer version, an edited rule or a deactivated rule is never touched by a re-run.
 */
export async function seedNotifications(prisma: PrismaClient): Promise<void> {
  for (const entry of TEMPLATE_CATALOG) {
    for (const locale of TEMPLATE_LOCALES) {
      for (const channel of CHANNELS) {
        const any = await prisma.notificationTemplate.findFirst({
          where: { code: entry.code, channel, locale },
        });
        if (any) continue;
        const text = entry[locale];
        await prisma.notificationTemplate.create({
          data: {
            code: entry.code,
            channel,
            locale,
            version: 1,
            subject: channel === 'WHATSAPP' ? null : text.title,
            bodyTemplate:
              channel === 'WHATSAPP'
                ? `${text.title}\n${text.body}`
                : text.body,
            active: true,
          },
        });
      }
    }
  }
  const have = new Set(
    (await prisma.automationRule.findMany({ select: { code: true } })).map(
      (r) => r.code,
    ),
  );
  const rules = DEFAULT_AUTOMATION_RULES.filter((r) => !have.has(r.code));
  if (rules.length)
    await prisma.automationRule.createMany({
      data: rules.map((r) => ({
        code: r.code,
        eventType: r.eventType,
        alertType: r.alertType,
        minSeverity: r.minSeverity,
        audience: r.audience,
        audienceValue: r.audienceValue,
        channels: r.channels,
        templateCode: r.templateCode,
        severity: r.severity ?? 'INFO',
        critical: r.critical ?? false,
      })),
    });
  const haveEsc = new Set(
    (await prisma.escalationRule.findMany({ select: { code: true } })).map(
      (r) => r.code,
    ),
  );
  const esc = DEFAULT_ESCALATION_RULES.filter((r) => !haveEsc.has(r.code));
  if (esc.length)
    await prisma.escalationRule.createMany({
      data: esc.map((r) => ({
        code: r.code,
        alertType: r.alertType,
        level: r.level,
        afterMinutes: r.afterMinutes,
        recipientKind: r.recipientKind,
        recipientRoleCode: r.recipientRoleCode,
        channels: r.channels,
        critical: r.critical ?? false,
      })),
    });
}
