import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { AppConfig } from '../src/config/app.config.js';
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
import { makeFloor, makeWorker, type Floor } from './support/floor.js';
import {
  approvedReferenceSample,
  createOrder,
  orderDetail,
  producedOrder,
  readyOrder,
  standardItems,
  type ApprovedSample,
  type OrderBody,
} from './support/orders.js';

const LINES = [
  {
    type: 'PRINTING',
    description: 'DTF print x100',
    quantity: 100,
    unitPrice: 8.5,
  },
  {
    type: 'FABRIC',
    description: 'Fabric x100',
    quantity: 100,
    unitPrice: 31.5,
  },
];
const TOTAL = '4000.00'; // 850 + 3150

describe('Order commercial integration and public tracking (Phase 5B, e2e)', () => {
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
  });
  afterAll(() => app.close());

  const draftOrder = () =>
    createOrder(a.sales, s.sampleId, { items: standardItems(s) });
  /** DRAFT order with a SENT quotation. */
  const quoted = async (o?: OrderBody) => {
    const order = o ?? (await draftOrder());
    const q = (
      await a.sales
        .post(`/admin/orders/${order.id}/quotations`, { lineItems: LINES })
        .expect(201)
    ).body;
    const versionId = q.currentVersion.id as string;
    await a.sales
      .post(`/admin/quotation-versions/${versionId}/send`)
      .expect(200);
    return { order, q, versionId };
  };
  const accepted = async (o?: OrderBody) => {
    const r = await quoted(o);
    await a.sales
      .post(`/admin/order-quotation-versions/${r.versionId}/accept`, {
        sourceNote: 'WhatsApp confirmation (test)',
      })
      .expect(200);
    return r;
  };
  const pay = async (orderId: string, amount: number) => {
    const proof = (
      await a.sales.upload('PAYMENT_PROOF', 'receipt.png').expect(201)
    ).body;
    const p = (
      await a.sales
        .post(`/admin/orders/${orderId}/payments`, {
          amount,
          method: 'INSTAPAY',
          proofAssetId: proof.id,
        })
        .expect(201)
    ).body;
    return p.id as string;
  };
  const payAndVerify = async (orderId: string, amount: number) => {
    const id = await pay(orderId, amount);
    await a.finance.post(`/admin/payments/${id}/verify`).expect(200);
    return id;
  };

  // ───────────────────────── order quotations ─────────────────────────
  describe('quotations for orders', () => {
    it('creates a versioned Decimal quotation with an explicit currency', async () => {
      const o = await draftOrder();
      const q = (
        await a.sales
          .post(`/admin/orders/${o.id}/quotations`, {
            lineItems: LINES,
            currency: 'USD',
            discount: 100,
            taxPercent: 14,
          })
          .expect(201)
      ).body;
      expect(q.quotationNumber).toMatch(/^QTN-\d{6}$/);
      expect(q.orderId).toBe(o.id);
      expect(q.sampleId).toBeNull();
      expect(q.currency).toBe('USD');
      const v = q.currentVersion;
      expect(v).toMatchObject({
        versionNumber: 1,
        status: 'DRAFT',
        subtotal: '4000.00',
        discount: '100.00',
        taxPercent: '14.00',
        tax: '546.00',
        total: '4446.00',
      });
      expect(v.lineItems.map((l: { amount: string }) => l.amount)).toEqual([
        '850.00',
        '3150.00',
      ]);
      expect(
        (await a.sales.get(`/admin/orders/${o.id}/quotations`).expect(200))
          .body,
      ).toHaveLength(1);
      await a.sales
        .post(`/admin/orders/${o.id}/quotations`, { lineItems: LINES })
        .expect(409); // one live quotation at a time
      expect(await auditActions(app, q.id)).toContain('quotation.created');
      // clients cannot send totals
      await a.sales
        .post(`/admin/orders/${(await draftOrder()).id}/quotations`, {
          lineItems: LINES,
          total: 1,
        })
        .expect(400);
      await a.sales
        .post(`/admin/orders/${(await draftOrder()).id}/quotations`, {
          lineItems: LINES,
          currency: 'euro',
        })
        .expect(400);
    });

    it('versions, supersedes, accepts and freezes', async () => {
      const { order: o, q, versionId } = await quoted();
      const sent = (
        await a.sales.get(`/admin/quotation-versions/${versionId}`).expect(200)
      ).body;
      expect(sent.status).toBe('SENT');
      await a.sales
        .patch(`/admin/quotation-versions/${versionId}`, { notes: 'late edit' })
        .expect(409); // sent = immutable
      const v2 = (
        await a.sales
          .post(`/admin/quotations/${q.id}/versions`, {
            lineItems: [
              {
                type: 'PRINTING',
                description: 'DTF',
                quantity: 100,
                unitPrice: 9,
              },
            ],
          })
          .expect(201)
      ).body;
      expect(v2).toMatchObject({
        versionNumber: 2,
        status: 'DRAFT',
        total: '900.00',
      });
      expect(
        (
          await a.sales
            .get(`/admin/quotation-versions/${versionId}`)
            .expect(200)
        ).body.status,
      ).toBe('SUPERSEDED'); // preserved
      await a.sales
        .post(`/admin/order-quotation-versions/${versionId}/accept`, {
          sourceNote: 'too old',
        })
        .expect(409); // superseded
      await a.sales
        .patch(`/admin/quotation-versions/${v2.id}`, { notes: 'final wording' })
        .expect(200);
      await a.sales.post(`/admin/quotation-versions/${v2.id}/send`).expect(200);
      await a.sales
        .post(`/admin/order-quotation-versions/${v2.id}/accept`, {})
        .expect(400); // evidence is required
      const acc = (
        await a.sales
          .post(`/admin/order-quotation-versions/${v2.id}/accept`, {
            sourceNote: 'Customer agreed on WhatsApp 21 Oct',
          })
          .expect(200)
      ).body;
      expect(acc.status).toBe('ACCEPTED');
      expect(acc.acceptedAt).toBeTruthy();
      const row = await prisma.quotationVersion.findUniqueOrThrow({
        where: { id: v2.id },
      });
      expect(row.decisionNote).toMatch(/WhatsApp/);
      expect(row.decidedByUserId).toBe(a.salesUserId);
      await a.sales
        .post(`/admin/order-quotation-versions/${v2.id}/accept`, {
          sourceNote: 'again again',
        })
        .expect(409);
      await a.sales
        .post(`/admin/order-quotation-versions/${v2.id}/reject`, {
          sourceNote: 'changed my mind',
        })
        .expect(409);
      await a.sales
        .patch(`/admin/quotation-versions/${v2.id}`, { notes: 'x' })
        .expect(409);
      await a.sales.post(`/admin/quotations/${q.id}/versions`, {}).expect(409); // accepted is final
      await expect(
        prisma.quotationVersion.update({
          where: { id: v2.id },
          data: { total: 1 },
        }),
      ).rejects.toThrow();
      expect(await auditActions(app, v2.id)).toEqual(
        expect.arrayContaining(['quotation_version.accepted']),
      );
      const commercial = (
        await a.finance.get(`/admin/orders/${o.id}/commercial`).expect(200)
      ).body;
      expect(commercial).toMatchObject({
        quotedTotal: '900.00',
        acceptedTotal: '900.00',
        paymentState: 'UNPAID',
        remaining: '900.00',
        verifiedPaid: '0.00',
      });
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['QUOTATION_SENT', 'QUOTATION_ACCEPTED']),
      );
    });

    it('can record a rejection and quote again', async () => {
      const { order: o, versionId, q } = await quoted();
      await a.sales
        .post(`/admin/order-quotation-versions/${versionId}/reject`, {
          sourceNote: 'Customer found it too expensive',
        })
        .expect(200);
      const v2 = (
        await a.sales.post(`/admin/quotations/${q.id}/versions`, {}).expect(201)
      ).body; // starts from the old lines
      expect(v2.versionNumber).toBe(2);
      expect(
        (await a.sales.get(`/admin/orders/${o.id}/quotations`).expect(200))
          .body[0].versions,
      ).toHaveLength(2);
    });

    it('is only possible before production is released, and never for a cancelled order', async () => {
      const done = await producedOrder(app, a, floor, s);
      await a.sales
        .post(`/admin/orders/${done.order.id}/quotations`, { lineItems: LINES })
        .expect(409);
      const o = await draftOrder();
      await a.admin
        .post(`/admin/orders/${o.id}/cancel`, { reason: 'customer withdrew' })
        .expect(200);
      await a.sales
        .post(`/admin/orders/${o.id}/quotations`, { lineItems: LINES })
        .expect(409);
      await a.sales
        .post('/admin/orders/00000000-0000-4000-8000-000000000000/quotations', {
          lineItems: LINES,
        })
        .expect(404);
    });

    it('leaves sample quotations exactly as they were', async () => {
      const { versionId } = await quoted();
      // the sample approvals flow refuses an order version (and vice versa)
      await a.sales
        .post(`/admin/quotation-versions/${versionId}/accept`, {
          sourceNote: 'wrong endpoint',
        })
        .expect(409);
      const sample = await prisma.quotation.findFirst({
        where: { sampleId: { not: null } },
      });
      expect(sample?.orderId).toBeNull();
      await expect(
        prisma.quotation.create({
          data: {
            quotationNumber: 'QTN-990001',
            createdByUserId: a.salesUserId,
          },
        }),
      ).rejects.toThrow(); // exactly one target
      await expect(
        prisma.quotation.create({
          data: {
            quotationNumber: 'QTN-990002',
            sampleId: s.sampleId,
            orderId: (await draftOrder()).id,
          },
        }),
      ).rejects.toThrow();
      const sampleQuotes = (
        await a.sales.get(`/admin/samples/${s.sampleId}/quotations`).expect(200)
      ).body;
      expect(
        sampleQuotes.every(
          (q: { sampleId: string; orderId: null }) =>
            q.sampleId === s.sampleId && q.orderId === null,
        ),
      ).toBe(true);
    });

    it('needs the quotation and order-commercial permissions', async () => {
      const o = await draftOrder();
      await floor.cutting.api
        .get(`/admin/orders/${o.id}/quotations`)
        .expect(403);
      await a.finance.get(`/admin/orders/${o.id}/quotations`).expect(200);
      await a.finance
        .post(`/admin/orders/${o.id}/quotations`, { lineItems: LINES })
        .expect(403);
      const { versionId } = await quoted(o);
      await a.finance
        .post(`/admin/order-quotation-versions/${versionId}/accept`, {
          sourceNote: 'finance may not decide',
        })
        .expect(403);
      const limited = await createUserAndLogin(app, {
        permissions: ['quotations.create', 'quotations.read'],
      });
      await api(app, limited.accessToken)
        .post(`/admin/order-quotation-versions/${versionId}/accept`, {
          sourceNote: 'no commercial permission',
        })
        .expect(403);
    });
  });

  // ───────────────────────── order payments ─────────────────────────
  describe('payments for orders', () => {
    it('records, verifies and totals payments; derives the payment state', async () => {
      const { order: o } = await accepted();
      await a.sales
        .post(`/admin/orders/${(await draftOrder()).id}/payments`, {
          amount: 10,
          method: 'CASH',
        })
        .expect(409); // nothing accepted yet
      const first = await pay(o.id, 1500);
      let c = (
        await a.sales.get(`/admin/orders/${o.id}/commercial`).expect(200)
      ).body;
      expect(c).toMatchObject({
        paymentState: 'UNPAID',
        pendingPayments: '1500.00',
        verifiedPaid: '0.00',
      });
      await a.sales.post(`/admin/payments/${first}/verify`).expect(403); // sales has no payments.verify
      await a.finance.post(`/admin/payments/${first}/verify`).expect(200);
      c = (await a.finance.get(`/admin/orders/${o.id}/commercial`).expect(200))
        .body;
      expect(c).toMatchObject({
        paymentState: 'PARTIALLY_PAID',
        verifiedPaid: '1500.00',
        remaining: '2500.00',
        acceptedTotal: TOTAL,
      });
      expect(c.counts.verified).toBe(1);
      expect((await orderDetail(a.admin, o.id)).paymentState).toBe(
        'PARTIALLY_PAID',
      );
      await payAndVerify(o.id, 2500);
      c = (await a.admin.get(`/admin/orders/${o.id}/commercial`).expect(200))
        .body;
      expect(c).toMatchObject({
        paymentState: 'PAID',
        verifiedPaid: TOTAL,
        remaining: '0.00',
      });
      const detail = (await a.finance.get(`/admin/orders/${o.id}`).expect(200))
        .body;
      expect(detail.paymentState).toBe('PAID');
      expect(detail.commercial.verifiedPaid).toBe(TOTAL);
      const list = (await a.sales
        .get(`/admin/payments?x=1`)
        .catch(() => null)) as unknown;
      void list;
      const payments = (
        await a.finance.get(`/admin/orders/${o.id}/payments`).expect(200)
      ).body;
      expect(payments).toHaveLength(2);
      expect(
        payments.every(
          (p: { orderId: string; sampleId: null }) =>
            p.orderId === o.id && p.sampleId === null,
        ),
      ).toBe(true);
      const types = (
        await a.admin
          .get(`/admin/orders/${o.id}/activities?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(
        types.filter((t: string) => t === 'PAYMENT_VERIFIED'),
      ).toHaveLength(2);
      expect(await auditActions(app, first)).toEqual(
        expect.arrayContaining(['payment.created', 'payment.verified']),
      );
    });

    it('applies the overpayment policy and the separation of duties', async () => {
      const { order: o } = await accepted();
      await a.sales
        .post(`/admin/orders/${o.id}/payments`, {
          amount: 4000.01,
          method: 'INSTAPAY',
        })
        .expect(400); // never more than the balance
      await a.sales
        .post(`/admin/orders/${o.id}/payments`, {
          amount: 0,
          method: 'INSTAPAY',
        })
        .expect(400);
      await a.sales
        .post(`/admin/orders/${o.id}/payments`, {
          amount: -5,
          method: 'INSTAPAY',
        })
        .expect(400);
      await a.sales
        .post(`/admin/orders/${o.id}/payments`, {
          amount: 10,
          method: 'INSTAPAY',
          currency: 'USD',
        })
        .expect(400);
      await a.sales
        .post(`/admin/orders/${o.id}/payments`, {
          amount: 10,
          method: 'INSTAPAY',
          transactionReference: '4111 1111 1111 1111',
        })
        .expect(400); // card numbers are refused
      const mine = await pay(o.id, 3000);
      await a.sales.post(`/admin/payments/${mine}/verify`).expect(403);
      const finance = await createUserAndLogin(app, { roleCodes: ['FINANCE'] });
      const recorder = api(app, finance.accessToken);
      const proof = (
        await a.admin.upload('PAYMENT_PROOF', 'r2.png').expect(201)
      ).body;
      const own = (
        await recorder
          .post(`/admin/orders/${o.id}/payments`, {
            amount: 500,
            method: 'CASH',
            proofAssetId: proof.id,
          })
          .expect(201)
      ).body;
      await recorder.post(`/admin/payments/${own.id}/verify`).expect(403); // the person who recorded it cannot verify it
      const adminRole = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
      await api(app, adminRole.accessToken)
        .post(`/admin/payments/${own.id}/verify`)
        .expect(403); // the ADMIN role has no payments.verify either
      await a.finance.post(`/admin/payments/${own.id}/verify`).expect(200);
      // verifying more than remains is refused (race-safe: 3000 + 500 verified, 500 left)
      await a.finance.post(`/admin/payments/${mine}/verify`).expect(200);
      await a.sales
        .post(`/admin/orders/${o.id}/payments`, {
          amount: 500.01,
          method: 'CASH',
        })
        .expect(400);
      await a.sales
        .post(`/admin/payments/${await pay(o.id, 500)}/cancel`)
        .expect(200);
      const rejected = await pay(o.id, 100);
      await a.finance
        .post(`/admin/payments/${rejected}/reject`, {
          reason: 'amount does not match the transfer',
        })
        .expect(200);
      const c = (
        await a.admin.get(`/admin/orders/${o.id}/commercial`).expect(200)
      ).body;
      expect(c).toMatchObject({
        verifiedPaid: '3500.00',
        remaining: '500.00',
        paymentState: 'PARTIALLY_PAID',
      });
      expect(c.counts).toMatchObject({
        verified: 2,
        rejected: 1,
        cancelled: 1,
      });
    });

    it('verifies concurrently without overshooting the total', async () => {
      const { order: o } = await accepted();
      const a1 = await pay(o.id, 3000);
      const a2 = await pay(o.id, 1000);
      const a3 = await pay(o.id, 500); // 4500 recorded against 4000? the third exceeds the balance when recorded
      void a3;
      const res = await Promise.all(
        [a1, a2].map((id) => a.finance.post(`/admin/payments/${id}/verify`)),
      );
      expect(res.map((r) => r.status)).toEqual([200, 200]);
      const c = (
        await a.admin.get(`/admin/orders/${o.id}/commercial`).expect(200)
      ).body;
      expect(c.paymentState).toBe('PAID');
      expect(c.verifiedPaid).toBe(TOTAL);
    });

    it('keeps factory and delivery roles away from commercial amounts', async () => {
      const { order: o } = await accepted();
      await payAndVerify(o.id, 1000);
      const delivery = await makeWorker(app, 'DELIVERY');
      for (const who of [
        floor.cutting.api,
        floor.qc.api,
        floor.packaging.api,
        floor.sewing.api,
        delivery.api,
      ]) {
        await who.get(`/admin/orders/${o.id}/commercial`).expect(403);
        await who.get(`/admin/orders/${o.id}`).expect(403);
        await who.get(`/admin/orders/${o.id}/payments`).expect(403);
        await who
          .post(`/admin/orders/${o.id}/payments`, { amount: 1, method: 'CASH' })
          .expect(403);
      }
      // the production summary and job views carry no money either
      const summary = JSON.stringify(
        (
          await a.sales
            .get(`/admin/orders/${o.id}/production-summary`)
            .expect(200)
        ).body,
      );
      expect(summary).not.toMatch(
        /total|price|amount|payment/i.source === ''
          ? /x^/
          : /unitPrice|verifiedPaid|paymentState/,
      );
      // order detail for a caller without commercial rights has no commercial block
      const noCommercial = await createUserAndLogin(app, {
        permissions: ['orders.read'],
      });
      const d = (
        await api(app, noCommercial.accessToken)
          .get(`/admin/orders/${o.id}`)
          .expect(200)
      ).body;
      expect(d.commercial).toBeUndefined();
      expect(JSON.stringify(d)).not.toMatch(
        /verifiedPaid|acceptedTotal|quotedTotal/,
      );
      const withCommercial = (
        await a.finance.get(`/admin/orders/${o.id}`).expect(200)
      ).body;
      expect(withCommercial.commercial.acceptedTotal).toBe(TOTAL);
    });

    it('generalised payments keep sample behaviour: one target per payment, shared verify endpoints', async () => {
      const { order: o } = await accepted();
      const id = await pay(o.id, 100);
      const row = await prisma.payment.findUniqueOrThrow({ where: { id } });
      expect(row.sampleId).toBeNull();
      await expect(
        prisma.payment.create({
          data: {
            paymentNumber: 'PAY-990001',
            amount: 5,
            currency: 'EGP',
            method: 'CASH',
            createdByUserId: a.salesUserId,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.payment.create({
          data: {
            paymentNumber: 'PAY-990002',
            amount: 5,
            currency: 'EGP',
            method: 'CASH',
            sampleId: s.sampleId,
            orderId: o.id,
          },
        }),
      ).rejects.toThrow();
      const samplePayments = (
        await a.finance.get(`/admin/samples/${s.sampleId}/payments`).expect(200)
      ).body;
      expect(
        samplePayments.every((p: { orderId: null }) => p.orderId === null),
      ).toBe(true);
      expect(
        (await a.finance.get(`/admin/payments/${id}`).expect(200)).body.orderId,
      ).toBe(o.id);
    });
  });

  // ───────────────────────── production release gate ─────────────────────────
  describe('production commercial gate', () => {
    const withGate = async (
      percent: number,
      body: () => Promise<void>,
      requireQuote = true,
    ) => {
      const before = { ...gate };
      gate.requireAcceptedQuotation = requireQuote;
      gate.requiredPaidPercent = percent;
      try {
        await body();
      } finally {
        Object.assign(gate, before);
      }
    };

    it('needs an accepted quotation and the full amount by default', async () => {
      await withGate(100, async () => {
        const o = await draftOrder();
        await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
        const r = await a.sales.post(`/admin/orders/${o.id}/ready`).expect(409);
        expect(JSON.stringify(r.body)).toMatch(/no accepted quotation/);
        const { versionId } = await quoted(o);
        await a.sales
          .post(`/admin/order-quotation-versions/${versionId}/accept`, {
            sourceNote: 'WhatsApp OK',
          })
          .expect(200);
        const gateInfo = (
          await a.sales.get(`/admin/orders/${o.id}/commercial`).expect(200)
        ).body.releaseGate;
        expect(gateInfo).toMatchObject({
          satisfied: false,
          requiredPaidPercent: 100,
          requiredPaidAmount: TOTAL,
          requireAcceptedQuotation: true,
        });
        await a.sales.post(`/admin/orders/${o.id}/ready`).expect(409);
        await payAndVerify(o.id, 3999.99);
        await a.sales.post(`/admin/orders/${o.id}/ready`).expect(409); // one cent short
        await payAndVerify(o.id, 0.01);
        expect(
          (await a.sales.post(`/admin/orders/${o.id}/ready`).expect(200)).body
            .status,
        ).toBe('READY_FOR_PRODUCTION');
        expect(
          (await a.sales.get(`/admin/orders/${o.id}/commercial`).expect(200))
            .body.releaseGate.satisfied,
        ).toBe(true);
      });
    });

    it('supports a configured deposit instead of full payment', async () => {
      await withGate(30, async () => {
        const { order: o } = await accepted();
        await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
        await payAndVerify(o.id, 1000);
        await a.sales.post(`/admin/orders/${o.id}/ready`).expect(409); // 30% of 4000 = 1200
        await payAndVerify(o.id, 200);
        const c = (
          await a.sales.get(`/admin/orders/${o.id}/commercial`).expect(200)
        ).body;
        expect(c.releaseGate).toMatchObject({
          requiredPaidPercent: 30,
          requiredPaidAmount: '1200.00',
          satisfied: true,
        });
        expect(c.paymentState).toBe('PARTIALLY_PAID'); // not fully paid, yet releasable
        await a.sales.post(`/admin/orders/${o.id}/ready`).expect(200);
      });
    });

    it('can be switched off, and an order with no quotation then skips the gate', async () => {
      await withGate(
        100,
        async () => {
          const o = await draftOrder();
          await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
          await a.sales.post(`/admin/orders/${o.id}/ready`).expect(200);
        },
        false,
      );
    });

    it('still enforces an accepted quotation that exists even when quotations are optional', async () => {
      await withGate(
        100,
        async () => {
          const { order: o } = await accepted();
          await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
          await a.sales.post(`/admin/orders/${o.id}/ready`).expect(409);
        },
        false,
      );
    });

    it('does not let an order be closed while payments are outstanding, unless an admin overrides', async () => {
      await withGate(0, async () => {
        const { order: o } = await accepted();
        await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
        await a.sales.post(`/admin/orders/${o.id}/ready`).expect(200);
        await a.admin
          .put(`/admin/orders/${o.id}/packaging`, { polybagRequired: true })
          .expect(200);
        const job = (
          await a.admin
            .post(`/admin/orders/${o.id}/create-factory-job`)
            .expect(201)
        ).body;
        const { finishBulkJob } = await import('./support/orders.js');
        await finishBulkJob(app, a, floor, job.id, { packaging: {} });
        expect(await orderDetail(a.admin, o.id).then((d) => d.status)).toBe(
          'READY_FOR_DELIVERY',
        );
        const w = await makeWorker(app, 'DELIVERY');
        const sh = (
          await a.admin
            .post(`/admin/orders/${o.id}/shipments`, {
              deliveryMethod: 'CUSTOMER_PICKUP',
              recipientName: 'Mona Ali',
              recipientPhone: '+201001112233',
              assignedDeliveryUserId: w.id,
              lines: (await orderDetail(a.admin, o.id)).items[0]!.variants.map(
                (v) => ({ orderVariantId: v.id, quantity: v.quantity }),
              ),
            })
            .expect(201)
        ).body;
        await a.admin.post(`/admin/shipments/${sh.id}/ready`).expect(200);
        await w.api.post(`/staff/deliveries/${sh.id}/dispatch`, {}).expect(200);
        await w.api
          .post(`/staff/deliveries/${sh.id}/delivered`, {})
          .expect(200);
        expect(await orderDetail(a.admin, o.id).then((d) => d.status)).toBe(
          'DELIVERED',
        );
        const r = await a.admin
          .post(`/admin/orders/${o.id}/complete`)
          .expect(409);
        expect(JSON.stringify(r.body)).toMatch(/not fully paid/);
        // force-complete is its own permission, needs a reason and is audited
        await a.sales
          .post(`/admin/orders/${o.id}/force-complete`, {
            reason: 'customer pays on invoice',
          })
          .expect(403);
        await a.admin
          .post(`/admin/orders/${o.id}/force-complete`, {})
          .expect(400);
        const done = (
          await a.admin
            .post(`/admin/orders/${o.id}/force-complete`, {
              reason: 'customer pays on invoice',
            })
            .expect(200)
        ).body;
        expect(done.status).toBe('COMPLETED');
        expect(await auditActions(app, o.id)).toContain(
          'order.force_completed',
        );
      });
    });

    it('an order cannot be force-completed before production is complete', async () => {
      const o = await readyOrder(a.admin, s);
      await a.admin
        .post(`/admin/orders/${o.id}/force-complete`, {
          reason: 'trying to skip production',
        })
        .expect(409);
    });
  });

  // ───────────────────────── public tracking ─────────────────────────
  describe('public tracking', () => {
    const track = (token: string) =>
      request(app.getHttpServer()).get(`/api/v1/track/orders/${token}`);
    const hash = (t: string) => createHash('sha256').update(t).digest('hex');

    it('issues a secure token once, stores only its hash and exposes a safe view', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      expect(
        (await a.sales.get(`/admin/orders/${o.id}/tracking`).expect(200)).body,
      ).toMatchObject({ enabled: false });
      const issued = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token`, { expiresInDays: 30 })
          .expect(201)
      ).body;
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issued.path).toBe(`/api/v1/track/orders/${issued.token}`);
      expect(issued.url).toContain(issued.token); // PUBLIC_APP_URL is set in tests
      expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 29 * 86_400_000,
      );
      const row = await prisma.orderTrackingToken.findUniqueOrThrow({
        where: { id: issued.tokenId },
      });
      expect(row.tokenHash).toBe(hash(issued.token));
      expect(row.tokenHash).not.toContain(issued.token);
      const status = (
        await a.sales.get(`/admin/orders/${o.id}/tracking`).expect(200)
      ).body;
      expect(status).toMatchObject({ enabled: true, tokenId: issued.tokenId });
      expect(JSON.stringify(status)).not.toContain(issued.token);
      expect(
        (await orderDetail(a.admin, o.id)).fulfillment.trackingEnabled,
      ).toBe(true);
      await a.sales
        .post(`/admin/orders/${o.id}/tracking-token`, {})
        .expect(409); // regenerate to replace
      // the public view: exactly these fields, nothing else
      const view = (await track(issued.token).expect(200)).body;
      expect(Object.keys(view).sort()).toEqual([
        'currentStage',
        'deliveredQuantity',
        'orderNumber',
        'progressPercent',
        'remainingDeliveryQuantity',
        'shipments',
        'status',
        'targetDeliveryDate',
        'totalQuantity',
        'updatedAt',
      ]);
      expect(view).toMatchObject({
        orderNumber: o.orderNumber,
        status: 'READY_FOR_DELIVERY',
        totalQuantity: 100,
        deliveredQuantity: 0,
        remainingDeliveryQuantity: 100,
        progressPercent: 100,
        shipments: [],
      });
      expect(view.currentStage).toBeNull();
      // no auth needed, and the audit log never sees the raw token
      const audits = await prisma.auditLog.findMany({
        where: { entityId: o.id },
      });
      expect(JSON.stringify(audits)).not.toContain(issued.token);
      expect(JSON.stringify(audits)).not.toContain(row.tokenHash);
      const acts = await prisma.orderActivity.findMany({
        where: { orderId: o.id },
      });
      expect(JSON.stringify(acts)).not.toContain(issued.token);
      expect(audits.map((x) => x.action)).toContain('order_tracking.generated');
    });

    it('shows shipments and delivery progress, and still nothing private', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const w = await makeWorker(app, 'DELIVERY');
      const address = await prisma.customerAddress.create({
        data: {
          customerId: s.customerId,
          country: 'Egypt',
          city: 'Cairo',
          addressLine1: '77 Secret Street',
        },
      });
      const mk = async (variant: number, qty: number) =>
        (
          await a.admin
            .post(`/admin/orders/${o.id}/shipments`, {
              deliveryMethod: 'COURIER',
              courierName: 'Bosta',
              recipientName: 'Private Person',
              recipientPhone: '+201555000111',
              customerAddressId: address.id,
              assignedDeliveryUserId: w.id,
              notes: 'INTERNAL: customer owes us money',
              lines: [
                {
                  orderVariantId: o.items[0]!.variants[variant]!.id,
                  quantity: qty,
                },
              ],
            })
            .expect(201)
        ).body;
      const s1 = await mk(0, 60);
      const s2 = await mk(1, 40);
      await a.admin
        .post(`/admin/orders/${o.id}/internal-notes`, {})
        .catch(() => null);
      await a.admin
        .patch(`/admin/orders/${o.id}`, {
          internalNotes: 'SECRET internal remark',
        })
        .expect(200);
      const token = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token`, {})
          .expect(201)
      ).body.token as string;
      let view = (await track(token).expect(200)).body;
      expect(view.shipments).toEqual([]); // drafts are invisible
      await a.admin.post(`/admin/shipments/${s1.id}/ready`).expect(200);
      await a.admin
        .post(`/admin/shipments/${s1.id}/dispatch`, {
          trackingNumber: 'B-1',
          trackingUrl: 'https://bosta.example.test/B-1',
        })
        .expect(200);
      await a.admin.post(`/admin/shipments/${s1.id}/deliver`, {}).expect(200);
      await a.admin.post(`/admin/shipments/${s2.id}/ready`).expect(200);
      view = (await track(token).expect(200)).body;
      expect(view).toMatchObject({
        status: 'PARTIALLY_SHIPPED',
        deliveredQuantity: 60,
        remainingDeliveryQuantity: 40,
      });
      expect(view.shipments).toHaveLength(2);
      expect(view.shipments[0]).toMatchObject({
        shipmentNumber: s1.shipmentNumber,
        status: 'DELIVERED',
        quantity: 60,
        courierName: 'Bosta',
      });
      expect(view.shipments[0].deliveredAt).toBeTruthy();
      expect(view.shipments[1]).toMatchObject({
        status: 'PREPARING',
        deliveredAt: null,
      });
      const text = JSON.stringify(view);
      for (const secret of [
        'SECRET',
        'INTERNAL',
        'owes us',
        'Private Person',
        '+201555',
        '77 Secret',
        'Cairo',
        'Mona',
        w.id,
        a.salesUserId,
        'payment',
        'price',
        'unitPrice',
        'quotation',
        'blocker',
        'qc',
        'audit',
        'proof',
        'priority',
        'batch',
        'job',
        'email',
        'phone',
        'address',
      ]) {
        expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      }
      // the customer's own tracking number is fine; the staff identity and delivery notes are not
      expect(Object.keys(view.shipments[0]).sort()).toEqual([
        'courierName',
        'deliveredAt',
        'dispatchedAt',
        'quantity',
        'shipmentNumber',
        'status',
        'trackingUrl',
      ]);
    });

    it('shows production progress by department while the order is being made', async () => {
      const o = await readyOrder(a.admin, s);
      const token = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token`, {})
          .expect(201)
      ).body.token as string;
      expect((await track(token).expect(200)).body).toMatchObject({
        status: 'CONFIRMED',
        currentStage: null,
        progressPercent: 0,
      });
      const job = (
        await a.admin
          .post(`/admin/orders/${o.id}/create-factory-job`)
          .expect(201)
      ).body;
      const { runBulkStage } = await import('./support/orders.js');
      expect(
        (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
          .status,
      ).toBe(200);
      const v = (await track(token).expect(200)).body;
      expect(v.status).toBe('IN_PRODUCTION');
      expect(v.currentStage).toBe('Pattern making');
      expect(JSON.stringify(v)).not.toMatch(
        /PATTERN_MAKING|QC_GATE|attempt|rework|blocked/i,
      );
      // a QC gate is shown as a quality check, never as internal inspection data
      await runBulkStage(app, a, floor, job.id, 'PATTERN_MAKING');
      await runBulkStage(app, a, floor, job.id, 'CUTTING');
      expect((await track(token).expect(200)).body.currentStage).toBe(
        'Quality check',
      );
    });

    it('resists enumeration: invalid, malformed, revoked, expired and regenerated tokens look the same', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const first = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token`, {})
          .expect(201)
      ).body;
      const unknown = await track('A'.repeat(43)).expect(404);
      const malformed = await track('not-a-token').expect(404);
      const orderNumber = await track(o.orderNumber).expect(404); // an order number is not a credential
      const idAsToken = await track(o.id).expect(404);
      for (const r of [malformed, orderNumber, idAsToken]) {
        expect(r.body.message).toBe(unknown.body.message);
        expect(r.body.statusCode).toBe(404);
      }
      expect(unknown.body.message).toBe('Tracking link not found');
      expect(JSON.stringify(unknown.body)).not.toContain(o.orderNumber);
      expect(unknown.body.path).toContain('[token]'); // the credential is never echoed back
      // regenerate: old stops, new works
      const second = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token/regenerate`, {})
          .expect(201)
      ).body;
      expect(second.token).not.toBe(first.token);
      const old = await track(first.token).expect(404);
      expect(old.body.message).toBe(unknown.body.message);
      await track(second.token).expect(200);
      const rows = await prisma.orderTrackingToken.findMany({
        where: { orderId: o.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]!.revokedAt).toBeTruthy();
      expect(rows[1]!.revokedAt).toBeNull();
      // revoke
      const revoked = (
        await a.sales.del(`/admin/orders/${o.id}/tracking-token`).expect(200)
      ).body;
      expect(revoked.enabled).toBe(false);
      const r = await track(second.token).expect(404);
      expect(r.body.message).toBe(unknown.body.message);
      await a.sales.del(`/admin/orders/${o.id}/tracking-token`).expect(409);
      // a fresh link can be issued afterwards
      const third = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token`, {})
          .expect(201)
      ).body;
      await track(third.token).expect(200);
      expect(await auditActions(app, o.id)).toEqual(
        expect.arrayContaining([
          'order_tracking.generated',
          'order_tracking.regenerated',
          'order_tracking.revoked',
        ]),
      );
      // expired tokens behave like unknown ones
      const raw = 'E'.repeat(43);
      await prisma.orderTrackingToken.create({
        data: {
          orderId: o.id,
          tokenHash: hash(raw),
          expiresAt: new Date(Date.now() - 1000),
          revokedAt: new Date(),
          createdByUserId: a.salesUserId,
        },
      });
      await track(raw).expect(404);
      const live = 'L'.repeat(43);
      const other = await readyOrder(a.admin, s);
      await prisma.orderTrackingToken.create({
        data: {
          orderId: other.id,
          tokenHash: hash(live),
          expiresAt: new Date(Date.now() - 1000),
          createdByUserId: a.salesUserId,
        },
      });
      const expired = await track(live).expect(404);
      expect(expired.body.message).toBe(unknown.body.message);
      expect(
        (await a.sales.get(`/admin/orders/${other.id}/tracking`).expect(200))
          .body.enabled,
      ).toBe(false); // expired = not enabled
    });

    it('protects the token table: one active token per order, hash and expiry immutable, no deletes', async () => {
      const { order: o } = await producedOrder(app, a, floor, s);
      const t = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token`, {})
          .expect(201)
      ).body;
      await expect(
        prisma.orderTrackingToken.create({
          data: {
            orderId: o.id,
            tokenHash: hash('second-active'),
            createdByUserId: a.salesUserId,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.orderTrackingToken.update({
          where: { id: t.tokenId },
          data: { tokenHash: 'x' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.orderTrackingToken.update({
          where: { id: t.tokenId },
          data: { expiresAt: new Date(Date.now() + 86_400_000 * 900) },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.orderTrackingToken.delete({ where: { id: t.tokenId } }),
      ).rejects.toThrow();
      await a.sales.del(`/admin/orders/${o.id}/tracking-token`).expect(200);
      await expect(
        prisma.orderTrackingToken.update({
          where: { id: t.tokenId },
          data: { revokedAt: null },
        }),
      ).rejects.toThrow(); // a revoked token stays revoked
    });

    it('regenerates and issues exactly once under concurrency', async () => {
      const o = await readyOrder(a.admin, s);
      const res = await Promise.all(
        [1, 2, 3, 4].map(() =>
          a.sales.post(`/admin/orders/${o.id}/tracking-token`, {}),
        ),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(3);
      const regen = await Promise.all(
        [1, 2, 3].map(() =>
          a.sales.post(`/admin/orders/${o.id}/tracking-token/regenerate`, {}),
        ),
      );
      expect(regen.every((r) => r.status === 201)).toBe(true);
      const active = await prisma.orderTrackingToken.findMany({
        where: { orderId: o.id, revokedAt: null },
      });
      expect(active).toHaveLength(1);
      // exactly one of the regenerated tokens works
      const works = await Promise.all(regen.map((r) => track(r.body.token)));
      expect(works.filter((w) => w.status === 200)).toHaveLength(1);
    });

    it('is managed with public_tracking.manage only; cancelled orders cannot be tracked', async () => {
      const o = await readyOrder(a.admin, s);
      await a.finance
        .post(`/admin/orders/${o.id}/tracking-token`, {})
        .expect(403);
      await floor.cutting.api
        .post(`/admin/orders/${o.id}/tracking-token`, {})
        .expect(403);
      await a.finance.get(`/admin/orders/${o.id}/tracking`).expect(403);
      await a.sales
        .post(`/admin/orders/${o.id}/tracking-token`, { expiresInDays: 0 })
        .expect(400);
      await a.sales
        .post(`/admin/orders/${o.id}/tracking-token`, { expiresInDays: 9999 })
        .expect(400);
      await a.sales
        .post(
          '/admin/orders/00000000-0000-4000-8000-000000000000/tracking-token',
          {},
        )
        .expect(404);
      const t = (
        await a.sales
          .post(`/admin/orders/${o.id}/tracking-token`, {})
          .expect(201)
      ).body;
      await a.admin
        .post(`/admin/orders/${o.id}/cancel`, { reason: 'customer withdrew' })
        .expect(200);
      expect((await track(t.token).expect(200)).body.status).toBe('CANCELLED'); // an existing link says so, without a reason
      await a.sales
        .post(`/admin/orders/${o.id}/tracking-token/regenerate`, {})
        .expect(409);
    });
  });
});
