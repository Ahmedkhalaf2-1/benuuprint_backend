import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auditActions,
  createTestApp,
  createUserAndLogin,
} from './support/app.js';
import {
  api,
  completeDraft,
  lookupRefs,
  makeActors,
  toAwaitingPayment,
  type Actors,
  type Flow,
  type Refs,
} from './support/factory.js';

describe('Payments and commercial summary (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
  });
  afterAll(() => app.close());

  const flow = (): Promise<Flow> => toAwaitingPayment(app, a, refs); // accepted, total 1000.00
  const record = (sampleId: string, body: object) =>
    a.sales.post(`/admin/samples/${sampleId}/payments`, {
      amount: 100,
      method: 'INSTAPAY',
      ...body,
    });
  const summary = async (sampleId: string) =>
    (
      await a.admin
        .get(`/admin/samples/${sampleId}/commercial-summary`)
        .expect(200)
    ).body;
  const sample = async (id: string) =>
    (await a.admin.get(`/admin/samples/${id}`)).body;

  it('cannot record a payment before a quotation is accepted', async () => {
    const d = await completeDraft(app, a.admin, refs);
    await record(d.id, {}).expect(409);
    await a.sales.post(`/admin/samples/${d.id}/submit`).expect(200);
    await a.sales.post(`/admin/samples/${d.id}/review`).expect(200);
    await record(d.id, {}).expect(409);
    const q = (
      await a.sales
        .post(`/admin/samples/${d.id}/quotations`, {
          lineItems: [
            {
              type: 'SAMPLE_FEE',
              description: 'Fee',
              quantity: 1,
              unitPrice: 500,
            },
          ],
        })
        .expect(201)
    ).body;
    await a.sales
      .post(`/admin/quotation-versions/${q.currentVersion.id}/send`)
      .expect(200);
    const sent = await record(d.id, {}).expect(409);
    expect(sent.body.message).toMatch(/QUOTED/);
    await a.admin
      .post('/admin/samples/3f2b1c0e-0000-4000-8000-000000000000/payments', {
        amount: 1,
        method: 'CASH',
      })
      .expect(404);
  });

  it('records a PAY-… payment with proof, currency from the quotation and a SUBMITTED status', async () => {
    const f = await flow();
    const proof = (
      await a.sales.upload('PAYMENT_PROOF', 'receipt.png').expect(201)
    ).body;
    const p = (
      await record(f.sample.id, {
        amount: 250.5,
        method: 'VODAFONE_CASH',
        transactionReference: 'VC-20261021-9981',
        proofAssetId: proof.id,
        receivedAt: '2026-10-21T10:00:00.000Z',
      }).expect(201)
    ).body;
    expect(p.paymentNumber).toMatch(/^PAY-\d{6}$/);
    expect(p).toMatchObject({
      amount: '250.50',
      currency: 'EGP',
      method: 'VODAFONE_CASH',
      status: 'SUBMITTED',
      transactionReference: 'VC-20261021-9981',
      quotationVersionId: f.versionId,
    });
    expect(p.proof).toMatchObject({
      assetId: proof.id,
      originalName: 'receipt.png',
    });
    expect(JSON.stringify(p)).not.toMatch(/storageKey|assets\/\d{4}/);
    expect(p.verifiedAt).toBeNull();
    const list = (
      await a.finance.get(`/admin/samples/${f.sample.id}/payments`).expect(200)
    ).body;
    expect(list.map((x: any) => x.id)).toEqual([p.id]);
    expect(
      (await a.finance.get(`/admin/payments/${p.id}`).expect(200)).body.id,
    ).toBe(p.id);
    expect(await auditActions(app, p.id)).toContain('payment.created');
    // proof is private: only through the asset download-url flow
    const link = (
      await a.finance.get(`/admin/assets/${proof.id}/download-url`).expect(200)
    ).body;
    expect(link.url).toMatch(/^\/api\/v1\/storage\/local\//);
  });

  it('rejects invalid amounts, currencies, references and proofs', async () => {
    const f = await flow();
    const id = f.sample.id;
    await record(id, { amount: 0 }).expect(400);
    await record(id, { amount: -5 }).expect(400);
    await record(id, { amount: 10.005 }).expect(400);
    await record(id, { amount: 'ten' }).expect(400);
    await record(id, { method: 'BITCOIN' }).expect(400);
    const over = await record(id, { amount: 1000.01 }).expect(400);
    expect(over.body.message).toMatch(
      /exceeds the remaining balance of 1000\.00/,
    );
    const currency = await record(id, { currency: 'USD' }).expect(400);
    expect(currency.body.message).toMatch(
      /must match the quotation currency \(EGP\)/,
    );
    await record(id, { currency: 'EGP' }).expect(201);
    // never accept something that looks like a card number
    const card = await record(id, {
      transactionReference: '4111 1111 1111 1111',
    }).expect(400);
    expect(card.body.message).toMatch(/card number/);
    await record(id, { transactionReference: 'INSTAPAY-883210' }).expect(201);
    const wrong = (await a.sales.upload('REFERENCE', 'x.png').expect(201)).body;
    expect(
      (await record(id, { proofAssetId: wrong.id }).expect(400)).body.message,
    ).toMatch(/PAYMENT_PROOF/);
    await record(id, {
      proofAssetId: '3f2b1c0e-0000-4000-8000-000000000000',
    }).expect(400);
    const proof = (await a.sales.upload('PAYMENT_PROOF', 'p.png').expect(201))
      .body;
    await record(id, { proofAssetId: proof.id }).expect(201);
    await record(id, { proofAssetId: proof.id }).expect(409); // a proof proves one payment
    await record(id, { id: 'x' }).expect(400);
    await record(id, { status: 'VERIFIED' }).expect(400);
  });

  it('verifies partially then fully, with backend-calculated balance and automatic READY_FOR_PRODUCTION', async () => {
    const f = await flow();
    const id = f.sample.id;
    let s = await summary(id);
    expect(s).toMatchObject({
      currency: 'EGP',
      acceptedTotal: '1000.00',
      quotedTotal: '1000.00',
      verifiedPaid: '0.00',
      pendingPayments: '0.00',
      remaining: '1000.00',
      paymentState: 'UNPAID',
    });
    expect(s.quotation).toMatchObject({
      versionNumber: 1,
      status: 'ACCEPTED',
      total: '1000.00',
    });

    const p1 = (await record(id, { amount: 400 }).expect(201)).body;
    s = await summary(id);
    expect(s).toMatchObject({
      verifiedPaid: '0.00',
      pendingPayments: '400.00',
      remaining: '1000.00',
      paymentState: 'UNPAID',
    }); // pending money is not paid money

    await a.finance.post(`/admin/payments/${p1.id}/review`).expect(200);
    const verified = (
      await a.finance.post(`/admin/payments/${p1.id}/verify`).expect(200)
    ).body;
    expect(verified).toMatchObject({
      status: 'VERIFIED',
      verifiedByUserId: a.financeUserId,
    });
    expect(verified.verifiedAt).not.toBeNull();
    s = await summary(id);
    expect(s).toMatchObject({
      verifiedPaid: '400.00',
      pendingPayments: '0.00',
      remaining: '600.00',
      paymentState: 'PARTIALLY_PAID',
    });
    expect(s.counts).toMatchObject({ verified: 1, pending: 0 });
    let sm = await sample(id);
    expect(sm).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentState: 'PARTIALLY_PAID',
    });

    const p2 = (await record(id, { amount: 600 }).expect(201)).body;
    await record(id, { amount: 600.01 }).expect(400); // more than what is left
    await a.finance.post(`/admin/payments/${p2.id}/verify`).expect(200);
    s = await summary(id);
    expect(s).toMatchObject({
      verifiedPaid: '1000.00',
      remaining: '0.00',
      paymentState: 'PAID',
    });
    sm = await sample(id);
    expect(sm).toMatchObject({
      status: 'READY_FOR_PRODUCTION',
      paymentState: 'PAID',
    });
    const hist = (await a.admin.get(`/admin/samples/${id}/status-history`))
      .body;
    expect(hist.at(-1)).toMatchObject({
      action: 'payment-covered',
      source: 'SYSTEM',
      toStatus: 'READY_FOR_PRODUCTION',
    });
    await record(id, { amount: 1 }).expect(400); // nothing left to pay
    expect(await auditActions(app, p2.id)).toEqual(
      expect.arrayContaining(['payment.created', 'payment.verified']),
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: p2.id, action: 'payment.verified' },
    });
    expect(audit.metadata).toMatchObject({
      amount: '600.00',
      currency: 'EGP',
      paymentState: 'PAID',
      sampleReady: true,
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(
      /transactionReference|proof/i,
    );
  });

  it('uses the payment state filter on the sample list', async () => {
    const f = await flow();
    await record(f.sample.id, { amount: 100 }).then(async (r) =>
      a.finance.post(`/admin/payments/${r.body.id}/verify`).expect(200),
    );
    const q = async (state: string) =>
      (
        await a.admin
          .get(
            `/admin/samples?customerId=${f.sample.customerId}&paymentState=${state}`,
          )
          .expect(200)
      ).body.data.map((x: any) => x.id);
    expect(await q('PARTIALLY_PAID')).toEqual([f.sample.id]);
    expect(await q('PAID')).toEqual([]);
    expect(await q('UNPAID')).toEqual([]);
  });

  it('separates recording from verifying: the recorder cannot verify, sales cannot verify, finance can', async () => {
    const f = await flow();
    const p = (await record(f.sample.id, { amount: 200 }).expect(201)).body;
    const self = await a.sales
      .post(`/admin/payments/${p.id}/verify`)
      .expect(403);
    expect(self.body.statusCode).toBe(403);
    await a.sewing.post(`/admin/payments/${p.id}/verify`).expect(403);
    const adminRole = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
    await api(app, adminRole.accessToken)
      .post(`/admin/payments/${p.id}/verify`)
      .expect(403); // the ADMIN role lacks payments.verify by design
    // finance recorded it: finance cannot self-verify, but admin-created records can be verified by finance
    const byFinance = (
      await a.finance
        .post(`/admin/samples/${f.sample.id}/payments`, {
          amount: 100,
          method: 'CASH',
        })
        .expect(201)
    ).body;
    expect(
      (
        await a.finance
          .post(`/admin/payments/${byFinance.id}/verify`)
          .expect(403)
      ).body.message,
    ).toMatch(/recorded/);
    await a.finance.post(`/admin/payments/${p.id}/verify`).expect(200);
  });

  it('never lets two concurrent verifications overshoot the quotation total', async () => {
    const f = await flow();
    const p1 = (await record(f.sample.id, { amount: 600 }).expect(201)).body;
    const p2 = (await record(f.sample.id, { amount: 600 }).expect(201)).body; // each fits on its own
    const results = await Promise.all([
      a.finance.post(`/admin/payments/${p1.id}/verify`),
      a.finance.post(`/admin/payments/${p2.id}/verify`),
    ]);
    expect(
      results
        .map((r) => r.status)
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.message).toMatch(/exceed the quotation total/);
    expect((await summary(f.sample.id)).verifiedPaid).toBe('600.00');
    const same = await Promise.all([
      a.finance.post(`/admin/payments/${p1.id}/verify`),
      a.finance.post(`/admin/payments/${p1.id}/verify`),
    ]);
    expect(same.every((r) => r.status === 409)).toBe(true); // already verified / duplicate
  });

  it('rejects with a reason, cancels, and makes decided payments final (API and database)', async () => {
    const f = await flow();
    const p = (await record(f.sample.id, { amount: 300 }).expect(201)).body;
    await a.finance.post(`/admin/payments/${p.id}/reject`, {}).expect(400);
    const rejected = (
      await a.finance
        .post(`/admin/payments/${p.id}/reject`, {
          reason: 'Amount does not match the receipt',
        })
        .expect(200)
    ).body;
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Amount does not match the receipt',
    });
    await a.finance.post(`/admin/payments/${p.id}/verify`).expect(409);
    await a.sales.post(`/admin/payments/${p.id}/cancel`).expect(409);
    await a.sales.patch(`/admin/payments/${p.id}`, { amount: 1 }).expect(409);
    await expect(
      prisma.payment.update({ where: { id: p.id }, data: { amount: 1 } }),
    ).rejects.toThrow();
    await expect(
      prisma.payment.update({
        where: { id: p.id },
        data: {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedByUserId: a.financeUserId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.payment.delete({ where: { id: p.id } }),
    ).rejects.toThrow();
    expect((await summary(f.sample.id)).verifiedPaid).toBe('0.00'); // a rejected payment never counts
    expect((await summary(f.sample.id)).counts.rejected).toBe(1);

    const c = (await record(f.sample.id, { amount: 50 }).expect(201)).body;
    expect(
      (await a.sales.post(`/admin/payments/${c.id}/cancel`).expect(200)).body
        .status,
    ).toBe('CANCELLED');
    await a.finance.post(`/admin/payments/${c.id}/verify`).expect(409);
    expect(await auditActions(app, p.id)).toContain('payment.rejected');
    expect(await auditActions(app, c.id)).toContain('payment.cancelled');
  });

  it('lets a SUBMITTED payment be corrected, with the same balance rules', async () => {
    const f = await flow();
    const p = (await record(f.sample.id, { amount: 100 }).expect(201)).body;
    const upd = await a.sales
      .patch(`/admin/payments/${p.id}`, {
        amount: 150,
        method: 'BANK_TRANSFER',
        transactionReference: 'BT-1',
      })
      .expect(200);
    expect(upd.body).toMatchObject({
      amount: '150.00',
      method: 'BANK_TRANSFER',
      transactionReference: 'BT-1',
    });
    await a.sales
      .patch(`/admin/payments/${p.id}`, { amount: 5000 })
      .expect(400);
    await a.sales
      .patch(`/admin/payments/${p.id}`, {
        transactionReference: '5555555555554444',
      })
      .expect(400);
    await a.sales
      .patch(`/admin/payments/${p.id}`, { status: 'VERIFIED' })
      .expect(400);
    const cleared = await a.sales
      .patch(`/admin/payments/${p.id}`, { transactionReference: null })
      .expect(200);
    expect(cleared.body.transactionReference).toBeNull();
    expect(await auditActions(app, p.id)).toContain('payment.updated');
  });

  it('keeps payment permissions tight', async () => {
    const f = await flow();
    const p = (await record(f.sample.id, { amount: 10 }).expect(201)).body;
    await api(app, '').get(`/admin/payments/${p.id}`).expect(401);
    await a.sewing.get(`/admin/payments/${p.id}`).expect(403);
    await a.sewing.get(`/admin/samples/${f.sample.id}/payments`).expect(403);
    await a.sewing
      .post(`/admin/samples/${f.sample.id}/payments`, {
        amount: 1,
        method: 'CASH',
      })
      .expect(403);
    await a.sewing
      .get(`/admin/samples/${f.sample.id}/commercial-summary`)
      .expect(403);
    await a.finance
      .get(`/admin/samples/${f.sample.id}/commercial-summary`)
      .expect(200);
    await a.sales
      .get(`/admin/samples/${f.sample.id}/commercial-summary`)
      .expect(200);
  });

  it('refuses payments for cancelled or rejected samples and archives of paid-for assets', async () => {
    const f = await flow();
    await a.sales
      .post(`/admin/samples/${f.sample.id}/cancel`, {
        reason: 'Customer cancelled',
      })
      .expect(200);
    await record(f.sample.id, {}).expect(409);
    const g = await flow();
    const proof = (
      await a.sales.upload('PAYMENT_PROOF', 'keep.png').expect(201)
    ).body;
    await record(g.sample.id, { proofAssetId: proof.id }).expect(201);
    expect(
      (await a.admin.del(`/admin/assets/${proof.id}`).expect(409)).body.message,
    ).toMatch(/payment proof/);
  });

  it('records the verified amount already paid when a sample is cancelled', async () => {
    const f = await flow();
    const p = (await record(f.sample.id, { amount: 250 }).expect(201)).body;
    await a.finance.post(`/admin/payments/${p.id}/verify`).expect(200);
    await a.sales
      .post(`/admin/samples/${f.sample.id}/cancel`, {
        reason: 'Customer cancelled after paying a deposit',
      })
      .expect(200);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: f.sample.id, action: 'sample.status_changed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry.metadata).toMatchObject({
      action: 'cancel',
      verifiedPaid: '250.00',
    });
  });
});
