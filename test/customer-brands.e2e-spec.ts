import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { auth, createTestApp, uniq } from './support/app.js';
import { makePortalCustomer, type PortalCustomer } from './support/customer.js';
import { makeActors, type Actors } from './support/factory.js';

describe('Customer brand self-creation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let alice: PortalCustomer;
  let bob: PortalCustomer;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    alice = await makePortalCustomer(app, a.admin);
    bob = await makePortalCustomer(app, a.admin);
  });
  afterAll(() => app.close());

  const create = (c: PortalCustomer, body: object) =>
    c.api.post('/customer/brands', body);

  it('creates a brand for the signed-in customer, ACTIVE, listed and audited with the customer actor', async () => {
    const name = uniq('Nile');
    const res = await create(alice, {
      name,
      instagram: '@nile.core',
      website: 'https://nile.example.com',
      description: 'Streetwear',
      primaryColor: '#112233',
    }).expect(201);
    expect(res.body).toMatchObject({
      name,
      instagram: 'nile.core',
      website: 'https://nile.example.com',
      primaryColor: '#112233',
      brandNumber: expect.stringMatching(/^BRD-\d+$/),
    });
    expect(res.body).not.toHaveProperty('customerId');
    expect(res.body).not.toHaveProperty('status');

    const row = await prisma.brand.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row).toMatchObject({
      customerId: alice.customerId,
      status: 'ACTIVE',
      archivedAt: null,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'brand.created', entityId: row.id },
    });
    expect(audit).toMatchObject({
      actorCustomerId: alice.customerId,
      actorUserId: null,
    });

    const list = (await alice.api.get('/customer/brands').expect(200)).body;
    expect(list.map((b: { id: string }) => b.id)).toContain(row.id);
    expect(
      (await bob.api.get('/customer/brands').expect(200)).body.map(
        (b: { id: string }) => b.id,
      ),
    ).not.toContain(row.id);
  });

  it('ignores nothing: staff-only and ownership fields are rejected', async () => {
    for (const extra of [
      { customerId: bob.customerId },
      { status: 'INACTIVE' },
      { notes: 'x' },
      { archivedAt: new Date().toISOString() },
      { salesOwnerId: a.salesUserId },
      { brandNumber: 'BRD-999999' },
    ]) {
      await create(alice, { name: uniq('X'), ...extra }).expect(400);
    }
    await create(alice, {}).expect(400);
    await create(alice, { name: uniq('X'), primaryColor: 'red' }).expect(400);
    await create(alice, {
      name: uniq('X'),
      website: 'javascript:alert(1)',
    }).expect(400);
  });

  it('answers 409 for a duplicate name (case-insensitive) but allows the same name for another customer', async () => {
    const name = uniq('Dup');
    await create(alice, { name }).expect(201);
    await create(alice, { name: name.toUpperCase() }).expect(409);
    await create(bob, { name }).expect(201);
  });

  it('lets a customer edit only their own brand; foreign and archived ids are 404', async () => {
    const mine = (await create(alice, { name: uniq('Edit') }).expect(201)).body;
    const edited = await alice.api
      .patch(`/customer/brands/${mine.id}`, {
        description: 'New story',
        website: null,
      })
      .expect(200);
    expect(edited.body).toMatchObject({
      description: 'New story',
      website: null,
    });
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'brand.updated',
          entityId: mine.id,
          actorCustomerId: alice.customerId,
        },
      }),
    ).toBe(1);
    await alice.api
      .patch(`/customer/brands/${mine.id}`, { status: 'INACTIVE' })
      .expect(400);
    await alice.api
      .patch(`/customer/brands/${mine.id}`, { customerId: bob.customerId })
      .expect(400);

    // another customer
    await bob.api.get(`/customer/brands/${mine.id}`).expect(404);
    await bob.api
      .patch(`/customer/brands/${mine.id}`, { description: 'hijack' })
      .expect(404);
    expect(
      (await prisma.brand.findUniqueOrThrow({ where: { id: mine.id } }))
        .description,
    ).toBe('New story');

    // archived by staff -> gone for the customer
    await a.admin.del(`/admin/brands/${mine.id}`).expect(204);
    await alice.api
      .patch(`/customer/brands/${mine.id}`, { description: 'x' })
      .expect(404);
  });

  it('a self-created brand is immediately usable for a sample, and only by its owner', async () => {
    const brand = (await create(alice, { name: uniq('Sample') }).expect(201))
      .body;
    const sample = (
      await alice.api
        .post('/customer/samples', { brandId: brand.id })
        .expect(201)
    ).body;
    const row = await prisma.sample.findUniqueOrThrow({
      where: { id: sample.id },
    });
    expect(row).toMatchObject({
      customerId: alice.customerId,
      brandId: brand.id,
    });
    // same behaviour as any foreign brand in the existing sample flow
    await bob.api.post('/customer/samples', { brandId: brand.id }).expect(400);
  });

  it('leaves staff brand management and the customer/staff boundary unchanged', async () => {
    const { customerId } = alice;
    const staffBrand = (
      await a.admin
        .post(`/admin/customers/${customerId}/brands`, {
          name: uniq('Staff'),
          status: 'INACTIVE',
        })
        .expect(201)
    ).body;
    expect(staffBrand.status).toBe('INACTIVE');
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'brand.created', entityId: staffBrand.id },
    });
    expect(audit).toMatchObject({
      actorCustomerId: null,
      actorUserId: expect.any(String),
    });

    await http()
      .post('/api/v1/customer/brands')
      .set(auth(a.adminToken))
      .send({ name: 'x' })
      .expect(401);
    await http()
      .post(`/api/v1/admin/customers/${customerId}/brands`)
      .set(auth(alice.accessToken))
      .send({ name: 'x' })
      .expect(401);
    await http()
      .patch(`/api/v1/admin/brands/${staffBrand.id}`)
      .set(auth(alice.accessToken))
      .send({})
      .expect(401);
  });
});
