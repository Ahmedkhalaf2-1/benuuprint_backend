import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
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
  type Api,
  type Refs,
} from './support/factory.js';
import {
  assignWorker,
  createJob,
  currentStage,
  makeFloor,
  makeWorker,
  paidSample,
  type Floor,
} from './support/floor.js';
import {
  approvedReferenceSample,
  packagingBody,
  readyOrder,
  standardItems,
  type ApprovedSample,
} from './support/orders.js';

function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const decode = (hex: string) => {
    const bytes = Buffer.from(hex, 'hex');
    return bytes[0] === 0xfe && bytes[1] === 0xff
      ? bytes.subarray(2).swap16().toString('utf16le')
      : bytes.toString('latin1');
  };
  const out: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\]\s*TJ/g))
    out.push(
      [...m[1]!.matchAll(/<([0-9a-fA-F]+)>/g)]
        .map((x) => decode(x[1]!))
        .join(''),
    );
  for (const m of raw.matchAll(/<([0-9a-fA-F]{2,})>\s*Tj/g))
    out.push(decode(m[1]!));
  for (const m of raw.matchAll(
    /\/(?:Title|Author|Subject|Keywords)\s*<([0-9a-fA-F]+)>/g,
  ))
    out.push(decode(m[1]!));
  return `${raw}\n${out.join('\n')}`;
}

describe('Tech packs (Phase 6B, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let admin: Api;
  let generator: Api;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    admin = api(
      app,
      (await createUserAndLogin(app, { roleCodes: ['ADMIN'] })).accessToken,
    );
    generator = api(
      app,
      (
        await createUserAndLogin(app, {
          permissions: ['tech_packs.read', 'tech_packs.generate'],
        })
      ).accessToken,
    );
  }, 120_000);
  afterAll(() => app.close());

  const download = async (url: string) => {
    // the local provider returns a path; a cloud provider would return an absolute URL
    const path = url.startsWith('http')
      ? new URL(url).pathname + new URL(url).search
      : url;
    return (await request(app.getHttpServer()).get(path).expect(200))
      .body as Buffer;
  };
  const version = async (id: string) =>
    (await admin.get(`/admin/tech-pack-versions/${id}`).expect(200)).body;
  const genOrder = async (id: string, who: Api = admin) =>
    (await who.post(`/admin/orders/${id}/tech-pack`).expect(201)).body;
  const confirmedOrder = async () => readyOrder(a.admin, s, {});

  // ───────────────────────── sample packs ─────────────────────────
  describe('sample production', () => {
    it('is generated from the PRE_PRODUCTION specification, not from anything mutable', async () => {
      const flow = await paidSample(app, a, refs);
      await admin
        .post(`/admin/samples/${flow.sample.id}/tech-pack`)
        .expect(409); // nothing frozen yet
      expect(
        (
          await admin
            .get(`/admin/samples/${flow.sample.id}/tech-pack`)
            .expect(200)
        ).body,
      ).toMatchObject({ exists: false, versions: [] });
      const job = await createJob(a.admin, flow.sample.id); // freezes the PRE_PRODUCTION spec
      const spec = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { sampleId: flow.sample.id, kind: 'PRE_PRODUCTION' },
      });
      const v1 = (
        await admin
          .post(`/admin/samples/${flow.sample.id}/tech-pack`)
          .expect(201)
      ).body;
      expect(v1).toMatchObject({
        version: 1,
        status: 'DRAFT',
        kind: 'SAMPLE',
        stale: false,
        hasDocument: true,
        sampleProductionSpecId: spec.id,
        orderProductionSpecId: null,
      });
      expect(v1.reference).toMatch(/^TPK-\d{6}$/);
      expect(v1.content.source).toMatchObject({
        sampleNumber: flow.sample.sampleNumber,
        specification: {
          id: spec.id,
          kind: 'PRE_PRODUCTION',
          revision: spec.revision,
          hash: spec.specHash,
        },
        orderSpecification: null,
      });
      expect(v1.content.order).toBeNull();
      expect(v1.content.document).toMatchObject({
        kind: 'SAMPLE',
        version: 1,
        reference: v1.reference,
      });
      expect(v1.content.jobs).toEqual([
        { jobNumber: job.jobNumber, status: expect.any(String) },
      ]);
      expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const row = await prisma.techPackVersion.findUniqueOrThrow({
        where: { id: v1.id },
      });
      expect(row.sampleProductionSpecId).toBe(spec.id);

      // editing master data afterwards does not change what was frozen
      const fabricBefore = v1.content.fabric.name as string;
      await prisma.fabric.update({
        where: { id: refs.fabricId },
        data: { name: 'Renamed After The Fact' },
      });
      try {
        const v2 = (
          await admin
            .post(`/admin/samples/${flow.sample.id}/tech-pack`)
            .expect(201)
        ).body;
        expect(v2.version).toBe(2);
        expect(v2.content.fabric.name).toBe(fabricBefore);
        expect((await version(v1.id)).contentHash).toBe(v1.contentHash);
      } finally {
        await prisma.fabric.update({
          where: { id: refs.fabricId },
          data: { name: fabricBefore },
        });
      }
      await admin
        .post('/admin/samples/5c7e1b88-0000-4000-8000-000000000000/tech-pack')
        .expect(404);
    }, 90_000);
  });

  // ───────────────────────── bulk packs ─────────────────────────
  describe('bulk orders', () => {
    it('uses the APPROVED_REFERENCE plus the order specification in force, and snapshots packaging and QC', async () => {
      const order = await confirmedOrder();
      await a.admin
        .put(`/admin/orders/${order.id}/packaging`, packagingBody)
        .expect(200);
      const full = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      const v = await genOrder(order.id);
      expect(v).toMatchObject({
        kind: 'ORDER',
        version: 1,
        status: 'DRAFT',
        sampleProductionSpecId: full.approvedProductionSpecId,
        orderProductionSpecId: full.currentSpecId,
      });
      const ref = await prisma.sampleProductionSpec.findUniqueOrThrow({
        where: { id: full.approvedProductionSpecId },
      });
      expect(ref.kind).toBe('APPROVED_REFERENCE');
      expect(v.content.source.specification).toMatchObject({
        id: ref.id,
        kind: 'APPROVED_REFERENCE',
      });
      expect(v.content.source.orderSpecification).toMatchObject({
        id: full.currentSpecId,
        revision: 1,
      });
      expect(v.content.order).toMatchObject({
        orderNumber: order.orderNumber,
        totalQuantity: 100,
      });
      expect(
        v.content.order.items[0].variants.map(
          (x: { quantity: number }) => x.quantity,
        ),
      ).toEqual([60, 40]);
      expect(v.content.packaging).toMatchObject({
        foldingInstructions: 'Fold in thirds, logo up',
        polybagRequired: true,
        unitsPerCarton: 25,
      });
      expect(v.content.packaging.components[0]).toMatchObject({
        name: 'Branded hang tag',
        quantityPerUnit: 1,
      });
      expect(v.content.qcRequirements.length).toBeGreaterThan(0);
      expect(v.content.qcRequirements[0].items.length).toBeGreaterThan(0);
      for (const k of [
        'product',
        'fabric',
        'color',
        'gsm',
        'fabricProvider',
        'fit',
        'decorations',
        'accessories',
        'labelsAndPackaging',
        'instructions',
        'customer',
        'brand',
      ])
        expect(v.content).toHaveProperty(k);
      expect(v.content.customer.displayName).toBeTruthy(); // the admin copy keeps the customer; the floor copy does not
    }, 60_000);

    it('an unconfirmed order has no frozen specification yet', async () => {
      const draft = (
        await a.sales
          .post(`/admin/samples/${s.sampleId}/create-order`, {
            items: standardItems(s),
          })
          .expect(201)
      ).body;
      await admin.post(`/admin/orders/${draft.id}/tech-pack`).expect(409);
      await admin
        .post('/admin/orders/5c7e1b88-0000-4000-8000-000000000000/tech-pack')
        .expect(404);
    });

    it('a revision makes the issued version stale; a pre-revision draft can no longer be issued', async () => {
      const order = await confirmedOrder();
      const v1 = await genOrder(order.id);
      const draftBeforeRevision = await genOrder(order.id); // supersedes v1 draft
      expect((await version(v1.id)).status).toBe('SUPERSEDED');
      await admin
        .post(`/admin/tech-pack-versions/${draftBeforeRevision.id}/issue`)
        .expect(200);
      await a.admin
        .post(`/admin/orders/${order.id}/revise`, {
          reason: 'customer wants 20 more',
          items: standardItems(s, 80, 40),
        })
        .expect(200);

      const pack = (
        await admin.get(`/admin/orders/${order.id}/tech-pack`).expect(200)
      ).body;
      expect(
        pack.versions.find((x: { status: string }) => x.status === 'ISSUED')
          .stale,
      ).toBe(true);
      const stale = await genOrder(order.id); // a draft made AFTER the revision is current
      expect(stale.stale).toBe(false);
      expect(stale.content.order.totalQuantity).toBe(120);
      expect(stale.orderProductionSpecId).not.toBe(
        draftBeforeRevision.orderProductionSpecId,
      );
      // another revision after that draft was generated makes the draft stale too
      await a.admin
        .post(`/admin/orders/${order.id}/revise`, {
          reason: 'and 10 more',
          items: standardItems(s, 90, 40),
        })
        .expect(200);
      await admin
        .post(`/admin/tech-pack-versions/${stale.id}/issue`)
        .expect(409);
      const fresh = await genOrder(order.id);
      expect(fresh.content.order.totalQuantity).toBe(130);
      await admin
        .post(`/admin/tech-pack-versions/${fresh.id}/issue`)
        .expect(200);
      const after = (
        await admin.get(`/admin/orders/${order.id}/tech-pack`).expect(200)
      ).body;
      expect(
        after.versions.filter((x: { status: string }) => x.status === 'ISSUED'),
      ).toHaveLength(1);
      expect(
        after.versions.find((x: { status: string }) => x.status === 'ISSUED')
          .version,
      ).toBe(fresh.version);
      expect(
        after.versions.find(
          (x: { id: string }) => x.id === draftBeforeRevision.id,
        ).status,
      ).toBe('SUPERSEDED');
      expect(
        after.versions.find(
          (x: { id: string }) => x.id === draftBeforeRevision.id,
        ).supersededReason,
      ).toMatch(/Replaced by version/);
    }, 90_000);

    it('packaging edits after generation do not alter an issued pack; the next version picks them up', async () => {
      const order = await confirmedOrder();
      await a.admin
        .put(`/admin/orders/${order.id}/packaging`, packagingBody)
        .expect(200);
      const v1 = await genOrder(order.id);
      await admin.post(`/admin/tech-pack-versions/${v1.id}/issue`).expect(200);
      await a.admin
        .put(`/admin/orders/${order.id}/packaging`, {
          ...packagingBody,
          unitsPerCarton: 40,
          foldingInstructions: 'Roll instead',
        })
        .expect(200);
      const issued = await version(v1.id);
      expect(issued.content.packaging.unitsPerCarton).toBe(25);
      expect(issued.contentHash).toBe(v1.contentHash);
      const v2 = await genOrder(order.id);
      expect(v2.content.packaging).toMatchObject({
        unitsPerCarton: 40,
        foldingInstructions: 'Roll instead',
      });
    }, 60_000);
  });

  // ───────────────────────── versioning and lifecycle ─────────────────────────
  describe('versioning, issuing and superseding', () => {
    it('keeps one draft and one issued version, and records every step', async () => {
      const order = await confirmedOrder();
      const v1 = await genOrder(order.id);
      const v2 = await genOrder(order.id);
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect((await version(v1.id)).status).toBe('SUPERSEDED'); // an unissued draft is replaced by the newer draft
      expect(
        await prisma.techPackVersion.count({
          where: { techPackId: v1.techPackId, status: 'DRAFT' },
        }),
      ).toBe(1);
      const issued = (
        await admin.post(`/admin/tech-pack-versions/${v2.id}/issue`).expect(200)
      ).body;
      expect(issued).toMatchObject({
        status: 'ISSUED',
        issuedAt: expect.any(String),
      });
      await admin.post(`/admin/tech-pack-versions/${v2.id}/issue`).expect(409);
      await admin.post(`/admin/tech-pack-versions/${v1.id}/issue`).expect(409); // superseded versions cannot come back
      const v3 = await genOrder(order.id);
      await admin.post(`/admin/tech-pack-versions/${v3.id}/issue`).expect(200);
      const second = await version(v2.id);
      expect(second.status).toBe('SUPERSEDED');
      expect(second.supersededReason).toBe('Replaced by version 3');
      // withdrawing needs a reason
      await admin
        .post(`/admin/tech-pack-versions/${v3.id}/supersede`, {})
        .expect(400);
      await admin
        .post(`/admin/tech-pack-versions/${v3.id}/supersede`, {
          reason: 'Wrong fabric noted',
        })
        .expect(200);
      await admin
        .post(`/admin/tech-pack-versions/${v3.id}/supersede`, {
          reason: 'Again please',
        })
        .expect(409);
      expect(
        await prisma.techPackVersion.count({
          where: { techPackId: v1.techPackId, status: 'ISSUED' },
        }),
      ).toBe(0);
      const audit = await auditActions(app, v1.techPackId);
      expect(audit.filter((x) => x === 'tech_pack.generated')).toHaveLength(3);
      expect(audit.filter((x) => x === 'tech_pack.issued')).toHaveLength(2);
      expect(
        audit.filter((x) => x === 'tech_pack.superseded').length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        (await admin.get(`/admin/orders/${order.id}/tech-pack`).expect(200))
          .body.techPack.reference,
      ).toBe(v1.reference);
    }, 60_000);

    it('issuing is an operational step: it does not touch the order or any approval', async () => {
      const order = await confirmedOrder();
      const before = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      const v = await genOrder(order.id);
      await admin.post(`/admin/tech-pack-versions/${v.id}/issue`).expect(200);
      const after = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(
        await prisma.approval.count({
          where: { sampleId: s.sampleId, createdAt: { gt: before.createdAt } },
        }),
      ).toBe(0);
    });

    it('generation under concurrency numbers versions without gaps or duplicates and keeps one draft', async () => {
      const order = await confirmedOrder();
      const res = await Promise.all(
        [1, 2, 3].map(() => admin.post(`/admin/orders/${order.id}/tech-pack`)),
      );
      expect(res.every((r) => r.status === 201)).toBe(true);
      expect(
        res.map((r) => r.body.version as number).sort((x, y) => x - y),
      ).toEqual([1, 2, 3]);
      const pack = await prisma.techPack.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(
        await prisma.techPackVersion.count({
          where: { techPackId: pack.id, status: 'DRAFT' },
        }),
      ).toBe(1);
      expect(
        await prisma.techPack.count({ where: { orderId: order.id } }),
      ).toBe(1);
    }, 60_000);

    it('issued versions are immutable at the database level', async () => {
      const order = await confirmedOrder();
      const v = await genOrder(order.id);
      await admin.post(`/admin/tech-pack-versions/${v.id}/issue`).expect(200);
      const row = await prisma.techPackVersion.findUniqueOrThrow({
        where: { id: v.id },
      });
      await expect(
        prisma.techPackVersion.update({
          where: { id: v.id },
          data: { content: { tampered: true } },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.techPackVersion.update({
          where: { id: v.id },
          data: { contentHash: 'x'.repeat(64) },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.techPackVersion.update({
          where: { id: v.id },
          data: { sampleProductionSpecId: row.orderProductionSpecId! },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.techPackVersion.update({
          where: { id: v.id },
          data: { documentAssetId: null },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.techPackVersion.update({
          where: { id: v.id },
          data: { status: 'DRAFT' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.techPackVersion.update({
          where: { id: v.id },
          data: { issuedAt: new Date() },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.techPackVersion.delete({ where: { id: v.id } }),
      ).rejects.toThrow();
      // the only legal move is ISSUED → SUPERSEDED
      await prisma.techPackVersion.update({
        where: { id: v.id },
        data: {
          status: 'SUPERSEDED',
          supersededAt: new Date(),
          supersededReason: 'test',
        },
      });
      await expect(
        prisma.techPackVersion.update({
          where: { id: v.id },
          data: { status: 'ISSUED' },
        }),
      ).rejects.toThrow();
    }, 60_000);
  });

  // ───────────────────────── document ─────────────────────────
  describe('PDF document', () => {
    it('is a deterministic, private PDF with the reference, version and metadata', async () => {
      const order = await confirmedOrder();
      await a.admin
        .put(`/admin/orders/${order.id}/packaging`, packagingBody)
        .expect(200);
      const v = await genOrder(order.id);
      const asset = await prisma.asset.findFirstOrThrow({
        where: { techPackVersions: { some: { id: v.id } } },
      });
      expect(asset).toMatchObject({
        type: 'TECH_PACK',
        mimeType: 'application/pdf',
        originalName: `${v.reference}-v1.pdf`,
      });
      expect(asset.sizeBytes).toBeGreaterThan(2000);
      expect(asset.storageKey).toMatch(
        /^assets\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/,
      ); // random server key
      const url = (
        await admin
          .get(`/admin/tech-pack-versions/${v.id}/document`)
          .expect(200)
      ).body;
      expect(url.url).toMatch(/\/storage\/local\//);
      expect(new Date(url.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const bytes = await download(url.url);
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      const text = pdfText(bytes);
      expect(text).toContain(v.reference);
      expect(text).toContain('Bulk production tech pack');
      expect(text).toContain(order.orderNumber);
      expect(text).toMatch(/D:\d{14}Z/);
      expect(text).toContain('Fold in thirds');
      expect(text).not.toContain(v.content.customer.displayName); // brand only on the document
      // the content hash says what the PDF was made from
      expect(createHashOf(bytes)).toBe(asset.checksum);
      // a tech pack document cannot be archived
      await a.admin.del(`/admin/assets/${asset.id}`).expect(409);
      await a.sales
        .get(`/admin/tech-pack-versions/${v.id}/document`)
        .expect(200); // tech_packs.read
      await a.finance
        .get(`/admin/tech-pack-versions/${v.id}/document`)
        .expect(403);
    }, 60_000);

    it('carries the job card QR code when the pack points at a single job', async () => {
      const order = await confirmedOrder();
      const job = (
        await a.admin
          .post(`/admin/orders/${order.id}/create-factory-job`)
          .expect(201)
      ).body;
      const withoutQr = await genOrder(order.id);
      expect(withoutQr.content.jobCard).toBeNull();
      const qr = (
        await admin.post(`/admin/factory-jobs/${job.id}/qr`).expect(201)
      ).body;
      const withQr = await genOrder(order.id);
      expect(withQr.content.jobCard).toEqual({ url: qr.url });
      const bytesWith = await download(
        (
          await admin
            .get(`/admin/tech-pack-versions/${withQr.id}/document`)
            .expect(200)
        ).body.url,
      );
      expect(pdfText(bytesWith)).toContain('Scan: job card');
    }, 60_000);
  });

  // ───────────────────────── access ─────────────────────────
  describe('permissions and floor access', () => {
    it('generation, issuing and reading are separate permissions', async () => {
      const order = await confirmedOrder();
      await floor.sewing.api
        .post(`/admin/orders/${order.id}/tech-pack`)
        .expect(403);
      await a.sales.post(`/admin/orders/${order.id}/tech-pack`).expect(403); // tech_packs.read only
      await a.sales.get(`/admin/orders/${order.id}/tech-pack`).expect(200);
      await floor.sewing.api
        .get(`/admin/orders/${order.id}/tech-pack`)
        .expect(403);
      const v = await genOrder(order.id, generator); // a generator may generate …
      await generator
        .post(`/admin/tech-pack-versions/${v.id}/issue`)
        .expect(403); // … but not issue
      await generator
        .post(`/admin/tech-pack-versions/${v.id}/supersede`, {
          reason: 'nope nope',
        })
        .expect(403);
      await a.sales.post(`/admin/tech-pack-versions/${v.id}/issue`).expect(403);
      await floor.sewing.api
        .post(`/admin/tech-pack-versions/${v.id}/issue`)
        .expect(403);
      await admin.post(`/admin/tech-pack-versions/${v.id}/issue`).expect(200);
      await api(app, 'bad')
        .get(`/admin/tech-pack-versions/${v.id}`)
        .expect(401);
    }, 60_000);

    it('floor staff read the ISSUED pack of their own jobs, read-only and without the customer', async () => {
      const order = await confirmedOrder();
      const job = (
        await a.admin
          .post(`/admin/orders/${order.id}/create-factory-job`)
          .expect(201)
      ).body;
      const worker = await assignWorker(
        a.admin,
        floor,
        await currentStage(a.admin, job.id, 'FABRIC_PREPARATION'),
      );
      const stranger = await makeWorker(app, 'FABRIC');
      await worker.api.get(`/staff/jobs/${job.id}/tech-pack`).expect(404); // nothing issued yet
      const draft = await genOrder(order.id);
      await worker.api.get(`/staff/jobs/${job.id}/tech-pack`).expect(404); // drafts are not for the floor
      await admin
        .post(`/admin/tech-pack-versions/${draft.id}/issue`)
        .expect(200);
      const view = (
        await worker.api.get(`/staff/jobs/${job.id}/tech-pack`).expect(200)
      ).body;
      expect(view).toMatchObject({
        reference: draft.reference,
        version: 1,
        stale: false,
      });
      expect(view.content).not.toHaveProperty('customer');
      expect(view.content).not.toHaveProperty('jobCard');
      expect(JSON.stringify(view)).not.toContain(
        draft.content.customer.displayName,
      );
      expect(view.content.order.totalQuantity).toBe(100);
      expect(view.content.brand.name).toBeTruthy();
      // PDF through a short-lived link
      const doc = (
        await worker.api
          .get(`/staff/jobs/${job.id}/tech-pack/document`)
          .expect(200)
      ).body;
      expect((await download(doc.url)).subarray(0, 5).toString()).toBe('%PDF-');
      // not assigned → not found; no permission → forbidden; floor staff can never change anything
      await stranger.api.get(`/staff/jobs/${job.id}/tech-pack`).expect(404);
      await stranger.api
        .get(`/staff/jobs/${job.id}/tech-pack/document`)
        .expect(404);
      await a.finance.get(`/staff/jobs/${job.id}/tech-pack`).expect(403);
      await worker.api.post(`/admin/orders/${order.id}/tech-pack`).expect(403);
      await worker.api
        .post(`/admin/tech-pack-versions/${draft.id}/supersede`, {
          reason: 'I disagree',
        })
        .expect(403);
      await worker.api.get(`/admin/tech-pack-versions/${draft.id}`).expect(403);
    }, 60_000);

    it('a job without a sample/order pack, or an unknown job, is simply not found', async () => {
      const worker = await makeWorker(app, 'FABRIC');
      await worker.api
        .get('/staff/jobs/5c7e1b88-0000-4000-8000-000000000000/tech-pack')
        .expect(404);
      await worker.api.get('/staff/jobs/not-a-uuid/tech-pack').expect(400);
    });
  });
});

import { createHash } from 'node:crypto';
const createHashOf = (b: Buffer) =>
  createHash('sha256').update(b).digest('hex');
