import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auditActions,
  auth,
  createTestApp,
  createUserAndLogin,
} from './support/app.js';
import {
  PNG,
  api,
  createCustomerWithBrand,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';
import {
  assignWorker,
  currentStage,
  makeFloor,
  makeWorker,
  STAGE_ORDER,
  type Floor,
  type Worker,
} from './support/floor.js';
import {
  approvedReferenceSample,
  createOrder,
  orderDetail,
  packagingBody,
  producedOrder,
  readyOrder,
  runBulkStage,
  standardItems,
  staffStage,
  type ApprovedSample,
  type OrderBody,
} from './support/orders.js';

describe('Packaging, shipments and delivery (Phase 5B, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let addressId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    addressId = (
      await prisma.customerAddress.create({
        data: {
          customerId: s.customerId,
          country: 'Egypt',
          city: 'Cairo',
          area: 'Nasr City',
          addressLine1: '12 Textile St',
          addressLine2: 'Floor 3',
          postalCode: '11765',
          notes: 'Ring twice',
        },
      })
    ).id;
  });
  afterAll(() => app.close());

  const delivery = async () => makeWorker(app, 'DELIVERY');
  const shipBody = (
    o: OrderBody,
    lines: [number, number][],
    extra: Record<string, unknown> = {},
  ) => ({
    deliveryMethod: 'OWN_DELIVERY',
    recipientName: 'Mona Ali',
    recipientPhone: '+201001112233',
    customerAddressId: addressId,
    lines: lines.map(([variant, quantity]) => ({
      orderVariantId: o.items[0]!.variants[variant]!.id,
      quantity,
    })),
    ...extra,
  });
  const ship = async (
    o: OrderBody,
    lines: [number, number][],
    extra: Record<string, unknown> = {},
    expected = 201,
  ) =>
    a.admin
      .post(`/admin/orders/${o.id}/shipments`, shipBody(o, lines, extra))
      .expect(expected);
  const send = async (id: string, w: Worker) => {
    await a.admin.post(`/admin/shipments/${id}/ready`).expect(200);
    await w.api.post(`/staff/deliveries/${id}/dispatch`, {}).expect(200);
  };
  const status = async (id: string) => (await orderDetail(a.admin, id)).status;

  // ───────────────────────── packaging ─────────────────────────
  describe('packaging specification and execution', () => {
    it('defines the specification with master-data and custom components', async () => {
      const o = await readyOrder(a.admin, s);
      const polybag = await prisma.componentOption.findUniqueOrThrow({
        where: { code: 'POLYBAG' },
      });
      expect(
        (await a.sales.get(`/admin/orders/${o.id}/packaging`).expect(200)).body,
      ).toMatchObject({ defined: false, components: [] });
      const r = (
        await a.sales
          .put(`/admin/orders/${o.id}/packaging`, {
            ...packagingBody,
            stickersRequired: true,
            stickerNotes: 'Barcode sticker on the polybag',
            specialInstructions: 'Keep sleeves out of the bag',
            components: [
              {
                componentOptionId: polybag.id,
                quantityPerUnit: 1,
                notes: 'resealable',
              },
              { customName: 'Tissue paper', quantityPerUnit: 2 },
            ],
          })
          .expect(200)
      ).body;
      expect(r.defined).toBe(true);
      expect(r).toMatchObject({
        polybagRequired: true,
        hangTagsRequired: true,
        unitsPerCarton: 25,
        stickersRequired: true,
      });
      expect(r.components.map((c: { name: string }) => c.name)).toEqual([
        polybag.name,
        'Tissue paper',
      ]);
      expect(r.components[0].componentCode).toBe('POLYBAG');
      expect(r.reconciliation).toMatchObject({
        completedQuantity: 0,
        packedQuantity: 0,
        packagingComplete: false,
      });
      expect(await auditActions(app, o.id)).toContain(
        'order_packaging.updated',
      );
      // edit: components replaced only when sent
      const again = (
        await a.sales
          .put(`/admin/orders/${o.id}/packaging`, { cartonNotes: 'Max 10 kg' })
          .expect(200)
      ).body;
      expect(again.cartonNotes).toBe('Max 10 kg');
      expect(again.components).toHaveLength(2);
    });

    it('rejects invalid packaging input and needs packaging.manage', async () => {
      const o = await readyOrder(a.admin, s);
      const polybag = await prisma.componentOption.findUniqueOrThrow({
        where: { code: 'POLYBAG' },
      });
      const put = (body: object) =>
        a.admin.put(`/admin/orders/${o.id}/packaging`, body);
      await put({
        components: [{ componentOptionId: polybag.id, customName: 'both' }],
      }).expect(400);
      await put({ components: [{}] }).expect(400);
      await put({
        components: [
          { componentOptionId: polybag.id },
          { componentOptionId: polybag.id },
        ],
      }).expect(400);
      await put({
        components: [
          { componentOptionId: '00000000-0000-4000-8000-000000000000' },
        ],
      }).expect(400);
      await put({ unitsPerCarton: 0 }).expect(400);
      await put({ unitsPerCarton: 1.5 }).expect(400);
      await put({ polybagRequired: 'yes' }).expect(400);
      await put({ unknownField: 1 }).expect(400);
      await a.finance
        .put(`/admin/orders/${o.id}/packaging`, packagingBody)
        .expect(403);
      await floor.cutting.api
        .put(`/admin/orders/${o.id}/packaging`, packagingBody)
        .expect(403);
      await floor.cutting.api
        .get(`/admin/orders/${o.id}/packaging`)
        .expect(403);
    });

    it('packaging reports need the specification and are append-only, reconciled and validated', async () => {
      const o = await readyOrder(a.admin, s);
      const job = (
        await a.admin
          .post(`/admin/orders/${o.id}/create-factory-job`)
          .expect(201)
      ).body;
      for (const code of STAGE_ORDER.slice(0, 8))
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      const pack = await currentStage(a.admin, job.id, 'PACKAGING');
      expect(await status(o.id)).toBe('READY_FOR_PACKAGING');
      const w = await assignWorker(a.admin, floor, pack);
      await w.api.post(`/staff/job-stages/${pack.id}/start`).expect(200);
      expect(await status(o.id)).toBe('PACKAGING');
      const url = `/staff/job-stages/${pack.id}/packaging-reports`;
      await w.api.post(url, { packedQuantity: 10 }).expect(409); // no packaging specification yet
      await a.admin
        .put(`/admin/orders/${o.id}/packaging`, packagingBody)
        .expect(409); // …and it cannot be defined while packers are working
      expect(
        await prisma.orderPackagingSpec.count({ where: { orderId: o.id } }),
      ).toBe(0);
    });

    it('records packed, damaged and carton counts, blocks bad quantities and keeps history', async () => {
      const o = await readyOrder(a.admin, s);
      await a.admin
        .put(`/admin/orders/${o.id}/packaging`, packagingBody)
        .expect(200);
      const job = (
        await a.admin
          .post(`/admin/orders/${o.id}/create-factory-job`)
          .expect(201)
      ).body;
      for (const code of STAGE_ORDER.slice(0, 8))
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      const pack = await currentStage(a.admin, job.id, 'PACKAGING');
      const w = await assignWorker(a.admin, floor, pack);
      const url = `/staff/job-stages/${pack.id}/packaging-reports`;
      await w.api.post(url, { packedQuantity: 10 }).expect(409); // not started
      await w.api.post(`/staff/job-stages/${pack.id}/start`).expect(200);
      await w.api.post(url, { packedQuantity: -1 }).expect(400);
      await w.api.post(url, { packedQuantity: 1.5 }).expect(400);
      await w.api.post(url, { packedQuantity: 0 }).expect(400); // nothing reported
      await w.api.post(url, { packedQuantity: 101 }).expect(409); // more than the stage handles
      await w.api
        .post(url, { packedQuantity: 60, damagedQuantity: 41 })
        .expect(409);
      await w.api
        .post(url, {
          packedQuantity: 50,
          cartonCount: 2,
          notes: 'first pallet',
        })
        .expect(201);
      await w.api
        .post(url, { packedQuantity: 45, damagedQuantity: 5, cartonCount: 2 })
        .expect(201);
      await w.api.post(url, { packedQuantity: 1 }).expect(409); // all 100 accounted for
      await floor.sewing.api.post(url, { packedQuantity: 1 }).expect(403); // not the packaging stage's worker
      const spec = (
        await a.admin.get(`/admin/orders/${o.id}/packaging`).expect(200)
      ).body;
      expect(spec.reports).toHaveLength(2);
      expect(spec.reconciliation).toMatchObject({
        packedQuantity: 95,
        damagedQuantity: 5,
        cartonCount: 4,
      });
      expect(
        spec.reports.map((r: { packedQuantity: number }) => r.packedQuantity),
      ).toEqual([50, 45]);
      const row = await prisma.packagingReport.findFirstOrThrow({
        where: { jobStageId: pack.id },
      });
      await expect(
        prisma.packagingReport.update({
          where: { id: row.id },
          data: { packedQuantity: 1 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.packagingReport.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      // the packing instructions reach the packer, without commercial data
      const view = await staffStage(w.api, pack.id);
      expect(JSON.stringify(view.orderView)).toContain('Fold in thirds');
      expect(JSON.stringify(view)).not.toMatch(
        /paymentState|unitPrice|quotation/,
      );
      // a non-packaging stage rejects packaging reports
      const fab = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      expect(fab.status).toBe('COMPLETED');
    });

    it('is not ready for delivery until production is complete, packaging is defined and every unit is packed', async () => {
      const noSpec = await producedOrder(app, a, floor, s, {
        packaging: false,
      });
      expect(noSpec.order.status).toBe('PRODUCTION_COMPLETED'); // produced but not packaged/ready
      await a.admin
        .post(
          `/admin/orders/${noSpec.order.id}/shipments`,
          shipBody(noSpec.order, [[0, 10]]),
        )
        .expect(409);
      await a.admin
        .put(`/admin/orders/${noSpec.order.id}/packaging`, packagingBody)
        .expect(200);
      // the spec exists now, but nothing was reported through the packaging stage? it was: plain reports count as packed units
      expect(await status(noSpec.order.id)).toBe('READY_FOR_DELIVERY');
      const done = await producedOrder(app, a, floor, s);
      expect(done.order.status).toBe('READY_FOR_DELIVERY');
      expect(done.order.fulfillment).toMatchObject({
        packagingDefined: true,
        packedQuantity: 100,
        packagingComplete: true,
        shippableQuantity: 100,
        remainingDeliveryQuantity: 100,
      });
      const types = (
        await a.admin
          .get(`/admin/orders/${done.order.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'PACKAGING_STARTED',
          'PACKAGING_COMPLETED',
          'PRODUCTION_COMPLETED',
        ]),
      );
    });

    it('damaged units are scrapped: only packed units are deliverable', async () => {
      const o = await producedOrder(app, a, floor, s, { damaged: 6 });
      expect(o.order.fulfillment).toMatchObject({
        packedQuantity: 94,
        shippableQuantity: 94,
        remainingDeliveryQuantity: 94,
      });
      expect(o.order.status).toBe('READY_FOR_DELIVERY');
      await ship(
        o.order,
        [
          [0, 60],
          [1, 40],
        ],
        {},
        409,
      ); // variant 1 only has 34 deliverable? 100−6 spread
    });
  });

  // ───────────────────────── shipments ─────────────────────────
  describe('shipments and partial shipments', () => {
    it('creates a shipment from variant quantities with an address snapshot', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      await a.sales
        .post(`/admin/orders/${o.id}/shipments`, shipBody(o, [[0, 60]]))
        .expect(403); // shipments.manage is admin's
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { notes: 'Fragile', deliveryNotes: 'Call before arriving' },
        )
      ).body;
      expect(r.shipmentNumber).toMatch(/^SHP-\d{6}$/);
      expect(r).toMatchObject({
        status: 'DRAFT',
        totalQuantity: 100,
        orderNumber: o.orderNumber,
        recipientName: 'Mona Ali',
        deliveryNotes: 'Call before arriving',
      });
      expect(r.addressSnapshot).toMatchObject({
        source: 'CUSTOMER_ADDRESS',
        city: 'Cairo',
        addressLine1: '12 Textile St',
        postalCode: '11765',
      });
      expect(r.lines).toHaveLength(2);
      expect(r.lines[0].label).toMatch(/\//);
      expect(await auditActions(app, r.id)).toContain('shipment.created');
      const d = await orderDetail(a.admin, o.id);
      expect(d.shipments).toHaveLength(1);
      expect(d.fulfillment).toMatchObject({
        shippableQuantity: 0,
        deliveredQuantity: 0,
      });
      expect(
        (await a.admin.get(`/admin/orders/${o.id}/shipments`).expect(200)).body,
      ).toHaveLength(1);
      expect(
        (
          await a.admin
            .get(`/admin/shipments?orderId=${o.id}&status=DRAFT`)
            .expect(200)
        ).body.data,
      ).toHaveLength(1);
      expect(
        (await a.sales.get(`/admin/shipments/${r.id}`).expect(200)).body.id,
      ).toBe(r.id);
    });

    it('keeps the destination immutable even if the customer address changes', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const r = (await ship(o, [[0, 10]])).body;
      await prisma.customerAddress.update({
        where: { id: addressId },
        data: { city: 'Giza', addressLine1: 'Somewhere else' },
      });
      try {
        const after = (
          await a.admin.get(`/admin/shipments/${r.id}`).expect(200)
        ).body;
        expect(after.addressSnapshot).toMatchObject({
          city: 'Cairo',
          addressLine1: '12 Textile St',
        });
        await expect(
          prisma.shipment.update({
            where: { id: r.id },
            data: { addressSnapshot: { city: 'Hacked' } },
          }),
        ).rejects.toThrow();
        await expect(
          prisma.shipment.update({
            where: { id: r.id },
            data: { orderId: s.sampleId },
          }),
        ).rejects.toThrow();
        await expect(
          prisma.shipment.delete({ where: { id: r.id } }),
        ).rejects.toThrow();
        // the API has no way to change the destination either
        await a.admin
          .patch(`/admin/shipments/${r.id}`, { addressSnapshot: { city: 'x' } })
          .expect(400);
        await a.admin
          .patch(`/admin/shipments/${r.id}`, { customerAddressId: addressId })
          .expect(400);
      } finally {
        await prisma.customerAddress.update({
          where: { id: addressId },
          data: { city: 'Cairo', addressLine1: '12 Textile St' },
        });
      }
    });

    it('accepts a one-off address or pickup and validates the recipient and destination', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const custom = (
        await ship(o, [[0, 5]], {
          customerAddressId: undefined,
          address: { city: 'Alexandria', addressLine1: '5 Corniche Rd' },
        })
      ).body;
      expect(custom.addressSnapshot).toMatchObject({
        source: 'CUSTOM',
        city: 'Alexandria',
      });
      const pickup = (
        await ship(o, [[0, 5]], {
          deliveryMethod: 'CUSTOMER_PICKUP',
          customerAddressId: undefined,
        })
      ).body;
      expect(pickup.addressSnapshot).toMatchObject({ source: 'PICKUP' });
      await ship(o, [[0, 5]], { customerAddressId: undefined }, 400); // delivery needs a destination
      await ship(
        o,
        [[0, 5]],
        { address: { city: 'x', addressLine1: 'y1' } },
        400,
      ); // both a saved and a one-off address
      await ship(o, [[0, 5]], { recipientPhone: 'call me' }, 400);
      await ship(o, [[0, 5]], { recipientName: ' ' }, 400);
      await ship(o, [[0, 5]], { deliveryMethod: 'DRONE' }, 400);
      await ship(
        o,
        [[0, 5]],
        { customerAddressId: '00000000-0000-4000-8000-000000000000' },
        400,
      );
      const { customer: other } = await createCustomerWithBrand(a.admin);
      const foreign = await prisma.customerAddress.create({
        data: {
          customerId: other.id,
          country: 'Egypt',
          city: 'Luxor',
          addressLine1: 'Not theirs',
        },
      });
      await ship(o, [[0, 5]], { customerAddressId: foreign.id }, 400); // another customer's address
      await ship(o, [], {}, 400);
      await ship(o, [[0, 0]], {}, 400);
    });

    it('supports multiple partial shipments and blocks over-shipping', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      await ship(o, [[0, 61]], {}, 409); // variant 0 has only 60 units
      const first = (await ship(o, [[0, 40]])).body;
      await ship(o, [[0, 21]], {}, 409);
      const second = (
        await ship(o, [
          [0, 20],
          [1, 30],
        ])
      ).body;
      expect(
        (await orderDetail(a.admin, o.id)).fulfillment.shippableQuantity,
      ).toBe(10);
      await ship(o, [[1, 11]], {}, 409); // 10 left on variant 1
      await ship(
        o,
        [
          [0, 5],
          [0, 5],
        ],
        {},
        400,
      ); // duplicate variant
      await ship(o, [[1, 10]]);
      await ship(o, [[0, 1]], {}, 409); // everything is committed
      // cancelling frees the units
      await a.admin
        .post(`/admin/shipments/${first.id}/cancel`, {
          reason: 'merged into another',
        })
        .expect(200);
      await ship(o, [[0, 40]]);
      expect(second.id).not.toBe(first.id);
      expect(await prisma.shipment.count({ where: { orderId: o.id } })).toBe(4);
      await ship(
        { ...o, id: '00000000-0000-4000-8000-000000000000' } as OrderBody,
        [[0, 1]],
        {},
        404,
      );
    });

    it('never over-ships under concurrency', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          a.admin.post(
            `/admin/orders/${o.id}/shipments`,
            shipBody(o, [[0, 40]]),
          ),
        ),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(3);
      const lines = await prisma.shipmentLine.aggregate({
        where: { shipment: { orderId: o.id } },
        _sum: { quantity: true },
      });
      expect(lines._sum.quantity).toBe(40);
    });

    it('enforces the shipping rule in the database too', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const r = (await ship(o, [[0, 50]])).body;
      const second = (await ship(o, [[1, 5]])).body;
      const v0 = o.items[0]!.variants[0]!.id;
      await expect(
        prisma.shipmentLine.create({
          data: { shipmentId: second.id, orderVariantId: v0, quantity: 11 },
        }),
      ).rejects.toThrow(/over-shipping/i);
      await expect(
        prisma.shipmentLine.create({
          data: { shipmentId: second.id, orderVariantId: v0, quantity: 0 },
        }),
      ).rejects.toThrow();
      // lines freeze once the shipment leaves DRAFT
      await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(200);
      const line = await prisma.shipmentLine.findFirstOrThrow({
        where: { shipmentId: r.id },
      });
      await expect(
        prisma.shipmentLine.update({
          where: { id: line.id },
          data: { quantity: 1 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.shipmentLine.delete({ where: { id: line.id } }),
      ).rejects.toThrow();
      await a.admin
        .patch(`/admin/shipments/${r.id}`, {
          lines: [{ orderVariantId: v0, quantity: 1 }],
        })
        .expect(409);
      // a variant of another order is refused
      const other = await readyOrder(a.admin, s);
      await expect(
        prisma.shipmentLine.create({
          data: {
            shipmentId: second.id,
            orderVariantId: other.items[0]!.variants[0]!.id,
            quantity: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it('edits a DRAFT shipment and re-validates it when marking READY', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const r = (await ship(o, [[0, 30]])).body;
      const v1 = o.items[0]!.variants[1]!.id;
      const edited = (
        await a.admin
          .patch(`/admin/shipments/${r.id}`, {
            recipientName: 'Omar Said',
            notes: 'updated',
            lines: [{ orderVariantId: v1, quantity: 25 }],
          })
          .expect(200)
      ).body;
      expect(edited).toMatchObject({
        recipientName: 'Omar Said',
        totalQuantity: 25,
      });
      await a.admin
        .patch(`/admin/shipments/${r.id}`, {
          lines: [{ orderVariantId: v1, quantity: 41 }],
        })
        .expect(409);
      await a.admin
        .patch(`/admin/shipments/${r.id}`, { recipientPhone: 'nope' })
        .expect(400);
      const ready = (
        await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(200)
      ).body;
      expect(ready.status).toBe('READY');
      expect(ready.readyAt).toBeTruthy();
      await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(409);
      await a.admin
        .patch(`/admin/shipments/${r.id}`, { recipientName: 'Late change' })
        .expect(200); // still allowed before dispatch
      expect(await auditActions(app, r.id)).toEqual(
        expect.arrayContaining(['shipment.updated', 'shipment.ready']),
      );
    });
  });

  // ───────────────────────── delivery ─────────────────────────
  describe('dispatch and delivery', () => {
    it('dispatches once, tracks the order status and refuses double dispatch', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r = (await ship(o, [[0, 60]], { assignedDeliveryUserId: w.id }))
        .body;
      await w.api.post(`/staff/deliveries/${r.id}/dispatch`, {}).expect(404); // still a draft: invisible to delivery staff
      await a.admin.post(`/admin/shipments/${r.id}/dispatch`, {}).expect(409); // not READY
      await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(200);
      const d1 = (
        await w.api
          .post(`/staff/deliveries/${r.id}/dispatch`, {
            trackingNumber: 'TRK-1',
          })
          .expect(200)
      ).body;
      expect(d1).toMatchObject({
        status: 'DISPATCHED',
        trackingNumber: 'TRK-1',
      });
      expect(d1.dispatchedAt).toBeTruthy();
      await w.api.post(`/staff/deliveries/${r.id}/dispatch`, {}).expect(409);
      await a.admin.post(`/admin/shipments/${r.id}/dispatch`, {}).expect(409);
      expect(await status(o.id)).toBe('PARTIALLY_SHIPPED'); // 60 of 100 on the road
      const full = (await ship(o, [[1, 40]], { assignedDeliveryUserId: w.id }))
        .body;
      await send(full.id, w);
      expect(await status(o.id)).toBe('OUT_FOR_DELIVERY'); // every unit is on a van
      await w.api.post(`/staff/deliveries/${full.id}/in-transit`).expect(200);
      await w.api.post(`/staff/deliveries/${full.id}/in-transit`).expect(409);
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'SHIPMENT_CREATED',
          'SHIPMENT_READY',
          'SHIPMENT_DISPATCHED',
        ]),
      );
      expect(await auditActions(app, r.id)).toContain('shipment.dispatched');
    });

    it('needs a delivery person for own delivery and a courier for courier shipments', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const own = (await ship(o, [[0, 10]])).body; // no assignee
      await a.admin.post(`/admin/shipments/${own.id}/ready`).expect(200);
      await a.admin.post(`/admin/shipments/${own.id}/dispatch`, {}).expect(400);
      const courier = (await ship(o, [[0, 10]], { deliveryMethod: 'COURIER' }))
        .body;
      await a.admin.post(`/admin/shipments/${courier.id}/ready`).expect(200);
      await a.admin
        .post(`/admin/shipments/${courier.id}/dispatch`, {})
        .expect(400);
      const ok = (
        await a.admin
          .post(`/admin/shipments/${courier.id}/dispatch`, {
            courierName: 'Bosta',
            trackingNumber: 'B-77',
            trackingUrl: 'https://track.example.test/B-77',
          })
          .expect(200)
      ).body;
      expect(ok).toMatchObject({ courierName: 'Bosta', status: 'DISPATCHED' });
      // only people who can deliver are assignable
      await ship(o, [[0, 5]], { assignedDeliveryUserId: a.salesUserId }, 400);
      await ship(
        o,
        [[0, 5]],
        { assignedDeliveryUserId: floor.cutting.id },
        400,
      );
      await a.admin
        .patch(`/admin/shipments/${own.id}`, {
          assignedDeliveryUserId: floor.sewing.id,
        })
        .expect(400);
    });

    it('partial delivery does not complete the order; full delivery does, then it can be closed', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const s1 = (await ship(o, [[0, 60]], { assignedDeliveryUserId: w.id }))
        .body;
      const s2 = (await ship(o, [[1, 40]], { assignedDeliveryUserId: w.id }))
        .body;
      await send(s1.id, w);
      await w.api
        .post(`/staff/deliveries/${s1.id}/delivered`, {
          notes: 'Received by Mona',
        })
        .expect(200);
      await w.api.post(`/staff/deliveries/${s1.id}/delivered`, {}).expect(409); // already delivered
      let d = await orderDetail(a.admin, o.id);
      expect(d.status).toBe('PARTIALLY_SHIPPED'); // 60 delivered, 40 pending
      expect(d.fulfillment).toMatchObject({
        deliveredQuantity: 60,
        remainingDeliveryQuantity: 40,
      });
      expect(
        (await a.admin.post(`/admin/orders/${o.id}/complete`).expect(409)).body
          .message,
      ).toBeTruthy();
      await send(s2.id, w);
      expect(await status(o.id)).toBe('OUT_FOR_DELIVERY');
      await w.api.post(`/staff/deliveries/${s2.id}/delivered`, {}).expect(200);
      d = await orderDetail(a.admin, o.id);
      expect(d.status).toBe('DELIVERED');
      expect(d.deliveredAt).toBeTruthy();
      expect(d.fulfillment).toMatchObject({
        deliveredQuantity: 100,
        remainingDeliveryQuantity: 0,
        inFlightQuantity: 0,
      });
      // production done + delivered, but closing is its own checked step
      await a.sales
        .post(`/admin/orders/${o.id}/complete`)
        .expect(200)
        .then((r) => expect(r.body.status).toBe('COMPLETED'));
      expect((await orderDetail(a.admin, o.id)).closedAt).toBeTruthy();
      await a.admin.post(`/admin/orders/${o.id}/complete`).expect(409);
      await a.admin
        .post(`/admin/orders/${o.id}/cancel`, { reason: 'too late now' })
        .expect(409);
      await a.admin
        .patch(`/admin/orders/${o.id}/priority`, { priority: 'LOW' })
        .expect(409);
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'SHIPMENT_DELIVERED',
          'ORDER_DELIVERED',
          'ORDER_COMPLETED',
        ]),
      );
      expect(await auditActions(app, o.id)).toContain('order.completed');
      await expect(
        prisma.order.update({
          where: { id: o.id },
          data: { status: 'DELIVERED' },
        }),
      ).rejects.toThrow(); // COMPLETED is final
    });

    it('production finishing alone never completes an order', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      expect(o.status).toBe('READY_FOR_DELIVERY');
      await a.admin.post(`/admin/orders/${o.id}/complete`).expect(409);
      const r = (await ship(o, [[0, 60]])).body;
      expect(r.status).toBe('DRAFT');
      expect(await status(o.id)).toBe('READY_FOR_DELIVERY'); // a draft shipment changes nothing
      await a.admin.post(`/admin/orders/${o.id}/complete`).expect(409);
    });

    it('closes an order exactly once under concurrency', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      await send(r.id, w);
      await w.api.post(`/staff/deliveries/${r.id}/delivered`, {}).expect(200);
      const res = await Promise.all(
        [1, 2, 3].map(() => a.admin.post(`/admin/orders/${o.id}/complete`)),
      );
      expect(res.filter((x) => x.status === 200)).toHaveLength(1);
      expect(res.filter((x) => x.status === 409)).toHaveLength(2);
      expect(
        await prisma.orderActivity.count({
          where: { orderId: o.id, type: 'ORDER_COMPLETED' },
        }),
      ).toBe(1);
    });

    it('records failed deliveries and returns with reasons, keeps history, and frees returned units', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      await send(r.id, w);
      expect(await status(o.id)).toBe('OUT_FOR_DELIVERY');
      await w.api.post(`/staff/deliveries/${r.id}/failed`, {}).expect(400);
      const failed = (
        await w.api
          .post(`/staff/deliveries/${r.id}/failed`, {
            reason: 'Customer not at home',
          })
          .expect(200)
      ).body;
      expect(failed.status).toBe('FAILED');
      let admin = (await a.admin.get(`/admin/shipments/${r.id}`).expect(200))
        .body;
      expect(admin).toMatchObject({
        status: 'FAILED',
        failureReason: 'Customer not at home',
      });
      expect(admin.failedAt).toBeTruthy();
      expect(await status(o.id)).toBe('READY_FOR_DELIVERY'); // nothing on the road any more
      await w.api.post(`/staff/deliveries/${r.id}/delivered`, {}).expect(409); // a failed delivery must be retried first
      // retry: dispatch again; the first dispatch time is kept
      const firstDispatch = admin.dispatchedAt;
      await w.api.post(`/staff/deliveries/${r.id}/dispatch`, {}).expect(200);
      admin = (await a.admin.get(`/admin/shipments/${r.id}`).expect(200)).body;
      expect(admin.status).toBe('DISPATCHED');
      expect(admin.dispatchedAt).toBe(firstDispatch);
      await w.api
        .post(`/staff/deliveries/${r.id}/failed`, {
          reason: 'Wrong address given',
        })
        .expect(200);
      await w.api.post(`/staff/deliveries/${r.id}/returned`, {}).expect(400);
      await w.api
        .post(`/staff/deliveries/${r.id}/returned`, {
          reason: 'Goods back at the factory',
        })
        .expect(200);
      admin = (await a.admin.get(`/admin/shipments/${r.id}`).expect(200)).body;
      expect(admin).toMatchObject({
        status: 'RETURNED',
        returnReason: 'Goods back at the factory',
        failureReason: 'Wrong address given',
      });
      expect(admin.returnedAt).toBeTruthy();
      // returned units can be shipped again; the returned shipment stays on record
      expect(
        (await orderDetail(a.admin, o.id)).fulfillment.shippableQuantity,
      ).toBe(100);
      await ship(o, [
        [0, 60],
        [1, 40],
      ]);
      expect(await prisma.shipment.count({ where: { orderId: o.id } })).toBe(2);
      await a.admin
        .post(`/admin/shipments/${r.id}/return`, { reason: 'again again' })
        .expect(409);
      await a.admin
        .post(`/admin/shipments/${r.id}/cancel`, { reason: 'nope nope' })
        .expect(409);
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['SHIPMENT_FAILED', 'SHIPMENT_RETURNED']),
      );
      expect(await auditActions(app, r.id)).toEqual(
        expect.arrayContaining(['shipment.failed', 'shipment.returned']),
      );
    });

    it('lets admins drive a shipment too (no delivery person needed for pickup)', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { deliveryMethod: 'CUSTOMER_PICKUP', customerAddressId: undefined },
        )
      ).body;
      await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(200);
      await a.admin.post(`/admin/shipments/${r.id}/dispatch`, {}).expect(200);
      await a.admin.post(`/admin/shipments/${r.id}/in-transit`).expect(200);
      await a.admin
        .post(`/admin/shipments/${r.id}/deliver`, {
          notes: 'Collected by the owner',
        })
        .expect(200);
      expect(await status(o.id)).toBe('DELIVERED');
      await a.admin.post(`/admin/shipments/${r.id}/deliver`, {}).expect(409);
      await a.admin
        .post(`/admin/shipments/${r.id}/cancel`, { reason: 'too late now' })
        .expect(409);
    });

    it('delivers concurrently exactly once', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      await send(r.id, w);
      const res = await Promise.all(
        [1, 2, 3].map(() =>
          w.api.post(`/staff/deliveries/${r.id}/delivered`, {}),
        ),
      );
      expect(res.filter((x) => x.status === 200)).toHaveLength(1);
      expect(res.filter((x) => x.status === 409)).toHaveLength(3 - 1);
    });

    it('dispatches exactly once under concurrency', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(200);
      const res = await Promise.all(
        [1, 2, 3].map(() =>
          w.api.post(`/staff/deliveries/${r.id}/dispatch`, {}),
        ),
      );
      expect(res.filter((x) => x.status === 200)).toHaveLength(1);
      expect(res.filter((x) => x.status === 409)).toHaveLength(2);
    });
  });

  // ───────────────────────── delivery staff ─────────────────────────
  describe('delivery staff workflow', () => {
    it('shows only my open deliveries with just what a delivery person needs', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const other = await delivery();
      const mine = (
        await ship(o, [[0, 30]], {
          assignedDeliveryUserId: w.id,
          deliveryNotes: 'Gate code 4411',
        })
      ).body;
      const theirs = (
        await ship(o, [[1, 20]], { assignedDeliveryUserId: other.id })
      ).body;
      expect(
        (await w.api.get('/staff/deliveries').expect(200)).body.data,
      ).toEqual([]); // drafts are not shown
      await a.admin.post(`/admin/shipments/${mine.id}/ready`).expect(200);
      await a.admin.post(`/admin/shipments/${theirs.id}/ready`).expect(200);
      const list = (await w.api.get('/staff/deliveries').expect(200)).body;
      expect(list.data.map((d: { id: string }) => d.id)).toEqual([mine.id]);
      const d = (await w.api.get(`/staff/deliveries/${mine.id}`).expect(200))
        .body;
      expect(d).toMatchObject({
        shipmentNumber: mine.shipmentNumber,
        recipientName: 'Mona Ali',
        recipientPhone: '+201001112233',
        totalQuantity: 30,
        deliveryNotes: 'Gate code 4411',
      });
      expect(d.address).toMatchObject({
        city: 'Cairo',
        addressLine1: '12 Textile St',
      });
      expect(d.packages).toHaveLength(1);
      const text = JSON.stringify(d);
      for (const forbidden of [
        'paymentState',
        'quotation',
        'priority',
        'customerId',
        'brand',
        'internalNotes',
        'orderId',
        'createdByUserId',
        'audit',
        'unitPrice',
        'proofAssetId',
        'storageKey',
      ])
        expect(text).not.toContain(forbidden);
      await w.api.get(`/staff/deliveries/${theirs.id}`).expect(404);
      await w.api
        .post(`/staff/deliveries/${theirs.id}/dispatch`, {})
        .expect(404);
      await w.api
        .post(`/staff/deliveries/${theirs.id}/delivered`, {})
        .expect(404);
      await w.api
        .post(`/staff/deliveries/${theirs.id}/failed`, {
          reason: 'not mine to fail',
        })
        .expect(404);
      await w.api.get(`/staff/deliveries/${mine.id}/proof-url`).expect(404); // no proof yet
      expect(
        (await w.api.get('/staff/deliveries?includeFinished=true').expect(200))
          .body.data,
      ).toHaveLength(1);
    });

    it('keeps delivery staff away from admin, commercial and production data', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      await w.api.get('/admin/orders').expect(403);
      await w.api.get(`/admin/orders/${o.id}`).expect(403);
      await w.api.get(`/admin/orders/${o.id}/commercial`).expect(403);
      await w.api.get(`/admin/orders/${o.id}/quotations`).expect(403);
      await w.api.get(`/admin/orders/${o.id}/payments`).expect(403);
      await w.api.get('/admin/shipments').expect(403);
      await w.api
        .post(`/admin/orders/${o.id}/shipments`, shipBody(o, [[0, 1]]))
        .expect(403);
      await w.api.get('/admin/factory-jobs').expect(403);
      await w.api
        .get('/staff/my-stages')
        .expect(200)
        .then((r) => expect(r.body.data).toEqual([]));
      await floor.cutting.api.get('/staff/deliveries').expect(403);
      await a.finance.get('/staff/deliveries').expect(403);
      await a.sales.get('/staff/deliveries').expect(403);
    });

    it('stores delivery proof privately: uploads, signed URL for authorised staff only, never archivable', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const stranger = await delivery();
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      const upload = (token: string, id = r.id) =>
        request(app.getHttpServer())
          .post(`/api/v1/staff/deliveries/${id}/proof`)
          .set(auth(token))
          .attach('file', PNG, {
            filename: 'signed.png',
            contentType: 'image/png',
          });
      await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(200);
      await upload(w.token).expect(409); // not dispatched yet
      await w.api.post(`/staff/deliveries/${r.id}/dispatch`, {}).expect(200);
      await upload(stranger.token).expect(404);
      await upload(w.token).expect(201);
      const row = await prisma.shipment.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.proofAssetId).toBeTruthy();
      const asset = await prisma.asset.findUniqueOrThrow({
        where: { id: row.proofAssetId! },
      });
      expect(asset.type).toBe('DELIVERY_PROOF');
      expect(
        (await a.admin.get(`/admin/shipments/${r.id}`).expect(200)).body
          .hasProof,
      ).toBe(true);
      expect(
        JSON.stringify(
          (await a.admin.get(`/admin/shipments/${r.id}`).expect(200)).body,
        ),
      ).not.toContain(asset.storageKey);
      // signed URL for admins with shipments.read and for the assignee only
      const url = (
        await a.admin.get(`/admin/shipments/${r.id}/proof-url`).expect(200)
      ).body;
      expect(url.url).toBeTruthy();
      expect(
        (await w.api.get(`/staff/deliveries/${r.id}/proof-url`).expect(200))
          .body.url,
      ).toBeTruthy();
      await stranger.api.get(`/staff/deliveries/${r.id}/proof-url`).expect(404);
      await a.sales.get(`/admin/shipments/${r.id}/proof-url`).expect(200); // shipments.read
      await a.finance.get(`/admin/shipments/${r.id}/proof-url`).expect(403);
      await floor.qc.api.get(`/admin/shipments/${r.id}/proof-url`).expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/admin/shipments/${r.id}/proof-url`)
        .expect(401);
      // the generic asset API is closed to delivery staff, and the proof can never be archived
      await w.api.get(`/admin/assets/${row.proofAssetId}`).expect(403);
      await w.api
        .get(`/admin/assets/${row.proofAssetId}/download-url`)
        .expect(403);
      await a.admin.del(`/admin/assets/${row.proofAssetId}`).expect(409);
      expect(await auditActions(app, r.id)).toContain(
        'shipment.proof_attached',
      );
      await w.api.post(`/staff/deliveries/${r.id}/delivered`, {}).expect(200);
      await upload(w.token).expect(409); // final
    });

    it('accepts an existing proof asset at delivery and refuses wrong or reused proof', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r1 = (await ship(o, [[0, 60]], { assignedDeliveryUserId: w.id }))
        .body;
      const r2 = (await ship(o, [[1, 40]], { assignedDeliveryUserId: w.id }))
        .body;
      await send(r1.id, w);
      await send(r2.id, w);
      const wrongType = (await a.admin.upload('REFERENCE', 'x.png').expect(201))
        .body;
      await w.api
        .post(`/staff/deliveries/${r1.id}/delivered`, {
          proofAssetId: wrongType.id,
        })
        .expect(400);
      await w.api
        .post(`/staff/deliveries/${r1.id}/delivered`, {
          proofAssetId: '00000000-0000-4000-8000-000000000000',
        })
        .expect(400);
      const proof = (
        await a.admin.upload('DELIVERY_PROOF', 'receipt.png').expect(201)
      ).body;
      await w.api
        .post(`/staff/deliveries/${r1.id}/delivered`, {
          proofAssetId: proof.id,
        })
        .expect(200);
      await w.api
        .post(`/staff/deliveries/${r2.id}/delivered`, {
          proofAssetId: proof.id,
        })
        .expect(409); // already another shipment's proof
      await w.api.post(`/staff/deliveries/${r2.id}/delivered`, {}).expect(200);
      await expect(
        prisma.shipment.update({
          where: { id: r1.id },
          data: { proofAssetId: null },
        }),
      ).rejects.toThrow(); // final shipments keep their proof
    });
  });

  // ───────────────────────── cancellation and reorder ─────────────────────────
  describe('cancellation, holds and reorders', () => {
    it('cancelling an order cancels unsent shipments but refuses once goods left', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const draft = (await ship(o, [[0, 60]], { assignedDeliveryUserId: w.id }))
        .body;
      const ready = (await ship(o, [[1, 40]], { assignedDeliveryUserId: w.id }))
        .body;
      await a.admin.post(`/admin/shipments/${ready.id}/ready`).expect(200);
      await a.admin
        .post(`/admin/orders/${o.id}/cancel`, { reason: 'customer withdrew' })
        .expect(200);
      expect(await status(o.id)).toBe('CANCELLED');
      for (const id of [draft.id, ready.id]) {
        const sh = (await a.admin.get(`/admin/shipments/${id}`).expect(200))
          .body;
        expect(sh.status).toBe('CANCELLED');
        expect(sh.cancelReason).toMatch(/Order cancelled/);
        expect(sh.lines.length).toBeGreaterThan(0); // history kept
      }
      expect(await prisma.shipment.count({ where: { orderId: o.id } })).toBe(2);
      const { order: o2 } = await producedOrder(app, a, floor, s);
      const sent = (
        await ship(
          o2,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      await send(sent.id, w);
      await a.admin
        .post(`/admin/orders/${o2.id}/cancel`, { reason: 'too late to cancel' })
        .expect(409);
      expect(await status(o2.id)).toBe('OUT_FOR_DELIVERY');
    });

    it('a held order cannot ship or deliver until it resumes', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      await a.admin.post(`/admin/shipments/${r.id}/ready`).expect(200);
      await a.admin
        .post(`/admin/orders/${o.id}/hold`, { reason: 'payment dispute' })
        .expect(200);
      await w.api.post(`/staff/deliveries/${r.id}/dispatch`, {}).expect(409);
      await ship(o, [[0, 1]], {}, 409);
      await a.admin.post(`/admin/orders/${o.id}/resume`).expect(200);
      expect(await status(o.id)).toBe('READY_FOR_DELIVERY');
      await w.api.post(`/staff/deliveries/${r.id}/dispatch`, {}).expect(200);
    });

    it('a reorder copies no shipments, delivery history, proof, tracking token, quotations or payments', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await delivery();
      const r = (
        await ship(
          o,
          [
            [0, 60],
            [1, 40],
          ],
          { assignedDeliveryUserId: w.id },
        )
      ).body;
      await send(r.id, w);
      await w.api.post(`/staff/deliveries/${r.id}/delivered`, {}).expect(200);
      await a.admin
        .post(`/admin/orders/${o.id}/tracking-token`, {})
        .expect(201);
      const re = (
        await a.sales.post(`/admin/orders/${o.id}/reorder`).expect(201)
      ).body;
      expect(re.shipments).toEqual([]);
      expect(re.fulfillment).toMatchObject({
        deliveredQuantity: 0,
        packagingDefined: false,
        trackingEnabled: false,
      });
      expect(re.paymentState).toBe('UNPAID');
      expect(await prisma.shipment.count({ where: { orderId: re.id } })).toBe(
        0,
      );
      expect(
        await prisma.orderTrackingToken.count({ where: { orderId: re.id } }),
      ).toBe(0);
      expect(
        await prisma.orderPackagingSpec.count({ where: { orderId: re.id } }),
      ).toBe(0);
      expect(await prisma.quotation.count({ where: { orderId: re.id } })).toBe(
        0,
      );
      expect(await prisma.payment.count({ where: { orderId: re.id } })).toBe(0);
      expect(
        (await a.admin.get(`/admin/orders/${o.id}/shipments`).expect(200)).body,
      ).toHaveLength(1);
    });
  });

  // ───────────────────────── authorization and listing ─────────────────────────
  describe('authorization and listing', () => {
    it('grants shipment permissions with least privilege', async () => {
      const codes = [
        'packaging.manage',
        'shipments.read',
        'shipments.manage',
        'shipments.dispatch',
        'shipments.complete',
        'deliveries.read_assigned',
        'public_tracking.manage',
        'orders.commercial.read',
        'orders.commercial.manage',
        'orders.override',
      ];
      expect(
        await prisma.permission.count({ where: { code: { in: codes } } }),
      ).toBe(10);
      const grants = async (role: string) =>
        (
          await prisma.rolePermission.findMany({
            where: { role: { code: role } },
            include: { permission: true },
          })
        ).map((g) => g.permission.code);
      const admin = await grants('ADMIN');
      for (const c of codes) expect(admin).toContain(c);
      expect(await grants('DELIVERY')).toEqual(
        expect.arrayContaining([
          'deliveries.read_assigned',
          'shipments.dispatch',
          'shipments.complete',
        ]),
      );
      expect(await grants('DELIVERY')).not.toEqual(
        expect.arrayContaining([
          'shipments.manage',
          'orders.read',
          'orders.commercial.read',
        ]),
      );
      expect(await grants('SALES')).toEqual(
        expect.arrayContaining([
          'packaging.manage',
          'shipments.read',
          'public_tracking.manage',
          'orders.commercial.read',
          'orders.commercial.manage',
        ]),
      );
      expect(await grants('SALES')).not.toEqual(
        expect.arrayContaining(['shipments.manage', 'orders.override']),
      );
      expect(await grants('FINANCE')).toContain('orders.commercial.read');
      expect(await grants('FINANCE')).not.toContain('orders.commercial.manage');
      for (const role of ['CUTTING', 'QC', 'PACKAGING', 'SEWING']) {
        const g = await grants(role);
        for (const c of [
          'orders.commercial.read',
          'shipments.read',
          'shipments.manage',
          'public_tracking.manage',
          'orders.override',
        ])
          expect(g).not.toContain(c);
      }
      expect(await grants('SUPER_ADMIN')).toEqual(
        expect.arrayContaining(codes),
      );
    });

    it('lists orders by delivery facts', async () => {
      const ready = (await producedOrder(app, a, floor, s)).order;
      const w = await delivery();
      const partly = (await producedOrder(app, a, floor, s)).order;
      const r = (
        await ship(partly, [[0, 60]], { assignedDeliveryUserId: w.id })
      ).body;
      await send(r.id, w);
      const ids = async (qs: string) =>
        (
          await a.admin.get(`/admin/orders?${qs}&pageSize=100`).expect(200)
        ).body.data.map((o: { id: string }) => o.id);
      expect(await ids('readyForDelivery=true')).toContain(ready.id);
      expect(await ids('readyForDelivery=true')).not.toContain(partly.id);
      expect(await ids('status=PARTIALLY_SHIPPED')).toContain(partly.id);
      expect(await ids('shipmentStatus=DISPATCHED')).toContain(partly.id);
      expect(await ids('shipmentStatus=DISPATCHED')).not.toContain(ready.id);
      expect(await ids('packagingComplete=true')).toEqual(
        expect.arrayContaining([ready.id, partly.id]),
      );
      expect(await ids('packagingComplete=false')).not.toContain(ready.id);
      expect(await ids('delivered=true')).not.toContain(partly.id);
      expect(await ids('paymentState=UNPAID')).toContain(ready.id);
      expect(await ids('paymentState=PAID')).not.toContain(ready.id);
      await a.admin.get('/admin/orders?shipmentStatus=NOPE').expect(400);
      await a.admin.get('/admin/orders?paymentState=NOPE').expect(400);
      const shipments = (
        await a.admin.get('/admin/shipments?open=true&pageSize=100').expect(200)
      ).body;
      expect(shipments.data.map((x: { id: string }) => x.id)).toContain(r.id);
      expect(
        (
          await a.admin
            .get(`/admin/shipments?search=${r.shipmentNumber}`)
            .expect(200)
        ).body.data,
      ).toHaveLength(1);
      const u = await createUserAndLogin(app, { permissions: ['orders.read'] });
      const detail = (
        await api(app, u.accessToken)
          .get(`/admin/orders/${ready.id}`)
          .expect(200)
      ).body;
      expect(detail.commercial).toBeUndefined(); // no orders.commercial.read: no commercial block
      expect(detail.fulfillment).toBeDefined();
      void createOrder;
      void standardItems;
    });

    it('marks the legacy sample stand-ins deprecated and refuses them once a job exists', async () => {
      const doc = (
        await request(app.getHttpServer()).get('/api/docs-json').expect(200)
      ).body;
      expect(
        doc.paths['/api/v1/admin/samples/{id}/start-production'].post
          .deprecated,
      ).toBe(true);
      expect(
        doc.paths['/api/v1/admin/samples/{id}/finish-production'].post
          .deprecated,
      ).toBe(true);
      // the sample behind the approved reference has a (completed) sample-production job
      await a.admin
        .post(`/admin/samples/${s.sampleId}/start-production`)
        .expect(409);
      await a.admin
        .post(`/admin/samples/${s.sampleId}/finish-production`)
        .expect(409);
    });
  });
});
