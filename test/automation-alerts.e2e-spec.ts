import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { AlertsService } from '../src/modules/automation/alerts.service.js';
import { ManagementContext } from '../src/modules/management/management-context.service.js';
import {
  auditActions,
  createTestApp,
  createUserAndLogin,
} from './support/app.js';
import { drain } from './support/automation.js';
import {
  api,
  lookupRefs,
  makeActors,
  type Actors,
  type Api,
  type Refs,
} from './support/factory.js';
import {
  currentStage,
  makeFloor,
  makeWorker,
  type Floor,
} from './support/floor.js';
import {
  approvedReferenceSample,
  readyOrder,
  runBulkStage,
  type ApprovedSample,
} from './support/orders.js';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

describe('Operational alerts, escalation and the scheduler (Phase 6B, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ctx: ManagementContext;
  let alerts: AlertsService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let admin: { api: Api; id: string };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ctx = app.get(ManagementContext);
    alerts = app.get(AlertsService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    const u = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
    admin = { api: api(app, u.accessToken), id: u.user.id };
    await drain(app);
    await alerts.evaluate(); // absorb everything that is already wrong in the shared test database
    await drain(app);
  }, 180_000);
  afterEach(() => ctx.freeze(null));
  afterAll(() => app.close());

  // ───────────────────────── helpers ─────────────────────────
  const newJob = async (priority = 'URGENT') => {
    const order = await readyOrder(a.admin, s, { priority });
    const job = (
      await a.admin
        .post(`/admin/orders/${order.id}/create-factory-job`)
        .expect(201)
    ).body as { id: string; jobNumber: string };
    return { order, job };
  };
  const stage = (jobId: string, code = 'FABRIC_PREPARATION') =>
    currentStage(a.admin, jobId, code);
  const alertsFor = (entityId: string, type?: string) =>
    prisma.operationalAlert.findMany({
      where: { entityId, ...(type && { type }) },
      orderBy: { createdAt: 'asc' },
    });
  const eventsFor = (alertId: string) =>
    prisma.outboxEvent.findMany({
      where: { aggregateId: alertId },
      orderBy: { occurredAt: 'asc' },
    });
  const block = async (stageId: string) =>
    (
      await a.admin
        .post(`/admin/job-stages/${stageId}/blockers`, {
          type: 'MATERIAL_UNAVAILABLE',
          description: 'Fabric not delivered',
        })
        .expect(201)
    ).body as { id: string };
  const msgs = (alertId: string, where: Record<string, unknown> = {}) =>
    prisma.notification.findMany({
      where: { alertId, ...where },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  // ───────────────────────── open, dedupe, severity ─────────────────────────
  describe('opening and severity', () => {
    it('opens one alert for a delayed stage and tells the people responsible exactly once', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      await a.admin
        .post(`/admin/job-stages/${st.id}/assignments`, {
          userId: floor.fabric.id,
        })
        .expect(201);
      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: hoursAgo(3) },
      });

      const first = await alerts.evaluate();
      expect(first.opened).toBeGreaterThanOrEqual(1);
      const [alert] = await alertsFor(st.id, 'DELAYED_STAGE');
      expect(alert).toMatchObject({
        type: 'DELAYED_STAGE',
        entityType: 'JOB_STAGE',
        status: 'OPEN',
        severity: 'WARNING', // 500 + urgent 200
        lastNotifiedSeverity: 'WARNING',
        escalationLevel: 0,
        reference: job.jobNumber,
        department: 'FABRIC',
        fingerprint: `DELAYED_STAGE:JOB_STAGE:${st.id}`,
      });
      expect(alert!.resolvedAt).toBeNull();
      expect(
        (alert!.context as { responsibleUserIds: string[] }).responsibleUserIds,
      ).toEqual([floor.fabric.id]);
      expect(await eventsFor(alert!.id)).toHaveLength(1);

      await drain(app);
      const toWorker = await msgs(alert!.id, {
        recipientUserId: floor.fabric.id,
      });
      expect(toWorker).toHaveLength(1);
      expect(toWorker[0]).toMatchObject({
        type: 'STAGE_DELAYED',
        channel: 'IN_APP',
        severity: 'WARNING',
        templateCode: 'STAGE_DELAYED',
      });
      expect(toWorker[0]!.title).toContain('Fabric');
      const notificationsAfterFirstRun = (await msgs(alert!.id)).length;
      expect(await msgs(alert!.id, { recipientUserId: admin.id })).toHaveLength(
        0,
      ); // admins hear about CRITICAL alerts only

      // the same unchanged problem is not announced again
      const again = await alerts.evaluate();
      expect(again.opened).toBe(0);
      expect(again.severityIncreased).toBe(0);
      await alerts.evaluate();
      await drain(app);
      expect(await alertsFor(st.id, 'DELAYED_STAGE')).toHaveLength(1);
      expect(await eventsFor(alert!.id)).toHaveLength(1);
      expect(await msgs(alert!.id)).toHaveLength(notificationsAfterFirstRun);
      const row = await prisma.operationalAlert.findUniqueOrThrow({
        where: { id: alert!.id },
      });
      expect(row.lastDetectedAt.getTime()).toBeGreaterThanOrEqual(
        alert!.lastDetectedAt.getTime(),
      );
    }, 120_000);

    it('announces a materially higher severity once, and not when it merely moves back and forth', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: hoursAgo(3) },
      });
      await alerts.evaluate();
      const [alert] = await alertsFor(st.id, 'DELAYED_STAGE');
      expect(alert!.severity).toBe('WARNING');
      await drain(app);

      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: daysAgo(12) },
      }); // 700 + 120 → CRITICAL
      const r = await alerts.evaluate();
      expect(r.severityIncreased).toBeGreaterThanOrEqual(1);
      let row = await prisma.operationalAlert.findUniqueOrThrow({
        where: { id: alert!.id },
      });
      expect(row).toMatchObject({
        severity: 'CRITICAL',
        lastNotifiedSeverity: 'CRITICAL',
      });
      const events = await eventsFor(alert!.id);
      expect(events.map((e) => e.eventType)).toEqual([
        'ALERT_OPENED',
        'ALERT_SEVERITY_INCREASED',
      ]);
      expect(events[1]!.deduplicationKey).toBe(
        `ALERT_SEV:${alert!.id}:CRITICAL`,
      );
      await drain(app);
      // CRITICAL reaches the admins, over in-app and email
      const toAdmin = await msgs(alert!.id, { recipientUserId: admin.id });
      expect(toAdmin.map((m) => m.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
      expect(
        toAdmin.every(
          (m) => m.severity === 'CRITICAL' && m.type === 'STAGE_DELAYED',
        ),
      ).toBe(true);
      expect(toAdmin.find((m) => m.channel === 'IN_APP')!.title).toMatch(
        /^Escalated to CRITICAL: /,
      );

      await alerts.evaluate();
      expect(await eventsFor(alert!.id)).toHaveLength(2); // unchanged: silent

      // improves, then worsens again: the level was already announced, so no new message
      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: hoursAgo(3) },
      });
      await alerts.evaluate();
      row = await prisma.operationalAlert.findUniqueOrThrow({
        where: { id: alert!.id },
      });
      expect(row).toMatchObject({
        severity: 'WARNING',
        lastNotifiedSeverity: 'CRITICAL',
      });
      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: daysAgo(12) },
      });
      await alerts.evaluate();
      expect(await eventsFor(alert!.id)).toHaveLength(2);
    }, 120_000);
  });

  // ───────────────────────── resolution ─────────────────────────
  describe('resolution and reappearance', () => {
    it('resolves when the condition goes away and keeps the history', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: hoursAgo(3) },
      });
      await alerts.evaluate();
      const [open] = await alertsFor(st.id, 'DELAYED_STAGE');
      expect(open!.status).toBe('OPEN');
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200); // the stage is done
      const r = await alerts.evaluate();
      expect(r.resolved).toBeGreaterThanOrEqual(1);
      const resolved = await prisma.operationalAlert.findUniqueOrThrow({
        where: { id: open!.id },
      });
      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.resolvedAt).toBeTruthy();
      expect(resolved.firstDetectedAt.getTime()).toBe(
        open!.firstDetectedAt.getTime(),
      );
      expect(await alertsFor(st.id, 'DELAYED_STAGE')).toHaveLength(1); // preserved, not deleted
      expect((await alerts.evaluate()).resolved).toBe(0);
    }, 120_000);

    it('a problem that comes back after being resolved opens a NEW alert', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      const b1 = await block(st.id);
      await alerts.evaluate();
      const [first] = await alertsFor(st.id, 'BLOCKED_STAGE');
      expect(first).toMatchObject({ status: 'OPEN', severity: 'CRITICAL' }); // 700 + urgent 200
      await a.admin
        .post(`/admin/blockers/${b1.id}/resolve`, { note: 'Delivered' })
        .expect(200);
      await alerts.evaluate();
      expect(
        (
          await prisma.operationalAlert.findUniqueOrThrow({
            where: { id: first!.id },
          })
        ).status,
      ).toBe('RESOLVED');
      await block(st.id);
      await alerts.evaluate();
      const all = await alertsFor(st.id, 'BLOCKED_STAGE');
      expect(all).toHaveLength(2);
      expect(all.map((x) => x.status)).toEqual(['RESOLVED', 'OPEN']);
      expect(all[1]!.id).not.toBe(all[0]!.id);
      expect(all[1]!.firstDetectedAt.getTime()).toBeGreaterThanOrEqual(
        all[0]!.resolvedAt!.getTime(),
      );
      expect(await eventsFor(all[1]!.id)).toHaveLength(1); // announced again, once
    }, 120_000);

    it('lists open and historical alerts for operations', async () => {
      const list = (
        await admin.api
          .get(
            '/admin/automation/alerts?status=OPEN&type=BLOCKED_STAGE&pageSize=100',
          )
          .expect(200)
      ).body;
      expect(list.data.length).toBeGreaterThan(0);
      expect(
        list.data.every(
          (x: { status: string; type: string }) =>
            x.status === 'OPEN' && x.type === 'BLOCKED_STAGE',
        ),
      ).toBe(true);
      const resolved = (
        await admin.api
          .get('/admin/automation/alerts?status=RESOLVED&pageSize=5')
          .expect(200)
      ).body;
      expect(
        resolved.data.every(
          (x: { resolvedAt: string | null }) => !!x.resolvedAt,
        ),
      ).toBe(true);
      const detail = (
        await admin.api
          .get(`/admin/automation/alerts/${list.data[0].id}`)
          .expect(200)
      ).body;
      expect(detail.notifications).toBeInstanceOf(Array);
      await a.sales.get('/admin/automation/alerts').expect(403);
      await admin.api.get('/admin/automation/alerts?type=NOPE').expect(400);
    });
  });

  // ───────────────────────── escalation ─────────────────────────
  describe('escalation', () => {
    it('escalates each level once, to the configured recipients', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      await block(st.id);
      await alerts.evaluate();
      const [alert] = await alertsFor(st.id, 'BLOCKED_STAGE');
      await drain(app);
      expect((await eventsFor(alert!.id)).map((e) => e.eventType)).toEqual([
        'ALERT_OPENED',
      ]);

      await alerts.evaluate(); // 0 minutes open: nothing due
      expect(await eventsFor(alert!.id)).toHaveLength(1);

      // level 1 (after 60 working minutes) → people of the responsible department
      await prisma.operationalAlert.update({
        where: { id: alert!.id },
        data: { firstDetectedAt: new Date(Date.now() - 90 * 60_000) },
      });
      const r1 = await alerts.evaluate();
      expect(r1.escalated).toBeGreaterThanOrEqual(1);
      await drain(app);
      let row = await prisma.operationalAlert.findUniqueOrThrow({
        where: { id: alert!.id },
      });
      expect(row.escalationLevel).toBe(1);
      let esc = await msgs(alert!.id, { type: 'ALERT_ESCALATED' });
      expect(esc.length).toBeGreaterThan(0);
      expect(
        esc.every(
          (m) =>
            m.channel === 'IN_APP' && m.title.startsWith('Escalation level 1:'),
        ),
      ).toBe(true);
      expect(esc.some((m) => m.recipientUserId === floor.fabric.id)).toBe(true); // FABRIC role
      expect(esc.some((m) => m.recipientUserId === admin.id)).toBe(false);

      await alerts.evaluate();
      expect(
        (await eventsFor(alert!.id)).filter(
          (e) => e.eventType === 'ALERT_ESCALATED',
        ),
      ).toHaveLength(1);

      // level 2 (after 240 working minutes) → ADMIN, critical, in-app + email
      await prisma.operationalAlert.update({
        where: { id: alert!.id },
        data: { firstDetectedAt: new Date(Date.now() - 5 * 3_600_000) },
      });
      await alerts.evaluate();
      await drain(app);
      row = await prisma.operationalAlert.findUniqueOrThrow({
        where: { id: alert!.id },
      });
      expect(row.escalationLevel).toBe(2);
      esc = await msgs(alert!.id, {
        type: 'ALERT_ESCALATED',
        recipientUserId: admin.id,
      });
      expect(esc.map((m) => m.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
      expect(
        esc.every(
          (m) => m.critical && m.title.startsWith('Escalation level 2:'),
        ),
      ).toBe(true);

      // nothing beyond the configured levels, however long it stays open
      await prisma.operationalAlert.update({
        where: { id: alert!.id },
        data: { firstDetectedAt: daysAgo(30) },
      });
      await alerts.evaluate();
      await alerts.evaluate();
      const escalations = (await eventsFor(alert!.id)).filter(
        (e) => e.eventType === 'ALERT_ESCALATED',
      );
      expect(escalations).toHaveLength(2);
      expect(new Set(escalations.map((e) => e.deduplicationKey)).size).toBe(2);
      expect(
        escalations.map((e) => (e.payload as { level: string }).level),
      ).toEqual(['1', '2']);
    }, 120_000);

    it('measures escalation time in WORKING minutes on the factory calendar', async () => {
      // Mon–Fri 09:00–17:00 in the (test) business zone Asia/Kolkata
      const cal = (
        await admin.api
          .post('/admin/working-calendars', {
            code: `T_CAL_${Date.now()}`,
            name: 'Test week',
            timezone: 'Asia/Kolkata',
            days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
              weekday,
              isWorkingDay: weekday >= 1 && weekday <= 5,
              startTime: weekday >= 1 && weekday <= 5 ? '09:00' : undefined,
              endTime: weekday >= 1 && weekday <= 5 ? '17:00' : undefined,
            })),
          })
          .expect(201)
      ).body;
      const original = (
        await prisma.workingCalendar.findFirstOrThrow({
          where: { isDefault: true },
        })
      ).id;
      await admin.api
        .post(`/admin/working-calendars/${cal.id}/make-default`)
        .expect(200);
      try {
        const { job } = await newJob();
        const st = await stage(job.id);
        await block(st.id);
        await alerts.evaluate();
        const [alert] = await alertsFor(st.id, 'BLOCKED_STAGE');
        // first detected Friday 16:00 local (10:30Z); now Monday 10:00 local (04:30Z): 66 elapsed hours but only 120 working minutes
        await prisma.operationalAlert.update({
          where: { id: alert!.id },
          data: { firstDetectedAt: new Date('2031-08-08T10:30:00Z') },
        });
        ctx.freeze(new Date('2031-08-11T04:30:00Z'));
        await alerts.evaluate();
        const row = await prisma.operationalAlert.findUniqueOrThrow({
          where: { id: alert!.id },
        });
        expect(row.escalationLevel).toBe(1); // 120 ≥ 60, but < 240: calendar time would have fired level 2 as well
      } finally {
        await admin.api
          .post(`/admin/working-calendars/${original}/make-default`)
          .expect(200);
        ctx.freeze(null);
      }
    }, 120_000);

    it('escalation rules are configurable, bounded and audited', async () => {
      const post = (body: object) =>
        admin.api.post('/admin/automation/escalation-rules', body);
      const base = {
        alertType: 'UNASSIGNED_READY_STAGE',
        afterMinutes: 30,
        recipientKind: 'ROLE',
        recipientRoleCode: 'SALES',
        channels: ['IN_APP'],
      };
      await post({ ...base, code: 'T_ESC_6', level: 6 }).expect(400); // at most 5 levels: no endless chains
      await post({ ...base, code: 'T_ESC_0', level: 0 }).expect(400);
      await post({
        ...base,
        code: 'T_ESC_X',
        level: 1,
        recipientRoleCode: 'NO_SUCH_ROLE',
      }).expect(400);
      await post({
        ...base,
        code: 'T_ESC_Y',
        level: 1,
        recipientKind: 'RESPONSIBLE_DEPARTMENT',
      }).expect(400);
      await post({
        ...base,
        code: 'T_ESC_Z',
        level: 1,
        channels: ['WHATSAPP'],
      }).expect(400);
      await post({
        ...base,
        code: 'T_ESC_W',
        level: 1,
        alertType: 'NOPE',
      }).expect(400);
      await a.sales
        .post('/admin/automation/escalation-rules', {
          ...base,
          code: 'T_ESC_S',
          level: 1,
        })
        .expect(403);
      const created = (
        await post({ ...base, code: `T_ESC_${Date.now()}`, level: 1 }).expect(
          201,
        )
      ).body;
      try {
        await post({ ...base, code: `T_ESC_B${Date.now()}`, level: 1 }).expect(
          409,
        ); // one rule per alert type and level
        const upd = (
          await admin.api
            .put(`/admin/automation/escalation-rules/${created.id}`, {
              afterMinutes: 45,
              channels: ['IN_APP', 'EMAIL'],
              critical: true,
            })
            .expect(200)
        ).body;
        expect(upd).toMatchObject({
          afterMinutes: 45,
          channels: ['IN_APP', 'EMAIL'],
          critical: true,
        });
        await admin.api
          .put(`/admin/automation/escalation-rules/${created.id}`, {})
          .expect(400);
        expect(
          (
            await admin.api
              .get(
                '/admin/automation/escalation-rules?alertType=UNASSIGNED_READY_STAGE',
              )
              .expect(200)
          ).body.some((r: { id: string }) => r.id === created.id),
        ).toBe(true);
        expect(await auditActions(app, created.id)).toEqual([
          'escalation_rule.created',
          'escalation_rule.updated',
        ]);
      } finally {
        await admin.api
          .put(`/admin/automation/escalation-rules/${created.id}`, {
            active: false,
          })
          .expect(200);
      }
    });
  });

  // ───────────────────────── scheduler ─────────────────────────
  describe('scheduler', () => {
    it('runs the three idempotent tasks on demand and records a heartbeat per task', async () => {
      await a.sales.post('/admin/automation/run', {}).expect(403);
      const r = (await admin.api.post('/admin/automation/run', {}).expect(200))
        .body;
      expect(Object.keys(r)).toEqual(['outbox', 'dispatch', 'alerts']);
      for (const t of ['outbox', 'dispatch', 'alerts'])
        expect(r[t].status).toBe('OK');
      expect(r.alerts).toHaveProperty('opened');
      await admin.api
        .post('/admin/automation/run', { tasks: ['nope'] })
        .expect(400);
      const only = (
        await admin.api
          .post('/admin/automation/run', { tasks: ['alerts'] })
          .expect(200)
      ).body;
      expect(Object.keys(only)).toEqual(['alerts']);
      const beats = await prisma.schedulerRun.findMany({
        where: { task: { in: ['outbox', 'dispatch', 'alerts'] } },
      });
      expect(beats.map((b) => b.task).sort()).toEqual([
        'alerts',
        'dispatch',
        'outbox',
      ]);
      expect(beats.every((b) => b.finishedAt && b.status === 'OK')).toBe(true);
      const cfg = (
        await admin.api.get('/admin/automation/scheduler').expect(200)
      ).body;
      expect(cfg).toMatchObject({
        enabled: false,
        intervals: { outbox: 10, dispatch: 15, alerts: 300 },
      });
      await a.sales.get('/admin/automation/scheduler').expect(403);
    }, 120_000);

    it('a second run while one is in progress is skipped, not duplicated', async () => {
      const [x, y] = await Promise.all([
        admin.api.post('/admin/automation/run', { tasks: ['alerts'] }),
        admin.api.post('/admin/automation/run', { tasks: ['alerts'] }),
      ]);
      expect(x.status).toBe(200);
      expect(y.status).toBe(200);
      const statuses = [x.body.alerts, y.body.alerts];
      expect(statuses.some((r: { skipped?: boolean }) => r.skipped)).toBe(true);
      // and the database invariant holds either way: at most one OPEN alert per fingerprint
      const dup = await prisma.$queryRaw<
        { n: number }[]
      >`SELECT COUNT(*)::int AS n FROM (SELECT fingerprint FROM operational_alerts WHERE status = 'OPEN' GROUP BY fingerprint HAVING COUNT(*) > 1) t`;
      expect(dup[0]!.n).toBe(0);
    }, 120_000);

    it('the database refuses a second OPEN alert for the same condition', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      await block(st.id);
      await alerts.evaluate();
      const [open] = await alertsFor(st.id, 'BLOCKED_STAGE');
      await expect(
        prisma.operationalAlert.create({
          data: {
            type: open!.type,
            entityType: open!.entityType,
            entityId: open!.entityId,
            fingerprint: open!.fingerprint,
            severity: 'INFO',
            reference: 'x',
            title: 'x',
            reason: 'x',
            firstDetectedAt: new Date(),
            lastDetectedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
      const w = await makeWorker(app, 'FABRIC');
      expect(w.id).toBeTruthy();
    }, 60_000);
  });
});
