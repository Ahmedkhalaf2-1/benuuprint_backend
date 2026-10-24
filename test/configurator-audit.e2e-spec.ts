import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import { createTestApp, createUserAndLogin, uniq } from './support/app.js';
import {
  api,
  approvedPatternVersion,
  completeDraft,
  createFabricColor,
  lookupRefs,
  makeActors,
  produce,
  quoteAndAccept,
  type Actors,
  type Refs,
} from './support/factory.js';

describe('Configurator and audit coverage (e2e)', () => {
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

  const options = async (client = a.admin) =>
    (await client.get('/configurator/sample-options').expect(200)).body;

  describe('GET /configurator/sample-options', () => {
    it('returns everything a sample form needs from active data only', async () => {
      const o = await options();
      expect(o.productTypes.map((p: any) => p.code)).toEqual(
        expect.arrayContaining(['TEE', 'HOODIE']),
      );
      const fabric = o.fabrics.find((f: any) => f.code === 'SINGLE_LYCRA');
      expect(fabric).toMatchObject({
        composition: 'Cotton / elastane',
        minGsm: 140,
        maxGsm: 200,
      });
      expect(fabric.productTypes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ isRecommended: true }),
        ]),
      );
      const scale = o.sizeScales.find((s: any) => s.code === 'STANDARD');
      expect(scale.sizes.map((s: any) => s.code)).toEqual([
        'XXS',
        'XS',
        'S',
        'M',
        'L',
        'XL',
        'XXL',
        'ONE_SIZE',
      ]);
      expect(o.printMethods.map((p: any) => p.code)).toEqual(
        expect.arrayContaining(['DTF', 'EMBROIDERY']),
      );
      expect(o.accessories.map((p: any) => p.code)).toContain('ZIP');
      expect(o.components.map((p: any) => p.code)).toContain('POLYBAG');
      expect(o.fitMethods.map((x: any) => x.value)).toEqual([
        'BENUE_PATTERN',
        'COPY_CUSTOMER_PIECE',
        'CUSTOM_SIZE_CHART',
        'NOT_SURE',
      ]);
      expect(o.fabricProviders.map((x: any) => x.value)).toEqual([
        'CUSTOMER',
        'BENUE_PRINT',
        'NOT_DECIDED',
      ]);
      expect(o.decorationSides).toHaveLength(5);
      expect(o.measurementUnits.map((x: any) => x.value)).toEqual([
        'CM',
        'MM',
        'IN',
      ]);
      expect(o.terms).toMatchObject({
        code: 'SAMPLE_TERMS',
        version: expect.any(Number),
        title: expect.any(String),
      });
    });

    it('never leaks prices, internal notes, archived rows or storage details', async () => {
      const code = () => uniq('CFG').toUpperCase().replace(/-/g, '_');
      const priced = (
        await a.admin
          .post('/admin/product-types', {
            code: code(),
            name: 'Priced',
            defaultSampleFee: 750,
          })
          .expect(201)
      ).body;
      const hidden = (
        await a.admin
          .post('/admin/product-types', {
            code: code(),
            name: 'Hidden',
            isActive: false,
          })
          .expect(201)
      ).body;
      const archived = (
        await a.admin
          .post('/admin/product-types', { code: code(), name: 'Archived' })
          .expect(201)
      ).body;
      await a.admin.del(`/admin/product-types/${archived.id}`).expect(204);
      const method = (
        await a.admin
          .post('/admin/print-methods', {
            code: code(),
            name: 'Costly',
            setupFee: 900,
            notes: 'margin 40%',
          })
          .expect(201)
      ).body;
      const fabric = (
        await a.admin
          .post('/admin/fabrics', {
            code: code(),
            name: 'Noted fabric',
            notes: 'supplier: Acme',
          })
          .expect(201)
      ).body;
      await a.admin
        .post(`/admin/fabrics/${fabric.id}/colors`, {
          name: 'Visible',
          hex: '#00aa00',
        })
        .expect(201);
      await a.admin
        .post(`/admin/fabrics/${fabric.id}/colors`, {
          name: 'Unavailable',
          isAvailable: false,
        })
        .expect(201);
      const gone = (
        await a.admin
          .post(`/admin/fabrics/${fabric.id}/colors`, { name: 'Gone' })
          .expect(201)
      ).body;
      await a.admin.del(`/admin/fabric-colors/${gone.id}`).expect(204);

      const o = await options();
      const ids = o.productTypes.map((p: any) => p.id);
      expect(ids).toContain(priced.id);
      expect(ids).not.toContain(hidden.id);
      expect(ids).not.toContain(archived.id);
      expect(o.printMethods.find((p: any) => p.id === method.id)).toBeDefined();
      expect(
        o.fabrics
          .find((f: any) => f.id === fabric.id)
          .colors.map((c: any) => c.name),
      ).toEqual(['Visible']);
      // pattern entries intentionally carry their customer-facing PAT-… reference; everything else must not
      const dump = JSON.stringify({ ...o, patterns: undefined });
      expect(dump).not.toMatch(
        /defaultSampleFee|setupFee|margin 40|supplier: Acme|referenceNumber|archivedAt|storageKey|assets\/\d{4}|sortOrder|createdAt/,
      );
    });

    it('lists only patterns that have an approved current version and are not archived', async () => {
      const draftOnly = (
        await a.admin
          .post('/admin/patterns', {
            code: uniq('CP').toUpperCase().replace(/-/g, '_'),
            name: 'Draft only',
            productTypeId: refs.productTypeId,
          })
          .expect(201)
      ).body;
      const live = await approvedPatternVersion(a.admin, refs.productTypeId);
      const toArchive = await approvedPatternVersion(
        a.admin,
        refs.productTypeId,
      );
      await a.admin.del(`/admin/patterns/${toArchive.patternId}`).expect(204);
      const o = await options();
      const ids = o.patterns.map((p: any) => p.patternId);
      expect(ids).toContain(live.patternId);
      expect(ids).not.toContain(draftOnly.id);
      expect(ids).not.toContain(toArchive.patternId);
      const entry = o.patterns.find((p: any) => p.patternId === live.patternId);
      expect(entry).toMatchObject({
        patternVersionId: live.versionId,
        versionNumber: 1,
        productTypeId: refs.productTypeId,
      });
      // the offered patternVersionId is directly usable on a sample
      const d = await completeDraft(app, a.admin, refs, {
        patternVersionId: entry.patternVersionId,
      });
      expect(d.id).toBeTruthy();
    });

    it('requires authentication and master_data.read', async () => {
      await api(app, '').get('/configurator/sample-options').expect(401);
      await a.sales.get('/configurator/sample-options').expect(200);
      await a.sewing.get('/configurator/sample-options').expect(200);
      const delivery = await createUserAndLogin(app, {
        roleCodes: ['DELIVERY'],
      });
      await api(app, delivery.accessToken)
        .get('/configurator/sample-options')
        .expect(403);
    });
  });

  describe('audit coverage of the commercial workflow', () => {
    it('records every critical action of a full sample lifecycle, without secrets', async () => {
      const marker = 'TOP-SECRET-REF-' + uniq('r');
      const d = await completeDraft(app, a.admin, refs);
      const art = (await a.admin.upload('ARTWORK', 'logo.png').expect(201))
        .body;
      const artwork = (
        await a.admin
          .post('/admin/artworks', {
            brandId: d.brandId,
            name: 'Logo',
            assetId: art.id,
          })
          .expect(201)
      ).body;
      const deco = (
        await a.admin
          .post(`/admin/samples/${d.id}/decorations`, {
            printMethodId: refs.printMethodId,
            placement: 'Chest',
            artworkId: artwork.id,
          })
          .expect(201)
      ).body;
      await a.admin
        .post(`/admin/samples/${d.id}/assign-sales`, { userId: a.salesUserId })
        .expect(200);
      await a.admin
        .post(`/admin/samples/${d.id}/notes`, { content: 'private note text' })
        .expect(201);
      const flow = await quoteAndAccept(a, d);
      const proof = (
        await a.sales.upload('PAYMENT_PROOF', 'receipt.png').expect(201)
      ).body;
      const pay = (
        await a.sales
          .post(`/admin/samples/${d.id}/payments`, {
            amount: 1000,
            method: 'INSTAPAY',
            transactionReference: marker,
            proofAssetId: proof.id,
          })
          .expect(201)
      ).body;
      await a.finance.post(`/admin/payments/${pay.id}/verify`).expect(200);
      await a.admin.post(`/admin/samples/${d.id}/start-production`).expect(200);
      await a.admin
        .post(`/admin/samples/${d.id}/finish-production`)
        .expect(200);
      const artReq = (
        await a.sales
          .post(`/admin/samples/${d.id}/approvals`, {
            type: 'ARTWORK',
            artworkVersionId: artwork.versions[0].id,
          })
          .expect(201)
      ).body;
      await a.sales
        .post(`/admin/approvals/${artReq.id}/approve`, {
          sourceNote: 'WhatsApp proof OK',
        })
        .expect(200);
      const req = (
        await a.sales
          .post(`/admin/samples/${d.id}/approvals`, { type: 'SAMPLE' })
          .expect(201)
      ).body;
      await a.sales
        .post(`/admin/approvals/${req.id}/approve`, {
          sourceNote: 'WhatsApp, approved',
        })
        .expect(200);
      await a.admin.post(`/admin/samples/${d.id}/complete`).expect(200);
      const rev = (
        await a.sales.post(`/admin/samples/${d.id}/revise`).expect(201)
      ).body;

      const spec = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { sampleId: d.id },
      });
      const entityIds = [
        d.id,
        flow.quotationId,
        flow.versionId,
        pay.id,
        artReq.id,
        req.id,
        artwork.id,
        artwork.versions[0].id,
        deco.id,
        spec.id,
        rev.id,
      ];
      const rows = await prisma.auditLog.findMany({
        where: { entityId: { in: entityIds } },
      });
      const actions = new Set(rows.map((r) => r.action));
      for (const expected of [
        'sample.created',
        'sample.submitted',
        'sample.status_changed',
        'sample.updated',
        'sample.sales_assigned',
        'sample.terms_accepted',
        'sample.revision_created',
        'sample_decoration.created',
        'sample_note.created',
        'artwork.created',
        'artwork_version.created',
        'artwork_version.approved',
        'quotation.created',
        'quotation_version.created',
        'quotation_version.sent',
        'quotation_version.accepted',
        'payment.created',
        'payment.verified',
        'approval.requested',
        'approval.approved',
        'production_spec.created',
      ]) {
        if (expected === 'sample.updated') continue; // only raised by edits; covered in samples spec
        expect([...actions]).toContain(expected);
      }
      // the status timeline in the audit log matches the history table
      const transitions = rows
        .filter(
          (r) => r.entityId === d.id && r.action === 'sample.status_changed',
        )
        .map((r) => (r.metadata as any).action);
      expect(transitions).toEqual(
        expect.arrayContaining([
          'submit',
          'start-review',
          'quote-sent',
          'quote-accepted',
          'payment-covered',
          'start-production',
          'finish-production',
          'sample-approved',
          'complete',
        ]),
      );
      expect(rows.filter((r) => r.actorUserId === null)).toEqual([]); // every entry names who did it
      // nothing sensitive is written to the audit log
      const dump = JSON.stringify(
        await prisma.auditLog.findMany({
          where: { createdAt: { gte: new Date(Date.now() - 600_000) } },
        }),
      );
      expect(dump).not.toContain(marker); // payment reference
      expect(dump).not.toContain('private note text'); // note content
      expect(dump).not.toMatch(/storageKey|assets\/\d{4}\/\d{2}\//);
      expect(dump).not.toMatch(/"password|refreshToken|accessToken/i);
    });

    it('exposes the audit entries through the audit API with filters', async () => {
      const d = await completeDraft(app, a.admin, refs);
      await a.sales.post(`/admin/samples/${d.id}/submit`).expect(200);
      const res = await a.admin
        .get(
          `/admin/audit-logs?entityType=Sample&action=sample.submitted&pageSize=100`,
        )
        .expect(200);
      expect(res.body.data.map((r: any) => r.entityId)).toContain(d.id);
      void createFabricColor;
      void produce;
    });
  });
});
