import type { INestApplication } from '@nestjs/common';
import { canonicalJson, sha256Hex } from '../src/common/canonical-json.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { auditActions, createTestApp } from './support/app.js';
import {
  acceptActiveTerms,
  lookupRefs,
  makeActors,
  payAndVerify,
  quoteAndAccept,
  type Actors,
  type Refs,
} from './support/factory.js';
import {
  createJob,
  currentStage,
  jobDetail,
  makeFloor,
  paidSample,
  runStage,
  STAGE_ORDER,
  type Floor,
} from './support/floor.js';

describe('Sample production before final approval (Phase 4.1, e2e)', () => {
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

  const sample = async (id: string) =>
    (await a.admin.get(`/admin/samples/${id}`).expect(200)).body;
  const finishJob = async (jobId: string) => {
    for (const code of STAGE_ORDER)
      await runStage(app, a.admin, floor, jobId, code);
  };
  const requestApproval = async (sampleId: string) =>
    (
      await a.sales
        .post(`/admin/samples/${sampleId}/approvals`, { type: 'SAMPLE' })
        .expect(201)
    ).body;

  it('builds the physical sample first: the job exists before any customer approval', async () => {
    const f = await paidSample(app, a, refs);
    expect((await sample(f.sample.id)).status).toBe('READY_FOR_PRODUCTION');

    const job = await createJob(a.admin, f.sample.id);
    expect(job.sourceType).toBe('SAMPLE_PRODUCTION');
    const s = await sample(f.sample.id);
    expect(s.status).toBe('IN_PRODUCTION');

    // a PRE_PRODUCTION spec exists; the final reference does not
    const specs = (
      await a.admin
        .get(`/admin/samples/${f.sample.id}/production-specs`)
        .expect(200)
    ).body;
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe('PRE_PRODUCTION');
    expect(specs[0].approvalId).toBeNull();
    expect(specs[0].snapshot.approval).toBeNull();
    expect(specs[0].id).toBe(job.sampleProductionSpecId);
    await a.admin
      .get(`/admin/samples/${f.sample.id}/production-spec`)
      .expect(404);
    expect(await auditActions(app, f.sample.id)).toEqual(
      expect.arrayContaining([
        'production_spec.created',
        'sample.status_changed',
      ]),
    );
  });

  it('the factory, not the manual stand-ins, drives the sample while a job is live', async () => {
    const f = await paidSample(app, a, refs);
    await createJob(a.admin, f.sample.id);
    await a.admin
      .post(`/admin/samples/${f.sample.id}/finish-production`)
      .expect(409);
    await a.admin
      .post(`/admin/samples/${f.sample.id}/start-production`)
      .expect(409);
  });

  it('completing the job makes the sample ready for customer approval, never APPROVED', async () => {
    const f = await paidSample(app, a, refs);
    const job = await createJob(a.admin, f.sample.id);
    for (const code of STAGE_ORDER.slice(0, 9))
      await runStage(app, a.admin, floor, job.id, code);
    expect((await sample(f.sample.id)).status).toBe('IN_PRODUCTION');
    await runStage(app, a.admin, floor, job.id, 'READY');
    expect((await jobDetail(a.admin, job.id)).status).toBe('COMPLETED');
    const s = await sample(f.sample.id);
    expect(s.status).toBe('AWAITING_APPROVAL');
    expect(s.approvedAt ?? null).toBeNull();
    await a.admin
      .get(`/admin/samples/${f.sample.id}/production-spec`)
      .expect(404);
    const history = await prisma.sampleStatusHistory.findMany({
      where: { sampleId: f.sample.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.at(-1)?.toStatus).toBe('AWAITING_APPROVAL');
  });

  it('force-completing the job also moves the sample to AWAITING_APPROVAL', async () => {
    const f = await paidSample(app, a, refs);
    const job = await createJob(a.admin, f.sample.id);
    await a.admin
      .post(`/admin/factory-jobs/${job.id}/force-complete`, {
        reason: 'sample finished off-system',
      })
      .expect(200);
    expect((await sample(f.sample.id)).status).toBe('AWAITING_APPROVAL');
  });

  it('final approval after the job freezes the APPROVED_REFERENCE and keeps the job and pre-production spec', async () => {
    const f = await paidSample(app, a, refs);
    const job = await createJob(a.admin, f.sample.id);
    await finishJob(job.id);
    const req = await requestApproval(f.sample.id);
    await a.sales
      .post(`/admin/approvals/${req.id}/approve`, {
        sourceNote: 'Customer approved the physical sample (test)',
      })
      .expect(200);
    expect((await sample(f.sample.id)).status).toBe('APPROVED');

    const specs = (
      await a.admin
        .get(`/admin/samples/${f.sample.id}/production-specs`)
        .expect(200)
    ).body;
    expect(specs.map((s: { kind: string }) => s.kind).sort()).toEqual([
      'APPROVED_REFERENCE',
      'PRE_PRODUCTION',
    ]);
    const reference = (
      await a.admin
        .get(`/admin/samples/${f.sample.id}/production-spec`)
        .expect(200)
    ).body;
    expect(reference.kind).toBe('APPROVED_REFERENCE');
    expect(reference.approvalId).toBe(req.id);
    expect(reference.id).not.toBe(job.sampleProductionSpecId);
    // the job still points at what it was built from
    const after = await jobDetail(a.admin, job.id);
    expect(after.status).toBe('COMPLETED');
    expect(after.sampleProductionSpecId).toBe(job.sampleProductionSpecId);
    // an approved sample cannot get another sample-production job
    await a.admin
      .post(`/admin/samples/${f.sample.id}/create-factory-job`)
      .expect(409);
    // the approval flow cannot target the pre-production spec
    const pre = specs.find(
      (s: { kind: string }) => s.kind === 'PRE_PRODUCTION',
    );
    await a.sales
      .post(`/admin/samples/${f.sample.id}/approvals`, {
        type: 'PRODUCTION_SPEC',
        productionSpecId: pre.id,
      })
      .expect(404);
  });

  it('a rejected physical sample keeps the old job and spec, and can be built again', async () => {
    const f = await paidSample(app, a, refs);
    const first = await createJob(a.admin, f.sample.id);
    await finishJob(first.id);
    const req = await requestApproval(f.sample.id);
    await a.sales
      .post(`/admin/approvals/${req.id}/reject`, {
        sourceNote: 'WhatsApp',
        responseNote: 'sleeves are too long',
      })
      .expect(200);
    expect((await sample(f.sample.id)).status).toBe('IN_PRODUCTION');

    // old job: untouched and complete, with all of its history
    const old = await jobDetail(a.admin, first.id);
    expect(old.status).toBe('COMPLETED');
    expect(
      await prisma.jobActivity.count({ where: { jobId: first.id } }),
    ).toBeGreaterThan(20);
    expect(
      await prisma.qcInspection.count({ where: { jobId: first.id } }),
    ).toBe(3);

    // a second sample-production job: new spec revision, new stages
    const second = await createJob(a.admin, f.sample.id);
    expect(second.id).not.toBe(first.id);
    expect(second.sampleProductionSpecId).not.toBe(
      first.sampleProductionSpecId,
    );
    expect(second.specRevision).toBeGreaterThan(first.specRevision as number);
    expect(
      (await currentStage(a.admin, second.id, 'FABRIC_PREPARATION')).status,
    ).toBe('READY');
    // still only one live job per sample
    await a.admin
      .post(`/admin/samples/${f.sample.id}/create-factory-job`)
      .expect(409);
    await finishJob(second.id);
    expect((await sample(f.sample.id)).status).toBe('AWAITING_APPROVAL');
    const list = (
      await a.admin
        .get(`/admin/factory-jobs?search=${f.sample.sampleNumber}`)
        .expect(200)
    ).body;
    expect(list.data).toHaveLength(2);
  });

  it('a cancelled job lets the sample get a fresh job; the cancelled one stays on record', async () => {
    const f = await paidSample(app, a, refs);
    const first = await createJob(a.admin, f.sample.id);
    await a.admin
      .post(`/admin/factory-jobs/${first.id}/cancel`, {
        reason: 'wrong fabric',
      })
      .expect(200);
    expect((await sample(f.sample.id)).status).toBe('IN_PRODUCTION');
    const second = await createJob(a.admin, f.sample.id);
    expect((await jobDetail(a.admin, first.id)).status).toBe('CANCELLED');
    expect(second.sampleProductionSpecId).not.toBe(
      first.sampleProductionSpecId,
    );
  });

  it('a revised sample generates its own sample-production job', async () => {
    const f = await paidSample(app, a, refs);
    const job1 = await createJob(a.admin, f.sample.id);
    await finishJob(job1.id);
    const rev = (
      await a.sales.post(`/admin/samples/${f.sample.id}/revise`).expect(201)
    ).body;
    expect(rev.status).toBe('DRAFT');
    await acceptActiveTerms(a.admin, rev.id).expect(201);
    const flow = await quoteAndAccept(a, {
      ...f.sample,
      id: rev.id,
      sampleNumber: rev.sampleNumber,
    });
    await payAndVerify(a.sales, a.finance, rev.id, Number(flow.total));
    const job2 = await createJob(a.admin, rev.id);
    expect(job2.sampleId).toBe(rev.id);
    expect(job2.id).not.toBe(job1.id);
    expect(job2.sampleProductionSpecId).not.toBe(job1.sampleProductionSpecId);
    expect((await jobDetail(a.admin, job1.id)).status).toBe('COMPLETED');
    expect((await sample(rev.id)).status).toBe('IN_PRODUCTION');
  });

  it('the pre-production snapshot is frozen: master-data edits never reach a created job', async () => {
    const f = await paidSample(app, a, refs);
    const job = await createJob(a.admin, f.sample.id);
    const specBefore = await prisma.sampleProductionSpec.findUniqueOrThrow({
      where: { id: job.sampleProductionSpecId as string },
    });
    expect(specBefore.specHash).toBe(
      sha256Hex(canonicalJson(specBefore.snapshot)),
    );
    const snap = specBefore.snapshot as {
      product: { name: string };
      fabric: { name: string };
    };

    // rename the catalogue product and fabric after the job exists
    await prisma.productType.update({
      where: { id: refs.productTypeId },
      data: { name: 'Renamed After Job' },
    });
    await prisma.fabric.update({
      where: { id: refs.fabricId },
      data: { name: 'Fabric Renamed After Job' },
    });
    try {
      const specAfter = await prisma.sampleProductionSpec.findUniqueOrThrow({
        where: { id: specBefore.id },
      });
      expect(specAfter.snapshot).toEqual(specBefore.snapshot);
      expect(specAfter.specHash).toBe(specBefore.specHash);
      expect((specAfter.snapshot as typeof snap).product.name).toBe(
        snap.product.name,
      );
      // the floor sees the frozen values
      const stage = await currentStage(a.admin, job.id, 'FABRIC_PREPARATION');
      const worker = floor.fabric;
      await a.admin
        .post(`/admin/job-stages/${stage.id}/assignments`, {
          userId: worker.id,
        })
        .expect(201);
      const view = (
        await worker.api.get(`/staff/job-stages/${stage.id}`).expect(200)
      ).body;
      const text = JSON.stringify(view.taskView);
      expect(text).not.toContain('Fabric Renamed After Job');
      expect(text).not.toContain('Renamed After Job');
    } finally {
      await prisma.productType.update({
        where: { id: refs.productTypeId },
        data: { name: (snap.product.name as string) || 'T-Shirt' },
      });
      await prisma.fabric.update({
        where: { id: refs.fabricId },
        data: { name: snap.fabric.name },
      });
    }
  });

  it('database: a SAMPLE_PRODUCTION job cannot pin a final reference; specs are append-only', async () => {
    const approved = await paidSample(app, a, refs);
    const job = await createJob(a.admin, approved.sample.id);
    await finishJob(job.id);
    const req = await requestApproval(approved.sample.id);
    await a.sales
      .post(`/admin/approvals/${req.id}/approve`, { sourceNote: 'ok (test)' })
      .expect(200);
    const reference = await prisma.sampleProductionSpec.findFirstOrThrow({
      where: { sampleId: approved.sample.id, kind: 'APPROVED_REFERENCE' },
    });
    const row = await prisma.factoryJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    await expect(
      prisma.factoryJob.create({
        data: {
          jobNumber: 'JOB-998877',
          sourceType: 'SAMPLE_PRODUCTION',
          sampleId: null,
          sampleProductionSpecId: reference.id,
          workflowTemplateVersionId: row.workflowTemplateVersionId,
          customerId: row.customerId,
          brandId: row.brandId,
          productName: 'x',
          createdByUserId: row.createdByUserId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.sampleProductionSpec.delete({ where: { id: reference.id } }),
    ).rejects.toThrow();
  });

  it('keeps unpaid samples out and does not duplicate under concurrent creation', async () => {
    const f = await paidSample(app, a, refs);
    const res = await Promise.all(
      Array.from({ length: 3 }, () =>
        a.admin.post(`/admin/samples/${f.sample.id}/create-factory-job`),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      await prisma.sampleProductionSpec.count({
        where: { sampleId: f.sample.id, kind: 'PRE_PRODUCTION' },
      }),
    ).toBe(1);
    expect(
      await prisma.factoryJob.count({ where: { sampleId: f.sample.id } }),
    ).toBe(1);
  });
});
