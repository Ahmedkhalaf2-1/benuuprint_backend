import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { EVENT_TYPES } from '../src/modules/notifications/events.js';
import { createTestApp, createUserAndLogin } from './support/app.js';
import { drain } from './support/automation.js';
import {
  api,
  lookupRefs,
  makeActors,
  toAwaitingApproval,
  toAwaitingPayment,
  type Actors,
  type Api,
  type Refs,
} from './support/factory.js';
import {
  assignWorker,
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

describe('Domain events and who they notify (Phase 6B, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let admin: { api: Api; id: string };
  let startedAt: Date;
  const ids: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    const u = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
    admin = { api: api(app, u.accessToken), id: u.user.id };
    startedAt = new Date(Date.now() - 1000);
    s = await approvedReferenceSample(app, a, refs, floor);
    ids.push(s.sampleId, s.sampleJobId);
    await prisma.sample.update({
      where: { id: s.sampleId },
      data: { assignedSalesUserId: a.salesUserId },
    });
    await drain(app);
  }, 180_000);
  afterAll(() => app.close());

  const events = (aggregateIds: string[]) =>
    prisma.outboxEvent.findMany({
      where: {
        aggregateId: { in: aggregateIds },
        createdAt: { gte: startedAt },
      },
      orderBy: { occurredAt: 'asc' },
    });
  const types = async (aggregateIds: string[]) =>
    (await events(aggregateIds)).map((e) => e.eventType);
  const inbox = (userId: string, type: string, entityId?: string) =>
    prisma.notification.findMany({
      where: {
        recipientUserId: userId,
        type,
        channel: 'IN_APP',
        ...(entityId && { entityId }),
      },
    });

  it('the sample journey writes its events as the business happens', async () => {
    const sampleEvents = await types([s.sampleId]);
    for (const t of [
      'SAMPLE_SUBMITTED',
      'SAMPLE_READY_FOR_APPROVAL',
      'SAMPLE_APPROVED',
    ])
      expect(sampleEvents.filter((x) => x === t)).toHaveLength(1);
    const quotations = await prisma.quotation.findMany({
      where: { sampleId: s.sampleId },
    });
    const q = await types(quotations.map((x) => x.id));
    expect(q.filter((x) => x === 'QUOTATION_SENT')).toHaveLength(1);
    expect(q.filter((x) => x === 'QUOTATION_ACCEPTED')).toHaveLength(1);
    const payments = await prisma.payment.findMany({
      where: { sampleId: s.sampleId },
    });
    const p = await types(payments.map((x) => x.id));
    expect(p).toEqual(
      expect.arrayContaining(['PAYMENT_SUBMITTED', 'PAYMENT_VERIFIED']),
    );
    // the sample production job
    const jobEvents = await types([s.sampleJobId]);
    expect(jobEvents.filter((x) => x === 'JOB_STARTED')).toHaveLength(1); // once, however many stages follow
    expect(jobEvents.filter((x) => x === 'JOB_COMPLETED')).toHaveLength(1);
    // samples never produce customer milestones (those are for bulk orders)
    expect(jobEvents).not.toContain('ORDER_MILESTONE');
    for (const e of await events([
      s.sampleId,
      ...quotations.map((x) => x.id),
      ...payments.map((x) => x.id),
    ]))
      expect(JSON.stringify(e.payload)).not.toMatch(/token|password|secret/i);
  });

  it('sample events reach the right people and nobody else', async () => {
    const submitted = (
      await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: s.sampleId, eventType: 'SAMPLE_SUBMITTED' },
      })
    ).id;
    const got = await prisma.notification.findMany({
      where: { outboxEventId: submitted },
    });
    const recipients = new Set(
      got
        .filter((n) => n.recipientKind === 'STAFF')
        .map((n) => n.recipientUserId),
    );
    expect(recipients.has(admin.id)).toBe(true);
    expect(recipients.has(floor.sewing.id)).toBe(false);
    // every recipient holds samples.review (the audience of the rule), nobody else was told
    const holders = await prisma.user.findMany({
      where: {
        id: { in: [...recipients] as string[] },
        roles: {
          some: {
            role: {
              permissions: { some: { permission: { code: 'samples.review' } } },
            },
          },
        },
      },
      select: { id: true },
    });
    expect(new Set(holders.map((h) => h.id))).toEqual(recipients);
    const ready = await prisma.notification.findMany({
      where: { type: 'SAMPLE_READY_FOR_APPROVAL', entityId: s.sampleId },
    });
    expect(
      ready.some(
        (n) => n.recipientUserId === a.salesUserId && n.channel === 'IN_APP',
      ),
    ).toBe(true); // the sample's sales owner
    expect(ready.some((n) => n.recipientKind === 'CUSTOMER')).toBe(true); // and the customer, in their language
    expect(ready.some((n) => n.recipientUserId === admin.id)).toBe(false);
    const payments = await prisma.payment.findMany({
      where: { sampleId: s.sampleId },
    });
    const submitted2 = await prisma.notification.findMany({
      where: {
        type: 'PAYMENT_SUBMITTED',
        entityId: { in: payments.map((p) => p.id) },
      },
    });
    const payRecipients = new Set(submitted2.map((n) => n.recipientUserId));
    expect(payRecipients.has(a.financeUserId)).toBe(true); // payments.verify
    expect(payRecipients.has(admin.id)).toBe(false); // ADMIN does not hold payments.verify
    expect(payRecipients.has(a.salesUserId)).toBe(false);
    expect(payRecipients.has(floor.sewing.id)).toBe(false);
  });

  it('a commercial revision and the order documents raise their events', async () => {
    const order = await createOrder(a.sales, s.sampleId, {
      items: standardItems(s),
      assignedSalesUserId: a.salesUserId,
    });
    const q = (
      await a.sales
        .post(`/admin/orders/${order.id}/quotations`, {
          lineItems: [
            {
              type: 'PRINTING',
              description: 'Print',
              quantity: 100,
              unitPrice: 40,
            },
          ],
        })
        .expect(201)
    ).body;
    await a.sales
      .post(`/admin/quotation-versions/${q.currentVersion.id}/send`)
      .expect(200);
    await a.sales
      .post(`/admin/order-quotation-versions/${q.currentVersion.id}/accept`, {
        sourceNote: 'WhatsApp',
      })
      .expect(200);
    await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
    const proof = (await a.sales.upload('PAYMENT_PROOF', 'r.png').expect(201))
      .body;
    const pay = (
      await a.sales
        .post(`/admin/orders/${order.id}/payments`, {
          amount: 1000,
          method: 'INSTAPAY',
          proofAssetId: proof.id,
        })
        .expect(201)
    ).body;
    await a.finance.post(`/admin/payments/${pay.id}/verify`).expect(200);
    await a.admin
      .post(`/admin/orders/${order.id}/revise`, {
        reason: 'more units',
        items: standardItems(s, 80, 40),
      })
      .expect(200);
    const orderEvents = await types([order.id]);
    expect(orderEvents).toEqual(
      expect.arrayContaining([
        'ORDER_CONFIRMED',
        'COMMERCIAL_REAPPROVAL_REQUIRED',
      ]),
    );
    expect(await types([q.id])).toEqual(
      expect.arrayContaining(['QUOTATION_SENT', 'QUOTATION_ACCEPTED']),
    );
    expect(await types([pay.id])).toEqual(
      expect.arrayContaining(['PAYMENT_SUBMITTED', 'PAYMENT_VERIFIED']),
    );
    await drain(app);
    const re = await inbox(
      a.salesUserId,
      'COMMERCIAL_REAPPROVAL_REQUIRED',
      order.id,
    );
    expect(re).toHaveLength(1);
    expect(re[0]).toMatchObject({ critical: true });
    expect(
      (await inbox(a.financeUserId, 'COMMERCIAL_REAPPROVAL_REQUIRED', order.id))
        .length,
    ).toBe(1);
    expect(
      await inbox(floor.sewing.id, 'COMMERCIAL_REAPPROVAL_REQUIRED', order.id),
    ).toHaveLength(0);
    // the customer is never told that internal terms changed
    expect(
      await prisma.notification.count({
        where: {
          type: 'COMMERCIAL_REAPPROVAL_REQUIRED',
          recipientKind: 'CUSTOMER',
        },
      }),
    ).toBe(0);
    // the customer hears about the quotation and the verified payment (transactional messages)
    const customerTypes = (
      await prisma.notification.findMany({
        where: {
          recipientKind: 'CUSTOMER',
          customerId: s.customerId,
          entityId: { in: [q.id, pay.id] },
        },
      })
    ).map((n) => n.type);
    expect(customerTypes).toEqual(
      expect.arrayContaining(['QUOTATION_SENT', 'PAYMENT_VERIFIED']),
    );
    expect(new Set(customerTypes)).not.toContain('PAYMENT_SUBMITTED'); // internal
  }, 90_000);

  it('factory events: assignment, block, QC failure, rework and completion', async () => {
    const order = await readyOrder(a.admin, s, {
      priority: 'NORMAL',
      assignedSalesUserId: a.salesUserId,
    });
    const job = (
      await a.admin
        .post(`/admin/orders/${order.id}/create-factory-job`)
        .expect(201)
    ).body;
    const fabric = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
    const worker = await assignWorker(a.admin, floor, fabric);
    const other = await makeWorker(app, 'FABRIC');
    await a.admin
      .post(`/admin/job-stages/${fabric.id}/blockers`, {
        type: 'MATERIAL_UNAVAILABLE',
        description: 'Fabric not delivered',
      })
      .expect(201);
    await drain(app);
    expect(await types([fabric.id])).toEqual(
      expect.arrayContaining(['STAGE_ASSIGNED', 'STAGE_BLOCKED']),
    );
    // the assignee, and only the assignee, is told about the assignment
    const assigned = await inbox(worker.id, 'STAGE_ASSIGNED', fabric.id);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.title).toContain('Fabric');
    expect(await inbox(other.id, 'STAGE_ASSIGNED', fabric.id)).toHaveLength(0);
    // a blocked stage reaches the admins and the order's sales owner
    expect((await inbox(admin.id, 'STAGE_BLOCKED', fabric.id)).length).toBe(1);
    expect(
      (await inbox(a.salesUserId, 'STAGE_BLOCKED', fabric.id)).length,
    ).toBe(1);
    const blocked = (await inbox(admin.id, 'STAGE_BLOCKED', fabric.id))[0]!;
    expect(blocked.body).toContain('Fabric not delivered');

    // QC failure + rework
    const order2 = await readyOrder(a.admin, s, { priority: 'NORMAL' });
    const job2 = (
      await a.admin
        .post(`/admin/orders/${order2.id}/create-factory-job`)
        .expect(201)
    ).body;
    for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING', 'CUTTING'])
      expect((await runBulkStage(app, a, floor, job2.id, code)).status).toBe(
        200,
      );
    expect(
      (
        await runBulkStage(app, a, floor, job2.id, 'QC_GATE_1', {
          failUnits: 5,
        })
      ).status,
    ).toBe(200);
    const qcStage = await prisma.jobStage.findFirstOrThrow({
      where: { jobId: job2.id, stageCode: 'QC_GATE_1' },
      orderBy: { attempt: 'asc' },
    });
    await drain(app);
    expect(await types([qcStage.id])).toContain('QC_FAILED');
    expect(await types([job2.id])).toContain('REWORK_CREATED');
    expect((await inbox(floor.qc.id, 'QC_FAILED', qcStage.id)).length).toBe(1);
    expect((await inbox(admin.id, 'QC_FAILED', qcStage.id)).length).toBe(1);
    expect((await inbox(admin.id, 'REWORK_CREATED', job2.id)).length).toBe(1);
    expect(await inbox(a.salesUserId, 'QC_FAILED', qcStage.id)).toHaveLength(0);
  }, 120_000);

  it('production, packaging, dispatch, failure and delivery raise the delivery-side events', async () => {
    const { order, job } = await producedOrder(app, a, floor, s, {
      priority: 'NORMAL',
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { assignedSalesUserId: a.salesUserId },
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
    const ship = async (variant: number, qty: number) =>
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
      ).body as { id: string };
    const s1 = await ship(0, 60);
    const s2 = await ship(1, 40);
    for (const x of [s1, s2]) {
      await a.admin.post(`/admin/shipments/${x.id}/ready`).expect(200);
      await w.api.post(`/staff/deliveries/${x.id}/dispatch`, {}).expect(200);
    }
    await w.api.post(`/staff/deliveries/${s2.id}/in-transit`).expect(200); // in transit is not a second "dispatched" event
    await w.api
      .post(`/staff/deliveries/${s1.id}/failed`, { reason: 'Nobody home' })
      .expect(200);
    await w.api.post(`/staff/deliveries/${s1.id}/dispatch`, {}).expect(200); // retry
    await w.api.post(`/staff/deliveries/${s1.id}/delivered`, {}).expect(200);
    await w.api.post(`/staff/deliveries/${s2.id}/delivered`, {}).expect(200);
    await drain(app);

    const orderEvents = await types([order.id]);
    for (const t of [
      'ORDER_CONFIRMED',
      'ORDER_READY_FOR_PRODUCTION',
      'ORDER_PRODUCTION_COMPLETED',
      'ORDER_READY_FOR_DELIVERY',
      'ORDER_DELIVERED',
    ])
      expect(
        orderEvents.filter((x) => x === t),
        t,
      ).toHaveLength(1);
    expect(await types([job.id])).toEqual(
      expect.arrayContaining(['JOB_STARTED', 'JOB_COMPLETED']),
    );
    const sh = await types([s1.id, s2.id]);
    expect(sh.filter((x) => x === 'SHIPMENT_DISPATCHED')).toHaveLength(3); // s1, s2, and s1's retry; s2 "in transit" is not one
    expect(sh.filter((x) => x === 'SHIPMENT_FAILED')).toHaveLength(1);

    // failed delivery is critical for sales and admins, and never goes to the customer
    const failed = await prisma.notification.findMany({
      where: { type: 'SHIPMENT_FAILED', entityId: s1.id },
    });
    expect(
      failed.some(
        (n) =>
          n.recipientUserId === a.salesUserId &&
          n.critical &&
          n.channel === 'IN_APP',
      ),
    ).toBe(true);
    expect(
      failed.some((n) => n.recipientUserId === admin.id && n.critical),
    ).toBe(true);
    expect(failed.some((n) => n.recipientKind === 'CUSTOMER')).toBe(false);
    expect(
      failed.find(
        (n) => n.recipientUserId === a.salesUserId && n.channel === 'IN_APP',
      )!.body,
    ).toContain('Nobody home');
    // customer-facing: ready for delivery, dispatched, delivered (and milestones); nothing internal
    const customerMsgs = await prisma.notification.findMany({
      where: {
        recipientKind: 'CUSTOMER',
        entityId: { in: [order.id, s1.id, s2.id] },
      },
    });
    const t = new Set(customerMsgs.map((n) => n.type));
    expect([...t]).toEqual(
      expect.arrayContaining([
        'ORDER_READY_FOR_DELIVERY',
        'SHIPMENT_DISPATCHED',
        'ORDER_DELIVERED',
      ]),
    );
    for (const forbidden of [
      'SHIPMENT_FAILED',
      'QC_FAILED',
      'STAGE_BLOCKED',
      'REWORK_CREATED',
    ])
      expect(t.has(forbidden)).toBe(false);
    expect(customerMsgs.some((n) => /Nobody home/.test(n.body))).toBe(false);
    // delivery staff hear about goods that are ready; floor roles hear nothing about money
    expect(
      (await inbox(w.id, 'ORDER_READY_FOR_DELIVERY', order.id)).length,
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: {
          recipientUserId: floor.sewing.id,
          type: {
            in: ['PAYMENT_VERIFIED', 'PAYMENT_SUBMITTED', 'QUOTATION_ACCEPTED'],
          },
        },
      }),
    ).toBe(0);
  }, 180_000);

  it('a rejected payment and a sample sent back for changes are emitted and notify the customer', async () => {
    // payment rejected: the customer is told, with the staff-written message only
    const awaiting = await toAwaitingPayment(app, a, refs);
    const proof = (await a.sales.upload('PAYMENT_PROOF', 'r.png').expect(201))
      .body;
    const payment = (
      await a.sales
        .post(`/admin/samples/${awaiting.sample.id}/payments`, {
          amount: 100,
          method: 'INSTAPAY',
          proofAssetId: proof.id,
        })
        .expect(201)
    ).body;
    await a.finance
      .post(`/admin/payments/${payment.id}/reject`, {
        reason: 'INTERNAL: sender mismatch',
        customerMessage: 'The transfer name does not match.',
      })
      .expect(200);
    // sample sent back: recorded on the customer's behalf by staff, same event as the portal path
    const finished = await toAwaitingApproval(app, a, refs);
    const req = (
      await a.sales
        .post(`/admin/samples/${finished.sample.id}/approvals`, {
          type: 'SAMPLE',
        })
        .expect(201)
    ).body;
    await a.sales
      .post(`/admin/approvals/${req.id}/reject`, {
        sourceNote: 'Customer asked on WhatsApp (test)',
        responseNote: 'Sleeves too long',
      })
      .expect(200);
    await drain(app);
    const rejected = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: payment.id, eventType: 'PAYMENT_REJECTED' },
    });
    expect(JSON.stringify(rejected.payload)).not.toContain('INTERNAL');
    expect(rejected.payload).toMatchObject({
      reason: 'The transfer name does not match.',
    });
    const changes = await prisma.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: finished.sample.id,
        eventType: 'SAMPLE_CHANGES_REQUESTED',
      },
    });
    expect(changes.payload).toMatchObject({ reason: 'Sleeves too long' });
    const toCustomer = await prisma.notification.findMany({
      where: { entityId: { in: [payment.id, finished.sample.id] } },
    });
    const templates = toCustomer
      .filter((n) => n.recipientKind === 'CUSTOMER')
      .map((n) => n.templateCode);
    expect(templates).toEqual(
      expect.arrayContaining([
        'PAYMENT_REJECTED',
        'SAMPLE_CHANGES_REQUESTED_CUSTOMER',
      ]),
    );
    expect(
      toCustomer
        .filter((n) => n.recipientKind === 'CUSTOMER')
        .map((n) => n.body)
        .join(' '),
    ).not.toContain('INTERNAL');
  }, 180_000);

  it('a submitted order tells the people who confirm orders', async () => {
    const o = await createOrder(a.sales, s.sampleId, {
      items: standardItems(s),
    });
    await a.sales.post(`/admin/orders/${o.id}/submit`).expect(200);
    await drain(app);
    const ev = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: o.id, eventType: 'ORDER_SUBMITTED' },
    });
    expect(ev.payload).toMatchObject({ orderId: o.id });
    expect((await inbox(admin.id, 'ORDER_SUBMITTED', o.id)).length).toBe(1);
    // sales hold orders.confirm, so they are among the confirmers: told once, not once per rule
    expect((await inbox(a.salesUserId, 'ORDER_SUBMITTED', o.id)).length).toBe(
      1,
    );
  }, 120_000);

  it('every supported event type is emitted by a real flow', async () => {
    const emitted = new Set(
      (
        await prisma.outboxEvent.findMany({
          where: { createdAt: { gte: startedAt } },
          select: { eventType: true },
          distinct: ['eventType'],
        })
      ).map((e) => e.eventType),
    );
    // ALERT_* are raised by the scheduled evaluator (tested with the alerts); the rest come from the business flows above
    const fromFlows = EVENT_TYPES.filter((t) => !t.startsWith('ALERT_'));
    expect(fromFlows.filter((t) => !emitted.has(t))).toEqual([]);
  });
});
