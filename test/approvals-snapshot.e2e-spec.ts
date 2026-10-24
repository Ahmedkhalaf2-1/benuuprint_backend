import type { INestApplication } from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../src/common/canonical-json.js';
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
  produce,
  quoteAndAccept,
  toAwaitingApproval,
  toAwaitingPayment,
  type Actors,
  type Flow,
  type Refs,
} from './support/factory.js';

describe('Approvals and the frozen production specification (e2e)', () => {
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

  const requestSample = (sampleId: string) =>
    a.sales.post(`/admin/samples/${sampleId}/approvals`, { type: 'SAMPLE' });
  const approveSample = async (
    sampleId: string,
    body: object = { sourceNote: 'Customer approved by WhatsApp 21 Oct' },
  ) => {
    const req = (await requestSample(sampleId).expect(201)).body;
    return {
      req,
      res: a.sales.post(`/admin/approvals/${req.id}/approve`, body),
    };
  };
  const sample = async (id: string) =>
    (await a.admin.get(`/admin/samples/${id}`)).body;
  const spec = async (id: string) =>
    (await a.admin.get(`/admin/samples/${id}/production-spec`).expect(200))
      .body;

  describe('requesting and deciding', () => {
    it('validates the target for each approval type', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const id = f.sample.id;
      const post = (body: object) =>
        a.sales.post(`/admin/samples/${id}/approvals`, body);
      await post({ type: 'QUOTATION' }).expect(400);
      await post({ type: 'ARTWORK' }).expect(400);
      await post({ type: 'PRODUCTION_SPEC' }).expect(400);
      await post({ type: 'SAMPLE', quotationVersionId: f.versionId }).expect(
        400,
      );
      await post({ type: 'NOPE' }).expect(400);
      await post({ type: 'QUOTATION', quotationVersionId: f.versionId }).expect(
        409,
      ); // already accepted, no longer SENT
      await post({
        type: 'QUOTATION',
        quotationVersionId: '3f2b1c0e-0000-4000-8000-000000000000',
      }).expect(404);
      await post({
        type: 'SAMPLE',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }).expect(400);
      const other = await toAwaitingApproval(app, a, refs);
      await post({
        type: 'QUOTATION',
        quotationVersionId: other.versionId,
      }).expect(404); // another sample's quotation
    });

    it('a SAMPLE approval needs the sample AWAITING_APPROVAL and samples.approve', async () => {
      const f = await toAwaitingPayment(app, a, refs);
      expect(
        (await requestSample(f.sample.id).expect(409)).body.message,
      ).toMatch(/AWAITING_APPROVAL/);
      await produce(a, f);
      await a.sewing
        .post(`/admin/samples/${f.sample.id}/approvals`, { type: 'SAMPLE' })
        .expect(403);
      await a.finance
        .post(`/admin/samples/${f.sample.id}/approvals`, { type: 'SAMPLE' })
        .expect(403);
      // approvals.manage alone is not enough for a sample-level approval
      const mgr = await createUserAndLogin(app, {
        permissions: ['approvals.manage', 'samples.read'],
      });
      await api(app, mgr.accessToken)
        .post(`/admin/samples/${f.sample.id}/approvals`, { type: 'SAMPLE' })
        .expect(403);
      const req = (await requestSample(f.sample.id).expect(201)).body;
      await requestSample(f.sample.id).expect(409); // one pending request per target
      await api(app, mgr.accessToken)
        .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'WhatsApp' })
        .expect(403);
      await api(app, mgr.accessToken)
        .post(`/admin/approvals/${req.id}/cancel`)
        .expect(403);
    });

    it('requires evidence for on-behalf decisions and forbids INTERNAL for customer decisions', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const req = (await requestSample(f.sample.id).expect(201)).body;
      await a.sales.post(`/admin/approvals/${req.id}/approve`, {}).expect(400);
      await a.sales
        .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'ok' })
        .expect(400);
      const internal = await a.sales
        .post(`/admin/approvals/${req.id}/approve`, { recordedAs: 'INTERNAL' })
        .expect(400);
      expect(internal.body.message).toMatch(/belongs to the customer/);
      await a.sales
        .post(`/admin/approvals/${req.id}/approve`, {
          recordedAs: 'CUSTOMER_AUTHENTICATED',
          sourceNote: 'trust me',
        })
        .expect(400);
      expect(
        (await prisma.approval.findUniqueOrThrow({ where: { id: req.id } }))
          .status,
      ).toBe('PENDING');
    });

    it('marks every decision as staff-recorded with actor, evidence and audit', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const { req, res } = await approveSample(f.sample.id, {
        sourceNote: 'Voice note, 21 Oct 16:10',
        responseNote: 'Looks great',
      });
      const approved = (await res.expect(200)).body;
      expect(approved).toMatchObject({
        status: 'APPROVED',
        mode: 'STAFF_RECORDED_ON_BEHALF',
        staffRecorded: true,
        sourceNote: 'Voice note, 21 Oct 16:10',
        responseNote: 'Looks great',
        respondedByUserId: a.salesUserId,
      });
      expect(approved.respondedAt).not.toBeNull();
      expect(await auditActions(app, req.id)).toEqual(
        expect.arrayContaining(['approval.requested', 'approval.approved']),
      );
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: req.id, action: 'approval.approved' },
      });
      expect(entry.actorUserId).toBe(a.salesUserId);
      expect(entry.metadata).toMatchObject({
        type: 'SAMPLE',
        mode: 'STAFF_RECORDED_ON_BEHALF',
        staffRecorded: true,
        sourceNote: 'Voice note, 21 Oct 16:10',
      });
      // decided approvals are final, in the API and the database
      await a.sales
        .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'again' })
        .expect(409);
      await a.sales
        .post(`/admin/approvals/${req.id}/reject`, {
          sourceNote: 'again',
          responseNote: 'x',
        })
        .expect(409);
      await a.sales.post(`/admin/approvals/${req.id}/cancel`).expect(409);
      await expect(
        prisma.approval.update({
          where: { id: req.id },
          data: { status: 'REJECTED' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.approval.delete({ where: { id: req.id } }),
      ).rejects.toThrow();
    });

    it('a decision on an outdated target fails cleanly and leaves the request pending', async () => {
      const d = await completeDraft(app, a.admin, refs);
      await a.sales.post(`/admin/samples/${d.id}/submit`).expect(200);
      await a.sales.post(`/admin/samples/${d.id}/review`).expect(200);
      const q = (
        await a.sales
          .post(`/admin/samples/${d.id}/quotations`, {
            lineItems: [
              {
                type: 'SAMPLE_FEE',
                description: 'Fee',
                quantity: 1,
                unitPrice: 100,
              },
            ],
          })
          .expect(201)
      ).body;
      const v1 = q.currentVersion.id;
      await a.sales.post(`/admin/quotation-versions/${v1}/send`).expect(200);
      const req = (
        await a.sales
          .post(`/admin/samples/${d.id}/approvals`, {
            type: 'QUOTATION',
            quotationVersionId: v1,
          })
          .expect(201)
      ).body;
      await a.sales.post(`/admin/quotations/${q.id}/versions`, {}).expect(201); // v1 superseded
      const stale = await a.sales
        .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'WhatsApp' })
        .expect(409);
      expect(stale.body.message).toMatch(/superseded/);
      expect(
        (await prisma.approval.findUniqueOrThrow({ where: { id: req.id } }))
          .status,
      ).toBe('PENDING');
      expect((await sample(d.id)).status).toBe('QUOTED');
      await a.sales.post(`/admin/approvals/${req.id}/cancel`).expect(200);
    });

    it('expires a request after its deadline', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const req = (
        await a.sales
          .post(`/admin/samples/${f.sample.id}/approvals`, {
            type: 'SAMPLE',
            expiresAt: new Date(Date.now() + 1200).toISOString(),
          })
          .expect(201)
      ).body;
      await new Promise((r) => setTimeout(r, 1500));
      const late = await a.sales
        .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'WhatsApp' })
        .expect(409);
      expect(late.body.message).toMatch(/expired/);
      expect(
        (await prisma.approval.findUniqueOrThrow({ where: { id: req.id } }))
          .status,
      ).toBe('EXPIRED');
      expect((await sample(f.sample.id)).status).toBe('AWAITING_APPROVAL');
      expect(await auditActions(app, req.id)).toContain('approval.expired');
      await requestSample(f.sample.id).expect(201); // a fresh request is possible
    });

    it('lists approvals for a sample and enforces read access', async () => {
      const f = await toAwaitingPayment(app, a, refs);
      const list = (
        await a.finance
          .get(`/admin/samples/${f.sample.id}/approvals`)
          .expect(200)
      ).body;
      expect(list).toHaveLength(1);
      await a.sewing.get(`/admin/samples/${f.sample.id}/approvals`).expect(403);
      await api(app, '')
        .get(`/admin/samples/${f.sample.id}/approvals`)
        .expect(401);
      await a.admin
        .get('/admin/samples/3f2b1c0e-0000-4000-8000-000000000000/approvals')
        .expect(404);
    });
  });

  describe('approving a sample freezes the production specification', () => {
    it('creates an immutable snapshot, moves the sample to APPROVED and records everything that was approved', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const id = f.sample.id;
      await a.admin
        .get(`/admin/samples/${id}/production-spec`)
        .expect(200)
        .catch(() => undefined);
      const before = await a.admin.get(`/admin/samples/${id}/production-spec`);
      expect(before.status).toBe(404); // nothing frozen yet
      await a.admin
        .post(`/admin/samples/${id}/decorations`, {
          printMethodId: refs.printMethodId,
          placement: 'Back',
        })
        .expect(409); // spec already locked

      const { res } = await approveSample(id);
      await res.expect(200);
      const s = await sample(id);
      expect(s.status).toBe('APPROVED');
      expect(s.approvedAt).not.toBeNull();

      const frozen = await spec(id);
      expect(frozen).toMatchObject({
        sampleId: id,
        revision: 1,
        schemaVersion: 1,
      });
      const snap = frozen.snapshot;
      expect(snap.sample).toMatchObject({
        sampleNumber: f.sample.sampleNumber,
        id,
      });
      expect(snap.product).toMatchObject({ source: 'CATALOG', code: 'TEE' });
      expect(snap.fabric).toMatchObject({
        source: 'CATALOG',
        code: 'SINGLE_LYCRA',
        name: 'Single Lycra',
      });
      expect(snap.color).toMatchObject({ source: 'CATALOG', hex: '#336699' });
      expect(snap.fabricProvider).toBe('BENUE_PRINT');
      expect(snap.size).toMatchObject({
        code: 'M',
        scale: { code: 'STANDARD' },
      });
      expect(snap.fit).toMatchObject({ method: 'BENUE_PATTERN' });
      expect(snap.fit.patternVersion).toMatchObject({
        patternVersionId: f.sample.patternVersionId,
        versionNumber: 1,
      });
      expect(snap.fit.patternVersion.files).toHaveLength(1);
      expect(snap.fit.patternVersion.files[0].checksum).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(snap.quotation).toMatchObject({
        quotationVersionId: f.versionId,
        versionNumber: 1,
        total: '1000.00',
        currency: 'EGP',
      });
      expect(snap.terms).toHaveLength(1);
      expect(snap.terms[0]).toMatchObject({
        code: 'SAMPLE_TERMS',
        mode: 'STAFF_RECORDED_ON_BEHALF',
      });
      expect(snap.approval).toMatchObject({
        mode: 'STAFF_RECORDED_ON_BEHALF',
        recordedByUserId: a.salesUserId,
        sourceNote: 'Customer approved by WhatsApp 21 Oct',
      });
      expect(snap.customer.customerNumber).toMatch(/^CUS-/);
      expect(JSON.stringify(frozen)).not.toMatch(/storageKey|assets\/\d{4}/);

      // integrity: hash matches the canonical snapshot; row ids are recorded next to the values
      expect(frozen.specHash).toBe(
        sha256Hex(canonicalJson(JSON.parse(JSON.stringify(snap)))),
      );
      const row = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { sampleId: id },
      });
      expect(row).toMatchObject({
        productTypeId: refs.productTypeId,
        fabricId: refs.fabricId,
        sampleSizeOptionId: refs.sizeId,
        quotationVersionId: f.versionId,
      });
      expect(row.approvalId).toBeTruthy();
      expect(row.termsVersionId).toBeTruthy();

      expect(
        (await a.admin.get(`/admin/samples/${id}/production-specs`).expect(200))
          .body,
      ).toHaveLength(1);
      const entries = await auditActions(app, id);
      expect(entries).toEqual(
        expect.arrayContaining([
          'production_spec.created',
          'sample.status_changed',
        ]),
      );
      const hist = (await a.admin.get(`/admin/samples/${id}/status-history`))
        .body;
      expect(hist.at(-1)).toMatchObject({
        action: 'sample-approved',
        toStatus: 'APPROVED',
        source: 'SYSTEM',
      });
    });

    it('later master-data edits never change the approved specification', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const id = f.sample.id;
      await (await approveSample(id)).res.expect(200);
      const frozenBefore = await spec(id);

      const fabric = await prisma.fabric.findUniqueOrThrow({
        where: { id: refs.fabricId },
      });
      const tee = await prisma.productType.findUniqueOrThrow({
        where: { id: refs.productTypeId },
      });
      const dtf = await prisma.printMethod.findUniqueOrThrow({
        where: { id: refs.printMethodId },
      });
      try {
        await a.admin
          .patch(`/admin/fabrics/${refs.fabricId}`, {
            name: 'Renamed Fabric',
            composition: '100% polyester',
            defaultGsm: 150,
          })
          .expect(200);
        await a.admin
          .patch(`/admin/product-types/${refs.productTypeId}`, {
            name: 'Renamed Tee',
          })
          .expect(200);
        await a.admin
          .patch(`/admin/print-methods/${refs.printMethodId}`, {
            name: 'Renamed DTF',
          })
          .expect(200);
        await a.admin
          .patch(`/admin/fabric-colors/${f.sample.colorId}`, {
            hex: '#ff0000',
            pantone: 'NEW',
          })
          .expect(200);
        await a.admin
          .del(`/admin/fabric-colors/${f.sample.colorId}`)
          .expect(204);

        // the live sample reflects the new names; the frozen spec does not
        expect((await sample(id)).fabric.name).toBe('Renamed Fabric');
        const frozenAfter = await spec(id);
        expect(frozenAfter).toEqual(frozenBefore);
        expect(frozenAfter.snapshot.fabric).toMatchObject({
          name: 'Single Lycra',
          composition: 'Cotton / elastane',
        });
        expect(frozenAfter.snapshot.color.hex).toBe('#336699');
        expect(frozenAfter.snapshot.product.name).toBe('Tee');
        expect(frozenAfter.specHash).toBe(frozenBefore.specHash);
      } finally {
        await prisma.fabric.update({
          where: { id: fabric.id },
          data: {
            name: fabric.name,
            composition: fabric.composition,
            defaultGsm: fabric.defaultGsm,
          },
        });
        await prisma.productType.update({
          where: { id: tee.id },
          data: { name: tee.name },
        });
        await prisma.printMethod.update({
          where: { id: dtf.id },
          data: { name: dtf.name },
        });
      }
    });

    it('the snapshot cannot be updated or deleted, even directly in the database', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      await (await approveSample(f.sample.id)).res.expect(200);
      const row = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { sampleId: f.sample.id },
      });
      await expect(
        prisma.sampleProductionSpec.update({
          where: { id: row.id },
          data: { specHash: 'x' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.sampleProductionSpec.update({
          where: { id: row.id },
          data: { snapshot: {} },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.sampleProductionSpec.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      await expect(
        prisma.sampleProductionSpec.deleteMany({
          where: { sampleId: f.sample.id },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.sampleProductionSpec.create({
          data: {
            sampleId: f.sample.id,
            revision: 1,
            specHash: 'x',
            snapshot: {},
            customerId: f.sample.customerId,
            brandId: f.sample.brandId,
          },
        }),
      ).rejects.toThrow(); // unique revision
    });

    it('rejection returns the sample to production (reason required) and creates no snapshot', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const id = f.sample.id;
      const req = (await requestSample(id).expect(201)).body;
      await a.sales
        .post(`/admin/approvals/${req.id}/reject`, { sourceNote: 'WhatsApp' })
        .expect(400); // reason required
      const rej = (
        await a.sales
          .post(`/admin/approvals/${req.id}/reject`, {
            sourceNote: 'WhatsApp',
            responseNote: 'Sleeves are too long',
          })
          .expect(200)
      ).body;
      expect(rej).toMatchObject({
        status: 'REJECTED',
        responseNote: 'Sleeves are too long',
      });
      expect((await sample(id)).status).toBe('IN_PRODUCTION');
      await a.admin.get(`/admin/samples/${id}/production-spec`).expect(404);
      const hist = (await a.admin.get(`/admin/samples/${id}/status-history`))
        .body;
      expect(hist.at(-1)).toMatchObject({
        action: 'sample-rejected',
        reason: 'Sleeves are too long',
        toStatus: 'IN_PRODUCTION',
      });
      await a.admin.post(`/admin/samples/${id}/finish-production`).expect(200);
      await (await approveSample(id)).res.expect(200);
      expect((await spec(id)).revision).toBe(1);
    });

    it('freezes only once, even if approved concurrently or requested twice', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const id = f.sample.id;
      const requests = await Promise.all([
        requestSample(id),
        requestSample(id),
      ]);
      expect(
        requests
          .map((r) => r.status)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual([201, 409]);
      const req = requests.find((r) => r.status === 201)!.body;
      const results = await Promise.all([
        a.sales.post(`/admin/approvals/${req.id}/approve`, {
          sourceNote: 'WhatsApp',
        }),
        a.sales.post(`/admin/approvals/${req.id}/approve`, {
          sourceNote: 'WhatsApp',
        }),
        a.sales.post(`/admin/approvals/${req.id}/approve`, {
          sourceNote: 'WhatsApp',
        }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        await prisma.sampleProductionSpec.count({ where: { sampleId: id } }),
      ).toBe(1);
      expect((await sample(id)).status).toBe('APPROVED');
    });

    it('requires an APPROVED artwork version for decorations that need artwork', async () => {
      const d = await completeDraft(app, a.admin, refs);
      const art = (await a.admin.upload('ARTWORK', 'logo.png').expect(201))
        .body;
      const artwork = (
        await a.admin
          .post('/admin/artworks', {
            brandId: d.brandId,
            name: 'Logo',
            purpose: 'FRONT_PRINT',
            assetId: art.id,
          })
          .expect(201)
      ).body;
      await a.admin
        .post(`/admin/samples/${d.id}/decorations`, {
          printMethodId: refs.printMethodId,
          placement: 'Chest',
          width: 20,
          height: 8,
          unit: 'CM',
          colorCount: 2,
          artworkRequired: true,
          artworkId: artwork.id,
        })
        .expect(201);
      const flow: Flow = await quoteAndAccept(a, d);
      await produce(a, flow);

      const req = (await requestSample(d.id).expect(201)).body;
      const blocked = await a.sales
        .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'WhatsApp' })
        .expect(409);
      expect(blocked.body.message).toMatch(/has no APPROVED version/);
      expect((await sample(d.id)).status).toBe('AWAITING_APPROVAL');
      expect(
        (await prisma.approval.findUniqueOrThrow({ where: { id: req.id } }))
          .status,
      ).toBe('PENDING');
      expect(
        await prisma.sampleProductionSpec.count({ where: { sampleId: d.id } }),
      ).toBe(0);

      // approve the artwork version (customer OK), then the sample
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
          sourceNote: 'WhatsApp proof approved',
        })
        .expect(200);
      await a.sales
        .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'WhatsApp' })
        .expect(200);
      const snap = (await spec(d.id)).snapshot;
      expect(snap.decorations).toHaveLength(1);
      expect(snap.decorations[0]).toMatchObject({
        placement: 'Chest',
        width: '20.00',
        height: '8.00',
        unit: 'CM',
        colorCount: 2,
        artworkRequired: true,
      });
      expect(snap.decorations[0].printMethod).toMatchObject({ code: 'DTF' });
      expect(snap.decorations[0].artwork).toMatchObject({
        artworkId: artwork.id,
        artworkVersionId: artwork.versions[0].id,
        versionNumber: 1,
      });
      expect(snap.decorations[0].artwork.file).toMatchObject({
        assetId: art.id,
      });
      expect(snap.decorations[0].artwork.file.checksum).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });

    it('captures accessories, labels and custom values as they were approved', async () => {
      const { customer, brand } = await (
        await import('./support/factory.js')
      ).createCustomerWithBrand(a.admin);
      const color = await prisma.fabricColor.findFirst({
        where: { fabricId: refs.fabricId },
      });
      void color;
      const d = await completeDraft(app, a.admin, refs, {
        notes: 'rush job',
        factoryInstructions: 'Pre-wash the fabric',
      });
      await a.admin
        .post(`/admin/samples/${d.id}/accessories`, {
          accessoryId: refs.accessoryId,
          quantity: 2,
          notes: 'metal',
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${d.id}/accessories`, {
          customName: 'Wooden toggle',
          quantity: 4,
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${d.id}/components`, {
          componentOptionId: refs.componentId,
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${d.id}/components`, {
          customName: 'Gift ribbon',
          notes: 'red',
        })
        .expect(201);
      await produce(a, await quoteAndAccept(a, d));
      await (await approveSample(d.id)).res.expect(200);
      const snap = (await spec(d.id)).snapshot;
      expect(
        snap.accessories.map((x: any) => [x.name, x.custom, x.quantity]),
      ).toEqual(
        expect.arrayContaining([
          ['Zip', false, 2],
          ['Wooden toggle', true, 4],
        ]),
      );
      expect(
        snap.labelsAndPackaging.map((x: any) => [x.name, x.custom]),
      ).toEqual(
        expect.arrayContaining([
          ['Polybag', false],
          ['Gift ribbon', true],
        ]),
      );
      expect(snap.instructions).toMatchObject({
        notes: 'rush job',
        factoryInstructions: 'Pre-wash the fabric',
      });
      void customer;
      void brand;
    });

    it('locks an approved sample, allows a revision, and completes it', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      const id = f.sample.id;
      await (await approveSample(id)).res.expect(200);
      await a.admin
        .patch(`/admin/samples/${id}`, { notes: 'late change' })
        .expect(409);
      await a.admin.patch(`/admin/samples/${id}`, { gsm: 150 }).expect(409);
      await a.admin
        .post(`/admin/samples/${id}/decorations`, {
          printMethodId: refs.printMethodId,
          placement: 'Back',
        })
        .expect(409);
      await a.admin
        .post(`/admin/samples/${id}/hold`, { reason: 'x' })
        .expect(409);
      await a.admin
        .post(`/admin/samples/${id}/cancel`, { reason: 'x' })
        .expect(409);
      await a.admin.del(`/admin/samples/${id}`).expect(409);
      const rev = (
        await a.sales.post(`/admin/samples/${id}/revise`).expect(201)
      ).body;
      expect(rev).toMatchObject({
        status: 'DRAFT',
        revisionNumber: 2,
        revisionOfId: id,
      });
      await a.admin.get(`/admin/samples/${rev.id}/production-spec`).expect(404); // the revision has nothing frozen yet
      expect((await spec(id)).revision).toBe(1); // the original reference is untouched

      const done = await a.admin
        .post(`/admin/samples/${id}/complete`)
        .expect(200);
      expect(done.body).toMatchObject({
        status: 'COMPLETED',
        allowedActions: [],
      });
      expect(done.body.completedAt).not.toBeNull();
      expect(await spec(id)).toBeDefined();
    });

    it('supports an internal PRODUCTION_SPEC sign-off on the frozen specification', async () => {
      const f = await toAwaitingApproval(app, a, refs);
      await (await approveSample(f.sample.id)).res.expect(200);
      const frozen = await spec(f.sample.id);
      const other = await toAwaitingApproval(app, a, refs);
      await (await approveSample(other.sample.id)).res.expect(200);
      await a.sales
        .post(`/admin/samples/${f.sample.id}/approvals`, {
          type: 'PRODUCTION_SPEC',
          productionSpecId: (await spec(other.sample.id)).id,
        })
        .expect(404);
      const req = (
        await a.sales
          .post(`/admin/samples/${f.sample.id}/approvals`, {
            type: 'PRODUCTION_SPEC',
            productionSpecId: frozen.id,
          })
          .expect(201)
      ).body;
      await a.finance
        .post(`/admin/approvals/${req.id}/approve`, { recordedAs: 'INTERNAL' })
        .expect(403);
      const done = (
        await a.sales
          .post(`/admin/approvals/${req.id}/approve`, {
            recordedAs: 'INTERNAL',
          })
          .expect(200)
      ).body;
      expect(done).toMatchObject({
        type: 'PRODUCTION_SPEC',
        status: 'APPROVED',
        mode: 'STAFF_INTERNAL',
        productionSpecId: frozen.id,
      });
      expect(await spec(f.sample.id)).toEqual(frozen); // sign-off does not alter the spec
    });
  });

  it('keeps production roles out of approvals and frozen specs', async () => {
    const f = await toAwaitingApproval(app, a, refs);
    await (await approveSample(f.sample.id)).res.expect(200);
    await a.sewing
      .get(`/admin/samples/${f.sample.id}/production-spec`)
      .expect(403); // Phase 4 will expose task-specific views instead
    await a.finance
      .get(`/admin/samples/${f.sample.id}/production-spec`)
      .expect(200);
    await api(app, '')
      .get(`/admin/samples/${f.sample.id}/production-spec`)
      .expect(401);
  });
});
