import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { auth, createUserAndLogin, loginSuperAdmin, uniq } from './app.js';

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('benue-phase3-image'),
]);

/** Thin authenticated wrapper so specs read as a sequence of API calls. */
export const api = (app: INestApplication, token: string) => ({
  get: (path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set(auth(token)),
  post: (path: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set(auth(token))
      .send(body ?? {}),
  patch: (path: string, body?: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set(auth(token))
      .send(body ?? {}),
  put: (path: string, body?: object) =>
    request(app.getHttpServer())
      .put(`/api/v1${path}`)
      .set(auth(token))
      .send(body ?? {}),
  del: (path: string) =>
    request(app.getHttpServer()).delete(`/api/v1${path}`).set(auth(token)),
  upload: (type: string, filename = 'file.png', buffer: Buffer = PNG) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/assets')
      .set(auth(token))
      .field('type', type)
      .attach('file', buffer, { filename, contentType: 'image/png' }),
});
export type Api = ReturnType<typeof api>;

export interface Actors {
  admin: Api;
  adminToken: string;
  sales: Api;
  salesUserId: string;
  finance: Api;
  financeUserId: string;
  /** a factory role with no commercial rights */
  sewing: Api;
}

export async function makeActors(app: INestApplication): Promise<Actors> {
  const sa = await loginSuperAdmin(app);
  const sales = await createUserAndLogin(app, { roleCodes: ['SALES'] });
  const finance = await createUserAndLogin(app, { roleCodes: ['FINANCE'] });
  const sewing = await createUserAndLogin(app, { roleCodes: ['SEWING'] });
  return {
    admin: api(app, sa.accessToken),
    adminToken: sa.accessToken,
    sales: api(app, sales.accessToken),
    salesUserId: sales.user.id,
    finance: api(app, finance.accessToken),
    financeUserId: finance.user.id,
    sewing: api(app, sewing.accessToken),
  };
}

export interface Refs {
  productTypeId: string;
  hoodieId: string;
  fabricId: string;
  otherFabricId: string;
  sizeId: string;
  printMethodId: string;
  accessoryId: string;
  componentId: string;
  scaleId: string;
}

export async function lookupRefs(app: INestApplication): Promise<Refs> {
  const prisma = app.get(PrismaService);
  const pick = async <T extends { id: string }>(
    p: Promise<T | null>,
    what: string,
  ) => {
    const row = await p;
    if (!row) throw new Error(`seed data missing: ${what}`);
    return row.id;
  };
  const scale = await prisma.sizeScale.findUniqueOrThrow({
    where: { code: 'STANDARD' },
  });
  return {
    productTypeId: await pick(
      prisma.productType.findUnique({ where: { code: 'TEE' } }),
      'TEE',
    ),
    hoodieId: await pick(
      prisma.productType.findUnique({ where: { code: 'HOODIE' } }),
      'HOODIE',
    ),
    fabricId: await pick(
      prisma.fabric.findUnique({ where: { code: 'SINGLE_LYCRA' } }),
      'SINGLE_LYCRA',
    ),
    otherFabricId: await pick(
      prisma.fabric.findUnique({ where: { code: 'OTHER_NOT_SURE' } }),
      'OTHER_NOT_SURE',
    ),
    sizeId: await pick(
      prisma.sizeOption.findFirst({ where: { scaleId: scale.id, code: 'M' } }),
      'size M',
    ),
    printMethodId: await pick(
      prisma.printMethod.findUnique({ where: { code: 'DTF' } }),
      'DTF',
    ),
    accessoryId: await pick(
      prisma.accessory.findUnique({ where: { code: 'ZIP' } }),
      'ZIP',
    ),
    componentId: await pick(
      prisma.componentOption.findUnique({ where: { code: 'POLYBAG' } }),
      'POLYBAG',
    ),
    scaleId: scale.id,
  };
}

export async function createCustomerWithBrand(
  admin: Api,
  extra: Record<string, unknown> = {},
) {
  const customer = (
    await admin
      .post('/admin/customers', {
        displayName: `Cust ${uniq('c')}`,
        whatsapp: '+201001112233',
        ...extra,
      })
      .expect(201)
  ).body;
  const brand = (
    await admin
      .post(`/admin/customers/${customer.id}/brands`, {
        name: `Brand ${uniq('b')}`,
      })
      .expect(201)
  ).body;
  return { customer, brand };
}

export async function createFabricColor(
  admin: Api,
  fabricId: string,
  name = uniq('Color'),
) {
  return (
    await admin
      .post(`/admin/fabrics/${fabricId}/colors`, { name, hex: '#336699' })
      .expect(201)
  ).body;
}

/** Pattern with a PATTERN file and an APPROVED version, ready to pin on a sample. */
export async function approvedPatternVersion(
  admin: Api,
  productTypeId: string,
) {
  const code = uniq('PAT').toUpperCase().replace(/-/g, '_');
  const pattern = (
    await admin
      .post('/admin/patterns', { code, name: 'Test fit', productTypeId })
      .expect(201)
  ).body;
  const versionId = pattern.versions[0].id;
  const asset = (await admin.upload('PATTERN', 'pattern.png').expect(201)).body;
  await admin
    .post(`/admin/assets/${asset.id}/attachments`, {
      targetType: 'PATTERN_VERSION',
      targetId: versionId,
    })
    .expect(201);
  await admin
    .post(`/admin/patterns/${pattern.id}/versions/${versionId}/approve`)
    .expect(200);
  return { patternId: pattern.id as string, versionId: versionId as string };
}

export function acceptActiveTerms(admin: Api, sampleId: string) {
  return admin.post(`/admin/samples/${sampleId}/terms-acceptances`, {
    sourceNote: 'Confirmed by WhatsApp (test)',
  });
}

export interface Draft {
  id: string;
  sampleNumber: string;
  customerId: string;
  brandId: string;
  colorId: string;
  patternVersionId: string;
}

/** A complete, submittable DRAFT (catalogue product/fabric/colour, size, Benue pattern, terms accepted). */
export async function completeDraft(
  app: INestApplication,
  admin: Api,
  refs: Refs,
  overrides: Record<string, unknown> = {},
  opts: { acceptTerms?: boolean } = {},
): Promise<Draft> {
  const { customer, brand } = await createCustomerWithBrand(admin);
  const color = await createFabricColor(admin, refs.fabricId);
  const pattern = await approvedPatternVersion(admin, refs.productTypeId);
  const sample = (
    await admin
      .post('/admin/samples', {
        customerId: customer.id,
        brandId: brand.id,
        productTypeId: refs.productTypeId,
        fabricId: refs.fabricId,
        fabricColorId: color.id,
        fabricProvider: 'BENUE_PRINT',
        sampleSizeOptionId: refs.sizeId,
        fitMethod: 'BENUE_PATTERN',
        patternVersionId: pattern.versionId,
        ...overrides,
      })
      .expect(201)
  ).body;
  if (opts.acceptTerms !== false)
    await acceptActiveTerms(admin, sample.id).expect(201);
  return {
    id: sample.id,
    sampleNumber: sample.sampleNumber,
    customerId: customer.id,
    brandId: brand.id,
    colorId: color.id,
    patternVersionId: pattern.versionId,
  };
}

export const LINES = [
  {
    type: 'SAMPLE_FEE',
    description: 'Sample fee',
    quantity: 1,
    unitPrice: 800,
  },
  { type: 'PRINTING', description: 'DTF print', quantity: 2, unitPrice: 100 },
];

export interface Flow {
  sample: Draft;
  quotationId: string;
  versionId: string;
  total: string;
}

/**
 * Drive a fresh sample through submit → review → quotation sent & accepted.
 * Leaves it AWAITING_PAYMENT (total 1000.00 with default LINES).
 */
export async function toAwaitingPayment(
  app: INestApplication,
  a: Actors,
  refs: Refs,
  lines: object[] = LINES,
  discount = 0,
  taxPercent = 0,
): Promise<Flow> {
  const sample = await completeDraft(app, a.admin, refs);
  return quoteAndAccept(a, sample, lines, discount, taxPercent);
}

/** submit → review → quotation sent & accepted, for an already prepared draft. */
export async function quoteAndAccept(
  a: Actors,
  sample: Draft,
  lines: object[] = LINES,
  discount = 0,
  taxPercent = 0,
): Promise<Flow> {
  await a.sales.post(`/admin/samples/${sample.id}/submit`).expect(200);
  await a.sales.post(`/admin/samples/${sample.id}/review`).expect(200);
  const q = (
    await a.sales
      .post(`/admin/samples/${sample.id}/quotations`, {
        lineItems: lines,
        discount,
        taxPercent,
      })
      .expect(201)
  ).body;
  const versionId = q.currentVersion.id as string;
  await a.sales.post(`/admin/quotation-versions/${versionId}/send`).expect(200);
  await a.sales
    .post(`/admin/quotation-versions/${versionId}/accept`, {
      sourceNote: 'WhatsApp confirmation (test)',
    })
    .expect(200);
  return {
    sample,
    quotationId: q.id,
    versionId,
    total: q.currentVersion.total,
  };
}

/** Record a payment (by `recorder`) and have `verifier` verify it. */
export async function payAndVerify(
  recorder: Api,
  verifier: Api,
  sampleId: string,
  amount: number,
) {
  const proof = (
    await recorder.upload('PAYMENT_PROOF', 'receipt.png').expect(201)
  ).body;
  const payment = (
    await recorder
      .post(`/admin/samples/${sampleId}/payments`, {
        amount,
        method: 'INSTAPAY',
        proofAssetId: proof.id,
      })
      .expect(201)
  ).body;
  await verifier.post(`/admin/payments/${payment.id}/verify`).expect(200);
  return payment.id as string;
}

/** AWAITING_PAYMENT → paid in full → READY_FOR_PRODUCTION → IN_PRODUCTION → AWAITING_APPROVAL. */
export async function toAwaitingApproval(
  app: INestApplication,
  a: Actors,
  refs: Refs,
): Promise<Flow> {
  const flow = await toAwaitingPayment(app, a, refs);
  await produce(a, flow);
  return flow;
}

export async function produce(a: Actors, flow: Flow): Promise<void> {
  await payAndVerify(a.sales, a.finance, flow.sample.id, Number(flow.total));
  await a.admin
    .post(`/admin/samples/${flow.sample.id}/start-production`)
    .expect(200);
  await a.admin
    .post(`/admin/samples/${flow.sample.id}/finish-production`)
    .expect(200);
}
