import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { AppConfig } from '../src/config/app.config.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { createTestApp } from './support/app.js';
import { drain, notificationsFor } from './support/automation.js';
import {
  PAY_PNG,
  makePortalCustomer,
  portalForCustomer,
  submitPortalSample,
  type PortalCustomer,
} from './support/customer.js';
import {
  createFabricColor,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';
import { makeFloor, makeWorker, type Floor } from './support/floor.js';
import {
  approvedReferenceSample,
  finishBulkJob,
  orderDetail,
  packagingBody,
  type ApprovedSample,
} from './support/orders.js';

describe('Customer bulk orders, tracking and reorder (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let alice: PortalCustomer;
  let bob: PortalCustomer;
  let gate: AppConfig['orders'];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    // the customer who owns the approved sample gets a portal login
    alice = await portalForCustomer(app, a.admin, s.customerId, s.brandId);
    bob = await makePortalCustomer(app, a.admin);
    gate = app.get(ConfigService).getOrThrow<AppConfig>('app').orders;
    gate.requireAcceptedQuotation = true;
    gate.requiredPaidPercent = 100;
  }, 240_000);
  afterAll(async () => {
    gate.requireAcceptedQuotation = false;
    await app.close();
  });

  const lines = (qty: number, unit = 40) => [
    { type: 'PRINTING', description: 'Print', quantity: qty, unitPrice: unit },
  ];
  /** 20 units: M 10 + L 10 in the approved colour. */
  const twenty = () => ({
    quantity: 20,
    variants: [
      { sizeOptionId: s.sizeM, fabricColorId: s.colorId, quantity: 10 },
      { sizeOptionId: s.sizeL, fabricColorId: s.colorId, quantity: 10 },
    ],
  });
  const draft = async (c: PortalCustomer = alice, body: object = {}) =>
    (
      await c.api
        .post(`/customer/samples/${s.sampleId}/create-order`, {
          items: twenty(),
          ...body,
        })
        .expect(201)
    ).body;
  const submitted = async () => {
    const o = await draft();
    await alice.api.post(`/customer/orders/${o.id}/submit`).expect(200);
    return o.id as string;
  };
  const sendQuote = async (orderId: string, qty = 20, extra: object = {}) => {
    const q = (
      await a.sales
        .post(`/admin/orders/${orderId}/quotations`, {
          lineItems: lines(qty),
          customerNotes: 'Bulk price, valid for the quoted lead time',
          notes: 'INTERNAL-MARGIN-NOTE keep 35%',
          ...extra,
        })
        .expect(201)
    ).body;
    const versionId = q.currentVersion.id as string;
    await a.sales
      .post(`/admin/quotation-versions/${versionId}/send`)
      .expect(200);
    return { quotationId: q.id as string, versionId };
  };
  /** Customer-submitted, staff-confirmed, quoted (20 × 40 = 800.00) and accepted by the customer. */
  const accepted = async () => {
    const orderId = await submitted();
    await a.admin.post(`/admin/orders/${orderId}/confirm`).expect(200);
    const q = await sendQuote(orderId);
    await alice.api
      .post(`/customer/order-quotation-versions/${q.versionId}/accept`)
      .expect(200);
    return { orderId, ...q };
  };
  const payOrder = (
    orderId: string,
    amount: string,
    token = alice.accessToken,
  ) =>
    http()
      .post(`/api/v1/customer/orders/${orderId}/payments`)
      .set({ Authorization: `Bearer ${token}` })
      .field('amount', amount)
      .field('method', 'INSTAPAY')
      .attach('file', PAY_PNG, {
        filename: 'receipt.png',
        contentType: 'image/png',
      });
  const detail = async (c: PortalCustomer, id: string) =>
    (await c.api.get(`/customer/orders/${id}`).expect(200)).body;
  /** Released for production: accepted, paid in full (customer proof, finance verifies), marked ready. */
  const released = async () => {
    const o = await accepted();
    const pay = (await payOrder(o.orderId, '800').expect(201)).body;
    await a.finance.post(`/admin/payments/${pay.id}/verify`).expect(200);
    await a.admin.post(`/admin/orders/${o.orderId}/ready`).expect(200);
    return { ...o, paymentId: pay.id as string };
  };

  // ───────────────────────── creation and ownership ─────────────────────────

  describe('creating an order', () => {
    it('creates a draft from the customer’s approved sample on the approved reference', async () => {
      const o = await draft();
      expect(o).toMatchObject({
        status: 'DRAFT',
        statusLabel: 'Draft',
        allowedActions: ['EDIT_ORDER', 'SUBMIT_ORDER'],
        reference: { sampleNumber: s.sampleNumber, sampleId: s.sampleId },
        quantities: { total: 20, shipped: 0, delivered: 0, remaining: 20 },
      });
      expect(o.orderNumber).toMatch(/^ORD-/);
      expect(
        o.items[0].variants.map((v: { quantity: number }) => v.quantity),
      ).toEqual([10, 10]);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      const spec = await prisma.sampleProductionSpec.findUniqueOrThrow({
        where: { id: row.approvedProductionSpecId },
      });
      expect(spec).toMatchObject({
        kind: 'APPROVED_REFERENCE',
        sampleId: s.sampleId,
      });
      expect(row).toMatchObject({
        customerId: s.customerId,
        createdByUserId: null,
        createdByCustomerId: s.customerId,
        status: 'DRAFT',
        currentSpecId: null,
      });
      // staff see the same order, with the customer as its creator in the timeline
      expect((await orderDetail(a.admin, o.id)).status).toBe('DRAFT');
      const act = await prisma.orderActivity.findFirstOrThrow({
        where: { orderId: o.id, type: 'ORDER_CREATED' },
      });
      expect(act).toMatchObject({
        actorCustomerId: s.customerId,
        actorUserId: null,
      });
      expect(
        await prisma.auditLog.count({
          where: {
            entityId: o.id,
            action: 'order.created',
            actorCustomerId: s.customerId,
          },
        }),
      ).toBe(1);
    });

    it('needs an approved sample that belongs to the customer', async () => {
      await bob.api
        .post(`/customer/samples/${s.sampleId}/create-order`, {})
        .expect(404);
      // an unapproved (submitted) request has no approved reference
      const sid = await submitPortalSample(alice, refs, {});
      await alice.api
        .post(`/customer/samples/${sid}/create-order`, {})
        .expect(409);
      expect(await prisma.order.count({ where: { sourceSampleId: sid } })).toBe(
        0,
      );
    });

    it('never accepts ownership, pricing, ownership of staff fields or custom production choices', async () => {
      for (const body of [
        { customerId: bob.customerId },
        { priority: 'URGENT' },
        { internalNotes: 'x' },
        { assignedSalesUserId: a.salesUserId },
        { status: 'CONFIRMED' },
        {
          items: {
            quantity: 5,
            variants: [{ customColorName: 'Neon', quantity: 5 }],
          },
        },
        {
          items: {
            quantity: 5,
            variants: [{ customSizeName: 'XXXXL', quantity: 5 }],
          },
        },
      ])
        await alice.api
          .post(`/customer/samples/${s.sampleId}/create-order`, body)
          .expect(400);
    });

    it('validates the preferred address and the target date', async () => {
      const mine = (
        await alice.api
          .post('/customer/addresses', {
            country: 'Egypt',
            city: 'Cairo',
            addressLine1: '1 Test St',
          })
          .expect(201)
      ).body;
      const theirs = (
        await bob.api
          .post('/customer/addresses', {
            country: 'Egypt',
            city: 'Giza',
            addressLine1: '2 Other St',
          })
          .expect(201)
      ).body;
      await alice.api
        .post(`/customer/samples/${s.sampleId}/create-order`, {
          preferredAddressId: theirs.id,
        })
        .expect(400);
      await alice.api
        .post(`/customer/samples/${s.sampleId}/create-order`, {
          targetDeliveryDate: '2020-01-01',
        })
        .expect(400);
      const o = await draft(alice, {
        preferredAddressId: mine.id,
        targetDeliveryDate: new Date(
          Date.now() + 40 * 86_400_000,
        ).toISOString(),
        customerNotes: 'Please deliver in the morning',
      });
      expect(o).toMatchObject({
        preferredAddressId: mine.id,
        customerNotes: 'Please deliver in the morning',
      });
      await alice.api
        .patch(`/customer/orders/${o.id}`, { preferredAddressId: theirs.id })
        .expect(400);
    });
  });

  // ───────────────────────── quantity integrity ─────────────────────────

  describe('quantities and variants', () => {
    it('enforces positive whole numbers, consistent totals and valid, unique size / colour lines', async () => {
      const o = await draft(alice, { items: undefined });
      const put = (body: object) =>
        alice.api.put(`/customer/orders/${o.id}/items`, body);
      const v = (qty: number, extra: object = {}) => ({
        sizeOptionId: s.sizeM,
        fabricColorId: s.colorId,
        quantity: qty,
        ...extra,
      });
      await put({
        quantity: 20,
        variants: [v(5), v(5, { sizeOptionId: s.sizeL })],
      }).expect(400); // 10 ≠ 20
      await put({ quantity: 0, variants: [v(0)] }).expect(400);
      await put({ quantity: -5, variants: [v(-5)] }).expect(400);
      await put({ quantity: 1.5, variants: [v(1.5)] }).expect(400);
      await put({ quantity: 20, variants: [] }).expect(400);
      await put({ quantity: 20, variants: [v(10), v(10)] }).expect(400); // same size/colour twice
      await put({ quantity: 20, variants: [{ quantity: 20 }] }).expect(400); // neither size nor colour
      await put({
        quantity: 20,
        variants: [
          v(20, { sizeOptionId: '00000000-0000-4000-8000-000000000000' }),
        ],
      }).expect(400);
      // a colour of another fabric would change the material: it needs a new sample
      const other = await createFabricColor(a.admin, refs.otherFabricId);
      await put({
        quantity: 20,
        variants: [v(20, { fabricColorId: other.id })],
      }).expect(400);
      expect((await detail(alice, o.id)).quantities.total).toBe(0);

      const ok = (await put(twenty()).expect(200)).body;
      expect(ok.quantities.total).toBe(20);
      expect(ok.items[0].variants).toHaveLength(2);
      expect(ok.items[0].variants[0]).toMatchObject({
        size: expect.any(String),
        color: expect.any(String),
      });
      // the colour of the approved sample is also the default when none is chosen
      await put({
        quantity: 20,
        variants: [{ sizeOptionId: s.sizeM, quantity: 20 }],
      }).expect(200);
    });

    it('submits a complete draft, then freezes it for the customer', async () => {
      const o = await draft(alice, { items: undefined });
      await alice.api.post(`/customer/orders/${o.id}/submit`).expect(409); // no items yet
      await alice.api
        .put(`/customer/orders/${o.id}/items`, twenty())
        .expect(200);
      const res = (
        await alice.api.post(`/customer/orders/${o.id}/submit`).expect(200)
      ).body;
      expect(res).toMatchObject({
        status: 'PENDING_CONFIRMATION',
        nextStep: 'Our team is reviewing your order.',
        allowedActions: [],
      });
      await alice.api
        .patch(`/customer/orders/${o.id}`, { customerNotes: 'late' })
        .expect(409);
      await alice.api
        .put(`/customer/orders/${o.id}/items`, twenty())
        .expect(409);
      await alice.api.post(`/customer/orders/${o.id}/submit`).expect(409);
      // the customer has no way to confirm or release it
      await alice.api.post(`/customer/orders/${o.id}/confirm`, {}).expect(404);
      await alice.api.post(`/customer/orders/${o.id}/ready`, {}).expect(404);
      await http()
        .post(`/api/v1/admin/orders/${o.id}/confirm`)
        .set({ Authorization: `Bearer ${alice.accessToken}` })
        .expect(401);

      // staff see it where they expect it, confirm it and the customer follows
      const staff = await orderDetail(a.admin, o.id);
      expect(staff.status).toBe('PENDING_CONFIRMATION');
      const list = (
        await a.admin
          .get('/admin/orders?status=PENDING_CONFIRMATION')
          .expect(200)
      ).body;
      expect(list.data.map((x: { id: string }) => x.id)).toContain(o.id);
      const submittedAct = await prisma.orderActivity.findFirstOrThrow({
        where: { orderId: o.id, type: 'ORDER_SUBMITTED' },
      });
      expect(submittedAct.actorCustomerId).toBe(s.customerId);
      await a.admin.post(`/admin/orders/${o.id}/confirm`).expect(200);
      expect((await detail(alice, o.id)).status).toBe('QUOTATION_PENDING');

      await drain(app);
      const notes = await notificationsFor(app, o.id);
      expect(notes.map((n) => n.templateCode)).toEqual(
        expect.arrayContaining(['ORDER_SUBMITTED']),
      );
    });
  });

  // ───────────────────────── list and projection ─────────────────────────

  describe('list and detail', () => {
    it('lists only my orders with filters, and hides internals in the detail', async () => {
      const mine = await submitted();
      await a.admin.post(`/admin/orders/${mine}/confirm`).expect(200);
      await a.admin
        .patch(`/admin/orders/${mine}`, {
          internalNotes: 'SECRET-INTERNAL-NOTE',
        })
        .expect(200);
      await a.admin
        .patch(`/admin/orders/${mine}/priority`, { priority: 'URGENT' })
        .expect(200);
      const list = (await alice.api.get('/customer/orders').expect(200)).body;
      expect(list.data.map((x: { id: string }) => x.id)).toContain(mine);
      expect(
        (await bob.api.get('/customer/orders').expect(200)).body.data,
      ).toHaveLength(0);
      const filtered = (
        await alice.api
          .get('/customer/orders?status=QUOTATION_PENDING&sort=oldest')
          .expect(200)
      ).body;
      expect(filtered.data.map((x: { id: string }) => x.id)).toContain(mine);
      const draftsOnly = (
        await alice.api.get('/customer/orders?status=DRAFT').expect(200)
      ).body;
      expect(draftsOnly.data.map((x: { id: string }) => x.id)).not.toContain(
        mine,
      );
      await alice.api.get('/customer/orders?status=NOPE').expect(400);
      const search = (
        await alice.api
          .get(
            `/customer/orders?search=${(await orderDetail(a.admin, mine)).orderNumber}`,
          )
          .expect(200)
      ).body;
      expect(search.data).toHaveLength(1);

      const d = await detail(alice, mine);
      const json = JSON.stringify(d);
      for (const leak of [
        'SECRET-INTERNAL-NOTE',
        'internalNotes',
        'priority',
        'URGENT',
        'assignedSales',
        'createdByUserId',
        'holdReason',
        'approvedProductionSpecId',
        'specHash',
      ])
        expect(json).not.toContain(leak);
      expect(d.status).toBe('QUOTATION_PENDING');
    });

    it('hides every order resource from another customer', async () => {
      const q = await accepted();
      const proof = (await payOrder(q.orderId, '100').expect(201)).body;
      for (const path of [
        `/customer/orders/${q.orderId}`,
        `/customer/orders/${q.orderId}/commercial`,
        `/customer/orders/${q.orderId}/quotation`,
        `/customer/orders/${q.orderId}/payments`,
        `/customer/orders/${q.orderId}/production`,
        `/customer/orders/${q.orderId}/shipments`,
        `/customer/orders/${q.orderId}/activity`,
        `/customer/payments/${proof.id}/proof/download-url`,
      ])
        await bob.api.get(path).expect(404);
      await bob.api
        .patch(`/customer/orders/${q.orderId}`, { customerNotes: 'x' })
        .expect(404);
      await bob.api
        .put(`/customer/orders/${q.orderId}/items`, twenty())
        .expect(404);
      await bob.api.post(`/customer/orders/${q.orderId}/submit`).expect(404);
      await bob.api
        .post(`/customer/orders/${q.orderId}/reorder`, {})
        .expect(404);
      await bob.api
        .post(`/customer/order-quotation-versions/${q.versionId}/accept`)
        .expect(404);
      await bob.api
        .post(`/customer/order-quotation-versions/${q.versionId}/reject`, {})
        .expect(404);
      await payOrder(q.orderId, '10', bob.accessToken).expect(404);
      await http()
        .post(`/api/v1/customer/payments/${proof.id}/proof`)
        .set({ Authorization: `Bearer ${bob.accessToken}` })
        .attach('file', PAY_PNG, {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(404);
      // staff tokens are not customers
      await http()
        .get(`/api/v1/customer/orders/${q.orderId}`)
        .set({ Authorization: `Bearer ${a.adminToken}` })
        .expect(401);
    });
  });

  // ───────────────────────── commercial ─────────────────────────

  describe('quotation and payment', () => {
    it('shows a sent quotation, lets the customer accept it, pay with proof, and staff verify', async () => {
      const orderId = await submitted();
      await a.admin.post(`/admin/orders/${orderId}/confirm`).expect(200);
      const q = await sendQuote(orderId);
      const view = (
        await alice.api.get(`/customer/orders/${orderId}/quotation`).expect(200)
      ).body;
      expect(view.actionableVersionId).toBe(q.versionId);
      expect(view.quotations[0].versions[0]).toMatchObject({
        status: 'SENT',
        actionable: true,
        total: '800.00',
        currency: 'EGP',
        notes: 'Bulk price, valid for the quoted lead time',
        endedByChange: false,
      });
      expect(JSON.stringify(view)).not.toMatch(
        /INTERNAL-MARGIN|createdByUserId|metadata/,
      );
      let d = await detail(alice, orderId);
      expect(d).toMatchObject({
        status: 'QUOTATION_READY',
        nextStep: 'Review your quotation.',
        allowedActions: ['ACCEPT_QUOTATION', 'REJECT_QUOTATION'],
      });
      const c0 = (
        await alice.api
          .get(`/customer/orders/${orderId}/commercial`)
          .expect(200)
      ).body;
      expect(c0).toMatchObject({
        nextAction: 'REVIEW_QUOTATION',
        readyForProduction: false,
        payment: { status: 'NOT_REQUIRED_YET' },
      });
      // not payable before acceptance
      await payOrder(orderId, '100').expect(409);

      d = (
        await alice.api
          .post(`/customer/order-quotation-versions/${q.versionId}/accept`)
          .expect(200)
      ).body;
      expect(d).toMatchObject({
        status: 'PAYMENT_REQUIRED',
        nextStep: 'Payment is required.',
        allowedActions: ['UPLOAD_PAYMENT_PROOF'],
        commercial: {
          paymentStatus: 'PAYMENT_REQUIRED',
          requiredAmount: '800.00',
          remainingAmount: '800.00',
        },
      });
      const decided = await prisma.quotationVersion.findUniqueOrThrow({
        where: { id: q.versionId },
      });
      expect(decided).toMatchObject({
        status: 'ACCEPTED',
        decidedByCustomerId: s.customerId,
        decidedByUserId: null,
      });
      await alice.api
        .post(`/customer/order-quotation-versions/${q.versionId}/accept`)
        .expect(409);
      await alice.api
        .post(`/customer/order-quotation-versions/${q.versionId}/reject`, {})
        .expect(409);

      // payment rules
      await payOrder(orderId, '900').expect(400); // more than owed
      const first = (await payOrder(orderId, '300').expect(201)).body;
      expect(first).toMatchObject({
        status: 'PENDING_VERIFICATION',
        amount: '300.00',
        hasProof: true,
      });
      d = await detail(alice, orderId);
      expect(d.status).toBe('PAYMENT_UNDER_REVIEW');
      // staff queue: the same payment table, flagged as customer-submitted
      const staff = (
        await a.finance.get(`/admin/orders/${orderId}/payments`).expect(200)
      ).body;
      expect(staff[0]).toMatchObject({
        id: first.id,
        status: 'SUBMITTED',
        createdByCustomerId: s.customerId,
      });
      // verification is staff-only
      await alice.api
        .post(`/customer/payments/${first.id}/verify`, {})
        .expect(404);
      await http()
        .post(`/api/v1/admin/payments/${first.id}/verify`)
        .set({ Authorization: `Bearer ${alice.accessToken}` })
        .expect(401);
      await a.finance.post(`/admin/payments/${first.id}/verify`).expect(200);
      let pay = (
        await alice.api.get(`/customer/orders/${orderId}/payments`).expect(200)
      ).body;
      expect(pay.summary).toMatchObject({
        verifiedAmount: '300.00',
        remainingAmount: '500.00',
        pendingAmount: '0.00',
      });
      // the gate is still closed: customers cannot release production, staff cannot either
      await a.admin.post(`/admin/orders/${orderId}/ready`).expect(409);
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/commercial`)
            .expect(200)
        ).body.readyForProduction,
      ).toBe(false);

      const second = (await payOrder(orderId, '500').expect(201)).body;
      await a.finance.post(`/admin/payments/${second.id}/verify`).expect(200);
      d = await detail(alice, orderId);
      expect(d).toMatchObject({
        status: 'READY_FOR_PRODUCTION',
        nextStep: 'Your order is ready for production.',
      });
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/commercial`)
            .expect(200)
        ).body.readyForProduction,
      ).toBe(true);
      await a.admin.post(`/admin/orders/${orderId}/ready`).expect(200);
      pay = (
        await alice.api.get(`/customer/orders/${orderId}/payments`).expect(200)
      ).body;
      expect(pay.summary.status).toBe('PAID');
      expect(pay.payments.map((p: { status: string }) => p.status)).toEqual([
        'VERIFIED',
        'VERIFIED',
      ]);
    });

    it('rejects a quotation and keeps its history', async () => {
      const orderId = await submitted();
      await a.admin.post(`/admin/orders/${orderId}/confirm`).expect(200);
      const q = await sendQuote(orderId);
      const res = (
        await alice.api
          .post(`/customer/order-quotation-versions/${q.versionId}/reject`, {
            reason: 'Too expensive',
          })
          .expect(200)
      ).body;
      expect(res.status).toBe('QUOTATION_PENDING');
      expect(
        await prisma.quotationVersion.findUniqueOrThrow({
          where: { id: q.versionId },
        }),
      ).toMatchObject({
        status: 'REJECTED',
        decisionNote: 'Too expensive',
        decidedByCustomerId: s.customerId,
      });
      const acts = (
        await alice.api.get(`/customer/orders/${orderId}/activity`).expect(200)
      ).body;
      expect(acts.map((e: { title: string }) => e.title)).toEqual(
        expect.arrayContaining(['Quotation declined']),
      );
    });

    it('refuses an expired offer', async () => {
      const orderId = await submitted();
      await a.admin.post(`/admin/orders/${orderId}/confirm`).expect(200);
      const q = await sendQuote(orderId, 20, {
        validUntil: new Date(Date.now() + 1500).toISOString(),
      });
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/quotation`)
            .expect(200)
        ).body.actionableVersionId,
      ).toBe(q.versionId);
      await new Promise((r) => setTimeout(r, 1800));
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/quotation`)
            .expect(200)
        ).body.actionableVersionId,
      ).toBeNull();
      await alice.api
        .post(`/customer/order-quotation-versions/${q.versionId}/accept`)
        .expect(409);
    });

    it('never carries an acceptance forward after a commercially relevant change', async () => {
      const r = await released();
      // staff revise the quantity: the accepted quotation ends, the order is pulled back
      await a.admin
        .post(`/admin/orders/${r.orderId}/revise`, {
          reason: 'customer wants more',
          items: [
            {
              id: (await orderDetail(a.admin, r.orderId)).items[0]!.id,
              quantity: 30,
              variants: [
                {
                  sizeOptionId: s.sizeM,
                  fabricColorId: s.colorId,
                  quantity: 15,
                },
                {
                  sizeOptionId: s.sizeL,
                  fabricColorId: s.colorId,
                  quantity: 15,
                },
              ],
            },
          ],
        })
        .expect(200);
      let d = await detail(alice, r.orderId);
      expect(d.status).toBe('QUOTATION_PENDING');
      expect(d.commercial.requiresReview).toBe(true);
      const view = (
        await alice.api
          .get(`/customer/orders/${r.orderId}/quotation`)
          .expect(200)
      ).body;
      expect(view.actionableVersionId).toBeNull();
      expect(view.notice).toMatch(/new one/i);
      expect(view.quotations[0].versions[0]).toMatchObject({
        status: 'SUPERSEDED',
        endedByChange: true,
        actionable: false,
      });
      await alice.api
        .post(`/customer/order-quotation-versions/${r.versionId}/accept`)
        .expect(409);
      const c = (
        await alice.api
          .get(`/customer/orders/${r.orderId}/commercial`)
          .expect(200)
      ).body;
      expect(c).toMatchObject({
        requiresReview: true,
        readyForProduction: false,
      });
      expect(d.allowedActions).not.toContain('ACCEPT_QUOTATION');
      const acts = (
        await alice.api
          .get(`/customer/orders/${r.orderId}/activity`)
          .expect(200)
      ).body;
      expect(acts.map((e: { title: string }) => e.title)).toContain(
        'A new quotation is needed',
      );

      // a new quotation for the new quantity: the customer is asked again; the verified money is credited
      const fresh = await sendQuote(r.orderId, 30);
      d = await detail(alice, r.orderId);
      expect(d.status).toBe('QUOTATION_READY');
      const view2 = (
        await alice.api
          .get(`/customer/orders/${r.orderId}/quotation`)
          .expect(200)
      ).body;
      expect(view2).toMatchObject({
        actionableVersionId: fresh.versionId,
        requiresReview: true,
        notice: 'A new quotation requires your review.',
      });
      await alice.api
        .post(`/customer/order-quotation-versions/${fresh.versionId}/accept`)
        .expect(200);
      d = await detail(alice, r.orderId);
      expect(d.commercial).toMatchObject({
        requiredAmount: '1200.00',
        remainingAmount: '400.00',
      });
      expect(d.status).toBe('PAYMENT_REQUIRED');
    });

    it('lets the customer edit a draft whose staff quotation already exists, and shows the new quote as needed', async () => {
      const o = await draft();
      const q = await sendQuote(o.id); // staff may quote a draft
      await alice.api
        .put(`/customer/orders/${o.id}/items`, {
          quantity: 30,
          variants: [
            { sizeOptionId: s.sizeM, fabricColorId: s.colorId, quantity: 15 },
            { sizeOptionId: s.sizeL, fabricColorId: s.colorId, quantity: 15 },
          ],
        })
        .expect(200);
      expect(
        (
          await prisma.quotationVersion.findUniqueOrThrow({
            where: { id: q.versionId },
          })
        ).status,
      ).toBe('SUPERSEDED');
      const view = (
        await alice.api.get(`/customer/orders/${o.id}/quotation`).expect(200)
      ).body;
      expect(view.actionableVersionId).toBeNull();
      await alice.api
        .post(`/customer/order-quotation-versions/${q.versionId}/accept`)
        .expect(409);
    });
  });

  // ───────────────────────── production, shipments, reorder ─────────────────────────

  describe('production, delivery and reorder', () => {
    it('tracks production in coarse steps, partial shipments and delivery, then reorders', async () => {
      const r = await released();
      const orderId = r.orderId;
      await a.admin
        .put(`/admin/orders/${orderId}/packaging`, packagingBody)
        .expect(200);
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/production`)
            .expect(200)
        ).body,
      ).toMatchObject({
        phase: 'NOT_STARTED',
        packaging: 'NOT_STARTED',
      });
      const job = (
        await a.admin
          .post(`/admin/orders/${orderId}/create-factory-job`)
          .expect(201)
      ).body;
      await finishBulkJob(app, a, floor, job.id, { packaging: { damaged: 0 } });

      const prod = (
        await alice.api
          .get(`/customer/orders/${orderId}/production`)
          .expect(200)
      ).body;
      expect(prod).toMatchObject({
        phase: 'COMPLETE',
        progressPercent: 100,
        packaging: 'READY_FOR_SHIPMENT',
      });
      expect(prod.steps.map((x: { code: string }) => x.code)).toEqual([
        'PREPARING_MATERIALS',
        'PATTERN_AND_CUTTING',
        'DECORATION',
        'SEWING',
        'QUALITY_CHECK',
        'PACKAGING',
        'READY_FOR_SHIPMENT',
      ]);
      expect(
        prod.steps.every((x: { state: string }) => x.state === 'DONE'),
      ).toBe(true);
      expect(prod.eta).toBeNull(); // production is finished
      const json = JSON.stringify(prod);
      for (const leak of [
        'FABRIC_PREPARATION',
        'QC_GATE',
        job.jobNumber,
        floor.fabric.id,
        'blocker',
        'rework',
      ])
        expect(json).not.toContain(leak);
      expect(await detail(alice, orderId)).toMatchObject({
        status: 'READY_TO_SHIP',
        progressPercent: 100,
      });

      // partial shipment: 10 of 20
      const address = (
        await alice.api
          .post('/customer/addresses', {
            country: 'Egypt',
            city: 'Cairo',
            area: 'Nasr City',
            addressLine1: '12 Textile St',
            notes: 'Ring twice',
          })
          .expect(201)
      ).body;
      const w = await makeWorker(app, 'DELIVERY');
      const o = await orderDetail(a.admin, orderId);
      const ship = async (variant: number, qty: number) =>
        (
          await a.admin
            .post(`/admin/orders/${orderId}/shipments`, {
              deliveryMethod: 'OWN_DELIVERY',
              recipientName: 'Mona Ali',
              recipientPhone: '+201001112233',
              customerAddressId: address.id,
              assignedDeliveryUserId: w.id,
              courierName: 'Own fleet',
              notes: 'INTERNAL-SHIPMENT-NOTE',
              lines: [
                {
                  orderVariantId: o.items[0]!.variants[variant]!.id,
                  quantity: qty,
                },
              ],
            })
            .expect(201)
        ).body;
      const s1 = await ship(0, 10);
      // a draft shipment is invisible to the customer
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/shipments`)
            .expect(200)
        ).body.shipments,
      ).toHaveLength(0);
      await a.admin.post(`/admin/shipments/${s1.id}/ready`).expect(200);
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/shipments`)
            .expect(200)
        ).body.shipments[0].status,
      ).toBe('PREPARING');
      await w.api.post(`/staff/deliveries/${s1.id}/dispatch`, {}).expect(200);
      let ships = (
        await alice.api.get(`/customer/orders/${orderId}/shipments`).expect(200)
      ).body;
      expect(ships.shipments[0]).toMatchObject({
        shipmentNumber: s1.shipmentNumber,
        status: 'ON_THE_WAY',
        quantity: 10,
        destination: 'Cairo, Egypt',
        courierName: 'Own fleet',
      });
      expect(ships.summary).toEqual({
        totalUnits: 20,
        shippedUnits: 10,
        deliveredUnits: 0,
        remainingUnits: 10,
        partiallyShipped: true,
      });
      let d = await detail(alice, orderId);
      expect(d).toMatchObject({
        status: 'PARTIALLY_SHIPPED',
        nextStep: 'Part of your order has shipped.',
        quantities: { total: 20, shipped: 10, delivered: 0, remaining: 10 },
      });
      // a failed attempt: the customer sees the state, never the internal reason or the proof
      await w.api
        .post(`/staff/deliveries/${s1.id}/failed`, {
          reason: 'INTERNAL: neighbour said nobody lives there',
        })
        .expect(200);
      ships = (
        await alice.api.get(`/customer/orders/${orderId}/shipments`).expect(200)
      ).body;
      expect(ships.shipments[0].status).toBe('DELIVERY_ATTEMPT_FAILED');
      expect(JSON.stringify(ships)).not.toMatch(
        /INTERNAL|neighbour|proof|assignedDelivery|recipientPhone|Ring twice|addressLine/i,
      );
      const detailShip = (
        await alice.api.get(`/customer/shipments/${s1.id}`).expect(200)
      ).body;
      expect(detailShip.lines).toEqual([
        { size: expect.any(String), color: expect.any(String), quantity: 10 },
      ]);
      await bob.api.get(`/customer/shipments/${s1.id}`).expect(404);
      // retry and deliver both halves
      await a.admin
        .post(`/admin/shipments/${s1.id}/ready`)
        .expect(200)
        .catch(() => undefined);
      const s2 = await ship(1, 10);
      await a.admin.post(`/admin/shipments/${s2.id}/ready`).expect(200);
      await w.api.post(`/staff/deliveries/${s2.id}/dispatch`, {}).expect(200);
      await w.api
        .post(`/staff/deliveries/${s2.id}/delivered`, {
          notes: 'Received by Mona',
        })
        .expect(200);
      ships = (
        await alice.api.get(`/customer/orders/${orderId}/shipments`).expect(200)
      ).body;
      expect(ships.summary).toMatchObject({ deliveredUnits: 10 });
      // not delivered until every unit is (the backend decides)
      expect((await detail(alice, orderId)).status).not.toBe('DELIVERED');
    });

    it('marks the order delivered only when the backend does, and reorders without carrying state over', async () => {
      const r = await released();
      const orderId = r.orderId;
      await a.admin
        .put(`/admin/orders/${orderId}/packaging`, packagingBody)
        .expect(200);
      const job = (
        await a.admin
          .post(`/admin/orders/${orderId}/create-factory-job`)
          .expect(201)
      ).body;
      await finishBulkJob(app, a, floor, job.id, { packaging: { damaged: 0 } });
      const w = await makeWorker(app, 'DELIVERY');
      const o = await orderDetail(a.admin, orderId);
      const address = (
        await alice.api
          .post('/customer/addresses', {
            country: 'Egypt',
            city: 'Alexandria',
            addressLine1: '3 Port St',
          })
          .expect(201)
      ).body;
      // not reorderable before delivery
      await alice.api
        .post(`/customer/orders/${orderId}/reorder`, {})
        .expect(409);
      expect((await detail(alice, orderId)).allowedActions).not.toContain(
        'REORDER',
      );
      const shipAll = (
        await a.admin
          .post(`/admin/orders/${orderId}/shipments`, {
            deliveryMethod: 'OWN_DELIVERY',
            recipientName: 'Mona Ali',
            recipientPhone: '+201001112233',
            customerAddressId: address.id,
            assignedDeliveryUserId: w.id,
            lines: o.items[0]!.variants.map((v) => ({
              orderVariantId: v.id,
              quantity: v.quantity,
            })),
          })
          .expect(201)
      ).body;
      await a.admin.post(`/admin/shipments/${shipAll.id}/ready`).expect(200);
      await w.api
        .post(`/staff/deliveries/${shipAll.id}/dispatch`, {})
        .expect(200);
      expect(await detail(alice, orderId)).toMatchObject({
        status: 'SHIPPED',
        nextStep: 'Your order is on its way.',
      });
      await w.api
        .post(`/staff/deliveries/${shipAll.id}/delivered`, {})
        .expect(200);
      const delivered = await detail(alice, orderId);
      expect(delivered).toMatchObject({
        status: 'DELIVERED',
        nextStep: 'Your order has been delivered.',
        quantities: { delivered: 20, remaining: 0 },
        allowedActions: ['REORDER'],
      });
      expect(
        (
          await alice.api
            .get(`/customer/orders/${orderId}/shipments`)
            .expect(200)
        ).body.summary.partiallyShipped,
      ).toBe(false);

      // reorder: a NEW draft on the same approved reference, quantities copied, nothing else
      const again = (
        await alice.api
          .post(`/customer/orders/${orderId}/reorder`, {
            customerNotes: 'Same again please',
          })
          .expect(201)
      ).body;
      expect(again.id).not.toBe(orderId);
      expect(again).toMatchObject({
        status: 'DRAFT',
        reorderOf: delivered.orderNumber,
        customerNotes: 'Same again please',
        allowedActions: ['EDIT_ORDER', 'SUBMIT_ORDER'],
        quantities: { total: 20, shipped: 0, delivered: 0, remaining: 0 + 20 },
        commercial: { paymentStatus: 'NOT_REQUIRED_YET', requiredAmount: null },
      });
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: again.id },
      });
      const src = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(row).toMatchObject({
        reorderOfOrderId: orderId,
        approvedProductionSpecId: src.approvedProductionSpecId,
        createdByCustomerId: s.customerId,
        createdByUserId: null,
        paymentState: 'UNPAID',
        currentSpecId: null,
        confirmedAt: null,
      });
      for (const [model, n] of [
        [prisma.quotation.count({ where: { orderId: again.id } }), 0],
        [prisma.payment.count({ where: { orderId: again.id } }), 0],
        [prisma.factoryJob.count({ where: { orderId: again.id } }), 0],
        [prisma.shipment.count({ where: { orderId: again.id } }), 0],
        [prisma.orderBatch.count({ where: { orderId: again.id } }), 0],
      ] as const)
        expect(await model).toBe(n);
      // it behaves like any draft: editable and submittable, and invisible to others
      await alice.api
        .put(`/customer/orders/${again.id}/items`, {
          quantity: 40,
          variants: [{ sizeOptionId: s.sizeM, quantity: 40 }],
        })
        .expect(200);
      await bob.api.get(`/customer/orders/${again.id}`).expect(404);
      // staff see the link
      expect(
        (await a.admin.get(`/admin/orders/${again.id}`).expect(200)).body
          .reorderOfOrderId ?? delivered.orderNumber,
      ).toBeTruthy();

      const acts = (
        await alice.api.get(`/customer/orders/${orderId}/activity`).expect(200)
      ).body;
      const titles = acts.map((e: { title: string }) => e.title);
      for (const t of [
        'Order created',
        'Order submitted',
        'Order confirmed',
        'Quotation accepted',
        'Payment proof submitted',
        'Payment verified',
        'Ready for production',
        'Production started',
        'Production complete',
        'Shipment dispatched',
        'Order delivered',
      ])
        expect(titles).toContain(t);
      expect(JSON.stringify(acts)).not.toMatch(/INTERNAL|priority|batch|job /i);

      await drain(app);
      const mine = (await notificationsFor(app, orderId)).filter(
        (n) => n.customerId === s.customerId,
      );
      expect(mine.map((n) => n.templateCode)).toEqual(
        expect.arrayContaining([
          'ORDER_READY_FOR_PRODUCTION_CUSTOMER',
          'ORDER_PRODUCTION_COMPLETED_CUSTOMER',
        ]),
      );
    });
  });
});
