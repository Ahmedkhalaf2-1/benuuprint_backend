import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { auditActions, createTestApp, uniq } from './support/app.js';
import {
  acceptActiveTerms,
  api,
  approvedPatternVersion,
  completeDraft,
  createCustomerWithBrand,
  createFabricColor,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';

describe('Sample submission and state machine (e2e)', () => {
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

  const problems = (res: { body: { message: string[] } }) =>
    res.body.message.map((m) => m.split(':')[0]);
  const submit = (id: string) => a.sales.post(`/admin/samples/${id}/submit`);
  const bareDraft = async (extra: Record<string, unknown> = {}) => {
    const { customer, brand } = await createCustomerWithBrand(a.admin);
    return (
      await a.admin
        .post('/admin/samples', {
          customerId: customer.id,
          brandId: brand.id,
          ...extra,
        })
        .expect(201)
    ).body;
  };

  describe('submission validation', () => {
    it('submits a complete sample and records the timestamp, history and audit', async () => {
      const d = await completeDraft(app, a.admin, refs);
      const res = await submit(d.id).expect(200);
      expect(res.body.status).toBe('SUBMITTED');
      expect(res.body.submittedAt).not.toBeNull();
      expect(res.body.allowedActions).toEqual(
        expect.arrayContaining(['hold', 'reject', 'cancel', 'request-changes']),
      );
      const hist = (await a.admin.get(`/admin/samples/${d.id}/status-history`))
        .body;
      expect(hist.map((h: any) => [h.action, h.toStatus, h.source])).toEqual([
        ['create', 'DRAFT', 'STAFF'],
        ['submit', 'SUBMITTED', 'STAFF'],
      ]);
      expect(await auditActions(app, d.id)).toEqual(
        expect.arrayContaining([
          'sample.created',
          'sample.submitted',
          'sample.status_changed',
        ]),
      );
    });

    it('lists every missing piece together and changes nothing', async () => {
      const s = await bareDraft();
      const res = await submit(s.id).expect(400);
      expect(
        problems(res).sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['color', 'fabric', 'product', 'sampleSize', 'terms']);
      expect((await a.admin.get(`/admin/samples/${s.id}`)).body.status).toBe(
        'DRAFT',
      );
    });

    it('accepts custom product / fabric / colour in place of master data', async () => {
      const d = await completeDraft(app, a.admin, refs, {
        productTypeId: null,
        fabricId: null,
        fabricColorId: null,
        patternVersionId: null,
        fitMethod: 'COPY_CUSTOMER_PIECE',
      }).catch(() => null);
      // create DTO cannot send nulls for the xor pairs; build via PATCH instead
      const s = await bareDraft({
        sampleSizeOptionId: refs.sizeId,
        fitMethod: 'COPY_CUSTOMER_PIECE',
      });
      await a.admin
        .patch(`/admin/samples/${s.id}`, {
          customProductName: 'Quilted vest',
          customFabricName: 'Customer wool blend',
          customPantone: '18-1550 TCX',
          fabricProvider: 'CUSTOMER',
        })
        .expect(200);
      await acceptActiveTerms(a.admin, s.id).expect(201);
      await submit(s.id).expect(200);
      void d;
    });

    it('enforces the pattern rules (version required, approved only, current only, same product)', async () => {
      const d = await completeDraft(app, a.admin, refs);
      // 1. switch to BENUE_PATTERN without a version
      const s = await bareDraft({
        productTypeId: refs.productTypeId,
        fabricId: refs.fabricId,
        sampleSizeOptionId: refs.sizeId,
        fitMethod: 'BENUE_PATTERN',
      });
      await a.admin
        .patch(`/admin/samples/${s.id}`, { fabricColorId: d.colorId })
        .expect(200);
      await acceptActiveTerms(a.admin, s.id).expect(201);
      expect(problems(await submit(s.id).expect(400))).toEqual([
        'patternVersion',
      ]);

      // 2. a pattern for another product type
      const hoodiePattern = await approvedPatternVersion(
        a.admin,
        refs.hoodieId,
      );
      await a.admin
        .patch(`/admin/samples/${s.id}`, {
          patternVersionId: hoodiePattern.versionId,
        })
        .expect(200);
      const wrongProduct = await submit(s.id).expect(400);
      expect(wrongProduct.body.message[0]).toMatch(/different product type/);

      // 3. a version that was superseded after it was chosen
      const tee = await approvedPatternVersion(a.admin, refs.productTypeId);
      await a.admin
        .patch(`/admin/samples/${s.id}`, { patternVersionId: tee.versionId })
        .expect(200);
      const v2 = (
        await a.admin
          .post(`/admin/patterns/${tee.patternId}/versions`, { notes: 'v2' })
          .expect(201)
      ).body;
      const f = (await a.admin.upload('PATTERN', 'v2.png').expect(201)).body;
      await a.admin
        .post(`/admin/assets/${f.id}/attachments`, {
          targetType: 'PATTERN_VERSION',
          targetId: v2.id,
        })
        .expect(201);
      await a.admin
        .post(`/admin/patterns/${tee.patternId}/versions/${v2.id}/approve`)
        .expect(200);
      const superseded = await submit(s.id).expect(400);
      expect(superseded.body.message[0]).toMatch(/newer approved version/);
      await a.admin
        .patch(`/admin/samples/${s.id}`, { patternVersionId: v2.id })
        .expect(200);
      await submit(s.id).expect(200);
    });

    it('requires a SIZE_CHART file for CUSTOM_SIZE_CHART and nothing extra for COPY_CUSTOMER_PIECE', async () => {
      const s = await bareDraft({
        productTypeId: refs.productTypeId,
        fabricId: refs.fabricId,
        sampleSizeOptionId: refs.sizeId,
        fitMethod: 'CUSTOM_SIZE_CHART',
        customColorName: 'Navy',
      });
      await acceptActiveTerms(a.admin, s.id).expect(201);
      const missing = await submit(s.id).expect(400);
      expect(missing.body.message[0]).toMatch(/SIZE_CHART/);
      const wrongType = (
        await a.admin.upload('REFERENCE', 'ref.png').expect(201)
      ).body;
      await a.admin
        .post(`/admin/samples/${s.id}/assets`, { assetId: wrongType.id })
        .expect(201);
      await submit(s.id).expect(400);
      const chart = (
        await a.admin.upload('SIZE_CHART', 'chart.png').expect(201)
      ).body;
      await a.admin
        .post(`/admin/samples/${s.id}/assets`, { assetId: chart.id })
        .expect(201);
      await submit(s.id).expect(200);
    });

    it('requires usable artwork for a decoration that needs it, and respects the print method colour limit', async () => {
      const d = await completeDraft(app, a.admin, refs);
      const deco = (
        await a.admin
          .post(`/admin/samples/${d.id}/decorations`, {
            printMethodId: refs.printMethodId,
            placement: 'Chest',
            artworkRequired: true,
          })
          .expect(201)
      ).body;
      const missing = await submit(d.id).expect(400);
      expect(missing.body.message[0]).toMatch(/artwork is required/);
      const asset = (await a.admin.upload('ARTWORK', 'logo.png').expect(201))
        .body;
      const artwork = (
        await a.admin
          .post('/admin/artworks', {
            brandId: d.brandId,
            name: 'Logo',
            purpose: 'FRONT_PRINT',
            assetId: asset.id,
          })
          .expect(201)
      ).body;
      await a.admin
        .patch(`/admin/sample-decorations/${deco.id}`, {
          artworkId: artwork.id,
        })
        .expect(200);
      await submit(d.id).expect(200); // a DRAFT version is usable at submission; approval happens later

      const embroidery = await prisma.printMethod.findUniqueOrThrow({
        where: { code: 'VINYL' },
      });
      const e = await completeDraft(app, a.admin, refs);
      await a.admin
        .post(`/admin/samples/${e.id}/decorations`, {
          printMethodId: embroidery.id,
          placement: 'Back',
          colorCount: 20,
        })
        .expect(201);
      const tooMany = await submit(e.id).expect(400);
      expect(tooMany.body.message[0]).toMatch(/exceeds the method maximum/);
    });

    it('checks gsm against the fabric range and blocks blocked customers', async () => {
      const d = await completeDraft(app, a.admin, refs, { gsm: 500 });
      expect((await submit(d.id).expect(400)).body.message[0]).toMatch(
        /gsm: 500 is outside/,
      );
      await a.admin.patch(`/admin/samples/${d.id}`, { gsm: 160 }).expect(200);
      await a.admin
        .patch(`/admin/customers/${d.customerId}/status`, { status: 'BLOCKED' })
        .expect(200);
      expect((await submit(d.id).expect(400)).body.message[0]).toMatch(
        /blocked/,
      );
      await a.admin
        .patch(`/admin/customers/${d.customerId}/status`, { status: 'ACTIVE' })
        .expect(200);
      await submit(d.id).expect(200);
    });

    it('requires acceptance of the ACTIVE terms; a newer active version needs fresh acceptance', async () => {
      const versions = (await a.admin.get('/admin/terms?code=SAMPLE_TERMS'))
        .body as { isActive: boolean; version: number }[];
      const original = versions.find((t) => t.isActive)!;
      // other files may have published (and since deactivated) newer versions: the next one is max + 1
      const nextVersion = Math.max(...versions.map((t) => t.version)) + 1;
      try {
        const d = await completeDraft(app, a.admin, refs);
        const v2 = (
          await a.admin
            .post('/admin/terms', {
              code: 'SAMPLE_TERMS',
              title: 'Sample terms v2',
              content: 'Real content v2',
              activate: true,
            })
            .expect(201)
        ).body;
        expect(v2.isActive).toBe(true);
        expect(v2.version).toBe(nextVersion);
        expect(
          (await a.admin.get(`/admin/terms/${original.id}`)).body.isActive,
        ).toBe(false);
        expect((await submit(d.id).expect(400)).body.message[0]).toMatch(
          new RegExp(`version ${v2.version}`),
        );
        await acceptActiveTerms(a.admin, d.id).expect(201);
        await submit(d.id).expect(200);

        // legal text is immutable
        await expect(
          prisma.$executeRaw`UPDATE terms_versions SET content = 'tampered' WHERE id = ${v2.id}::uuid`,
        ).rejects.toThrow();
        await expect(
          prisma.$executeRaw`DELETE FROM terms_versions WHERE id = ${v2.id}::uuid`,
        ).rejects.toThrow();
        // with no active terms nothing has to be accepted
        await a.admin.post(`/admin/terms/${v2.id}/deactivate`).expect(200);
        const free = await completeDraft(
          app,
          a.admin,
          refs,
          {},
          { acceptTerms: false },
        );
        await submit(free.id).expect(200);
        // permissions
        await a.sales.post(`/admin/terms/${v2.id}/activate`).expect(403);
        expect(await auditActions(app, v2.id)).toEqual(
          expect.arrayContaining([
            'terms.created',
            'terms.activated',
            'terms.deactivated',
          ]),
        );
      } finally {
        await a.admin.post(`/admin/terms/${original.id}/activate`).expect(200);
      }
    });

    it('cannot be submitted twice, concurrently or from the wrong state', async () => {
      const d = await completeDraft(app, a.admin, refs);
      const results = await Promise.all([
        submit(d.id),
        submit(d.id),
        submit(d.id),
      ]);
      expect(
        results
          .map((r) => r.status)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual([200, 409, 409]);
      await submit(d.id).expect(409);
      expect(
        await prisma.sampleStatusHistory.count({
          where: { sampleId: d.id, action: 'submit' },
        }),
      ).toBe(1);
    });
  });

  describe('state machine over the API', () => {
    it('walks review and request-changes, reopening the specification', async () => {
      const d = await completeDraft(app, a.admin, refs);
      await submit(d.id).expect(200);
      await a.sales
        .post(`/admin/samples/${d.id}/request-changes`, {})
        .expect(400); // reason required
      const back = await a.sales
        .post(`/admin/samples/${d.id}/request-changes`, {
          reason: 'Please confirm the size',
        })
        .expect(200);
      expect(back.body.status).toBe('DRAFT');
      await a.admin.patch(`/admin/samples/${d.id}`, { gsm: 150 }).expect(200);
      await submit(d.id).expect(200);
      const reviewed = await a.sales
        .post(`/admin/samples/${d.id}/review`)
        .expect(200);
      expect(reviewed.body).toMatchObject({ status: 'UNDER_REVIEW' });
      expect(reviewed.body.reviewedAt).not.toBeNull();
      const hist = (await a.admin.get(`/admin/samples/${d.id}/status-history`))
        .body;
      const last = hist.at(-1);
      expect(last).toMatchObject({
        action: 'start-review',
        fromStatus: 'SUBMITTED',
        toStatus: 'UNDER_REVIEW',
      });
      expect(hist.find((h: any) => h.action === 'request-changes').reason).toBe(
        'Please confirm the size',
      );
    });

    it('rejects invalid transitions with 409 and never changes state', async () => {
      const d = await completeDraft(app, a.admin, refs);
      for (const action of [
        'review',
        'complete',
        'start-production',
        'finish-production',
        'resume',
      ]) {
        await a.admin.post(`/admin/samples/${d.id}/${action}`, {}).expect(409);
      }
      await a.admin
        .post(`/admin/samples/${d.id}/hold`, { reason: 'x' })
        .expect(409);
      await a.admin
        .post(`/admin/samples/${d.id}/reject`, { reason: 'x' })
        .expect(409);
      expect((await a.admin.get(`/admin/samples/${d.id}`)).body.status).toBe(
        'DRAFT',
      );
      await a.admin
        .post(`/admin/samples/${d.id}/set-status`, { status: 'APPROVED' })
        .expect(404); // no arbitrary status endpoint
      await a.admin
        .patch(`/admin/samples/${d.id}`, { status: 'APPROVED' })
        .expect(400);
    });

    it('holds with a reason and resumes to the previous status; hold remembers where it came from', async () => {
      const d = await completeDraft(app, a.admin, refs);
      await submit(d.id).expect(200);
      await a.sales.post(`/admin/samples/${d.id}/review`).expect(200);
      await a.sales.post(`/admin/samples/${d.id}/hold`, {}).expect(400);
      const held = await a.sales
        .post(`/admin/samples/${d.id}/hold`, { reason: 'Waiting for customer' })
        .expect(200);
      expect(held.body).toMatchObject({
        status: 'ON_HOLD',
        holdPreviousStatus: 'UNDER_REVIEW',
      });
      await a.sales
        .post(`/admin/samples/${d.id}/hold`, { reason: 'again' })
        .expect(409);
      await a.admin
        .patch(`/admin/samples/${d.id}`, { notes: 'edit while held' })
        .expect(409);
      const resumed = await a.sales
        .post(`/admin/samples/${d.id}/resume`)
        .expect(200);
      expect(resumed.body).toMatchObject({
        status: 'UNDER_REVIEW',
        holdPreviousStatus: null,
      });
      await a.sales.post(`/admin/samples/${d.id}/resume`).expect(409);
      expect(await auditActions(app, d.id)).toContain('sample.status_changed');
    });

    it('rejects and cancels with reasons; terminal states are final', async () => {
      const r = await completeDraft(app, a.admin, refs);
      await submit(r.id).expect(200);
      await a.sales.post(`/admin/samples/${r.id}/reject`, {}).expect(400);
      const rejected = await a.sales
        .post(`/admin/samples/${r.id}/reject`, { reason: 'Not producible' })
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        allowedActions: [],
      });
      for (const action of ['review', 'hold', 'cancel', 'reject', 'resume']) {
        await a.admin
          .post(`/admin/samples/${r.id}/${action}`, { reason: 'x' })
          .expect(409);
      }
      await a.admin.post(`/admin/samples/${r.id}/revise`).expect(201); // a rejected request can be reworked as a revision
      const c = await completeDraft(app, a.admin, refs);
      await a.sales.post(`/admin/samples/${c.id}/cancel`, {}).expect(400);
      expect(
        (
          await a.sales
            .post(`/admin/samples/${c.id}/cancel`, {
              reason: 'Customer withdrew',
            })
            .expect(200)
        ).body.status,
      ).toBe('CANCELLED');
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: c.id, action: 'sample.status_changed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry.metadata).toMatchObject({
        action: 'cancel',
        from: 'DRAFT',
        to: 'CANCELLED',
        reason: 'Customer withdrew',
        verifiedPaid: '0.00',
      });
    });

    it('limits editing by status: spec locked after submit, notes editable only during review', async () => {
      const d = await completeDraft(app, a.admin, refs);
      await submit(d.id).expect(200);
      await a.admin.patch(`/admin/samples/${d.id}`, { gsm: 150 }).expect(409);
      await a.admin
        .patch(`/admin/samples/${d.id}`, { fabricId: refs.otherFabricId })
        .expect(409);
      await a.admin.patch(`/admin/samples/${d.id}`, { gsm: 160 }).expect(409); // even the same value is a spec edit
      const notes = await a.admin
        .patch(`/admin/samples/${d.id}`, {
          factoryInstructions: 'Use the long table',
          notes: 'ok',
        })
        .expect(200);
      expect(notes.body.factoryInstructions).toBe('Use the long table');
      await a.sales.post(`/admin/samples/${d.id}/review`).expect(200);
      await a.admin
        .patch(`/admin/samples/${d.id}`, { printNotes: 'still editable' })
        .expect(200);
      await a.admin
        .patch(`/admin/samples/${d.id}`, {
          patternVersionId: null,
          fitMethod: 'NOT_SURE',
        })
        .expect(409);
    });

    it('transitions are race-safe: concurrent hold/cancel leave exactly one outcome', async () => {
      const d = await completeDraft(app, a.admin, refs);
      await submit(d.id).expect(200);
      const results = await Promise.all([
        a.admin.post(`/admin/samples/${d.id}/cancel`, { reason: 'one' }),
        a.admin.post(`/admin/samples/${d.id}/reject`, { reason: 'two' }),
        a.admin.post(`/admin/samples/${d.id}/hold`, { reason: 'three' }),
      ]);
      // hold can legitimately win first and be followed by cancel/reject (both
      // allowed from ON_HOLD), so assert consistency rather than exactly one winner.
      const wins = results.filter((r) => r.status === 200).length;
      expect(wins).toBeGreaterThanOrEqual(1);
      expect(wins).toBeLessThanOrEqual(2);
      const sample = await prisma.sample.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(['CANCELLED', 'REJECTED', 'ON_HOLD']).toContain(sample.status);
      // every successful transition left exactly one history row (no lost updates)
      expect(
        await prisma.sampleStatusHistory.count({ where: { sampleId: d.id } }),
      ).toBe(2 + wins); // create, submit, then the winners
    });

    it('keeps the append-only history immutable', async () => {
      const d = await completeDraft(app, a.admin, refs);
      const row = await prisma.sampleStatusHistory.findFirstOrThrow({
        where: { sampleId: d.id },
      });
      await expect(
        prisma.sampleStatusHistory.update({
          where: { id: row.id },
          data: { reason: 'edited' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.sampleStatusHistory.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
    });
  });

  it('does not let a different role transition samples outside their permissions', async () => {
    const d = await completeDraft(app, a.admin, refs);
    for (const action of [
      'submit',
      'review',
      'hold',
      'cancel',
      'start-production',
      'assign-sales',
    ]) {
      await a.sewing
        .post(`/admin/samples/${d.id}/${action}`, { reason: 'x', userId: null })
        .expect(403);
      await a.finance
        .post(`/admin/samples/${d.id}/${action}`, { reason: 'x', userId: null })
        .expect(403);
    }
    await api(app, '').post(`/admin/samples/${d.id}/submit`).expect(401);
    void uniq;
    void createFabricColor;
  });
});
