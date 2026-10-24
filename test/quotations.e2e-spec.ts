import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { auditActions, createTestApp } from './support/app.js';
import {
  LINES,
  api,
  completeDraft,
  lookupRefs,
  makeActors,
  toAwaitingPayment,
  type Actors,
  type Refs,
} from './support/factory.js';

describe('Quotations (e2e)', () => {
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

  const underReview = async () => {
    const d = await completeDraft(app, a.admin, refs);
    await a.sales.post(`/admin/samples/${d.id}/submit`).expect(200);
    await a.sales.post(`/admin/samples/${d.id}/review`).expect(200);
    return d;
  };
  const status = async (sampleId: string) =>
    (await a.admin.get(`/admin/samples/${sampleId}`)).body.status;
  const accept = (versionId: string, sourceNote = 'WhatsApp (test)') =>
    a.sales.post(`/admin/quotation-versions/${versionId}/accept`, {
      sourceNote,
    });

  describe('creation and Decimal totals', () => {
    it('creates QTN-… with a DRAFT version and server-calculated Decimal totals', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, {
            lineItems: [
              {
                type: 'SAMPLE_FEE',
                description: 'Sample fee',
                quantity: 3,
                unitPrice: 19.99,
              },
              {
                type: 'PRINTING',
                description: 'DTF',
                quantity: 1.5,
                unitPrice: 100,
              },
            ],
            discount: 10,
            taxPercent: 14,
            notes: 'Valid for 7 days',
          })
          .expect(201)
      ).body;
      expect(q.quotationNumber).toMatch(/^QTN-\d{6}$/);
      expect(q).toMatchObject({
        status: 'DRAFT',
        currency: 'EGP',
        sampleId: d.id,
      });
      const v = q.currentVersion;
      expect(v).toMatchObject({
        versionNumber: 1,
        status: 'DRAFT',
        subtotal: '209.97',
        discount: '10.00',
        taxPercent: '14.00',
        tax: '28.00',
        total: '227.97',
      });
      expect(
        v.lineItems.map((l: any) => [l.quantity, l.unitPrice, l.amount]),
      ).toEqual([
        ['3.00', '19.99', '59.97'],
        ['1.50', '100.00', '150.00'],
      ]);
      expect(await auditActions(app, q.id)).toContain('quotation.created');
      expect(await auditActions(app, v.id)).toContain(
        'quotation_version.created',
      );
    });

    it('ignores any totals a client tries to send and rejects bad money input', async () => {
      const d = await underReview();
      const post = (body: object) =>
        a.sales.post(`/admin/samples/${d.id}/quotations`, body);
      await post({ lineItems: LINES, total: '1.00', subtotal: '1.00' }).expect(
        400,
      );
      await post({
        lineItems: [
          { type: 'OTHER', description: 'x', quantity: 1, unitPrice: 1.005 },
        ],
      }).expect(400); // 3 decimals
      await post({
        lineItems: [
          { type: 'OTHER', description: 'x', quantity: 0, unitPrice: 1 },
        ],
      }).expect(400);
      await post({
        lineItems: [
          { type: 'WIDGET', description: 'x', quantity: 1, unitPrice: 1 },
        ],
      }).expect(400);
      await post({
        lineItems: [
          { type: 'OTHER', description: '', quantity: 1, unitPrice: 1 },
        ],
      }).expect(400);
      await post({
        lineItems: [
          { type: 'OTHER', description: 'x', quantity: 1, unitPrice: 'abc' },
        ],
      }).expect(400);
      await post({ lineItems: LINES, currency: 'egp' }).expect(400);
      await post({ lineItems: LINES, taxPercent: 150 }).expect(400);
      const tooMuch = await post({ lineItems: LINES, discount: 5000 }).expect(
        400,
      );
      expect(tooMuch.body.message).toMatch(
        /discount cannot exceed the subtotal/,
      );
      await post({
        lineItems: [
          { type: 'OTHER', description: 'x', quantity: 1, unitPrice: -5 },
        ],
      }).expect(400); // negative only for DISCOUNT_ADJUSTMENT lines
      const neg = await post({
        lineItems: [
          { type: 'FABRIC', description: 'x', quantity: 1, unitPrice: 10 },
          {
            type: 'DISCOUNT_ADJUSTMENT',
            description: 'goodwill',
            quantity: 1,
            unitPrice: -30,
          },
        ],
      });
      expect(neg.status).toBe(400); // would make the subtotal negative
      await a.sales
        .post(`/admin/samples/${d.id}/quotations`, {
          lineItems: [
            { type: 'FABRIC', description: 'x', quantity: 1, unitPrice: 100 },
            {
              type: 'DISCOUNT_ADJUSTMENT',
              description: 'goodwill',
              quantity: 1,
              unitPrice: -30,
            },
          ],
        })
        .expect(201);
    });

    it('supports another currency and defaults to the configured one', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, {
            lineItems: LINES,
            currency: 'USD',
          })
          .expect(201)
      ).body;
      expect(q.currency).toBe('USD');
      expect(q.currentVersion.currency).toBe('USD');
    });

    it('needs an UNDER_REVIEW sample, one live quotation per sample, and quotations.create', async () => {
      const draft = await completeDraft(app, a.admin, refs);
      expect(
        (
          await a.sales
            .post(`/admin/samples/${draft.id}/quotations`, { lineItems: LINES })
            .expect(409)
        ).body.message,
      ).toMatch(/UNDER_REVIEW/);
      const d = await underReview();
      await a.sales
        .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
        .expect(201);
      expect(
        (
          await a.sales
            .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
            .expect(409)
        ).body.message,
      ).toMatch(/create a new version instead/);
      await a.finance
        .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
        .expect(403);
      await a.sewing
        .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
        .expect(403);
      await api(app, '')
        .post(`/admin/samples/${d.id}/quotations`, {})
        .expect(401);
      await a.admin
        .post(
          '/admin/samples/3f2b1c0e-0000-4000-8000-000000000000/quotations',
          {},
        )
        .expect(404);
    });
  });

  describe('drafting, sending and versioning', () => {
    it('edits a DRAFT version (replacing lines, recalculating) but not a sent one', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
          .expect(201)
      ).body;
      const vid = q.currentVersion.id;
      const upd = await a.sales
        .patch(`/admin/quotation-versions/${vid}`, {
          lineItems: [
            {
              type: 'PATTERN_FEE',
              description: 'Pattern',
              quantity: 1,
              unitPrice: 500,
            },
          ],
          taxPercent: 10,
          notes: 'v1 notes',
        })
        .expect(200);
      expect(upd.body).toMatchObject({
        subtotal: '500.00',
        tax: '50.00',
        total: '550.00',
        notes: 'v1 notes',
      });
      expect(upd.body.lineItems).toHaveLength(1);
      const partial = await a.sales
        .patch(`/admin/quotation-versions/${vid}`, { discount: 100 })
        .expect(200);
      expect(partial.body).toMatchObject({
        subtotal: '500.00',
        discount: '100.00',
        tax: '40.00',
        total: '440.00',
      });
      await a.sales
        .patch(`/admin/quotation-versions/${vid}`, { discount: 9999 })
        .expect(400);

      await a.sales.post(`/admin/quotation-versions/${vid}/send`).expect(200);
      expect(await status(d.id)).toBe('QUOTED');
      await a.sales
        .patch(`/admin/quotation-versions/${vid}`, { notes: 'edit after send' })
        .expect(409);
      await a.sales.post(`/admin/quotation-versions/${vid}/send`).expect(409);
      // and the database agrees
      await expect(
        prisma.quotationVersion.update({
          where: { id: vid },
          data: { total: 1 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.quotationLineItem.deleteMany({
          where: { quotationVersionId: vid },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.quotationLineItem.create({
          data: {
            quotationVersionId: vid,
            description: 'x',
            quantity: 1,
            unitPrice: 1,
            amount: 1,
          },
        }),
      ).rejects.toThrow();
      expect(await auditActions(app, vid)).toEqual(
        expect.arrayContaining([
          'quotation_version.updated',
          'quotation_version.sent',
        ]),
      );
    });

    it('refuses to send an empty version or one with a past validity', async () => {
      const d = await underReview();
      const q = (
        await a.sales.post(`/admin/samples/${d.id}/quotations`, {}).expect(201)
      ).body;
      const vid = q.currentVersion.id;
      expect(
        (
          await a.sales
            .post(`/admin/quotation-versions/${vid}/send`)
            .expect(400)
        ).body.message,
      ).toMatch(/at least one line item/);
      await a.sales
        .patch(`/admin/quotation-versions/${vid}`, {
          lineItems: LINES,
          validUntil: new Date(Date.now() - 1000).toISOString(),
        })
        .expect(400);
      expect(await status(d.id)).toBe('UNDER_REVIEW');
    });

    it('a new version supersedes the sent one; only the latest can be accepted; history is kept', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
          .expect(201)
      ).body;
      const v1 = q.currentVersion.id;
      await a.sales.post(`/admin/quotation-versions/${v1}/send`).expect(200);
      await a.sales
        .post(`/admin/quotations/${q.id}/versions`, {})
        .expect(201)
        .then(async (r) => {
          expect(r.body).toMatchObject({
            versionNumber: 2,
            status: 'DRAFT',
            total: '1000.00',
          }); // lines copied from v1
          expect(r.body.lineItems).toHaveLength(2);
        });
      await a.sales.post(`/admin/quotations/${q.id}/versions`, {}).expect(409); // v2 is an open draft
      const full = (await a.admin.get(`/admin/quotations/${q.id}`)).body;
      expect(
        full.versions.map((v: any) => [v.versionNumber, v.status]),
      ).toEqual([
        [2, 'DRAFT'],
        [1, 'SUPERSEDED'],
      ]);
      expect(full.status).toBe('DRAFT');
      expect(full.versions[1].supersededAt).not.toBeNull();

      // the superseded offer cannot be accepted any more
      const outdated = await accept(v1).expect(409);
      expect(outdated.body.message).toMatch(/superseded/);
      expect(await status(d.id)).toBe('QUOTED');

      const v2 = full.versions[0].id;
      await a.sales
        .patch(`/admin/quotation-versions/${v2}`, {
          lineItems: [
            {
              type: 'SAMPLE_FEE',
              description: 'Reduced',
              quantity: 1,
              unitPrice: 700,
            },
          ],
        })
        .expect(200);
      await a.sales.post(`/admin/quotation-versions/${v2}/send`).expect(200);
      expect(await status(d.id)).toBe('QUOTED'); // stays QUOTED
      const ok = await accept(v2).expect(200);
      expect(ok.body).toMatchObject({ status: 'ACCEPTED', total: '700.00' });
      expect(await status(d.id)).toBe('AWAITING_PAYMENT');
      expect(await auditActions(app, v1)).toContain(
        'quotation_version.superseded',
      );
    });

    it('accepted quotations are final: no new version, no edits, immutable in the database', async () => {
      const f = await toAwaitingPayment(app, a, refs);
      await a.sales
        .post(`/admin/quotations/${f.quotationId}/versions`, {})
        .expect(409);
      await a.sales
        .patch(`/admin/quotation-versions/${f.versionId}`, {
          notes: 'changed terms',
        })
        .expect(409);
      await a.sales
        .post(`/admin/quotation-versions/${f.versionId}/send`)
        .expect(409);
      await accept(f.versionId).expect(409);
      await expect(
        prisma.quotationVersion.update({
          where: { id: f.versionId },
          data: { discount: 999 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.quotationVersion.update({
          where: { id: f.versionId },
          data: { status: 'DRAFT' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.quotationVersion.update({
          where: { id: f.versionId },
          data: { status: 'SUPERSEDED' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.quotationVersion.delete({ where: { id: f.versionId } }),
      ).rejects.toThrow();
      const row = await prisma.quotationVersion.findUniqueOrThrow({
        where: { id: f.versionId },
      });
      expect(row.acceptedAt).not.toBeNull();
      expect(await auditActions(app, f.versionId)).toContain(
        'quotation_version.accepted',
      );
    });

    it('guarantees a single live version per quotation in the database', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
          .expect(201)
      ).body;
      await expect(
        prisma.quotationVersion.create({
          data: { quotationId: q.id, versionNumber: 2 },
        }),
      ).rejects.toThrow(); // v1 is still a live DRAFT
    });
  });

  describe('customer decisions', () => {
    it('records acceptance only with evidence and approvals.manage, and moves the sample to AWAITING_PAYMENT', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
          .expect(201)
      ).body;
      const vid = q.currentVersion.id;
      await accept(vid).expect(409); // not sent yet
      await a.sales.post(`/admin/quotation-versions/${vid}/send`).expect(200);
      await a.sales
        .post(`/admin/quotation-versions/${vid}/accept`, {})
        .expect(400); // source note required
      await a.sales
        .post(`/admin/quotation-versions/${vid}/accept`, { sourceNote: 'x' })
        .expect(400); // too short
      await a.finance
        .post(`/admin/quotation-versions/${vid}/accept`, {
          sourceNote: 'WhatsApp',
        })
        .expect(403);
      await a.sewing
        .post(`/admin/quotation-versions/${vid}/accept`, {
          sourceNote: 'WhatsApp',
        })
        .expect(403);
      expect(await status(d.id)).toBe('QUOTED');

      const accepted = await a.sales
        .post(`/admin/quotation-versions/${vid}/accept`, {
          sourceNote: 'WhatsApp, 21 Oct 14:05',
          responseNote: 'Go ahead',
        })
        .expect(200);
      expect(accepted.body.status).toBe('ACCEPTED');
      expect(await status(d.id)).toBe('AWAITING_PAYMENT');
      const approvals = (
        await a.admin.get(`/admin/samples/${d.id}/approvals`).expect(200)
      ).body;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        type: 'QUOTATION',
        status: 'APPROVED',
        mode: 'STAFF_RECORDED_ON_BEHALF',
        staffRecorded: true,
        sourceNote: 'WhatsApp, 21 Oct 14:05',
        responseNote: 'Go ahead',
        quotationVersionId: vid,
      });
      expect(approvals[0].respondedByUserId).toBe(a.salesUserId);
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: approvals[0].id, action: 'approval.approved' },
      });
      expect(entry.actorUserId).toBe(a.salesUserId);
      expect(entry.metadata).toMatchObject({
        type: 'QUOTATION',
        mode: 'STAFF_RECORDED_ON_BEHALF',
        staffRecorded: true,
        sourceNote: 'WhatsApp, 21 Oct 14:05',
      });
    });

    it('records a rejection, returns the sample to review, and allows a fresh quotation or version', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
          .expect(201)
      ).body;
      const vid = q.currentVersion.id;
      await a.sales.post(`/admin/quotation-versions/${vid}/send`).expect(200);
      const rej = await a.sales
        .post(`/admin/quotation-versions/${vid}/reject`, {
          sourceNote: 'Email 21 Oct',
          responseNote: 'Too expensive',
        })
        .expect(200);
      expect(rej.body.status).toBe('REJECTED');
      expect(rej.body.rejectedAt).not.toBeNull();
      expect(await status(d.id)).toBe('UNDER_REVIEW');
      const full = (await a.admin.get(`/admin/quotations/${q.id}`)).body;
      expect(full.status).toBe('REJECTED');
      const hist = (await a.admin.get(`/admin/samples/${d.id}/status-history`))
        .body;
      expect(hist.at(-1)).toMatchObject({
        action: 'quote-rejected',
        source: 'SYSTEM',
        reason: 'Too expensive',
      });
      await accept(vid).expect(409);
      const v2 = await a.sales
        .post(`/admin/quotations/${q.id}/versions`, {
          lineItems: [
            {
              type: 'SAMPLE_FEE',
              description: 'Cheaper',
              quantity: 1,
              unitPrice: 600,
            },
          ],
        })
        .expect(201);
      expect(v2.body.versionNumber).toBe(2);
      await a.sales
        .post(`/admin/quotation-versions/${v2.body.id}/send`)
        .expect(200);
      expect(await status(d.id)).toBe('QUOTED');
      expect(await auditActions(app, vid)).toContain(
        'quotation_version.rejected',
      );
    });

    it('expires an offer after validUntil: acceptance is refused and the version is marked EXPIRED', async () => {
      const d = await underReview();
      const validUntil = new Date(Date.now() + 1500).toISOString();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, {
            lineItems: LINES,
            validUntil,
          })
          .expect(201)
      ).body;
      const vid = q.currentVersion.id;
      await a.sales.post(`/admin/quotation-versions/${vid}/send`).expect(200);
      await new Promise((r) => setTimeout(r, 1800));
      const late = await accept(vid).expect(409);
      expect(late.body.message).toMatch(/expired/);
      const v = (await a.admin.get(`/admin/quotation-versions/${vid}`)).body;
      expect(v.status).toBe('EXPIRED');
      expect(v.expiredAt).not.toBeNull();
      expect((await a.admin.get(`/admin/quotations/${q.id}`)).body.status).toBe(
        'EXPIRED',
      );
      expect(await status(d.id)).toBe('QUOTED');
      expect(await auditActions(app, vid)).toContain(
        'quotation_version.expired',
      );
      // a fresh version can follow
      await a.sales.post(`/admin/quotations/${q.id}/versions`, {}).expect(201);
    });

    it('a zero-value quotation needs no payment: acceptance makes the sample READY_FOR_PRODUCTION', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, {
            lineItems: [
              {
                type: 'SAMPLE_FEE',
                description: 'Free sample',
                quantity: 1,
                unitPrice: 0,
              },
            ],
          })
          .expect(201)
      ).body;
      await a.sales
        .post(`/admin/quotation-versions/${q.currentVersion.id}/send`)
        .expect(200);
      await accept(q.currentVersion.id).expect(200);
      const sample = (await a.admin.get(`/admin/samples/${d.id}`)).body;
      expect(sample.status).toBe('READY_FOR_PRODUCTION');
      expect(sample.paymentState).toBe('PAID');
    });

    it('cannot accept while the sample is on hold, and concurrent decisions resolve once', async () => {
      const d = await underReview();
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, { lineItems: LINES })
          .expect(201)
      ).body;
      const vid = q.currentVersion.id;
      await a.sales.post(`/admin/quotation-versions/${vid}/send`).expect(200);
      await a.sales
        .post(`/admin/samples/${d.id}/hold`, { reason: 'Customer travelling' })
        .expect(200);
      await accept(vid).expect(409);
      expect(
        (await a.admin.get(`/admin/quotation-versions/${vid}`)).body.status,
      ).toBe('SENT'); // rolled back cleanly
      await a.sales.post(`/admin/samples/${d.id}/resume`).expect(200);
      const results = await Promise.all([
        accept(vid),
        accept(vid),
        a.sales.post(`/admin/quotation-versions/${vid}/reject`, {
          sourceNote: 'WhatsApp no',
        }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        await prisma.approval.count({
          where: {
            quotationVersionId: vid,
            status: { in: ['APPROVED', 'REJECTED'] },
          },
        }),
      ).toBe(1);
    });
  });

  it('exposes quotations to finance read-only and keeps production roles out', async () => {
    const f = await toAwaitingPayment(app, a, refs);
    const list = (
      await a.finance
        .get(`/admin/samples/${f.sample.id}/quotations`)
        .expect(200)
    ).body;
    expect(list).toHaveLength(1);
    await a.finance.get(`/admin/quotations/${f.quotationId}`).expect(200);
    await a.finance.get(`/admin/quotation-versions/${f.versionId}`).expect(200);
    await a.finance
      .post(`/admin/quotations/${f.quotationId}/versions`, {})
      .expect(403);
    await a.sewing.get(`/admin/samples/${f.sample.id}/quotations`).expect(403);
    await a.sewing.get(`/admin/quotations/${f.quotationId}`).expect(403);
  });
});
