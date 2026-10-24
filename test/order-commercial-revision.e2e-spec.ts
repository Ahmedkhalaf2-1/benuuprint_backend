import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/database/prisma.service.js';
import type { AppConfig } from '../src/config/app.config.js';
import { auditActions, createTestApp } from './support/app.js';
import {
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';
import { makeFloor, type Floor } from './support/floor.js';
import {
  approvedReferenceSample,
  createOrder,
  standardItems,
  type ApprovedSample,
  type OrderBody,
} from './support/orders.js';

const linesFor = (qty: number, unit = 40) => [
  { type: 'PRINTING', description: 'Print', quantity: qty, unitPrice: unit },
];
// 100 units × 40 = 4000.00 ; 120 units × 40 = 4800.00
const TOTAL_100 = '4000.00';

describe('Order revisions and commercial validity (Phase 5B.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let gate: AppConfig['orders'];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    gate = app.get(ConfigService).getOrThrow<AppConfig>('app').orders;
    gate.requireAcceptedQuotation = true;
    gate.requiredPaidPercent = 100;
  });
  afterAll(async () => {
    gate.requireAcceptedQuotation = false;
    await app.close();
  });

  const items = (qm: number, ql: number) => standardItems(s, qm, ql);
  const newQuote = async (orderId: string, qty = 100, unit = 40) => {
    const q = (
      await a.sales
        .post(`/admin/orders/${orderId}/quotations`, {
          lineItems: linesFor(qty, unit),
        })
        .expect(201)
    ).body;
    const versionId = q.currentVersion.id as string;
    await a.sales
      .post(`/admin/quotation-versions/${versionId}/send`)
      .expect(200);
    return { q, versionId };
  };
  const accept = (versionId: string) =>
    a.sales.post(`/admin/order-quotation-versions/${versionId}/accept`, {
      sourceNote: 'WhatsApp confirmation (test)',
    });
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
    return id;
  };
  const commercial = async (id: string) =>
    (await a.sales.get(`/admin/orders/${id}/commercial`).expect(200)).body;
  const revise = (id: string, body: object) =>
    a.admin.post(`/admin/orders/${id}/revise`, {
      reason: 'customer change',
      ...body,
    });
  const dbVersions = (orderId: string) =>
    prisma.quotationVersion.findMany({
      where: { quotation: { orderId } },
      orderBy: { createdAt: 'asc' },
    });

  /** Confirmed order, quotation accepted for 100 units, fully paid, released for production. */
  const releasedOrder = async (): Promise<{
    order: OrderBody;
    versionId: string;
    quotationId: string;
  }> => {
    const order = await createOrder(a.sales, s.sampleId, {
      items: items(60, 40),
    });
    const { q, versionId } = await newQuote(order.id);
    await accept(versionId).expect(200);
    await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
    await payAndVerify(order.id, 4000);
    await a.sales.post(`/admin/orders/${order.id}/ready`).expect(200);
    return { order, versionId, quotationId: q.id };
  };
  /** Accepted + paid, but only CONFIRMED (not yet released). */
  const confirmedPaid = async () => {
    const order = await createOrder(a.sales, s.sampleId, {
      items: items(60, 40),
    });
    const { versionId } = await newQuote(order.id);
    await accept(versionId).expect(200);
    await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
    await payAndVerify(order.id, 4000);
    return { order, versionId };
  };

  it('a quantity revision ends the accepted quotation and pulls a released order back', async () => {
    const { order, versionId } = await releasedOrder();
    const rev = (await revise(order.id, { items: items(80, 40) }).expect(200))
      .body;
    expect(rev.status).toBe('CONFIRMED');

    const c = await commercial(order.id);
    expect(c.reapprovalRequired).toBe(true);
    expect(c.acceptedTotal).toBeNull();
    expect(c.releaseGate.satisfied).toBe(false);
    expect(c.releaseGate.reasons.join()).toMatch(/no longer applies/);
    await a.sales.post(`/admin/orders/${order.id}/ready`).expect(409);
    // the superseded offer cannot be (re-)decided
    await accept(versionId).expect(409);

    const acts = (
      await a.sales
        .get(`/admin/orders/${order.id}/activities?pageSize=100`)
        .expect(200)
    ).body.data as { type: string; message: string }[];
    expect(acts.map((x) => x.type)).toContain('COMMERCIAL_REAPPROVAL_REQUIRED');
    const audit = await auditActions(app, order.id);
    expect(audit).toContain('order.commercial_reapproval_required');
    expect(await auditActions(app, versionId)).toContain(
      'quotation_version.invalidated',
    );
  });

  it('a variant-only revision (same total) also requires re-approval', async () => {
    const { order } = await releasedOrder();
    await revise(order.id, { items: items(50, 50) }).expect(200);
    const c = await commercial(order.id);
    expect(c.reapprovalRequired).toBe(true);
    await a.sales.post(`/admin/orders/${order.id}/ready`).expect(409);
    const rows = await prisma.orderRevision.findMany({
      where: { orderId: order.id },
    });
    expect(rows[0]).toMatchObject({ commercialImpact: true });
    expect((rows[0]!.commercialChanges as string[]).join()).toMatch(
      /Size\/colour breakdown/,
    );
  });

  it('a non-commercial revision keeps the accepted quotation valid', async () => {
    const { order, versionId } = await releasedOrder();
    const rev = (
      await revise(order.id, {
        internalNotes: 'pack carefully',
        targetDeliveryDate: new Date(Date.now() + 40 * 864e5).toISOString(),
      }).expect(200)
    ).body;
    expect(rev.status).toBe('READY_FOR_PRODUCTION');
    const c = await commercial(order.id);
    expect(c.reapprovalRequired).toBe(false);
    expect(c.releaseGate.satisfied).toBe(true);
    expect(c.acceptedTotal).toBe(TOTAL_100);
    const v = await prisma.quotationVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(v.status).toBe('ACCEPTED');
    expect(v.invalidatedAt).toBeNull();
    const row = await prisma.orderRevision.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(row.commercialImpact).toBe(false);
  });

  it('keeps the old quotation, its decision and its amount readable', async () => {
    const { order, versionId, quotationId } = await releasedOrder();
    await revise(order.id, { items: items(80, 40) }).expect(200);
    const list = (
      await a.sales.get(`/admin/orders/${order.id}/quotations`).expect(200)
    ).body as {
      id: string;
      currentVersion: Record<string, unknown>;
    }[];
    const old = list.find((q) => q.id === quotationId)!;
    expect(old.currentVersion).toMatchObject({
      id: versionId,
      status: 'SUPERSEDED',
      total: TOTAL_100,
      orderRevision: 0, // quoted while the order was still a DRAFT (revision 0)
      invalidatedByRevision: 2,
    });
    expect(old.currentVersion.acceptedAt).toBeTruthy();
    expect(old.currentVersion.invalidatedAt).toBeTruthy();
    expect(String(old.currentVersion.invalidationReason)).toMatch(
      /Total quantity changed from 100 to 120/,
    );
    const db = await prisma.quotationVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(db.decisionNote).toBe('WhatsApp confirmation (test)');
    expect(db.total.toString()).toBe('4000');
    const revs = (
      await a.sales.get(`/admin/orders/${order.id}/revisions`).expect(200)
    ).body;
    expect(revs[0]).toMatchObject({ commercialImpact: true });
    expect(revs[0].commercialChanges.length).toBeGreaterThan(0);
  });

  it('a new quotation accepted for the revision lets production pass again; payments carry forward', async () => {
    const { order } = await releasedOrder();
    await revise(order.id, { items: items(80, 40) }).expect(200);
    const { versionId, q } = await newQuote(order.id, 120);
    expect(q.currentVersion.total).toBe('4800.00');
    // still blocked until accepted
    await a.sales.post(`/admin/orders/${order.id}/ready`).expect(409);
    await accept(versionId).expect(200);
    expect(
      (await dbVersions(order.id)).find((v) => v.id === versionId)!
        .orderRevision,
    ).toBe(2);

    // 4000 verified earlier counts toward 4800: 800 remain
    let c = await commercial(order.id);
    expect(c).toMatchObject({
      acceptedTotal: '4800.00',
      verifiedPaid: '4000.00',
      remaining: '800.00',
      overpaid: '0.00',
      paymentState: 'PARTIALLY_PAID',
      reapprovalRequired: false,
    });
    expect(c.counts.verified).toBe(1); // no duplicated payment history
    await a.sales.post(`/admin/orders/${order.id}/ready`).expect(409); // 800 short
    await payAndVerify(order.id, 800);
    c = await commercial(order.id);
    expect(c).toMatchObject({ remaining: '0.00', paymentState: 'PAID' });
    expect(
      (await a.sales.post(`/admin/orders/${order.id}/ready`).expect(200)).body
        .status,
    ).toBe('READY_FOR_PRODUCTION');
    // the first payment still points at the first quotation version
    const pays = await prisma.payment.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(pays).toHaveLength(2);
    expect(pays[0]!.quotationVersionId).not.toBe(pays[1]!.quotationVersionId);
  });

  it('a smaller re-quote keeps payment history; the overpayment is reported, not refunded', async () => {
    const { order } = await confirmedPaid();
    await revise(order.id, { items: items(30, 20) }).expect(200);
    const { versionId } = await newQuote(order.id, 50, 40); // 2000.00 < 4000.00 verified
    await accept(versionId).expect(200);
    const c = await commercial(order.id);
    expect(c).toMatchObject({
      acceptedTotal: '2000.00',
      verifiedPaid: '4000.00',
      remaining: '0.00',
      overpaid: '2000.00',
      paymentState: 'PAID',
    });
    expect(c.releaseGate.satisfied).toBe(true);
    expect(
      (
        await prisma.payment.findMany({
          where: { orderId: order.id, status: 'VERIFIED' },
        })
      ).length,
    ).toBe(1);
    // nothing more can be recorded against a fully covered order
    const proof = (await a.sales.upload('PAYMENT_PROOF', 'r.png').expect(201))
      .body;
    await a.sales
      .post(`/admin/orders/${order.id}/payments`, {
        amount: 1,
        method: 'INSTAPAY',
        proofAssetId: proof.id,
      })
      .expect(400);
  });

  it('a new version on the same quotation works after a revision', async () => {
    const { order, quotationId } = await releasedOrder();
    await revise(order.id, { items: items(80, 40) }).expect(200);
    const v = (
      await a.sales
        .post(`/admin/quotations/${quotationId}/versions`, {
          lineItems: linesFor(120),
        })
        .expect(201)
    ).body;
    expect(v).toMatchObject({ versionNumber: 2, orderRevision: 2 });
    await a.sales.post(`/admin/quotation-versions/${v.id}/send`).expect(200);
    await accept(v.id).expect(200);
    expect((await commercial(order.id)).acceptedTotal).toBe('4800.00');
  });

  it('supersedes a sent or draft quotation too, and a DRAFT order edit after quoting', async () => {
    const order = await createOrder(a.sales, s.sampleId, {
      items: items(60, 40),
    });
    const { versionId } = await newQuote(order.id); // SENT
    await a.sales
      .put(`/admin/orders/${order.id}/items`, { items: items(70, 40) })
      .expect(200);
    const v = await prisma.quotationVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(v.status).toBe('SUPERSEDED');
    expect(v.invalidatedAt).toBeTruthy();
    await accept(versionId).expect(409);
    // an unchanged resend of the same items is not commercial
    const second = await newQuote(order.id, 110);
    await a.sales
      .put(`/admin/orders/${order.id}/items`, { items: items(70, 40) })
      .expect(200);
    expect(
      (
        await prisma.quotationVersion.findUniqueOrThrow({
          where: { id: second.versionId },
        })
      ).status,
    ).toBe('SENT');
  });

  it('without a gate, an order that lost an accepted quotation still needs a new one', async () => {
    gate.requireAcceptedQuotation = false;
    try {
      const order = await createOrder(a.sales, s.sampleId, {
        items: items(60, 40),
      });
      const { versionId } = await newQuote(order.id);
      await accept(versionId).expect(200);
      await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
      await revise(order.id, { items: items(70, 40) }).expect(200);
      const r = await a.sales
        .post(`/admin/orders/${order.id}/ready`)
        .expect(409);
      expect(JSON.stringify(r.body)).toMatch(/no longer applies/);
    } finally {
      gate.requireAcceptedQuotation = true;
    }
  });

  it('the database refuses to end or change an accepted quotation any other way', async () => {
    const { versionId } = await releasedOrder();
    await expect(
      prisma.quotationVersion.update({
        where: { id: versionId },
        data: { status: 'SUPERSEDED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.quotationVersion.update({
        where: { id: versionId },
        data: { total: 1, subtotal: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.quotationVersion.update({
        where: { id: versionId },
        data: { orderRevision: 9 },
      }),
    ).rejects.toThrow();
  });

  // ───────────────────────── concurrency ─────────────────────────
  describe('concurrency', () => {
    it('revision vs quotation acceptance never leaves a stale accepted quotation', async () => {
      for (let i = 0; i < 4; i++) {
        const order = await createOrder(a.sales, s.sampleId, {
          items: items(60, 40),
        });
        const { versionId } = await newQuote(order.id);
        await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
        const [acc, rev] = await Promise.all([
          accept(versionId),
          revise(order.id, { items: items(80, 40) }),
        ]);
        expect(rev.status).toBe(200);
        expect([200, 409]).toContain(acc.status);
        const o = await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(o.commercialRevision).toBe(2);
        const live = (await dbVersions(order.id)).filter(
          (v) => v.status === 'ACCEPTED',
        );
        expect(live).toHaveLength(0); // priced revision 1, so nothing may stay valid
        expect((await commercial(order.id)).acceptedTotal).toBeNull();
      }
    });

    it('revision vs readiness leaves the order unreleased', async () => {
      for (let i = 0; i < 4; i++) {
        const { order } = await confirmedPaid();
        const [ready, rev] = await Promise.all([
          a.sales.post(`/admin/orders/${order.id}/ready`),
          revise(order.id, { items: items(80, 40) }),
        ]);
        expect(rev.status).toBe(200);
        expect([200, 409]).toContain(ready.status);
        const o = await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(o.status).toBe('CONFIRMED');
      }
    });

    it('payment verification during a revision credits the money either way', async () => {
      for (let i = 0; i < 3; i++) {
        const order = await createOrder(a.sales, s.sampleId, {
          items: items(60, 40),
        });
        const { versionId } = await newQuote(order.id);
        await accept(versionId).expect(200);
        await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
        const proof = (
          await a.sales.upload('PAYMENT_PROOF', 'p.png').expect(201)
        ).body;
        const pid = (
          await a.sales
            .post(`/admin/orders/${order.id}/payments`, {
              amount: 4000,
              method: 'INSTAPAY',
              proofAssetId: proof.id,
            })
            .expect(201)
        ).body.id as string;
        const [ver, rev] = await Promise.all([
          a.finance.post(`/admin/payments/${pid}/verify`),
          revise(order.id, { items: items(80, 40) }),
        ]);
        expect(ver.status).toBe(200);
        expect(rev.status).toBe(200);
        const c = await commercial(order.id);
        expect(c.verifiedPaid).toBe(TOTAL_100);
        expect(c.reapprovalRequired).toBe(true);
      }
    });

    it('two simultaneous revisions serialise into consecutive revisions', async () => {
      const order = await createOrder(a.sales, s.sampleId, {
        items: items(60, 40),
      });
      await a.sales.post(`/admin/orders/${order.id}/confirm`).expect(200);
      const res = await Promise.all([
        revise(order.id, { items: items(70, 40) }),
        revise(order.id, { items: items(60, 50) }),
      ]);
      expect(res.map((r) => r.status)).toEqual([200, 200]);
      const revs = await prisma.orderRevision.findMany({
        where: { orderId: order.id },
        orderBy: { revisionNumber: 'asc' },
      });
      expect(revs.map((r) => r.revisionNumber)).toEqual([2, 3]);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
          .commercialRevision,
      ).toBe(3);
    });
  });
});
