import type { INestApplication } from '@nestjs/common';
import { createTestApp, createUserAndLogin } from './support/app.js';
import {
  api,
  lookupRefs,
  makeActors,
  type Actors,
  type Api,
  type Refs,
} from './support/factory.js';
import {
  answerQc,
  createJob,
  currentStage,
  makeFloor,
  paidSample,
  runStage,
  uploadEvidence,
  type Floor,
} from './support/floor.js';

describe('ADMIN executes factory stages (e2e)', () => {
  let app: INestApplication;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let adminUser: { api: Api; token: string; id: string };

  beforeAll(async () => {
    app = await createTestApp();
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    const u = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
    adminUser = {
      api: api(app, u.accessToken),
      token: u.accessToken,
      id: u.user.id,
    };
  });
  afterAll(() => app.close());

  const newJob = async () => {
    const f = await paidSample(app, a, refs);
    return (await createJob(a.admin, f.sample.id, {})).id;
  };

  it('starts, annotates, evidences and completes an unassigned stage', async () => {
    const jobId = await newJob();
    const stage = await currentStage(a.admin, jobId, 'FABRIC_PREPARATION');
    expect(stage.assignees).toHaveLength(0);

    // the task view lists the actions the caller may take
    const view = (
      await adminUser.api.get(`/staff/job-stages/${stage.id}`).expect(200)
    ).body;
    expect(view.allowedActions).toContain('START');

    await adminUser.api.post(`/staff/job-stages/${stage.id}/start`).expect(200);
    await adminUser.api
      .post(`/staff/job-stages/${stage.id}/notes`, { content: 'admin note' })
      .expect(201);
    await uploadEvidence(app, adminUser.token, stage.id).expect(201);
    await adminUser.api
      .post(`/staff/job-stages/${stage.id}/complete`, {
        note: stage.requiresCompletionNote ? 'done' : undefined,
      })
      .expect(200);
    expect(
      (await currentStage(a.admin, jobId, 'FABRIC_PREPARATION')).status,
    ).toBe('COMPLETED');
  });

  it('still enforces completion requirements and the stage state machine', async () => {
    const jobId = await newJob();
    const stage = await currentStage(a.admin, jobId, 'FABRIC_PREPARATION');
    // complete before start is an invalid transition
    await adminUser.api
      .post(`/staff/job-stages/${stage.id}/complete`, { note: 'x' })
      .expect(409);
    await adminUser.api.post(`/staff/job-stages/${stage.id}/start`).expect(200);
    if (stage.requiresCompletionNote) {
      await adminUser.api
        .post(`/staff/job-stages/${stage.id}/complete`, {})
        .expect(400);
    }
    if (stage.requiresAttachment) {
      await adminUser.api
        .post(`/staff/job-stages/${stage.id}/complete`, { note: 'x' })
        .expect(409);
    }
    // a later stage is not READY yet
    const later = await currentStage(a.admin, jobId, 'PATTERN_MAKING');
    await adminUser.api.post(`/staff/job-stages/${later.id}/start`).expect(409);
  });

  it('runs a QC gate through its inspection, not by plain completion', async () => {
    const jobId = await newJob();
    for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING', 'CUTTING'])
      await runStage(app, a.admin, floor, jobId, code);
    const qc = await currentStage(a.admin, jobId, 'QC_GATE_1');
    await adminUser.api.post(`/staff/job-stages/${qc.id}/start`).expect(200);
    await adminUser.api
      .post(`/staff/job-stages/${qc.id}/complete`, { note: 'x' })
      .expect(409);
    const insp = (
      await adminUser.api
        .post(`/staff/job-stages/${qc.id}/qc/start`)
        .expect(201)
    ).body;
    // an unanswered checklist cannot be submitted
    await adminUser.api
      .post(`/staff/qc-inspections/${insp.id}/complete`, {
        overallResult: 'PASS',
      })
      .expect(409);
    await answerQc(app, { ...adminUser } as never, insp);
    await adminUser.api
      .post(`/staff/qc-inspections/${insp.id}/complete`, {
        overallResult: 'PASS',
      })
      .expect(200);
  });

  it('keeps ordinary floor staff assignment-restricted', async () => {
    const jobId = await newJob();
    const stage = await currentStage(a.admin, jobId, 'FABRIC_PREPARATION');
    // assign someone else; the fabric worker is not assigned
    await a.admin
      .post(`/admin/job-stages/${stage.id}/assignments`, {
        userId: floor.fabric.id,
      })
      .expect(201);
    await floor.pattern.api
      .post(`/staff/job-stages/${stage.id}/start`)
      .expect(403);
    await floor.fabric.api
      .post(`/staff/job-stages/${stage.id}/start`)
      .expect(200);
    await floor.pattern.api
      .post(`/staff/job-stages/${stage.id}/notes`, { content: 'x' })
      .expect(403);
    await floor.pattern.api
      .post(`/staff/job-stages/${stage.id}/complete`, { note: 'x' })
      .expect(403);
  });
});
