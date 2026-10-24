import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, uniq } from './app.js';
import { PNG, createCustomerWithBrand, type Api } from './factory.js';

export const CUSTOMER_PASSWORD = 'Portal-Passw0rd-123';

/** Authenticated wrapper for /customer/* routes. */
export const capi = (app: INestApplication, token: string) => ({
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
  upload: (
    sampleId: string,
    fields: Record<string, string>,
    buffer: Buffer = PNG,
    filename = 'ref.png',
  ) => {
    const req = request(app.getHttpServer())
      .post(`/api/v1/customer/samples/${sampleId}/files`)
      .set(auth(token));
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req.attach('file', buffer, { filename, contentType: 'image/png' });
  },
});
export type CApi = ReturnType<typeof capi>;

export interface PortalCustomer {
  customerId: string;
  brandId: string;
  accountId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  api: CApi;
}

export const customerLogin = (
  app: INestApplication,
  email: string,
  password: string,
) =>
  request(app.getHttpServer())
    .post('/api/v1/customer/auth/login')
    .send({ email, password });

/** A customer with one brand, a portal account created by staff, activated through the invitation, logged in. */
export async function makePortalCustomer(
  app: INestApplication,
  admin: Api,
): Promise<PortalCustomer> {
  const { customer, brand } = await createCustomerWithBrand(admin);
  const email = `${uniq('portal')}@test.benue.local`;
  const invite = (
    await admin
      .post(`/admin/customers/${customer.id}/portal-account`, { email })
      .expect(201)
  ).body;
  await request(app.getHttpServer())
    .post('/api/v1/customer/auth/activate')
    .send({ token: invite.inviteToken, password: CUSTOMER_PASSWORD })
    .expect(204);
  const res = await customerLogin(app, email, CUSTOMER_PASSWORD).expect(200);
  return {
    customerId: customer.id,
    brandId: brand.id,
    accountId: invite.id,
    email,
    password: CUSTOMER_PASSWORD,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    api: capi(app, res.body.accessToken),
  };
}

export const PAY_PNG = PNG;

/** Multipart upload helpers for the customer commercial routes. */
export const cPay = (
  app: INestApplication,
  token: string,
  sampleId: string,
  fields: Record<string, string>,
  buffer: Buffer | null = PNG,
) => {
  const req = request(app.getHttpServer())
    .post(`/api/v1/customer/samples/${sampleId}/payments`)
    .set(auth(token));
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return buffer
    ? req.attach('file', buffer, {
        filename: 'receipt.png',
        contentType: 'image/png',
      })
    : req;
};

export const cProof = (
  app: INestApplication,
  token: string,
  paymentId: string,
  buffer: Buffer = PNG,
) =>
  request(app.getHttpServer())
    .post(`/api/v1/customer/payments/${paymentId}/proof`)
    .set(auth(token))
    .attach('file', buffer, {
      filename: 'receipt2.png',
      contentType: 'image/png',
    });

/** A request the customer built, accepted the terms of and submitted through the portal. */
export async function submitPortalSample(
  c: PortalCustomer,
  refs: { sizeId: string },
  extra: Record<string, unknown> = {},
) {
  const s = (
    await c.api
      .post('/customer/samples', {
        brandId: c.brandId,
        customProductName: 'Portal commercial test hoodie',
        customFabricName: 'Own cotton',
        customColorName: 'Navy',
        sampleSizeOptionId: refs.sizeId,
        ...extra,
      })
      .expect(201)
  ).body;
  await c.api.post(`/customer/samples/${s.id}/terms/accept`, {}).expect(200);
  await c.api.post(`/customer/samples/${s.id}/submit`).expect(200);
  return s.id as string;
}

/** A portal login for an EXISTING customer (e.g. the one that owns an approved sample): provision, activate, log in. */
export async function portalForCustomer(
  app: INestApplication,
  admin: Api,
  customerId: string,
  brandId: string,
): Promise<PortalCustomer> {
  const email = `${uniq('portal')}@test.benue.local`;
  const invite = (
    await admin
      .post(`/admin/customers/${customerId}/portal-account`, { email })
      .expect(201)
  ).body;
  await request(app.getHttpServer())
    .post('/api/v1/customer/auth/activate')
    .send({ token: invite.inviteToken, password: CUSTOMER_PASSWORD })
    .expect(204);
  const res = await customerLogin(app, email, CUSTOMER_PASSWORD).expect(200);
  return {
    customerId,
    brandId,
    accountId: invite.id,
    email,
    password: CUSTOMER_PASSWORD,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    api: capi(app, res.body.accessToken),
  };
}
