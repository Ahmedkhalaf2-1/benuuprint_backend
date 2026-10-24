import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { ManagementContext } from '../src/modules/management/management-context.service.js';
import {
  auditActions,
  createTestApp,
  createUserAndLogin,
} from './support/app.js';
import {
  api,
  lookupRefs,
  makeActors,
  type Actors,
  type Api,
  type Refs,
} from './support/factory.js';
import {
  assignWorker,
  currentStage,
  makeFloor,
  makeWorker,
  uploadEvidence,
  type Floor,
  type Worker,
} from './support/floor.js';
import {
  approvedReferenceSample,
  producedOrder,
  readyOrder,
  runBulkStage,
  staffStage,
  type ApprovedSample,
  type OrderBody,
} from './support/orders.js';

const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000);

describe('Workload, capacity and ETA (Phase 6A, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ctx: ManagementContext;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ctx = app.get(ManagementContext);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
  });
  const savedMinSamples = () => ctx.cfg.etaMinSamples;
  let originalMinSamples = 0;
  beforeAll(() => {
    originalMinSamples = savedMinSamples();
  });
  afterEach(() => {
    ctx.freeze(null);
    ctx.cfg.etaMinSamples = originalMinSamples;
  });
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
  const dept = async (name: string) =>
    (
      await a.admin.get('/admin/management/workload/departments').expect(200)
    ).body.departments.find(
      (d: { department: string }) => d.department === name,
    );
  const wipOf = async (code: string) =>
    (await a.admin.get('/admin/management/wip').expect(200)).body.stages.find(
      (x: { stageCode: string }) => x.stageCode === code,
    );
  /** Do a stage as one specific worker (assigned first): start, report everything, evidence, complete. */
  const finishAs = async (
    w: Worker,
    st: {
      id: string;
      stageCode: string;
      requiresAttachment?: unknown;
      requiresCompletionNote?: unknown;
    },
  ) => {
    await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
    const q = (await staffStage(w.api, st.id)).quantity!;
    await w.api
      .post(`/staff/job-stages/${st.id}/production-reports`, {
        producedQuantity: q.required,
        rejectedQuantity: 0,
      })
      .expect(201);
    if (st.requiresAttachment)
      await uploadEvidence(app, w.token, st.id).expect(201);
    return w.api
      .post(`/staff/job-stages/${st.id}/complete`, {
        note: st.requiresCompletionNote ? 'done' : undefined,
      })
      .expect(200);
  };
  const assign = (stageId: string, userId: string) =>
    a.admin
      .post(`/admin/job-stages/${stageId}/assignments`, { userId })
      .expect(201);

  // ───────────────────────── department workload ─────────────────────────
  describe('department workload', () => {
    it('counts ready, unassigned, assigned, in-progress and blocked work; completed work drops out', async () => {
      const fabricWorker = await makeWorker(app, 'FABRIC');
      const b0 = await dept('FABRIC');
      const { job } = await newJob();
      const st = await stage(job.id);

      let d = await dept('FABRIC');
      expect(d.readyStages).toBe(b0.readyStages + 1);
      expect(d.unassignedReadyStages).toBe(b0.unassignedReadyStages + 1);
      expect(d.plannedUnits).toBe(b0.plannedUnits + 100);
      expect(d.remainingUnits).toBe(b0.remainingUnits + 100);
      expect(d.jobsInvolved).toBe(b0.jobsInvolved + 1);

      await assign(st.id, fabricWorker.id);
      d = await dept('FABRIC');
      expect(d.unassignedReadyStages).toBe(b0.unassignedReadyStages);
      expect(d.assignedStaffCount).toBe(b0.assignedStaffCount + 1);

      await fabricWorker.api
        .post(`/staff/job-stages/${st.id}/start`)
        .expect(200);
      d = await dept('FABRIC');
      expect(d.readyStages).toBe(b0.readyStages);
      expect(d.inProgressStages).toBe(b0.inProgressStages + 1);

      await a.admin
        .post(`/admin/job-stages/${st.id}/blockers`, {
          type: 'MATERIAL_UNAVAILABLE',
          description: 'Waiting on fabric',
        })
        .expect(201);
      d = await dept('FABRIC');
      expect(d.inProgressStages).toBe(b0.inProgressStages);
      expect(d.blockedStages).toBe(b0.blockedStages + 1);

      // a paused job's work is not workload
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/hold`, {
          reason: 'Customer asked to pause',
        })
        .expect(200);
      d = await dept('FABRIC');
      expect(d.blockedStages).toBe(b0.blockedStages);
      expect(d.plannedUnits).toBe(b0.plannedUnits);
      await a.admin.post(`/admin/factory-jobs/${job.id}/resume`).expect(200);
      expect((await dept('FABRIC')).blockedStages).toBe(b0.blockedStages + 1);
    });

    it('finishing a stage removes it from its department and queues the next one', async () => {
      const { job } = await newJob();
      const fabricBefore = await dept('FABRIC');
      const patternBefore = await dept('PATTERN');
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      const fabricAfter = await dept('FABRIC');
      const patternAfter = await dept('PATTERN');
      expect(fabricAfter.readyStages).toBe(fabricBefore.readyStages - 1);
      expect(fabricAfter.inProgressStages).toBe(fabricBefore.inProgressStages);
      expect(fabricAfter.plannedUnits).toBe(fabricBefore.plannedUnits - 100);
      expect(patternAfter.readyStages).toBe(patternBefore.readyStages + 1);
    });

    it('remaining units shrink as quantity is reported', async () => {
      const { job } = await newJob();
      for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING'])
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      const before = await dept('CUTTING');
      const st = await stage(job.id, 'CUTTING');
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const mid = await dept('CUTTING');
      expect(mid.remainingUnits).toBe(before.remainingUnits);
      await w.api
        .post(`/staff/job-stages/${st.id}/production-reports`, {
          producedQuantity: 40,
          rejectedQuantity: 0,
        })
        .expect(201);
      const after = await dept('CUTTING');
      expect(after.plannedUnits).toBe(mid.plannedUnits);
      expect(after.remainingUnits).toBe(mid.remainingUnits - 40);
    });

    it('DELIVERY is derived from shipments', async () => {
      const before = await dept('DELIVERY');
      const { order } = await producedOrder(app, a, floor, s);
      const w = await makeWorker(app, 'DELIVERY');
      const addr = await prisma.customerAddress.create({
        data: {
          customerId: s.customerId,
          country: 'Egypt',
          city: 'Cairo',
          addressLine1: '9 Test St',
        },
      });
      const sh = (
        await a.admin
          .post(`/admin/orders/${order.id}/shipments`, {
            deliveryMethod: 'OWN_DELIVERY',
            recipientName: 'Mona',
            recipientPhone: '+201001112233',
            customerAddressId: addr.id,
            assignedDeliveryUserId: w.id,
            lines: [
              { orderVariantId: order.items[0]!.variants[0]!.id, quantity: 30 },
            ],
          })
          .expect(201)
      ).body;
      await a.admin.post(`/admin/shipments/${sh.id}/ready`).expect(200);
      let d = await dept('DELIVERY');
      expect(d.readyStages).toBe(before.readyStages + 1);
      expect(d.plannedUnits).toBe(before.plannedUnits + 30);
      await w.api.post(`/staff/deliveries/${sh.id}/dispatch`, {}).expect(200);
      d = await dept('DELIVERY');
      expect(d.inProgressStages).toBe(before.inProgressStages + 1);
      expect(d.assignedStaffCount).toBe(before.assignedStaffCount + 1);
      await w.api.post(`/staff/deliveries/${sh.id}/delivered`, {}).expect(200);
      d = await dept('DELIVERY');
      expect(d.inProgressStages).toBe(before.inProgressStages);
      expect(d.plannedUnits).toBe(before.plannedUnits);
    }, 90_000);

    it('lists every department with eligible staff taken from the stage configuration', async () => {
      const r = (
        await a.admin.get('/admin/management/workload/departments').expect(200)
      ).body;
      expect(
        r.departments.map((x: { department: string }) => x.department),
      ).toEqual([
        'FABRIC',
        'PATTERN',
        'CUTTING',
        'PRINTING',
        'SEWING',
        'QC',
        'PACKAGING',
        'GENERAL',
        'DELIVERY',
      ]);
      const fabric = r.departments.find(
        (x: { department: string }) => x.department === 'FABRIC',
      );
      expect(fabric.eligibleStaffCount).toBeGreaterThanOrEqual(1);
      await a.sales.get('/admin/management/workload/departments').expect(403);
    });
  });

  // ───────────────────────── WIP ─────────────────────────
  describe('work in progress', () => {
    it('tracks queued, active, blocked and completed-today per stage', async () => {
      const b0 = await wipOf('FABRIC_PREPARATION');
      const p0 = await wipOf('PATTERN_MAKING');
      const { job } = await newJob();
      const st = await stage(job.id);
      let w = await wipOf('FABRIC_PREPARATION');
      expect(w.queued).toEqual({
        stages: b0.queued.stages + 1,
        jobs: b0.queued.jobs + 1,
        units: b0.queued.units + 100,
      });
      expect((await wipOf('PATTERN_MAKING')).upcomingStages).toBe(
        p0.upcomingStages + 1,
      );

      const worker = await assignWorker(a.admin, floor, st);
      await worker.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      w = await wipOf('FABRIC_PREPARATION');
      expect(w.queued.stages).toBe(b0.queued.stages);
      expect(w.active.stages).toBe(b0.active.stages + 1);
      expect(w.active.units).toBe(b0.active.units + 100);

      await a.admin
        .post(`/admin/job-stages/${st.id}/blockers`, {
          type: 'OTHER',
          description: 'Machine down',
        })
        .expect(201);
      w = await wipOf('FABRIC_PREPARATION');
      expect(w.blocked.stages).toBe(b0.blocked.stages + 1);
      expect(w.active.stages).toBe(b0.active.stages);

      const job2 = await newJob();
      expect(
        (await runBulkStage(app, a, floor, job2.job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      w = await wipOf('FABRIC_PREPARATION');
      expect(w.completedToday.stages).toBe(b0.completedToday.stages + 1);
      expect(w.completedToday.units).toBe(b0.completedToday.units + 100);
      const p1 = await wipOf('PATTERN_MAKING');
      expect(p1.queued.stages).toBe(p0.queued.stages + 1);
      expect(p1.upcomingStages).toBe(p0.upcomingStages + 1); // job 1's pattern stage is still waiting; job 2's moved to queued
    });

    it('is ordered by stage sequence and needs workload.read', async () => {
      const r = (await a.admin.get('/admin/management/wip').expect(200)).body;
      const seq = r.stages.map((x: { sequence: number }) => x.sequence);
      expect([...seq].sort((x: number, y: number) => x - y)).toEqual(seq);
      expect(r.stages[0].stageCode).toBe('FABRIC_PREPARATION');
      await a.finance.get('/admin/management/wip').expect(403);
    });
  });

  // ───────────────────────── staff workload ─────────────────────────
  describe('staff workload and my-workload', () => {
    it("reports one person's assignments, completions and durations without ranking anyone", async () => {
      const w = await makeWorker(app, 'FABRIC');
      const quiet = await makeWorker(app, 'FABRIC');
      const j1 = await newJob();
      const j2 = await newJob();
      const s1 = await stage(j1.job.id);
      const s2 = await stage(j2.job.id);
      await assign(s1.id, w.id);
      await assign(s2.id, w.id);
      await prisma.jobStage.update({
        where: { id: s2.id },
        data: { dueAt: new Date(Date.now() - 2 * 3_600_000) },
      });

      const list = async (q = '') =>
        (
          await a.admin
            .get(`/admin/management/workload/staff?pageSize=100${q}`)
            .expect(200)
        ).body;
      let row = (await list()).data.find(
        (r: { userId: string }) => r.userId === w.id,
      );
      expect(row).toMatchObject({
        name: 'Test User',
        roles: ['FABRIC'],
        activeAssignments: 2,
        readyAssignments: 2,
        inProgressAssignments: 0,
        overdueAssignments: 1,
        plannedQuantity: 200,
        stagesCompleted: 0,
        averageCompletionMinutes: null,
        onTimeCompletionRate: null,
      });
      expect(
        (await list()).data.find(
          (r: { userId: string }) => r.userId === quiet.id,
        ),
      ).toBeUndefined();

      await finishAs(w, s1);
      row = (await list()).data.find(
        (r: { userId: string }) => r.userId === w.id,
      );
      expect(row).toMatchObject({
        activeAssignments: 1,
        overdueAssignments: 1,
        stagesCompleted: 1,
        producedQuantity: 100,
        onTimeCompletionRate: 100,
      });
      expect(row.averageCompletionMinutes).toBeGreaterThanOrEqual(0);
      expect(row.plannedQuantity).toBe(100);

      // planning data only
      expect(
        Object.keys(row).filter((k) => /score|rank|rating|grade/i.test(k)),
      ).toEqual([]);
      const all = (await list()).data as { name: string; userId: string }[];
      const sorted = [...all].sort(
        (x, y) =>
          x.name.localeCompare(y.name) || x.userId.localeCompare(y.userId),
      );
      expect(all).toEqual(sorted);

      // department filter and optional staff capacity
      expect(
        (await list('&department=SEWING')).data.find(
          (r: { userId: string }) => r.userId === w.id,
        ),
      ).toBeUndefined();
      expect(
        (await list('&department=FABRIC')).data.find(
          (r: { userId: string }) => r.userId === w.id,
        ),
      ).toBeDefined();
      const cap = (
        await a.admin
          .post('/admin/management/capacity/staff', {
            userId: w.id,
            workingMinutesPerDay: 420,
            effectiveFrom: ctx.todayKey(),
          })
          .expect(201)
      ).body;
      row = (await list()).data.find(
        (r: { userId: string }) => r.userId === w.id,
      );
      expect(row.capacityMinutesPerDay).toBe(420);
      expect(row.assignedExpectedMinutes).toBeGreaterThan(0);
      await a.admin
        .post('/admin/management/capacity/staff', {
          userId: w.id,
          workingMinutesPerDay: 300,
          effectiveFrom: ctx.todayKey(),
        })
        .expect(409);
      await a.admin
        .post(`/admin/management/capacity/staff/${cap.id}/deactivate`)
        .expect(200);
      expect(await auditActions(app, cap.id)).toEqual([
        'staff_capacity.created',
        'staff_capacity.deactivated',
      ]);

      await a.sales.get('/admin/management/workload/staff').expect(403);
      await a.admin
        .get('/admin/management/workload/staff?from=2030-02-01&to=2030-01-01')
        .expect(400);
    });

    it("my-workload shows only the caller's own numbers", async () => {
      const w = await makeWorker(app, 'FABRIC');
      const other = await makeWorker(app, 'PRINTING');
      const j1 = await newJob();
      const j2 = await newJob();
      const s1 = await stage(j1.job.id);
      const s2 = await stage(j2.job.id);
      await assign(s1.id, w.id);
      await assign(s2.id, w.id);
      await prisma.jobStage.update({
        where: { id: s1.id },
        data: { dueAt: hoursAhead(5) },
      }); // due soon (24h window)
      await prisma.jobStage.update({
        where: { id: s2.id },
        data: { dueAt: hoursAhead(100) },
      });

      let mine = (await w.api.get('/staff/my-workload').expect(200)).body;
      expect(mine).toMatchObject({
        ready: 2,
        inProgress: 0,
        blocked: 0,
        overdue: 0,
        dueSoon: 1,
        completedToday: 0,
        dueSoonWindowHours: 24,
      });
      expect(mine.nextUp.map((n: { stageId: string }) => n.stageId)).toEqual([
        s1.id,
        s2.id,
      ]); // earliest due first

      await finishAs(w, s1);
      mine = (await w.api.get('/staff/my-workload').expect(200)).body;
      expect(mine).toMatchObject({ ready: 1, completedToday: 1, dueSoon: 0 });
      await prisma.jobStage.update({
        where: { id: s2.id },
        data: { dueAt: new Date(Date.now() - 3_600_000) },
      });
      expect(
        (await w.api.get('/staff/my-workload').expect(200)).body.overdue,
      ).toBe(1);

      const theirs = (await other.api.get('/staff/my-workload').expect(200))
        .body;
      expect(theirs).toMatchObject({
        ready: 0,
        inProgress: 0,
        overdue: 0,
        dueSoon: 0,
        completedToday: 0,
        nextUp: [],
      });
      expect(JSON.stringify(theirs)).not.toContain(s2.id);
      await a.sales.get('/staff/my-workload').expect(403);
      await api(app, 'bad').get('/staff/my-workload').expect(401);
    });
  });

  // ───────────────────────── management board ─────────────────────────
  describe('management production board', () => {
    const board = async (q: string, who: Api = a.admin) =>
      (
        await who
          .get(`/admin/management/production-board?pageSize=100${q}`)
          .expect(200)
      ).body as {
        data: Record<string, any>[];
        meta: { total: number; page: number; pageSize: number };
        etaIncluded: boolean;
      };
    const row = (res: { data: Record<string, any>[] }, jobId: string) =>
      res.data.find((r) => r.jobId === jobId);

    it('returns one row per live job with the requested filters', async () => {
      const w = await makeWorker(app, 'FABRIC');
      const live = await newJob('URGENT');
      const blocked = await newJob('NORMAL');
      const late = await newJob('HIGH');
      const sl = await stage(live.job.id);
      await assign(sl.id, w.id);
      await a.admin
        .post(
          `/admin/job-stages/${(await stage(blocked.job.id)).id}/blockers`,
          { type: 'OTHER', description: 'Stuck' },
        )
        .expect(201);
      await prisma.jobStage.update({
        where: { id: (await stage(late.job.id)).id },
        data: { dueAt: new Date(Date.now() - 3 * 3_600_000) },
      });

      const all = await board('');
      const r = row(all, live.job.id)!;
      expect(r).toMatchObject({
        jobNumber: live.job.jobNumber,
        kind: 'BULK',
        orderId: live.order.id,
        orderNumber: live.order.orderNumber,
        sampleId: null,
        priority: 'URGENT',
        status: 'READY',
        blocked: false,
        delayed: false,
        delayReasons: [],
        progress: {
          stagesCompleted: 0,
          percent: 0,
          plannedQuantity: 100,
          completedQuantity: 0,
        },
      });
      expect(r.customerName).toBeTruthy();
      expect(r.brandName).toBeTruthy();
      expect(r.currentStages).toMatchObject([
        {
          stageCode: 'FABRIC_PREPARATION',
          status: 'READY',
          department: 'FABRIC',
        },
      ]);
      expect(r.assignees).toEqual([{ id: w.id, name: 'Test User' }]);
      expect(all.etaIncluded).toBe(true);
      expect(r.estimatedCompletionAt).toBeTruthy();
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(r.etaDataQuality);
      // ordered by priority first
      const ids = all.data.map((x) => x.jobId);
      expect(ids.indexOf(live.job.id)).toBeLessThan(ids.indexOf(late.job.id));
      expect(ids.indexOf(late.job.id)).toBeLessThan(
        ids.indexOf(blocked.job.id),
      );

      expect(row(await board('&blocked=true'), blocked.job.id)).toMatchObject({
        blocked: true,
        status: 'BLOCKED',
        delayed: true,
      });
      expect(row(await board('&blocked=true'), live.job.id)).toBeUndefined();
      const delayed = await board('&delayed=true');
      expect(row(delayed, late.job.id)).toMatchObject({
        delayed: true,
        delayReasons: ['STAGE_OVERDUE'],
      });
      expect(row(delayed, live.job.id)).toBeUndefined();
      expect(
        row(await board(`&assignedUserId=${w.id}`), live.job.id),
      ).toBeDefined();
      expect(
        row(await board(`&assignedUserId=${w.id}`), late.job.id),
      ).toBeUndefined();
      expect(row(await board('&priority=HIGH'), late.job.id)).toBeDefined();
      expect(row(await board('&priority=HIGH'), live.job.id)).toBeUndefined();
      expect(
        row(await board('&stageCode=FABRIC_PREPARATION'), live.job.id),
      ).toBeDefined();
      expect(
        row(await board('&stageCode=SEWING'), live.job.id),
      ).toBeUndefined();
      expect(row(await board('&department=FABRIC'), live.job.id)).toBeDefined();
      expect(
        row(await board('&department=SEWING'), live.job.id),
      ).toBeUndefined();
      expect(row(await board('&kind=BULK'), live.job.id)).toBeDefined();
      expect(row(await board('&kind=SAMPLE'), live.job.id)).toBeUndefined();
      expect(
        row(await board(`&customerId=${s.customerId}`), live.job.id),
      ).toBeDefined();
      expect(
        row(await board(`&customerId=${w.id}`), live.job.id),
      ).toBeUndefined();
      expect(
        row(await board(`&brandId=${s.brandId}`), live.job.id),
      ).toBeDefined();
      await a.admin
        .get('/admin/management/production-board?priority=NOPE')
        .expect(400);
    });

    it('paginates, drops finished jobs and hides ETA from callers without eta.read', async () => {
      const first = await newJob('NORMAL');
      await newJob('NORMAL');
      const page1 = (
        await a.admin
          .get('/admin/management/production-board?pageSize=1&page=1')
          .expect(200)
      ).body;
      const page2 = (
        await a.admin
          .get('/admin/management/production-board?pageSize=1&page=2')
          .expect(200)
      ).body;
      expect(page1.data).toHaveLength(1);
      expect(page1.meta).toMatchObject({ page: 1, pageSize: 1 });
      expect(page1.meta.total).toBeGreaterThanOrEqual(2);
      expect(page2.data[0].jobId).not.toBe(page1.data[0].jobId);

      const noEta = await createUserAndLogin(app, {
        permissions: ['production_board.read'],
      });
      const res = await board('', api(app, noEta.accessToken));
      expect(res.etaIncluded).toBe(false);
      const r = row(res, first.job.id)!;
      expect(r.estimatedCompletionAt).toBeNull();
      expect(r.etaDataQuality).toBeNull();
      expect(r.projectedLate).toBeNull();
      await a.finance.get('/admin/management/production-board').expect(403);

      const done = await producedOrder(app, a, floor, s);
      expect(row(await board(''), done.job.id)).toBeUndefined(); // completed jobs leave the board
    }, 90_000);
  });

  // ───────────────────────── capacity ─────────────────────────
  describe('capacity configuration and utilization', () => {
    const FROZEN = new Date('2031-03-01T06:00:00Z'); // 11:30 on 2031-03-01 in Kolkata
    const cap = (body: Record<string, unknown>, expected = 201) =>
      a.admin
        .post('/admin/management/capacity/departments', body)
        .expect(expected);
    const util = async (q: string) =>
      (
        await a.admin
          .get(`/admin/management/capacity/utilization?${q}`)
          .expect(200)
      ).body;
    const seriesOf = (
      res: any,
      department: string,
      stageCode: string | null = null,
    ) =>
      res.series.find(
        (x: any) =>
          x.departmentType === department && x.stageCode === stageCode,
      );

    it('validates, audits and refuses overlapping configuration', async () => {
      const first = (
        await cap({
          departmentType: 'PRINTING',
          capacityUnit: 'PIECES',
          dailyCapacity: 300,
          workingMinutesPerDay: 480,
          effectiveFrom: '2032-01-01',
          effectiveTo: '2032-06-30',
        })
      ).body;
      expect(first).toMatchObject({
        departmentType: 'PRINTING',
        capacityUnit: 'PIECES',
        dailyCapacity: 300,
        effectiveFrom: '2032-01-01',
        effectiveTo: '2032-06-30',
        active: true,
      });
      await cap(
        {
          departmentType: 'PRINTING',
          capacityUnit: 'PIECES',
          dailyCapacity: 100,
          effectiveFrom: '2032-06-30',
        },
        409,
      ); // overlaps the last day
      const next = (
        await cap({
          departmentType: 'PRINTING',
          capacityUnit: 'PIECES',
          dailyCapacity: 150,
          effectiveFrom: '2032-07-01',
        })
      ).body;
      await cap(
        {
          departmentType: 'PRINTING',
          capacityUnit: 'PIECES',
          dailyCapacity: 1,
          effectiveFrom: '2032-03-01',
          effectiveTo: '2032-02-01',
        },
        400,
      );
      await cap(
        {
          departmentType: 'PRINTING',
          capacityUnit: 'PIECES',
          dailyCapacity: 0,
          effectiveFrom: '2033-01-01',
        },
        400,
      );
      await cap(
        {
          departmentType: 'PRINTING',
          capacityUnit: 'LITRES',
          dailyCapacity: 5,
          effectiveFrom: '2033-01-01',
        },
        400,
      );
      const sewing = await prisma.productionStageDefinition.findUniqueOrThrow({
        where: { code: 'SEWING' },
      });
      await cap(
        {
          departmentType: 'PRINTING',
          stageDefinitionId: sewing.id,
          capacityUnit: 'PIECES',
          dailyCapacity: 5,
          effectiveFrom: '2033-01-01',
        },
        400,
      ); // SEWING is not PRINTING

      await a.admin
        .put(`/admin/management/capacity/departments/${first.id}`, {
          dailyCapacity: 320,
          effectiveTo: '2032-06-30',
        })
        .expect(200);
      await a.admin
        .put(`/admin/management/capacity/departments/${first.id}`, {
          effectiveTo: '2032-12-31',
        })
        .expect(409); // would overlap `next`
      await a.admin
        .put(`/admin/management/capacity/departments/${first.id}`, {})
        .expect(400);
      const list = (
        await a.admin
          .get('/admin/management/capacity/departments?department=PRINTING')
          .expect(200)
      ).body;
      expect(
        list.find((x: { id: string }) => x.id === first.id).dailyCapacity,
      ).toBe(320);
      await a.admin
        .post(`/admin/management/capacity/departments/${next.id}/deactivate`)
        .expect(200);
      await a.admin
        .post(`/admin/management/capacity/departments/${first.id}/deactivate`)
        .expect(200);
      expect(await auditActions(app, first.id)).toEqual([
        'department_capacity.created',
        'department_capacity.updated',
        'department_capacity.deactivated',
      ]);
      expect(await auditActions(app, next.id)).toEqual([
        'department_capacity.created',
        'department_capacity.deactivated',
      ]);

      await a.sales.get('/admin/management/capacity/departments').expect(403);
      await a.sales
        .post('/admin/management/capacity/departments', {})
        .expect(403);
      await a.finance.get('/admin/management/capacity/utilization').expect(403);
    });

    it('computes demand against capacity per day, with effective-date changes and overload', async () => {
      ctx.freeze(FROZEN);
      // capacity for FABRIC: 1000/day for the first three days, 50/day afterwards
      const r1 = (
        await cap({
          departmentType: 'FABRIC',
          capacityUnit: 'PIECES',
          dailyCapacity: 1000,
          effectiveFrom: '2031-03-01',
          effectiveTo: '2031-03-03',
        })
      ).body;
      const r2 = (
        await cap({
          departmentType: 'FABRIC',
          capacityUnit: 'PIECES',
          dailyCapacity: 50,
          effectiveFrom: '2031-03-04',
        })
      ).body;
      try {
        const before = await util(
          'from=2031-03-01&to=2031-03-06&department=FABRIC',
        );
        const { job } = await newJob();
        const st = await stage(job.id);
        // due on day 5 of the window (12:00 Kolkata)
        await prisma.jobStage.update({
          where: { id: st.id },
          data: { dueAt: new Date('2031-03-05T06:30:00Z') },
        });
        const after = await util(
          'from=2031-03-01&to=2031-03-06&department=FABRIC',
        );

        const sB = seriesOf(before, 'FABRIC');
        const sA = seriesOf(after, 'FABRIC');
        expect(sA.days.map((d: any) => d.date)).toEqual([
          '2031-03-01',
          '2031-03-02',
          '2031-03-03',
          '2031-03-04',
          '2031-03-05',
          '2031-03-06',
        ]);
        expect(sA.days.map((d: any) => d.capacity)).toEqual([
          1000, 1000, 1000, 50, 50, 50,
        ]); // effective-date change
        const day = (series: any, date: string) =>
          series.days.find((d: any) => d.date === date);
        // the new stage lands on its due day, nowhere else
        expect(day(sA, '2031-03-05').demand).toBe(
          day(sB, '2031-03-05').demand + 100,
        );
        expect(day(sA, '2031-03-01').demand).toBe(day(sB, '2031-03-01').demand);
        const d5 = day(sA, '2031-03-05');
        expect(d5).toMatchObject({
          capacity: 50,
          overloaded: true,
          remainingCapacity: 0,
          capacityUnit: 'PIECES',
        });
        expect(d5.utilizationPercent).toBe(
          Math.round((d5.demand / 50) * 1000) / 10,
        );
        expect(day(sA, '2031-03-06')).toMatchObject({
          demand: 0,
          utilizationPercent: 0,
          overloaded: false,
          remainingCapacity: 50,
        });
        const d1 = day(sA, '2031-03-01');
        expect(d1.overloaded).toBe(d1.demand > 1000);
        expect(d1.remainingCapacity).toBe(Math.max(1000 - d1.demand, 0));
        expect(sA.overloadedDays).toBe(
          sA.days.filter((d: any) => d.overloaded).length,
        );
        expect(after.timezone).toBe('Asia/Kolkata');
        expect(after.assumptions.join('|')).toMatch(
          /Every calendar day is a working day/,
        );
        // departments without configuration are listed, not given a made-up capacity
        const all = await util('from=2031-03-01&to=2031-03-02');
        expect(seriesOf(all, 'SEWING')).toBeUndefined();
        expect(
          all.departmentsWithoutCapacity.every(
            (x: any) => x.department !== 'FABRIC',
          ),
        ).toBe(true);
      } finally {
        await a.admin
          .post(`/admin/management/capacity/departments/${r1.id}/deactivate`)
          .expect(200);
        await a.admin
          .post(`/admin/management/capacity/departments/${r2.id}/deactivate`)
          .expect(200);
      }
    });

    it('a day before any configuration has no utilization; JOBS and MINUTES units are supported', async () => {
      ctx.freeze(FROZEN);
      const jobs = (
        await cap({
          departmentType: 'PATTERN',
          capacityUnit: 'JOBS',
          dailyCapacity: 2,
          effectiveFrom: '2031-03-01',
        })
      ).body;
      const minutes = (
        await cap({
          departmentType: 'CUTTING',
          capacityUnit: 'MINUTES',
          dailyCapacity: 480,
          effectiveFrom: '2031-03-02',
        })
      ).body;
      try {
        const made = [await newJob(), await newJob(), await newJob()];
        for (const j of made)
          expect(
            (await runBulkStage(app, a, floor, j.job.id, 'FABRIC_PREPARATION'))
              .status,
          ).toBe(200);
        const res = await util('from=2031-03-01&to=2031-03-03');
        const pattern = seriesOf(res, 'PATTERN');
        const d1 = pattern.days[0];
        expect(d1).toMatchObject({
          date: '2031-03-01',
          capacity: 2,
          capacityUnit: 'JOBS',
        });
        const workload = await dept('PATTERN');
        expect(d1.demand).toBe(workload.jobsInvolved); // JOBS = distinct live jobs in the department
        expect(d1.demand).toBeGreaterThanOrEqual(3);
        expect(d1.overloaded).toBe(true);
        expect(d1.remainingCapacity).toBe(0);
        const cutting = seriesOf(res, 'CUTTING');
        expect(cutting.days[0]).toMatchObject({
          date: '2031-03-01',
          capacity: null,
          utilizationPercent: null,
          overloaded: false,
          remainingCapacity: null,
        }); // nothing configured yet: no made-up number
        expect(cutting.days[1]).toMatchObject({
          capacity: 480,
          capacityUnit: 'MINUTES',
        });
      } finally {
        await a.admin
          .post(`/admin/management/capacity/departments/${jobs.id}/deactivate`)
          .expect(200);
        await a.admin
          .post(
            `/admin/management/capacity/departments/${minutes.id}/deactivate`,
          )
          .expect(200);
      }
    });

    it('limits the window to 31 days and rejects inverted ranges', async () => {
      await a.admin
        .get(
          '/admin/management/capacity/utilization?from=2031-03-01&to=2031-05-01',
        )
        .expect(400);
      await a.admin
        .get(
          '/admin/management/capacity/utilization?from=2031-03-05&to=2031-03-01',
        )
        .expect(400);
      await a.admin
        .get('/admin/management/capacity/utilization?from=nope')
        .expect(400);
      const ok = (
        await a.admin
          .get(
            '/admin/management/capacity/utilization?from=2031-03-01&to=2031-03-31',
          )
          .expect(200)
      ).body;
      expect(ok.series).toBeInstanceOf(Array);
    });
  });

  // ───────────────────────── ETA ─────────────────────────
  describe('ETA', () => {
    const eta = async (jobId: string, who: Api = a.admin) =>
      (await who.get(`/admin/management/jobs/${jobId}/eta`).expect(200)).body;
    const orderEta = async (orderId: string) =>
      (await a.admin.get(`/admin/management/orders/${orderId}/eta`).expect(200))
        .body;
    const setDurations = (jobId: string, minutes: number | null) =>
      prisma.jobStage.updateMany({
        where: { jobId },
        data: { expectedDurationMinutes: minutes },
      });

    it('falls back to the configured durations and explains itself', async () => {
      ctx.cfg.etaMinSamples = 1_000_000; // never enough history
      const { job } = await newJob();
      await setDurations(job.id, 60);
      const r = await eta(job.id);
      expect(r.persisted).toBe(false);
      expect(r.stages).toHaveLength(10);
      expect(
        r.stages.every(
          (x: any) => x.source === 'CONFIGURED' && x.estimateMinutes === 60,
        ),
      ).toBe(true);
      expect(r.dataQuality).toBe('MEDIUM');
      // total = ten sequential stages of 60 min + the queue ahead of the first one
      const first = r.stages.find(
        (x: any) => x.stageCode === 'FABRIC_PREPARATION',
      );
      const spanMin =
        (new Date(r.estimatedCompletionAt).getTime() -
          new Date(r.generatedAt).getTime()) /
        60_000;
      expect(spanMin).toBeGreaterThanOrEqual(600 - 1);
      expect(Math.abs(spanMin - (600 + first.queueMinutes))).toBeLessThan(2);
      expect(r.basis[0]).toBe('10 stages remaining');
      expect(r.basis.join('|')).toMatch(/Fabric.*configured estimate 60min/i);
      expect(r.basis.join('|')).toMatch(/Calendar time/);
      expect(r.status).toBe('READY');
      await a.admin
        .get('/admin/management/jobs/5c7e1b88-0000-4000-8000-000000000000/eta')
        .expect(404);
    });

    it('prefers the historical average once enough completed stages exist', async () => {
      const warm = await newJob();
      expect(
        (await runBulkStage(app, a, floor, warm.job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      ctx.cfg.etaMinSamples = 1;
      const { job } = await newJob();
      await setDurations(job.id, 600);
      const r = await eta(job.id);
      const fabric = r.stages.find(
        (x: any) => x.stageCode === 'FABRIC_PREPARATION',
      );
      expect(fabric.source).toBe('HISTORICAL');
      const since = new Date(Date.now() - ctx.cfg.etaHistoryDays * 86_400_000);
      const [row] = await prisma.$queryRaw<{ avg: unknown }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0) AS avg
        FROM job_stages js JOIN production_stage_definitions d ON d.id = js.stage_definition_id
        WHERE d.code = 'FABRIC_PREPARATION' AND js.status = 'COMPLETED' AND js.started_at IS NOT NULL
          AND js.completed_at > js.started_at AND js.completed_at >= ${since}`;
      expect(fabric.estimateMinutes).toBeCloseTo(Number(row!.avg), 3);
      expect(fabric.estimateMinutes).toBeLessThan(600); // the configured 600 was not used
      expect(r.basis.join('|')).toMatch(/Fabric.*historical average/i);
    });

    it('is LOW quality when a stage has no estimate at all', async () => {
      ctx.cfg.etaMinSamples = 1_000_000;
      const { job } = await newJob();
      await setDurations(job.id, null);
      const r = await eta(job.id);
      expect(r.dataQuality).toBe('LOW');
      expect(r.stages.every((x: any) => x.source === 'NONE')).toBe(true);
      expect(r.basis.join('|')).toMatch(/no historical or configured duration/);
    });

    it('a blocked job is LOW quality and says the block is assumed resolved', async () => {
      ctx.cfg.etaMinSamples = 1_000_000;
      const { job } = await newJob();
      await setDurations(job.id, 60);
      const clear = await eta(job.id);
      await a.admin
        .post(`/admin/job-stages/${(await stage(job.id)).id}/blockers`, {
          type: 'MATERIAL_UNAVAILABLE',
          description: 'No fabric',
        })
        .expect(201);
      const r = await eta(job.id);
      expect(clear.dataQuality).toBe('MEDIUM');
      expect(r).toMatchObject({
        blocked: true,
        dataQuality: 'LOW',
        status: 'BLOCKED',
      });
      expect(r.basis.join('|')).toMatch(
        /Blocked since .*MATERIAL_UNAVAILABLE.*resolved now/,
      );
      expect(r.estimatedCompletionAt).toBeTruthy();
    });

    it('a held job is LOW quality too', async () => {
      const { job } = await newJob();
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/hold`, {
          reason: 'Customer asked to pause',
        })
        .expect(200);
      const r = await eta(job.id);
      expect(r).toMatchObject({
        onHold: true,
        dataQuality: 'LOW',
        status: 'ON_HOLD',
      });
    });

    it('flags a job that is projected to miss its target date', async () => {
      ctx.cfg.etaMinSamples = 1_000_000;
      const { job } = await newJob();
      await setDurations(job.id, 60);
      await prisma.factoryJob.update({
        where: { id: job.id },
        data: { targetCompletionDate: new Date(Date.now() + 60_000) },
      });
      const late = await eta(job.id);
      expect(late.projectedLate).toBe(true);
      expect(late.projectedLateMinutes).toBeGreaterThan(500);
      await prisma.factoryJob.update({
        where: { id: job.id },
        data: { targetCompletionDate: new Date(Date.now() + 90 * 86_400_000) },
      });
      const fine = await eta(job.id);
      expect(fine).toMatchObject({
        projectedLate: false,
        projectedLateMinutes: 0,
      });
    });

    it('queues: a later job waits behind the earlier one in the same stage', async () => {
      ctx.cfg.etaMinSamples = 1;
      const warm = await newJob();
      expect(
        (await runBulkStage(app, a, floor, warm.job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      const first = await newJob();
      const second = await newJob();
      const q1 = (await eta(first.job.id)).stages.find(
        (x: any) => x.stageCode === 'FABRIC_PREPARATION',
      ).queueMinutes;
      const q2 = (await eta(second.job.id)).stages.find(
        (x: any) => x.stageCode === 'FABRIC_PREPARATION',
      ).queueMinutes;
      expect(q2).toBeGreaterThanOrEqual(q1);
    });

    it('a completed job reports its actual completion time with HIGH quality', async () => {
      const { job } = await producedOrder(app, a, floor, s);
      const r = await eta(job.id);
      const done = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(r).toMatchObject({
        status: 'COMPLETED',
        dataQuality: 'HIGH',
        projectedLate: false,
      });
      expect(r.estimatedCompletionAt).toBe(done.completedAt!.toISOString());
    }, 60_000);

    it('order ETA: slowest batch decides, unbatched units are flagged, delivery is never invented', async () => {
      ctx.cfg.etaMinSamples = 1_000_000;
      const order: OrderBody = await readyOrder(a.admin, s, {});
      const alloc = (variant: number, quantity: number) => ({
        orderVariantId: order.items[0]!.variants[variant]!.id,
        quantity,
      });
      const mkBatch = async (
        allocations: { orderVariantId: string; quantity: number }[],
      ) => {
        const b = (
          await a.admin
            .post(`/admin/orders/${order.id}/batches`, { allocations })
            .expect(201)
        ).body;
        await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
        return (
          await a.admin
            .post(`/admin/order-batches/${b.id}/create-factory-job`)
            .expect(201)
        ).body as { id: string; jobNumber: string };
      };
      const fast = await mkBatch([alloc(0, 60)]);
      await setDurations(fast.id, 30); // 10 × 30 = 300 min
      let r = await orderEta(order.id);
      expect(r.production.jobs).toHaveLength(1);
      expect(r.production.unplannedUnits).toBe(40);
      expect(r.production.dataQuality).toBe('LOW'); // 40 units are in no batch
      expect(r.production.basis.join('|')).toMatch(
        /40 unit\(s\) are not in any batch yet/,
      );

      const slow = await mkBatch([alloc(1, 40)]);
      await setDurations(slow.id, 120); // 10 × 120 = 1200 min
      r = await orderEta(order.id);
      expect(r.production.unplannedUnits).toBe(0);
      expect(r.production.jobs).toHaveLength(2);
      const times = r.production.jobs.map((j: any) =>
        new Date(j.estimatedCompletionAt).getTime(),
      );
      expect(new Date(r.production.estimatedCompletionAt).getTime()).toBe(
        Math.max(...times),
      );
      const slowRow = r.production.jobs.find((j: any) => j.jobId === slow.id);
      expect(new Date(slowRow.estimatedCompletionAt).getTime()).toBe(
        Math.max(...times),
      );
      expect(r.production.dataQuality).toBe('MEDIUM');
      expect(r.production.basis.join('|')).toMatch(
        new RegExp(`the slowest is ${slow.jobNumber}`),
      );
      // no shipment: no delivery estimate
      expect(r.delivery.estimatedAt).toBeNull();
      expect(r.delivery.basis.join('|')).toMatch(/No shipment exists yet/);
      expect(r.persisted).toBe(false);
      await a.finance
        .get(`/admin/management/orders/${order.id}/eta`)
        .expect(403);
      await a.sales.get(`/admin/management/orders/${order.id}/eta`).expect(200);
    });

    it('order ETA: delivery follows shipment data and the actual delivery time once delivered', async () => {
      const { order } = await producedOrder(app, a, floor, s);
      const w = await makeWorker(app, 'DELIVERY');
      const addr = await prisma.customerAddress.create({
        data: {
          customerId: s.customerId,
          country: 'Egypt',
          city: 'Cairo',
          addressLine1: '5 Test St',
        },
      });
      let r = await orderEta(order.id);
      expect(r.production.basis.join('|')).toMatch(/Production is complete/);
      expect(r.delivery.estimatedAt).toBeNull();
      const when = hoursAhead(30);
      const sh = (
        await a.admin
          .post(`/admin/orders/${order.id}/shipments`, {
            deliveryMethod: 'OWN_DELIVERY',
            recipientName: 'Mona',
            recipientPhone: '+201001112233',
            customerAddressId: addr.id,
            assignedDeliveryUserId: w.id,
            scheduledAt: when.toISOString(),
            lines: order.items[0]!.variants.map((v) => ({
              orderVariantId: v.id,
              quantity: v.quantity,
            })),
          })
          .expect(201)
      ).body;
      r = await orderEta(order.id);
      expect(r.delivery.estimatedAt).toBe(when.toISOString());
      expect(r.delivery.basis.join('|')).toMatch(/Latest scheduled date/);
      await a.admin.post(`/admin/shipments/${sh.id}/ready`).expect(200);
      await w.api.post(`/staff/deliveries/${sh.id}/dispatch`, {}).expect(200);
      await w.api.post(`/staff/deliveries/${sh.id}/delivered`, {}).expect(200);
      r = await orderEta(order.id);
      const done = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(r.delivery.estimatedAt).toBe(done.deliveredAt!.toISOString());
      expect(r.delivery.basis.join('|')).toMatch(/actual delivery time/);
    }, 90_000);
  });
});
