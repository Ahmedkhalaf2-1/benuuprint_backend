import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { auth, createTestApp, createUserAndLogin } from './support/app.js';
import { makePortalCustomer } from './support/customer.js';
import {
  api,
  completeDraft,
  createCustomerWithBrand,
  lookupRefs,
  makeActors,
  payAndVerify,
  quoteAndAccept,
  type Actors,
  type Refs,
} from './support/factory.js';
import {
  createJob,
  currentStage,
  jobDetail,
  makeFloor,
  makeWorker,
  runStage,
  type Floor,
  type Worker,
} from './support/floor.js';
import {
  approvedReferenceSample,
  producedOrder,
  type ApprovedSample,
} from './support/orders.js';

describe('Responsibility rules + process visibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let mahmoud: Worker; // CUTTING
  let hassan: Worker; // CUTTING
  let karim: Worker; // CUTTING
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    mahmoud = await makeWorker(app, 'CUTTING');
    hassan = await makeWorker(app, 'CUTTING');
    karim = await makeWorker(app, 'CUTTING');
    await clearRules();
  });
  // rules are global state: never leak them into other test files
  afterAll(async () => {
    await clearRules();
    await app.close();
  });

  async function clearRules() {
    await prisma.responsibilityRule.deleteMany({});
  }
  const setGlobal = (key: string, userId: string, extra: object = {}) =>
    a.admin.put(`/admin/responsibilities/${key}`, { userId, ...extra });
  const setOverride = (customerId: string, key: string, userId: string) =>
    a.admin.put(`/admin/customers/${customerId}/responsibilities/${key}`, {
      userId,
    });

  /** A paid sample for the given customer and its factory job (stages assigned by whatever rules exist now). */
  async function jobFor(customerId: string, brandId: string) {
    const draft = await completeDraft(app, a.admin, refs, {
      customerId,
      brandId,
    });
    const flow = await quoteAndAccept(a, draft);
    await payAndVerify(a.sales, a.finance, flow.sample.id, Number(flow.total));
    const job = await createJob(a.admin, flow.sample.id);
    return { job, sampleId: flow.sample.id };
  }
  const newCustomer = async () => {
    const { customer, brand } = await createCustomerWithBrand(a.admin);
    return { customerId: customer.id as string, brandId: brand.id as string };
  };
  const assignmentsOf = (stageId: string) =>
    prisma.stageAssignment.findMany({
      where: { jobStageId: stageId },
      orderBy: { assignedAt: 'asc' },
    });
  const active = async (stageId: string) =>
    (await assignmentsOf(stageId)).filter((x) => !x.removedAt);

  // ───────────────────────── defaults, precedence, auto-assignment ─────────────────────────

  it('a global default auto-assigns new jobs through the normal assignment domain and shows in My Work', async () => {
    await clearRules();
    const res = await setGlobal('CUTTING', mahmoud.id).expect(200);
    expect(res.body).toMatchObject({
      scope: 'GLOBAL',
      stageKey: 'CUTTING',
      primaryUser: { id: mahmoud.id },
      health: 'OK',
    });
    const c = await newCustomer();
    const { job } = await jobFor(c.customerId, c.brandId);
    const stage = await currentStage(a.admin, job.id, 'CUTTING');
    const rows = await active(stage.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: mahmoud.id,
      isPrimary: true,
      source: 'GLOBAL_DEFAULT',
    });
    // the same row manual assignment writes: visible in job detail, My Work, history and audit
    expect(stage.assignees.map((x) => x.userId)).toEqual([mahmoud.id]);
    const mine = (await mahmoud.api.get('/staff/my-jobs').expect(200)).body;
    expect(JSON.stringify(mine)).toContain(job.id);
    expect(
      await prisma.jobActivity.count({
        where: { jobStageId: stage.id, type: 'STAGE_ASSIGNED' },
      }),
    ).toBe(1);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'job_stage.assigned', entityId: stage.id },
    });
    expect(audit?.metadata).toMatchObject({
      auto: true,
      source: 'GLOBAL_DEFAULT',
    });
    // the overview reflects it
    const overview = (await a.admin.get('/admin/responsibilities').expect(200))
      .body;
    const cutting = overview.find(
      (x: { stageKey: string }) => x.stageKey === 'CUTTING',
    );
    expect(cutting).toMatchObject({
      source: 'GLOBAL_DEFAULT',
      health: 'OK',
      effectiveUser: { id: mahmoud.id },
    });
    expect(cutting.activeWork).toBeGreaterThanOrEqual(1);
    const unset = overview.find(
      (x: { stageKey: string }) => x.stageKey === 'SEWING',
    );
    expect(unset).toMatchObject({
      health: 'NOT_CONFIGURED',
      effectiveUser: null,
    });
  });

  it('a customer override wins for that customer only, and removing it falls back to the default', async () => {
    await clearRules();
    await setGlobal('CUTTING', mahmoud.id).expect(200);
    const abc = await newCustomer();
    const other = await newCustomer();
    await setOverride(abc.customerId, 'CUTTING', hassan.id).expect(200);

    const matrix = (
      await a.admin
        .get(`/admin/customers/${abc.customerId}/responsibilities`)
        .expect(200)
    ).body;
    const row = matrix.areas.find(
      (x: { stageKey: string }) => x.stageKey === 'CUTTING',
    );
    expect(row).toMatchObject({
      source: 'CUSTOMER_OVERRIDE',
      effectiveUser: { id: hassan.id },
      globalDefaultUser: { id: mahmoud.id },
      customerOverrideUser: { id: hassan.id },
      health: 'OK',
    });
    expect(matrix.areas.map((x: { stageKey: string }) => x.stageKey)).toContain(
      'DELIVERY',
    );

    const { job: j1 } = await jobFor(abc.customerId, abc.brandId);
    const s1 = await currentStage(a.admin, j1.id, 'CUTTING');
    expect(await active(s1.id)).toMatchObject([
      { userId: hassan.id, source: 'CUSTOMER_OVERRIDE' },
    ]);
    const { job: j2 } = await jobFor(other.customerId, other.brandId);
    const s2 = await currentStage(a.admin, j2.id, 'CUTTING');
    expect(await active(s2.id)).toMatchObject([
      { userId: mahmoud.id, source: 'GLOBAL_DEFAULT' },
    ]);

    await a.admin
      .del(`/admin/customers/${abc.customerId}/responsibilities/CUTTING`)
      .expect(204);
    const { job: j3 } = await jobFor(abc.customerId, abc.brandId);
    const s3 = await currentStage(a.admin, j3.id, 'CUTTING');
    expect(await active(s3.id)).toMatchObject([{ userId: mahmoud.id }]);
    // the earlier job is NOT rewritten
    expect(await active(s1.id)).toMatchObject([{ userId: hassan.id }]);
  });

  it('manual reassignment stays manual and a changed default only affects future work', async () => {
    await clearRules();
    await setGlobal('CUTTING', mahmoud.id).expect(200);
    const c = await newCustomer();
    const { job } = await jobFor(c.customerId, c.brandId);
    const stage = await currentStage(a.admin, job.id, 'CUTTING');
    const first = (await active(stage.id))[0]!;
    await a.admin
      .post(`/admin/job-stages/${stage.id}/assignments`, {
        userId: hassan.id,
        isPrimary: true,
      })
      .expect(201);
    await a.admin
      .del(`/admin/job-stages/${stage.id}/assignments/${first.id}`)
      .expect(200);
    const manual = await active(stage.id);
    expect(manual).toMatchObject([
      { userId: hassan.id, source: 'MANUAL', isPrimary: true },
    ]);

    // change the default: the open job keeps its manual owner
    await setGlobal('CUTTING', karim.id).expect(200);
    expect(await active(stage.id)).toMatchObject([
      { userId: hassan.id, source: 'MANUAL' },
    ]);
    const next = await jobFor(c.customerId, c.brandId);
    const ns = await currentStage(a.admin, next.job.id, 'CUTTING');
    expect(await active(ns.id)).toMatchObject([{ userId: karim.id }]);
  });

  // ───────────────────────── apply to active work ─────────────────────────

  it('apply-active fills only unassigned stages by default and replaces owners only on request, never started or completed work', async () => {
    await clearRules();
    const c = await newCustomer();
    // jobs created while no rule exists: nothing assigned
    const { job: unassigned } = await jobFor(c.customerId, c.brandId);
    const { job: owned } = await jobFor(c.customerId, c.brandId);
    const { job: started } = await jobFor(c.customerId, c.brandId);
    const cutOf = (j: { id: string }) => currentStage(a.admin, j.id, 'CUTTING');
    const sUnassigned = await cutOf(unassigned);
    const sOwned = await cutOf(owned);
    const sStarted = await cutOf(started);
    expect(await active(sUnassigned.id)).toHaveLength(0);
    // manual owner on one, and one cutting stage already running
    await a.admin
      .post(`/admin/job-stages/${sOwned.id}/assignments`, { userId: hassan.id })
      .expect(201);
    for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING']) {
      await runStage(app, a.admin, floor, started.id, code);
    }
    const fabric = await currentStage(
      a.admin,
      started.id,
      'FABRIC_PREPARATION',
    );
    await a.admin
      .post(`/admin/job-stages/${sStarted.id}/assignments`, {
        userId: hassan.id,
      })
      .expect(201);
    await hassan.api.post(`/staff/job-stages/${sStarted.id}/start`).expect(200);
    const fabricOwner = (await active(fabric.id))[0]!.userId;

    await setGlobal('CUTTING', mahmoud.id).expect(200);
    // a plain rule change does not touch anything that exists
    expect(await active(sUnassigned.id)).toHaveLength(0);

    const r1 = (
      await a.admin
        .post('/admin/responsibilities/CUTTING/apply-active', {})
        .expect(200)
    ).body;
    expect(r1.mode).toBe('UNASSIGNED_ONLY');
    expect(r1.assigned).toBeGreaterThanOrEqual(1);
    expect(await active(sUnassigned.id)).toMatchObject([
      { userId: mahmoud.id, source: 'GLOBAL_DEFAULT' },
    ]);
    expect(await active(sOwned.id)).toMatchObject([
      { userId: hassan.id, source: 'MANUAL' },
    ]);

    await setGlobal('CUTTING', karim.id).expect(200);
    const r2 = (
      await a.admin
        .post('/admin/responsibilities/CUTTING/apply-active', {
          mode: 'REPLACE',
        })
        .expect(200)
    ).body;
    expect(r2.replaced).toBeGreaterThanOrEqual(2);
    expect(r2.skipped.started).toBeGreaterThanOrEqual(1);
    expect(await active(sUnassigned.id)).toMatchObject([{ userId: karim.id }]);
    expect(await active(sOwned.id)).toMatchObject([{ userId: karim.id }]);
    // history kept: the replaced assignment still exists with removedAt
    expect(
      (await assignmentsOf(sOwned.id)).some(
        (x) => x.userId === hassan.id && x.removedAt,
      ),
    ).toBe(true);
    // running work untouched
    expect(await active(sStarted.id)).toMatchObject([{ userId: hassan.id }]);

    // completed stages are never touched, even by REPLACE
    const other = floor.fabric;
    await setGlobal('FABRIC_PREPARATION', other.id).expect(200);
    await a.admin
      .post('/admin/responsibilities/FABRIC_PREPARATION/apply-active', {
        mode: 'REPLACE',
      })
      .expect(200);
    expect((await active(fabric.id))[0]!.userId).toBe(fabricOwner);
    expect(
      (await prisma.jobStage.findUniqueOrThrow({ where: { id: fabric.id } }))
        .status,
    ).toBe('COMPLETED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'responsibility.applied_to_active' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({
      stageKey: 'FABRIC_PREPARATION',
      mode: 'REPLACE',
    });
  });

  // ───────────────────────── eligibility and health ─────────────────────────

  it('rejects ineligible assignees and never assigns a disabled one, flagging the rule as needing attention', async () => {
    await clearRules();
    // wrong role: a sewing worker cannot own CUTTING; a non-existent area is 404; bad keys are 400
    await setGlobal('CUTTING', floor.sewing.id).expect(400);
    await setGlobal('NOT_A_STAGE', mahmoud.id).expect(404);
    await a.admin
      .put('/admin/responsibilities/cutting', { userId: mahmoud.id })
      .expect(400);
    await setGlobal('CUTTING', mahmoud.id, {
      additionalUserIds: [mahmoud.id],
    }).expect(400);
    // a delivery area needs the delivery permission
    await setGlobal('DELIVERY', mahmoud.id).expect(400);

    const doomed = await makeWorker(app, 'CUTTING');
    await setGlobal('CUTTING', doomed.id).expect(200);
    await prisma.user.update({
      where: { id: doomed.id },
      data: { status: 'DISABLED', isActive: false },
    });
    const overview = (await a.admin.get('/admin/responsibilities').expect(200))
      .body;
    expect(
      overview.find((x: { stageKey: string }) => x.stageKey === 'CUTTING'),
    ).toMatchObject({
      health: 'NEEDS_ATTENTION',
      reason: 'ASSIGNEE_DISABLED',
      effectiveUser: null,
      globalDefault: { primaryUser: { id: doomed.id } },
    });
    const c = await newCustomer();
    const { job } = await jobFor(c.customerId, c.brandId);
    const stage = await currentStage(a.admin, job.id, 'CUTTING');
    expect(await active(stage.id)).toHaveLength(0);
    const attention = (
      await a.admin.get('/admin/responsibilities/attention').expect(200)
    ).body;
    expect(attention.rulesNeedingAttention.count).toBeGreaterThanOrEqual(1);
    expect(attention.rulesNeedingAttention.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageKey: 'CUTTING',
          configuredUser: expect.objectContaining({ id: doomed.id }),
          effectiveUser: null,
          reason: 'ASSIGNEE_DISABLED',
        }),
      ]),
    );
    expect(attention.unassignedActiveStages.byStageKey).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageKey: expect.any(String) }),
      ]),
    );
  });

  // ───────────────────────── process projection ─────────────────────────

  it('projects the live stage, owner, timestamps, handoff and next owner from real data', async () => {
    await clearRules();
    const owners: Record<string, Worker> = {
      FABRIC_PREPARATION: floor.fabric,
      PATTERN_MAKING: floor.pattern,
      CUTTING: floor.cutting,
      QC_GATE_1: floor.qc,
      PRINTING_EMBROIDERY: floor.printing,
      QC_GATE_2: floor.qc,
      SEWING: floor.sewing,
      QC_GATE_3: floor.qc,
      PACKAGING: floor.packaging,
    };
    for (const [key, w] of Object.entries(owners))
      await setGlobal(key, w.id).expect(200);
    const c = await newCustomer();
    const { job, sampleId } = await jobFor(c.customerId, c.brandId);
    const process = async () =>
      (await a.admin.get(`/admin/jobs/${job.id}/process`).expect(200)).body;

    let p = await process();
    expect(p.currentStage).toMatchObject({
      stageKey: 'FABRIC_PREPARATION',
      responsibleUser: { id: floor.fabric.id },
      assignmentSource: 'GLOBAL_DEFAULT',
    });
    expect(p.currentStage.assignedAt).toBeTruthy();
    expect(p.nextStage).toMatchObject({
      stageKey: 'PATTERN_MAKING',
      responsibleUser: { id: floor.pattern.id },
    });
    expect(
      p.stages.every(
        (s: { responsibleUser: unknown; stageKey: string }) =>
          s.responsibleUser || s.stageKey === 'READY',
      ),
    ).toBe(true);

    await runStage(app, a.admin, floor, job.id, 'FABRIC_PREPARATION');
    await runStage(app, a.admin, floor, job.id, 'PATTERN_MAKING');
    const cutting = await currentStage(a.admin, job.id, 'CUTTING');
    await floor.cutting.api
      .post(`/staff/job-stages/${cutting.id}/start`)
      .expect(200);

    p = await process();
    expect(p.currentStage).toMatchObject({
      stageKey: 'CUTTING',
      status: 'IN_PROGRESS',
      responsibleUser: { id: floor.cutting.id },
      startedBy: { id: floor.cutting.id },
      completedAt: null,
    });
    expect(p.currentStage.startedAt).toBeTruthy();
    expect(p.currentStage.durationMinutes).toBeGreaterThanOrEqual(0);
    expect(p.nextStage).toMatchObject({
      stageKey: 'QC_GATE_1',
      responsibleUser: { id: floor.qc.id },
    });
    expect(p.lastCompleted).toMatchObject({
      stageKey: 'PATTERN_MAKING',
      status: 'COMPLETED',
      completedBy: { id: floor.pattern.id },
      handoff: { toStageKey: 'CUTTING', toUser: { id: floor.cutting.id } },
    });
    expect(p.progress).toMatchObject({ completedStages: 2 });
    expect(p.progress.percent).toBeGreaterThan(0);
    expect(p.attention).toBe('IN_PROGRESS');

    await floor.cutting.api
      .post(`/staff/job-stages/${cutting.id}/complete`)
      .expect(200);
    p = await process();
    expect(p.lastCompleted).toMatchObject({
      stageKey: 'CUTTING',
      completedBy: { id: floor.cutting.id },
      handoff: {
        toStageKey: 'QC_GATE_1',
        toLabel: expect.any(String),
        toUser: { id: floor.qc.id },
      },
    });
    expect(p.lastCompleted.startedAt).toBeTruthy();
    expect(p.lastCompleted.completedAt).toBeTruthy();
    expect(
      new Date(p.lastCompleted.completedAt) >=
        new Date(p.lastCompleted.startedAt),
    ).toBe(true);
    expect(p.currentStage).toMatchObject({
      stageKey: 'QC_GATE_1',
      responsibleUser: { id: floor.qc.id },
    });
    expect(p.currentStage.startedAt).toBeNull();

    // the sample view carries the same job and keeps the sample's own status
    const sp = (
      await a.admin.get(`/admin/samples/${sampleId}/process`).expect(200)
    ).body;
    expect(sp.sample).toMatchObject({ id: sampleId });
    expect(sp.jobs[0]).toMatchObject({ jobId: job.id });
    expect(sp.jobs[0].stages.length).toBeGreaterThan(5);
  });

  it('lists several active jobs of one customer in a deterministic order: blocked, in progress, ready', async () => {
    await clearRules();
    const c = await newCustomer();
    for (const [key, w] of [
      ['FABRIC_PREPARATION', floor.fabric],
      ['CUTTING', mahmoud],
    ] as const) {
      await setGlobal(key, w.id).expect(200);
    }
    const ready = (await jobFor(c.customerId, c.brandId)).job;
    const running = (await jobFor(c.customerId, c.brandId)).job;
    const blocked = (await jobFor(c.customerId, c.brandId)).job;
    const fab = await currentStage(a.admin, running.id, 'FABRIC_PREPARATION');
    await floor.fabric.api
      .post(`/staff/job-stages/${fab.id}/start`)
      .expect(200);
    const bfab = await currentStage(a.admin, blocked.id, 'FABRIC_PREPARATION');
    await a.admin
      .post(`/admin/job-stages/${bfab.id}/blockers`, {
        type: 'MATERIAL_UNAVAILABLE',
        description: 'Fabric roll delayed',
      })
      .expect(201);

    const ops = (
      await a.admin
        .get(`/admin/customers/${c.customerId}/operations`)
        .expect(200)
    ).body;
    expect(ops.customer.id).toBe(c.customerId);
    const order = ops.currentWork.map((w: { jobId: string }) => w.jobId);
    expect(order).toEqual([blocked.id, running.id, ready.id]);
    expect(ops.currentWork[0]).toMatchObject({
      attention: 'BLOCKED',
      blocker: { active: true, reason: 'Fabric roll delayed' },
      referenceType: 'SAMPLE',
      currentStage: {
        stageKey: 'FABRIC_PREPARATION',
        responsibleUser: { id: floor.fabric.id },
      },
      nextStage: { stageKey: 'PATTERN_MAKING' },
    });
    expect(ops.currentWork[1]).toMatchObject({
      attention: 'IN_PROGRESS',
      currentStage: { status: 'IN_PROGRESS' },
    });
    expect(ops.currentWork[1].currentStage.startedAt).toBeTruthy();
    expect(ops.currentWork[0].progress).toMatchObject({ completedStages: 0 });
    expect(ops.currentWork[0]).toHaveProperty('eta');
    expect(ops.activeSamples.length).toBe(3);
    expect(ops.activeSamples[0].jobNumbers.length).toBe(1);
    // repeatable
    const again = (
      await a.admin
        .get(`/admin/customers/${c.customerId}/operations`)
        .expect(200)
    ).body;
    expect(again.currentWork.map((w: { jobId: string }) => w.jobId)).toEqual(
      order,
    );

    // list summary: one call, sales owner + effective owners + current process
    const list = (
      await a.admin
        .get(
          `/admin/customers?search=${c.customerId.slice(0, 0)}&includeOperations=true&pageSize=100`,
        )
        .expect(200)
    ).body;
    const mine = list.data.find((x: { id: string }) => x.id === c.customerId);
    expect(mine.activeJobCount).toBe(3);
    expect(mine.currentProcess).toMatchObject({
      jobNumber: blocked.jobNumber,
      attention: 'BLOCKED',
      blocked: true,
      stage: 'FABRIC_PREPARATION',
      responsibleUser: { id: floor.fabric.id },
    });
    expect(mine.responsibilitySummary.totalAreas).toBeGreaterThanOrEqual(9);
    expect(mine.responsibilitySummary.configuredCount).toBe(2);
    const detail = (
      await a.admin
        .get(`/admin/customers/${c.customerId}?includeOperations=true`)
        .expect(200)
    ).body;
    expect(detail.currentProcesses.length).toBe(3);
    // a customer without work has no current process and is unaffected
    const idle = list.data.find(
      (x: { id: string; activeJobCount: number }) => x.id !== c.customerId,
    );
    if (idle) expect(idle.currentProcess).toBeNull();
  });

  it('exposes the order process, and gives new shipments the default delivery person', async () => {
    await clearRules();
    const s: ApprovedSample = await approvedReferenceSample(
      app,
      a,
      refs,
      floor,
    );
    const driver = await makeWorker(app, 'DELIVERY');
    const { order } = await producedOrder(app, a, floor, s);
    await setGlobal('DELIVERY', driver.id).expect(200);
    await prisma.customerAddress.create({
      data: {
        customerId: s.customerId,
        country: 'Egypt',
        city: 'Cairo',
        addressLine1: '12 Textile St',
      },
    });
    const addr = await prisma.customerAddress.findFirstOrThrow({
      where: { customerId: s.customerId },
    });
    const shipBody = {
      deliveryMethod: 'OWN_DELIVERY',
      recipientName: 'Mona Ali',
      recipientPhone: '+201001112233',
      customerAddressId: addr.id,
      lines: [
        { orderVariantId: order.items[0]!.variants[0]!.id, quantity: 10 },
      ],
    };
    const res = await a.admin
      .post(`/admin/orders/${order.id}/shipments`, shipBody)
      .expect(201);
    expect(res.body.assignedDeliveryUserId).toBe(driver.id);
    // an explicit delivery person always wins over the default
    const explicit = await makeWorker(app, 'DELIVERY');
    const res2 = await a.admin
      .post(`/admin/orders/${order.id}/shipments`, {
        ...shipBody,
        assignedDeliveryUserId: explicit.id,
      })
      .expect(201);
    expect(res2.body.assignedDeliveryUserId).toBe(explicit.id);

    const matrix = (
      await a.admin
        .get(`/admin/customers/${s.customerId}/responsibilities`)
        .expect(200)
    ).body;
    expect(
      matrix.areas.find((x: { stageKey: string }) => x.stageKey === 'DELIVERY'),
    ).toMatchObject({
      group: 'FULFILLMENT',
      source: 'GLOBAL_DEFAULT',
      effectiveUser: { id: driver.id },
    });

    const process = (
      await a.admin.get(`/admin/orders/${order.id}/process`).expect(200)
    ).body;
    expect(process.order).toMatchObject({ id: order.id });
    expect(process.jobs.length).toBeGreaterThanOrEqual(1);
    expect(process.jobs[0].stages.length).toBeGreaterThan(5);
    expect(process.jobs[0].referenceType).toBe('ORDER');
    expect(process.progress.percent).toBeGreaterThan(0);

    // apply-active reaches live shipments without one
    const unassigned = await prisma.shipment.create({
      data: {
        shipmentNumber: `SHP-T${Date.now() % 100000}`,
        orderId: order.id,
        deliveryMethod: 'OWN_DELIVERY',
        recipientName: 'x',
        recipientPhone: '+201000000000',
        addressSnapshot: {},
        createdByUserId: (await prisma.user.findFirstOrThrow()).id,
      },
    });
    const applied = (
      await a.admin
        .post('/admin/responsibilities/DELIVERY/apply-active', {})
        .expect(200)
    ).body;
    expect(applied.assigned).toBeGreaterThanOrEqual(1);
    expect(
      (
        await prisma.shipment.findUniqueOrThrow({
          where: { id: unassigned.id },
        })
      ).assignedDeliveryUserId,
    ).toBe(driver.id);
  });

  // ───────────────────────── bulk overrides, audit, RBAC ─────────────────────────

  it('sets and clears overrides in bulk, with audit entries carrying actor, scope, users and counts', async () => {
    await clearRules();
    const c1 = await newCustomer();
    const c2 = await newCustomer();
    const res = await a.admin
      .post('/admin/responsibilities/bulk-customer-overrides', {
        customerIds: [c1.customerId, c2.customerId],
        stageKey: 'CUTTING',
        userId: hassan.id,
      })
      .expect(200);
    expect(res.body).toMatchObject({ requested: 2, changed: 2, unchanged: 0 });
    for (const c of [c1, c2]) {
      const m = (
        await a.admin
          .get(`/admin/customers/${c.customerId}/responsibilities`)
          .expect(200)
      ).body;
      expect(
        m.areas.find((x: { stageKey: string }) => x.stageKey === 'CUTTING'),
      ).toMatchObject({
        source: 'CUSTOMER_OVERRIDE',
        effectiveUser: { id: hassan.id },
      });
    }
    // global default is untouched (no per-customer global defaults are ever created)
    expect(
      await prisma.responsibilityRule.count({ where: { scope: 'GLOBAL' } }),
    ).toBe(0);
    // repeating is a no-op
    expect(
      (
        await a.admin
          .post('/admin/responsibilities/bulk-customer-overrides', {
            customerIds: [c1.customerId, c2.customerId],
            stageKey: 'CUTTING',
            userId: hassan.id,
          })
          .expect(200)
      ).body,
    ).toMatchObject({ changed: 0, unchanged: 2 });
    // an invalid customer or assignee rejects the whole request
    await a.admin
      .post('/admin/responsibilities/bulk-customer-overrides', {
        customerIds: [c1.customerId, '00000000-0000-4000-8000-000000000000'],
        stageKey: 'CUTTING',
        userId: karim.id,
      })
      .expect(400);
    await a.admin
      .post('/admin/responsibilities/bulk-customer-overrides', {
        customerIds: [c1.customerId],
        stageKey: 'CUTTING',
        userId: floor.sewing.id,
      })
      .expect(400);
    const cleared = await a.admin
      .post('/admin/responsibilities/bulk-customer-overrides', {
        customerIds: [c1.customerId, c2.customerId],
        stageKey: 'CUTTING',
        clear: true,
      })
      .expect(200);
    expect(cleared.body.changed).toBe(2);
    expect(
      await prisma.responsibilityRule.count({ where: { scope: 'CUSTOMER' } }),
    ).toBe(0);

    const audits = (
      await prisma.auditLog.findMany({
        where: { action: 'responsibility.bulk_overrides' },
        orderBy: { createdAt: 'asc' },
      })
    ).filter((x) =>
      (x.metadata as { customerIds?: string[] }).customerIds?.includes(
        c1.customerId,
      ),
    );
    // set (2), repeat (0 changed), clear (2)
    expect(
      audits.map(
        (x) => (x.metadata as { affectedCount: number }).affectedCount,
      ),
    ).toEqual([2, 0, 2]);
    expect(audits[0]?.metadata).toMatchObject({
      scope: 'CUSTOMER',
      stageKey: 'CUTTING',
      newUserId: hassan.id,
      cleared: false,
    });
    expect(audits[2]?.metadata).toMatchObject({
      cleared: true,
      newUserId: null,
    });
    expect(audits[2]?.actorUserId).toBeTruthy();

    // single set / change / clear audit trail
    const trailFrom = new Date();
    await setGlobal('SEWING', floor.sewing.id).expect(200);
    const other = await makeWorker(app, 'SEWING');
    await setGlobal('SEWING', other.id).expect(200);
    await setGlobal('SEWING', other.id).expect(200); // no-op: not audited again
    await a.admin.del('/admin/responsibilities/SEWING').expect(204);
    await a.admin.del('/admin/responsibilities/SEWING').expect(404);
    const trail = await prisma.auditLog.findMany({
      where: {
        action: { in: ['responsibility.set', 'responsibility.cleared'] },
        entityId: 'SEWING',
        createdAt: { gte: trailFrom },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(trail.map((t) => t.action)).toEqual([
      'responsibility.set',
      'responsibility.set',
      'responsibility.cleared',
    ]);
    expect(trail[1]?.metadata).toMatchObject({
      scope: 'GLOBAL',
      stageKey: 'SEWING',
      oldUserId: floor.sewing.id,
      newUserId: other.id,
    });
    expect(trail[2]?.metadata).toMatchObject({
      oldUserId: other.id,
      newUserId: null,
    });
  });

  it('enforces permissions: admin manages, sales only reads, factory staff and customers get nothing', async () => {
    await clearRules();
    const c = await newCustomer();
    await a.sales.get('/admin/responsibilities').expect(200);
    await a.sales
      .get(`/admin/customers/${c.customerId}/responsibilities`)
      .expect(200);
    await a.sales
      .get(`/admin/customers/${c.customerId}/operations`)
      .expect(200);
    await a.sales.get('/admin/customers?includeOperations=true').expect(200);
    await a.sales
      .put('/admin/responsibilities/CUTTING', { userId: mahmoud.id })
      .expect(403);
    await a.sales.del('/admin/responsibilities/CUTTING').expect(403);
    await a.sales
      .put(`/admin/customers/${c.customerId}/responsibilities/CUTTING`, {
        userId: mahmoud.id,
      })
      .expect(403);
    await a.sales
      .post('/admin/responsibilities/CUTTING/apply-active', {})
      .expect(403);
    await a.sales
      .post('/admin/responsibilities/bulk-customer-overrides', {
        customerIds: [c.customerId],
        stageKey: 'CUTTING',
        clear: true,
      })
      .expect(403);
    // finance reads customers but not responsibilities
    await a.finance.get('/admin/customers').expect(200);
    await a.finance.get('/admin/customers?includeOperations=true').expect(403);
    await a.finance.get('/admin/responsibilities').expect(403);
    // floor staff
    await floor.cutting.api.get('/admin/responsibilities').expect(403);
    await floor.cutting.api
      .put('/admin/responsibilities/CUTTING', { userId: mahmoud.id })
      .expect(403);
    await floor.cutting.api
      .get(`/admin/jobs/${'00000000-0000-4000-8000-000000000000'}/process`)
      .expect(403);
    // anonymous
    await http().get('/api/v1/admin/responsibilities').expect(401);
    // manage without jobs.assign cannot apply to active work
    const partial = await createUserAndLogin(app, {
      permissions: ['responsibilities.manage'],
    });
    await api(app, partial.accessToken)
      .post('/admin/responsibilities/CUTTING/apply-active', {})
      .expect(403);
    await api(app, partial.accessToken)
      .put('/admin/responsibilities/CUTTING', { userId: mahmoud.id })
      .expect(200);
    await clearRules();
  });

  it('keeps staff names and assignments out of the customer portal and refuses customer tokens', async () => {
    const portal = await makePortalCustomer(app, a.admin);
    for (const path of [
      '/admin/responsibilities',
      `/admin/customers/${portal.customerId}/responsibilities`,
      `/admin/customers/${portal.customerId}/operations`,
      '/admin/responsibilities/attention',
    ]) {
      await http()
        .get(`/api/v1${path}`)
        .set(auth(portal.accessToken))
        .expect(401);
    }
    await http()
      .put('/api/v1/admin/responsibilities/CUTTING')
      .set(auth(portal.accessToken))
      .send({ userId: mahmoud.id })
      .expect(401);
    // the customer-facing listing carries none of the new staff fields
    const samples = (await portal.api.get('/customer/samples').expect(200))
      .body;
    expect(JSON.stringify(samples)).not.toMatch(
      /responsible|assignmentSource|primaryUser|assignedAt/i,
    );
    // a staff token is not a customer identity either
    await http()
      .get('/api/v1/customer/auth/me')
      .set(auth(a.adminToken))
      .expect(401);
    // sanity: detail of the job still exposes the assignment source to staff only
    const c = await newCustomer();
    await clearRules();
    await setGlobal('CUTTING', mahmoud.id).expect(200);
    const { job } = await jobFor(c.customerId, c.brandId);
    const detail = await jobDetail(a.admin, job.id);
    expect(
      detail.stages.find((s) => s.stageCode === 'CUTTING')?.assignees,
    ).toHaveLength(1);
    await clearRules();
  });
});
