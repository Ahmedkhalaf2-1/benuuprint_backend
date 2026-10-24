import type { INestApplication } from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../src/common/canonical-json.js';
import { PrismaService } from '../src/database/prisma.service.js';
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
  type Refs,
} from './support/factory.js';
import {
  createJob,
  makeFloor,
  paidSample,
  type Floor,
} from './support/floor.js';
import {
  approvedReferenceSample,
  createOrder,
  orderDetail,
  readyOrder,
  standardItems,
  type ApprovedSample,
} from './support/orders.js';

describe('Bulk orders (Phase 5A, e2e)', () => {
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

  // ───────────────────────── creation and the approved reference ─────────────────────────
  describe('creation', () => {
    it('creates a DRAFT ORD-nnnnnn from an approved sample, pinning the APPROVED_REFERENCE', async () => {
      const order = await createOrder(a.sales, s.sampleId, {
        priority: 'HIGH',
      });
      expect(order.orderNumber).toMatch(/^ORD-\d{6}$/);
      expect(order.status).toBe('DRAFT');
      expect(order.priority).toBe('HIGH');
      const ref = order.approvedReference as {
        kind: string;
        id: string;
        specHash: string;
      };
      expect(ref.kind).toBe('APPROVED_REFERENCE');
      const spec = await prisma.sampleProductionSpec.findUniqueOrThrow({
        where: { id: ref.id },
      });
      expect(spec.kind).toBe('APPROVED_REFERENCE');
      expect(spec.specHash).toBe(sha256Hex(canonicalJson(spec.snapshot)));
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
          .approvedProductionSpecId,
      ).toBe(spec.id);
      expect(order.sampleNumber).toBe(s.sampleNumber);
      expect(await auditActions(app, order.id)).toContain('order.created');
      expect(order.currentSpec).toBeNull();
    });

    it('traces the approved reference back to the sample-production job that built the sample', async () => {
      const order = await createOrder(a.sales, s.sampleId);
      const ref = order.approvedReference as {
        sourceFactoryJobId: string;
        sourceFactoryJobNumber: string;
      };
      expect(ref.sourceFactoryJobId).toBe(s.sampleJobId);
      const job = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: s.sampleJobId },
      });
      expect(ref.sourceFactoryJobNumber).toBe(job.jobNumber);
      expect(job.sourceType).toBe('SAMPLE_PRODUCTION');
      const spec = (
        await a.admin
          .get(`/admin/samples/${s.sampleId}/production-spec`)
          .expect(200)
      ).body;
      expect(spec.sourceFactoryJobId).toBe(s.sampleJobId);
      // the pre-production spec carries no such link
      const specs = (
        await a.admin
          .get(`/admin/samples/${s.sampleId}/production-specs`)
          .expect(200)
      ).body;
      const pre = specs.find(
        (x: { kind: string }) => x.kind === 'PRE_PRODUCTION',
      );
      expect(pre.sourceFactoryJobId).toBeNull();
    });

    it('rejects samples that are not approved yet', async () => {
      const unpaid = await paidSample(app, a, refs); // READY_FOR_PRODUCTION
      await a.admin
        .post(`/admin/samples/${unpaid.sample.id}/create-order`)
        .expect(409);
      const job = await createJob(a.admin, unpaid.sample.id); // IN_PRODUCTION: only a PRE_PRODUCTION spec exists
      expect(job.status).toBe('READY');
      await a.admin
        .post(`/admin/samples/${unpaid.sample.id}/create-order`)
        .expect(409);
    });

    it('refuses a pre-production specification at the database level', async () => {
      const f = await paidSample(app, a, refs);
      const job = await createJob(a.admin, f.sample.id);
      const pre = await prisma.sampleProductionSpec.findUniqueOrThrow({
        where: { id: job.sampleProductionSpecId as string },
      });
      expect(pre.kind).toBe('PRE_PRODUCTION');
      await expect(
        prisma.order.create({
          data: {
            orderNumber: 'ORD-990001',
            customerId: pre.customerId,
            brandId: pre.brandId,
            sourceSampleId: f.sample.id,
            approvedProductionSpecId: pre.id,
            createdByUserId: a.salesUserId,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a reference that belongs to another sample, and makes the order identity immutable', async () => {
      const order = await createOrder(a.sales, s.sampleId);
      const second = await approvedReferenceSample(app, a, refs, floor);
      const other = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { kind: 'APPROVED_REFERENCE', sampleId: second.sampleId },
      });
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { approvedProductionSpecId: other.id },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { orderNumber: 'ORD-000000' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: { customerId: other.customerId },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.order.delete({ where: { id: order.id } }),
      ).rejects.toThrow();
      await expect(
        prisma.sampleProductionSpec.update({
          where: { id: other.id },
          data: { specHash: 'x' },
        }),
      ).rejects.toThrow();
    });

    it('needs an active customer and brand', async () => {
      await prisma.customer.update({
        where: { id: s.customerId },
        data: { status: 'BLOCKED' },
      });
      try {
        await a.sales
          .post(`/admin/samples/${s.sampleId}/create-order`)
          .expect(409);
      } finally {
        await prisma.customer.update({
          where: { id: s.customerId },
          data: { status: 'ACTIVE' },
        });
      }
      await prisma.brand.update({
        where: { id: s.brandId },
        data: { status: 'INACTIVE' },
      });
      try {
        await a.sales
          .post(`/admin/samples/${s.sampleId}/create-order`)
          .expect(409);
      } finally {
        await prisma.brand.update({
          where: { id: s.brandId },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('allocates distinct order numbers under concurrency', async () => {
      const res = await Promise.all(
        Array.from({ length: 5 }, () =>
          a.sales.post(`/admin/samples/${s.sampleId}/create-order`),
        ),
      );
      expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(res.map((r) => r.body.orderNumber)).size).toBe(5);
    });

    it('validates the optional sales owner', async () => {
      await a.sales
        .post(`/admin/samples/${s.sampleId}/create-order`, {
          assignedSalesUserId: '00000000-0000-4000-8000-000000000000',
        })
        .expect(400);
      const o = await createOrder(a.sales, s.sampleId, {
        assignedSalesUserId: a.salesUserId,
      });
      expect(o.assignedSalesUserId).toBe(a.salesUserId);
    });
  });

  // ───────────────────────── items and variants ─────────────────────────
  describe('items and variants', () => {
    const put = (id: string, items: object[]) =>
      a.sales.put(`/admin/orders/${id}/items`, { items });

    it('supports size, colour, size+colour and custom variants', async () => {
      const order = await createOrder(a.sales, s.sampleId);
      const r = (
        await put(order.id, [
          {
            quantity: 100,
            variants: [
              { sizeOptionId: s.sizeM, quantity: 20 },
              { fabricColorId: s.colorId, quantity: 20 },
              {
                sizeOptionId: s.sizeL,
                fabricColorId: s.color2Id,
                quantity: 20,
              },
              {
                customSizeName: 'XXL-Tall',
                customColorName: 'Sunset',
                pantone: '17-1463',
                hex: '#ff6600',
                quantity: 20,
              },
              {
                customSizeName: 'Kids 10',
                fabricColorId: s.colorId,
                quantity: 20,
              },
            ],
          },
        ]).expect(200)
      ).body;
      const v = r.items[0].variants;
      expect(v).toHaveLength(5);
      expect(v.map((x: { quantity: number }) => x.quantity)).toEqual([
        20, 20, 20, 20, 20,
      ]);
      expect(v[2].label).toMatch(/\/ /);
      expect(r.totalQuantity).toBe(100);
      expect(r.items[0].variantTotal).toBe(100);
      expect(v[3].customColorName).toBe('Sunset');
      expect(v[3].hex).toBe('#ff6600');
    });

    it('rejects invalid variants', async () => {
      const order = await createOrder(a.sales, s.sampleId);
      const bad = (variants: object[]) =>
        put(order.id, [{ quantity: 10, variants }]);
      await bad([{ sizeOptionId: s.sizeM, quantity: 0 }]).expect(400);
      await bad([{ sizeOptionId: s.sizeM, quantity: -5 }]).expect(400);
      await bad([{ sizeOptionId: s.sizeM, quantity: 1.5 }]).expect(400);
      await bad([
        { sizeOptionId: s.sizeM, customSizeName: 'x', quantity: 5 },
      ]).expect(400);
      await bad([
        { fabricColorId: s.colorId, customColorName: 'x', quantity: 5 },
      ]).expect(400);
      await bad([{ quantity: 5 }]).expect(400); // neither size nor colour
      await bad([
        { sizeOptionId: s.sizeM, quantity: 5 },
        { sizeOptionId: s.sizeM, quantity: 5 },
      ]).expect(400); // duplicate combo
      await bad([
        { sizeOptionId: '00000000-0000-4000-8000-000000000000', quantity: 5 },
      ]).expect(400);
      await bad([{ sizeOptionId: s.sizeM, hex: 'red', quantity: 5 }]).expect(
        400,
      );
      await put(order.id, [{ quantity: 0, variants: [] }]).expect(400);
    });

    it('rejects a colour of another fabric (that would need a new sample)', async () => {
      const order = await createOrder(a.sales, s.sampleId);
      const other = await prisma.fabric.findUniqueOrThrow({
        where: { code: 'OTHER_NOT_SURE' },
      });
      const color = await prisma.fabricColor.create({
        data: { fabricId: other.id, name: `Foreign ${Date.now()}` },
      });
      const res = await put(order.id, [
        { quantity: 5, variants: [{ fabricColorId: color.id, quantity: 5 }] },
      ]).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/different fabric/);
    });

    it('updates existing rows in place and removes missing ones', async () => {
      const order = await createOrder(a.sales, s.sampleId, {
        items: standardItems(s),
      });
      const before = (await orderDetail(a.admin, order.id)).items[0];
      const keep = before.variants[0]!;
      const next = (
        await put(order.id, [
          {
            id: before.id,
            quantity: 80,
            variants: [
              {
                id: keep.id,
                sizeOptionId: s.sizeM,
                fabricColorId: s.colorId,
                quantity: 80,
              },
            ],
          },
        ]).expect(200)
      ).body;
      expect(next.items[0].id).toBe(before.id);
      expect(next.items[0].variants).toHaveLength(1);
      expect(next.items[0].variants[0].id).toBe(keep.id);
      expect(next.items[0].variants[0].quantity).toBe(80);
      await put(order.id, [
        {
          id: '00000000-0000-4000-8000-000000000000',
          quantity: 1,
          variants: [{ sizeOptionId: s.sizeM, quantity: 1 }],
        },
      ]).expect(400);
      expect(await auditActions(app, order.id)).toContain(
        'order.items_changed',
      );
    });

    it('lets a draft be incomplete but refuses edits once confirmed', async () => {
      const order = await createOrder(a.sales, s.sampleId);
      await put(order.id, [
        { quantity: 50, variants: [{ sizeOptionId: s.sizeM, quantity: 30 }] },
      ]).expect(200); // totals not checked yet
      await put(order.id, standardItems(s)).expect(200);
      await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
      await put(order.id, standardItems(s, 10, 10)).expect(409);
    });
  });

  // ───────────────────────── confirmation ─────────────────────────
  describe('confirmation', () => {
    it('confirms, freezes the order production spec and records it', async () => {
      const order = await createOrder(a.sales, s.sampleId, {
        items: standardItems(s),
      });
      const done = (
        await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200)
      ).body;
      expect(done.status).toBe('CONFIRMED');
      expect(done.currentSpec.revision).toBe(1);
      expect(done.currentSpec.totalQuantity).toBe(100);
      expect(done.revisionNumber).toBe(1);
      expect(done.confirmedAt).toBeTruthy();
      const spec = await prisma.orderProductionSpec.findUniqueOrThrow({
        where: { id: done.currentSpec.id },
      });
      expect(spec.specHash).toBe(sha256Hex(canonicalJson(spec.snapshot)));
      const snap = spec.snapshot as {
        reference: { approvedProductionSpecId: string };
        items: {
          variants: {
            variantId: string;
            size: unknown;
            color: { source: string };
          }[];
        }[];
      };
      expect(snap.reference.approvedProductionSpecId).toBe(
        (done.approvedReference as { id: string }).id,
      );
      expect(snap.items[0]!.variants).toHaveLength(2);
      expect(snap.items[0]!.variants[0]!.color.source).toBe('CATALOG');
      expect(await auditActions(app, order.id)).toContain('order.confirmed');
      // frozen: append-only
      await expect(
        prisma.orderProductionSpec.update({
          where: { id: spec.id },
          data: { totalQuantity: 5 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.orderProductionSpec.delete({ where: { id: spec.id } }),
      ).rejects.toThrow();
    });

    it('verifies the totals on the server and refuses incomplete orders', async () => {
      const empty = await createOrder(a.sales, s.sampleId);
      await a.sales.post(`/admin/orders/${empty.id}/confirm`).expect(409);
      const noVariants = await createOrder(a.sales, s.sampleId, {
        items: [{ quantity: 10, variants: [] }],
      });
      await a.sales.post(`/admin/orders/${noVariants.id}/confirm`).expect(409);
      const mismatch = await createOrder(a.sales, s.sampleId, {
        items: [
          {
            quantity: 100,
            variants: [
              { sizeOptionId: s.sizeM, quantity: 60 },
              { sizeOptionId: s.sizeL, quantity: 30 },
            ],
          },
        ],
      });
      const res = await a.sales
        .post(`/admin/orders/${mismatch.id}/confirm`)
        .expect(409);
      expect(JSON.stringify(res.body)).toMatch(/add up to 90/);
      expect((await orderDetail(a.admin, mismatch.id)).status).toBe('DRAFT');
      // fix it and confirm
      await a.sales
        .put(`/admin/orders/${mismatch.id}/items`, { items: standardItems(s) })
        .expect(200);
      await a.sales.post(`/admin/orders/${mismatch.id}/confirm`).expect(200);
    });

    it('confirms exactly once under concurrency', async () => {
      const order = await createOrder(a.sales, s.sampleId, {
        items: standardItems(s),
      });
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          a.sales.post(`/admin/orders/${order.id}/confirm`),
        ),
      );
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(3);
      expect(
        await prisma.orderProductionSpec.count({
          where: { orderId: order.id },
        }),
      ).toBe(1);
    });

    it('supports submit / request-changes before confirmation', async () => {
      const order = await createOrder(a.sales, s.sampleId, {
        items: standardItems(s),
      });
      await a.sales
        .post(`/admin/orders/${order.id}/request-changes`, {
          reason: 'nothing to change',
        })
        .expect(409);
      expect(
        (await a.sales.post(`/admin/orders/${order.id}/submit`).expect(200))
          .body.status,
      ).toBe('PENDING_CONFIRMATION');
      await a.sales
        .put(`/admin/orders/${order.id}/items`, { items: standardItems(s) })
        .expect(409); // pending: not editable
      await a.sales
        .post(`/admin/orders/${order.id}/request-changes`, {})
        .expect(400);
      expect(
        (
          await a.sales
            .post(`/admin/orders/${order.id}/request-changes`, {
              reason: 'colour split wrong',
            })
            .expect(200)
        ).body.status,
      ).toBe('DRAFT');
      await a.sales.post(`/admin/orders/${order.id}/submit`).expect(200);
      expect(
        (await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200))
          .body.status,
      ).toBe('CONFIRMED');
    });
  });

  // ───────────────────────── state machine ─────────────────────────
  describe('state machine', () => {
    it('refuses arbitrary transitions', async () => {
      const draft = await createOrder(a.sales, s.sampleId, {
        items: standardItems(s),
      });
      await a.sales.post(`/admin/orders/${draft.id}/ready`).expect(409);
      await a.sales.post(`/admin/orders/${draft.id}/resume`).expect(409);
      await a.sales
        .post(`/admin/orders/${draft.id}/hold`, { reason: 'not yet confirmed' })
        .expect(409);
      await a.sales
        .post(`/admin/orders/${draft.id}/create-factory-job`)
        .expect(403); // needs factory_jobs.manage
      await a.admin
        .post(`/admin/orders/${draft.id}/create-factory-job`)
        .expect(409);
      await a.sales.post(`/admin/orders/${draft.id}/confirm`).expect(200);
      await a.sales.post(`/admin/orders/${draft.id}/confirm`).expect(409);
      await a.sales.post(`/admin/orders/${draft.id}/submit`).expect(409);
      await a.sales.post(`/admin/orders/${draft.id}/ready`).expect(200);
      await a.sales.post(`/admin/orders/${draft.id}/ready`).expect(409);
    });

    it('holds, resumes and cancels with reasons; cancelled is final', async () => {
      const order = await readyOrder(a.admin, s);
      await a.admin.post(`/admin/orders/${order.id}/hold`, {}).expect(400);
      const held = (
        await a.admin
          .post(`/admin/orders/${order.id}/hold`, { reason: 'customer paused' })
          .expect(200)
      ).body;
      expect(held.status).toBe('ON_HOLD');
      expect(held.holdReason).toBe('customer paused');
      await a.admin
        .post(`/admin/orders/${order.id}/hold`, { reason: 'again again' })
        .expect(409);
      expect(
        (await a.admin.post(`/admin/orders/${order.id}/resume`).expect(200))
          .body.status,
      ).toBe('READY_FOR_PRODUCTION');
      await a.admin.post(`/admin/orders/${order.id}/cancel`, {}).expect(400);
      const cancelled = (
        await a.admin
          .post(`/admin/orders/${order.id}/cancel`, {
            reason: 'customer withdrew',
          })
          .expect(200)
      ).body;
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancellationReason).toBe('customer withdrew');
      await a.admin.post(`/admin/orders/${order.id}/resume`).expect(409);
      await a.admin
        .post(`/admin/orders/${order.id}/cancel`, { reason: 'twice twice' })
        .expect(409);
      await a.admin
        .patch(`/admin/orders/${order.id}/priority`, { priority: 'LOW' })
        .expect(409);
      await expect(
        prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'DRAFT',
            cancelledAt: null,
            cancellationReason: null,
          },
        }),
      ).rejects.toThrow();
      const actions = await auditActions(app, order.id);
      expect(actions).toEqual(
        expect.arrayContaining([
          'order.held',
          'order.resumed',
          'order.cancelled',
        ]),
      );
      const tl = (
        await a.admin
          .get(`/admin/orders/${order.id}/activities?pageSize=100`)
          .expect(200)
      ).body;
      const types = tl.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'ORDER_CREATED',
          'ORDER_CONFIRMED',
          'PRODUCTION_READY',
          'ORDER_HELD',
          'ORDER_RESUMED',
          'ORDER_CANCELLED',
        ]),
      );
      expect(types[0]).toBe('ORDER_CREATED');
    });

    it('updates the target date and notes, with an audit trail', async () => {
      const order = await createOrder(a.sales, s.sampleId);
      const r = (
        await a.sales
          .patch(`/admin/orders/${order.id}`, {
            targetDeliveryDate: '2027-01-15T00:00:00.000Z',
            internalNotes: 'rush',
          })
          .expect(200)
      ).body;
      expect(r.targetDeliveryDate).toContain('2027-01-15');
      expect(r.internalNotes).toBe('rush');
      await a.sales
        .patch(`/admin/orders/${order.id}`, { targetDeliveryDate: null })
        .expect(200);
      expect(await auditActions(app, order.id)).toContain('order.updated');
      await a.sales
        .patch(`/admin/orders/${order.id}`, { fabricId: s.colorId })
        .expect(400); // not an order field: a new sample is needed
    });
  });

  // ───────────────────────── revisions ─────────────────────────
  describe('revisions', () => {
    it('revises a confirmed order and preserves the history', async () => {
      const order = await readyOrder(a.admin, s);
      const first = order.currentSpec!;
      const items = [
        {
          id: order.items[0]!.id,
          quantity: 120,
          variants: [
            {
              id: order.items[0]!.variants[0]!.id,
              sizeOptionId: s.sizeM,
              fabricColorId: s.colorId,
              quantity: 70,
            },
            {
              id: order.items[0]!.variants[1]!.id,
              sizeOptionId: s.sizeL,
              fabricColorId: s.colorId,
              quantity: 50,
            },
          ],
        },
      ];
      await a.admin
        .post(`/admin/orders/${order.id}/revise`, { items })
        .expect(400); // reason is required
      const rev = (
        await a.admin
          .post(`/admin/orders/${order.id}/revise`, {
            reason: 'customer wants 20 more',
            items,
          })
          .expect(200)
      ).body;
      expect(rev.currentSpec.revision).toBe(2);
      expect(rev.currentSpec.totalQuantity).toBe(120);
      expect(rev.revisionNumber).toBe(2);
      expect(rev.status).toBe('READY_FOR_PRODUCTION');
      const revisions = (
        await a.admin.get(`/admin/orders/${order.id}/revisions`).expect(200)
      ).body;
      expect(revisions).toHaveLength(1);
      expect(revisions[0].reason).toBe('customer wants 20 more');
      expect(revisions[0].previousSnapshot.totalQuantity).toBe(100);
      // revision 1 is still stored, untouched
      const specs = (
        await a.admin
          .get(`/admin/orders/${order.id}/production-specs`)
          .expect(200)
      ).body;
      expect(specs.map((x: { revision: number }) => x.revision)).toEqual([
        2, 1,
      ]);
      expect(specs[1].id).toBe(first.id);
      expect(specs[1].totalQuantity).toBe(100);
      await expect(
        prisma.orderRevision.update({
          where: { id: revisions[0].id },
          data: { reason: 'x' },
        }),
      ).rejects.toThrow();
      expect(await auditActions(app, order.id)).toContain('order.revised');
      const types = (
        await a.admin
          .get(`/admin/orders/${order.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toContain('ORDER_REVISED');
    });

    it('rejects an invalid revision and one with nothing in it', async () => {
      const order = await readyOrder(a.admin, s);
      await a.admin
        .post(`/admin/orders/${order.id}/revise`, { reason: 'empty change' })
        .expect(400);
      await a.admin
        .post(`/admin/orders/${order.id}/revise`, {
          reason: 'bad totals',
          items: [
            {
              quantity: 100,
              variants: [{ sizeOptionId: s.sizeM, quantity: 50 }],
            },
          ],
        })
        .expect(409);
      expect((await orderDetail(a.admin, order.id)).currentSpec!.revision).toBe(
        1,
      ); // nothing was applied
      const draft = await createOrder(a.sales, s.sampleId);
      await a.admin
        .post(`/admin/orders/${draft.id}/revise`, {
          reason: 'draft is edited directly',
          targetDeliveryDate: '2027-02-01T00:00:00.000Z',
        })
        .expect(409);
    });

    it('restricts changes heavily once production has started', async () => {
      const order = await readyOrder(a.admin, s);
      await a.admin
        .post(`/admin/orders/${order.id}/create-factory-job`)
        .expect(201);
      // a live job: no quantity changes
      const items = [
        {
          id: order.items[0]!.id,
          quantity: 100,
          variants: order.items[0]!.variants.map((v) => ({
            id: v.id,
            sizeOptionId: s.sizeM,
            quantity: v.quantity,
            fabricColorId: s.colorId,
          })),
        },
      ];
      await a.admin
        .post(`/admin/orders/${order.id}/revise`, {
          reason: 'try quantity change',
          items,
        })
        .expect(409);
      // but the delivery date can move, and it is recorded
      const r = (
        await a.admin
          .post(`/admin/orders/${order.id}/revise`, {
            reason: 'customer moved the date',
            targetDeliveryDate: '2027-03-01T00:00:00.000Z',
          })
          .expect(200)
      ).body;
      expect(r.currentSpec.revision).toBe(2);
      expect(r.targetDeliveryDate).toContain('2027-03-01');
    });
  });

  // ───────────────────────── priority ─────────────────────────
  describe('priority', () => {
    it('changes priority, audits it and pushes it to live jobs', async () => {
      const order = await readyOrder(a.admin, s, { priority: 'LOW' });
      const job = (
        await a.admin
          .post(`/admin/orders/${order.id}/create-factory-job`)
          .expect(201)
      ).body;
      expect(job.priority).toBe('LOW'); // inherited
      const r = (
        await a.admin
          .patch(`/admin/orders/${order.id}/priority`, {
            priority: 'URGENT',
            reason: 'event',
          })
          .expect(200)
      ).body;
      expect(r.priority).toBe('URGENT');
      expect(
        (await a.admin.get(`/admin/factory-jobs/${job.id}`).expect(200)).body
          .priority,
      ).toBe('URGENT');
      expect(await auditActions(app, order.id)).toContain(
        'order.priority_changed',
      );
      const tl = (
        await a.admin.get(`/admin/factory-jobs/${job.id}/timeline`).expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(tl).toContain('PRIORITY_CHANGED');
      await a.admin
        .patch(`/admin/orders/${order.id}/priority`, { priority: 'BOGUS' })
        .expect(400);
    });
  });

  // ───────────────────────── reorders ─────────────────────────
  describe('reorders', () => {
    it('creates a clean linked draft with the same approved reference and no production history', async () => {
      const source = await readyOrder(a.admin, s);
      const job = (
        await a.admin
          .post(`/admin/orders/${source.id}/create-factory-job`)
          .expect(201)
      ).body;
      const re = (
        await a.sales
          .post(`/admin/orders/${source.id}/reorder`, {
            targetDeliveryDate: '2027-04-01T00:00:00.000Z',
          })
          .expect(201)
      ).body;
      expect(re.id).not.toBe(source.id);
      expect(re.orderNumber).not.toBe(source.orderNumber);
      expect(re.status).toBe('DRAFT');
      expect(re.reorderOfOrderId).toBe(source.id);
      expect(re.reorderOfOrderNumber).toBe(source.orderNumber);
      expect((re.approvedReference as { id: string }).id).toBe(
        (source.approvedReference as { id: string }).id,
      );
      expect(
        re.items[0].variants.map((v: { quantity: number }) => v.quantity),
      ).toEqual([60, 40]);
      expect(
        re.items[0].variants.every(
          (v: { completedQuantity: number }) => v.completedQuantity === 0,
        ),
      ).toBe(true);
      expect(re.items[0].variants[0].id).not.toBe(
        source.items[0]!.variants[0]!.id,
      );
      // nothing from production history is copied
      expect(re.factoryJobs).toHaveLength(0);
      expect(re.batches).toHaveLength(0);
      expect(re.currentSpec).toBeNull();
      expect(re.productionSummary.completedQuantity).toBe(0);
      expect(await prisma.factoryJob.count({ where: { orderId: re.id } })).toBe(
        0,
      );
      expect(
        await prisma.jobActivity.count({ where: { jobId: job.id } }),
      ).toBeGreaterThan(0);
      expect(await auditActions(app, re.id)).toContain('order.reordered');
      const srcTl = (
        await a.admin
          .get(`/admin/orders/${source.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(srcTl).toContain('REORDER_CREATED');
      // the reorder follows the normal flow
      await a.sales
        .put(`/admin/orders/${re.id}/items`, {
          items: standardItems(s, 30, 20),
        })
        .expect(200);
      await a.sales.post(`/admin/orders/${re.id}/confirm`).expect(200);
    });

    it('can start empty, and only a confirmed order can be reordered', async () => {
      const source = await readyOrder(a.admin, s);
      const empty = (
        await a.sales
          .post(`/admin/orders/${source.id}/reorder`, { cloneItems: false })
          .expect(201)
      ).body;
      expect(empty.items).toHaveLength(0);
      const draft = await createOrder(a.sales, s.sampleId);
      await a.sales.post(`/admin/orders/${draft.id}/reorder`).expect(409);
    });

    it('rejects major changes: they are not order fields and need a new sample', async () => {
      const source = await readyOrder(a.admin, s);
      for (const field of [
        'fabricId',
        'patternVersionId',
        'printMethodId',
        'fitMethod',
        'artworkId',
        'productTypeId',
      ]) {
        await a.sales
          .post(`/admin/orders/${source.id}/reorder`, { [field]: s.colorId })
          .expect(400);
      }
      await a.sales
        .put(
          `/admin/orders/${(await createOrder(a.sales, s.sampleId)).id}/items`,
          {
            items: [
              {
                quantity: 1,
                fabricId: s.colorId,
                variants: [{ sizeOptionId: s.sizeM, quantity: 1 }],
              },
            ],
          },
        )
        .expect(400);
    });

    it('allows the simple changes: quantities, size breakdown and approved colours', async () => {
      const source = await readyOrder(a.admin, s);
      const re = (
        await a.sales.post(`/admin/orders/${source.id}/reorder`).expect(201)
      ).body;
      const r = (
        await a.sales
          .put(`/admin/orders/${re.id}/items`, {
            items: [
              {
                quantity: 150,
                variants: [
                  {
                    sizeOptionId: s.sizeS,
                    fabricColorId: s.color2Id,
                    quantity: 50,
                  },
                  {
                    sizeOptionId: s.sizeM,
                    fabricColorId: s.color2Id,
                    quantity: 50,
                  },
                  {
                    sizeOptionId: s.sizeL,
                    fabricColorId: s.colorId,
                    quantity: 50,
                  },
                ],
              },
            ],
          })
          .expect(200)
      ).body;
      expect(r.totalQuantity).toBe(150);
    });

    it('allocates distinct numbers when reordering concurrently', async () => {
      const source = await readyOrder(a.admin, s);
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          a.sales.post(`/admin/orders/${source.id}/reorder`),
        ),
      );
      expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(new Set(res.map((r) => r.body.orderNumber)).size).toBe(4);
    });
  });

  // ───────────────────────── listing ─────────────────────────
  describe('list and detail', () => {
    it('searches and filters with pagination', async () => {
      const order = await readyOrder(a.admin, s, { priority: 'URGENT' });
      const customer = await prisma.customer.findUniqueOrThrow({
        where: { id: s.customerId },
      });
      const brand = await prisma.brand.findUniqueOrThrow({
        where: { id: s.brandId },
      });
      const ids = async (qs: string) =>
        (await a.admin.get(`/admin/orders?${qs}`).expect(200)).body.data.map(
          (o: { id: string }) => o.id,
        );
      expect(await ids(`search=${order.orderNumber}`)).toEqual([order.id]);
      expect(
        await ids(
          `search=${encodeURIComponent(customer.displayName)}&pageSize=100`,
        ),
      ).toContain(order.id);
      expect(
        await ids(`search=${encodeURIComponent(brand.name)}&pageSize=100`),
      ).toContain(order.id);
      expect(await ids(`search=${s.sampleNumber}&pageSize=100`)).toContain(
        order.id,
      );
      if (customer.email)
        expect(
          await ids(
            `search=${encodeURIComponent(customer.email)}&pageSize=100`,
          ),
        ).toContain(order.id);
      if (customer.phone)
        expect(
          await ids(
            `search=${encodeURIComponent(customer.phone)}&pageSize=100`,
          ),
        ).toContain(order.id);
      expect(
        await ids(`status=READY_FOR_PRODUCTION&priority=URGENT&pageSize=100`),
      ).toContain(order.id);
      expect(await ids(`status=DRAFT&pageSize=100`)).not.toContain(order.id);
      expect(await ids(`productionStatus=NOT_STARTED&pageSize=100`)).toContain(
        order.id,
      );
      expect(
        await ids(`productionStatus=COMPLETED&pageSize=100`),
      ).not.toContain(order.id);
      expect(
        await ids(
          `customerId=${s.customerId}&brandId=${s.brandId}&pageSize=100`,
        ),
      ).toContain(order.id);
      expect(await ids(`sourceSampleId=${s.sampleId}&pageSize=100`)).toContain(
        order.id,
      );
      const page = (
        await a.admin
          .get('/admin/orders?pageSize=3&page=1&sort=oldest')
          .expect(200)
      ).body;
      expect(page.data.length).toBeLessThanOrEqual(3);
      expect(page.meta.total).toBeGreaterThan(3);
      await a.admin.get('/admin/orders?status=NOPE').expect(400);
      await a.admin
        .get('/admin/orders/00000000-0000-4000-8000-000000000000')
        .expect(404);
    });

    it('filters on sales owner and delay', async () => {
      const order = await readyOrder(a.admin, s, {
        assignedSalesUserId: a.salesUserId,
        targetDeliveryDate: '2020-01-01T00:00:00.000Z',
      });
      const ids = async (qs: string) =>
        (
          await a.admin.get(`/admin/orders?${qs}&pageSize=100`).expect(200)
        ).body.data.map((o: { id: string }) => o.id);
      expect(await ids(`assignedSalesUserId=${a.salesUserId}`)).toContain(
        order.id,
      );
      expect(await ids('delayed=true')).toContain(order.id);
      const onTime = await readyOrder(a.admin, s, {
        targetDeliveryDate: '2099-01-01T00:00:00.000Z',
      });
      expect(await ids('delayed=true')).not.toContain(onTime.id);
      const row = (
        await a.admin
          .get(`/admin/orders?search=${order.orderNumber}`)
          .expect(200)
      ).body.data[0];
      expect(row.isDelayed).toBe(true);
    });

    it('returns a rich detail without storage internals', async () => {
      const order = await readyOrder(a.admin, s);
      const d = (await a.admin.get(`/admin/orders/${order.id}`).expect(200))
        .body;
      for (const k of [
        'customer',
        'brand',
        'approvedReference',
        'currentSpec',
        'items',
        'batches',
        'factoryJobs',
        'productionSummary',
        'recentActivities',
      ])
        expect(d[k]).toBeDefined();
      expect(d.customer.name).toBeTruthy();
      expect(d.recentActivities.length).toBeGreaterThan(1);
      expect(JSON.stringify(d)).not.toMatch(
        /storageKey|storage_key|passwordHash/,
      );
    });
  });

  // ───────────────────────── authorization ─────────────────────────
  describe('authorization', () => {
    it('denies unauthenticated and factory roles; sales cannot cancel; finance reads only', async () => {
      const order = await readyOrder(a.admin, s);
      for (const w of [floor.cutting, floor.qc, floor.packaging]) {
        await w.api.get('/admin/orders').expect(403);
        await w.api.get(`/admin/orders/${order.id}`).expect(403);
        await w.api
          .post(`/admin/samples/${s.sampleId}/create-order`)
          .expect(403);
        await w.api
          .get(`/admin/orders/${order.id}/production-summary`)
          .expect(403);
      }
      await a.sales.get(`/admin/orders/${order.id}`).expect(200);
      await a.sales
        .get(`/admin/orders/${order.id}/production-summary`)
        .expect(200);
      await a.sales
        .post(`/admin/orders/${order.id}/cancel`, {
          reason: 'sales may not cancel',
        })
        .expect(403);
      await a.sales.post(`/admin/orders/${order.id}/reorder`).expect(201);
      await a.finance.get(`/admin/orders/${order.id}`).expect(200);
      await a.finance
        .post(`/admin/samples/${s.sampleId}/create-order`)
        .expect(403);
      await a.finance.post(`/admin/orders/${order.id}/confirm`).expect(403);
      await a.finance.get(`/admin/orders/${order.id}/batches`).expect(403);
      // confirmation is its own permission
      const manager = await createUserAndLogin(app, {
        permissions: ['orders.read', 'orders.manage'],
      });
      const mgr = api(app, manager.accessToken);
      const draft = (
        await mgr
          .post(`/admin/samples/${s.sampleId}/create-order`, {
            items: standardItems(s),
          })
          .expect(201)
      ).body;
      await mgr.post(`/admin/orders/${draft.id}/confirm`).expect(403);
      await a.admin.get('/admin/orders').expect(200);
      const request = (await import('supertest')).default;
      await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .expect(401);
    });

    it('seeds the Phase 5A permissions and grants least privilege', async () => {
      const codes = [
        'orders.read',
        'orders.manage',
        'orders.confirm',
        'orders.cancel',
        'orders.reorder',
        'order_batches.read',
        'order_batches.manage',
        'production_quantity.report',
      ];
      expect(
        await prisma.permission.count({ where: { code: { in: codes } } }),
      ).toBe(8);
      const grants = async (role: string) =>
        (
          await prisma.rolePermission.findMany({
            where: { role: { code: role } },
            include: { permission: true },
          })
        ).map((g) => g.permission.code);
      const admin = await grants('ADMIN');
      for (const c of codes) expect(admin).toContain(c);
      const sales = await grants('SALES');
      expect(sales).toEqual(
        expect.arrayContaining([
          'orders.read',
          'orders.manage',
          'orders.confirm',
          'orders.reorder',
          'order_batches.read',
        ]),
      );
      expect(sales).not.toContain('orders.cancel');
      expect(sales).not.toContain('order_batches.manage');
      expect(await grants('FINANCE')).toContain('orders.read');
      expect(await grants('FINANCE')).not.toContain('orders.manage');
      expect(await grants('CUTTING')).toContain('production_quantity.report');
      expect(await grants('CUTTING')).not.toContain('orders.read');
      expect(await grants('SUPER_ADMIN')).toEqual(
        expect.arrayContaining(codes),
      );
    });
  });
});
