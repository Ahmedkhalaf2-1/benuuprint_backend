import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auditActions,
  auth,
  createTestApp,
  createUserAndLogin,
  uniq,
} from './support/app.js';
import {
  api,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';
import {
  answerQc,
  paidSample,
  assignWorker,
  createJob,
  currentStage,
  jobDetail,
  makeFloor,
  makeWorker,
  runStage,
  STAGE_ORDER,
  uploadEvidence,
  workerFor,
  type Floor,
} from './support/floor.js';

describe('Factory operations (e2e)', () => {
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

  const newJob = async (body: object = {}) => {
    const f = await paidSample(app, a, refs);
    return createJob(a.admin, f.sample.id, body);
  };
  /** Run stages up to (not including) `until`. */
  const advanceTo = async (jobId: string, until: string) => {
    for (const code of STAGE_ORDER) {
      if (code === until) return;
      await runStage(app, a.admin, floor, jobId, code);
    }
  };
  const stageOf = (jobId: string, code: string) =>
    currentStage(a.admin, jobId, code);
  const adminStage = async (id: string) =>
    (await a.admin.get(`/admin/job-stages/${id}`).expect(200)).body;

  // ───────────────────────── workflow ─────────────────────────
  describe('workflow templates', () => {
    const stage = (
      stageCode: string,
      sequence: number,
      deps: number[] = [],
    ) => ({
      stageCode,
      sequence,
      dependsOnSequences: deps,
    });
    const makeTemplate = async (
      stages: object[],
      code = uniq('WF').toUpperCase().replace(/-/g, '_'),
    ) =>
      (
        await a.admin
          .post('/admin/workflow-templates', { code, name: code, stages })
          .expect(201)
      ).body;

    it('seeds the default Benue workflow with ten ordered stages and three QC gates', async () => {
      const list = (
        await a.admin
          .get('/admin/workflow-templates?search=BENUE_STANDARD')
          .expect(200)
      ).body;
      const t = list.data.find(
        (x: { code: string }) => x.code === 'BENUE_STANDARD_APPAREL',
      );
      expect(t.isDefault).toBe(true);
      expect(t.activeVersion).toBe(1);
      const v = t.versions.find(
        (x: { status: string }) => x.status === 'ACTIVE',
      );
      expect(v.stages.map((s: { stageCode: string }) => s.stageCode)).toEqual(
        STAGE_ORDER,
      );
      expect(
        v.stages.filter((s: { isQcStage: boolean }) => s.isQcStage),
      ).toHaveLength(3);
    });

    it('rejects cycles, unknown stages and QC gates that check nothing', async () => {
      const bad = (stages: object[]) =>
        a.admin.post('/admin/workflow-templates', {
          code: uniq('BAD').toUpperCase().replace(/-/g, '_'),
          name: 'x',
          stages,
        });
      await bad([stage('CUTTING', 1, [2]), stage('SEWING', 2, [1])]).expect(
        400,
      );
      await bad([stage('NOT_A_STAGE', 1)]).expect(400);
      await bad([stage('QC_GATE_1', 1)]).expect(400);
      await bad([stage('CUTTING', 1), stage('CUTTING', 1)]).expect(400);
    });

    it('freezes an active version; changes go into a new version; running jobs keep theirs', async () => {
      const t = await makeTemplate([
        stage('FABRIC_PREPARATION', 1),
        stage('CUTTING', 2, [1]),
      ]);
      const v1 = t.versions[0];
      expect(v1.status).toBe('DRAFT');
      await a.admin
        .post(`/admin/workflow-template-versions/${v1.id}/activate`)
        .expect(200);
      await a.admin
        .put(`/admin/workflow-template-versions/${v1.id}/stages`, {
          stages: [stage('CUTTING', 1)],
        })
        .expect(409);
      const job1 = await newJob({ workflowTemplateCode: t.code });
      expect(job1.stages).toHaveLength(2);
      expect(job1.workflowVersion).toBe(1);

      const v2 = (
        await a.admin
          .post(`/admin/workflow-templates/${t.id}/versions`, {
            stages: [
              stage('FABRIC_PREPARATION', 1),
              stage('CUTTING', 2, [1]),
              stage('PACKAGING', 3, [2]),
            ],
          })
          .expect(201)
      ).body;
      expect(v2.version).toBe(2);
      await a.admin
        .post(`/admin/workflow-template-versions/${v2.id}/activate`)
        .expect(200);

      const job2 = await newJob({ workflowTemplateCode: t.code });
      expect(job2.stages).toHaveLength(3);
      expect(job2.workflowVersion).toBe(2);
      const again = await jobDetail(a.admin, job1.id);
      expect(again.stages).toHaveLength(2);
      expect(again.workflowVersion).toBe(1);
      const audit = await auditActions(app, t.id);
      expect(audit).toContain('workflow_template.created');
    });

    it('supports explicit dependencies: parallel branches join before the next stage', async () => {
      const t = await makeTemplate([
        stage('FABRIC_PREPARATION', 1),
        stage('CUTTING', 2, [1]),
        stage('PRINTING_EMBROIDERY', 3, [1]),
        stage('SEWING', 4, [2, 3]),
      ]);
      await a.admin
        .post(`/admin/workflow-template-versions/${t.versions[0].id}/activate`)
        .expect(200);
      const job = await newJob({ workflowTemplateCode: t.code });
      await runStage(app, a.admin, floor, job.id, 'FABRIC_PREPARATION');
      expect((await stageOf(job.id, 'CUTTING')).status).toBe('READY');
      expect((await stageOf(job.id, 'PRINTING_EMBROIDERY')).status).toBe(
        'READY',
      );
      expect((await stageOf(job.id, 'SEWING')).status).toBe('WAITING');
      await runStage(app, a.admin, floor, job.id, 'CUTTING');
      expect((await stageOf(job.id, 'SEWING')).status).toBe('WAITING');
      await runStage(app, a.admin, floor, job.id, 'PRINTING_EMBROIDERY');
      expect((await stageOf(job.id, 'SEWING')).status).toBe('READY');
    });

    it('requires workflow_templates permissions', async () => {
      await a.sales.get('/admin/workflow-templates').expect(403);
      await a.sales.post('/admin/workflow-templates', {}).expect(403);
      await floor.cutting.api
        .get('/admin/production-stage-definitions')
        .expect(403);
      const defs = (
        await a.admin.get('/admin/production-stage-definitions').expect(200)
      ).body;
      expect(defs.length).toBeGreaterThanOrEqual(10);
    });
  });

  // ───────────────────────── assignments ─────────────────────────
  describe('assignments and staff task lists', () => {
    it('assigns several eligible people, first one primary, and removes with history', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const other = await makeWorker(app, 'FABRIC');
      const r1 = (
        await a.admin
          .post(`/admin/job-stages/${st.id}/assignments`, {
            userId: floor.fabric.id,
          })
          .expect(201)
      ).body;
      expect(r1.assignees).toHaveLength(1);
      expect(r1.assignees[0].isPrimary).toBe(true);
      const r2 = (
        await a.admin
          .post(`/admin/job-stages/${st.id}/assignments`, {
            userId: other.id,
            context: 'helper',
          })
          .expect(201)
      ).body;
      expect(r2.assignees).toHaveLength(2);
      expect(
        r2.assignees.filter((x: { isPrimary: boolean }) => x.isPrimary),
      ).toHaveLength(1);
      await a.admin
        .post(`/admin/job-stages/${st.id}/assignments`, { userId: other.id })
        .expect(409);
      const removed = (
        await a.admin
          .del(
            `/admin/job-stages/${st.id}/assignments/${r1.assignees[0].assignmentId}`,
          )
          .expect(200)
      ).body;
      expect(removed.assignees).toHaveLength(1);
      expect(removed.assignees[0].isPrimary).toBe(true);
      expect(
        await prisma.stageAssignment.count({ where: { jobStageId: st.id } }),
      ).toBe(2);
      const actions = await auditActions(app, st.id);
      expect(actions.filter((x) => x === 'job_stage.assigned')).toHaveLength(2);
      expect(actions).toContain('job_stage.unassigned');
    });

    it('rejects ineligible roles, users without stage rights and inactive users', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const post = (userId: string) =>
        a.admin.post(`/admin/job-stages/${st.id}/assignments`, { userId });
      await post(floor.sewing.id).expect(400); // not an eligible role
      await post(a.salesUserId).expect(400); // cannot work stages
      const suspended = await createUserAndLogin(app, {
        roleCodes: ['FABRIC'],
      });
      await prisma.user.update({
        where: { id: suspended.user.id },
        data: { status: 'SUSPENDED', isActive: false },
      });
      await post(suspended.user.id).expect(400);
      await post('00000000-0000-4000-8000-000000000000').expect(400);
    });

    it('needs jobs.assign', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      await floor.fabric.api
        .post(`/admin/job-stages/${st.id}/assignments`, {
          userId: floor.fabric.id,
        })
        .expect(403);
      await a.sales
        .post(`/admin/job-stages/${st.id}/assignments`, {
          userId: floor.fabric.id,
        })
        .expect(403);
    });

    it('shows staff only their own stages and jobs', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const mine = await makeWorker(app, 'FABRIC');
      const notMine = await makeWorker(app, 'FABRIC');
      await a.admin
        .post(`/admin/job-stages/${st.id}/assignments`, { userId: mine.id })
        .expect(201);

      const stages = (await mine.api.get('/staff/my-stages').expect(200)).body;
      expect(stages.data.map((s: { id: string }) => s.id)).toContain(st.id);
      expect(
        stages.data.find((s: { id: string }) => s.id === st.id).job.jobNumber,
      ).toBe(job.jobNumber);
      const jobs = (await mine.api.get('/staff/my-jobs').expect(200)).body;
      expect(jobs.data.map((j: { id: string }) => j.id)).toContain(job.id);
      expect(
        jobs.data.find((j: { id: string }) => j.id === job.id).myStages,
      ).toHaveLength(1);

      expect(
        (await notMine.api.get('/staff/my-stages').expect(200)).body.data,
      ).toEqual([]);
      expect(
        (await notMine.api.get('/staff/my-jobs').expect(200)).body.data,
      ).toEqual([]);
      await notMine.api.get(`/staff/job-stages/${st.id}`).expect(404);
      await notMine.api.post(`/staff/job-stages/${st.id}/start`).expect(403);
      await mine.api.get(`/staff/my-stages/${st.id}`).expect(200);
    });

    it("task views contain the department's inputs and never prices or customer contact data", async () => {
      const job = await newJob();
      await advanceTo(job.id, 'CUTTING');
      const cut = await stageOf(job.id, 'CUTTING');
      await assignWorker(a.admin, floor, cut);
      const view = (
        await floor.cutting.api.get(`/staff/job-stages/${cut.id}`).expect(200)
      ).body;
      expect(view.allowedActions).toEqual(expect.arrayContaining(['START']));
      expect(view.taskView.sampleNumber).toBeTruthy();
      const text = JSON.stringify(view);
      for (const forbidden of [
        'unitPrice',
        'lineItems',
        'paymentState',
        'whatsapp',
        'quotation',
        'proofAsset',
        'storageKey',
        'passwordHash',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      const customer = await prisma.customer.findFirstOrThrow({
        where: { id: job.customer.id },
      });
      expect(text).not.toContain(customer.displayName);
      expect(text).not.toContain(customer.customerNumber);
    });
  });

  // ───────────────────────── stage lifecycle ─────────────────────────
  describe('stage start and completion', () => {
    it('enforces assignment, readiness, double start and double complete', async () => {
      const job = await newJob();
      const fab = await stageOf(job.id, 'FABRIC_PREPARATION');
      const cut = await stageOf(job.id, 'CUTTING');
      const w = await assignWorker(a.admin, floor, fab);
      await floor.cutting.api
        .post(`/staff/job-stages/${fab.id}/start`)
        .expect(403); // not assigned
      await assignWorker(a.admin, floor, cut);
      await floor.cutting.api
        .post(`/staff/job-stages/${cut.id}/start`)
        .expect(409); // WAITING
      await w.api.post(`/staff/job-stages/${fab.id}/complete`).expect(409); // not started
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(200);
      await w.api.post(`/staff/job-stages/${fab.id}/start`).expect(409);
      expect((await jobDetail(a.admin, job.id)).status).toBe('IN_PROGRESS');
      await w.api.post(`/staff/job-stages/${fab.id}/complete`).expect(200);
      await w.api.post(`/staff/job-stages/${fab.id}/complete`).expect(409);
      expect((await stageOf(job.id, 'PATTERN_MAKING')).status).toBe('READY');
    });

    it('enforces completion notes and required attachments', async () => {
      const job = await newJob();
      await advanceTo(job.id, 'PATTERN_MAKING');
      const pat = await stageOf(job.id, 'PATTERN_MAKING');
      const w = await assignWorker(a.admin, floor, pat);
      await w.api.post(`/staff/job-stages/${pat.id}/start`).expect(200);
      await w.api.post(`/staff/job-stages/${pat.id}/complete`).expect(400); // note required
      await w.api
        .post(`/staff/job-stages/${pat.id}/complete`, { note: 'pattern ready' })
        .expect(200);

      await advanceTo(job.id, 'PRINTING_EMBROIDERY').catch(() => undefined);
      await runStage(app, a.admin, floor, job.id, 'CUTTING');
      await runStage(app, a.admin, floor, job.id, 'QC_GATE_1');
      const pr = await stageOf(job.id, 'PRINTING_EMBROIDERY');
      const pw = await assignWorker(a.admin, floor, pr);
      await pw.api.post(`/staff/job-stages/${pr.id}/start`).expect(200);
      await pw.api.post(`/staff/job-stages/${pr.id}/complete`).expect(409); // attachment required
      await uploadEvidence(app, pw.token, pr.id, 'PRINT_PROOF').expect(201);
      await pw.api.post(`/staff/job-stages/${pr.id}/complete`).expect(200);
    });

    it('lets the first eligible worker claim an unassigned-by-design stage (READY)', async () => {
      const job = await newJob();
      await advanceTo(job.id, 'READY');
      const ready = await stageOf(job.id, 'READY');
      expect(ready.requiresAssignment).toBe(false);
      const stranger = await makeWorker(app, 'PACKAGING');
      await floor.cutting.api
        .post(`/staff/job-stages/${ready.id}/start`)
        .expect(403); // wrong role
      await stranger.api
        .post(`/staff/job-stages/${ready.id}/start`)
        .expect(200);
      expect(
        (await adminStage(ready.id)).assignees.map(
          (x: { userId: string }) => x.userId,
        ),
      ).toEqual([stranger.id]);
      await stranger.api
        .post(`/staff/job-stages/${ready.id}/complete`)
        .expect(200);
      expect((await jobDetail(a.admin, job.id)).status).toBe('COMPLETED');
    });

    it('cannot remove the last assignee of a stage in progress', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const assignmentId = (await adminStage(st.id)).assignees[0].assignmentId;
      await a.admin
        .del(`/admin/job-stages/${st.id}/assignments/${assignmentId}`)
        .expect(409);
    });

    it('supports stage hold/resume and job hold/resume without losing state', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      await a.admin.post(`/admin/job-stages/${st.id}/hold`, {}).expect(400);
      await a.admin
        .post(`/admin/job-stages/${st.id}/hold`, {
          reason: 'awaiting fabric roll',
        })
        .expect(200);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(409);
      await a.admin.post(`/admin/job-stages/${st.id}/resume`).expect(200);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);

      await a.admin
        .post(`/admin/factory-jobs/${job.id}/hold`, {
          reason: 'customer paused',
        })
        .expect(200);
      expect((await jobDetail(a.admin, job.id)).status).toBe('ON_HOLD');
      await w.api.post(`/staff/job-stages/${st.id}/complete`).expect(409);
      await a.admin.post(`/admin/factory-jobs/${job.id}/resume`).expect(200);
      expect((await jobDetail(a.admin, job.id)).status).toBe('IN_PROGRESS');
      await w.api.post(`/staff/job-stages/${st.id}/complete`).expect(200);
      const actions = await auditActions(app, job.id);
      expect(actions).toEqual(
        expect.arrayContaining(['factory_job.held', 'factory_job.resumed']),
      );
    });

    it('a cancelled job keeps its history and blocks further work', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await makeWorker(app, 'FABRIC');
      await a.admin
        .post(`/admin/job-stages/${st.id}/assignments`, { userId: w.id })
        .expect(201);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/cancel`, {})
        .expect(400);
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/cancel`, {
          reason: 'customer withdrew',
        })
        .expect(200);
      const d = await jobDetail(a.admin, job.id);
      expect(d.status).toBe('CANCELLED');
      expect(d.stages.every((s) => s.status === 'CANCELLED')).toBe(true);
      expect(d.stages).toHaveLength(10);
      await w.api.post(`/staff/job-stages/${st.id}/complete`).expect(409);
      await a.admin.post(`/admin/factory-jobs/${job.id}/resume`).expect(409);
      const tl = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?pageSize=100`)
          .expect(200)
      ).body;
      expect(tl.data.map((e: { type: string }) => e.type)).toContain(
        'JOB_CANCELLED',
      );
      expect(
        (await w.api.get('/staff/my-stages').expect(200)).body.data,
      ).toEqual([]);
    });

    it('records a timeline with actors and keeps it append-only', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const tl = (
        await a.admin.get(`/admin/factory-jobs/${job.id}/timeline`).expect(200)
      ).body;
      const started = tl.data.find(
        (e: { type: string }) => e.type === 'STAGE_STARTED',
      );
      expect(started.actorUserId).toBe(w.id);
      expect(started.jobStageId).toBe(st.id);
      const only = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?jobStageId=${st.id}`)
          .expect(200)
      ).body;
      expect(
        only.data.every((e: { jobStageId: string }) => e.jobStageId === st.id),
      ).toBe(true);
      await expect(
        prisma.jobActivity.update({
          where: { id: started.id },
          data: { message: 'tampered' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.jobActivity.delete({ where: { id: started.id } }),
      ).rejects.toThrow();
    });
  });

  // ───────────────────────── notes and files ─────────────────────────
  describe('notes and evidence', () => {
    it('stores internal notes and keeps evidence files undeletable', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      const outsider = await makeWorker(app, 'FABRIC');
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const note = (
        await w.api
          .post(`/staff/job-stages/${st.id}/notes`, {
            content: 'roll 3 has a flaw',
          })
          .expect(201)
      ).body;
      expect(note.visibility).toBe('INTERNAL');
      await outsider.api
        .post(`/staff/job-stages/${st.id}/notes`, { content: 'hi' })
        .expect(403);
      const adminNotes = (
        await a.admin.get(`/admin/factory-jobs/${job.id}/notes`).expect(200)
      ).body;
      expect(adminNotes.map((n: { id: string }) => n.id)).toContain(note.id);

      await uploadEvidence(app, outsider.token, st.id).expect(403);
      await uploadEvidence(app, w.token, st.id, 'LOGO').expect(400);
      const asset = (await uploadEvidence(app, w.token, st.id).expect(201))
        .body;
      const detail = (await w.api.get(`/staff/job-stages/${st.id}`).expect(200))
        .body;
      expect(detail.files.map((f: { assetId: string }) => f.assetId)).toContain(
        asset.id,
      );
      const url = (
        await w.api
          .get(`/staff/job-stages/${st.id}/files/${asset.id}/download-url`)
          .expect(200)
      ).body;
      expect(url.url).toBeTruthy();
      await outsider.api
        .get(`/staff/job-stages/${st.id}/files/${asset.id}/download-url`)
        .expect(404);

      await a.admin.del(`/admin/assets/${asset.id}`).expect(409); // evidence is part of the record
      const att = await prisma.assetAttachment.findFirstOrThrow({
        where: { assetId: asset.id },
      });
      await a.admin
        .del(`/admin/assets/${asset.id}/attachments/${att.id}`)
        .expect(409);
      await a.admin
        .del(`/admin/factory-jobs/${job.id}/notes/${note.id}`)
        .expect(204);
      expect(
        (await a.admin.get(`/admin/factory-jobs/${job.id}/notes`).expect(200))
          .body,
      ).toHaveLength(0);
    });

    it('requires production_notes.create to attach production files via the asset API', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const asset = (await a.admin.upload('STAGE_PHOTO', 'p.png').expect(201))
        .body;
      const limited = await createUserAndLogin(app, {
        permissions: ['assets.manage', 'assets.read'],
      });
      await api(app, limited.accessToken)
        .post(`/admin/assets/${asset.id}/attachments`, {
          targetType: 'JOB_STAGE',
          targetId: st.id,
        })
        .expect(403);
      await a.admin
        .post(`/admin/assets/${asset.id}/attachments`, {
          targetType: 'JOB_STAGE',
          targetId: st.id,
        })
        .expect(201);
    });
  });

  // ───────────────────────── blockers ─────────────────────────
  describe('blockers', () => {
    it('blocks a stage, restores its previous status on resolution and logs the timeline', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const b = (
        await w.api
          .post(`/staff/job-stages/${st.id}/blockers`, {
            type: 'MATERIAL_UNAVAILABLE',
            description: 'no lycra in stock',
          })
          .expect(201)
      ).body;
      expect(b.status).toBe('OPEN');
      expect((await adminStage(st.id)).status).toBe('BLOCKED');
      expect((await jobDetail(a.admin, job.id)).status).toBe('BLOCKED');
      await w.api.post(`/staff/job-stages/${st.id}/complete`).expect(409);
      const second = (
        await w.api
          .post(`/staff/job-stages/${st.id}/blockers`, {
            type: 'STAFFING',
            description: 'short staffed',
          })
          .expect(201)
      ).body;
      await w.api
        .post(`/staff/blockers/${b.id}/resolve`, { note: 'stock arrived' })
        .expect(200);
      expect((await adminStage(st.id)).status).toBe('BLOCKED'); // one still open
      await w.api.post(`/staff/blockers/${b.id}/resolve`).expect(409);
      await w.api.post(`/staff/blockers/${second.id}/resolve`).expect(200);
      expect((await adminStage(st.id)).status).toBe('IN_PROGRESS');
      expect((await jobDetail(a.admin, job.id)).status).toBe('IN_PROGRESS');
      await w.api.post(`/staff/job-stages/${st.id}/complete`).expect(200);
      const list = (
        await a.admin.get(`/admin/factory-jobs/${job.id}/blockers`).expect(200)
      ).body;
      expect(list).toHaveLength(2);
      expect(
        list.every((x: { status: string }) => x.status === 'RESOLVED'),
      ).toBe(true);
      const types = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['STAGE_BLOCKED', 'BLOCKER_RESOLVED']),
      );
    });

    it('only assignees raise stage blockers and only they (or the reporter/admin) resolve', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      const outsider = await makeWorker(app, 'FABRIC');
      await outsider.api
        .post(`/staff/job-stages/${st.id}/blockers`, {
          type: 'OTHER',
          description: 'nope',
        })
        .expect(403);
      const b = (
        await w.api
          .post(`/staff/job-stages/${st.id}/blockers`, {
            type: 'OTHER',
            description: 'waiting on art',
          })
          .expect(201)
      ).body;
      await outsider.api.post(`/staff/blockers/${b.id}/resolve`).expect(403);
      await floor.sewing.api
        .post(`/staff/job-stages/${st.id}/blockers`, {
          type: 'OTHER',
          description: 'xyz',
        })
        .expect(403);
      await a.admin
        .post(`/admin/blockers/${b.id}/resolve`, { note: 'ok' })
        .expect(200);
      expect(await auditActions(app, b.id)).toContain(
        'blocker.resolved_by_admin',
      );
    });

    it('cannot block a waiting stage; validates the body', async () => {
      const job = await newJob();
      const cut = await stageOf(job.id, 'CUTTING');
      await a.admin
        .post(`/admin/job-stages/${cut.id}/blockers`, {
          type: 'OTHER',
          description: 'early',
        })
        .expect(409);
      const fab = await stageOf(job.id, 'FABRIC_PREPARATION');
      await a.admin
        .post(`/admin/job-stages/${fab.id}/blockers`, {
          type: 'NOT_A_TYPE',
          description: 'x',
        })
        .expect(400);
      await a.admin
        .post(`/admin/job-stages/${fab.id}/blockers`, { type: 'OTHER' })
        .expect(400);
    });

    it('job-level blockers stop all work until resolved or cancelled', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      const b = (
        await a.admin
          .post(`/admin/factory-jobs/${job.id}/blockers`, {
            type: 'PAYMENT_PENDING',
            description: 'balance unpaid',
          })
          .expect(201)
      ).body;
      expect(b.jobStageId).toBeNull();
      expect((await jobDetail(a.admin, job.id)).status).toBe('BLOCKED');
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(409);
      await a.admin
        .post(`/admin/blockers/${b.id}/cancel`, { note: 'raised in error' })
        .expect(200);
      expect((await jobDetail(a.admin, job.id)).status).toBe('READY');
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      expect(await auditActions(app, b.id)).toEqual(
        expect.arrayContaining([
          'blocker.raised_by_admin',
          'blocker.resolved_by_admin',
        ]),
      );
      await a.sales
        .post(`/admin/factory-jobs/${job.id}/blockers`, {
          type: 'OTHER',
          description: 'x',
        })
        .expect(403);
    });

    it('resolves two blockers concurrently without corrupting the stage', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const b1 = (
        await w.api
          .post(`/staff/job-stages/${st.id}/blockers`, {
            type: 'OTHER',
            description: 'one',
          })
          .expect(201)
      ).body;
      const b2 = (
        await w.api
          .post(`/staff/job-stages/${st.id}/blockers`, {
            type: 'OTHER',
            description: 'two',
          })
          .expect(201)
      ).body;
      const res = await Promise.all([
        w.api.post(`/staff/blockers/${b1.id}/resolve`),
        w.api.post(`/staff/blockers/${b2.id}/resolve`),
      ]);
      expect(res.map((r) => r.status)).toEqual([200, 200]);
      expect((await adminStage(st.id)).status).toBe('IN_PROGRESS');
    });
  });

  // ───────────────────────── QC ─────────────────────────
  describe('quality control', () => {
    const toQc = async (code = 'QC_GATE_1') => {
      const job = await newJob();
      await advanceTo(job.id, code);
      const st = await stageOf(job.id, code);
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      return { job, st, w };
    };

    it('exposes the seeded checklists', async () => {
      const list = (
        await a.admin
          .get('/admin/qc-templates?activeOnly=true&pageSize=50')
          .expect(200)
      ).body;
      const codes = list.data
        .map((t: { stageCode: string }) => t.stageCode)
        .sort();
      expect(codes).toEqual(
        expect.arrayContaining(['QC_GATE_1', 'QC_GATE_2', 'QC_GATE_3']),
      );
      const t1 = list.data.find(
        (t: { stageCode: string }) => t.stageCode === 'QC_GATE_1',
      );
      expect(t1.items.length).toBeGreaterThan(3);
      await a.admin.get(`/admin/qc-templates/${t1.id}`).expect(200);
    });

    it('a QC stage completes only through its inspection, and only for the assigned inspector', async () => {
      const { st, w } = await toQc();
      await w.api.post(`/staff/job-stages/${st.id}/complete`).expect(409);
      await floor.cutting.api
        .post(`/staff/job-stages/${st.id}/qc/start`)
        .expect(403); // no qc.perform
      const otherQc = await makeWorker(app, 'QC');
      await otherQc.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(403); // not assigned
      const insp = (
        await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(201)
      ).body;
      expect(insp.status).toBe('IN_PROGRESS');
      expect(insp.templateVersion).toBeGreaterThanOrEqual(1);
      await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(409); // already has one
      await otherQc.api
        .put(`/staff/qc-inspections/${insp.id}/results`, {
          results: [{ itemCode: insp.results[0].itemCode, result: 'PASS' }],
        })
        .expect(403);
      await otherQc.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
        })
        .expect(403);
    });

    it('validates results, required items and required photos before passing', async () => {
      const { job, st, w } = await toQc('QC_GATE_2');
      const insp = (
        await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(201)
      ).body;
      await w.api
        .put(`/staff/qc-inspections/${insp.id}/results`, {
          results: [{ itemCode: 'NOPE', result: 'PASS' }],
        })
        .expect(400);
      const passFail = insp.results.find(
        (r: { resultType: string }) => r.resultType === 'PASS_FAIL',
      );
      await w.api
        .put(`/staff/qc-inspections/${insp.id}/results`, {
          results: [{ itemCode: passFail.itemCode }],
        })
        .expect(400);
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
        })
        .expect(409); // unanswered
      // answer everything but skip the photos
      const results = insp.results.map(
        (r: { itemCode: string; resultType: string }) =>
          r.resultType === 'NUMBER'
            ? { itemCode: r.itemCode, numericValue: 150 }
            : r.resultType === 'MEASUREMENT'
              ? { itemCode: r.itemCode, numericValue: 25, result: 'PASS' }
              : r.resultType === 'TEXT'
                ? { itemCode: r.itemCode, textValue: 'ok' }
                : { itemCode: r.itemCode, result: 'PASS' },
      );
      await w.api
        .put(`/staff/qc-inspections/${insp.id}/results`, { results })
        .expect(200);
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
        })
        .expect(409); // photo required
      const needed = insp.results.filter(
        (r: { resultType: string; required: boolean }) =>
          r.resultType === 'PHOTO_REQUIRED' && r.required,
      ).length;
      expect(needed).toBeGreaterThan(0);
      for (let i = 0; i < needed; i += 1) {
        await request(app.getHttpServer())
          .post(`/api/v1/staff/qc-inspections/${insp.id}/photos`)
          .set(auth(w.token))
          .attach(
            'file',
            Buffer.concat([
              Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              Buffer.from(`p${i}`),
            ]),
            { filename: 'q.png', contentType: 'image/png' },
          )
          .expect(201);
      }
      const done = (
        await w.api
          .post(`/staff/qc-inspections/${insp.id}/complete`, {
            overallResult: 'PASS',
          })
          .expect(200)
      ).body;
      expect(done.status).toBe('COMPLETED');
      expect(done.overallResult).toBe('PASS');
      expect((await stageOf(job.id, 'QC_GATE_2')).status).toBe('COMPLETED');
      expect((await stageOf(job.id, 'SEWING')).status).toBe('READY');
      // final: results cannot change
      await w.api
        .put(`/staff/qc-inspections/${insp.id}/results`, { results })
        .expect(409);
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
        })
        .expect(409);
      await expect(
        prisma.qcInspectionResult.updateMany({
          where: { inspectionId: insp.id },
          data: { notes: 'tamper' },
        }),
      ).rejects.toThrow();
    });

    it('does not allow PASS with failed items; FAIL and CONDITIONAL_PASS need notes', async () => {
      const { st, w } = await toQc();
      const insp = (
        await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(201)
      ).body;
      await answerQc(app, w, insp, 'CUT_QUALITY');
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'PASS',
        })
        .expect(409);
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'FAIL',
        })
        .expect(400);
      await w.api
        .post(`/staff/qc-inspections/${insp.id}/complete`, {
          overallResult: 'CONDITIONAL_PASS',
        })
        .expect(400);
    });

    it('CONDITIONAL_PASS completes the stage and records the notes', async () => {
      const { job, st, w } = await toQc();
      const insp = (
        await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(201)
      ).body;
      await answerQc(app, w, insp);
      const done = (
        await w.api
          .post(`/staff/qc-inspections/${insp.id}/complete`, {
            overallResult: 'CONDITIONAL_PASS',
            notes: 'minor loose thread, fix at sewing',
          })
          .expect(200)
      ).body;
      expect(done.overallResult).toBe('CONDITIONAL_PASS');
      expect((await stageOf(job.id, 'QC_GATE_1')).status).toBe('COMPLETED');
      const types = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toContain('QC_CONDITIONAL_PASS');
    });

    it('all three QC gates run on a full job and are visible to admins', async () => {
      const job = await newJob();
      for (const code of STAGE_ORDER)
        await runStage(app, a.admin, floor, job.id, code);
      const inspections = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/qc-inspections`)
          .expect(200)
      ).body;
      expect(inspections).toHaveLength(3);
      expect(
        inspections.every(
          (i: { overallResult: string }) => i.overallResult === 'PASS',
        ),
      ).toBe(true);
      await a.admin
        .get(`/admin/qc-inspections/${inspections[0].id}`)
        .expect(200);
      await floor.cutting.api
        .get(`/admin/factory-jobs/${job.id}/qc-inspections`)
        .expect(403);
    });

    it('publishes a new checklist version without touching running inspections', async () => {
      const { st, w } = await toQc('QC_GATE_2');
      const insp = (
        await w.api.post(`/staff/job-stages/${st.id}/qc/start`).expect(201)
      ).body;
      const before = insp.templateVersion;
      const v = (
        await a.admin
          .post('/admin/qc-templates', {
            stageCode: 'QC_GATE_2',
            name: 'Print QC v-next',
            items: [
              {
                code: 'EXTRA_CHECK',
                label: 'Extra check',
                resultType: 'PASS_FAIL',
              },
            ],
          })
          .expect(201)
      ).body;
      expect(v.version).toBe(before + 1);
      expect(v.isActive).toBe(true);
      const active = (
        await a.admin
          .get('/admin/qc-templates?stageCode=QC_GATE_2&activeOnly=true')
          .expect(200)
      ).body;
      expect(active.data).toHaveLength(1);
      expect(
        (await w.api.get(`/staff/qc-inspections/${insp.id}`).expect(200)).body
          .templateVersion,
      ).toBe(before);
      await a.admin
        .post('/admin/qc-templates', {
          stageCode: 'CUTTING',
          name: 'x',
          items: [{ code: 'A', label: 'a', resultType: 'PASS_FAIL' }],
        })
        .expect(400);
      await a.sales
        .post('/admin/qc-templates', {
          stageCode: 'QC_GATE_2',
          name: 'x',
          items: [{ code: 'A', label: 'a', resultType: 'PASS_FAIL' }],
        })
        .expect(403);
      // restore the seeded shape for later tests
      await prisma.qcTemplate.updateMany({
        where: { id: v.id },
        data: { isActive: false },
      });
      const prev = await prisma.qcTemplate.findFirstOrThrow({
        where: { stageDefinition: { code: 'QC_GATE_2' }, version: before },
      });
      await prisma.qcTemplate.update({
        where: { id: prev.id },
        data: { isActive: true },
      });
    });
  });

  // ───────────────────────── rework ─────────────────────────
  describe('rework', () => {
    it('a failed QC gate sends work back, keeps history and re-checks after the redo', async () => {
      const job = await newJob();
      await advanceTo(job.id, 'QC_GATE_1');
      const cut1 = await stageOf(job.id, 'CUTTING');
      const qc1 = await stageOf(job.id, 'QC_GATE_1');
      const w = await assignWorker(a.admin, floor, qc1);
      await w.api.post(`/staff/job-stages/${qc1.id}/start`).expect(200);
      const insp = (
        await w.api.post(`/staff/job-stages/${qc1.id}/qc/start`).expect(201)
      ).body;
      await answerQc(app, w, insp, 'CUT_QUALITY');
      const failed = (
        await w.api
          .post(`/staff/qc-inspections/${insp.id}/complete`, {
            overallResult: 'FAIL',
            notes: 'pieces cut off-grain',
          })
          .expect(200)
      ).body;
      expect(failed.overallResult).toBe('FAIL');
      expect(failed.reworkId).toBeTruthy();

      const d = await jobDetail(a.admin, job.id);
      expect(d.stages).toHaveLength(12);
      const oldQc = d.stages.find((s) => s.id === qc1.id)!;
      expect(oldQc.status).toBe('FAILED');
      expect(oldQc.superseded).toBe(true);
      expect(d.stages.find((s) => s.id === cut1.id)!.superseded).toBe(true);
      expect(d.stages.find((s) => s.id === cut1.id)!.status).toBe('COMPLETED');
      const cut2 = await stageOf(job.id, 'CUTTING');
      expect(cut2.id).not.toBe(cut1.id);
      expect(cut2.attempt).toBe(2);
      expect(cut2.status).toBe('READY');
      expect(cut2.assignees).toHaveLength(1); // assignment carried over
      const qc2 = await stageOf(job.id, 'QC_GATE_1');
      expect(qc2.attempt).toBe(2);
      expect(qc2.status).toBe('WAITING');
      expect((await stageOf(job.id, 'PRINTING_EMBROIDERY')).status).toBe(
        'WAITING',
      );
      expect(d.status).not.toBe('COMPLETED');

      const rework = (
        await a.admin.get(`/admin/factory-jobs/${job.id}/rework`).expect(200)
      ).body;
      expect(rework).toHaveLength(1);
      expect(rework[0].status).toBe('OPEN');
      expect(rework[0].targetStageCode).toBe('CUTTING');
      expect(rework[0].reason).toBe('pieces cut off-grain');
      expect(rework[0].newStageIds).toEqual(
        expect.arrayContaining([cut2.id, qc2.id]),
      );

      // redo the cutting, then the re-check
      const cw = workerFor(floor, 'CUTTING');
      await cw.api.post(`/staff/job-stages/${cut2.id}/start`).expect(200);
      expect(
        (await a.admin.get(`/admin/factory-jobs/${job.id}/rework`).expect(200))
          .body[0].status,
      ).toBe('IN_PROGRESS');
      await cw.api.post(`/staff/job-stages/${cut2.id}/complete`).expect(200);
      expect(
        (await a.admin.get(`/admin/factory-jobs/${job.id}/rework`).expect(200))
          .body[0].status,
      ).toBe('RESOLVED');
      expect((await stageOf(job.id, 'QC_GATE_1')).status).toBe('READY');
      await runStage(app, a.admin, floor, job.id, 'QC_GATE_1');
      expect((await stageOf(job.id, 'PRINTING_EMBROIDERY')).status).toBe(
        'READY',
      );

      const inspections = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/qc-inspections`)
          .expect(200)
      ).body;
      expect(
        inspections.map((i: { overallResult: string }) => i.overallResult),
      ).toEqual(['FAIL', 'PASS']);
      const types = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'QC_FAILED',
          'REWORK_CREATED',
          'REWORK_RESOLVED',
        ]),
      );
      // the whole job still finishes
      for (const code of STAGE_ORDER.slice(4))
        await runStage(app, a.admin, floor, job.id, code);
      expect((await jobDetail(a.admin, job.id)).status).toBe('COMPLETED');
    });

    it('lets an admin send work back manually from a stage in progress', async () => {
      const job = await newJob();
      await advanceTo(job.id, 'PRINTING_EMBROIDERY');
      const pr = await stageOf(job.id, 'PRINTING_EMBROIDERY');
      const w = await assignWorker(a.admin, floor, pr);
      await w.api.post(`/staff/job-stages/${pr.id}/start`).expect(200);
      await a.admin
        .post(`/admin/job-stages/${pr.id}/rework`, {
          reason: 'wrong artwork placed',
        })
        .expect(200)
        .then(async (r) => {
          expect(r.body.reworkId).toBeTruthy();
        });
      expect((await adminStage(pr.id)).status).toBe('FAILED');
      expect((await stageOf(job.id, 'PRINTING_EMBROIDERY')).attempt).toBe(2);
      expect(await auditActions(app, pr.id)).toContain(
        'rework.created_manually',
      );
      await floor.sewing.api
        .post(`/admin/job-stages/${pr.id}/rework`, { reason: 'x' })
        .expect(403);
    });

    it('refuses manual rework from a stage that is not in progress', async () => {
      const job = await newJob();
      const fab = await stageOf(job.id, 'FABRIC_PREPARATION');
      await a.admin
        .post(`/admin/job-stages/${fab.id}/rework`, { reason: 'too early' })
        .expect(409);
    });
  });

  // ───────────────────────── delay, priority, board ─────────────────────────
  describe('delay, priority and the production board', () => {
    it('derives delay from the stage due date and filters on it', async () => {
      const job = await newJob();
      const other = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      expect(st.isDelayed).toBe(false);
      expect(st.dueAt).toBeTruthy();
      await prisma.jobStage.update({
        where: { id: st.id },
        data: { dueAt: new Date(Date.now() - 3600_000) },
      });
      expect((await stageOf(job.id, 'FABRIC_PREPARATION')).isDelayed).toBe(
        true,
      );
      const delayed = (
        await a.admin
          .get('/admin/factory-jobs?delayed=true&pageSize=100')
          .expect(200)
      ).body;
      const ids = delayed.data.map((j: { id: string }) => j.id);
      expect(ids).toContain(job.id);
      expect(ids).not.toContain(other.id);
      expect(
        delayed.data.find((j: { id: string }) => j.id === job.id).delayedStages,
      ).toBe(1);
      const board = (
        await a.admin
          .get(
            '/admin/production/board?delayed=true&stageCode=FABRIC_PREPARATION',
          )
          .expect(200)
      ).body;
      expect(
        board.columns[0].cards.map((c: { jobId: string }) => c.jobId),
      ).toContain(job.id);
      expect(
        board.columns[0].cards.map((c: { jobId: string }) => c.jobId),
      ).not.toContain(other.id);
      // completing the stage ends the delay
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      await w.api.post(`/staff/job-stages/${st.id}/complete`).expect(200);
      expect(
        (
          await a.admin
            .get('/admin/factory-jobs?delayed=true&pageSize=100')
            .expect(200)
        ).body.data.map((j: { id: string }) => j.id),
      ).not.toContain(job.id);
    });

    it('changes priority with an audit entry and timeline event', async () => {
      const job = await newJob();
      const r = (
        await a.admin
          .patch(`/admin/factory-jobs/${job.id}/priority`, {
            priority: 'URGENT',
            reason: 'event next week',
          })
          .expect(200)
      ).body;
      expect(r.priority).toBe('URGENT');
      await a.admin
        .patch(`/admin/factory-jobs/${job.id}/priority`, { priority: 'BOGUS' })
        .expect(400);
      expect(await auditActions(app, job.id)).toContain(
        'factory_job.priority_changed',
      );
      const types = (
        await a.admin.get(`/admin/factory-jobs/${job.id}/timeline`).expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toContain('PRIORITY_CHANGED');
      const urgent = (
        await a.admin
          .get('/admin/factory-jobs?priority=URGENT&pageSize=100')
          .expect(200)
      ).body;
      expect(
        urgent.data.every((j: { priority: string }) => j.priority === 'URGENT'),
      ).toBe(true);
      expect(urgent.data.map((j: { id: string }) => j.id)).toContain(job.id);
    });

    it('lists and filters jobs with pagination', async () => {
      const job = await newJob();
      const page = (
        await a.admin.get('/admin/factory-jobs?pageSize=2&page=1').expect(200)
      ).body;
      expect(page.data.length).toBeLessThanOrEqual(2);
      expect(page.meta.pageSize).toBe(2);
      expect(page.meta.total).toBeGreaterThan(2);
      const bySearch = (
        await a.admin
          .get(`/admin/factory-jobs?search=${job.jobNumber}`)
          .expect(200)
      ).body;
      expect(bySearch.data.map((j: { id: string }) => j.id)).toEqual([job.id]);
      const byBrand = (
        await a.admin
          .get(`/admin/factory-jobs?brandId=${job.brand.id}`)
          .expect(200)
      ).body;
      expect(byBrand.data.map((j: { id: string }) => j.id)).toEqual([job.id]);
      const byStatus = (
        await a.admin
          .get('/admin/factory-jobs?status=COMPLETED,CANCELLED&pageSize=100')
          .expect(200)
      ).body;
      expect(
        byStatus.data.every((j: { status: string }) =>
          ['COMPLETED', 'CANCELLED'].includes(j.status),
        ),
      ).toBe(true);
      await a.admin.get('/admin/factory-jobs?status=NOPE').expect(400);
      await a.admin
        .get('/admin/factory-jobs/00000000-0000-4000-8000-000000000000')
        .expect(404);
    });

    it('shows a production board with a column per stage, counts and filters', async () => {
      const job = await newJob({ priority: 'URGENT' });
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const board = (await a.admin.get('/admin/production/board').expect(200))
        .body;
      expect(
        board.columns.map((c: { stageCode: string }) => c.stageCode),
      ).toEqual(STAGE_ORDER);
      const fab = board.columns[0];
      expect(fab.counts.READY).toBeGreaterThan(0);
      expect(fab.cards.length).toBeLessThanOrEqual(20);
      const mine = (
        await a.admin
          .get(
            `/admin/production/board?stageCode=FABRIC_PREPARATION&priority=URGENT&pageSize=100`,
          )
          .expect(200)
      ).body;
      expect(mine.meta.total).toBeGreaterThan(0);
      const card = mine.columns[0].cards.find(
        (c: { jobId: string }) => c.jobId === job.id,
      );
      expect(card.jobNumber).toBe(job.jobNumber);
      expect(card.customerName).toBeTruthy();
      expect(card.status).toBe('READY');
      const un = (
        await a.admin
          .get(
            '/admin/production/board?stageCode=FABRIC_PREPARATION&unassigned=true&pageSize=100',
          )
          .expect(200)
      ).body;
      expect(
        un.columns[0].cards.map((c: { stageId: string }) => c.stageId),
      ).toContain(st.id);
      const w = await makeWorker(app, 'FABRIC');
      await a.admin
        .post(`/admin/job-stages/${st.id}/assignments`, { userId: w.id })
        .expect(201);
      const assigned = (
        await a.admin
          .get(
            `/admin/production/board?stageCode=FABRIC_PREPARATION&assignedUserId=${w.id}&pageSize=100`,
          )
          .expect(200)
      ).body;
      expect(
        assigned.columns[0].cards.map((c: { stageId: string }) => c.stageId),
      ).toEqual([st.id]);
      const blockedOnly = (
        await a.admin.get('/admin/production/board?blocked=true').expect(200)
      ).body;
      expect(
        blockedOnly.columns.every((c: { cards: { status: string }[] }) =>
          c.cards.every((x) => x.status === 'BLOCKED'),
        ),
      ).toBe(true);
      await a.admin
        .get('/admin/production/board?stageCode=NOPE_STAGE')
        .expect(200)
        .then((r) => expect(r.body.columns).toEqual([]));
    });
  });

  // ───────────────────────── overrides and completion ─────────────────────────
  describe('admin overrides and job completion', () => {
    it('force-complete needs a reason, finishes the job and is audited', async () => {
      const job = await newJob();
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/force-complete`, {})
        .expect(400);
      await a.sales
        .post(`/admin/factory-jobs/${job.id}/force-complete`, {
          reason: 'x yz',
        })
        .expect(403);
      const done = (
        await a.admin
          .post(`/admin/factory-jobs/${job.id}/force-complete`, {
            reason: 'delivered from stock',
          })
          .expect(200)
      ).body;
      expect(done.status).toBe('COMPLETED');
      expect(
        done.stages.every((s: { status: string }) =>
          ['SKIPPED', 'CANCELLED', 'COMPLETED'].includes(s.status),
        ),
      ).toBe(true);
      expect(await auditActions(app, job.id)).toContain(
        'factory_job.force_completed',
      );
      const types = (
        await a.admin
          .get(`/admin/factory-jobs/${job.id}/timeline?pageSize=100`)
          .expect(200)
      ).body.data.map((e: { type: string }) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['ADMIN_OVERRIDE', 'JOB_COMPLETED']),
      );
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/force-complete`, {
          reason: 'again again',
        })
        .expect(409);
    });

    it('stage override needs stages.override + reason; QC gates also need qc.manage', async () => {
      const job = await newJob();
      const fab = await stageOf(job.id, 'FABRIC_PREPARATION');
      await a.admin
        .post(`/admin/job-stages/${fab.id}/override`, { action: 'complete' })
        .expect(400);
      await a.sales
        .post(`/admin/job-stages/${fab.id}/override`, {
          action: 'complete',
          reason: 'because',
        })
        .expect(403);
      const r = (
        await a.admin
          .post(`/admin/job-stages/${fab.id}/override`, {
            action: 'complete',
            reason: 'done offline',
          })
          .expect(200)
      ).body;
      expect(r.status).toBe('COMPLETED');
      expect((await stageOf(job.id, 'PATTERN_MAKING')).status).toBe('READY');
      expect(await auditActions(app, fab.id)).toContain('job_stage.overridden');
      const skipped = (
        await a.admin
          .post(
            `/admin/job-stages/${(await stageOf(job.id, 'PATTERN_MAKING')).id}/override`,
            { action: 'skip', reason: 'reuse approved pattern' },
          )
          .expect(200)
      ).body;
      expect(skipped.status).toBe('SKIPPED');
      expect((await stageOf(job.id, 'CUTTING')).status).toBe('READY');

      // a QC gate override is its own audit action and needs qc.manage
      const cut = await stageOf(job.id, 'CUTTING');
      await a.admin
        .post(`/admin/job-stages/${cut.id}/override`, {
          action: 'complete',
          reason: 'cut elsewhere',
        })
        .expect(200);
      const qc1 = await stageOf(job.id, 'QC_GATE_1');
      const noQcManage = await createUserAndLogin(app, {
        permissions: ['stages.override'],
      });
      await api(app, noQcManage.accessToken)
        .post(`/admin/job-stages/${qc1.id}/override`, {
          action: 'complete',
          reason: 'trust me',
        })
        .expect(403);
      await a.admin
        .post(`/admin/job-stages/${qc1.id}/override`, {
          action: 'complete',
          reason: 'QC done on paper',
        })
        .expect(200);
      expect(await auditActions(app, qc1.id)).toContain('qc.override');
    });

    it('completes the job automatically once every required stage is done', async () => {
      const job = await newJob();
      for (const code of STAGE_ORDER.slice(0, 9))
        await runStage(app, a.admin, floor, job.id, code);
      expect((await jobDetail(a.admin, job.id)).status).toBe('IN_PROGRESS');
      await runStage(app, a.admin, floor, job.id, 'READY');
      const d = await jobDetail(a.admin, job.id);
      expect(d.status).toBe('COMPLETED');
      expect(d.stages.every((s) => s.status === 'COMPLETED')).toBe(true);
      // a finished job refuses further changes
      await a.admin
        .post(`/admin/factory-jobs/${job.id}/cancel`, { reason: 'too late' })
        .expect(409);
      await a.admin
        .patch(`/admin/factory-jobs/${job.id}/priority`, { priority: 'LOW' })
        .expect(409);
    });
  });

  // ───────────────────────── concurrency ─────────────────────────
  describe('concurrency', () => {
    it('lets only one of two simultaneous starts win', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const second = await makeWorker(app, 'FABRIC');
      await assignWorker(a.admin, floor, st);
      await a.admin
        .post(`/admin/job-stages/${st.id}/assignments`, { userId: second.id })
        .expect(201);
      const res = await Promise.all([
        floor.fabric.api.post(`/staff/job-stages/${st.id}/start`),
        second.api.post(`/staff/job-stages/${st.id}/start`),
      ]);
      expect(res.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409,
      ]);
    });

    it('lets only one of several simultaneous completions win', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const w = await assignWorker(a.admin, floor, st);
      await w.api.post(`/staff/job-stages/${st.id}/start`).expect(200);
      const res = await Promise.all(
        Array.from({ length: 4 }, () =>
          w.api.post(`/staff/job-stages/${st.id}/complete`),
        ),
      );
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(3);
      expect((await stageOf(job.id, 'PATTERN_MAKING')).status).toBe('READY');
      expect(
        await prisma.jobActivity.count({
          where: { jobStageId: st.id, type: 'STAGE_COMPLETED' },
        }),
      ).toBe(1);
    });

    it('serialises QC completion and rework creation', async () => {
      const job = await newJob();
      await advanceTo(job.id, 'QC_GATE_1');
      const qc1 = await stageOf(job.id, 'QC_GATE_1');
      const w = await assignWorker(a.admin, floor, qc1);
      await w.api.post(`/staff/job-stages/${qc1.id}/start`).expect(200);
      const insp = (
        await w.api.post(`/staff/job-stages/${qc1.id}/qc/start`).expect(201)
      ).body;
      await answerQc(app, w, insp, 'CUT_QUALITY');
      const res = await Promise.all(
        Array.from({ length: 3 }, () =>
          w.api.post(`/staff/qc-inspections/${insp.id}/complete`, {
            overallResult: 'FAIL',
            notes: 'bad cuts',
          }),
        ),
      );
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        await prisma.reworkRecord.count({ where: { jobId: job.id } }),
      ).toBe(1);
      const d = await jobDetail(a.admin, job.id);
      expect(d.stages.filter((s) => s.stageCode === 'CUTTING')).toHaveLength(2);
    });

    it('starts concurrent jobs with distinct numbers', async () => {
      const samples = await Promise.all([
        paidSample(app, a, refs),
        paidSample(app, a, refs),
        paidSample(app, a, refs),
      ]);
      const res = await Promise.all(
        samples.map((f) =>
          a.admin.post(`/admin/samples/${f.sample.id}/create-factory-job`),
        ),
      );
      expect(res.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(res.map((r) => r.body.jobNumber)).size).toBe(3);
    });
  });

  // ───────────────────────── authorization ─────────────────────────
  describe('authorization', () => {
    it('denies unauthenticated callers on every factory route family', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      const raw = (p: string, m: 'get' | 'post' = 'get') =>
        request(app.getHttpServer())[m](`/api/v1${p}`);
      await raw('/admin/factory-jobs').expect(401);
      await raw(`/admin/factory-jobs/${job.id}`).expect(401);
      await raw('/admin/production/board').expect(401);
      await raw('/admin/workflow-templates').expect(401);
      await raw('/admin/qc-templates').expect(401);
      await raw('/staff/my-stages').expect(401);
      await raw(`/staff/job-stages/${st.id}/start`, 'post').expect(401);
    });

    it('keeps factory roles out of admin job management, and sales out of floor actions', async () => {
      const job = await newJob();
      const st = await stageOf(job.id, 'FABRIC_PREPARATION');
      for (const w of [floor.fabric, floor.cutting, floor.qc]) {
        await w.api.get('/admin/factory-jobs').expect(403);
        await w.api.get('/admin/production/board').expect(403);
        await w.api
          .post(`/admin/factory-jobs/${job.id}/hold`, { reason: 'because' })
          .expect(403);
        await w.api
          .post(`/admin/factory-jobs/${job.id}/cancel`, { reason: 'because' })
          .expect(403);
        await w.api
          .patch(`/admin/factory-jobs/${job.id}/priority`, { priority: 'LOW' })
          .expect(403);
        await w.api
          .get('/admin/qc-templates')
          .expect(w === floor.qc ? 200 : 403);
      }
      await a.sales.get('/admin/production/board').expect(200);
      await a.sales.get(`/admin/factory-jobs/${job.id}`).expect(200);
      await a.sales.post(`/staff/job-stages/${st.id}/start`).expect(403);
      await a.sales
        .post(`/admin/job-stages/${st.id}/hold`, { reason: 'because' })
        .expect(403);
      await a.finance.get('/staff/my-stages').expect(403);
      await a.finance.get('/admin/production/board').expect(403);
    });

    it('qc.perform alone does not let a floor role manage checklists', async () => {
      await floor.qc.api
        .post('/admin/qc-templates', {
          stageCode: 'QC_GATE_1',
          name: 'x',
          items: [{ code: 'A', label: 'a', resultType: 'PASS_FAIL' }],
        })
        .expect(403);
    });

    it('seeds the phase 4 permissions and grants', async () => {
      const perms = await prisma.permission.findMany({
        where: {
          code: {
            in: [
              'factory_jobs.manage',
              'production_board.read',
              'workflow_templates.read',
              'workflow_templates.manage',
              'stages.block',
              'stages.override',
              'qc.read',
              'qc.manage',
              'rework.manage',
              'production_notes.create',
            ],
          },
        },
      });
      expect(perms).toHaveLength(10);
      const grants = async (role: string) =>
        (
          await prisma.rolePermission.findMany({
            where: { role: { code: role } },
            include: { permission: true },
          })
        ).map((g) => g.permission.code);
      const admin = await grants('ADMIN');
      for (const p of perms) expect(admin).toContain(p.code);
      expect(await grants('SEWING')).toEqual(
        expect.arrayContaining(['stages.block', 'production_notes.create']),
      );
      expect(await grants('SEWING')).not.toContain('stages.override');
      expect(await grants('QC')).toContain('qc.read');
      expect(await grants('SALES')).toContain('production_board.read');
      expect(await grants('FINANCE')).not.toContain('production_board.read');
    });
  });

  describe('immutability guards (database)', () => {
    it('protects job identity, terminal states and the frozen workflow', async () => {
      const job = await newJob();
      const row = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      await expect(
        prisma.factoryJob.update({
          where: { id: job.id },
          data: {
            sampleProductionSpecId: (
              await prisma.sampleProductionSpec.findFirstOrThrow({
                where: { id: { not: row.sampleProductionSpecId } },
              })
            ).id,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.factoryJob.update({
          where: { id: job.id },
          data: { jobNumber: 'JOB-999999' },
        }),
      ).rejects.toThrow();
      const st = await prisma.jobStage.findFirstOrThrow({
        where: { jobId: job.id, stageCode: 'CUTTING' },
      });
      await expect(
        prisma.jobStage.update({
          where: { id: st.id },
          data: { status: 'COMPLETED' },
        }),
      ).rejects.toThrow(); // WAITING -> COMPLETED
      await expect(
        prisma.jobStage.delete({ where: { id: st.id } }),
      ).rejects.toThrow();
      const version = await prisma.workflowTemplateVersion.findUniqueOrThrow({
        where: { id: row.workflowTemplateVersionId },
      });
      expect(version.status).toBe('ACTIVE');
      await expect(
        prisma.workflowTemplateStage.deleteMany({
          where: { versionId: version.id },
        }),
      ).rejects.toThrow();
    });

    it('allows only one live job per sample at database level', async () => {
      const job = await newJob();
      const row = await prisma.factoryJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      await expect(
        prisma.factoryJob.create({
          data: {
            jobNumber: `JOB-${Math.floor(Math.random() * 900000 + 100000)}`,
            sourceType: 'SAMPLE_PRODUCTION',
            sampleId: row.sampleId,
            sampleProductionSpecId: row.sampleProductionSpecId,
            workflowTemplateVersionId: row.workflowTemplateVersionId,
            customerId: row.customerId,
            brandId: row.brandId,
            productName: 'dup',
            createdByUserId: row.createdByUserId,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
