import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  currentStage,
  makeFloor,
  makeWorker,
  type Floor,
} from './support/floor.js';
import {
  approvedReferenceSample,
  readyOrder,
  type ApprovedSample,
} from './support/orders.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

describe('QR job cards (Phase 6B, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let admin: Api;

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
  });
  afterAll(() => app.close());

  const newJob = async (priority = 'HIGH') => {
    const order = await readyOrder(a.admin, s, { priority });
    const job = (
      await a.admin
        .post(`/admin/orders/${order.id}/create-factory-job`)
        .expect(201)
    ).body as { id: string; jobNumber: string };
    return { order, job };
  };
  const generate = async (jobId: string) =>
    (await admin.post(`/admin/factory-jobs/${jobId}/qr`).expect(201)).body as {
      token: string;
      url: string;
      qrSvg: string;
    };
  const scan = (who: Api, token: string) => who.get(`/factory/qr/${token}`);

  describe('token lifecycle', () => {
    it('generates an opaque token that is not derived from the job and stores only its hash', async () => {
      const { job } = await newJob();
      expect(
        (await admin.get(`/admin/factory-jobs/${job.id}/qr`).expect(200)).body,
      ).toMatchObject({ jobId: job.id, hasActiveToken: false, active: null });
      const issue = await generate(job.id);
      expect(issue.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
      expect(issue.url).toBe(`http://localhost:5173/q/${issue.token}`);
      expect(
        issue.qrSvg.startsWith('<svg') || issue.qrSvg.startsWith('<?xml'),
      ).toBe(true);
      for (const leak of [job.id, job.jobNumber, job.id.replace(/-/g, '')])
        expect(issue.token.toLowerCase()).not.toContain(leak.toLowerCase());
      const row = await prisma.factoryJobQrToken.findFirstOrThrow({
        where: { jobId: job.id },
      });
      expect(row.tokenHash).toBe(sha(issue.token));
      expect(row.tokenHash).not.toBe(issue.token);
      expect(JSON.stringify(row)).not.toContain(issue.token);
      // the status endpoint never reveals the token
      const status = (
        await admin.get(`/admin/factory-jobs/${job.id}/qr`).expect(200)
      ).body;
      expect(status).toMatchObject({ hasActiveToken: true });
      expect(JSON.stringify(status)).not.toContain(issue.token);
      expect(status.active).toMatchObject({
        active: true,
        revokedAt: null,
        lastScannedAt: null,
      });
      await admin.post(`/admin/factory-jobs/${job.id}/qr`).expect(409); // already has one: rotate instead
      expect(await auditActions(app, job.id)).toContain('qr_token.generated');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: job.id, action: 'qr_token.generated' },
      });
      expect(JSON.stringify(audit.metadata)).not.toContain(issue.token);
    });

    it('rotating replaces the token: the old printed card stops working, the new one works', async () => {
      const { job } = await newJob();
      const w = await assignWorker(
        a.admin,
        floor,
        await currentStage(a.admin, job.id, 'FABRIC_PREPARATION'),
      );
      const first = await generate(job.id);
      await scan(w.api, first.token).expect(200);
      const second = (
        await admin.post(`/admin/factory-jobs/${job.id}/qr/rotate`).expect(200)
      ).body;
      expect(second.token).not.toBe(first.token);
      await scan(w.api, first.token).expect(404);
      await scan(w.api, second.token).expect(200);
      const rows = await prisma.factoryJobQrToken.findMany({
        where: { jobId: job.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]!.revokedAt).toBeTruthy();
      expect(rows[1]).toMatchObject({
        revokedAt: null,
        rotatedFromId: rows[0]!.id,
      });
      const status = (
        await admin.get(`/admin/factory-jobs/${job.id}/qr`).expect(200)
      ).body;
      expect(status.history).toHaveLength(2);
      expect(await auditActions(app, job.id)).toEqual(
        expect.arrayContaining(['qr_token.generated', 'qr_token.rotated']),
      );
      // one active token at all times, enforced by the database
      await expect(
        prisma.factoryJobQrToken.create({
          data: {
            jobId: job.id,
            tokenHash: sha('x'),
            createdByUserId: a.salesUserId,
          },
        }),
      ).rejects.toThrow();
    });

    it('revoking makes the code useless; a new one can be generated afterwards', async () => {
      const { job } = await newJob();
      const w = await assignWorker(
        a.admin,
        floor,
        await currentStage(a.admin, job.id, 'FABRIC_PREPARATION'),
      );
      const issue = await generate(job.id);
      const res = (
        await admin.post(`/admin/factory-jobs/${job.id}/qr/revoke`).expect(200)
      ).body;
      expect(res).toMatchObject({ hasActiveToken: false });
      await scan(w.api, issue.token).expect(404);
      await admin.post(`/admin/factory-jobs/${job.id}/qr/revoke`).expect(409);
      const again = await generate(job.id);
      expect(again.token).not.toBe(issue.token);
      await scan(w.api, again.token).expect(200);
      await scan(w.api, issue.token).expect(404);
      expect(await auditActions(app, job.id)).toEqual(
        expect.arrayContaining(['qr_token.revoked']),
      );
    });

    it('a rotating token can be rotated even when none exists; a cancelled job gets no code', async () => {
      const { job } = await newJob();
      const issue = (
        await admin.post(`/admin/factory-jobs/${job.id}/qr/rotate`).expect(200)
      ).body;
      expect(issue.token).toHaveLength(43);
      const { job: other } = await newJob();
      await a.admin
        .post(`/admin/factory-jobs/${other.id}/cancel`, {
          reason: 'Customer cancelled the order',
        })
        .expect(200);
      await admin.post(`/admin/factory-jobs/${other.id}/qr`).expect(409);
      await admin
        .post('/admin/factory-jobs/5c7e1b88-0000-4000-8000-000000000000/qr')
        .expect(404);
    });

    it('is protected by permission, and the database keeps tokens immutable', async () => {
      const { job } = await newJob();
      await a.sales.post(`/admin/factory-jobs/${job.id}/qr`).expect(403);
      await a.sales.get(`/admin/factory-jobs/${job.id}/qr`).expect(403);
      await floor.sewing.api
        .post(`/admin/factory-jobs/${job.id}/qr`)
        .expect(403);
      const issue = await generate(job.id);
      void issue;
      const row = await prisma.factoryJobQrToken.findFirstOrThrow({
        where: { jobId: job.id },
      });
      await expect(
        prisma.factoryJobQrToken.update({
          where: { id: row.id },
          data: { tokenHash: sha('other') },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.factoryJobQrToken.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      await admin.post(`/admin/factory-jobs/${job.id}/qr/revoke`).expect(200);
      await expect(
        prisma.factoryJobQrToken.update({
          where: { id: row.id },
          data: { revokedAt: null },
        }),
      ).rejects.toThrow();
    });
  });

  describe('scanning is identification, never authentication', () => {
    it('needs a signed-in staff member and then applies the normal assignment rules', async () => {
      const { job } = await newJob();
      const fabric = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const worker = await assignWorker(a.admin, floor, fabric);
      const { token } = await generate(job.id);
      await api(app, 'not-a-token').get(`/factory/qr/${token}`).expect(401);
      await api(app, '').get(`/factory/qr/${token}`).expect(401);
      // the assigned worker sees the card and their own task, with what they may do
      const res = (await scan(worker.api, token).expect(200)).body;
      expect(res.card).toMatchObject({
        jobId: job.id,
        jobNumber: job.jobNumber,
        kind: 'BULK',
        quantity: 100,
        priority: 'HIGH',
      });
      expect(res.myTasks).toHaveLength(1);
      expect(res.myTasks[0]).toMatchObject({
        stage: { id: fabric.id },
        allowedActions: expect.arrayContaining(['START']),
      });
      expect(res.myTasks[0].taskView).toBeDefined();
      // somebody not assigned to the job is told what an unknown code gets
      const stranger = await makeWorker(app, 'FABRIC');
      const unknown = await scan(worker.api, 'x'.repeat(43)).expect(404);
      const denied = await scan(stranger.api, token).expect(404);
      expect(denied.body.message).toBe(unknown.body.message);
      // a role without staff task access cannot even try
      await scan(a.finance, token).expect(403);
      await scan(a.sales, token).expect(403);
      // the scan does not grant actions on stages the person is not assigned to
      const pattern = await currentStage(a.admin, job.id, 'PATTERN_MAKING');
      expect(
        res.myTasks.map((t: { stage: { id: string } }) => t.stage.id),
      ).not.toContain(pattern.id);
      const tryOther = await worker.api.post(
        `/staff/job-stages/${pattern.id}/start`,
      );
      expect(tryOther.status).toBeGreaterThanOrEqual(400);
      expect(
        (await prisma.jobStage.findUniqueOrThrow({ where: { id: pattern.id } }))
          .status,
      ).toBe('WAITING');
      expect(
        (await stranger.api.post(`/staff/job-stages/${fabric.id}/start`))
          .status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await prisma.jobStage.findUniqueOrThrow({ where: { id: fabric.id } }))
          .status,
      ).toBe('READY');
      // lastScannedAt is kept
      const row = await prisma.factoryJobQrToken.findFirstOrThrow({
        where: { jobId: job.id },
      });
      expect(row.lastScannedAt).toBeTruthy();
    });

    it('people with jobs.read_all see the card but get no tasks and no actions', async () => {
      const { job } = await newJob();
      const { token } = await generate(job.id);
      const planner = await createUserAndLogin(app, {
        permissions: ['jobs.read_assigned', 'jobs.read_all'],
      });
      const res = (await scan(api(app, planner.accessToken), token).expect(200))
        .body;
      expect(res.card.jobId).toBe(job.id);
      expect(res.myTasks).toEqual([]);
    });

    it('malformed, unknown, revoked and rotated codes are indistinguishable', async () => {
      const { job } = await newJob();
      const w = await assignWorker(
        a.admin,
        floor,
        await currentStage(a.admin, job.id, 'FABRIC_PREPARATION'),
      );
      const { token } = await generate(job.id);
      await admin.post(`/admin/factory-jobs/${job.id}/qr/revoke`).expect(200);
      const bodies = await Promise.all(
        [
          token,
          'short',
          'x'.repeat(43),
          `${token}extra`,
          '../../etc/passwd',
          'a'.repeat(200),
        ].map(
          async (t) =>
            (await scan(w.api, encodeURIComponent(t)).expect(404)).body.message,
        ),
      );
      expect(new Set(bodies).size).toBe(1);
    });
  });

  describe('the job card', () => {
    it('carries what the floor needs and nothing commercial or personal', async () => {
      const { order, job } = await newJob('URGENT');
      await prisma.customer.update({
        where: { id: s.customerId },
        data: { email: 'private@example.com', phone: '+201005550000' },
      });
      const card = (
        await admin.get(`/admin/factory-jobs/${job.id}/job-card`).expect(200)
      ).body;
      expect(card).toMatchObject({
        jobId: job.id,
        jobNumber: job.jobNumber,
        kind: 'BULK',
        orderNumber: order.orderNumber,
        quantity: 100,
        priority: 'URGENT',
        status: 'READY',
      });
      expect(card.brand).toBeTruthy();
      expect(card.sampleNumber).toBe(s.sampleNumber);
      expect(card.currentStages[0]).toMatchObject({
        stageCode: 'FABRIC_PREPARATION',
        status: 'READY',
      });
      expect(card.specification).toMatchObject({ kind: 'APPROVED_REFERENCE' });
      expect(card.specification.reference).toHaveLength(12);
      expect(card.material).toHaveProperty('fabric');
      const text = JSON.stringify(card);
      for (const forbidden of [
        'private@example.com',
        '+201005550000',
        'whatsapp',
        'unitPrice',
        'amount',
        'price',
        'payment',
        'quotation',
        'customerNumber',
        'displayName',
      ])
        expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      expect(Object.keys(card).sort()).toEqual([
        'batchNumber',
        'brand',
        'currentStages',
        'instructions',
        'jobId',
        'jobNumber',
        'kind',
        'material',
        'orderNumber',
        'priority',
        'product',
        'quantity',
        'sampleNumber',
        'specification',
        'status',
        'targetDate',
      ]);
      await a.sales.get(`/admin/factory-jobs/${job.id}/job-card`).expect(403);
    });

    it('prints as deterministic HTML with the active QR code inline and no scripts', async () => {
      const { job } = await newJob();
      const before = await admin
        .get(`/admin/factory-jobs/${job.id}/job-card/print`)
        .expect(200);
      expect(before.headers['content-type']).toMatch(/text\/html/);
      expect(before.headers['cache-control']).toBe('no-store');
      expect(before.text).toContain(job.jobNumber);
      expect(before.text).not.toContain('<svg'); // no QR yet
      await generate(job.id);
      const printed = (
        await admin
          .get(`/admin/factory-jobs/${job.id}/job-card/print`)
          .expect(200)
      ).text;
      expect(printed).toContain('<svg');
      expect(printed).toContain('Scan with the factory app');
      expect(printed).not.toMatch(/<script|onerror|javascript:/i);
      expect(printed).toContain('<table>');
      expect(
        (
          await admin
            .get(`/admin/factory-jobs/${job.id}/job-card/print`)
            .expect(200)
        ).text,
      ).toBe(printed); // repeatable
      await admin.post(`/admin/factory-jobs/${job.id}/qr/rotate`).expect(200);
      expect(
        (
          await admin
            .get(`/admin/factory-jobs/${job.id}/job-card/print`)
            .expect(200)
        ).text,
      ).not.toBe(printed); // the new code is on the card
      await a.sales
        .get(`/admin/factory-jobs/${job.id}/job-card/print`)
        .expect(403);
    });
  });
});
