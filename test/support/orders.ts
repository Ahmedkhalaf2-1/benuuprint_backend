import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  createCustomerWithBrand,
  createFabricColor,
  type Actors,
  type Api,
  type Refs,
} from './factory.js';
import {
  answerQc,
  assignWorker,
  createJob,
  currentStage,
  paidSample,
  runStage,
  STAGE_ORDER,
  uploadEvidence,
  workerFor,
  type Floor,
} from './floor.js';

export interface ApprovedSample {
  sampleId: string;
  sampleNumber: string;
  sampleJobId: string;
  customerId: string;
  brandId: string;
  colorId: string;
  /** a second colour of the same fabric */
  color2Id: string;
  sizeM: string;
  sizeL: string;
  sizeS: string;
}

/** A sample built by a factory job and approved by the customer: it owns an APPROVED_REFERENCE. */
export async function approvedReferenceSample(
  app: INestApplication,
  a: Actors,
  refs: Refs,
  floor: Floor,
): Promise<ApprovedSample> {
  const flow = await paidSample(app, a, refs);
  const job = await createJob(a.admin, flow.sample.id);
  for (const code of STAGE_ORDER)
    await runStage(app, a.admin, floor, job.id, code);
  const req = (
    await a.sales
      .post(`/admin/samples/${flow.sample.id}/approvals`, { type: 'SAMPLE' })
      .expect(201)
  ).body;
  await a.sales
    .post(`/admin/approvals/${req.id}/approve`, {
      sourceNote: 'Customer approved the physical sample (test)',
    })
    .expect(200);
  const prisma = app.get(PrismaService);
  const sizes = await prisma.sizeOption.findMany({
    where: { code: { in: ['S', 'M', 'L'] }, scale: { code: 'STANDARD' } },
  });
  const size = (c: string) => sizes.find((s) => s.code === c)!.id;
  const color2 = await createFabricColor(a.admin, refs.fabricId);
  return {
    sampleId: flow.sample.id,
    sampleNumber: flow.sample.sampleNumber,
    sampleJobId: job.id,
    customerId: flow.sample.customerId,
    brandId: flow.sample.brandId,
    colorId: flow.sample.colorId,
    color2Id: color2.id,
    sizeM: size('M'),
    sizeL: size('L'),
    sizeS: size('S'),
  };
}

/** 100 units: Black/M 60 + Black/L 40 (or custom). */
export const standardItems = (s: ApprovedSample, qm = 60, ql = 40) => [
  {
    quantity: qm + ql,
    variants: [
      { sizeOptionId: s.sizeM, fabricColorId: s.colorId, quantity: qm },
      { sizeOptionId: s.sizeL, fabricColorId: s.colorId, quantity: ql },
    ],
  },
];

export interface OrderBody {
  id: string;
  orderNumber: string;
  status: string;
  priority: string;
  totalQuantity: number;
  items: {
    id: string;
    quantity: number;
    variants: { id: string; quantity: number; label: string }[];
  }[];
  currentSpec: { id: string; revision: number; totalQuantity: number } | null;
  batches: {
    id: string;
    batchNumber: string;
    status: string;
    quantity: number;
  }[];
  factoryJobs: { id: string; sourceType: string; status: string }[];
  fulfillment: {
    deliveredQuantity: number;
    inFlightQuantity: number;
    shippableQuantity: number;
    remainingDeliveryQuantity: number;
    packagingDefined: boolean;
    packedQuantity: number;
    packagingComplete: boolean;
    trackingEnabled: boolean;
  };
  shipments: { id: string; status: string; quantity: number }[];
  paymentState: string;
  deliveredAt: string | null;
  closedAt: string | null;
  commercial?: Record<string, unknown>;
  [k: string]: unknown;
}

export async function createOrder(
  admin: Api,
  sampleId: string,
  body: object = {},
): Promise<OrderBody> {
  return (
    await admin
      .post(`/admin/samples/${sampleId}/create-order`, body)
      .expect(201)
  ).body;
}

export async function orderDetail(admin: Api, id: string): Promise<OrderBody> {
  return (await admin.get(`/admin/orders/${id}`).expect(200)).body;
}

/** DRAFT → confirmed → READY_FOR_PRODUCTION with the standard 100-unit breakdown. */
export async function readyOrder(
  admin: Api,
  s: ApprovedSample,
  body: { items?: object[] } & Record<string, unknown> = {},
): Promise<OrderBody> {
  const order = await createOrder(admin, s.sampleId, {
    items: standardItems(s),
    ...body,
  });
  await admin.post(`/admin/orders/${order.id}/confirm`).expect(200);
  await admin.post(`/admin/orders/${order.id}/ready`).expect(200);
  return orderDetail(admin, order.id);
}

export async function staffStage(api: Api, stageId: string) {
  return (await api.get(`/staff/job-stages/${stageId}`).expect(200)).body as {
    quantity: {
      required: number;
      produced: number;
      rejected: number;
      remaining: number;
    } | null;
    allowedActions: string[];
    orderView: {
      items: { variants: { variantId: string; quantity: number }[] }[];
    } | null;
  };
}

export interface RunOptions {
  /** units scrapped on this stage */
  reject?: number;
  /** report the produced units in two steps */
  split?: boolean;
  /** variant to attribute the report to */
  variantId?: string;
  /** QC: failed units (result FAIL) */
  failUnits?: number;
  /** report the packaging stage through the packaging endpoint (cartons, damaged units) */
  packaging?: { cartons?: number; damaged?: number };
}

/** Run one bulk stage the way the floor would: assign, start, report quantities, complete. */
export async function runBulkStage(
  app: INestApplication,
  a: Actors,
  floor: Floor,
  jobId: string,
  code: string,
  opts: RunOptions = {},
) {
  const stage = await currentStage(a.admin, jobId, code);
  const worker = stage.assignees.length
    ? workerFor(floor, code)
    : await assignWorker(a.admin, floor, stage);
  await worker.api.post(`/staff/job-stages/${stage.id}/start`).expect(200);
  const detail = await staffStage(worker.api, stage.id);
  const required = detail.quantity!.required;
  if (stage.isQcStage) {
    const insp = (
      await worker.api
        .post(`/staff/job-stages/${stage.id}/qc/start`)
        .expect(201)
    ).body;
    const failUnits = opts.failUnits ?? 0;
    await answerQc(
      app,
      worker,
      insp,
      failUnits ? firstPassFail(insp) : undefined,
    );
    return worker.api.post(`/staff/qc-inspections/${insp.id}/complete`, {
      overallResult: failUnits ? 'FAIL' : 'PASS',
      notes: failUnits ? 'units failed inspection' : undefined,
      inspectedQuantity: required,
      passedQuantity: required - failUnits,
      failedQuantity: failUnits,
    });
  }
  if (opts.packaging && stage.stageCode === 'PACKAGING') {
    const damaged = opts.packaging.damaged ?? 0;
    await worker.api
      .post(`/staff/job-stages/${stage.id}/packaging-reports`, {
        packedQuantity: required - damaged,
        damagedQuantity: damaged,
        cartonCount: opts.packaging.cartons ?? 10,
      })
      .expect(201);
    if (stage.requiresAttachment)
      await uploadEvidence(app, worker.token, stage.id).expect(201);
    return worker.api.post(`/staff/job-stages/${stage.id}/complete`, {
      note: stage.requiresCompletionNote ? 'done' : undefined,
    });
  }
  const reject = opts.reject ?? 0;
  const produced = required - reject;
  const reports =
    opts.split && produced > 1
      ? [Math.floor(produced / 2), produced - Math.floor(produced / 2)]
      : [produced];
  for (const [i, units] of reports.entries()) {
    await worker.api
      .post(`/staff/job-stages/${stage.id}/production-reports`, {
        producedQuantity: units,
        rejectedQuantity: i === 0 ? reject : 0,
        orderVariantId: opts.variantId,
      })
      .expect(201);
  }
  if (stage.requiresAttachment)
    await uploadEvidence(app, worker.token, stage.id).expect(201);
  return worker.api.post(`/staff/job-stages/${stage.id}/complete`, {
    note: stage.requiresCompletionNote ? 'done' : undefined,
  });
}

function firstPassFail(insp: {
  results: { itemCode: string; resultType: string }[];
}): string {
  return insp.results.find((r) => r.resultType === 'PASS_FAIL')!.itemCode;
}

/** Run every stage of a bulk job to completion. */
export async function finishBulkJob(
  app: INestApplication,
  a: Actors,
  floor: Floor,
  jobId: string,
  opts: RunOptions = {},
) {
  for (const code of STAGE_ORDER) {
    const r = await runBulkStage(
      app,
      a,
      floor,
      jobId,
      code,
      code === 'CUTTING' || code === 'PACKAGING' ? opts : {},
    );
    if (r.status !== 200)
      throw new Error(
        `stage ${code} failed: ${r.status} ${JSON.stringify(r.body)}`,
      );
  }
}

export { createCustomerWithBrand };

export const packagingBody = {
  foldingInstructions: 'Fold in thirds, logo up',
  polybagRequired: true,
  labelsRequired: true,
  hangTagsRequired: true,
  unitsPerCarton: 25,
  cartonNotes: 'Max 12 kg per carton',
  components: [{ customName: 'Branded hang tag', quantityPerUnit: 1 }],
};

/** A bulk order whose job has run all ten stages; packaging defined first by default. */
export async function producedOrder(
  app: INestApplication,
  a: Actors,
  floor: Floor,
  s: ApprovedSample,
  opts: {
    packaging?: boolean;
    priority?: string;
    reject?: number;
    damaged?: number;
  } = {},
) {
  const order = await readyOrder(
    a.admin,
    s,
    opts.priority ? { priority: opts.priority } : {},
  );
  if (opts.packaging !== false)
    await a.admin
      .put(`/admin/orders/${order.id}/packaging`, packagingBody)
      .expect(200);
  const job = (
    await a.admin
      .post(`/admin/orders/${order.id}/create-factory-job`)
      .expect(201)
  ).body;
  await finishBulkJob(app, a, floor, job.id, {
    reject: opts.reject,
    packaging:
      opts.packaging === false ? undefined : { damaged: opts.damaged ?? 0 },
  });
  return { order: await orderDetail(a.admin, order.id), job };
}
