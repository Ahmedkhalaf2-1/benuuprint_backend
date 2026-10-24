import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { seed } from '../src/database/seed/seed.js';
import { createTestApp } from './support/app.js';
import { TEST_SUPER_ADMIN } from './support/env.js';

describe('Seed (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  const counts = async () => ({
    permissions: await prisma.permission.count(),
    roles: await prisma.role.count({ where: { isSystem: true } }),
    rolePermissions: await prisma.rolePermission.count({
      where: { role: { isSystem: true } },
    }),
    admins: await prisma.user.count({
      where: { email: TEST_SUPER_ADMIN.email },
    }),
  });

  it('is idempotent: running twice creates no duplicates and keeps the admin untouched', async () => {
    const before = await counts();
    const hashBefore = (
      await prisma.user.findUniqueOrThrow({
        where: { email: TEST_SUPER_ADMIN.email },
      })
    ).passwordHash;
    const result = await seed(prisma, {
      superAdmin: { ...TEST_SUPER_ADMIN, password: 'Different-Passw0rd-1' },
    });
    await seed(prisma, { superAdmin: TEST_SUPER_ADMIN });
    expect(await counts()).toEqual(before);
    expect(result.rolesCreated).toEqual([]);
    expect(result.superAdminCreated).toBe(false);
    const hashAfter = (
      await prisma.user.findUniqueOrThrow({
        where: { email: TEST_SUPER_ADMIN.email },
      })
    ).passwordHash;
    expect(hashAfter).toBe(hashBefore);
  });

  it('refuses a weak seed password and skips without credentials', async () => {
    await expect(
      seed(prisma, {
        superAdmin: { email: 'weak@test.benue.local', password: 'weak' },
      }),
    ).rejects.toThrow(/rejected/);
    const res = await seed(prisma, {});
    expect(res.superAdminCreated).toBe(false);
  });

  describe('Phase 2 master data and grant batches', () => {
    const roleHas = async (roleCode: string, permCode: string) =>
      (await prisma.rolePermission.count({
        where: { role: { code: roleCode }, permission: { code: permCode } },
      })) === 1;

    it('seeds master data once and never duplicates or overwrites admin edits', async () => {
      const counts = async () => ({
        productTypes: await prisma.productType.count(),
        fabrics: await prisma.fabric.count(),
        printMethods: await prisma.printMethod.count(),
        accessories: await prisma.accessory.count(),
        components: await prisma.componentOption.count(),
        sizes: await prisma.sizeOption.count(),
        compat: await prisma.productTypeFabric.count(),
        scales: await prisma.sizeScale.count({ where: { code: 'STANDARD' } }),
        refs: await prisma.fabric.count({
          where: { referenceNumber: { startsWith: 'FAB-' } },
        }),
      });
      const before = await counts();
      expect(before.productTypes).toBeGreaterThanOrEqual(13);
      expect(before.fabrics).toBeGreaterThanOrEqual(13);
      expect(before.scales).toBe(1);

      const milton = await prisma.fabric.findUniqueOrThrow({
        where: { code: 'MILTON' },
      });
      await prisma.fabric.update({
        where: { id: milton.id },
        data: { name: 'Milton (edited)', description: 'curated by admin' },
      });
      await prisma.printMethod.update({
        where: { code: 'DTF' },
        data: { setupFee: 123.45 },
      });

      await seed(prisma, {});
      await seed(prisma, {});

      expect(await counts()).toEqual(before);
      const after = await prisma.fabric.findUniqueOrThrow({
        where: { code: 'MILTON' },
      });
      expect(after).toMatchObject({
        name: 'Milton (edited)',
        description: 'curated by admin',
        referenceNumber: milton.referenceNumber,
      });
      expect(
        (
          await prisma.printMethod.findUniqueOrThrow({ where: { code: 'DTF' } })
        ).setupFee?.toString(),
      ).toBe('123.45');

      await prisma.fabric.update({
        where: { id: milton.id },
        data: { name: 'Milton', description: null },
      });
      await prisma.printMethod.update({
        where: { code: 'DTF' },
        data: { setupFee: null },
      });
    });

    it('does not re-grant default permissions an admin removed once the batch was applied', async () => {
      const sales = await prisma.role.findUniqueOrThrow({
        where: { code: 'SALES' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'master_data.read' },
      });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: sales.id, permissionId: perm.id },
        },
      });
      try {
        await seed(prisma, {});
        expect(await roleHas('SALES', 'master_data.read')).toBe(false);
      } finally {
        await prisma.rolePermission.create({
          data: { roleId: sales.id, permissionId: perm.id },
        });
      }
    });

    it('delivers a new batch to existing roles exactly once (upgrade path)', async () => {
      const adminRole = await prisma.role.findUniqueOrThrow({
        where: { code: 'ADMIN' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'assets.manage' },
      });
      // Simulate a Phase 1 database: batch not recorded, Phase 2 permission absent.
      await prisma.seedGrantBatch.delete({
        where: { key: 'phase2-master-data' },
      });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id },
        },
      });

      await seed(prisma, {});
      expect(await roleHas('ADMIN', 'assets.manage')).toBe(true);
      expect(
        await prisma.seedGrantBatch.count({
          where: { key: 'phase2-master-data' },
        }),
      ).toBe(1);
      expect(await roleHas('DELIVERY', 'master_data.read')).toBe(false); // least privilege kept
      expect(await roleHas('ADMIN', 'roles.manage')).toBe(false);
      expect(await roleHas('SUPER_ADMIN', 'patterns.manage')).toBe(true);
    });

    it('keeps SUPER_ADMIN on every permission, including new ones', async () => {
      const [all, held] = await Promise.all([
        prisma.permission.count(),
        prisma.rolePermission.count({
          where: { role: { code: 'SUPER_ADMIN' } },
        }),
      ]);
      expect(held).toBe(all);
    });
  });

  describe('Phase 3 grants and sample terms', () => {
    const roleHas = async (roleCode: string, permCode: string) =>
      (await prisma.rolePermission.count({
        where: { role: { code: roleCode }, permission: { code: permCode } },
      })) === 1;

    it('delivers the Phase 3 batch to existing roles once and keeps least privilege', async () => {
      const admin = await prisma.role.findUniqueOrThrow({
        where: { code: 'ADMIN' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'terms.manage' },
      });
      await prisma.seedGrantBatch.delete({ where: { key: 'phase3-samples' } });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: admin.id, permissionId: perm.id },
        },
      });
      await seed(prisma, {});
      expect(await roleHas('ADMIN', 'terms.manage')).toBe(true);
      expect(
        await prisma.seedGrantBatch.count({ where: { key: 'phase3-samples' } }),
      ).toBe(1);
      expect(await roleHas('SEWING', 'samples.read')).toBe(false);
      expect(await roleHas('FINANCE', 'payments.verify')).toBe(true);
      expect(await roleHas('SALES', 'payments.verify')).toBe(false);
      expect(await roleHas('SUPER_ADMIN', 'approvals.manage')).toBe(true);
    });

    it('seeds one placeholder SAMPLE_TERMS v1, idempotently, never stealing an admin-activated version', async () => {
      const count = () =>
        prisma.termsVersion.count({ where: { code: 'SAMPLE_TERMS' } });
      const before = await count();
      await seed(prisma, {});
      await seed(prisma, {});
      expect(await count()).toBe(before);
      const v1 = await prisma.termsVersion.findUniqueOrThrow({
        where: { code_version: { code: 'SAMPLE_TERMS', version: 1 } },
      });
      expect(v1.title).toMatch(/placeholder/i);
      expect(v1.content).toMatch(/PLACEHOLDER/);
      expect(
        await prisma.termsVersion.count({
          where: { code: 'SAMPLE_TERMS', isActive: true },
        }),
      ).toBe(1);

      const latest = await prisma.termsVersion.aggregate({
        where: { code: 'SAMPLE_TERMS' },
        _max: { version: true },
      });
      const v2 = await prisma.termsVersion.create({
        data: {
          code: 'SAMPLE_TERMS',
          version: (latest._max.version ?? 1) + 1,
          title: 'Real terms',
          content: 'Approved legal text',
          isActive: false,
        },
      });
      await prisma.termsVersion.updateMany({
        where: { code: 'SAMPLE_TERMS', isActive: true },
        data: { isActive: false },
      });
      await prisma.termsVersion.update({
        where: { id: v2.id },
        data: { isActive: true },
      });
      await seed(prisma, {});
      expect(
        (await prisma.termsVersion.findUniqueOrThrow({ where: { id: v2.id } }))
          .isActive,
      ).toBe(true);
      expect(
        await prisma.termsVersion.count({
          where: { code: 'SAMPLE_TERMS', isActive: true },
        }),
      ).toBe(1);
      // restore for the rest of the suite
      await prisma.termsVersion.update({
        where: { id: v2.id },
        data: { isActive: false },
      });
      await prisma.termsVersion.update({
        where: { id: v1.id },
        data: { isActive: true },
      });
    });
  });
  describe('Phase 4 factory configuration', () => {
    const factoryCounts = async () => ({
      definitions: await prisma.productionStageDefinition.count(),
      templates: await prisma.workflowTemplate.count(),
      versions: await prisma.workflowTemplateVersion.count(),
      templateStages: await prisma.workflowTemplateStage.count(),
      deps: await prisma.workflowTemplateStageDependency.count(),
      qcTemplates: await prisma.qcTemplate.count(),
      qcItems: await prisma.qcChecklistItemDefinition.count(),
    });

    it('seeds the default workflow and QC checklists idempotently', async () => {
      const before = await factoryCounts();
      await seed(prisma, {});
      await seed(prisma, {});
      expect(await factoryCounts()).toEqual(before);
      const t = await prisma.workflowTemplate.findUniqueOrThrow({
        where: { code: 'BENUE_STANDARD_APPAREL' },
        include: { versions: true },
      });
      expect(t.isDefault).toBe(true);
      expect(t.versions.filter((v) => v.status === 'ACTIVE')).toHaveLength(1);
      expect(
        await prisma.productionStageDefinition.count({
          where: { isQcStage: true },
        }),
      ).toBeGreaterThanOrEqual(3);
    });

    it('never overwrites an admin edit of a stage definition', async () => {
      await prisma.productionStageDefinition.update({
        where: { code: 'CUTTING' },
        data: { expectedDurationMinutes: 777 },
      });
      await seed(prisma, {});
      expect(
        (
          await prisma.productionStageDefinition.findUniqueOrThrow({
            where: { code: 'CUTTING' },
          })
        ).expectedDurationMinutes,
      ).toBe(777);
      await prisma.productionStageDefinition.update({
        where: { code: 'CUTTING' },
        data: { expectedDurationMinutes: 480 },
      });
    });

    it('delivers the Phase 4 grant batch once and keeps least privilege', async () => {
      const roleHas = async (roleCode: string, permCode: string) =>
        (await prisma.rolePermission.count({
          where: { role: { code: roleCode }, permission: { code: permCode } },
        })) === 1;
      const admin = await prisma.role.findUniqueOrThrow({
        where: { code: 'ADMIN' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'factory_jobs.manage' },
      });
      await prisma.seedGrantBatch.delete({ where: { key: 'phase4-factory' } });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: admin.id, permissionId: perm.id },
        },
      });
      await seed(prisma, {});
      expect(await roleHas('ADMIN', 'factory_jobs.manage')).toBe(true);
      expect(
        await prisma.seedGrantBatch.count({ where: { key: 'phase4-factory' } }),
      ).toBe(1);
      expect(await roleHas('SEWING', 'stages.override')).toBe(false);
      expect(await roleHas('SALES', 'factory_jobs.manage')).toBe(false);
      expect(await roleHas('QC', 'qc.manage')).toBe(false);
      expect(await roleHas('SUPER_ADMIN', 'rework.manage')).toBe(true);
    });
  });
  describe('Phase 5A grants', () => {
    it('delivers the Phase 5A batch once and keeps least privilege', async () => {
      const roleHas = async (roleCode: string, permCode: string) =>
        (await prisma.rolePermission.count({
          where: { role: { code: roleCode }, permission: { code: permCode } },
        })) === 1;
      const sales = await prisma.role.findUniqueOrThrow({
        where: { code: 'SALES' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'orders.confirm' },
      });
      await prisma.seedGrantBatch.delete({ where: { key: 'phase5a-orders' } });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: sales.id, permissionId: perm.id },
        },
      });
      await seed(prisma, {});
      await seed(prisma, {});
      expect(await roleHas('SALES', 'orders.confirm')).toBe(true);
      expect(
        await prisma.seedGrantBatch.count({ where: { key: 'phase5a-orders' } }),
      ).toBe(1);
      expect(await roleHas('SALES', 'orders.cancel')).toBe(false);
      expect(await roleHas('FINANCE', 'orders.manage')).toBe(false);
      expect(await roleHas('CUTTING', 'production_quantity.report')).toBe(true);
      expect(await roleHas('SEWING', 'orders.read')).toBe(false);
      expect(await roleHas('SUPER_ADMIN', 'order_batches.manage')).toBe(true);
    });
  });
  describe('Phase 5B grants', () => {
    it('delivers the Phase 5B batch once and keeps least privilege', async () => {
      const roleHas = async (roleCode: string, permCode: string) =>
        (await prisma.rolePermission.count({
          where: { role: { code: roleCode }, permission: { code: permCode } },
        })) === 1;
      const delivery = await prisma.role.findUniqueOrThrow({
        where: { code: 'DELIVERY' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'shipments.complete' },
      });
      await prisma.seedGrantBatch.delete({
        where: { key: 'phase5b-fulfillment' },
      });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: delivery.id, permissionId: perm.id },
        },
      });
      await seed(prisma, {});
      await seed(prisma, {});
      expect(await roleHas('DELIVERY', 'shipments.complete')).toBe(true);
      expect(
        await prisma.seedGrantBatch.count({
          where: { key: 'phase5b-fulfillment' },
        }),
      ).toBe(1);
      expect(await roleHas('DELIVERY', 'orders.read')).toBe(false);
      expect(await roleHas('DELIVERY', 'shipments.manage')).toBe(false);
      expect(await roleHas('FINANCE', 'orders.commercial.read')).toBe(true);
      expect(await roleHas('FINANCE', 'shipments.read')).toBe(false);
      expect(await roleHas('SALES', 'orders.override')).toBe(false);
      expect(await roleHas('SUPER_ADMIN', 'public_tracking.manage')).toBe(true);
    });

    it('delivers the Phase 6A management permissions once, without over-granting', async () => {
      const roleHas = async (roleCode: string, permCode: string) =>
        (await prisma.rolePermission.count({
          where: { role: { code: roleCode }, permission: { code: permCode } },
        })) === 1;
      const finance = await prisma.role.findUniqueOrThrow({
        where: { code: 'FINANCE' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'commercial_kpis.read' },
      });
      await prisma.seedGrantBatch.delete({
        where: { key: 'phase6a-management' },
      });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: finance.id, permissionId: perm.id },
        },
      });
      await seed(prisma, {});
      await seed(prisma, {});
      expect(await roleHas('FINANCE', 'commercial_kpis.read')).toBe(true);
      expect(
        await prisma.seedGrantBatch.count({
          where: { key: 'phase6a-management' },
        }),
      ).toBe(1);
      // finance sees commercial figures only
      expect(await roleHas('FINANCE', 'management_kpis.read')).toBe(false);
      expect(await roleHas('FINANCE', 'workload.read')).toBe(false);
      // sales: overview, no finance, no capacity, no staff workload
      expect(await roleHas('SALES', 'dashboard.read')).toBe(true);
      expect(await roleHas('SALES', 'management_kpis.read')).toBe(true);
      expect(await roleHas('SALES', 'commercial_kpis.read')).toBe(false);
      expect(await roleHas('SALES', 'workload.read')).toBe(false);
      expect(await roleHas('SALES', 'capacity.manage')).toBe(false);
      // QC: quality only; factory floor: nothing executive
      expect(await roleHas('QC', 'quality_kpis.read')).toBe(true);
      expect(await roleHas('QC', 'dashboard.read')).toBe(false);
      expect(await roleHas('SEWING', 'dashboard.read')).toBe(false);
      expect(await roleHas('SEWING', 'workload.read')).toBe(false);
      expect(await roleHas('ADMIN', 'sla.manage')).toBe(true);
      expect(await roleHas('ADMIN', 'capacity.manage')).toBe(true);
      expect(await roleHas('SUPER_ADMIN', 'eta.read')).toBe(true);
    });

    it('delivers the Phase 6B automation permissions once, with least privilege', async () => {
      const roleHas = async (roleCode: string, permCode: string) =>
        (await prisma.rolePermission.count({
          where: { role: { code: roleCode }, permission: { code: permCode } },
        })) === 1;
      const admin = await prisma.role.findUniqueOrThrow({
        where: { code: 'ADMIN' },
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'tech_packs.issue' },
      });
      await prisma.seedGrantBatch.delete({
        where: { key: 'phase6b-automation' },
      });
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: { roleId: admin.id, permissionId: perm.id },
        },
      });
      await seed(prisma, {});
      await seed(prisma, {});
      expect(await roleHas('ADMIN', 'tech_packs.issue')).toBe(true);
      expect(
        await prisma.seedGrantBatch.count({
          where: { key: 'phase6b-automation' },
        }),
      ).toBe(1);
      for (const p of [
        'notifications.read_all',
        'notifications.manage',
        'notification_templates.manage',
        'automation.manage',
        'qr_job_cards.manage',
        'tech_packs.generate',
        'working_calendar.manage',
      ])
        expect(await roleHas('ADMIN', p)).toBe(true);
      // sales read tech packs and the calendar, nothing more
      expect(await roleHas('SALES', 'tech_packs.read')).toBe(true);
      expect(await roleHas('SALES', 'working_calendar.read')).toBe(true);
      for (const p of [
        'tech_packs.generate',
        'tech_packs.issue',
        'qr_job_cards.manage',
        'automation.manage',
        'notifications.read_all',
        'working_calendar.manage',
      ])
        expect(await roleHas('SALES', p)).toBe(false);
      // the floor reads its tech pack through the staff API (jobs.read_assigned), not through tech_packs.read
      for (const r of [
        'SEWING',
        'QC',
        'PACKAGING',
        'FABRIC',
        'DELIVERY',
        'FINANCE',
      ])
        for (const p of [
          'tech_packs.read',
          'tech_packs.generate',
          'qr_job_cards.read',
          'notifications.read_all',
          'automation.read',
        ])
          expect(await roleHas(r, p), `${r} ${p}`).toBe(false);
      expect(await roleHas('SUPER_ADMIN', 'automation.manage')).toBe(true);
      expect(await prisma.permission.count()).toBe(88);
    });

    it('seeds templates, rules and the calendar once; re-seeding never overwrites later changes', async () => {
      const { TEMPLATE_CATALOG } =
        await import('../src/modules/notifications/template-catalog.js');
      const { DEFAULT_AUTOMATION_RULES, DEFAULT_ESCALATION_RULES } =
        await import('../src/modules/notifications/default-rules.js');
      expect(
        await prisma.notificationTemplate.count({ where: { version: 1 } }),
      ).toBe(TEMPLATE_CATALOG.length * 3 * 2); // 3 channels × en/ar
      expect(
        await prisma.automationRule.count({
          where: { code: { in: DEFAULT_AUTOMATION_RULES.map((r) => r.code) } },
        }),
      ).toBe(DEFAULT_AUTOMATION_RULES.length);
      expect(
        await prisma.escalationRule.count({
          where: { code: { in: DEFAULT_ESCALATION_RULES.map((r) => r.code) } },
        }),
      ).toBe(DEFAULT_ESCALATION_RULES.length);
      const rule = await prisma.automationRule.findUniqueOrThrow({
        where: { code: 'ORDER_CONFIRMED_ADMIN' },
      });
      const esc = await prisma.escalationRule.findUniqueOrThrow({
        where: { code: 'ESC_OVERDUE_JOB_L1' },
      });
      await prisma.automationRule.update({
        where: { id: rule.id },
        data: { active: false, channels: ['IN_APP', 'EMAIL'] },
      });
      await prisma.escalationRule.update({
        where: { id: esc.id },
        data: { active: false, afterMinutes: 999 },
      });
      const before = await prisma.notificationTemplate.count();
      await seed(prisma, {});
      expect(await prisma.notificationTemplate.count()).toBe(before);
      expect(
        await prisma.automationRule.findUniqueOrThrow({
          where: { id: rule.id },
        }),
      ).toMatchObject({ active: false, channels: ['IN_APP', 'EMAIL'] });
      expect(
        await prisma.escalationRule.findUniqueOrThrow({
          where: { id: esc.id },
        }),
      ).toMatchObject({ active: false, afterMinutes: 999 });
      await prisma.automationRule.update({
        where: { id: rule.id },
        data: { active: true, channels: ['IN_APP'] },
      });
      await prisma.escalationRule.update({
        where: { id: esc.id },
        data: { active: true, afterMinutes: 120 },
      });
      expect(
        await prisma.workingCalendar.count({
          where: { code: 'FACTORY_DEFAULT' },
        }),
      ).toBe(1);
      expect(
        await prisma.workingCalendar.count({ where: { isDefault: true } }),
      ).toBe(1);
    });

    it('seeds the default shipment SLA once and never overwrites an admin edit', async () => {
      const rule = await prisma.slaRule.findUniqueOrThrow({
        where: { code: 'SHIPMENT_DEFAULT' },
      });
      expect(rule).toMatchObject({
        targetType: 'SHIPMENT',
        thresholdMinutes: 4320,
      });
      await prisma.slaRule.update({
        where: { id: rule.id },
        data: { thresholdMinutes: 1000 },
      });
      await seed(prisma, {});
      expect(
        (await prisma.slaRule.findUniqueOrThrow({ where: { id: rule.id } }))
          .thresholdMinutes,
      ).toBe(1000);
      expect(
        await prisma.slaRule.count({ where: { code: 'SHIPMENT_DEFAULT' } }),
      ).toBe(1);
      await prisma.slaRule.update({
        where: { id: rule.id },
        data: { thresholdMinutes: 4320 },
      });
    });
  });
});
