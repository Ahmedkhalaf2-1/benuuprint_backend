import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auth,
  createTestApp,
  lastDeliveredToken,
  uniq,
} from './support/app.js';
import {
  CUSTOMER_PASSWORD,
  capi,
  customerLogin,
  makePortalCustomer,
  type PortalCustomer,
} from './support/customer.js';
import {
  PNG,
  approvedPatternVersion,
  createCustomerWithBrand,
  createFabricColor,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';

describe('Customer portal (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;
  let alice: PortalCustomer;
  let bob: PortalCustomer;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    alice = await makePortalCustomer(app, a.admin);
    bob = await makePortalCustomer(app, a.admin);
  });
  afterAll(() => app.close());

  const draft = async (c: PortalCustomer, body: object = {}) =>
    (
      await c.api
        .post('/customer/samples', { brandId: c.brandId, ...body })
        .expect(201)
    ).body;

  // ───────────────────────────── auth ─────────────────────────────

  describe('authentication', () => {
    it('provisions, activates once, logs in and returns only customer-safe identity', async () => {
      const { customer } = await createCustomerWithBrand(a.admin);
      const email = `${uniq('p')}@test.benue.local`;
      const invite = (
        await a.admin
          .post(`/admin/customers/${customer.id}/portal-account`, { email })
          .expect(201)
      ).body;
      expect(invite.status).toBe('INVITED');
      // one portal account per customer, and per email
      await a.admin
        .post(`/admin/customers/${customer.id}/portal-account`, {
          email: `${uniq('p')}@test.benue.local`,
        })
        .expect(409);
      // not usable before activation
      await customerLogin(app, email, CUSTOMER_PASSWORD).expect(401);

      await http()
        .post('/api/v1/customer/auth/activate')
        .send({ token: invite.inviteToken, password: CUSTOMER_PASSWORD })
        .expect(204);
      await http()
        .post('/api/v1/customer/auth/activate')
        .send({ token: invite.inviteToken, password: CUSTOMER_PASSWORD })
        .expect(400);

      const res = await customerLogin(app, email, CUSTOMER_PASSWORD).expect(
        200,
      );
      expect(res.body.tokenType).toBe('Bearer');
      expect(Object.keys(res.body.customer).sort()).toEqual([
        'customerNumber',
        'email',
        'id',
        'name',
      ]);
      expect(res.body.customer.id).toBe(customer.id);
      expect(res.body).not.toHaveProperty('user');
      expect(JSON.stringify(res.body)).not.toMatch(/permission|roles/);

      const me = (
        await capi(app, res.body.accessToken)
          .get('/customer/auth/me')
          .expect(200)
      ).body;
      expect(me).toMatchObject({
        id: customer.id,
        email,
        accountStatus: 'ACTIVE',
      });
      expect(Object.keys(me)).not.toEqual(
        expect.arrayContaining(['notes', 'status', 'source']),
      );
      // the staff view of the account
      const acct = (
        await a.admin
          .get(`/admin/customers/${customer.id}/portal-account`)
          .expect(200)
      ).body;
      expect(acct.status).toBe('ACTIVE');
      expect(acct).not.toHaveProperty('passwordHash');
    });

    it('gives the same answer for unknown email and wrong password', async () => {
      const unknown = await customerLogin(
        app,
        `${uniq('nobody')}@test.benue.local`,
        CUSTOMER_PASSWORD,
      ).expect(401);
      const wrong = await customerLogin(
        app,
        alice.email,
        'Wrong-Passw0rd-999',
      ).expect(401);
      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
      const c = await makePortalCustomer(app, a.admin);
      const refresh = (token: string) =>
        http()
          .post('/api/v1/customer/auth/refresh')
          .send({ refreshToken: token });
      const second = (await refresh(c.refreshToken).expect(200)).body;
      expect(second.refreshToken).not.toBe(c.refreshToken);
      await capi(app, second.accessToken).get('/customer/auth/me').expect(200);
      // replaying the rotated-out token is theft: the whole session dies
      await refresh(c.refreshToken).expect(401);
      await refresh(second.refreshToken).expect(401);
      await capi(app, second.accessToken).get('/customer/auth/me').expect(401);
      const reuse = await prisma.auditLog.findFirst({
        where: {
          actorCustomerId: c.customerId,
          action: 'customer_auth.refresh_reuse_detected',
        },
      });
      expect(reuse).not.toBeNull();
    });

    it('logs out (session revoked) and writes audit entries for the customer', async () => {
      const c = await makePortalCustomer(app, a.admin);
      await c.api.post('/customer/auth/logout').expect(204);
      await c.api.get('/customer/auth/me').expect(401);
      await http()
        .post('/api/v1/customer/auth/refresh')
        .send({ refreshToken: c.refreshToken })
        .expect(401);
      const actions = (
        await prisma.auditLog.findMany({
          where: { actorCustomerId: c.customerId },
        })
      ).map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'customer_portal.invitation_accepted',
          'customer_auth.login_success',
          'customer_auth.logout',
        ]),
      );
    });

    it('stops a disabled account immediately, even with a live token', async () => {
      const c = await makePortalCustomer(app, a.admin);
      await c.api.get('/customer/auth/me').expect(200);
      await a.admin
        .post(`/admin/customers/${c.customerId}/portal-account/disable`)
        .expect(200);
      await c.api.get('/customer/auth/me').expect(401);
      await customerLogin(app, c.email, c.password).expect(401);
      await a.admin
        .post(`/admin/customers/${c.customerId}/portal-account/enable`)
        .expect(200);
      await customerLogin(app, c.email, c.password).expect(200);
    });

    it('stops a blocked customer', async () => {
      const c = await makePortalCustomer(app, a.admin);
      await a.admin
        .patch(`/admin/customers/${c.customerId}/status`, {
          status: 'BLOCKED',
        })
        .expect(200);
      await c.api.get('/customer/auth/me').expect(401);
      await customerLogin(app, c.email, c.password).expect(401);
    });

    it('resets a forgotten password and revokes existing sessions', async () => {
      const c = await makePortalCustomer(app, a.admin);
      const known = await http()
        .post('/api/v1/customer/auth/forgot-password')
        .send({ email: c.email })
        .expect(200);
      const unknown = await http()
        .post('/api/v1/customer/auth/forgot-password')
        .send({ email: `${uniq('x')}@test.benue.local` })
        .expect(200);
      expect(known.body).toEqual(unknown.body);
      const token = lastDeliveredToken(c.email, 'PASSWORD_RESET');
      expect(token).toBeTruthy();
      const next = 'Brand-New-Passw0rd-1';
      await http()
        .post('/api/v1/customer/auth/reset-password')
        .send({ token, newPassword: next })
        .expect(204);
      await http()
        .post('/api/v1/customer/auth/reset-password')
        .send({ token, newPassword: next })
        .expect(400);
      await c.api.get('/customer/auth/me').expect(401);
      await customerLogin(app, c.email, c.password).expect(401);
      await customerLogin(app, c.email, next).expect(200);
    });
  });

  // ───────────────────────── token isolation ─────────────────────────

  describe('staff / customer token isolation', () => {
    it('rejects a staff token on every customer route', async () => {
      for (const path of [
        '/customer/auth/me',
        '/customer/samples',
        '/customer/profile',
        '/customer/brands',
        '/customer/configurator/sample-options',
      ]) {
        await http().get(`/api/v1${path}`).set(auth(a.adminToken)).expect(401);
      }
    });

    it('rejects a customer token on staff and admin routes', async () => {
      for (const path of [
        '/auth/me',
        '/admin/samples',
        '/admin/customers',
        '/configurator/sample-options',
        '/admin/audit-logs',
      ]) {
        await http()
          .get(`/api/v1${path}`)
          .set(auth(alice.accessToken))
          .expect(401);
      }
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: alice.refreshToken })
        .expect(401);
    });

    it('does not accept staff credentials for the portal or customer credentials for staff login', async () => {
      await customerLogin(app, 'admin@test.benue.local', 'x').expect(401);
      await http()
        .post('/api/v1/auth/login')
        .send({ email: alice.email, password: alice.password })
        .expect(401);
    });

    it('requires authentication on portal routes', async () => {
      await http().get('/api/v1/customer/samples').expect(401);
      await http().get('/api/v1/customer/profile').expect(401);
      await http()
        .get('/api/v1/customer/samples')
        .set(auth('not-a-token'))
        .expect(401);
    });
  });

  // ───────────────────────────── ownership ─────────────────────────────

  describe('ownership (no IDOR)', () => {
    it('hides one customer’s request, files and parts from another', async () => {
      const mine = await draft(alice, {
        customProductName: 'Alice jacket',
      });
      const upload = (
        await alice.api.upload(mine.id, { type: 'REFERENCE' }).expect(201)
      ).body;
      const deco = (
        await alice.api
          .post(`/customer/samples/${mine.id}/decorations`, {
            printMethodId: refs.printMethodId,
            placement: 'chest',
          })
          .expect(201)
      ).body;

      // reads
      await bob.api.get(`/customer/samples/${mine.id}`).expect(404);
      await bob.api.get(`/customer/samples/${mine.id}/activity`).expect(404);
      await bob.api.get(`/customer/samples/${mine.id}/messages`).expect(404);
      await bob.api.get(`/customer/samples/${mine.id}/files`).expect(404);
      await bob.api
        .get(`/customer/samples/${mine.id}/submission-check`)
        .expect(404);
      await bob.api
        .get(
          `/customer/samples/${mine.id}/files/${upload.attachmentId}/download-url`,
        )
        .expect(404);
      // writes
      await bob.api
        .patch(`/customer/samples/${mine.id}`, { notes: 'hijack' })
        .expect(404);
      await bob.api.post(`/customer/samples/${mine.id}/submit`).expect(404);
      await bob.api
        .post(`/customer/samples/${mine.id}/terms/accept`, {})
        .expect(404);
      await bob.api.upload(mine.id, { type: 'REFERENCE' }).expect(404);
      await bob.api
        .del(`/customer/samples/${mine.id}/files/${upload.attachmentId}`)
        .expect(404);
      await bob.api
        .post(`/customer/samples/${mine.id}/decorations`, {
          printMethodId: refs.printMethodId,
          placement: 'back',
        })
        .expect(404);
      await bob.api
        .patch(`/customer/samples/${mine.id}/decorations/${deco.id}`, {
          placement: 'x',
        })
        .expect(404);
      // even naming my own sample with someone else's child id gives nothing
      const bobsDraft = await draft(bob);
      await bob.api
        .patch(`/customer/samples/${bobsDraft.id}/decorations/${deco.id}`, {
          placement: 'x',
        })
        .expect(404);
      await bob.api
        .del(`/customer/samples/${bobsDraft.id}/files/${upload.attachmentId}`)
        .expect(404);

      // lists are scoped
      const bobsList = (await bob.api.get('/customer/samples').expect(200))
        .body;
      expect(bobsList.data.map((s: { id: string }) => s.id)).not.toContain(
        mine.id,
      );
      // nothing changed
      const still = (
        await alice.api.get(`/customer/samples/${mine.id}`).expect(200)
      ).body;
      expect(still.notes).toBeNull();
      expect(still.decorations[0].placement).toBe('chest');
    });

    it('validates brand ownership on create and update, regardless of the client', async () => {
      const own = await draft(alice);
      const res = await alice.api
        .post('/customer/samples', { brandId: bob.brandId })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('brand not found');
      await alice.api
        .patch(`/customer/samples/${own.id}`, { brandId: bob.brandId })
        .expect(400);
      await alice.api
        .post('/customer/samples', {
          brandId: '00000000-0000-4000-8000-000000000000',
        })
        .expect(400);
      // own brand is fine
      await alice.api
        .patch(`/customer/samples/${own.id}`, { brandId: alice.brandId })
        .expect(200);
    });

    it('never accepts ownership, status or internal fields from the client', async () => {
      const own = await draft(alice);
      await alice.api
        .post('/customer/samples', {
          brandId: alice.brandId,
          customerId: bob.customerId,
        })
        .expect(400);
      await alice.api
        .patch(`/customer/samples/${own.id}`, { status: 'APPROVED' })
        .expect(400);
      await alice.api
        .patch(`/customer/samples/${own.id}`, { customerId: bob.customerId })
        .expect(400);
      await alice.api
        .patch(`/customer/samples/${own.id}`, { factoryInstructions: 'x' })
        .expect(400);
      await alice.api
        .post('/customer/samples', {
          brandId: alice.brandId,
          assignedSalesUserId: a.salesUserId,
        })
        .expect(400);
      const after = await prisma.sample.findUniqueOrThrow({
        where: { id: own.id },
      });
      expect(after.status).toBe('DRAFT');
      expect(after.customerId).toBe(alice.customerId);
      const created = await prisma.sample.findUniqueOrThrow({
        where: { id: own.id },
      });
      expect(created.createdByCustomerId).toBe(alice.customerId);
      expect(created.createdByStaffUserId).toBeNull();
    });
  });

  // ───────────────────────── sample lifecycle ─────────────────────────

  describe('sample request lifecycle', () => {
    it('creates a minimal draft, saves it incompletely and lists/filters it', async () => {
      const s = await draft(alice);
      expect(s).toMatchObject({
        status: 'DRAFT',
        editable: true,
        brand: { id: alice.brandId },
      });
      expect(s.sampleNumber).toMatch(/^SMP-/);
      expect(s.nextStep).toBeTruthy();
      const saved = (
        await alice.api
          .patch(`/customer/samples/${s.id}`, {
            customProductName: 'Custom varsity jacket',
            customColorName: 'Burnt orange',
            gsm: 320,
          })
          .expect(200)
      ).body;
      expect(saved).toMatchObject({
        customProductName: 'Custom varsity jacket',
        productName: 'Custom varsity jacket',
        status: 'DRAFT',
      });
      // mutually exclusive pairs are still enforced on drafts
      await alice.api
        .patch(`/customer/samples/${s.id}`, {
          productTypeId: refs.productTypeId,
        })
        .expect(400);

      const list = (
        await alice.api
          .get('/customer/samples?status=DRAFT&search=varsity&sort=updated')
          .expect(200)
      ).body;
      expect(list.data.map((x: { id: string }) => x.id)).toContain(s.id);
      expect(list.meta.total).toBeGreaterThanOrEqual(1);
      const none = (
        await alice.api.get('/customer/samples?status=APPROVED').expect(200)
      ).body;
      expect(none.data.map((x: { id: string }) => x.id)).not.toContain(s.id);
      await alice.api.get('/customer/samples?status=NOPE').expect(400);
    });

    it('reports every submission problem together and refuses an incomplete draft', async () => {
      const s = await draft(alice);
      const check = (
        await alice.api
          .get(`/customer/samples/${s.id}/submission-check`)
          .expect(200)
      ).body;
      expect(check.ready).toBe(false);
      expect(check.problems.length).toBeGreaterThanOrEqual(3);
      const res = await alice.api
        .post(`/customer/samples/${s.id}/submit`)
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/product|fabric|terms/);
      const after = await prisma.sample.findUniqueOrThrow({
        where: { id: s.id },
      });
      expect(after.status).toBe('DRAFT');
    });

    it('builds a full request with artwork and terms, submits it and hands it to staff', async () => {
      const color = await createFabricColor(a.admin, refs.fabricId);
      const pattern = await approvedPatternVersion(a.admin, refs.productTypeId);
      const s = await draft(alice, {
        productTypeId: refs.productTypeId,
        fabricId: refs.fabricId,
        fabricColorId: color.id,
        fabricProvider: 'BENUE_PRINT',
        sampleSizeOptionId: refs.sizeId,
        fitMethod: 'BENUE_PATTERN',
        patternVersionId: pattern.versionId,
        notes: 'Please keep the neckline low',
      });
      const deco = (
        await alice.api
          .post(`/customer/samples/${s.id}/decorations`, {
            printMethodId: refs.printMethodId,
            placement: 'chest',
            side: 'FRONT',
            artworkRequired: true,
          })
          .expect(201)
      ).body;
      await alice.api
        .post(`/customer/samples/${s.id}/accessories`, {
          accessoryId: refs.accessoryId,
          quantity: 1,
        })
        .expect(201);
      await alice.api
        .post(`/customer/samples/${s.id}/components`, {
          componentOptionId: refs.componentId,
        })
        .expect(201);

      // artwork is required: not ready until the file is in and the terms are accepted
      let check = (
        await alice.api
          .get(`/customer/samples/${s.id}/submission-check`)
          .expect(200)
      ).body;
      expect(check.problems.join(' ')).toMatch(/artwork/i);
      expect(check.problems.join(' ')).toMatch(/terms/i);

      const art = (
        await alice.api
          .upload(
            s.id,
            { type: 'ARTWORK', decorationId: deco.id },
            PNG,
            'logo.png',
          )
          .expect(201)
      ).body;
      expect(art).toMatchObject({ type: 'ARTWORK', originalName: 'logo.png' });
      expect(JSON.stringify(art)).not.toMatch(/storageKey|storage_key/);

      const terms = (await alice.api.get('/customer/terms/sample').expect(200))
        .body;
      expect(terms.content).toBeTruthy();
      const accepted = (
        await alice.api
          .post(`/customer/samples/${s.id}/terms/accept`, {
            termsVersionId: terms.id,
          })
          .expect(200)
      ).body;
      expect(accepted.termsVersionId).toBe(terms.id);
      await alice.api
        .post(`/customer/samples/${s.id}/terms/accept`, {})
        .expect(409);

      check = (
        await alice.api
          .get(`/customer/samples/${s.id}/submission-check`)
          .expect(200)
      ).body;
      expect(check).toEqual({ ready: true, problems: [] });

      const detail = (
        await alice.api.get(`/customer/samples/${s.id}`).expect(200)
      ).body;
      expect(detail.decorations[0].artwork).toMatchObject({ versionCount: 1 });
      expect(detail.terms).toMatchObject({ required: true, accepted: true });
      expect(detail.pattern.patternVersionId).toBe(pattern.versionId);
      expect(detail.files).toHaveLength(1);

      const submitted = (
        await alice.api.post(`/customer/samples/${s.id}/submit`).expect(200)
      ).body;
      expect(submitted).toMatchObject({
        status: 'SUBMITTED',
        editable: false,
      });
      expect(submitted.nextStep).toMatch(/review/i);

      // locked after submit
      await alice.api
        .patch(`/customer/samples/${s.id}`, { notes: 'too late' })
        .expect(409);
      await alice.api
        .post(`/customer/samples/${s.id}/decorations`, {
          printMethodId: refs.printMethodId,
          placement: 'back',
        })
        .expect(409);
      await alice.api.upload(s.id, { type: 'REFERENCE' }).expect(409);
      await alice.api
        .del(`/customer/samples/${s.id}/files/${art.attachmentId}`)
        .expect(409);
      await alice.api.post(`/customer/samples/${s.id}/submit`).expect(409);
      await alice.api
        .post(`/customer/samples/${s.id}/terms/accept`, {})
        .expect(409);

      // the SAME sample shows up for staff, flagged as portal-created
      const staff = (await a.admin.get(`/admin/samples/${s.id}`).expect(200))
        .body;
      expect(staff).toMatchObject({
        status: 'SUBMITTED',
        createdVia: 'CUSTOMER_PORTAL',
        customer: { id: alice.customerId },
      });
      expect(staff.assignedSales).toBeNull();
      expect(staff.termsAcceptances[0].mode).toBe('CUSTOMER_AUTHENTICATED');
      const adminList = (
        await a.admin
          .get(`/admin/samples?status=SUBMITTED&customerId=${alice.customerId}`)
          .expect(200)
      ).body;
      expect(adminList.data.map((x: { id: string }) => x.id)).toContain(s.id);
      const history = (
        await a.admin.get(`/admin/samples/${s.id}/status-history`).expect(200)
      ).body;
      expect(history.at(-1)).toMatchObject({
        toStatus: 'SUBMITTED',
        source: 'CUSTOMER',
        actorCustomerId: alice.customerId,
        actorUserId: null,
      });
      const audit = await prisma.auditLog.findMany({
        where: { entityId: s.id, actorCustomerId: alice.customerId },
      });
      expect(audit.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'sample.created',
          'sample.submitted',
          'sample.terms_accepted',
          'sample.status_changed',
          'sample.file_uploaded_by_customer',
        ]),
      );
      const partAudit = await prisma.auditLog.findMany({
        where: {
          actorCustomerId: alice.customerId,
          entityType: { in: ['SampleDecoration', 'SampleAccessory'] },
        },
      });
      expect(partAudit.length).toBeGreaterThanOrEqual(2);
      // customer-caused entries never carry a staff actor
      expect(audit.every((r) => r.actorUserId === null)).toBe(true);
      // staff can pick it up (normal review flow keeps working)
      await a.admin.post(`/admin/samples/${s.id}/review`).expect(200);
      const underReview = (
        await alice.api.get(`/customer/samples/${s.id}`).expect(200)
      ).body;
      expect(underReview.status).toBe('UNDER_REVIEW');
    });

    it('shows a customer-safe projection and timeline, never internal data', async () => {
      const s = await draft(alice, {
        customProductName: 'Projection test',
        customFabricName: 'Own cotton',
        customColorName: 'Navy',
        sampleSizeOptionId: refs.sizeId,
      });
      await a.admin
        .patch(`/admin/samples/${s.id}`, {
          factoryInstructions: 'SECRET-FACTORY-INSTRUCTION',
        })
        .expect(200);
      await a.admin
        .post(`/admin/samples/${s.id}/notes`, {
          content: 'SECRET-INTERNAL-NOTE',
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${s.id}/notes`, {
          content: 'Please send a vector logo',
          visibility: 'CUSTOMER_VISIBLE',
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${s.id}/assign-sales`, { userId: a.salesUserId })
        .expect(200);
      await a.admin.post(`/admin/samples/${s.id}/submit`).expect(400); // staff cannot skip the same rules

      const detail = (
        await alice.api.get(`/customer/samples/${s.id}`).expect(200)
      ).body;
      const json = JSON.stringify(detail);
      for (const leak of [
        'SECRET-FACTORY-INSTRUCTION',
        'SECRET-INTERNAL-NOTE',
        'factoryInstructions',
        'assignedSales',
        'paymentState',
        'createdByStaff',
      ])
        expect(json).not.toContain(leak);

      const messages = (
        await alice.api.get(`/customer/samples/${s.id}/messages`).expect(200)
      ).body;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: 'Please send a vector logo',
        from: 'Benue Print team',
      });
      expect(Object.keys(messages[0]).sort()).toEqual([
        'at',
        'content',
        'from',
        'id',
      ]);

      // get it into review, hold it with an internal reason, then ask for changes
      await a.admin
        .post(`/admin/samples/${s.id}/terms-acceptances`, {
          sourceNote: 'Confirmed by WhatsApp (test)',
        })
        .expect(201);
      await a.admin.post(`/admin/samples/${s.id}/submit`).expect(200);
      await a.admin.post(`/admin/samples/${s.id}/review`).expect(200);
      await a.admin
        .post(`/admin/samples/${s.id}/hold`, { reason: 'SECRET-HOLD-REASON' })
        .expect(200);
      const held = (
        await alice.api.get(`/customer/samples/${s.id}`).expect(200)
      ).body;
      expect(held.status).toBe('UNDER_REVIEW');
      await a.admin.post(`/admin/samples/${s.id}/resume`, {}).expect(200);
      await a.admin
        .post(`/admin/samples/${s.id}/request-changes`, {
          reason: 'Please upload a vector logo',
        })
        .expect(200);

      const back = (
        await alice.api.get(`/customer/samples/${s.id}`).expect(200)
      ).body;
      expect(back).toMatchObject({
        status: 'CHANGES_REQUESTED',
        editable: true,
      });
      const activity = (
        await alice.api.get(`/customer/samples/${s.id}/activity`).expect(200)
      ).body;
      expect(activity.map((e: { status: string }) => e.status)).toEqual([
        'DRAFT',
        'SUBMITTED',
        'UNDER_REVIEW',
        'CHANGES_REQUESTED',
      ]);
      expect(JSON.stringify(activity)).not.toContain('SECRET');
      expect(activity.at(-1).message).toBe('Please upload a vector logo');
      const filtered = (
        await alice.api
          .get('/customer/samples?status=CHANGES_REQUESTED')
          .expect(200)
      ).body;
      expect(filtered.data.map((x: { id: string }) => x.id)).toContain(s.id);
      const asDraft = (
        await alice.api.get('/customer/samples?status=DRAFT').expect(200)
      ).body;
      expect(asDraft.data.map((x: { id: string }) => x.id)).not.toContain(s.id);

      // the customer fixes it and resubmits
      await alice.api
        .patch(`/customer/samples/${s.id}`, { notes: 'Vector logo attached' })
        .expect(200);
      const again = (
        await alice.api.post(`/customer/samples/${s.id}/submit`).expect(200)
      ).body;
      expect(again.status).toBe('SUBMITTED');
    });
  });

  // ─────────────────────────────── files ───────────────────────────────

  describe('files', () => {
    it('validates content and type, lets the owner download and delete, and hides staff files', async () => {
      const s = await draft(alice);
      // not an image/pdf, whatever the client claims
      await alice.api
        .upload(s.id, { type: 'REFERENCE' }, Buffer.from('plain text'), 'x.png')
        .expect(415);
      // internal asset types are not available to customers
      await alice.api.upload(s.id, { type: 'PAYMENT_PROOF' }).expect(400);
      await alice.api.upload(s.id, { type: 'TECH_PACK' }).expect(400);
      // decorationId only makes sense for artwork
      await alice.api
        .upload(s.id, {
          type: 'REFERENCE',
          decorationId: '00000000-0000-4000-8000-000000000000',
        })
        .expect(400);

      const file = (
        await alice.api
          .upload(s.id, { type: 'SIZE_CHART', description: 'my sizes' })
          .expect(201)
      ).body;
      expect(file.description).toBe('my sizes');
      const listed = (
        await alice.api.get(`/customer/samples/${s.id}/files`).expect(200)
      ).body;
      expect(
        listed.map((f: { attachmentId: string }) => f.attachmentId),
      ).toEqual([file.attachmentId]);

      const dl = (
        await alice.api
          .get(
            `/customer/samples/${s.id}/files/${file.attachmentId}/download-url`,
          )
          .expect(200)
      ).body;
      const bytes = await http().get(dl.url).expect(200);
      expect(Buffer.from(bytes.body).equals(PNG)).toBe(true);

      // a file staff attached is not the customer's to see or download
      const staffAsset = (
        await a.admin.upload('REFERENCE', 'staff.png').expect(201)
      ).body;
      const attached = (
        await a.admin
          .post(`/admin/assets/${staffAsset.id}/attachments`, {
            targetType: 'SAMPLE',
            targetId: s.id,
          })
          .expect(201)
      ).body;
      const afterStaff = (
        await alice.api.get(`/customer/samples/${s.id}/files`).expect(200)
      ).body;
      expect(afterStaff).toHaveLength(1);
      await alice.api
        .get(`/customer/samples/${s.id}/files/${attached.id}/download-url`)
        .expect(404);
      await alice.api
        .del(`/customer/samples/${s.id}/files/${attached.id}`)
        .expect(404);

      // owner removes theirs (draft): gone from list and download
      await alice.api
        .del(`/customer/samples/${s.id}/files/${file.attachmentId}`)
        .expect(204);
      await alice.api
        .get(
          `/customer/samples/${s.id}/files/${file.attachmentId}/download-url`,
        )
        .expect(404);
      expect(
        (await alice.api.get(`/customer/samples/${s.id}/files`).expect(200))
          .body,
      ).toHaveLength(0);
    });

    it('adds artwork versions to the same placement and unlinks it when the last file goes', async () => {
      const s = await draft(alice);
      const deco = (
        await alice.api
          .post(`/customer/samples/${s.id}/decorations`, {
            printMethodId: refs.printMethodId,
            placement: 'back',
            side: 'BACK',
            artworkRequired: true,
          })
          .expect(201)
      ).body;
      const v1 = (
        await alice.api
          .upload(s.id, { type: 'ARTWORK', decorationId: deco.id })
          .expect(201)
      ).body;
      const v2 = (
        await alice.api
          .upload(s.id, { type: 'ARTWORK', decorationId: deco.id })
          .expect(201)
      ).body;
      let detail = (
        await alice.api.get(`/customer/samples/${s.id}`).expect(200)
      ).body;
      expect(detail.decorations[0].artwork.versionCount).toBe(2);
      await alice.api
        .del(`/customer/samples/${s.id}/files/${v1.attachmentId}`)
        .expect(204);
      await alice.api
        .del(`/customer/samples/${s.id}/files/${v2.attachmentId}`)
        .expect(204);
      detail = (await alice.api.get(`/customer/samples/${s.id}`).expect(200))
        .body;
      expect(detail.decorations[0].artwork).toBeNull();
    });
  });

  // ──────────────────────────── configurator ────────────────────────────

  describe('configurator projection', () => {
    it('serves the catalogue with friendly patterns and no internals', async () => {
      const pattern = await approvedPatternVersion(a.admin, refs.productTypeId);
      const opts = (
        await alice.api.get('/customer/configurator/sample-options').expect(200)
      ).body;
      for (const key of [
        'productTypes',
        'fabrics',
        'sizeScales',
        'patterns',
        'printMethods',
        'accessories',
        'components',
        'fitMethods',
        'fabricProviders',
        'decorationSides',
        'measurementUnits',
        'terms',
      ])
        expect(opts).toHaveProperty(key);
      const p = opts.patterns.find(
        (x: { patternVersionId: string }) =>
          x.patternVersionId === pattern.versionId,
      );
      expect(p).toBeDefined();
      expect(Object.keys(p).sort()).toEqual([
        'fitType',
        'name',
        'patternVersionId',
        'productTypeId',
      ]);
      const json = JSON.stringify(opts);
      expect(json).not.toMatch(
        /PAT-\d|referenceNumber|storage|price|cost|margin/i,
      );
      expect(opts.productTypes.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────── profile, brands, addresses ───────────────────────

  describe('profile, brands and addresses', () => {
    it('shows and edits only contact fields', async () => {
      const p = (await alice.api.get('/customer/profile').expect(200)).body;
      expect(p).toMatchObject({
        id: alice.customerId,
        email: alice.email,
      });
      expect(JSON.stringify(p)).not.toMatch(/notes|source|status|archived/);
      const upd = (
        await alice.api
          .patch('/customer/profile', {
            phone: '+20 100 555 1234',
            city: 'Cairo',
            preferredLocale: 'ar',
          })
          .expect(200)
      ).body;
      expect(upd).toMatchObject({
        phone: '+201005551234',
        city: 'Cairo',
        preferredLocale: 'ar',
      });
      await alice.api
        .patch('/customer/profile', { name: 'Someone Else' })
        .expect(400);
      await alice.api
        .patch('/customer/profile', { email: 'x@y.z' })
        .expect(400);
      await alice.api
        .patch('/customer/profile', { preferredLocale: 'xx' })
        .expect(400);
      const fresh = await prisma.customer.findUniqueOrThrow({
        where: { id: alice.customerId },
      });
      expect(fresh.displayName).not.toBe('Someone Else');
    });

    it('lists only my own brands and 404s on someone else’s', async () => {
      const mine = (await alice.api.get('/customer/brands').expect(200)).body;
      expect(mine.map((b: { id: string }) => b.id)).toEqual([alice.brandId]);
      await alice.api.get(`/customer/brands/${alice.brandId}`).expect(200);
      await alice.api.get(`/customer/brands/${bob.brandId}`).expect(404);
      // archived brands disappear
      const extra = (
        await a.admin
          .post(`/admin/customers/${alice.customerId}/brands`, {
            name: `Gone ${uniq('b')}`,
          })
          .expect(201)
      ).body;
      await a.admin.del(`/admin/brands/${extra.id}`).expect(204);
      const after = (await alice.api.get('/customer/brands').expect(200)).body;
      expect(after.map((b: { id: string }) => b.id)).not.toContain(extra.id);
    });

    it('manages my addresses without touching anyone else’s', async () => {
      const created = (
        await alice.api
          .post('/customer/addresses', {
            country: 'Egypt',
            city: 'Cairo',
            addressLine1: '1 Test Street',
            isDefault: true,
          })
          .expect(201)
      ).body;
      const bobsAddr = (
        await bob.api
          .post('/customer/addresses', {
            country: 'Egypt',
            city: 'Giza',
            addressLine1: '2 Other Street',
          })
          .expect(201)
      ).body;
      await alice.api
        .patch(`/customer/addresses/${created.id}`, { city: 'Alexandria' })
        .expect(200);
      await alice.api
        .patch(`/customer/addresses/${bobsAddr.id}`, { city: 'Hijacked' })
        .expect(404);
      const mine = (await alice.api.get('/customer/addresses').expect(200))
        .body;
      expect(mine.map((x: { id: string }) => x.id)).toEqual([created.id]);
      expect(mine[0].city).toBe('Alexandria');
      const bobs = await prisma.customerAddress.findUniqueOrThrow({
        where: { id: bobsAddr.id },
      });
      expect(bobs.city).toBe('Giza');
    });
  });

  // ─────────────────────────────── admin ───────────────────────────────

  describe('staff provisioning', () => {
    it('needs customers.manage and refuses blocked or unknown customers', async () => {
      const { customer } = await createCustomerWithBrand(a.admin);
      await a.sewing
        .post(`/admin/customers/${customer.id}/portal-account`, {
          email: `${uniq('s')}@test.benue.local`,
        })
        .expect(403);
      await a.admin
        .post(
          `/admin/customers/00000000-0000-4000-8000-000000000000/portal-account`,
          {
            email: `${uniq('s')}@test.benue.local`,
          },
        )
        .expect(404);
      await a.admin
        .patch(`/admin/customers/${customer.id}/status`, {
          status: 'BLOCKED',
        })
        .expect(200);
      await a.admin
        .post(`/admin/customers/${customer.id}/portal-account`, {
          email: `${uniq('s')}@test.benue.local`,
        })
        .expect(409);
    });

    it('re-invites an unactivated account with a fresh single-use token', async () => {
      const { customer } = await createCustomerWithBrand(a.admin);
      const email = `${uniq('r')}@test.benue.local`;
      const first = (
        await a.admin
          .post(`/admin/customers/${customer.id}/portal-account`, { email })
          .expect(201)
      ).body;
      const second = (
        await a.admin
          .post(`/admin/customers/${customer.id}/portal-account/reinvite`)
          .expect(200)
      ).body;
      expect(second.inviteToken).not.toBe(first.inviteToken);
      await http()
        .post('/api/v1/customer/auth/activate')
        .send({ token: first.inviteToken, password: CUSTOMER_PASSWORD })
        .expect(400);
      await http()
        .post('/api/v1/customer/auth/activate')
        .send({ token: second.inviteToken, password: CUSTOMER_PASSWORD })
        .expect(204);
      await a.admin
        .post(`/admin/customers/${customer.id}/portal-account/reinvite`)
        .expect(409);
    });
  });
});
