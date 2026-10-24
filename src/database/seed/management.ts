import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Default management configuration (create-if-missing, never overwritten once an admin edits it).
 * Only one starting SLA is seeded: a ready shipment should reach the customer within 3 days unless
 * it carries its own scheduled date. Stage, job and order SLAs stay unset until the business sets them;
 * stage deadlines then fall back to each stage's expected duration.
 */
export async function seedManagement(prisma: PrismaClient): Promise<void> {
  const exists = await prisma.slaRule.findUnique({
    where: { code: 'SHIPMENT_DEFAULT' },
  });
  if (exists) return;
  const active = await prisma.slaRule.findFirst({
    where: { targetType: 'SHIPMENT', active: true, stageDefinitionId: null },
  });
  await prisma.slaRule.create({
    data: {
      code: 'SHIPMENT_DEFAULT',
      name: 'Shipment: ready to delivered within 72 hours',
      targetType: 'SHIPMENT',
      thresholdMinutes: 72 * 60,
      warningBeforeMinutes: 12 * 60,
      active: !active,
    },
  });
}

/**
 * Default working calendar: open around the clock every day, in the business time zone. That is the same as
 * calendar time, so nothing changes until the factory enters its real hours (`PUT /admin/working-calendars/:id/weekly`).
 * Create-if-missing: an edited calendar is never touched.
 */
export async function seedCalendar(prisma: PrismaClient): Promise<void> {
  if (
    await prisma.workingCalendar.findUnique({
      where: { code: 'FACTORY_DEFAULT' },
    })
  )
    return;
  const hasDefault = await prisma.workingCalendar.count({
    where: { isDefault: true },
  });
  await prisma.workingCalendar.create({
    data: {
      code: 'FACTORY_DEFAULT',
      name: 'Factory working calendar',
      timezone: process.env.BUSINESS_TIMEZONE || 'UTC',
      isDefault: hasDefault === 0,
      days: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          isWorkingDay: true,
          startMinute: 0,
          endMinute: 1440,
        })),
      },
    },
  });
}
