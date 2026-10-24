import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { auditActions, createTestApp } from './support/app.js';
import {
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';
import {
  assignWorker,
  createJob,
  currentStage,
  jobDetail,
  makeFloor,
  makeWorker,
  paidSample,
  STAGE_ORDER,
  uploadEvidence,
  workerFor,
  type Floor,
} from './support/floor.js';
import {
  approvedReferenceSample,
  finishBulkJob,
  orderDetail,
  readyOrder,
  runBulkStage,
  staffStage,
  type ApprovedSample,
  type OrderBody,
} from './support/orders.js';

describe('Bulk production control (Phase 5A, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
  });
  afterAll(() => app.close());

  const order = () => readyOrder(a.admin, s);
  const bulkJob = async (o?: OrderBody) => {
    const ord = o ?? (await order());
    const job = (
      await a.admin
        .post(`/admin/orders/${ord.id}/create-factory-job`)
        .expect(201)
    ).body;
    return { ord, job };
  };
  const batch = async (
    o: OrderBody,
    allocations: { orderVariantId: string; quantity: number }[],
    expected = 201,
  ) =>
    a.admin
      .post(`/admin/orders/${o.id}/batches`, { allocations })
      .expect(expected);
  const alloc = (o: OrderBody, variant: number, quantity: number) => ({
    orderVariantId: o.items[0]!.variants[variant]!.id,
    quantity,
  });
  const status = async (id: string) => (await orderDetail(a.admin, id)).status;

  // ───────────────────────── batches and allocations ─────────────────────────
  describe('batches', () => {
    it('plans a batch with BAT-nnnnnn from variant allocations', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 30), alloc(o, 1, 10)])).body;
      expect(b.batchNumber).toMatch(/^BAT-\d{6}$/);
      expect(b.status).toBe('PLANNED');
      expect(b.quantity).toBe(40);
      expect(b.allocations).toHaveLength(2);
      expect(b.allocations[0].label).toMatch(/\//);
      const d = await orderDetail(a.admin, o.id);
      expect(d.batches).toHaveLength(1);
      expect(d.items[0]!.variants[0]).toMatchObject({ allocatedQuantity: 30 });
      expect(await auditActions(app, b.id)).toContain('order_batch.created');
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toContain('BATCH_CREATED');
      expect(
        (await a.admin.get(`/admin/order-batches/${b.id}`).expect(200)).body.id,
      ).toBe(b.id);
      expect(
        (await a.admin.get(`/admin/orders/${o.id}/batches`).expect(200)).body,
      ).toHaveLength(1);
    });

    it('blocks over-allocation and frees units when a batch is cancelled', async () => {
      const o = await order(); // variant 0 has 60 units
      const first = (await batch(o, [alloc(o, 0, 40)])).body;
      const over = await batch(o, [alloc(o, 0, 21)], 409);
      expect(JSON.stringify(over.body)).toMatch(/Over-allocation/);
      await batch(o, [alloc(o, 0, 20)]);
      await batch(o, [alloc(o, 0, 1)], 409); // all 60 taken
      await a.admin
        .post(`/admin/order-batches/${first.id}/cancel`, {
          reason: 'replanned',
        })
        .expect(200);
      await batch(o, [alloc(o, 0, 40)]); // the 40 are free again
      const d = await orderDetail(a.admin, o.id);
      expect(d.items[0]!.variants[0]).toMatchObject({ allocatedQuantity: 60 });
    });

    it('never over-allocates under concurrency', async () => {
      const o = await order();
      const res = await Promise.all([
        a.admin.post(`/admin/orders/${o.id}/batches`, {
          allocations: [alloc(o, 0, 40)],
        }),
        a.admin.post(`/admin/orders/${o.id}/batches`, {
          allocations: [alloc(o, 0, 40)],
        }),
        a.admin.post(`/admin/orders/${o.id}/batches`, {
          allocations: [alloc(o, 0, 40)],
        }),
      ]);
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(2);
      const rows = await prisma.orderBatchVariant.findMany({
        where: { batch: { orderId: o.id } },
      });
      expect(rows.reduce((sum, r) => sum + r.quantity, 0)).toBe(40);
    });

    it('enforces the allocation rule in the database too', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 50)])).body;
      const v1 = o.items[0]!.variants[0]!.id;
      const b2 = await prisma.orderBatch.create({
        data: {
          batchNumber: `BAT-9${Date.now() % 100000}`,
          orderId: o.id,
          createdByUserId: a.salesUserId,
        },
      });
      await expect(
        prisma.orderBatchVariant.create({
          data: { batchId: b2.id, orderVariantId: v1, quantity: 11 },
        }),
      ).rejects.toThrow(/over-allocation/i);
      await expect(
        prisma.orderVariant.update({
          where: { id: v1 },
          data: { quantity: 40 },
        }),
      ).rejects.toThrow(); // below what batch holds
      await expect(
        prisma.orderBatchVariant.create({
          data: { batchId: b.id, orderVariantId: v1, quantity: 0 },
        }),
      ).rejects.toThrow();
    });

    it('validates allocations and the order state', async () => {
      const o = await order();
      const other = await order();
      await batch(o, [alloc(o, 0, 10), alloc(o, 0, 5)], 400); // variant twice
      await batch(o, [alloc(other, 0, 10)], 400); // variant of another order
      await batch(
        o,
        [{ orderVariantId: o.items[0]!.variants[0]!.id, quantity: 0 }],
        400,
      );
      await a.admin
        .post(`/admin/orders/${o.id}/batches`, { allocations: [] })
        .expect(400);
      await a.sales
        .post(`/admin/orders/${o.id}/batches`, {
          allocations: [alloc(o, 0, 5)],
        })
        .expect(403); // sales may only read batches
      await a.sales.get(`/admin/orders/${o.id}/batches`).expect(200);
      await a.admin
        .post(`/admin/orders/${o.id}/hold`, { reason: 'paused order' })
        .expect(200);
      await batch(o, [alloc(o, 0, 5)], 409);
      await a.admin.post(`/admin/orders/${o.id}/resume`).expect(200);
      const draft = (
        await a.sales
          .post(`/admin/samples/${s.sampleId}/create-order`, {
            items: [
              {
                quantity: 5,
                variants: [{ sizeOptionId: s.sizeM, quantity: 5 }],
              },
            ],
          })
          .expect(201)
      ).body;
      await batch(draft as OrderBody, [alloc(draft as OrderBody, 0, 5)], 409);
    });

    it('replaces allocations of a PLANNED batch, then marks it READY', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 20)])).body;
      const r = (
        await a.admin
          .put(`/admin/order-batches/${b.id}/allocations`, {
            allocations: [alloc(o, 0, 25), alloc(o, 1, 15)],
          })
          .expect(200)
      ).body;
      expect(r.quantity).toBe(40);
      await a.admin
        .put(`/admin/order-batches/${b.id}/allocations`, {
          allocations: [alloc(o, 0, 61)],
        })
        .expect(409);
      expect(
        (await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200))
          .body.status,
      ).toBe('READY');
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(409);
      await a.admin
        .put(`/admin/order-batches/${b.id}/allocations`, {
          allocations: [alloc(o, 0, 5)],
        })
        .expect(409);
      expect(await auditActions(app, b.id)).toEqual(
        expect.arrayContaining(['order_batch.allocated', 'order_batch.ready']),
      );
    });

    it('a batch can only start once the order is released', async () => {
      const f = await order();
      await a.admin
        .post(`/admin/orders/${f.id}/hold`, { reason: 'not now' })
        .expect(200);
      await a.admin.post(`/admin/orders/${f.id}/resume`).expect(200);
      // confirmed but not yet ready
      const o = (
        await a.sales
          .post(`/admin/samples/${s.sampleId}/create-order`, {
            items: [
              {
                quantity: 10,
                variants: [{ sizeOptionId: s.sizeM, quantity: 10 }],
              },
            ],
          })
          .expect(201)
      ).body as OrderBody;
      await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
      const full = await orderDetail(a.admin, o.id);
      const b = (await batch(full, [alloc(full, 0, 10)])).body; // planning is allowed once confirmed
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(409); // but READY needs a released order
      await a.admin.post(`/admin/orders/${o.id}/ready`).expect(200);
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
    });

    it('holds and cancels batches with reasons', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 10)])).body;
      await a.admin.post(`/admin/order-batches/${b.id}/hold`, {}).expect(400);
      const held = (
        await a.admin
          .post(`/admin/order-batches/${b.id}/hold`, {
            reason: 'waiting for fabric',
          })
          .expect(200)
      ).body;
      expect(held.status).toBe('ON_HOLD');
      expect(
        (await a.admin.post(`/admin/order-batches/${b.id}/resume`).expect(200))
          .body.status,
      ).toBe('PLANNED');
      await a.admin.post(`/admin/order-batches/${b.id}/cancel`, {}).expect(400);
      expect(
        (
          await a.admin
            .post(`/admin/order-batches/${b.id}/cancel`, {
              reason: 'merged elsewhere',
            })
            .expect(200)
        ).body.status,
      ).toBe('CANCELLED');
      await a.admin
        .post(`/admin/order-batches/${b.id}/cancel`, { reason: 'again again' })
        .expect(409);
      expect(await auditActions(app, b.id)).toEqual(
        expect.arrayContaining([
          'order_batch.held',
          'order_batch.resumed',
          'order_batch.cancelled',
        ]),
      );
    });
  });

  // ───────────────────────── bulk factory jobs ─────────────────────────
  describe('bulk factory jobs', () => {
    it('creates a BULK_ORDER job pinned to the APPROVED_REFERENCE and the frozen order spec', async () => {
      const o = await readyOrder(a.admin, s, {
        priority: 'HIGH',
        targetDeliveryDate: '2027-06-01T00:00:00.000Z',
      });
      const job = (
        await a.admin
          .post(`/admin/orders/${o.id}/create-factory-job`)
          .expect(201)
      ).body;
      expect(job.sourceType).toBe('BULK_ORDER');
      expect(job.plannedQuantity).toBe(100);
      expect(job.orderNumber).toBe(o.orderNumber);
      expect(job.priority).toBe('HIGH');
      expect(job.status).toBe('READY');
      expect(job.sampleNumber).toBeNull();
      expect(job.stages.map((x: { stageCode: string }) => x.stageCode)).toEqual(
        STAGE_ORDER,
      );
      const row = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { productionSpec: true },
      });
      expect(row.productionSpec.kind).toBe('APPROVED_REFERENCE');
      expect(row.sampleProductionSpecId).toBe(
        (o.approvedReference as { id: string }).id,
      );
      expect(row.orderProductionSpecId).toBe(o.currentSpec!.id);
      expect(row.sampleId).toBeNull();
      expect(row.targetCompletionDate?.toISOString()).toContain('2027-06-01');
      expect(await status(o.id)).toBe('READY_FOR_PRODUCTION'); // not started yet
      expect(await auditActions(app, job.id)).toContain('factory_job.created');
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toContain('JOB_CREATED');
      const list = (
        await a.admin.get(`/admin/factory-jobs?orderId=${o.id}`).expect(200)
      ).body;
      expect(list.data.map((j: { id: string }) => j.id)).toEqual([job.id]);
      expect(
        (
          await a.admin
            .get(`/admin/factory-jobs?sourceType=BULK_ORDER&pageSize=100`)
            .expect(200)
        ).body.data.every(
          (j: { sourceType: string }) => j.sourceType === 'BULK_ORDER',
        ),
      ).toBe(true);
    });

    it('needs a READY_FOR_PRODUCTION order and refuses a duplicate live job', async () => {
      const o = (
        await a.sales
          .post(`/admin/samples/${s.sampleId}/create-order`, {
            items: [
              {
                quantity: 10,
                variants: [{ sizeOptionId: s.sizeM, quantity: 10 }],
              },
            ],
          })
          .expect(201)
      ).body as OrderBody;
      await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
      await a.admin
        .post(`/admin/orders/${o.id}/create-factory-job`)
        .expect(409); // CONFIRMED, not ready
      await a.admin.post(`/admin/orders/${o.id}/ready`).expect(200);
      await a.admin
        .post(`/admin/orders/${o.id}/create-factory-job`)
        .expect(201);
      await a.admin
        .post(`/admin/orders/${o.id}/create-factory-job`)
        .expect(409);
      await a.sales
        .post(`/admin/orders/${o.id}/create-factory-job`)
        .expect(403);
    });

    it('creates exactly one job under concurrency', async () => {
      const o = await order();
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          a.admin.post(`/admin/orders/${o.id}/create-factory-job`),
        ),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await prisma.factoryJob.count({ where: { orderId: o.id } })).toBe(
        1,
      );
    });

    it('creates an ORDER_BATCH job sized to the batch; one live job per batch', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 35), alloc(o, 1, 15)])).body;
      await a.admin
        .post(`/admin/order-batches/${b.id}/create-factory-job`)
        .expect(409); // still PLANNED
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
      const job = (
        await a.admin
          .post(`/admin/order-batches/${b.id}/create-factory-job`)
          .expect(201)
      ).body;
      expect(job.sourceType).toBe('ORDER_BATCH');
      expect(job.plannedQuantity).toBe(50);
      expect(job.batchNumber).toBe(b.batchNumber);
      expect(job.orderNumber).toBe(o.orderNumber);
      const row = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { productionSpec: true },
      });
      expect(row.productionSpec.kind).toBe('APPROVED_REFERENCE');
      expect(row.orderBatchId).toBe(b.id);
      expect(row.orderId).toBe(o.id);
      await a.admin
        .post(`/admin/order-batches/${b.id}/create-factory-job`)
        .expect(409);
      const res = await Promise.all(
        [1, 2, 3].map(() =>
          a.admin.post(`/admin/order-batches/${b.id}/create-factory-job`),
        ),
      );
      expect(res.every((r) => r.status === 409)).toBe(true);
      // the staff see only their batch's breakdown
      const stage = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, stage);
      const view = await staffStage(w.api, stage.id);
      const units = view.orderView!.items[0]!.variants.reduce(
        (sum, v) => sum + v.quantity,
        0,
      );
      expect(units).toBe(50);
    });

    it('creates exactly one batch job under concurrency', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 20)])).body;
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
      const res = await Promise.all(
        Array.from({ length: 3 }, () =>
          a.admin.post(`/admin/order-batches/${b.id}/create-factory-job`),
        ),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        await prisma.factoryJob.count({ where: { orderBatchId: b.id } }),
      ).toBe(1);
    });

    it('never runs a whole-order job and batch jobs for the same order', async () => {
      const withBatch = await order();
      await batch(withBatch, [alloc(withBatch, 0, 10)]);
      await a.admin
        .post(`/admin/orders/${withBatch.id}/create-factory-job`)
        .expect(409);
      const withJob = await order();
      await a.admin
        .post(`/admin/orders/${withJob.id}/create-factory-job`)
        .expect(201);
      await batch(withJob, [alloc(withJob, 0, 10)], 409);
      // …and the database agrees
      const b = await prisma.orderBatch.create({
        data: {
          batchNumber: `BAT-8${Date.now() % 100000}`,
          orderId: withJob.id,
          quantity: 10,
          createdByUserId: a.salesUserId,
        },
      });
      const bulk = await prisma.factoryJob.findFirstOrThrow({
        where: { orderId: withJob.id },
      });
      await expect(
        prisma.factoryJob.create({
          data: {
            jobNumber: `JOB-8${Date.now() % 100000}`,
            sourceType: 'ORDER_BATCH',
            orderId: withJob.id,
            orderBatchId: b.id,
            orderProductionSpecId: bulk.orderProductionSpecId,
            plannedQuantity: 10,
            sampleProductionSpecId: bulk.sampleProductionSpecId,
            workflowTemplateVersionId: bulk.workflowTemplateVersionId,
            customerId: bulk.customerId,
            brandId: bulk.brandId,
            productName: 'x',
            createdByUserId: bulk.createdByUserId,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects invalid source / specification combinations in the database', async () => {
      const { ord, job } = await bulkJob();
      const row = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      const preSpec = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { kind: 'PRE_PRODUCTION' },
      });
      const base = {
        sourceType: 'BULK_ORDER' as const,
        orderId: ord.id,
        orderProductionSpecId: row.orderProductionSpecId,
        plannedQuantity: 5,
        workflowTemplateVersionId: row.workflowTemplateVersionId,
        customerId: row.customerId,
        brandId: row.brandId,
        productName: 'x',
        createdByUserId: row.createdByUserId,
      };
      const next = () => `JOB-7${Math.floor(Math.random() * 90000 + 10000)}`;
      // a bulk job may not pin a pre-production spec
      await expect(
        prisma.factoryJob.create({
          data: {
            ...base,
            jobNumber: next(),
            sampleProductionSpecId: preSpec.id,
          },
        }),
      ).rejects.toThrow(/APPROVED_REFERENCE/);
      // …and needs its quantity and order spec
      await expect(
        prisma.factoryJob.create({
          data: {
            ...base,
            jobNumber: next(),
            sampleProductionSpecId: row.sampleProductionSpecId,
            plannedQuantity: null,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.factoryJob.create({
          data: {
            ...base,
            jobNumber: next(),
            sampleProductionSpecId: row.sampleProductionSpecId,
            orderProductionSpecId: null,
          },
        }),
      ).rejects.toThrow();
      // a sample job may not carry order columns, nor pin an approved reference
      await expect(
        prisma.factoryJob.create({
          data: {
            ...base,
            jobNumber: next(),
            sourceType: 'SAMPLE_PRODUCTION',
            sampleId: s.sampleId,
            sampleProductionSpecId: row.sampleProductionSpecId,
          },
        }),
      ).rejects.toThrow();
      // the pinned specs and quantity are immutable
      await expect(
        prisma.factoryJob.update({
          where: { id: job.id },
          data: { plannedQuantity: 1 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.factoryJob.update({
          where: { id: job.id },
          data: { sampleProductionSpecId: preSpec.id },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.factoryJob.update({
          where: { id: job.id },
          data: { orderId: null },
        }),
      ).rejects.toThrow();
    });

    it('cancelling the job returns the order to READY and lets it be produced again', async () => {
      const { ord, job } = await bulkJob();
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/cancel`, {
          reason: 'wrong workflow',
        })
        .expect(200);
      expect(await status(ord.id)).toBe('READY_FOR_PRODUCTION');
      const second = (
        await a.admin
          .post(`/admin/orders/${ord.id}/create-factory-job`)
          .expect(201)
      ).body;
      expect(second.id).not.toBe(job.id);
      expect(
        (await a.admin.get(`/admin/factory-jobs/${job.id}`).expect(200)).body
          .status,
      ).toBe('CANCELLED');
    });
  });

  // ───────────────────────── quantity reporting ─────────────────────────
  describe('stage quantities', () => {
    it('accepts partial reports and completes only when every unit is accounted for', async () => {
      const { job } = await bulkJob();
      const fab = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, fab);
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
      expect((await staffStage(w.api, fab.id)).quantity).toMatchObject({
        required: 100,
        produced: 0,
        remaining: 100,
      });
      await w.api.post(`/staff/job-stages/${fab.id}/complete`).expect(409); // nothing reported
      await w.api
        .post(`/staff/job-stages/${fab.id}/production-reports`, {
          producedQuantity: 60,
        })
        .expect(201);
      expect((await staffStage(w.api, fab.id)).quantity).toMatchObject({
        produced: 60,
        remaining: 40,
      });
      const r = await w.api
        .post(`/staff/job-stages/${fab.id}/complete`)
        .expect(409);
      expect(JSON.stringify(r.body)).toMatch(/40 of 100/);
      await w.api
        .post(`/staff/job-stages/${fab.id}/production-reports`, {
          producedQuantity: 40,
        })
        .expect(201);
      await w.api.post(`/staff/job-stages/${fab.id}/complete`).expect(200);
      const list = (
        await w.api
          .get(`/staff/job-stages/${fab.id}/production-reports`)
          .expect(200)
      ).body;
      expect(
        list.reports.map(
          (x: { producedQuantity: number }) => x.producedQuantity,
        ),
      ).toEqual([60, 40]);
      expect(list.quantity).toMatchObject({
        required: 100,
        produced: 100,
        remaining: 0,
      });
      const admin = (
        await a.admin
          .get(`/admin/job-stages/${fab.id}/production-reports`)
          .expect(200)
      ).body;
      expect(admin.reports).toHaveLength(2);
      const types = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(
        types.filter((t: string) => t === 'QUANTITY_REPORTED'),
      ).toHaveLength(2);
    });

    it('blocks over-reporting, empty reports and reports from the wrong people', async () => {
      const { job } = await bulkJob();
      const fab = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, fab);
      const url = `/staff/job-stages/${fab.id}/production-reports`;
      await w.api.post(url, { producedQuantity: 10 }).expect(409); // not started
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
      await w.api.post(url, {}).expect(400);
      await w.api
        .post(url, { producedQuantity: 0, rejectedQuantity: 0 })
        .expect(400);
      await w.api.post(url, { producedQuantity: -1 }).expect(400);
      await w.api.post(url, { producedQuantity: 1.5 }).expect(400);
      await w.api.post(url, { producedQuantity: 101 }).expect(409);
      await w.api
        .post(url, { producedQuantity: 60, rejectedQuantity: 41 })
        .expect(409);
      await w.api.post(url, { producedQuantity: 60 }).expect(201);
      await w.api.post(url, { producedQuantity: 41 }).expect(409);
      await w.api
        .post(url, { producedQuantity: 40, reworkQuantity: 500 })
        .expect(201); // rework flags are informational
      await w.api.post(url, { producedQuantity: 1 }).expect(409); // nothing left
      const stranger = await makeWorker(app, 'FABRIC');
      await stranger.api.post(url, { producedQuantity: 1 }).expect(403);
      await a.sales.post(url, { producedQuantity: 1 }).expect(403); // no production_quantity.report
      // stages.override holders (ADMIN / SUPER_ADMIN) are not stopped by the assignment gate, but the quantity
      // rule still is: everything is already accounted for, so the report is refused with a 409, not accepted
      await a.admin.post(url, { producedQuantity: 1 }).expect(409);
      await stranger.api.get(url).expect(403);
    });

    it('reports are append-only', async () => {
      const { job } = await bulkJob();
      const fab = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, fab);
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
      await w.api
        .post(`/staff/job-stages/${fab.id}/production-reports`, {
          producedQuantity: 5,
        })
        .expect(201);
      const row = await prisma.stageProductionReport.findFirstOrThrow({
        where: { jobStageId: fab.id },
      });
      await expect(
        prisma.stageProductionReport.update({
          where: { id: row.id },
          data: { producedQuantity: 99 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.stageProductionReport.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      await expect(
        prisma.stageProductionReport.create({
          data: { jobStageId: fab.id, reportedByUserId: w.id },
        }),
      ).rejects.toThrow(); // empty
    });

    it('lets only one of two simultaneous reports win when together they would exceed the stage', async () => {
      const { job } = await bulkJob();
      const fab = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, fab);
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
      const res = await Promise.all(
        [1, 2, 3].map(() =>
          w.api.post(`/staff/job-stages/${fab.id}/production-reports`, {
            producedQuantity: 60,
          }),
        ),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(2);
      const sum = await prisma.stageProductionReport.aggregate({
        where: { jobStageId: fab.id },
        _sum: { producedQuantity: true },
      });
      expect(sum._sum.producedQuantity).toBe(60);
    });

    it('QC stages and sample jobs take no stage reports', async () => {
      const { job } = await bulkJob();
      for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING', 'CUTTING']) {
        const r = await runBulkStage(app, a, floor, job.id, code);
        expect(r.status).toBe(200);
      }
      const qc = await currentStage(a.admin, job.id, 'QC_GATE_1');
      const w = await assignWorker(a.admin, floor, qc);
      await w.api.post(`/staff/job-stages/${qc.id}/start`).expect(200);
      await w.api
        .post(`/staff/job-stages/${qc.id}/production-reports`, {
          producedQuantity: 1,
        })
        .expect(409);
      // a sample-production job has no quantities
      const f = await paidSample(app, a, refs);
      const sj = await createJob(a.admin, f.sample.id);
      const fab = await currentStage(a.admin, sj.id, 'FABRIC_PREPARATION');
      const sw = await assignWorker(a.admin, floor, fab);
      await sw.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
      await sw.api
        .post(`/staff/job-stages/${fab.id}/production-reports`, {
          producedQuantity: 1,
        })
        .expect(409);
      expect((await staffStage(sw.api, fab.id)).quantity).toBeNull();
    });

    it('scrapped units reduce what later stages must handle', async () => {
      const { job } = await bulkJob();
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      expect(
        (await runBulkStage(app, a, floor, job.id, 'PATTERN_MAKING')).status,
      ).toBe(200);
      expect(
        (await runBulkStage(app, a, floor, job.id, 'CUTTING', { reject: 7 }))
          .status,
      ).toBe(200);
      const qc = await currentStage(a.admin, job.id, 'QC_GATE_1');
      const w = await assignWorker(a.admin, floor, qc);
      await w.api.post(`/staff/job-stages/${qc.id}/start`).expect(200);
      expect((await staffStage(w.api, qc.id)).quantity).toMatchObject({
        required: 93,
      });
      const j = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(j.rejectedQuantity).toBe(7);
      expect(j.completedQuantity).toBe(0);
    });

    it('runs a whole order through production: statuses, totals and variant counters', async () => {
      const o = await order();
      const job = (
        await a.admin
          .post(`/admin/orders/${o.id}/create-factory-job`)
          .expect(201)
      ).body;
      const v0 = o.items[0]!.variants[0]!.id; // 60 units
      for (const code of STAGE_ORDER.slice(0, 9)) {
        const r = await runBulkStage(
          app,
          a,
          floor,
          job.id,
          code,
          code === 'CUTTING' ? { reject: 4, split: true } : {},
        );
        expect(r.status).toBe(200);
        if (code === 'FABRIC_PREPARATION')
          expect(await status(o.id)).toBe('IN_PRODUCTION'); // the job has started
      }
      expect((await jobDetail(a.admin, job.id)).status).toBe('IN_PROGRESS');
      // final stage: report in steps, attributing units to variants
      const last = await currentStage(a.admin, job.id, 'READY');
      const w = workerFor(floor, 'READY');
      await w.api.post(`/staff/job-stages/${last.id}/start`).expect(200);
      expect((await staffStage(w.api, last.id)).quantity).toMatchObject({
        required: 96,
      });
      const v1 = o.items[0]!.variants[1]!.id; // 40 units
      await w.api
        .post(`/staff/job-stages/${last.id}/production-reports`, {
          producedQuantity: 60,
          orderVariantId: v0,
        })
        .expect(201);
      expect(await status(o.id)).toBe('PARTIALLY_COMPLETED'); // some units have passed the final stage
      const mid = (
        await a.admin
          .get(`/admin/orders/${o.id}/production-summary`)
          .expect(200)
      ).body;
      expect(mid.totalQuantity).toBe(100);
      expect(mid.completedQuantity).toBe(60);
      expect(mid.rejectedQuantity).toBe(4);
      expect(mid.remainingQuantity).toBe(36);
      expect(mid.progressPercent).toBe(62.5); // 60 of the 96 units that can still be delivered, not a stage average
      expect(mid.currentStage.stageCode).toBe('READY');
      expect(mid.jobs[0].currentStage).toMatchObject({
        stageCode: 'READY',
        required: 96,
        accounted: 60,
      });
      await w.api
        .post(`/staff/job-stages/${last.id}/production-reports`, {
          producedQuantity: 1,
          orderVariantId: v0,
        })
        .expect(409); // variant 0 only has 60 (4 rejected earlier are not attributed)
      await w.api.post(`/staff/job-stages/${last.id}/complete`).expect(409);
      await w.api
        .post(`/staff/job-stages/${last.id}/production-reports`, {
          producedQuantity: 36,
          orderVariantId: v1,
        })
        .expect(201);
      await w.api.post(`/staff/job-stages/${last.id}/complete`).expect(200);
      expect(await status(o.id)).toBe('PRODUCTION_COMPLETED');
      const d = await orderDetail(a.admin, o.id);
      expect(d.completedAt).toBeTruthy();
      expect(d.productionStartDate).toBeTruthy();
      const done = (
        await a.admin
          .get(`/admin/orders/${o.id}/production-summary`)
          .expect(200)
      ).body;
      expect(done).toMatchObject({
        completedQuantity: 96,
        rejectedQuantity: 4,
        remainingQuantity: 0,
        progressPercent: 100,
      });
      const vars = await prisma.orderVariant.findMany({
        where: { id: { in: [v0, v1] } },
      });
      expect(vars.find((x) => x.id === v0)).toMatchObject({
        completedQuantity: 60,
      });
      expect(vars.find((x) => x.id === v1)).toMatchObject({
        completedQuantity: 36,
      });
      const j = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(j).toMatchObject({
        completedQuantity: 96,
        rejectedQuantity: 4,
        status: 'COMPLETED',
      });
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['PRODUCTION_STARTED', 'PRODUCTION_COMPLETED']),
      );
      // a finished order cannot be cancelled and its production history is intact
      await a.admin
        .post(`/admin/orders/${o.id}/cancel`, { reason: 'too late now' })
        .expect(409);
      const list = (
        await a.admin.get(`/admin/orders?search=${o.orderNumber}`).expect(200)
      ).body.data[0];
      expect(list).toMatchObject({
        completedQuantity: 96,
        rejectedQuantity: 4,
        progressPercent: 100,
        status: 'PRODUCTION_COMPLETED',
      });
    });
  });

  // ───────────────────────── bulk QC and quantity-aware rework ─────────────────────────
  describe('bulk QC and rework', () => {
    const toQc = async (code = 'QC_GATE_1') => {
      const { ord, job } = await bulkJob();
      for (const c of STAGE_ORDER) {
        if (c === code) break;
        expect((await runBulkStage(app, a, floor, job.id, c)).status).toBe(200);
      }
      const st = await currentStage(a.admin, job.id, code);
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const insp = (
        await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(201)
      ).body;
      return { ord, job, st, w, insp };
    };

    it('requires consistent inspection quantities', async () => {
      const { w, insp } = await toQc();
      const { answerQc } = await import('./support/floor.js');
      await answerQc(app, w, insp);
      const done = (body: object) =>
        w.api.post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
          ...body,
        });
      await done({}).expect(400); // quantities are mandatory on bulk jobs
      await done({ inspectedQuantity: 100 }).expect(400);
      await done({
        inspectedQuantity: 100,
        passedQuantity: 90,
        failedQuantity: 5,
      }).expect(400); // 95 ≠ 100
      await done({
        inspectedQuantity: 90,
        passedQuantity: 90,
        failedQuantity: 0,
      }).expect(409); // the gate handles 100
      await done({
        inspectedQuantity: 100,
        passedQuantity: 95,
        failedQuantity: 5,
      }).expect(409); // failed units need a FAIL result
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'FAIL',
          notes: 'no failures?',
          inspectedQuantity: 100,
          passedQuantity: 100,
          failedQuantity: 0,
        })
        .expect(409);
      const ok = (
        await done({
          inspectedQuantity: 100,
          passedQuantity: 100,
          failedQuantity: 0,
        }).expect(200)
      ).body;
      expect(ok).toMatchObject({
        overallResult: 'PASS',
        inspectedQuantity: 100,
        passedQuantity: 100,
        failedQuantity: 0,
      });
      await expect(
        prisma.qcInspection.update({
          where: { id: insp.id },
          data: { passedQuantity: 1 },
        }),
      ).rejects.toThrow();
    });

    it('sample inspections take no quantities', async () => {
      const f = await paidSample(app, a, refs);
      const sj = await createJob(a.admin, f.sample.id);
      for (const c of ['FABRIC_PREPARATION', 'PATTERN_MAKING', 'CUTTING']) {
        const { runStage } = await import('./support/floor.js');
        await runStage(app, a.admin, floor, sj.id, c);
      }
      const st = await currentStage(a.admin, sj.id, 'QC_GATE_1');
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const insp = (
        await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(201)
      ).body;
      const { answerQc } = await import('./support/floor.js');
      await answerQc(app, w, insp);
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
          inspectedQuantity: 5,
          passedQuantity: 5,
          failedQuantity: 0,
        })
        .expect(400);
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
        })
        .expect(200);
    });

    it('a partial failure reworks only the failed units and does not restart the order', async () => {
      const { ord, job, st, w, insp } = await toQc();
      const { answerQc } = await import('./support/floor.js');
      const failItem = insp.results.find(
        (r: { resultType: string }) => r.resultType === 'PASS_FAIL',
      ).itemCode;
      await answerQc(app, w, insp, failItem);
      const res = (
        await w.api
          .post(`/staff/qc-inspections/${insp.id}/complete`, {
            overallResult: 'FAIL',
            notes: '7 pieces cut off-grain',
            inspectedQuantity: 100,
            passedQuantity: 93,
            failedQuantity: 7,
          })
          .expect(200)
      ).body;
      expect(res).toMatchObject({ overallResult: 'FAIL', failedQuantity: 7 });
      const rework = (
        await a.admin.get(`/admin/factory-jobs/${job.id}/rework`).expect(200)
      ).body;
      expect(rework).toHaveLength(1);
      expect(rework[0]).toMatchObject({
        affectedQuantity: 7,
        status: 'OPEN',
        targetStageCode: 'CUTTING',
      });
      // the redo and the re-check handle 7 units, not 100
      const cut2 = await currentStage(a.admin, job.id, 'CUTTING');
      expect(cut2.attempt).toBe(2);
      const cw = workerFor(floor, 'CUTTING');
      await cw.api.post(`/staff/job-stages/${cut2.id}/start`).expect(200);
      expect((await staffStage(cw.api, cut2.id)).quantity).toMatchObject({
        required: 7,
        reworkAffectedQuantity: 7,
      });
      await cw.api
        .post(`/staff/job-stages/${cut2.id}/production-reports`, {
          producedQuantity: 8,
        })
        .expect(409);
      await cw.api
        .post(`/staff/job-stages/${cut2.id}/production-reports`, {
          producedQuantity: 6,
          rejectedQuantity: 1,
        })
        .expect(201);
      await cw.api.post(`/staff/job-stages/${cut2.id}/complete`).expect(200);
      expect(
        (await a.admin.get(`/admin/factory-jobs/${job.id}/rework`).expect(200))
          .body[0].status,
      ).toBe('RESOLVED');
      const qc2 = await currentStage(a.admin, job.id, 'QC_GATE_1');
      expect(qc2.attempt).toBe(2);
      expect(qc2.status).toBe('READY');
      const w2 = workerFor(floor, 'QC_GATE_1');
      await w2.api.post(`/staff/job-stages/${qc2.id}/start`).expect(200);
      expect((await staffStage(w2.api, qc2.id)).quantity).toMatchObject({
        required: 7,
      });
      const insp2 = (
        await w2.api.post(`/staff/job-stages/${qc2.id}/qc/start`).expect(201)
      ).body;
      await answerQc(app, w2, insp2);
      await w2.api
        .post(`/staff/qc-inspections/${insp2.id}/complete`, {
          overallResult: 'PASS',
          inspectedQuantity: 6,
          passedQuantity: 6,
          failedQuantity: 0,
        })
        .expect(409); // must inspect all 7
      await w2.api
        .post(`/staff/qc-inspections/${insp2.id}/complete`, {
          overallResult: 'PASS',
          inspectedQuantity: 7,
          passedQuantity: 7,
          failedQuantity: 0,
        })
        .expect(200);
      // the rest of the line continues for the full remaining quantity (100 − 1 scrapped in the redo)
      const print = await currentStage(a.admin, job.id, 'PRINTING_EMBROIDERY');
      expect(print.status).toBe('READY');
      expect(st.id).not.toBe(qc2.id);
      const pw = await assignWorker(a.admin, floor, print);
      await pw.api.post(`/staff/job-stages/${print.id}/start`).expect(200);
      expect((await staffStage(pw.api, print.id)).quantity).toMatchObject({
        required: 99,
      });
      const summary = (
        await a.admin
          .get(`/admin/orders/${ord.id}/production-summary`)
          .expect(200)
      ).body;
      expect(summary.rejectedQuantity).toBe(1);
      expect(summary.reworkQuantity).toBe(0); // resolved
    });

    it('shows open rework units in the production summary', async () => {
      const { ord, w, insp } = await toQc();
      const { answerQc } = await import('./support/floor.js');
      await answerQc(
        app,
        w,
        insp,
        insp.results.find(
          (r: { resultType: string }) => r.resultType === 'PASS_FAIL',
        ).itemCode,
      );
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'FAIL',
          notes: '20 pieces fail',
          inspectedQuantity: 100,
          passedQuantity: 80,
          failedQuantity: 20,
        })
        .expect(200);
      const summary = (
        await a.admin
          .get(`/admin/orders/${ord.id}/production-summary`)
          .expect(200)
      ).body;
      expect(summary).toMatchObject({
        reworkQuantity: 20,
        totalQuantity: 100,
        completedQuantity: 0,
      });
      expect(
        summary.activeStages.map((x: { stageCode: string }) => x.stageCode),
      ).toContain('CUTTING');
    });

    it('manual rework needs an affected quantity within what the stage handles', async () => {
      const { job } = await bulkJob();
      for (const c of [
        'FABRIC_PREPARATION',
        'PATTERN_MAKING',
        'CUTTING',
        'QC_GATE_1',
      ]) {
        expect((await runBulkStage(app, a, floor, job.id, c)).status).toBe(200);
      }
      const print = await currentStage(a.admin, job.id, 'PRINTING_EMBROIDERY');
      const w = await assignWorker(a.admin, floor, print);
      await w.api.post(`/staff/job-stages/${print.id}/start`).expect(200);
      const url = `/admin/job-stages/${print.id}/rework`;
      await a.admin.post(url, { reason: 'artwork misplaced' }).expect(400); // no quantity
      await a.admin
        .post(url, { reason: 'artwork misplaced', affectedQuantity: 101 })
        .expect(400);
      await a.admin
        .post(url, { reason: 'artwork misplaced', affectedQuantity: 0 })
        .expect(400);
      const r = (
        await a.admin
          .post(url, {
            reason: 'artwork misplaced on 12 pieces',
            affectedQuantity: 12,
          })
          .expect(200)
      ).body;
      const rw = await prisma.reworkRecord.findUniqueOrThrow({
        where: { id: r.reworkId },
      });
      expect(rw.affectedQuantity).toBe(12);
      await expect(
        prisma.reworkRecord.update({
          where: { id: rw.id },
          data: { affectedQuantity: -3 },
        }),
      ).rejects.toThrow();
    });
  });

  // ───────────────────────── batches end to end ─────────────────────────
  describe('batch production', () => {
    it('two batches complete the order: PARTIALLY_COMPLETED, then PRODUCTION_COMPLETED', async () => {
      const o = await order();
      const b1 = (await batch(o, [alloc(o, 0, 60)])).body;
      const b2 = (await batch(o, [alloc(o, 1, 40)])).body;
      for (const b of [b1, b2])
        await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
      expect(await status(o.id)).toBe('READY_FOR_PRODUCTION');
      const j1 = (
        await a.admin
          .post(`/admin/order-batches/${b1.id}/create-factory-job`)
          .expect(201)
      ).body;
      await finishBulkJob(app, a, floor, j1.id);
      let d = await orderDetail(a.admin, o.id);
      expect(d.status).toBe('PARTIALLY_COMPLETED');
      expect(d.batches.find((b) => b.id === b1.id)!.status).toBe('COMPLETED');
      expect(d.batches.find((b) => b.id === b2.id)!.status).toBe('READY');
      const mid = (
        await a.admin
          .get(`/admin/orders/${o.id}/production-summary`)
          .expect(200)
      ).body;
      expect(mid).toMatchObject({
        totalQuantity: 100,
        completedQuantity: 60,
        remainingQuantity: 40,
        progressPercent: 60,
      });
      const j2 = (
        await a.admin
          .post(`/admin/order-batches/${b2.id}/create-factory-job`)
          .expect(201)
      ).body;
      await finishBulkJob(app, a, floor, j2.id);
      d = await orderDetail(a.admin, o.id);
      expect(d.status).toBe('PRODUCTION_COMPLETED');
      expect(d.batches.every((b) => b.status === 'COMPLETED')).toBe(true);
      const done = (
        await a.admin
          .get(`/admin/orders/${o.id}/production-summary`)
          .expect(200)
      ).body;
      expect(done).toMatchObject({
        completedQuantity: 100,
        progressPercent: 100,
      });
      expect(done.jobs).toHaveLength(2);
      expect(d.factoryJobs.map((j) => j.sourceType)).toEqual([
        'ORDER_BATCH',
        'ORDER_BATCH',
      ]);
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'BATCH_CREATED',
          'BATCH_STARTED',
          'PRODUCTION_STARTED',
          'PRODUCTION_COMPLETED',
        ]),
      );
    });

    it('a cancelled batch job returns its batch to READY', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 20)])).body;
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
      const job = (
        await a.admin
          .post(`/admin/order-batches/${b.id}/create-factory-job`)
          .expect(201)
      ).body;
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      expect(
        (await a.admin.get(`/admin/order-batches/${b.id}`).expect(200)).body
          .status,
      ).toBe('IN_PRODUCTION');
      expect(await status(o.id)).toBe('IN_PRODUCTION');
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/cancel`, {
          reason: 'wrong cut plan',
        })
        .expect(200);
      expect(
        (await a.admin.get(`/admin/order-batches/${b.id}`).expect(200)).body
          .status,
      ).toBe('READY');
      expect(await status(o.id)).toBe('READY_FOR_PRODUCTION');
      await a.admin
        .post(`/admin/order-batches/${b.id}/create-factory-job`)
        .expect(201);
    });
  });

  // ───────────────────────── hold and cancel with production running ─────────────────────────
  describe('hold and cancel', () => {
    it('holding an order stops floor work on its jobs; resuming restores it', async () => {
      const { ord, job } = await bulkJob();
      const fab = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, fab);
      await a.admin
        .post(`/admin/orders/${ord.id}/hold`, { reason: 'customer paused' })
        .expect(200);
      const r = await w.api
        .post(`/staff/job-stages/${fab.id}/start`)
        .expect(409);
      expect(JSON.stringify(r.body)).toMatch(/on hold/);
      await a.admin.post(`/admin/orders/${ord.id}/resume`).expect(200);
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
      expect(await status(ord.id)).toBe('IN_PRODUCTION');
      // hold again while running: resume goes back to IN_PRODUCTION
      await a.admin
        .post(`/admin/orders/${ord.id}/hold`, { reason: 'second pause' })
        .expect(200);
      await w.api
        .post(`/staff/job-stages/${fab.id}/production-reports`, {
          producedQuantity: 5,
        })
        .expect(409);
      expect(
        (await a.admin.post(`/admin/orders/${ord.id}/resume`).expect(200)).body
          .status,
      ).toBe('IN_PRODUCTION');
    });

    it('holding a batch stops its job', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 20)])).body;
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
      const job = (
        await a.admin
          .post(`/admin/order-batches/${b.id}/create-factory-job`)
          .expect(201)
      ).body;
      const fab = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, fab);
      await a.admin
        .post(`/admin/order-batches/${b.id}/hold`, { reason: 'machine down' })
        .expect(200);
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(409);
      await a.admin.post(`/admin/order-batches/${b.id}/resume`).expect(200);
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
    });

    it('cancelling an order cancels live jobs and batches but keeps all production history', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 30)])).body;
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(200);
      const job = (
        await a.admin
          .post(`/admin/order-batches/${b.id}/create-factory-job`)
          .expect(201)
      ).body;
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      const activities = await prisma.jobActivity.count({
        where: { jobId: job.id },
      });
      const reports = await prisma.stageProductionReport.count({
        where: { jobStage: { jobId: job.id } },
      });
      await a.admin
        .post(`/admin/orders/${o.id}/cancel`, { reason: 'customer withdrew' })
        .expect(200);
      const d = await orderDetail(a.admin, o.id);
      expect(d.status).toBe('CANCELLED');
      expect(d.batches[0]!.status).toBe('CANCELLED');
      const j = await jobDetail(a.admin, job.id);
      expect(j.status).toBe('CANCELLED');
      expect(j.stages).toHaveLength(10);
      expect(
        await prisma.jobActivity.count({ where: { jobId: job.id } }),
      ).toBeGreaterThanOrEqual(activities);
      expect(
        await prisma.stageProductionReport.count({
          where: { jobStage: { jobId: job.id } },
        }),
      ).toBe(reports);
      expect(
        await prisma.stageAssignment.count({
          where: { jobStage: { jobId: job.id } },
        }),
      ).toBeGreaterThan(0);
      await a.admin.post(`/admin/order-batches/${b.id}/ready`).expect(409);
      expect(await auditActions(app, job.id)).toContain(
        'factory_job.cancelled',
      );
    });
  });

  // ───────────────────────── authorization of floor actions ─────────────────────────
  describe('authorization', () => {
    it('keeps production planning with admins and quantity reporting with assigned floor staff', async () => {
      const o = await order();
      const b = (await batch(o, [alloc(o, 0, 10)])).body;
      for (const who of [a.sales, a.finance, floor.cutting.api]) {
        await who.post(`/admin/order-batches/${b.id}/ready`).expect(403);
        await who
          .post(`/admin/order-batches/${b.id}/cancel`, {
            reason: 'not allowed',
          })
          .expect(403);
        await who.post(`/admin/orders/${o.id}/create-factory-job`).expect(403);
      }
      await a.sales.get(`/admin/order-batches/${b.id}`).expect(200);
      await floor.cutting.api.get(`/admin/order-batches/${b.id}`).expect(403);
      await floor.cutting.api.get(`/admin/orders/${o.id}/batches`).expect(403);
      void uploadEvidence;
    });
  });
});
