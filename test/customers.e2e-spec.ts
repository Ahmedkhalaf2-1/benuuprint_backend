import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auditActions,
  auth,
  createTestApp,
  createUserAndLogin,
  loginSuperAdmin,
  uniq,
} from './support/app.js';

describe('Customers, contacts, addresses and brands (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { accessToken: string };
  const http = () => request(app.getHttpServer());
  const A = () => auth(admin.accessToken);

  const newCustomer = async (body: Record<string, unknown> = {}) => {
    const res = await http()
      .post('/api/v1/admin/customers')
      .set(A())
      .send({ displayName: `Cust ${uniq('c')}`, ...body })
      .expect(201);
    return res.body;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  describe('customers', () => {
    it('creates a customer with a generated, human-friendly customerNumber and normalised fields', async () => {
      const c = await newCustomer({
        displayName: '  Nile Streetwear ',
        email: ' Owner@Nile.EXAMPLE ',
        phone: '0020 (100) 123-4567',
        whatsapp: '+20 100 123 4567',
        instagram: '@nile.streetwear',
        country: 'Egypt',
        city: 'Cairo',
        source: 'WhatsApp',
      });
      expect(c.customerNumber).toMatch(/^CUS-\d{6}$/);
      expect(c.displayName).toBe('Nile Streetwear');
      expect(c.email).toBe('owner@nile.example');
      expect(c.phone).toBe('+201001234567');
      expect(c.whatsapp).toBe('+201001234567');
      expect(c.instagram).toBe('nile.streetwear');
      expect(c.status).toBe('ACTIVE');
      expect(c.brands).toEqual([]);
    });

    it('does not require an email (WhatsApp-only leads) and rejects bad input', async () => {
      const c = await newCustomer({
        whatsapp: '+201112223334',
        status: 'LEAD',
      });
      expect(c.email).toBeNull();
      expect(c.status).toBe('LEAD');
      await http()
        .post('/api/v1/admin/customers')
        .set(A())
        .send({ displayName: 'x' })
        .expect(400);
      await http()
        .post('/api/v1/admin/customers')
        .set(A())
        .send({ displayName: 'Valid Name', phone: 'abc' })
        .expect(400);
      await http()
        .post('/api/v1/admin/customers')
        .set(A())
        .send({ displayName: 'Valid Name', email: 'nope' })
        .expect(400);
      await http()
        .post('/api/v1/admin/customers')
        .set(A())
        .send({ displayName: 'Valid Name', status: 'ARCHIVED' })
        .expect(400);
      await http()
        .post('/api/v1/admin/customers')
        .set(A())
        .send({ displayName: 'Valid Name', customerNumber: 'CUS-000001' })
        .expect(400);
    });

    it('generates unique sequential numbers under concurrency', async () => {
      const created = await Promise.all(
        Array.from({ length: 10 }, () => newCustomer()),
      );
      const numbers = created.map((c) => c.customerNumber);
      expect(new Set(numbers).size).toBe(10);
      const values = numbers
        .map((n) => Number(n.slice(4)))
        .sort((a, b) => a - b);
      expect(values[9]! - values[0]!).toBe(9);
    });

    it('searches by number, name, email, phone, WhatsApp and brand name; filters by status', async () => {
      const marker = uniq('zz').replace(/-/g, '');
      const c = await newCustomer({
        displayName: `Search ${marker} Co`,
        email: `${marker}@find.example`,
        phone: '+201009998887',
        whatsapp: '+201005554443',
        status: 'LEAD',
      });
      await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({ name: `Brand${marker}` })
        .expect(201);
      const archivedBrand = await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({ name: `Gone${marker}` });
      await http()
        .delete(`/api/v1/admin/brands/${archivedBrand.body.id}`)
        .set(A())
        .expect(204);

      const find = async (q: string) =>
        (
          await http()
            .get(`/api/v1/admin/customers?search=${encodeURIComponent(q)}`)
            .set(A())
            .expect(200)
        ).body.data.map((x: any) => x.id);
      expect(await find(c.customerNumber)).toContain(c.id);
      expect(await find(c.customerNumber.toLowerCase())).toContain(c.id);
      expect(await find(`Search ${marker}`)).toEqual([c.id]);
      expect(await find(`${marker}@find`)).toEqual([c.id]);
      expect(await find('+20 100 999 8887')).toContain(c.id);
      expect(await find('0020 100 555 4443')).toContain(c.id);
      expect(await find(`Brand${marker}`)).toEqual([c.id]);
      expect(await find(`Gone${marker}`)).toEqual([]); // archived brands are not searchable

      const byStatus = await http()
        .get(`/api/v1/admin/customers?search=${marker}&status=LEAD`)
        .set(A())
        .expect(200);
      expect(byStatus.body.meta.total).toBe(1);
      const wrong = await http()
        .get(`/api/v1/admin/customers?search=${marker}&status=BLOCKED`)
        .set(A());
      expect(wrong.body.meta.total).toBe(0);
    });

    it('paginates and sorts', async () => {
      const marker = uniq('pg').replace(/-/g, '');
      for (const n of ['b', 'a', 'c'])
        await newCustomer({ displayName: `${marker} ${n}` });
      const page = await http()
        .get(
          `/api/v1/admin/customers?search=${marker}&pageSize=2&page=1&sortBy=displayName&sortOrder=asc`,
        )
        .set(A())
        .expect(200);
      expect(page.body.meta).toEqual({ page: 1, pageSize: 2, total: 3 });
      expect(page.body.data.map((x: any) => x.displayName)).toEqual([
        `${marker} a`,
        `${marker} b`,
      ]);
      await http()
        .get('/api/v1/admin/customers?sortBy=passwordHash')
        .set(A())
        .expect(400);
    });

    it('updates details, clears optional fields with null, and rejects unknown/immutable fields', async () => {
      const c = await newCustomer({ email: 'old@x.example', notes: 'n' });
      const res = await http()
        .patch(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .send({ displayName: 'Renamed Co', email: null, city: 'Giza' })
        .expect(200);
      expect(res.body).toMatchObject({
        displayName: 'Renamed Co',
        email: null,
        city: 'Giza',
        notes: 'n',
      });
      expect(res.body.customerNumber).toBe(c.customerNumber);
      await http()
        .patch(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .send({ customerNumber: 'CUS-999999' })
        .expect(400);
      await http()
        .patch(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .send({ status: 'BLOCKED' })
        .expect(400);
    });

    it('changes status, archives (soft), hides archived by default, and restores via status', async () => {
      const c = await newCustomer();
      await http()
        .patch(`/api/v1/admin/customers/${c.id}/status`)
        .set(A())
        .send({ status: 'BLOCKED' })
        .expect(200);
      await http()
        .patch(`/api/v1/admin/customers/${c.id}/status`)
        .set(A())
        .send({ status: 'ARCHIVED' })
        .expect(400);
      const brand = await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({ name: 'B1' })
        .expect(201);

      await http()
        .delete(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .expect(204);
      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(row.status).toBe('ARCHIVED');
      expect(row.archivedAt).not.toBeNull();
      expect(
        (await prisma.brand.findUniqueOrThrow({ where: { id: brand.body.id } }))
          .archivedAt,
      ).not.toBeNull();

      const list = await http()
        .get(`/api/v1/admin/customers?search=${c.customerNumber}`)
        .set(A())
        .expect(200);
      expect(list.body.data).toHaveLength(0);
      const withArchived = await http()
        .get(
          `/api/v1/admin/customers?search=${c.customerNumber}&includeArchived=true`,
        )
        .set(A());
      expect(withArchived.body.data).toHaveLength(1);

      await http()
        .delete(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .expect(409);
      await http()
        .patch(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .send({ city: 'X' })
        .expect(409);
      await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({ name: 'B2' })
        .expect(409);

      const restored = await http()
        .patch(`/api/v1/admin/customers/${c.id}/status`)
        .set(A())
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(restored.body.archivedAt).toBeNull();
      expect(restored.body.brands).toEqual([]); // brands stay archived until restored individually
      expect(await auditActions(app, c.id)).toEqual(
        expect.arrayContaining([
          'customer.created',
          'customer.status_changed',
          'customer.archived',
        ]),
      );
    });

    it('has no hard-delete path and 404s for unknown ids', async () => {
      const c = await newCustomer();
      await http()
        .delete(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .expect(204);
      expect(await prisma.customer.count({ where: { id: c.id } })).toBe(1);
      await http()
        .get('/api/v1/admin/customers/3f2b1c0e-0000-4000-8000-000000000000')
        .set(A())
        .expect(404);
      await http()
        .get('/api/v1/admin/customers/not-a-uuid')
        .set(A())
        .expect(400);
    });

    it('enforces authentication and least privilege', async () => {
      const c = await newCustomer();
      await http().get('/api/v1/admin/customers').expect(401);
      const reader = await createUserAndLogin(app, {
        permissions: ['customers.read'],
      });
      await http()
        .get('/api/v1/admin/customers')
        .set(auth(reader.accessToken))
        .expect(200);
      await http()
        .get(`/api/v1/admin/customers/${c.id}`)
        .set(auth(reader.accessToken))
        .expect(200);
      await http()
        .post('/api/v1/admin/customers')
        .set(auth(reader.accessToken))
        .send({ displayName: 'Nope Co' })
        .expect(403);
      await http()
        .patch(`/api/v1/admin/customers/${c.id}`)
        .set(auth(reader.accessToken))
        .send({ city: 'x' })
        .expect(403);
      await http()
        .delete(`/api/v1/admin/customers/${c.id}`)
        .set(auth(reader.accessToken))
        .expect(403);
      const none = await createUserAndLogin(app, {
        permissions: ['samples.read'],
      });
      await http()
        .get('/api/v1/admin/customers')
        .set(auth(none.accessToken))
        .expect(403);
      // seeded SALES role may manage customers, FINANCE only read
      const sales = await createUserAndLogin(app, { roleCodes: ['SALES'] });
      await http()
        .post('/api/v1/admin/customers')
        .set(auth(sales.accessToken))
        .send({ displayName: 'Sales Made' })
        .expect(201);
      const finance = await createUserAndLogin(app, { roleCodes: ['FINANCE'] });
      await http()
        .get('/api/v1/admin/customers')
        .set(auth(finance.accessToken))
        .expect(200);
      await http()
        .post('/api/v1/admin/customers')
        .set(auth(finance.accessToken))
        .send({ displayName: 'Fin Made' })
        .expect(403);
    });
  });

  describe('brands', () => {
    it('lets one customer own several brands with generated numbers', async () => {
      const c = await newCustomer();
      const b1 = await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({
          name: 'Core',
          instagram: '@core.brand',
          website: 'https://core.example',
          primaryColor: '#112233',
        })
        .expect(201);
      const b2 = await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({ name: 'Sport' })
        .expect(201);
      expect(b1.body.brandNumber).toMatch(/^BRD-\d{6}$/);
      expect(b1.body.brandNumber).not.toBe(b2.body.brandNumber);
      expect(b1.body.instagram).toBe('core.brand');
      expect(b1.body.customer).toMatchObject({
        id: c.id,
        customerNumber: c.customerNumber,
      });

      const list = await http()
        .get(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .expect(200);
      expect(list.body.data.map((b: any) => b.name)).toEqual(['Core', 'Sport']);
      const detail = await http()
        .get(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .expect(200);
      expect(detail.body.brands.map((b: any) => b.name)).toEqual([
        'Core',
        'Sport',
      ]);
    });

    it('allows the same name for different customers but not twice for one customer (case-insensitive)', async () => {
      const c1 = await newCustomer();
      const c2 = await newCustomer();
      const name = `Shared ${uniq('n')}`;
      await http()
        .post(`/api/v1/admin/customers/${c1.id}/brands`)
        .set(A())
        .send({ name })
        .expect(201);
      await http()
        .post(`/api/v1/admin/customers/${c2.id}/brands`)
        .set(A())
        .send({ name })
        .expect(201);
      await http()
        .post(`/api/v1/admin/customers/${c1.id}/brands`)
        .set(A())
        .send({ name: name.toUpperCase() })
        .expect(409);
    });

    it('updates, archives, frees the name and restores', async () => {
      const c = await newCustomer();
      const b = await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({ name: 'Orig' })
        .expect(201);
      const upd = await http()
        .patch(`/api/v1/admin/brands/${b.body.id}`)
        .set(A())
        .send({ name: 'Renamed', secondaryColor: '#ffffff', website: null })
        .expect(200);
      expect(upd.body).toMatchObject({
        name: 'Renamed',
        secondaryColor: '#ffffff',
      });
      await http()
        .patch(`/api/v1/admin/brands/${b.body.id}`)
        .set(A())
        .send({ primaryColor: 'red' })
        .expect(400);
      await http()
        .patch(`/api/v1/admin/brands/${b.body.id}`)
        .set(A())
        .send({ customerId: c.id })
        .expect(400);

      await http()
        .delete(`/api/v1/admin/brands/${b.body.id}`)
        .set(A())
        .expect(204);
      await http()
        .delete(`/api/v1/admin/brands/${b.body.id}`)
        .set(A())
        .expect(409);
      await http()
        .patch(`/api/v1/admin/brands/${b.body.id}`)
        .set(A())
        .send({ name: 'Edit archived' })
        .expect(409);
      const hidden = await http()
        .get(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A());
      expect(hidden.body.data).toHaveLength(0);
      const shown = await http()
        .get(`/api/v1/admin/customers/${c.id}/brands?includeArchived=true`)
        .set(A());
      expect(shown.body.data).toHaveLength(1);

      // the name is free again while archived
      await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(A())
        .send({ name: 'Renamed' })
        .expect(201);
      await http()
        .patch(`/api/v1/admin/brands/${b.body.id}`)
        .set(A())
        .send({ status: 'ACTIVE' })
        .expect(409); // would clash
      expect(await auditActions(app, b.body.id)).toEqual(
        expect.arrayContaining([
          'brand.created',
          'brand.updated',
          'brand.archived',
        ]),
      );
    });

    it('rejects an unknown customer and a customer id that is not a uuid', async () => {
      await http()
        .post(
          '/api/v1/admin/customers/3f2b1c0e-0000-4000-8000-000000000000/brands',
        )
        .set(A())
        .send({ name: 'X' })
        .expect(404);
      await http()
        .get(
          '/api/v1/admin/customers/3f2b1c0e-0000-4000-8000-000000000000/brands',
        )
        .set(A())
        .expect(404);
      await http()
        .post('/api/v1/admin/customers/nope/brands')
        .set(A())
        .send({ name: 'X' })
        .expect(400);
      await http()
        .get('/api/v1/admin/brands/3f2b1c0e-0000-4000-8000-000000000000')
        .set(A())
        .expect(404);
    });

    it('enforces permissions', async () => {
      const c = await newCustomer();
      const reader = await createUserAndLogin(app, {
        permissions: ['customers.read'],
      });
      await http()
        .get(`/api/v1/admin/customers/${c.id}/brands`)
        .set(auth(reader.accessToken))
        .expect(200);
      await http()
        .post(`/api/v1/admin/customers/${c.id}/brands`)
        .set(auth(reader.accessToken))
        .send({ name: 'X' })
        .expect(403);
      await http().get(`/api/v1/admin/customers/${c.id}/brands`).expect(401);
    });
  });

  describe('contacts and addresses', () => {
    it('manages contacts with a single primary', async () => {
      const c = await newCustomer();
      const a = await http()
        .post(`/api/v1/admin/customers/${c.id}/contacts`)
        .set(A())
        .send({
          name: 'Owner One',
          role: 'OWNER',
          isPrimary: true,
          whatsapp: '+201000000001',
        })
        .expect(201);
      const b = await http()
        .post(`/api/v1/admin/customers/${c.id}/contacts`)
        .set(A())
        .send({
          name: 'Finance Two',
          role: 'FINANCE',
          isPrimary: true,
          email: 'FIN@X.EXAMPLE',
        })
        .expect(201);
      expect(b.body.email).toBe('fin@x.example');
      const list = await http()
        .get(`/api/v1/admin/customers/${c.id}/contacts`)
        .set(A())
        .expect(200);
      expect(
        list.body.filter((x: any) => x.isPrimary).map((x: any) => x.id),
      ).toEqual([b.body.id]);

      const upd = await http()
        .patch(`/api/v1/admin/customer-contacts/${a.body.id}`)
        .set(A())
        .send({ isPrimary: true, jobTitle: 'CEO' })
        .expect(200);
      expect(upd.body.jobTitle).toBe('CEO');
      const after = await http()
        .get(`/api/v1/admin/customers/${c.id}/contacts`)
        .set(A());
      expect(
        after.body.filter((x: any) => x.isPrimary).map((x: any) => x.id),
      ).toEqual([a.body.id]);

      await http()
        .delete(`/api/v1/admin/customer-contacts/${b.body.id}`)
        .set(A())
        .expect(204);
      await http()
        .delete(`/api/v1/admin/customer-contacts/${b.body.id}`)
        .set(A())
        .expect(404);
      const detail = await http()
        .get(`/api/v1/admin/customers/${c.id}`)
        .set(A());
      expect(detail.body.contacts).toHaveLength(1);
      expect(await auditActions(app, a.body.id)).toEqual(
        expect.arrayContaining([
          'customer_contact.created',
          'customer_contact.updated',
        ]),
      );
    });

    it('manages addresses with one default per type', async () => {
      const c = await newCustomer();
      const base = {
        country: 'Egypt',
        city: 'Cairo',
        addressLine1: '1 Nile St',
      };
      const s1 = await http()
        .post(`/api/v1/admin/customers/${c.id}/addresses`)
        .set(A())
        .send({
          ...base,
          type: 'SHIPPING',
          isDefault: true,
          state: 'Cairo',
          area: 'Maadi',
        })
        .expect(201);
      const bill = await http()
        .post(`/api/v1/admin/customers/${c.id}/addresses`)
        .set(A())
        .send({ ...base, type: 'BILLING', isDefault: true })
        .expect(201);
      const s2 = await http()
        .post(`/api/v1/admin/customers/${c.id}/addresses`)
        .set(A())
        .send({ ...base, addressLine1: '2 Nile St', isDefault: true })
        .expect(201);
      const list = await http()
        .get(`/api/v1/admin/customers/${c.id}/addresses`)
        .set(A())
        .expect(200);
      const defaults = list.body
        .filter((x: any) => x.isDefault)
        .map((x: any) => x.id)
        .sort((a: string, b: string) => a.localeCompare(b));
      expect(defaults).toEqual(
        [bill.body.id, s2.body.id].sort((a: string, b: string) =>
          a.localeCompare(b),
        ),
      );
      expect(list.body.find((x: any) => x.id === s1.body.id).isDefault).toBe(
        false,
      );

      const upd = await http()
        .patch(`/api/v1/admin/customer-addresses/${s1.body.id}`)
        .set(A())
        .send({ postalCode: '11728', area: null })
        .expect(200);
      expect(upd.body).toMatchObject({ postalCode: '11728', area: null });
      await http()
        .post(`/api/v1/admin/customers/${c.id}/addresses`)
        .set(A())
        .send({ country: 'Egypt' })
        .expect(400);
      await http()
        .delete(`/api/v1/admin/customer-addresses/${s1.body.id}`)
        .set(A())
        .expect(204);
      expect(
        (await http().get(`/api/v1/admin/customers/${c.id}/addresses`).set(A()))
          .body,
      ).toHaveLength(2);
    });

    it('rejects contacts/addresses for unknown or archived customers and enforces permissions', async () => {
      const c = await newCustomer();
      await http()
        .post(
          '/api/v1/admin/customers/3f2b1c0e-0000-4000-8000-000000000000/contacts',
        )
        .set(A())
        .send({ name: 'Ghost' })
        .expect(404);
      const reader = await createUserAndLogin(app, {
        permissions: ['customers.read'],
      });
      await http()
        .get(`/api/v1/admin/customers/${c.id}/contacts`)
        .set(auth(reader.accessToken))
        .expect(200);
      await http()
        .post(`/api/v1/admin/customers/${c.id}/contacts`)
        .set(auth(reader.accessToken))
        .send({ name: 'Nope' })
        .expect(403);
      await http()
        .delete(`/api/v1/admin/customers/${c.id}`)
        .set(A())
        .expect(204);
      await http()
        .post(`/api/v1/admin/customers/${c.id}/contacts`)
        .set(A())
        .send({ name: 'Late' })
        .expect(409);
    });
  });
});
