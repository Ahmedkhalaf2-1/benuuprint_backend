import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createUserAndLogin } from './app.js';
import {
  PNG,
  api,
  payAndVerify,
  toAwaitingApproval,
  toAwaitingPayment,
  type Actors,
  type Api,
  type Flow,
  type Refs,
} from './factory.js';

export interface Worker {
  api: Api;
  token: string;
  id: string;
}

export interface Floor {
  fabric: Worker;
  pattern: Worker;
  cutting: Worker;
  printing: Worker;
  sewing: Worker;
  qc: Worker;
  packaging: Worker;
}

const ROLE_FOR = {
  fabric: 'FABRIC',
  pattern: 'PATTERN_MAKER',
  cutting: 'CUTTING',
  printing: 'PRINTING',
  sewing: 'SEWING',
  qc: 'QC',
  packaging: 'PACKAGING',
} as const;

export async function makeWorker(
  app: INestApplication,
  roleCode: string,
): Promise<Worker> {
  const w = await createUserAndLogin(app, { roleCodes: [roleCode] });
  return { api: api(app, w.accessToken), token: w.accessToken, id: w.user.id };
}

export async function makeFloor(app: INestApplication): Promise<Floor> {
  const entries = await Promise.all(
    Object.entries(ROLE_FOR).map(
      async ([k, role]) => [k, await makeWorker(app, role)] as const,
    ),
  );
  return Object.fromEntries(entries) as unknown as Floor;
}

/** Reviewed, quoted, accepted and paid: READY_FOR_PRODUCTION, no factory job yet. */
export async function paidSample(
  app: INestApplication,
  a: Actors,
  refs: Refs,
): Promise<Flow> {
  const flow = await toAwaitingPayment(app, a, refs);
  await payAndVerify(a.sales, a.finance, flow.sample.id, Number(flow.total));
  return flow;
}

/** A paid, customer-approved sample with its frozen production specification. */
export async function approvedSample(
  app: INestApplication,
  a: Actors,
  refs: Refs,
): Promise<Flow> {
  const flow = await toAwaitingApproval(app, a, refs);
  const req = (
    await a.sales
      .post(`/admin/samples/${flow.sample.id}/approvals`, { type: 'SAMPLE' })
      .expect(201)
  ).body;
  await a.sales
    .post(`/admin/approvals/${req.id}/approve`, {
      sourceNote: 'Customer approved by WhatsApp (test)',
    })
    .expect(200);
  return flow;
}

export interface JobStageBody {
  id: string;
  stageCode: string;
  status: string;
  attempt: number;
  superseded: boolean;
  assignees: { assignmentId: string; userId: string }[];
  [k: string]: unknown;
}

export async function createJob(
  admin: Api,
  sampleId: string,
  body: object = {},
) {
  return (
    await admin
      .post(`/admin/samples/${sampleId}/create-factory-job`, body)
      .expect(201)
  ).body as {
    id: string;
    jobNumber: string;
    stages: JobStageBody[];
    customer: { id: string };
    brand: { id: string };
  } & Record<string, unknown>;
}

export async function jobDetail(admin: Api, jobId: string) {
  return (await admin.get(`/admin/factory-jobs/${jobId}`).expect(200)).body as {
    id: string;
    status: string;
    stages: JobStageBody[];
  } & Record<string, unknown>;
}

/** The current (non-superseded) occurrence of a stage code. */
export async function currentStage(admin: Api, jobId: string, code: string) {
  const job = await jobDetail(admin, jobId);
  const stage = job.stages
    .filter((s) => s.stageCode === code && !s.superseded)
    .sort((x, y) => y.attempt - x.attempt)[0];
  if (!stage) throw new Error(`no current ${code} stage`);
  return stage;
}

export const uploadEvidence = (
  app: INestApplication,
  token: string,
  stageId: string,
  type = 'STAGE_PHOTO',
) =>
  request(app.getHttpServer())
    .post(`/api/v1/staff/job-stages/${stageId}/assets`)
    .set(auth(token))
    .field('type', type)
    .attach('file', PNG, {
      filename: 'evidence.png',
      contentType: 'image/png',
    });

export const uploadQcPhoto = (
  app: INestApplication,
  token: string,
  inspectionId: string,
) =>
  request(app.getHttpServer())
    .post(`/api/v1/staff/qc-inspections/${inspectionId}/photos`)
    .set(auth(token))
    .attach('file', PNG, { filename: 'qc.png', contentType: 'image/png' });

const WORKER_FOR_CODE: Record<string, keyof Floor> = {
  FABRIC_PREPARATION: 'fabric',
  PATTERN_MAKING: 'pattern',
  CUTTING: 'cutting',
  PRINTING_EMBROIDERY: 'printing',
  SEWING: 'sewing',
  QC_GATE_1: 'qc',
  QC_GATE_2: 'qc',
  QC_GATE_3: 'qc',
  PACKAGING: 'packaging',
  READY: 'packaging',
};
export const workerFor = (floor: Floor, code: string) =>
  floor[WORKER_FOR_CODE[code]];

/** Assign the right floor worker to a stage (admin). */
export async function assignWorker(
  admin: Api,
  floor: Floor,
  stage: { id: string; stageCode: string },
) {
  const w = workerFor(floor, stage.stageCode);
  await admin
    .post(`/admin/job-stages/${stage.id}/assignments`, { userId: w.id })
    .expect(201);
  return w;
}

/** Answer every checklist item as PASS (photos attached as required). */
export async function answerQc(
  app: INestApplication,
  worker: Worker,
  inspection: {
    id: string;
    results: { itemCode: string; resultType: string; required: boolean }[];
  },
  failItem?: string,
) {
  const results = inspection.results.map((r) => {
    const fail = r.itemCode === failItem;
    switch (r.resultType) {
      case 'NUMBER':
        return { itemCode: r.itemCode, numericValue: 150 };
      case 'MEASUREMENT':
        return {
          itemCode: r.itemCode,
          numericValue: 25,
          result: fail ? 'FAIL' : 'PASS',
        };
      case 'TEXT':
        return { itemCode: r.itemCode, textValue: 'none' };
      default:
        return { itemCode: r.itemCode, result: fail ? 'FAIL' : 'PASS' };
    }
  });
  await worker.api
    .put(`/staff/qc-inspections/${inspection.id}/results`, { results })
    .expect(200);
  const photos = inspection.results.filter(
    (r) => r.resultType === 'PHOTO_REQUIRED' && r.required,
  ).length;
  for (let i = 0; i < photos; i += 1) {
    await uploadQcPhoto(app, worker.token, inspection.id).expect(201);
  }
}

/** Run one stage to COMPLETED the way the floor would (assign, start, evidence, complete / QC pass). */
export async function runStage(
  app: INestApplication,
  admin: Api,
  floor: Floor,
  jobId: string,
  code: string,
) {
  const stage = await currentStage(admin, jobId, code);
  const w = stage.assignees.length
    ? workerFor(floor, code)
    : await assignWorker(admin, floor, stage);
  await w.api.post(`/staff/job-stages/${stage.id}/start`).expect(200);
  if (stage.isQcStage) {
    const insp = (
      await w.api.post(`/staff/job-stages/${stage.id}/qc/start`).expect(201)
    ).body;
    await answerQc(app, w, insp);
    await w.api
      .post(`/staff/qc-inspections/${insp.id}/complete`, {
        overallResult: 'PASS',
      })
      .expect(200);
    return;
  }
  if (stage.requiresAttachment)
    await uploadEvidence(app, w.token, stage.id).expect(201);
  await w.api
    .post(`/staff/job-stages/${stage.id}/complete`, {
      note: stage.requiresCompletionNote ? 'done' : undefined,
    })
    .expect(200);
}

export const STAGE_ORDER = [
  'FABRIC_PREPARATION',
  'PATTERN_MAKING',
  'CUTTING',
  'QC_GATE_1',
  'PRINTING_EMBROIDERY',
  'QC_GATE_2',
  'SEWING',
  'QC_GATE_3',
  'PACKAGING',
  'READY',
];
