import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { createTestApp, uniq } from './support/app.js';
import { drain, notificationsFor } from './support/automation.js';
import {
  PAY_PNG,
  cPay,
  cProof,
  makePortalCustomer,
  submitPortalSample,
  type PortalCustomer,
} from './support/customer.js';
import {
  LINES,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';
import {
  STAGE_ORDER,
  createJob,
  makeFloor,
  runStage,
  type Floor,
} from './support/floor.js';

describe('Customer commercial and sample approval (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let alice: PortalCustomer;
  let bob: PortalCustomer;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    alice = await makePortalCustomer(app, a.admin);
    bob = await makePortalCustomer(app, a.admin);
  });
  afterAll(() => app.close());

  /** The customer's submitted request, reviewed, with a quotation CREATED (not yet sent). */
  const underReview = async (c: PortalCustomer = alice) => {
    const sampleId = await submitPortalSample(c, refs);
    await a.sales.post(`/admin/samples/${sampleId}/review`).expect(200);
    return sampleId;
  };
  const draftQuotation = async (sampleId: string, body: object = {}) => {
    const q = (
      await a.sales
        .post(`/admin/samples/${sampleId}/quotations`, {
          lineItems: LINES,
          customerNotes: 'Valid for the quoted lead time',
          notes: 'INTERNAL-MARGIN-NOTE keep 40%',
          ...body,
        })
        .expect(201)
    ).body;
    return {
      quotationId: q.id as string,
      versionId: q.currentVersion.id as string,
    };
  };
  const send = (versionId: string) =>
    a.sales.post(`/admin/quotation-versions/${versionId}/send`).expect(200);
  /** Reviewed, quoted and sent: the customer can decide. */
  const quoted = async (c: PortalCustomer = alice) => {
    const sampleId = await underReview(c);
    const q = await draftQuotation(sampleId);
    await send(q.versionId);
    return { sampleId, ...q };
  };
  /** Quotation accepted by the customer: AWAITING_PAYMENT (total 1000.00). */
  const awaitingPayment = async (c: PortalCustomer = alice) => {
    const q = await quoted(c);
    await c.api
      .post(`/customer/quotation-versions/${q.versionId}/accept`)
      .expect(200);
    return q;
  };
  const verify = (paymentId: string) =>
    a.finance.post(`/admin/payments/${paymentId}/verify`).expect(200);
  /** Paid in full by the customer, verified by finance: READY_FOR_PRODUCTION. */
  const paid = async (c: PortalCustomer = alice) => {
    const q = await awaitingPayment(c);
    const pay = (
      await cPay(app, c.accessToken, q.sampleId, {
        amount: '1000',
        method: 'INSTAPAY',
      }).expect(201)
    ).body;
    await verify(pay.id);
    return { ...q, paymentId: pay.id as string };
  };
  const detail = async (c: PortalCustomer, id: string) =>
    (await c.api.get(`/customer/samples/${id}`).expect(200)).body;

  // ─────────────────────────────── quotation ───────────────────────────────

  describe('quotation', () => {
    it('shows only what was sent, with customer-safe fields', async () => {
      const sampleId = await underReview();
      const q = await draftQuotation(sampleId);
      // a draft the customer was never sent does not exist for them
      let view = (
        await alice.api
          .get(`/customer/samples/${sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view).toMatchObject({
        quotations: [],
        actionableVersionId: null,
        requiresReview: false,
      });
      await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/accept`)
        .expect(409);

      await send(q.versionId);
      view = (
        await alice.api
          .get(`/customer/samples/${sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view.actionableVersionId).toBe(q.versionId);
      expect(view.requiresReview).toBe(false);
      const version = view.quotations[0].versions[0];
      expect(version).toMatchObject({
        status: 'SENT',
        actionable: true,
        isCurrent: true,
        currency: 'EGP',
        total: '1000.00',
        notes: 'Valid for the quoted lead time',
      });
      expect(version.lineItems).toHaveLength(2);
      expect(Object.keys(version.lineItems[0]).sort()).toEqual([
        'amount',
        'description',
        'quantity',
        'type',
        'unitPrice',
      ]);
      const json = JSON.stringify(view);
      for (const leak of [
        'INTERNAL-MARGIN-NOTE',
        'createdByUserId',
        'metadata',
        'decidedBy',
        'invalidat',
        'orderRevision',
      ])
        expect(json).not.toContain(leak);

      // the summary and the allowed actions follow the same truth
      const summary = (
        await alice.api
          .get(`/customer/samples/${sampleId}/commercial`)
          .expect(200)
      ).body;
      expect(summary).toMatchObject({
        nextAction: 'REVIEW_QUOTATION',
        allowedActions: ['ACCEPT_QUOTATION', 'REJECT_QUOTATION'],
        quotation: { versionId: q.versionId, total: '1000.00' },
        payment: { status: 'NOT_REQUIRED_YET' },
      });
      const d = await detail(alice, sampleId);
      expect(d).toMatchObject({
        status: 'QUOTATION_READY',
        nextStep: 'Review your quotation.',
        allowedActions: ['ACCEPT_QUOTATION', 'REJECT_QUOTATION'],
      });
    });

    it('accepts a quotation as an authenticated customer and moves it to payment', async () => {
      const q = await quoted();
      const res = await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/accept`)
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'PAYMENT_REQUIRED',
        nextStep: 'Payment is required.',
        allowedActions: ['UPLOAD_PAYMENT_PROOF'],
      });

      const approval = await prisma.approval.findFirstOrThrow({
        where: { quotationVersionId: q.versionId },
      });
      expect(approval).toMatchObject({
        type: 'QUOTATION',
        status: 'APPROVED',
        mode: 'CUSTOMER_AUTHENTICATED',
        respondedByCustomerId: alice.customerId,
        respondedByUserId: null,
        requestedByCustomerId: alice.customerId,
        requestedByUserId: null,
        sourceNote: null,
      });
      expect(
        (
          await prisma.auditLog.findMany({
            where: { actorCustomerId: alice.customerId },
            select: { action: true, actorUserId: true },
          })
        ).filter((r) =>
          ['quotation_version.accepted', 'approval.approved'].includes(
            r.action,
          ),
        ),
      ).toHaveLength(2);
      // the staff side sees the same fact, flagged as the customer's own decision
      const staffApprovals = (
        await a.admin.get(`/admin/samples/${q.sampleId}/approvals`).expect(200)
      ).body;
      expect(staffApprovals[0]).toMatchObject({
        mode: 'CUSTOMER_AUTHENTICATED',
        staffRecorded: false,
        respondedByCustomerId: alice.customerId,
      });
      const sample = (
        await a.admin.get(`/admin/samples/${q.sampleId}`).expect(200)
      ).body;
      expect(sample.status).toBe('AWAITING_PAYMENT');
      // history shows the customer, not a staff member
      const history = (
        await a.admin
          .get(`/admin/samples/${q.sampleId}/status-history`)
          .expect(200)
      ).body;
      expect(history.at(-1)).toMatchObject({
        action: 'quote-accepted',
        actorCustomerId: alice.customerId,
        source: 'CUSTOMER',
      });
      // a decided quotation cannot be decided again
      await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/accept`)
        .expect(409);
      await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/reject`, {})
        .expect(409);
    });

    it('rejects a quotation, keeps the history and shows a new offer as needing review', async () => {
      const q = await quoted();
      const res = await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/reject`, {
          reason: 'Too expensive for the first run',
        })
        .expect(200);
      expect(res.body.status).toBe('UNDER_REVIEW');
      const approval = await prisma.approval.findFirstOrThrow({
        where: { quotationVersionId: q.versionId },
      });
      expect(approval).toMatchObject({
        status: 'REJECTED',
        mode: 'CUSTOMER_AUTHENTICATED',
        responseNote: 'Too expensive for the first run',
      });
      // nothing was deleted
      expect(
        await prisma.quotationVersion.findUniqueOrThrow({
          where: { id: q.versionId },
        }),
      ).toMatchObject({ status: 'REJECTED' });

      // staff offer again: the customer sees the old one as history and is asked to review the new one
      const again = await draftQuotation(q.sampleId, {
        lineItems: [
          {
            type: 'SAMPLE_FEE',
            description: 'Sample fee',
            quantity: 1,
            unitPrice: 700,
          },
        ],
      });
      await send(again.versionId);
      const view = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view.quotations).toHaveLength(2);
      expect(view.quotations[0].versions[0].status).toBe('REJECTED');
      expect(view).toMatchObject({
        actionableVersionId: again.versionId,
        requiresReview: true,
        notice: 'A new quotation requires your review.',
      });
    });

    it('only lets the customer act on the latest open version', async () => {
      const sampleId = await underReview();
      const q = await draftQuotation(sampleId);
      await send(q.versionId);
      // staff revise the offer: v1 is superseded at once, v2 is a draft the customer cannot see yet
      const v2 = (
        await a.sales
          .post(`/admin/quotations/${q.quotationId}/versions`, {
            lineItems: [
              {
                type: 'SAMPLE_FEE',
                description: 'Sample fee',
                quantity: 1,
                unitPrice: 900,
              },
            ],
          })
          .expect(201)
      ).body;
      let view = (
        await alice.api
          .get(`/customer/samples/${sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view.actionableVersionId).toBeNull();
      expect(view.quotations[0].versions).toHaveLength(1);
      expect(view.quotations[0].versions[0]).toMatchObject({
        status: 'SUPERSEDED',
        actionable: false,
      });
      await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/accept`)
        .expect(409);
      await alice.api
        .post(`/customer/quotation-versions/${v2.id}/accept`)
        .expect(409); // still a draft

      await send(v2.id);
      view = (
        await alice.api
          .get(`/customer/samples/${sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view).toMatchObject({
        actionableVersionId: v2.id,
        requiresReview: true,
        notice: 'A new quotation requires your review.',
      });
      expect(
        view.quotations[0].versions.map((v: { status: string }) => v.status),
      ).toEqual(['SUPERSEDED', 'SENT']);
      await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/accept`)
        .expect(409);
      await alice.api
        .post(`/customer/quotation-versions/${v2.id}/accept`)
        .expect(200);
      expect((await detail(alice, sampleId)).status).toBe('PAYMENT_REQUIRED');
    });

    it('refuses an expired offer', async () => {
      const sampleId = await underReview();
      const q = await draftQuotation(sampleId, {
        validUntil: new Date(Date.now() + 1500).toISOString(),
      });
      await send(q.versionId);
      let view = (
        await alice.api
          .get(`/customer/samples/${sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view.actionableVersionId).toBe(q.versionId);
      await new Promise((r) => setTimeout(r, 1800));
      view = (
        await alice.api
          .get(`/customer/samples/${sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view.actionableVersionId).toBeNull();
      await alice.api
        .post(`/customer/quotation-versions/${q.versionId}/accept`)
        .expect(409);
    });

    it('hides everything from another customer', async () => {
      const q = await quoted();
      await bob.api
        .get(`/customer/samples/${q.sampleId}/quotation`)
        .expect(404);
      await bob.api
        .get(`/customer/samples/${q.sampleId}/commercial`)
        .expect(404);
      await bob.api
        .post(`/customer/quotation-versions/${q.versionId}/accept`)
        .expect(404);
      await bob.api
        .post(`/customer/quotation-versions/${q.versionId}/reject`, {})
        .expect(404);
      // the staff token is not a customer either
      await http()
        .post(`/api/v1/customer/quotation-versions/${q.versionId}/accept`)
        .set({ Authorization: `Bearer ${a.adminToken}` })
        .expect(401);
      expect(
        (
          await prisma.quotationVersion.findUniqueOrThrow({
            where: { id: q.versionId },
          })
        ).status,
      ).toBe('SENT');
    });
  });

  // ─────────────────────────────── payments ───────────────────────────────

  describe('payments', () => {
    it('submits a payment with proof that staff verify; customers never can', async () => {
      const q = await awaitingPayment();
      let pay = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(pay.summary).toMatchObject({
        status: 'PAYMENT_REQUIRED',
        currency: 'EGP',
        requiredAmount: '1000.00',
        verifiedAmount: '0.00',
        pendingAmount: '0.00',
        remainingAmount: '1000.00',
      });

      // proof rules
      await cPay(
        app,
        alice.accessToken,
        q.sampleId,
        { amount: '400', method: 'INSTAPAY' },
        null,
      ).expect(400);
      await cPay(
        app,
        alice.accessToken,
        q.sampleId,
        { amount: '400', method: 'INSTAPAY' },
        Buffer.from('not an image'),
      ).expect(415);
      await cPay(app, alice.accessToken, q.sampleId, {
        amount: '1500',
        method: 'INSTAPAY',
      }).expect(400); // more than owed
      await cPay(app, alice.accessToken, q.sampleId, {
        amount: '0',
        method: 'INSTAPAY',
      }).expect(400);
      await cPay(app, alice.accessToken, q.sampleId, {
        amount: '100',
        method: 'CRYPTO',
      }).expect(400);
      await cPay(app, alice.accessToken, q.sampleId, {
        amount: '100',
        method: 'INSTAPAY',
        transactionReference: '4111 1111 1111 1111',
      }).expect(400); // looks like a card number
      expect(
        await prisma.payment.count({ where: { sampleId: q.sampleId } }),
      ).toBe(0);

      const first = (
        await cPay(app, alice.accessToken, q.sampleId, {
          amount: '400',
          method: 'INSTAPAY',
          transactionReference: 'TX-123',
        }).expect(201)
      ).body;
      expect(first).toMatchObject({
        amount: '400.00',
        currency: 'EGP',
        status: 'PENDING_VERIFICATION',
        hasProof: true,
        proofFileName: 'receipt.png',
        canReplaceProof: true,
      });
      expect(JSON.stringify(first)).not.toMatch(
        /verifiedBy|createdBy|rejectionReason|storage/i,
      );

      // the same row staff see in their payment queue, flagged as customer-submitted
      const staff = (
        await a.finance.get(`/admin/samples/${q.sampleId}/payments`).expect(200)
      ).body;
      expect(staff).toHaveLength(1);
      expect(staff[0]).toMatchObject({
        id: first.id,
        status: 'SUBMITTED',
        createdByCustomerId: alice.customerId,
        createdByUserId: null,
      });
      expect(staff[0].proof.assetId).toBeTruthy();

      let d = await detail(alice, q.sampleId);
      expect(d).toMatchObject({
        status: 'PAYMENT_UNDER_REVIEW',
        nextStep: 'Your payment proof is being reviewed.',
      });
      pay = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(pay.summary).toMatchObject({
        status: 'PAYMENT_UNDER_REVIEW',
        pendingAmount: '400.00',
        verifiedAmount: '0.00',
        remainingAmount: '1000.00',
      });
      const filtered = (
        await alice.api
          .get('/customer/samples?status=PAYMENT_UNDER_REVIEW')
          .expect(200)
      ).body;
      expect(filtered.data.map((s: { id: string }) => s.id)).toContain(
        q.sampleId,
      );
      const required = (
        await alice.api
          .get('/customer/samples?status=PAYMENT_REQUIRED')
          .expect(200)
      ).body;
      expect(required.data.map((s: { id: string }) => s.id)).not.toContain(
        q.sampleId,
      );

      // there is no way for a customer to verify, review, reject or cancel
      for (const action of ['verify', 'review', 'reject', 'cancel'])
        await alice.api
          .post(`/customer/payments/${first.id}/${action}`, {})
          .expect(404);
      await http()
        .post(`/api/v1/admin/payments/${first.id}/verify`)
        .set({ Authorization: `Bearer ${alice.accessToken}` })
        .expect(401);

      // finance verifies; the customer sees the verified state and a smaller balance
      await verify(first.id);
      pay = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(pay.payments[0]).toMatchObject({
        status: 'VERIFIED',
        canReplaceProof: false,
      });
      expect(pay.summary).toMatchObject({
        status: 'PAYMENT_REQUIRED',
        verifiedAmount: '400.00',
        remainingAmount: '600.00',
      });
      d = await detail(alice, q.sampleId);
      expect(d.status).toBe('PAYMENT_REQUIRED');

      // the rest completes it: the backend's own gate moves the sample to production
      const second = (
        await cPay(app, alice.accessToken, q.sampleId, {
          amount: '600',
          method: 'BANK_TRANSFER',
        }).expect(201)
      ).body;
      await verify(second.id);
      d = await detail(alice, q.sampleId);
      expect(d).toMatchObject({
        status: 'IN_SAMPLE_PRODUCTION',
        nextStep: 'Your sample is being produced.',
        allowedActions: [],
      });
      expect(
        (await a.admin.get(`/admin/samples/${q.sampleId}`).expect(200)).body
          .status,
      ).toBe('READY_FOR_PRODUCTION');
      pay = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(pay.summary).toMatchObject({
        status: 'PAID',
        remainingAmount: '0.00',
      });
      // nothing left to pay
      await cPay(app, alice.accessToken, q.sampleId, {
        amount: '1',
        method: 'CASH',
      }).expect(400);
    });

    it('shows a rejection only through the message staff wrote for the customer, and notifies them', async () => {
      const q = await awaitingPayment();
      const pay = (
        await cPay(app, alice.accessToken, q.sampleId, {
          amount: '300',
          method: 'TELDA',
        }).expect(201)
      ).body;
      await a.finance
        .post(`/admin/payments/${pay.id}/reject`, {
          reason: 'INTERNAL fraud suspicion on this sender',
          customerMessage:
            'The receipt is blurry, please upload a clearer photo.',
        })
        .expect(200);
      const view = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(view.payments[0]).toMatchObject({
        status: 'REJECTED',
        message: 'The receipt is blurry, please upload a clearer photo.',
      });
      expect(JSON.stringify(view)).not.toContain('fraud');
      expect(view.summary.status).toBe('PAYMENT_REQUIRED');
      const activity = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/activity`)
          .expect(200)
      ).body;
      expect(JSON.stringify(activity)).not.toContain('fraud');
      expect(activity.map((e: { title: string }) => e.title)).toEqual(
        expect.arrayContaining([
          'Quotation accepted',
          'Payment proof submitted',
          'Payment could not be verified',
        ]),
      );

      await drain(app);
      const notes = await notificationsFor(app, pay.id);
      const forCustomer = notes.filter(
        (n) => n.customerId === alice.customerId,
      );
      expect(forCustomer.length).toBeGreaterThan(0);
      expect(forCustomer[0]).toMatchObject({
        templateCode: 'PAYMENT_REJECTED',
      });
      expect(forCustomer[0]!.body).toContain('receipt is blurry');
      expect(forCustomer.map((n) => n.body).join(' ')).not.toContain('fraud');

      // a payment rejected without a customer message shows none
      const bare = (
        await cPay(app, alice.accessToken, q.sampleId, {
          amount: '300',
          method: 'TELDA',
        }).expect(201)
      ).body;
      await a.finance
        .post(`/admin/payments/${bare.id}/reject`, {
          reason: 'INTERNAL: duplicate',
        })
        .expect(200);
      const again = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(
        again.payments.find((p: { id: string }) => p.id === bare.id).message,
      ).toBeNull();
    });

    it('replaces the proof only while the payment is untouched and only for its owner', async () => {
      const q = await awaitingPayment();
      const pay = (
        await cPay(app, alice.accessToken, q.sampleId, {
          amount: '200',
          method: 'INSTAPAY',
        }).expect(201)
      ).body;
      const before = await prisma.payment.findUniqueOrThrow({
        where: { id: pay.id },
      });
      const swapped = (await cProof(app, alice.accessToken, pay.id).expect(200))
        .body;
      expect(swapped.proofFileName).toBe('receipt2.png');
      const after = await prisma.payment.findUniqueOrThrow({
        where: { id: pay.id },
      });
      expect(after.proofAssetId).not.toBe(before.proofAssetId);
      await cProof(
        app,
        alice.accessToken,
        pay.id,
        Buffer.from('plain text'),
      ).expect(415);

      const dl = (
        await alice.api
          .get(`/customer/payments/${pay.id}/proof/download-url`)
          .expect(200)
      ).body;
      const bytes = await http().get(dl.url).expect(200);
      expect(Buffer.from(bytes.body).equals(PAY_PNG)).toBe(true);

      // another customer: nothing
      await cProof(app, bob.accessToken, pay.id).expect(404);
      await bob.api
        .get(`/customer/payments/${pay.id}/proof/download-url`)
        .expect(404);
      await bob.api.get(`/customer/samples/${q.sampleId}/payments`).expect(404);
      await cPay(app, bob.accessToken, q.sampleId, {
        amount: '50',
        method: 'CASH',
      }).expect(404);

      // once finance picks it up the customer can no longer change it
      await a.finance.post(`/admin/payments/${pay.id}/review`).expect(200);
      await cProof(app, alice.accessToken, pay.id).expect(409);
      const view = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(view.payments[0].canReplaceProof).toBe(false);
    });

    it('does not let a customer pay before a quotation is accepted or touch staff-recorded payments', async () => {
      const q = await quoted();
      await cPay(app, alice.accessToken, q.sampleId, {
        amount: '100',
        method: 'CASH',
      }).expect(409);
      const q2 = await awaitingPayment();
      // a payment staff recorded on the customer's behalf is visible but not theirs to modify
      const proof = (
        await a.sales.upload('PAYMENT_PROOF', 'staff-receipt.png').expect(201)
      ).body;
      const staffPayment = (
        await a.sales
          .post(`/admin/samples/${q2.sampleId}/payments`, {
            amount: 100,
            method: 'CASH',
            proofAssetId: proof.id,
          })
          .expect(201)
      ).body;
      const view = (
        await alice.api
          .get(`/customer/samples/${q2.sampleId}/payments`)
          .expect(200)
      ).body;
      expect(view.payments[0]).toMatchObject({
        id: staffPayment.id,
        canReplaceProof: false,
      });
      await cProof(app, alice.accessToken, staffPayment.id).expect(404);
      await alice.api
        .get(`/customer/payments/${staffPayment.id}/proof/download-url`)
        .expect(404);
    });
  });

  // ─────────────────────── customer-visible staff files ───────────────────────

  describe('files shared by staff', () => {
    it('shows only files staff explicitly exposed, with signed downloads', async () => {
      const sampleId = await underReview();
      const hidden = (
        await a.sales.upload('MOCKUP', 'internal.png').expect(201)
      ).body;
      await a.sales
        .post(`/admin/assets/${hidden.id}/attachments`, {
          targetType: 'SAMPLE',
          targetId: sampleId,
        })
        .expect(409); // staff attach is DRAFT-only: shared files use the explicit route below
      const mock = (await a.sales.upload('MOCKUP', 'mockup.png').expect(201))
        .body;
      const shared = (
        await a.sales
          .post(`/admin/samples/${sampleId}/assets/share`, { assetId: mock.id })
          .expect(201)
      ).body;
      expect(shared).toMatchObject({ customerVisible: true, type: 'MOCKUP' });

      const files = (
        await alice.api.get(`/customer/samples/${sampleId}/files`).expect(200)
      ).body;
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        source: 'BENUE_PRINT',
        attachmentId: shared.attachmentId,
        originalName: 'mockup.png',
        description: null,
      });
      expect(JSON.stringify(files)).not.toMatch(/storage|checksum|uploadedBy/i);
      expect((await detail(alice, sampleId)).files).toHaveLength(1);

      const dl = (
        await alice.api
          .get(
            `/customer/samples/${sampleId}/files/${shared.attachmentId}/download-url`,
          )
          .expect(200)
      ).body;
      const bytes = await http().get(dl.url).expect(200);
      expect(Buffer.from(bytes.body).equals(PAY_PNG)).toBe(true);

      // not removable by the customer, not visible to anyone else
      await alice.api
        .del(`/customer/samples/${sampleId}/files/${shared.attachmentId}`)
        .expect(409); // locked once submitted; in a draft it would be a 404 (not the customer's file)
      await bob.api
        .get(
          `/customer/samples/${sampleId}/files/${shared.attachmentId}/download-url`,
        )
        .expect(404);
      await bob.api.get(`/customer/samples/${sampleId}/files`).expect(404);

      // staff can hide it again; it was never listed as staff-only before they shared it
      const staffList = (
        await a.sales.get(`/admin/samples/${sampleId}/assets`).expect(200)
      ).body;
      expect(
        staffList.find(
          (f: { attachmentId: string }) =>
            f.attachmentId === shared.attachmentId,
        ).customerVisible,
      ).toBe(true);
      await a.sales
        .patch(
          `/admin/samples/${sampleId}/assets/${shared.attachmentId}/customer-visibility`,
          {
            customerVisible: false,
          },
        )
        .expect(200);
      expect(
        (await alice.api.get(`/customer/samples/${sampleId}/files`).expect(200))
          .body,
      ).toHaveLength(0);
      await alice.api
        .get(
          `/customer/samples/${sampleId}/files/${shared.attachmentId}/download-url`,
        )
        .expect(404);
      await a.sales
        .patch(
          `/admin/samples/${sampleId}/assets/${shared.attachmentId}/customer-visibility`,
          {
            customerVisible: true,
          },
        )
        .expect(200);
      expect(
        (await alice.api.get(`/customer/samples/${sampleId}/files`).expect(200))
          .body,
      ).toHaveLength(1);
      // sharing needs the sample permission, and only sample-attachable types can be shared
      await a.sewing
        .post(`/admin/samples/${sampleId}/assets/share`, { assetId: mock.id })
        .expect(403);
      const proofAsset = (
        await a.sales.upload('PAYMENT_PROOF', 'p.png').expect(201)
      ).body;
      await a.sales
        .post(`/admin/samples/${sampleId}/assets/share`, {
          assetId: proofAsset.id,
        })
        .expect(400);
      expect(hidden.id).not.toBe(mock.id);
    });
  });

  // ─────────────────────── production and sample approval ───────────────────────

  describe('production projection and approval', () => {
    it('follows a real sample production job in coarse steps and then lets the customer approve', async () => {
      const q = await paid();
      expect(
        (
          await alice.api
            .get(`/customer/samples/${q.sampleId}/production`)
            .expect(200)
        ).body.phase,
      ).toBe('NOT_STARTED');
      // approving before the sample exists is refused
      await alice.api
        .post(`/customer/samples/${q.sampleId}/approve`, {})
        .expect(409);
      await alice.api
        .post(`/customer/samples/${q.sampleId}/request-changes`, {
          reason: 'too early',
        })
        .expect(409);

      const job = await createJob(a.admin, q.sampleId, {});
      await runStage(app, a.admin, floor, job.id, 'FABRIC_PREPARATION');
      const mid = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/production`)
          .expect(200)
      ).body;
      expect(mid.phase).toBe('IN_PROGRESS');
      expect(mid.steps.map((s: { code: string }) => s.code)).toEqual([
        'PREPARING_MATERIALS',
        'PATTERN_AND_CUTTING',
        'DECORATION',
        'SEWING',
        'QUALITY_CHECK',
        'SAMPLE_READY',
      ]);
      expect(mid.steps[0].state).toBe('DONE');
      const json = JSON.stringify(mid);
      for (const leak of [
        'FABRIC_PREPARATION',
        'QC_GATE',
        job.jobNumber,
        floor.fabric.id,
        'blocker',
        'rework',
      ])
        expect(json).not.toContain(leak);
      expect(await detail(alice, q.sampleId)).toMatchObject({
        status: 'IN_SAMPLE_PRODUCTION',
        allowedActions: [],
      });

      for (const code of STAGE_ORDER.slice(1))
        await runStage(app, a.admin, floor, job.id, code);

      const done = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/production`)
          .expect(200)
      ).body;
      expect(done.phase).toBe('COMPLETE');
      expect(
        done.steps.every((s: { state: string }) => s.state === 'DONE'),
      ).toBe(true);
      const ready = await detail(alice, q.sampleId);
      expect(ready).toMatchObject({
        status: 'AWAITING_CUSTOMER_APPROVAL',
        nextStep: 'Review your completed sample.',
        allowedActions: ['APPROVE_SAMPLE', 'REQUEST_CHANGES'],
      });

      // another customer cannot touch it
      await bob.api
        .post(`/customer/samples/${q.sampleId}/approve`, {})
        .expect(404);
      await bob.api
        .post(`/customer/samples/${q.sampleId}/request-changes`, {
          reason: 'nope nope',
        })
        .expect(404);
      await bob.api
        .get(`/customer/samples/${q.sampleId}/production`)
        .expect(404);

      const approved = (
        await alice.api
          .post(`/customer/samples/${q.sampleId}/approve`, {
            note: 'Looks perfect',
          })
          .expect(200)
      ).body;
      expect(approved).toMatchObject({
        status: 'APPROVED',
        nextStep:
          'Your sample is approved and can be used for bulk production.',
        allowedActions: [],
      });
      // the existing approval flow produced the frozen reference, by the customer
      const spec = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { sampleId: q.sampleId, kind: 'APPROVED_REFERENCE' },
      });
      expect(spec.createdByUserId).toBeNull();
      expect(spec.sourceFactoryJobId).toBe(job.id);
      const snapshot = spec.snapshot as { approval: Record<string, unknown> };
      expect(snapshot.approval).toMatchObject({
        mode: 'CUSTOMER_AUTHENTICATED',
        approvedByCustomerId: alice.customerId,
        responseNote: 'Looks perfect',
      });
      const approval = await prisma.approval.findUniqueOrThrow({
        where: { id: spec.approvalId! },
      });
      expect(approval).toMatchObject({
        type: 'SAMPLE',
        mode: 'CUSTOMER_AUTHENTICATED',
        respondedByCustomerId: alice.customerId,
      });
      // exactly once
      await alice.api
        .post(`/customer/samples/${q.sampleId}/approve`, {})
        .expect(409);
      await alice.api
        .post(`/customer/samples/${q.sampleId}/request-changes`, {
          reason: 'changed my mind',
        })
        .expect(409);
      expect(
        await prisma.sampleProductionSpec.count({
          where: { sampleId: q.sampleId, kind: 'APPROVED_REFERENCE' },
        }),
      ).toBe(1);

      await drain(app);
      const notes = (await notificationsFor(app, q.sampleId)).filter(
        (n) => n.customerId === alice.customerId,
      );
      expect(notes.map((n) => n.templateCode)).toEqual(
        expect.arrayContaining([
          'SAMPLE_READY_FOR_APPROVAL',
          'SAMPLE_APPROVED_CUSTOMER',
        ]),
      );
      const titles = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/activity`)
          .expect(200)
      ).body.map((e: { title: string }) => e.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          'Quotation ready',
          'Quotation accepted',
          'Payment proof submitted',
          'Payment verified',
          'Sample ready',
          'Sample approved',
        ]),
      );
    });

    it('sends a finished sample back, keeps every record, and lets the new one be approved', async () => {
      const q = await paid();
      await a.admin
        .post(`/admin/samples/${q.sampleId}/start-production`)
        .expect(200);
      await a.admin
        .post(`/admin/samples/${q.sampleId}/finish-production`)
        .expect(200);
      expect((await detail(alice, q.sampleId)).status).toBe(
        'AWAITING_CUSTOMER_APPROVAL',
      );

      // a reason is required; categories are optional and validated
      await alice.api
        .post(`/customer/samples/${q.sampleId}/request-changes`, {})
        .expect(400);
      await alice.api
        .post(`/customer/samples/${q.sampleId}/request-changes`, {
          reason: 'x',
        })
        .expect(400);
      await alice.api
        .post(`/customer/samples/${q.sampleId}/request-changes`, {
          reason: 'Make it better please',
          categories: ['MAGIC'],
        })
        .expect(400);
      expect((await detail(alice, q.sampleId)).status).toBe(
        'AWAITING_CUSTOMER_APPROVAL',
      );

      const res = (
        await alice.api
          .post(`/customer/samples/${q.sampleId}/request-changes`, {
            reason: 'The sleeves are too long',
            categories: ['FIT', 'CONSTRUCTION'],
          })
          .expect(200)
      ).body;
      expect(res).toMatchObject({
        status: 'REVISION_REQUESTED',
        nextStep: 'Our team will review your requested changes.',
        allowedActions: [],
      });
      const rejected = await prisma.approval.findFirstOrThrow({
        where: { sampleId: q.sampleId, type: 'SAMPLE', status: 'REJECTED' },
      });
      expect(rejected).toMatchObject({
        mode: 'CUSTOMER_AUTHENTICATED',
        respondedByCustomerId: alice.customerId,
        responseNote: '[FIT, CONSTRUCTION] The sleeves are too long',
      });
      expect(
        (await a.admin.get(`/admin/samples/${q.sampleId}`).expect(200)).body
          .status,
      ).toBe('IN_PRODUCTION');
      const activity = (
        await alice.api
          .get(`/customer/samples/${q.sampleId}/activity`)
          .expect(200)
      ).body;
      expect(activity.at(-1)).toMatchObject({
        title: 'Changes requested',
        status: 'REVISION_REQUESTED',
        message: '[FIT, CONSTRUCTION] The sleeves are too long',
      });
      const filtered = (
        await alice.api
          .get('/customer/samples?status=REVISION_REQUESTED')
          .expect(200)
      ).body;
      expect(filtered.data.map((s: { id: string }) => s.id)).toContain(
        q.sampleId,
      );
      // approving a sample that is being redone is refused
      await alice.api
        .post(`/customer/samples/${q.sampleId}/approve`, {})
        .expect(409);

      await drain(app);
      const notes = await notificationsFor(app, q.sampleId);
      expect(
        notes
          .filter((n) => n.customerId === alice.customerId)
          .map((n) => n.templateCode),
      ).toContain('SAMPLE_CHANGES_REQUESTED_CUSTOMER');
      expect(notes.map((n) => n.templateCode)).toContain(
        'SAMPLE_CHANGES_REQUESTED_STAFF',
      );

      // staff redo the sample (history is preserved), the customer then approves the new one
      await a.admin
        .post(`/admin/samples/${q.sampleId}/finish-production`)
        .expect(200);
      expect((await detail(alice, q.sampleId)).status).toBe(
        'AWAITING_CUSTOMER_APPROVAL',
      );
      await alice.api
        .post(`/customer/samples/${q.sampleId}/approve`, {})
        .expect(200);
      const approvals = await prisma.approval.findMany({
        where: { sampleId: q.sampleId, type: 'SAMPLE' },
        orderBy: { createdAt: 'asc' },
      });
      expect(approvals.map((x) => x.status)).toEqual(['REJECTED', 'APPROVED']);
      const history = await prisma.sampleStatusHistory.findMany({
        where: { sampleId: q.sampleId },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => h.action)).toEqual(
        expect.arrayContaining(['sample-rejected', 'sample-approved']),
      );
      expect(
        history
          .filter((h) => h.actorCustomerId === alice.customerId)
          .map((h) => h.action),
      ).toEqual(
        expect.arrayContaining([
          'quote-accepted',
          'sample-rejected',
          'sample-approved',
        ]),
      );
    });

    it('keeps requests for other customers and wrong states out', async () => {
      const q = await paid();
      // READY_FOR_PRODUCTION / not awaiting approval
      await alice.api
        .post(`/customer/samples/${q.sampleId}/approve`, {})
        .expect(409);
      // the customer sees no sample-approval controls on someone else's request
      await bob.api
        .post(`/customer/samples/${q.sampleId}/approve`, {})
        .expect(404);
      expect(
        await prisma.approval.count({
          where: { sampleId: q.sampleId, type: 'SAMPLE' },
        }),
      ).toBe(0);
    });
  });

  // ─────────────────────────────── staff side ───────────────────────────────

  describe('staff integration', () => {
    it('round-trips customer notes on quotations and keeps the internal ones internal', async () => {
      const sampleId = await underReview();
      const q = await draftQuotation(sampleId, {
        customerNotes: 'First note',
        notes: 'INTERNAL one',
      });
      const staff = (
        await a.sales
          .get(`/admin/quotation-versions/${q.versionId}`)
          .expect(200)
      ).body;
      expect(staff).toMatchObject({
        notes: 'INTERNAL one',
        customerNotes: 'First note',
      });
      await a.sales
        .patch(`/admin/quotation-versions/${q.versionId}`, {
          customerNotes: 'Edited note',
        })
        .expect(200);
      await send(q.versionId);
      // frozen once sent, like the prices
      await expect(
        prisma.$executeRaw`UPDATE quotation_versions SET customer_notes = 'tampered' WHERE id = ${q.versionId}::uuid`,
      ).rejects.toThrow();
      const view = (
        await alice.api
          .get(`/customer/samples/${sampleId}/quotation`)
          .expect(200)
      ).body;
      expect(view.quotations[0].versions[0].notes).toBe('Edited note');
      expect(JSON.stringify(view)).not.toContain('INTERNAL one');
      expect(uniq('x')).toBeTruthy();
    });
  });
});
