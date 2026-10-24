import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/database/prisma.service.js';
import type { AppConfig } from '../src/config/app.config.js';
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
  currentStage,
  makeFloor,
  makeWorker,
  type Floor,
} from './support/floor.js';
import {
  approvedReferenceSample,
  createOrder,
  producedOrder,
  readyOrder,
  runBulkStage,
  standardItems,
  type ApprovedSample,
} from './support/orders.js';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000);

describe('Management intelligence: dashboard, attention, SLA, KPIs (Phase 6A, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ctx: ManagementContext;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let gate: AppConfig['orders'];
  let adminRole: Api;
  let qc: Api;
  let sales: Api;
  let finance: Api;
  let sewing: Api;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ctx = app.get(ManagementContext);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    gate = app.get(ConfigService).getOrThrow<AppConfig>('app').orders;
    const role = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
    adminRole = api(app, role.accessToken);
    qc = floor.qc.api;
    sales = a.sales;
    finance = a.finance;
    sewing = a.sewing;
  });
  afterEach(() => ctx.freeze(null));
  afterAll(async () => {
    gate.requireAcceptedQuotation = false;
    await app.close();
  });

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
  const attention = async (type?: string, who: Api = a.admin) =>
    (
      await who
        .get(
          `/admin/management/needs-attention?limit=200${type ? `&type=${type}` : ''}`,
        )
        .expect(200)
    ).body as {
      summary: {
        total: number;
        byType: Record<string, number>;
        bySeverity: Record<string, number>;
      };
      items: {
        type: string;
        severity: string;
        score: number;
        entityType: string;
        entityId: string;
        reference: string;
        title: string;
        reason: string;
        priority: string;
        responsible: { department: string | null; users: { id: string }[] };
        ageMinutes: number | null;
        dueAt: string | null;
        context: Record<string, string>;
      }[];
    };
  const item = async (type: string, entityId: string, who: Api = a.admin) =>
    (await attention(type, who)).items.find((i) => i.entityId === entityId);
  const kpi = async (name: string, who: Api = a.admin) =>
    (await who.get(`/admin/management/kpis/${name}`).expect(200)).body;
  const block = (stageId: string) =>
    a.admin
      .post(`/admin/job-stages/${stageId}/blockers`, {
        type: 'MATERIAL_UNAVAILABLE',
        description: 'Fabric not delivered',
      })
      .expect(201);
  const egp = (c: { byCurrency: { currency: string }[] }) =>
    (c.byCurrency.find((x) => x.currency === 'EGP') ?? {
      ordersWithAcceptedQuotation: 0,
      acceptedQuotationValue: '0.00',
      verifiedPayments: '0.00',
      outstandingBalance: '0.00',
      overpaidAmount: '0.00',
    }) as Record<string, string | number>;
  const money = (v: unknown) => Number(v);

  // ───────────────────────── permissions ─────────────────────────
  describe('permissions', () => {
    it('factory floor roles have no executive dashboard or analytics', async () => {
      for (const path of [
        '/admin/dashboard',
        '/admin/management/needs-attention',
        '/admin/management/kpis/production',
        '/admin/management/kpis/commercial',
        '/admin/management/workload/departments',
        '/admin/management/capacity/utilization',
        '/admin/management/sla-rules',
        '/admin/management/bottlenecks',
      ])
        await sewing.get(path).expect(403);
      await sewing.get('/staff/my-workload').expect(200); // their own workload is theirs to see
    });

    it('finance sees commercial figures, not production analytics', async () => {
      const d = (await finance.get('/admin/dashboard').expect(200)).body;
      expect(d.commercial).toBeDefined();
      expect(d.production).toBeUndefined();
      expect(d.quality).toBeUndefined();
      expect(d.workload).toBeUndefined();
      await finance.get('/admin/management/kpis/commercial').expect(200);
      await finance.get('/admin/management/kpis/production').expect(403);
      await finance.get('/admin/management/kpis/quality').expect(403);
      const types = (await attention(undefined, finance)).items.map(
        (i) => i.type,
      );
      expect(types).not.toContain('FAILED_QC');
      expect(types).not.toContain('OPEN_REWORK');
    });

    it('sales sees the order / production overview but never finance numbers', async () => {
      const d = (await sales.get('/admin/dashboard').expect(200)).body;
      expect(d.production).toBeDefined();
      expect(d.orders).toBeDefined();
      expect(d.delivery).toBeDefined();
      expect(d.commercial).toBeUndefined();
      expect(JSON.stringify(d)).not.toMatch(
        /byCurrency|acceptedQuotationValue|verifiedPayments/,
      );
      await sales.get('/admin/management/kpis/commercial').expect(403);
      await sales.get('/admin/management/kpis/quality').expect(403);
      await sales.get('/admin/management/workload/staff').expect(403);
      await sales.get('/admin/management/capacity/departments').expect(403);
      await sales.post('/admin/management/sla-rules', {}).expect(403);
      const types = (await attention(undefined, sales)).items.map(
        (i) => i.type,
      );
      for (const t of [
        'PAYMENT_BLOCK',
        'COMMERCIAL_REAPPROVAL_REQUIRED',
        'FAILED_QC',
        'OPEN_REWORK',
      ])
        expect(types).not.toContain(t);
    });

    it('QC sees quality KPIs only', async () => {
      await qc.get('/admin/management/kpis/quality').expect(200);
      await qc.get('/admin/dashboard').expect(403);
      await qc.get('/admin/management/kpis/production').expect(403);
      await qc.get('/admin/management/kpis/commercial').expect(403);
    });

    it('the ADMIN role sees everything', async () => {
      const d = (await adminRole.get('/admin/dashboard').expect(200)).body;
      for (const k of [
        'needsAttention',
        'pipeline',
        'production',
        'orders',
        'quality',
        'workload',
        'commercial',
        'delivery',
      ])
        expect(d[k]).toBeDefined();
    });

    it('a custom role with only dashboard.read gets the bare dashboard', async () => {
      const u = await createUserAndLogin(app, {
        permissions: ['dashboard.read'],
      });
      const d = (
        await api(app, u.accessToken).get('/admin/dashboard').expect(200)
      ).body;
      expect(Object.keys(d).sort()).toEqual([
        'generatedAt',
        'needsAttention',
        'pipeline',
        'timezone',
      ]);
    });

    it('anonymous callers are rejected', async () => {
      await api(app, 'nope').get('/admin/dashboard').expect(401);
    });
  });

  // ───────────────────────── dashboard ─────────────────────────
  describe('dashboard', () => {
    it('reports pipelines and KPIs consistent with the dedicated endpoints', async () => {
      const d = (await a.admin.get('/admin/dashboard').expect(200)).body;
      expect(d.timezone).toBe('Asia/Kolkata');
      expect(Object.keys(d.pipeline.samples)).toEqual(
        expect.arrayContaining([
          'draft',
          'review',
          'production',
          'awaitingApproval',
          'approved',
        ]),
      );
      expect(Object.keys(d.pipeline.orders)).toEqual(
        expect.arrayContaining([
          'draft',
          'confirmed',
          'ready',
          'production',
          'packaging',
          'delivery',
          'completed',
        ]),
      );
      const p = await kpi('production');
      expect(d.production.activeJobs).toBe(p.activeJobs);
      expect(d.production.blockedJobs).toBe(p.blockedJobs);
      expect(
        d.workload.map((w: { department: string }) => w.department),
      ).toEqual(
        expect.arrayContaining([
          'FABRIC',
          'SEWING',
          'QC',
          'PACKAGING',
          'DELIVERY',
        ]),
      );
    });

    it('counts a new ready order and a blocked job', async () => {
      const before = (await a.admin.get('/admin/dashboard').expect(200)).body;
      const { order, job } = await newJob();
      const st = await stage(job.id);
      await block(st.id);
      const after = (await a.admin.get('/admin/dashboard').expect(200)).body;
      expect(after.pipeline.orders.ready).toBe(
        before.pipeline.orders.ready + 1,
      );
      expect(after.production.blockedJobs).toBe(
        before.production.blockedJobs + 1,
      );
      expect(after.production.activeJobs).toBe(
        before.production.activeJobs + 1,
      );
      expect(after.needsAttention.summary.total).toBeGreaterThan(
        before.needsAttention.summary.total,
      );
      expect(order.id).toBeTruthy();
    });

    it('validates the date range', async () => {
      await a.admin
        .get('/admin/management/kpis/production?from=2027-03-05&to=2027-03-01')
        .expect(400);
      await a.admin
        .get('/admin/management/kpis/production?from=2020-01-01&to=2027-03-01')
        .expect(400); // too long
      await a.admin
        .get('/admin/management/kpis/production?from=garbage')
        .expect(400);
      await a.admin
        .get('/admin/management/kpis/production?from=2027-03-01&to=2027-03-02')
        .expect(200);
    });
  });

  // ───────────────────────── needs attention ─────────────────────────
  describe('needs attention', () => {
    it('lists a blocked stage with its context and ranks urgent above normal', async () => {
      const urgent = await newJob('URGENT');
      const normal = await newJob('NORMAL');
      const su = await stage(urgent.job.id);
      const sn = await stage(normal.job.id);
      await block(su.id);
      await block(sn.id);
      const res = await attention('BLOCKED_STAGE');
      const iu = res.items.find((i) => i.entityId === su.id)!;
      const inn = res.items.find((i) => i.entityId === sn.id)!;
      expect(iu).toMatchObject({
        type: 'BLOCKED_STAGE',
        severity: 'CRITICAL', // 700 + 200 urgent
        entityType: 'JOB_STAGE',
        reference: urgent.job.jobNumber,
        priority: 'URGENT',
        reason: 'Fabric not delivered',
      });
      expect(iu.responsible.department).toBe('FABRIC');
      expect(iu.context).toMatchObject({
        jobId: urgent.job.id,
        stageId: su.id,
        orderId: urgent.order.id,
        orderNumber: urgent.order.orderNumber,
      });
      expect(iu.ageMinutes).toBeGreaterThanOrEqual(0);
      expect(inn.severity).toBe('WARNING');
      expect(iu.score).toBeGreaterThan(inn.score);
      expect(res.items.indexOf(iu)).toBeLessThan(res.items.indexOf(inn));
    });

    it('lists an unassigned ready stage until someone is assigned', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      expect(await item('UNASSIGNED_READY_STAGE', st.id)).toMatchObject({
        entityType: 'JOB_STAGE',
        reference: job.jobNumber,
      });
      await a.admin
        .post(`/admin/job-stages/${st.id}/assignments`, {
          userId: floor.fabric.id,
        })
        .expect(201);
      expect(await item('UNASSIGNED_READY_STAGE', st.id)).toBeUndefined();
    });

    it('lists a delayed stage, and drops it once the stage is completed', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: hoursAgo(3) },
      });
      const hit = (await item('DELAYED_STAGE', st.id))!;
      expect(hit.reason).toMatch(/Not started .*3h past its due date/);
      expect(hit.dueAt).toBeTruthy();
      const done = await runBulkStage(
        app,
        a,
        floor,
        job.id,
        'FABRIC_PREPARATION',
      );
      expect(done.status).toBe(200);
      expect(await item('DELAYED_STAGE', st.id)).toBeUndefined(); // a completed stage is not "delayed"
    });

    it('lists a delayed packaging stage as PACKAGING_DELAY', async () => {
      const { job } = await newJob();
      for (const code of [
        'FABRIC_PREPARATION',
        'PATTERN_MAKING',
        'CUTTING',
        'QC_GATE_1',
        'PRINTING_EMBROIDERY',
        'QC_GATE_2',
        'SEWING',
        'QC_GATE_3',
      ])
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      const pack = await stage(job.id, 'PACKAGING');
      expect(pack.status).toBe('READY');
      await prisma.jobStage.update({
        where: { id: pack.id },
        data: { dueAt: hoursAgo(2) },
      });
      expect(await item('PACKAGING_DELAY', pack.id)).toMatchObject({
        type: 'PACKAGING_DELAY',
        responsible: { department: 'PACKAGING' },
      });
      expect(await item('DELAYED_STAGE', pack.id)).toBeUndefined();
    }, 60_000);

    it('lists overdue and approaching jobs and overdue orders', async () => {
      const late = await newJob();
      await prisma.factoryJob.update({
        where: { id: late.job.id },
        data: { targetCompletionDate: hoursAgo(26) },
      });
      const overdue = (await item('OVERDUE_JOB', late.job.id))!;
      expect(overdue).toMatchObject({
        entityType: 'JOB',
        reference: late.job.jobNumber,
      });
      expect(await item('APPROACHING_DEADLINE', late.job.id)).toBeUndefined();

      const soon = await newJob();
      await prisma.factoryJob.update({
        where: { id: soon.job.id },
        data: { targetCompletionDate: hoursAhead(10) },
      });
      expect(await item('APPROACHING_DEADLINE', soon.job.id)).toMatchObject({
        entityType: 'JOB',
        severity: 'INFO',
      });
      expect(await item('OVERDUE_JOB', soon.job.id)).toBeUndefined();

      await prisma.order.update({
        where: { id: late.order.id },
        data: { targetDeliveryDate: hoursAgo(50) },
      });
      const o = (await item('OVERDUE_ORDER', late.order.id))!;
      expect(o).toMatchObject({
        entityType: 'ORDER',
        reference: late.order.orderNumber,
      });
      expect(o.reason).toMatch(/2 day\(s\) ago/);
      expect(o.score).toBeGreaterThanOrEqual(650 + 200 + 20); // base + urgent + 2 overdue days
    });

    it('lists a failed QC and the open rework it created', async () => {
      const { job } = await newJob();
      for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING', 'CUTTING'])
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      const qcStage = await stage(job.id, 'QC_GATE_1');
      expect(
        (
          await runBulkStage(app, a, floor, job.id, 'QC_GATE_1', {
            failUnits: 5,
          })
        ).status,
      ).toBe(200);
      const insp = await prisma.qcInspection.findFirstOrThrow({
        where: { jobStageId: qcStage.id },
      });
      const rework = await prisma.reworkRecord.findFirstOrThrow({
        where: { jobId: job.id },
      });
      expect(await item('FAILED_QC', insp.id)).toMatchObject({
        entityType: 'QC_INSPECTION',
        reason: '5 unit(s) failed QC',
        reference: job.jobNumber,
      });
      expect(await item('OPEN_REWORK', rework.id)).toMatchObject({
        entityType: 'REWORK',
        reference: job.jobNumber,
      });
      // the quality items are visible to callers who hold quality_kpis.read, and hidden from sales
      expect(await item('FAILED_QC', insp.id, sales)).toBeUndefined();
      expect(await item('OPEN_REWORK', rework.id, sales)).toBeUndefined();
      expect(await item('FAILED_QC', insp.id, adminRole)).toBeDefined();
    }, 60_000);

    it('lists failed and late shipments', async () => {
      const { order } = await producedOrder(app, a, floor, s, {
        priority: 'URGENT',
      });
      const w = await makeWorker(app, 'DELIVERY');
      const addr = await prisma.customerAddress.create({
        data: {
          customerId: s.customerId,
          country: 'Egypt',
          city: 'Cairo',
          addressLine1: '1 Test St',
        },
      });
      const mk = async (variant: number, qty: number) =>
        (
          await a.admin
            .post(`/admin/orders/${order.id}/shipments`, {
              deliveryMethod: 'OWN_DELIVERY',
              recipientName: 'Mona',
              recipientPhone: '+201001112233',
              customerAddressId: addr.id,
              assignedDeliveryUserId: w.id,
              lines: [
                {
                  orderVariantId: order.items[0]!.variants[variant]!.id,
                  quantity: qty,
                },
              ],
            })
            .expect(201)
        ).body as { id: string; shipmentNumber: string };
      const failing = await mk(0, 60);
      const slow = await mk(1, 40);
      for (const sh of [failing, slow]) {
        await a.admin.post(`/admin/shipments/${sh.id}/ready`).expect(200);
        await w.api.post(`/staff/deliveries/${sh.id}/dispatch`, {}).expect(200);
      }
      await w.api
        .post(`/staff/deliveries/${failing.id}/failed`, {
          reason: 'Nobody home',
        })
        .expect(200);
      await prisma.shipment.update({
        where: { id: slow.id },
        data: { scheduledAt: hoursAgo(5) },
      });

      const f = (await item('SHIPMENT_FAILED', failing.id))!;
      expect(f).toMatchObject({
        entityType: 'SHIPMENT',
        reason: 'Nobody home',
        severity: 'CRITICAL',
        reference: failing.shipmentNumber,
      });
      expect(f.responsible).toMatchObject({ department: 'DELIVERY' });
      const d = (await item('DELIVERY_DELAY', slow.id))!;
      expect(d.reason).toMatch(/5h past its scheduled date/);
      expect(await item('DELIVERY_DELAY', failing.id)).toBeUndefined(); // failed ones are reported as failed
    }, 90_000);

    it('lists orders blocked by the commercial gate and orders needing a new quotation', async () => {
      gate.requireAcceptedQuotation = true;
      try {
        // no accepted quotation at all
        const bare = await readyOrderConfirmed();
        const block1 = (await item('PAYMENT_BLOCK', bare.id))!;
        expect(block1.reason).toMatch(/no accepted quotation/);
        expect(block1.responsible.department).toBe('FINANCE');
        expect(await item('PAYMENT_BLOCK', bare.id, sales)).toBeUndefined(); // sales may not see commercial items
        expect(await item('PAYMENT_BLOCK', bare.id, finance)).toBeDefined();

        // accepted but unpaid, then a commercial revision
        const o = await readyOrderConfirmed();
        const v = await quoteOrder(o.id, 100);
        await a.sales
          .post(`/admin/order-quotation-versions/${v}/accept`, {
            sourceNote: 'WhatsApp',
          })
          .expect(200);
        expect((await item('PAYMENT_BLOCK', o.id))!.reason).toMatch(
          /must be verified/,
        );
        await a.admin
          .post(`/admin/orders/${o.id}/revise`, {
            reason: 'more units',
            items: standardItems(s, 80, 40),
          })
          .expect(200);
        const re = (await item('COMMERCIAL_REAPPROVAL_REQUIRED', o.id))!;
        expect(re).toMatchObject({
          entityType: 'ORDER',
          responsible: { department: 'SALES' },
        });
        expect(re.reason).toMatch(/no longer applies/);
        expect(await item('PAYMENT_BLOCK', o.id)).toBeUndefined(); // reported once, as re-approval
      } finally {
        gate.requireAcceptedQuotation = false;
      }
    });

    it('filters by type, minimum severity and limit; totals match the items', async () => {
      const all = await attention();
      expect(all.summary.total).toBeGreaterThanOrEqual(all.items.length);
      const critical = (
        await a.admin
          .get(
            '/admin/management/needs-attention?minSeverity=CRITICAL&limit=200',
          )
          .expect(200)
      ).body;
      expect(
        critical.items.every(
          (i: { severity: string }) => i.severity === 'CRITICAL',
        ),
      ).toBe(true);
      const two = (
        await a.admin
          .get('/admin/management/needs-attention?limit=2')
          .expect(200)
      ).body;
      expect(two.items).toHaveLength(2);
      const blocked = await attention('BLOCKED_STAGE');
      expect(blocked.items.every((i) => i.type === 'BLOCKED_STAGE')).toBe(true);
      expect(blocked.summary.byType.BLOCKED_STAGE).toBe(blocked.items.length);
      // ordered by score, descending
      const scores = all.items.map((i) => i.score);
      expect([...scores].sort((x, y) => y - x)).toEqual(scores);
      await a.admin
        .get('/admin/management/needs-attention?type=NOPE')
        .expect(400);
    });
  });

  const readyOrderConfirmed = async () => {
    const o = await createOrder(a.sales, s.sampleId, {
      items: standardItems(s),
      priority: 'URGENT',
    });
    await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
    return o;
  };
  const quoteOrder = async (orderId: string, qty: number, unit = 40) => {
    const q = (
      await a.sales
        .post(`/admin/orders/${orderId}/quotations`, {
          lineItems: [
            {
              type: 'PRINTING',
              description: 'Print',
              quantity: qty,
              unitPrice: unit,
            },
          ],
        })
        .expect(201)
    ).body;
    await a.sales
      .post(`/admin/quotation-versions/${q.currentVersion.id}/send`)
      .expect(200);
    return q.currentVersion.id as string;
  };
  const payAndVerify = async (orderId: string, amount: number) => {
    const proof = (
      await a.sales.upload('PAYMENT_PROOF', 'receipt.png').expect(201)
    ).body;
    const id = (
      await a.sales
        .post(`/admin/orders/${orderId}/payments`, {
          amount,
          method: 'INSTAPAY',
          proofAssetId: proof.id,
        })
        .expect(201)
    ).body.id as string;
    await a.finance.post(`/admin/payments/${id}/verify`).expect(200);
  };

  // ───────────────────────── SLA and delay ─────────────────────────
  describe('SLA and delay evaluation', () => {
    const FIXED = new Date('2030-01-15T12:00:00Z');
    const m = (min: number) => new Date(FIXED.getTime() + min * 60_000);
    const stageSla = async (jobId: string, stageId: string) => {
      const r = (
        await a.admin.get(`/admin/management/jobs/${jobId}/delay`).expect(200)
      ).body;
      return {
        job: r,
        sla: r.stages.find((x: { stageId: string }) => x.stageId === stageId)
          .sla,
      };
    };
    const setStage = (id: string, data: Record<string, unknown>) =>
      prisma.jobStage.update({ where: { id }, data });
    const farTarget = (jobId: string) =>
      prisma.factoryJob.update({
        where: { id: jobId },
        data: { targetCompletionDate: m(60 * 24 * 30) },
      });

    it('on-time stage', async () => {
      ctx.freeze(FIXED);
      const { job } = await newJob();
      const st = await stage(job.id);
      await farTarget(job.id);
      await setStage(st.id, {
        readyAt: m(-60),
        dueAt: m(120),
        expectedDurationMinutes: 180,
      });
      const { sla, job: j } = await stageSla(job.id, st.id);
      expect(sla).toMatchObject({
        state: 'ON_TRACK',
        deadlineSource: 'DUE_AT',
        remainingMinutes: 120,
        elapsedMinutes: 60,
        breached: false,
        warning: false,
        expectedDurationMinutes: 180,
        actualDurationMinutes: null,
      });
      expect(j.isDelayed).toBe(false);
      expect(j.delayReasons).toEqual([]);
    });

    it('warning stage', async () => {
      ctx.freeze(FIXED);
      const { job } = await newJob();
      const st = await stage(job.id);
      await farTarget(job.id);
      await setStage(st.id, {
        readyAt: m(-50),
        dueAt: m(10),
        expectedDurationMinutes: 60,
      }); // 20% of 60 = 12 ≥ 10
      const { sla, job: j } = await stageSla(job.id, st.id);
      expect(sla).toMatchObject({
        state: 'WARNING',
        warning: true,
        remainingMinutes: 10,
        breached: false,
      });
      expect(j.isDelayed).toBe(false); // warning is not a delay
    });

    it('breached stage makes the job delayed with a reason', async () => {
      ctx.freeze(FIXED);
      const { job } = await newJob();
      const st = await stage(job.id);
      await farTarget(job.id);
      await setStage(st.id, {
        readyAt: m(-100),
        dueAt: m(-30),
        expectedDurationMinutes: 60,
      });
      const { sla, job: j } = await stageSla(job.id, st.id);
      expect(sla).toMatchObject({
        state: 'BREACHED',
        breached: true,
        breachMinutes: 30,
        remainingMinutes: null,
      });
      expect(j).toMatchObject({ isDelayed: true, delayMinutes: 30 });
      expect(j.delayReasons[0]).toMatchObject({
        code: 'STAGE_OVERDUE',
        minutes: 30,
        refs: [st.id],
      });
    });

    it('a blocked stage and an unresolved blocker delay the job', async () => {
      ctx.freeze(FIXED);
      const { job } = await newJob();
      const st = await stage(job.id);
      await farTarget(job.id);
      await block(st.id);
      const r = (
        await a.admin.get(`/admin/management/jobs/${job.id}/delay`).expect(200)
      ).body;
      expect(r.isDelayed).toBe(true);
      expect(r.delayReasons.map((x: { code: string }) => x.code)).toContain(
        'OPEN_BLOCKER',
      );
      expect(r.status).toBe('BLOCKED');
    });

    it('a target date in the past delays the job', async () => {
      ctx.freeze(FIXED);
      const { job } = await newJob();
      await prisma.factoryJob.update({
        where: { id: job.id },
        data: { targetCompletionDate: m(-90) },
      });
      const r = (
        await a.admin.get(`/admin/management/jobs/${job.id}/delay`).expect(200)
      ).body;
      expect(r.delayReasons.map((x: { code: string }) => x.code)).toContain(
        'TARGET_DATE_EXCEEDED',
      );
      expect(r.sla).toMatchObject({ state: 'BREACHED', breachMinutes: 90 });
      expect(r.deadlineSource).toBe('TARGET_DATE');
    });

    it('a completed stage is never falsely delayed, even with an old due date', async () => {
      const { job } = await newJob();
      const st = await stage(job.id);
      await farTarget(job.id);
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      await setStage(st.id, {
        dueAt: new Date(Date.now() - 86_400_000),
        expectedDurationMinutes: 30,
      });
      ctx.freeze(new Date(Date.now() + 5 * 86_400_000));
      const { sla, job: j } = await stageSla(job.id, st.id);
      expect(sla.state).toBe('COMPLETED_LATE'); // history says it was late …
      expect(sla.actualDurationMinutes).toBeGreaterThanOrEqual(0);
      expect(sla.remainingMinutes).toBeNull();
      // … but it is not a current delay (the next stage is ready and still within its own due date)
      expect(
        j.delayReasons.filter((x: { refs: string[] }) =>
          x.refs.includes(st.id),
        ),
      ).toEqual([]);
    });

    it('a delayed order reports its job, date and shipment reasons; an on-time order does not', async () => {
      ctx.freeze(FIXED);
      const late = await newJob();
      const st = await stage(late.job.id);
      await setStage(st.id, { readyAt: m(-100), dueAt: m(-30) });
      await prisma.order.update({
        where: { id: late.order.id },
        data: { targetDeliveryDate: m(-60 * 24 * 2) },
      });
      const r = (
        await a.admin
          .get(`/admin/management/orders/${late.order.id}/delay`)
          .expect(200)
      ).body;
      expect(r).toMatchObject({
        isDelayed: true,
        delayDays: 2,
        deadlineSource: 'TARGET_DATE',
      });
      expect(
        r.delayReasons.map((x: { code: string }) => x.code).sort(),
      ).toEqual(['DELIVERY_DATE_EXCEEDED', 'JOB_DELAYED']);
      expect(r.sla.state).toBe('BREACHED');

      const fine = await newJob();
      await prisma.jobStage.updateMany({
        where: { jobId: fine.job.id },
        data: { dueAt: m(60 * 24 * 10) },
      });
      await prisma.factoryJob.update({
        where: { id: fine.job.id },
        data: { targetCompletionDate: m(60 * 24 * 10) },
      });
      await prisma.order.update({
        where: { id: fine.order.id },
        data: { targetDeliveryDate: m(60 * 24 * 20) },
      });
      const ok = (
        await a.admin
          .get(`/admin/management/orders/${fine.order.id}/delay`)
          .expect(200)
      ).body;
      expect(ok).toMatchObject({
        isDelayed: false,
        delayMinutes: 0,
        delayReasons: [],
      });
    });

    it('an SLA rule overrides the stage deadline, and a deactivated rule stops applying', async () => {
      ctx.freeze(FIXED);
      const def = await prisma.productionStageDefinition.findUniqueOrThrow({
        where: { code: 'FABRIC_PREPARATION' },
      });
      const { job } = await newJob();
      const st = await stage(job.id);
      await farTarget(job.id);
      await setStage(st.id, {
        readyAt: m(-45),
        dueAt: m(500),
        expectedDurationMinutes: 600,
      });
      const code = `T_STAGE_${Date.now()}`;
      const rule = (
        await a.admin
          .post('/admin/management/sla-rules', {
            code,
            name: 'Fabric prep within 30 min',
            targetType: 'STAGE',
            stageDefinitionId: def.id,
            thresholdMinutes: 30,
            warningBeforeMinutes: 5,
            priorityMultipliers: { URGENT: 2 },
          })
          .expect(201)
      ).body;
      try {
        const { sla } = await stageSla(job.id, st.id);
        // URGENT doubles the threshold: 60 min from readyAt (−45) → 15 min left, inside the 5 min? no → ON_TRACK
        expect(sla).toMatchObject({
          deadlineSource: 'RULE',
          expectedDurationMinutes: 60,
          state: 'ON_TRACK',
          remainingMinutes: 15,
        });
        await a.admin
          .put(`/admin/management/sla-rules/${rule.id}`, {
            thresholdMinutes: 20,
            priorityMultipliers: null,
          })
          .expect(200);
        const breached = (await stageSla(job.id, st.id)).sla;
        expect(breached).toMatchObject({
          state: 'BREACHED',
          breachMinutes: 25,
          deadlineSource: 'RULE',
        });
      } finally {
        await a.admin
          .post(`/admin/management/sla-rules/${rule.id}/deactivate`)
          .expect(200);
      }
      const after = (await stageSla(job.id, st.id)).sla;
      expect(after.deadlineSource).toBe('DUE_AT');
    });
  });

  // ───────────────────────── SLA rule configuration ─────────────────────────
  describe('SLA rule configuration', () => {
    it('creates, updates and deactivates with audit; refuses a second active rule for the same target', async () => {
      const code = `T_JOB_${Date.now()}`;
      const rule = (
        await a.admin
          .post('/admin/management/sla-rules', {
            code,
            name: 'Job lead time',
            targetType: 'JOB',
            thresholdMinutes: 4320,
          })
          .expect(201)
      ).body;
      expect(rule).toMatchObject({
        code,
        targetType: 'JOB',
        thresholdMinutes: 4320,
        active: true,
      });
      try {
        await a.admin
          .post('/admin/management/sla-rules', {
            code: `${code}_2`,
            name: 'Twin',
            targetType: 'JOB',
            thresholdMinutes: 100,
          })
          .expect(409);
        await a.admin
          .post('/admin/management/sla-rules', {
            code,
            name: 'Dup',
            targetType: 'ORDER',
            thresholdMinutes: 1,
          })
          .expect(409);
        await a.admin
          .post('/admin/management/sla-rules', {
            code: `${code}_3`,
            name: 'Bad',
            targetType: 'JOB',
            thresholdMinutes: 10,
            warningBeforeMinutes: 10,
            active: false,
          })
          .expect(400);
        await a.admin
          .post('/admin/management/sla-rules', {
            code: `${code}_4`,
            name: 'Bad',
            targetType: 'JOB',
            thresholdMinutes: 10,
            stageDefinitionId: '5c7e1b88-0000-4000-8000-000000000000',
            active: false,
          })
          .expect(400); // stage definition only for STAGE rules
        await a.admin
          .put(`/admin/management/sla-rules/${rule.id}`, {
            thresholdMinutes: 2880,
            priorityMultipliers: { URGENT: 0.5 },
          })
          .expect(200);
        await a.admin
          .put(`/admin/management/sla-rules/${rule.id}`, {
            priorityMultipliers: { URGENT: 0 },
          })
          .expect(400);
        await a.admin
          .put(`/admin/management/sla-rules/${rule.id}`, {})
          .expect(400);
        const list = (
          await sales
            .get('/admin/management/sla-rules?targetType=JOB&active=true')
            .expect(200)
        ).body;
        expect(
          list.find((r: { id: string }) => r.id === rule.id),
        ).toMatchObject({
          thresholdMinutes: 2880,
          priorityMultipliers: { URGENT: 0.5 },
        });
      } finally {
        const off = (
          await a.admin
            .post(`/admin/management/sla-rules/${rule.id}/deactivate`)
            .expect(200)
        ).body;
        expect(off.active).toBe(false);
      }
      expect(await auditActions(app, rule.id)).toEqual([
        'sla_rule.created',
        'sla_rule.updated',
        'sla_rule.deactivated',
      ]);
      await a.admin.get(`/admin/management/sla-rules/${rule.id}`).expect(200);
      await sales.post('/admin/management/sla-rules', {}).expect(403);
    });

    it('a job SLA rule applies when the job has no target date', async () => {
      ctx.freeze(new Date('2030-01-15T12:00:00Z'));
      const code = `T_JOBRULE_${Date.now()}`;
      const rule = (
        await a.admin
          .post('/admin/management/sla-rules', {
            code,
            name: 'Job 1 day',
            targetType: 'JOB',
            thresholdMinutes: 1440,
          })
          .expect(201)
      ).body;
      try {
        const { job } = await newJob();
        await prisma.factoryJob.update({
          where: { id: job.id },
          data: { targetCompletionDate: null },
        });
        const r = (
          await a.admin
            .get(`/admin/management/jobs/${job.id}/delay`)
            .expect(200)
        ).body;
        expect(r.deadlineSource).toBe('RULE');
        expect(r.sla.state).toBe('BREACHED'); // created now, frozen clock is in 2030
      } finally {
        await a.admin
          .post(`/admin/management/sla-rules/${rule.id}/deactivate`)
          .expect(200);
      }
    });
  });

  // ───────────────────────── KPIs ─────────────────────────
  describe('KPIs', () => {
    it('production KPIs move when a job completes on time', async () => {
      const before = await kpi('production');
      const { job } = await newJob('NORMAL');
      await prisma.factoryJob.update({
        where: { id: job.id },
        data: { targetCompletionDate: hoursAhead(72) },
      });
      for (const code of [
        'FABRIC_PREPARATION',
        'PATTERN_MAKING',
        'CUTTING',
        'QC_GATE_1',
        'PRINTING_EMBROIDERY',
        'QC_GATE_2',
        'SEWING',
        'QC_GATE_3',
      ])
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      const mid = await kpi('production');
      expect(mid.activeJobs).toBe(before.activeJobs + 1);
      const packaged = await runBulkStage(app, a, floor, job.id, 'PACKAGING');
      expect(packaged.status).toBe(200);
      expect((await runBulkStage(app, a, floor, job.id, 'READY')).status).toBe(
        200,
      );
      const after = await kpi('production');
      expect(after.completedJobs).toBe(before.completedJobs + 1);
      expect(after.completedToday).toBe(before.completedToday + 1);
      expect(after.completedThisWeek).toBe(before.completedThisWeek + 1);
      expect(after.activeJobs).toBe(before.activeJobs);
      expect(after.onTimeCompletion.measured).toBe(
        before.onTimeCompletion.measured + 1,
      );
      expect(after.onTimeCompletion.onTime).toBe(
        before.onTimeCompletion.onTime + 1,
      );
      expect(after.averageLeadTimeMinutes).not.toBeNull();
      expect(after.averageStageDurationMinutes).not.toBeNull();
      expect(after.range.from).toBeTruthy();
      expect(after.timezone).toBe('Asia/Kolkata');
    }, 90_000);

    it('"today" follows the business time zone', async () => {
      // 20:00 UTC on 2030-01-15 is 01:30 on the 16th in Kolkata: "today" starts at 18:30 UTC on the 15th
      ctx.freeze(new Date('2030-01-15T20:00:00Z'));
      const w = (await a.admin.get('/admin/management/wip').expect(200)).body;
      expect(w.todayStartsAt).toBe('2030-01-15T18:30:00.000Z');
      ctx.freeze(new Date('2030-01-15T18:29:00Z'));
      expect(
        (await a.admin.get('/admin/management/wip').expect(200)).body
          .todayStartsAt,
      ).toBe('2030-01-14T18:30:00.000Z');
    });

    it('order KPIs: statuses, delivery on time and cycle time', async () => {
      const before = await kpi('orders');
      const { order } = await producedOrder(app, a, floor, s);
      await prisma.order.update({
        where: { id: order.id },
        data: { targetDeliveryDate: hoursAhead(48) },
      });
      const mid = await kpi('orders');
      expect(mid.current.readyForDelivery).toBe(
        before.current.readyForDelivery + 1,
      );
      const w = await makeWorker(app, 'DELIVERY');
      const addr = await prisma.customerAddress.create({
        data: {
          customerId: s.customerId,
          country: 'Egypt',
          city: 'Cairo',
          addressLine1: '2 Test St',
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
            lines: order.items[0]!.variants.map((v) => ({
              orderVariantId: v.id,
              quantity: v.quantity,
            })),
          })
          .expect(201)
      ).body as { id: string };
      const dBefore = await kpi('delivery');
      await a.admin.post(`/admin/shipments/${sh.id}/ready`).expect(200);
      const dReady = await kpi('delivery');
      expect(dReady.shipments.ready).toBe(dBefore.shipments.ready + 1);
      await w.api.post(`/staff/deliveries/${sh.id}/dispatch`, {}).expect(200);
      const dSent = await kpi('delivery');
      expect(dSent.shipments.ready).toBe(dBefore.shipments.ready);
      expect(dSent.shipments.dispatched).toBe(dBefore.shipments.dispatched + 1);
      await w.api.post(`/staff/deliveries/${sh.id}/in-transit`).expect(200);
      expect((await kpi('delivery')).shipments.inTransit).toBe(
        dBefore.shipments.inTransit + 1,
      );
      await w.api.post(`/staff/deliveries/${sh.id}/delivered`, {}).expect(200);
      const dDone = await kpi('delivery');
      expect(dDone.shipments.deliveredInRange).toBe(
        dBefore.shipments.deliveredInRange + 1,
      );
      expect(dDone.dispatchToDeliveryMeasured).toBe(
        dBefore.dispatchToDeliveryMeasured + 1,
      );
      expect(dDone.averageDispatchToDeliveryMinutes).not.toBeNull();
      const after = await kpi('orders');
      expect(after.inRange.delivered).toBe(before.inRange.delivered + 1);
      expect(after.onTimeDelivery.measured).toBe(
        before.onTimeDelivery.measured + 1,
      );
      expect(after.onTimeDelivery.onTime).toBe(
        before.onTimeDelivery.onTime + 1,
      );
      expect(after.averageCycleTimeMinutes).not.toBeNull();
      expect(after.current.delivered).toBe(before.current.delivered + 1);
    }, 90_000);

    it('delivery KPIs count failed deliveries and partial-delivery orders', async () => {
      const before = await kpi('delivery');
      const { order } = await producedOrder(app, a, floor, s);
      const w = await makeWorker(app, 'DELIVERY');
      const addr = await prisma.customerAddress.create({
        data: {
          customerId: s.customerId,
          country: 'Egypt',
          city: 'Giza',
          addressLine1: '3 Test St',
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
              { orderVariantId: order.items[0]!.variants[0]!.id, quantity: 10 },
            ],
          })
          .expect(201)
      ).body as { id: string };
      await a.admin.post(`/admin/shipments/${sh.id}/ready`).expect(200);
      await w.api.post(`/staff/deliveries/${sh.id}/dispatch`, {}).expect(200);
      await w.api.post(`/staff/deliveries/${sh.id}/delivered`, {}).expect(200);
      const mid = await kpi('delivery');
      expect(mid.partialDeliveryOrders).toBe(before.partialDeliveryOrders + 1); // 10 of 100 delivered
      expect(mid.shipments.deliveredInRange).toBe(
        before.shipments.deliveredInRange + 1,
      );
    }, 90_000);

    it('quality KPIs: QC results, rework, rejected units and failures by stage', async () => {
      const before = await kpi('quality');
      const { job } = await newJob('NORMAL');
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      expect(
        (await runBulkStage(app, a, floor, job.id, 'PATTERN_MAKING')).status,
      ).toBe(200);
      expect(
        (await runBulkStage(app, a, floor, job.id, 'CUTTING', { reject: 3 }))
          .status,
      ).toBe(200);
      expect(
        (
          await runBulkStage(app, a, floor, job.id, 'QC_GATE_1', {
            failUnits: 4,
          })
        ).status,
      ).toBe(200);
      const mid = await kpi('quality', qc);
      expect(mid.inspections.completed).toBe(before.inspections.completed + 1);
      expect(mid.inspections.fail).toBe(before.inspections.fail + 1);
      expect(mid.inspections.failedUnits).toBe(
        before.inspections.failedUnits + 4,
      );
      expect(mid.rework.created).toBe(before.rework.created + 1);
      expect(mid.rework.open).toBe(before.rework.open + 1);
      expect(mid.rejectedUnits).toBe(before.rejectedUnits + 3);
      const gate1Before =
        before.failuresByStage.find(
          (x: { stageCode: string }) => x.stageCode === 'QC_GATE_1',
        )?.failures ?? 0;
      expect(
        mid.failuresByStage.find(
          (x: { stageCode: string }) => x.stageCode === 'QC_GATE_1',
        ).failures,
      ).toBe(gate1Before + 1);
      expect(
        mid.inspections.failRatePercent +
          mid.inspections.passRatePercent +
          mid.inspections.conditionalPassRatePercent,
      ).toBeCloseTo(100, 0);
      expect(mid.failuresByProduct.length).toBeGreaterThan(0);
      expect(mid.repeatFailure.definition).toMatch(/failed QC more than once/);
      expect(mid.notDerived[0]).toMatch(/fabric/i);
      // a second failure of the same stage in the same job counts as a repeat
      const rework = await prisma.reworkRecord.findFirstOrThrow({
        where: { jobId: job.id },
      });
      expect(rework.status).not.toBe('RESOLVED');
    }, 90_000);

    it('commercial KPIs use Decimal per currency and follow payments and revisions', async () => {
      gate.requireAcceptedQuotation = false;
      const before = await kpi('commercial', finance);
      const o = await readyOrderConfirmed();
      const v1 = await quoteOrder(o.id, 100); // 4000.00
      await a.sales
        .post(`/admin/order-quotation-versions/${v1}/accept`, {
          sourceNote: 'WhatsApp',
        })
        .expect(200);
      let c = await kpi('commercial', finance);
      expect(
        money(egp(c).acceptedQuotationValue) -
          money(egp(before).acceptedQuotationValue),
      ).toBe(4000);
      expect(
        money(egp(c).outstandingBalance) -
          money(egp(before).outstandingBalance),
      ).toBe(4000);
      expect(c.orders.unpaid).toBe(before.orders.unpaid + 1);

      await payAndVerify(o.id, 1500.5);
      c = await kpi('commercial', finance);
      expect(
        money(egp(c).verifiedPayments) - money(egp(before).verifiedPayments),
      ).toBeCloseTo(1500.5, 2);
      expect(
        money(egp(c).outstandingBalance) -
          money(egp(before).outstandingBalance),
      ).toBeCloseTo(2499.5, 2);
      expect(c.orders.partiallyPaid).toBe(before.orders.partiallyPaid + 1);
      expect(
        c.verifiedInRange.find(
          (x: { currency: string; target: string }) =>
            x.currency === 'EGP' && x.target === 'ORDER',
        ),
      ).toBeDefined();

      await payAndVerify(o.id, 2499.5);
      c = await kpi('commercial', finance);
      expect(c.orders.paid).toBe(before.orders.paid + 1);
      expect(money(egp(c).outstandingBalance)).toBeCloseTo(
        money(egp(before).outstandingBalance),
        2,
      );

      // commercial revision: the quotation ends, the money stays
      await a.admin
        .post(`/admin/orders/${o.id}/revise`, {
          reason: 'fewer units',
          items: standardItems(s, 30, 20),
        })
        .expect(200);
      c = await kpi('commercial', finance);
      expect(c.orders.commercialReapprovalRequired).toBe(
        before.orders.commercialReapprovalRequired + 1,
      );
      expect(c.orders.withoutAcceptedQuotation).toBe(
        before.orders.withoutAcceptedQuotation + 1,
      );
      const v2 = await quoteOrder(o.id, 50); // 2000.00, below the 4000 already verified
      await a.sales
        .post(`/admin/order-quotation-versions/${v2}/accept`, {
          sourceNote: 'WhatsApp 2',
        })
        .expect(200);
      c = await kpi('commercial', finance);
      expect(c.orders.commercialReapprovalRequired).toBe(
        before.orders.commercialReapprovalRequired,
      );
      expect(
        money(egp(c).acceptedQuotationValue) -
          money(egp(before).acceptedQuotationValue),
      ).toBe(2000);
      expect(
        money(egp(c).verifiedPayments) - money(egp(before).verifiedPayments),
      ).toBe(4000);
      expect(
        money(egp(c).overpaidAmount) - money(egp(before).overpaidAmount),
      ).toBe(2000);
      expect(money(egp(c).outstandingBalance)).toBeCloseTo(
        money(egp(before).outstandingBalance),
        2,
      );
      expect(typeof egp(c).acceptedQuotationValue).toBe('string'); // Decimal strings, never floats
      expect(String(egp(c).acceptedQuotationValue)).toMatch(/^\d+\.\d{2}$/);
    }, 90_000);

    it('the commercial KPI is refused to everyone without commercial_kpis.read', async () => {
      await sales.get('/admin/management/kpis/commercial').expect(403);
      await qc.get('/admin/management/kpis/commercial').expect(403);
      await sewing.get('/admin/management/kpis/commercial').expect(403);
    });

    it('bottlenecks are ordered by accumulated waiting time and say they are descriptive', async () => {
      const r = (await a.admin.get('/admin/management/bottlenecks').expect(200))
        .body;
      expect(r.orderedBy).toBe('totalWaitMinutes');
      expect(r.caution).toMatch(/Descriptive only/);
      expect(r.stages.length).toBeGreaterThan(0);
      const waits = r.stages.map(
        (x: { totalWaitMinutes: number }) => x.totalWaitMinutes,
      );
      expect([...waits].sort((x: number, y: number) => y - x)).toEqual(waits);
      const first = r.stages[0];
      for (const k of [
        'stageCode',
        'averageDurationMinutes',
        'averageWaitBeforeStartMinutes',
        'queuedNow',
        'blockedNow',
        'overdueNow',
        'reworkRatePercent',
      ])
        expect(first).toHaveProperty(k);
      await sales.get('/admin/management/bottlenecks').expect(200);
      await qc.get('/admin/management/bottlenecks').expect(403);
    });
  });
});
