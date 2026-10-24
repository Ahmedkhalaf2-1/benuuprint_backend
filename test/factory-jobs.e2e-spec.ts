import type { INestApplication } from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../src/common/canonical-json.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { auditActions, createTestApp } from './support/app.js';
import {
  completeDraft,
  lookupRefs,
  makeActors,
  toAwaitingPayment,
  type Actors,
  type Refs,
} from './support/factory.js';
import {
  approvedSample,
  paidSample,
  createJob,
  currentStage,
  jobDetail,
  makeFloor,
  runStage,
  STAGE_ORDER,
  type Floor,
} from './support/floor.js';

describe('Factory jobs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
  });
  afterAll(() => app.close());

  describe('creation', () => {
    it('creates JOB-nnnnnn from a paid sample before final approval, pinning spec and workflow', async () => {
      const f = await paidSample(app, a, refs);
      const job = await createJob(a.admin, f.sample.id, { priority: 'HIGH' });
      expect(job.jobNumber).toMatch(/^JOB-\d{6}$/);
      expect(job.status).toBe('READY');
      expect(job.priority).toBe('HIGH');
      expect(job.sampleNumber).toBe(f.sample.sampleNumber);
      expect(job.workflowCode).toBe('BENUE_STANDARD_APPAREL');
      expect(job.stages.map((s) => s.stageCode)).toEqual(STAGE_ORDER);
      const spec = await prisma.sampleProductionSpec.findFirstOrThrow({
        where: { sampleId: f.sample.id },
      });
      expect(job.sampleProductionSpecId).toBe(spec.id);
      expect(job.specHash).toBe(spec.specHash);
      // only the first stage is ready; the rest wait on their dependencies
      expect(job.stages.map((s) => s.status)).toEqual([
        'READY',
        ...Array(9).fill('WAITING'),
      ]);
      expect(await auditActions(app, job.id)).toContain('factory_job.created');
    });

    it('rejects samples that are unpaid, not yet reviewed or already finally approved', async () => {
      const f = await paidSample(app, a, refs);
      const unpaid = await toAwaitingPayment(app, a, refs);
      await a.admin
        .post(`/admin/samples/${unpaid.sample.id}/create-factory-job`)
        .expect(409);
      const draft = await completeDraft(app, a.admin, refs);
      await a.admin
        .post(`/admin/samples/${draft.id}/create-factory-job`)
        .expect(409);
      const approved = await approvedSample(app, a, refs);
      await a.admin
        .post(`/admin/samples/${approved.sample.id}/create-factory-job`)
        .expect(409);
      await createJob(a.admin, f.sample.id);
    });

    it('rejects a duplicate live job and allows a new one after cancellation', async () => {
      const f = await paidSample(app, a, refs);
      const first = await createJob(a.admin, f.sample.id);
      await a.admin
        .post(`/admin/samples/${f.sample.id}/create-factory-job`)
        .expect(409);
      await a.admin
        .post(`/admin/factory-jobs/${first.id}/cancel`, {
          reason: 'wrong spec',
        })
        .expect(200);
      const second = await createJob(a.admin, f.sample.id);
      expect(second.id).not.toBe(first.id);
    });

    it('creates exactly one job when requested concurrently', async () => {
      const f = await paidSample(app, a, refs);
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          a.admin.post(`/admin/samples/${f.sample.id}/create-factory-job`),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      expect(
        await prisma.factoryJob.count({ where: { sampleId: f.sample.id } }),
      ).toBe(1);
    });

    it('freezes a verifiable PRE_PRODUCTION specification when the job is created', async () => {
      const f = await paidSample(app, a, refs);
      const job = await createJob(a.admin, f.sample.id);
      const spec = await prisma.sampleProductionSpec.findUniqueOrThrow({
        where: { id: job.sampleProductionSpecId as string },
      });
      expect(spec.kind).toBe('PRE_PRODUCTION');
      expect(spec.approvalId).toBeNull();
      expect(spec.specHash).toBe(sha256Hex(canonicalJson(spec.snapshot)));
      await expect(
        prisma.sampleProductionSpec.update({
          where: { id: spec.id },
          data: { specHash: 'tampered' },
        }),
      ).rejects.toThrow();
    });

    it('PLANNED job keeps stages WAITING until released', async () => {
      const f = await paidSample(app, a, refs);
      const job = await createJob(a.admin, f.sample.id, { release: false });
      expect(job.status).toBe('PLANNED');
      expect(job.stages.every((s) => s.status === 'WAITING')).toBe(true);
      const released = (
        await a.admin.post(`/admin/factory-jobs/${job.id}/release`).expect(200)
      ).body;
      expect(released.status).toBe('READY');
      expect(
        (await currentStage(a.admin, job.id, 'FABRIC_PREPARATION')).status,
      ).toBe('READY');
    });

    it('needs factory_jobs.manage', async () => {
      const f = await paidSample(app, a, refs);
      await a.sales
        .post(`/admin/samples/${f.sample.id}/create-factory-job`)
        .expect(403);
      await floor.cutting.api
        .post(`/admin/samples/${f.sample.id}/create-factory-job`)
        .expect(403);
    });
  });

  describe('full run', () => {
    it('walks every stage to a completed job and keeps a timeline', async () => {
      const f = await paidSample(app, a, refs);
      const job = await createJob(a.admin, f.sample.id);
      for (const code of STAGE_ORDER) {
        await runStage(app, a.admin, floor, job.id, code);
      }
      const done = await jobDetail(a.admin, job.id);
      expect(done.status).toBe('COMPLETED');
      expect(done.completedAt).toBeTruthy();
      const tl = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?pageSize=100`)
          .expect(200)
      ).body;
      const types = tl.data.map((e: { type: string }) => e.type);
      expect(types[0]).toBe('JOB_CREATED');
      expect(types).toContain('QC_PASSED');
      expect(types.at(-1)).toBe('JOB_COMPLETED');
    });
  });
});
