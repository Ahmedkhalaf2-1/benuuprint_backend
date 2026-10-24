import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/database/prisma.service.js';
import type { AppConfig } from '../src/config/app.config.js';
import { ManagementContext } from '../src/modules/management/management-context.service.js';
import { OutboxService } from '../src/modules/notifications/outbox.service.js';
import {
  auditActions,
  createTestApp,
  createUserAndLogin,
} from './support/app.js';
import { drain, providers } from './support/automation.js';
import {
  api,
  lookupRefs,
  makeActors,
  type Actors,
  type Api,
  type Refs,
} from './support/factory.js';
import { makeFloor, type Floor } from './support/floor.js';
import {
  approvedReferenceSample,
  createOrder,
  readyOrder,
  runBulkStage,
  standardItems,
  type ApprovedSample,
} from './support/orders.js';

describe('Outbox, notifications, templates and preferences (Phase 6B, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ctx: ManagementContext;
  let a: Actors;
  let refs: Refs;
  let floor: Floor;
  let s: ApprovedSample;
  let n: AppConfig['notifications'];
  let admin: { api: Api; id: string; email: string };
  let admin2: { api: Api; id: string };
  const orig = {} as Record<string, unknown>;
  const { email: emailOf, whatsapp: waOf } = {
    email: () => providers(app).email,
    whatsapp: () => providers(app).whatsapp,
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ctx = app.get(ManagementContext);
    a = await makeActors(app);
    refs = await lookupRefs(app);
    floor = await makeFloor(app);
    s = await approvedReferenceSample(app, a, refs, floor);
    n = app.get(ConfigService).getOrThrow<AppConfig>('app').notifications;
    Object.assign(orig, {
      maxAttempts: n.maxAttempts,
      outboxMaxAttempts: n.outboxMaxAttempts,
      quiet: { ...n.quietHours },
    });
    const u = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
    admin = {
      api: api(app, u.accessToken),
      id: u.user.id,
      email: u.user.email,
    };
    const u2 = await createUserAndLogin(app, { roleCodes: ['ADMIN'] });
    admin2 = { api: api(app, u2.accessToken), id: u2.user.id };
    // customer destinations for the customer-facing messages
    await prisma.customer.update({
      where: { id: s.customerId },
      data: { email: 'customer@example.com', whatsapp: '+201001112233' },
    });
    await drain(app); // start from an empty queue
  });
  beforeEach(() => {
    emailOf().reset();
    waOf().reset();
  });
  afterEach(() => {
    ctx.freeze(null);
    n.maxAttempts = orig.maxAttempts as number;
    n.outboxMaxAttempts = orig.outboxMaxAttempts as number;
    Object.assign(n.quietHours, orig.quiet);
    emailOf().reset();
    waOf().reset();
  });
  afterAll(() => app.close());

  // ───────────────────────── helpers ─────────────────────────
  const confirmedOrder = async (extra: Record<string, unknown> = {}) => {
    const o = await createOrder(a.sales, s.sampleId, {
      items: standardItems(s),
      assignedSalesUserId: a.salesUserId,
      targetDeliveryDate: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      ...extra,
    });
    await a.sales.post(`/admin/orders/${o.id}/confirm`).expect(200);
    return o;
  };
  const inbox = async (who: Api, q = '') =>
    (await who.get(`/staff/notifications?pageSize=100${q}`).expect(200)).body;
  const forEntity = async (id: string, extra: Record<string, unknown> = {}) =>
    prisma.notification.findMany({
      where: { entityId: id, ...extra },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const deactivateRule = (code: string) =>
    prisma.automationRule.update({ where: { code }, data: { active: false } });

  // ───────────────────────── outbox ─────────────────────────
  describe('transactional outbox', () => {
    it('writes the event in the same transaction as the business change and sends nothing yet', async () => {
      const o = await confirmedOrder();
      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: o.id, eventType: 'ORDER_CONFIRMED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateType: 'Order',
        status: 'PENDING',
        attempts: 0,
        processedAt: null,
      });
      expect(events[0]!.payload).toEqual({ orderId: o.id });
      expect(events[0]!.deduplicationKey).toMatch(/^ORDER_CONFIRMED:/);
      expect(await forEntity(o.id)).toHaveLength(0); // planning happens later, off the request path
      expect(emailOf().sent).toHaveLength(0);
    });

    it('a rolled-back transaction leaves no event behind', async () => {
      const outbox = app.get(OutboxService);
      const id = '11111111-1111-4111-8111-111111111111';
      await expect(
        prisma.$transaction(async (tx) => {
          await outbox.emit(tx, {
            eventType: 'ORDER_CONFIRMED',
            aggregateType: 'Order',
            aggregateId: id,
            payload: { orderId: id },
          });
          throw new Error('business step failed after the event was written');
        }),
      ).rejects.toThrow();
      expect(
        await prisma.outboxEvent.count({ where: { aggregateId: id } }),
      ).toBe(0);
    });

    it('refuses payloads that look like secrets', async () => {
      const outbox = app.get(OutboxService);
      await expect(
        prisma.$transaction((tx) =>
          outbox.emit(tx, {
            eventType: 'ORDER_CONFIRMED',
            aggregateType: 'Order',
            aggregateId: 'x',
            payload: { accessToken: 'abc' },
          }),
        ),
      ).rejects.toThrow(/must not be persisted/);
    });

    it('processing turns the event into notifications for the right recipients only', async () => {
      const o = await confirmedOrder();
      await drain(app);
      const ev = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: o.id, eventType: 'ORDER_CONFIRMED' },
      });
      expect(ev).toMatchObject({ status: 'PROCESSED', lastError: null });
      expect(ev.processedAt).toBeTruthy();
      const list = await forEntity(o.id);
      // admins (in-app) and the customer (email + WhatsApp); nobody else
      expect(
        list
          .filter((x) => x.recipientKind === 'STAFF')
          .every((x) => x.channel === 'IN_APP'),
      ).toBe(true);
      const staffIds = new Set(
        list
          .filter((x) => x.recipientKind === 'STAFF')
          .map((x) => x.recipientUserId),
      );
      expect(staffIds.has(admin.id)).toBe(true);
      expect(staffIds.has(admin2.id)).toBe(true);
      expect(staffIds.has(a.salesUserId)).toBe(false);
      expect(staffIds.has(floor.sewing.id)).toBe(false);
      const customer = list.filter((x) => x.recipientKind === 'CUSTOMER');
      expect(customer.map((x) => x.channel).sort()).toEqual([
        'EMAIL',
        'WHATSAPP',
      ]);
      expect(
        customer.every(
          (x) => x.customerId === s.customerId && x.status === 'SENT',
        ),
      ).toBe(true);
    });
  });

  // ───────────────────────── in-app ─────────────────────────
  describe('in-app notifications', () => {
    it('are private: you see, read and count only your own', async () => {
      const o = await confirmedOrder();
      await drain(app);
      const mine = (await inbox(admin.api, '&type=ORDER_CONFIRMED')).data.find(
        (x: { entityId: string }) => x.entityId === o.id,
      );
      expect(mine).toMatchObject({
        type: 'ORDER_CONFIRMED',
        severity: 'INFO',
        read: false,
        entityType: 'Order',
      });
      expect(mine.title).toContain(o.orderNumber);
      expect(mine.body).toContain(o.orderNumber);
      expect(Object.keys(mine).sort()).toEqual([
        'body',
        'createdAt',
        'entityId',
        'entityType',
        'id',
        'read',
        'readAt',
        'severity',
        'title',
        'type',
      ]);
      // others do not see it
      expect(
        (await inbox(a.sales)).data.some(
          (x: { id: string }) => x.id === mine.id,
        ),
      ).toBe(false);
      expect(
        (await inbox(floor.sewing.api)).data.some(
          (x: { id: string }) => x.id === mine.id,
        ),
      ).toBe(false);
      // and cannot read it (404, the same as an unknown id)
      await a.sales.post(`/staff/notifications/${mine.id}/read`).expect(404);
      await a.sales
        .post('/staff/notifications/5c7e1b88-0000-4000-8000-000000000000/read')
        .expect(404);
      await api(app, 'bad').get('/staff/notifications').expect(401);
      // the owner can
      const before = (
        await admin.api.get('/staff/notifications/unread-count').expect(200)
      ).body.unreadCount;
      expect(
        (
          await admin.api
            .post(`/staff/notifications/${mine.id}/read`)
            .expect(200)
        ).body,
      ).toMatchObject({ read: true });
      expect(
        (await admin.api.get('/staff/notifications/unread-count').expect(200))
          .body.unreadCount,
      ).toBe(before - 1);
      await admin.api.post(`/staff/notifications/${mine.id}/read`).expect(200); // idempotent
    });

    it('filters by unread, severity and type; read-all clears the unread count', async () => {
      const o = await confirmedOrder();
      await drain(app);
      const unread = await inbox(admin2.api, '&unread=true');
      expect(unread.data.length).toBeGreaterThan(0);
      expect(unread.data.every((x: { read: boolean }) => !x.read)).toBe(true);
      expect((await inbox(admin2.api, '&type=NOPE')).data).toHaveLength(0);
      expect(
        (await inbox(admin2.api, '&severity=CRITICAL')).data.every(
          (x: { severity: string }) => x.severity === 'CRITICAL',
        ),
      ).toBe(true);
      const sizes = (
        await admin2.api
          .get('/staff/notifications?pageSize=1&page=1')
          .expect(200)
      ).body;
      expect(sizes.data).toHaveLength(1);
      expect(sizes.meta.total).toBeGreaterThan(1);
      const r = (
        await admin2.api.post('/staff/notifications/read-all').expect(200)
      ).body;
      expect(r.marked).toBeGreaterThan(0);
      expect(
        (await admin2.api.get('/staff/notifications/unread-count').expect(200))
          .body.unreadCount,
      ).toBe(0);
      expect((await inbox(admin2.api, '&unread=true')).data).toHaveLength(0);
      expect(o.id).toBeTruthy();
      await a.sales.get('/staff/notifications?severity=LOUD').expect(400);
    });
  });

  // ───────────────────────── providers and customers ─────────────────────────
  describe('email and WhatsApp providers', () => {
    it('deliver customer messages through the ports with a snapshot of the destination', async () => {
      const o = await confirmedOrder();
      await drain(app);
      const mail = emailOf().sent.find((m) => m.metadata?.entityId === o.id)!;
      expect(mail).toMatchObject({
        to: 'customer@example.com',
        subject: `Order ${o.orderNumber} confirmed`,
      });
      expect(mail.text).toContain(o.orderNumber);
      expect(mail.html).toContain('<p>');
      expect(mail.idempotencyKey).toBeTruthy();
      expect(mail.metadata).toMatchObject({ type: 'ORDER_CONFIRMED' });
      const wa = waOf().sent.find((m) => m.metadata?.entityId === o.id)!;
      expect(wa).toMatchObject({
        to: '+201001112233',
        templateName: 'order_confirmed_en',
        locale: 'en',
      });
      expect(wa.fallbackText).toContain(o.orderNumber);
      expect(wa.variables.length).toBeGreaterThan(0);
      const rows = await forEntity(o.id, { recipientKind: 'CUSTOMER' });
      expect(rows.find((x) => x.channel === 'EMAIL')).toMatchObject({
        recipientAddress: 'customer@example.com',
        status: 'SENT',
        attempts: 1,
      });
      expect(
        rows.find((x) => x.channel === 'WHATSAPP')!.providerMessageId,
      ).toMatch(/^log-whatsapp-/);
      // later edits of the customer's address never rewrite history
      await prisma.customer.update({
        where: { id: s.customerId },
        data: { email: 'new@example.com' },
      });
      expect(
        (await forEntity(o.id, { channel: 'EMAIL' }))[0]!.recipientAddress,
      ).toBe('customer@example.com');
      await prisma.customer.update({
        where: { id: s.customerId },
        data: { email: 'customer@example.com' },
      });
    });

    it("prefers the primary contact's details over the customer's own and falls back when a detail is missing", async () => {
      const contact = await prisma.customerContact.create({
        data: {
          customerId: s.customerId,
          name: 'Sara',
          role: 'OWNER',
          email: 'sara@example.com',
          phone: '+201112223344',
          isPrimary: true,
        },
      });
      try {
        const o = await confirmedOrder();
        await drain(app);
        const mail = (await forEntity(o.id, { channel: 'EMAIL' }))[0]!;
        const wa = (await forEntity(o.id, { channel: 'WHATSAPP' }))[0]!;
        expect(mail).toMatchObject({
          recipientAddress: 'sara@example.com',
          customerContactId: contact.id,
        });
        expect(wa).toMatchObject({
          recipientAddress: '+201112223344',
          customerContactId: contact.id,
        }); // the contact has no WhatsApp number: its phone is used
        expect(emailOf().sent.some((m) => m.to === 'sara@example.com')).toBe(
          true,
        );
      } finally {
        await prisma.customerContact.update({
          where: { id: contact.id },
          data: { archivedAt: new Date() },
        });
      }
      // a customer without any destination simply gets nothing (the staff still do)
      await prisma.customer.update({
        where: { id: s.customerId },
        data: { email: null, whatsapp: null, phone: null },
      });
      try {
        const o = await confirmedOrder();
        await drain(app);
        expect(
          await forEntity(o.id, { recipientKind: 'CUSTOMER' }),
        ).toHaveLength(0);
        expect(
          (await forEntity(o.id, { channel: 'IN_APP' })).length,
        ).toBeGreaterThan(0);
      } finally {
        await prisma.customer.update({
          where: { id: s.customerId },
          data: { email: 'customer@example.com', whatsapp: '+201001112233' },
        });
      }
    });

    it('a failing provider never touches the business transaction', async () => {
      emailOf().simulate({ permanent: true });
      waOf().simulate({ permanent: true });
      const o = await confirmedOrder(); // the API call succeeded although both channels are down
      await drain(app);
      expect(
        (await a.admin.get(`/admin/orders/${o.id}`).expect(200)).body.status,
      ).toBe('CONFIRMED');
      const rows = await forEntity(o.id, { recipientKind: 'CUSTOMER' });
      expect(rows.every((r) => r.status === 'FAILED')).toBe(true);
      expect(
        rows.every((r) =>
          /Simulated permanent failure/.test(r.failureReason ?? ''),
        ),
      ).toBe(true);
      expect(
        (await forEntity(o.id, { channel: 'IN_APP' })).length,
      ).toBeGreaterThan(0); // in-app is independent
      expect(
        await prisma.outboxEvent.count({
          where: { aggregateId: o.id, status: 'PROCESSED' },
        }),
      ).toBeGreaterThan(0);
    });
  });

  // ───────────────────────── retry and idempotency ─────────────────────────
  describe('retry, idempotency and crash recovery', () => {
    const customerMail = async (o: { id: string }) =>
      (await forEntity(o.id, { channel: 'EMAIL' }))[0]!;

    it('retries a transient failure with bounded exponential backoff, then delivers once', async () => {
      const t0 = new Date('2031-04-01T08:00:00Z');
      ctx.freeze(t0);
      emailOf().simulate({ transient: 2 });
      const o = await confirmedOrder();
      await drain(app, 1);
      let row = await customerMail(o);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(row.failureReason).toMatch(/Simulated transient/);
      expect(row.nextAttemptAt!.getTime()).toBe(t0.getTime() + 60_000); // base 60 s
      await drain(app, 1); // not due yet: nothing happens
      expect((await customerMail(o)).attempts).toBe(1);
      ctx.freeze(new Date(t0.getTime() + 61_000));
      await drain(app, 1);
      row = await customerMail(o);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 2 });
      expect(row.nextAttemptAt!.getTime()).toBe(
        t0.getTime() + 61_000 + 120_000,
      ); // doubled
      ctx.freeze(new Date(t0.getTime() + 61_000 + 121_000));
      await drain(app, 1);
      row = await customerMail(o);
      expect(row).toMatchObject({
        status: 'SENT',
        attempts: 3,
        failureReason: null,
      });
      expect(
        emailOf().sent.filter((m) => m.metadata?.entityId === o.id),
      ).toHaveLength(1);
    });

    it('gives up after the maximum number of attempts and records why', async () => {
      n.maxAttempts = 2;
      const t0 = new Date('2031-04-02T08:00:00Z');
      ctx.freeze(t0);
      emailOf().simulate({ transient: 99 });
      const o = await confirmedOrder();
      await drain(app, 1);
      ctx.freeze(new Date(t0.getTime() + 3_600_000));
      await drain(app, 1);
      const row = await customerMail(o);
      expect(row).toMatchObject({ status: 'FAILED', attempts: 2 });
      expect(row.failureReason).toMatch(/gave up after 2 attempts/);
      expect(row.failedAt).toBeTruthy();
    });

    it('a permanent failure fails at once; an admin can retry it, audited', async () => {
      emailOf().simulate({ permanent: true });
      const o = await confirmedOrder();
      await drain(app);
      const row = await customerMail(o);
      expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
      await a.sales.post(`/admin/notifications/${row.id}/retry`).expect(403);
      emailOf().reset();
      const re = (
        await admin.api.post(`/admin/notifications/${row.id}/retry`).expect(200)
      ).body;
      expect(re).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        failureReason: null,
      });
      await admin.api.post(`/admin/notifications/${row.id}/retry`).expect(409); // only FAILED ones
      await drain(app);
      expect(await customerMail(o)).toMatchObject({ status: 'SENT' });
      expect(await auditActions(app, row.id)).toContain('notification.retried');
      // cancel
      const o2 = await confirmedOrder();
      ctx.freeze(new Date('2031-04-03T20:00:00Z')); // not important: quiet hours are off in this suite
      emailOf().simulate({ permanent: true });
      await drain(app);
      const failed = await customerMail(o2);
      await admin.api
        .post(`/admin/notifications/${failed.id}/cancel`)
        .expect(200);
      expect((await customerMail(o2)).status).toBe('CANCELLED');
      await admin.api
        .post(`/admin/notifications/${failed.id}/cancel`)
        .expect(409);
      expect(await auditActions(app, failed.id)).toContain(
        'notification.cancelled',
      );
    });

    it('processing the same event twice creates no duplicate notifications', async () => {
      const o = await confirmedOrder();
      await drain(app);
      const before = await forEntity(o.id);
      const ev = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: o.id, eventType: 'ORDER_CONFIRMED' },
      });
      // e.g. a worker crashed after planning but before marking the event processed
      await prisma.outboxEvent.update({
        where: { id: ev.id },
        data: {
          status: 'PENDING',
          processedAt: null,
          nextAttemptAt: new Date(0),
        },
      });
      await drain(app);
      const after = await forEntity(o.id);
      expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id));
      expect(new Set(after.map((x) => x.deduplicationKey)).size).toBe(
        after.length,
      );
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ev.id } }))
          .status,
      ).toBe('PROCESSED');
    });

    it('reclaims an event whose worker died, and never sends a delivered message twice', async () => {
      const o = await confirmedOrder();
      const ev = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: o.id, eventType: 'ORDER_CONFIRMED' },
      });
      // worker claimed it and died: PROCESSING with an expired lease
      await prisma.outboxEvent.update({
        where: { id: ev.id },
        data: {
          status: 'PROCESSING',
          lockedAt: new Date(Date.now() - 3_600_000),
          attempts: 1,
        },
      });
      await drain(app);
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ev.id } }))
          .status,
      ).toBe('PROCESSED');
      const mail = await customerMail(o);
      expect(mail.status).toBe('SENT');
      const sent = emailOf().sent.filter(
        (m) => m.metadata?.entityId === o.id,
      ).length;
      // the provider accepted the message but the row never got updated (crash): the retry must not re-send
      await prisma.notification.update({
        where: { id: mail.id },
        data: {
          status: 'PROCESSING',
          lockedAt: new Date(Date.now() - 3_600_000),
          providerMessageId: null,
          sentAt: null,
        },
      });
      await drain(app);
      const again = await customerMail(o);
      expect(again).toMatchObject({
        status: 'SENT',
        providerMessageId: mail.providerMessageId,
      });
      expect(
        emailOf().sent.filter((m) => m.metadata?.entityId === o.id),
      ).toHaveLength(sent);
    });

    it('a permanently failing event is retried a bounded number of times, then FAILED', async () => {
      n.outboxMaxAttempts = 2;
      const t0 = new Date('2031-05-01T08:00:00Z');
      ctx.freeze(t0);
      const ev = await prisma.outboxEvent.create({
        data: {
          eventType: 'NOT_A_REAL_EVENT',
          aggregateType: 'Order',
          aggregateId: '22222222-2222-4222-8222-222222222222',
          payload: {},
          deduplicationKey: `T:${Date.now()}`,
          nextAttemptAt: t0,
        },
      });
      await drain(app, 1);
      let row = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: ev.id },
      });
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(row.lastError).toMatch(/Unsupported event type/);
      expect(row.nextAttemptAt.getTime()).toBe(t0.getTime() + 60_000);
      ctx.freeze(new Date(t0.getTime() + 3_600_000));
      await drain(app, 1);
      row = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: ev.id },
      });
      expect(row).toMatchObject({ status: 'FAILED', attempts: 2 });
      ctx.freeze(new Date(t0.getTime() + 7_200_000));
      await drain(app, 1);
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ev.id } }))
          .attempts,
      ).toBe(2); // FAILED events are not retried
      await prisma.outboxEvent.delete({ where: { id: ev.id } });
    });
  });

  // ───────────────────────── templates and locales ─────────────────────────
  describe('templates, versions and locales', () => {
    it('renders Arabic for a customer who prefers it and English otherwise', async () => {
      await a.admin
        .put(`/admin/customers/${s.customerId}/notification-preferences`, {
          preferredLocale: 'ar',
        })
        .expect(200);
      try {
        const o = await confirmedOrder();
        await drain(app);
        const wa = (await forEntity(o.id, { channel: 'WHATSAPP' }))[0]!;
        expect(wa).toMatchObject({
          locale: 'ar',
          templateCode: 'ORDER_CONFIRMED',
          templateVersion: 1,
        });
        expect(wa.body).toMatch(/[؀-ۿ]/);
        expect(wa.body).toContain(o.orderNumber);
        expect(
          waOf().sent.find((m) => m.metadata?.entityId === o.id),
        ).toMatchObject({ templateName: 'order_confirmed_ar', locale: 'ar' });
        const mail = (await forEntity(o.id, { channel: 'EMAIL' }))[0]!;
        expect(mail.title).toMatch(/[؀-ۿ]/);
      } finally {
        await prisma.customer.update({
          where: { id: s.customerId },
          data: { preferredLocale: null },
        });
      }
      const o2 = await confirmedOrder();
      await drain(app);
      expect((await forEntity(o2.id, { channel: 'WHATSAPP' }))[0]!.locale).toBe(
        'en',
      );
    });

    it('a staff member can choose their language', async () => {
      await admin2.api
        .put('/staff/notification-preferences', { locale: 'fr' })
        .expect(400); // no templates in that language
      const p = (
        await admin2.api
          .put('/staff/notification-preferences', { locale: 'ar' })
          .expect(200)
      ).body;
      expect(p.locale).toBe('ar');
      try {
        const o = await confirmedOrder();
        await drain(app);
        const mine = (
          await forEntity(o.id, {
            recipientUserId: admin2.id,
            channel: 'IN_APP',
          })
        )[0]!;
        expect(mine.locale).toBe('ar');
        expect(mine.title).toMatch(/[؀-ۿ]/);
        const other = (
          await forEntity(o.id, {
            recipientUserId: admin.id,
            channel: 'IN_APP',
          })
        )[0]!;
        expect(other.locale).toBe('en');
      } finally {
        await prisma.user.update({
          where: { id: admin2.id },
          data: { notificationLocale: null },
        });
      }
    });

    it('a new template version applies to new notifications and old ones keep their text', async () => {
      const o1 = await confirmedOrder();
      await drain(app);
      const old = (
        await forEntity(o1.id, { recipientUserId: admin.id, channel: 'IN_APP' })
      )[0]!;
      const v1 = await prisma.notificationTemplate.findFirstOrThrow({
        where: {
          code: 'ORDER_CONFIRMED_STAFF',
          channel: 'IN_APP',
          locale: 'en',
          active: true,
        },
      });
      const v2 = (
        await admin.api
          .post('/admin/notification-templates', {
            code: 'ORDER_CONFIRMED_STAFF',
            channel: 'IN_APP',
            locale: 'en',
            subject: 'NEW: {{orderNumber}} is confirmed',
            bodyTemplate: 'Confirmed for {{brandName}}.',
          })
          .expect(201)
      ).body;
      try {
        expect(v2).toMatchObject({ version: v1.version + 1, active: true });
        expect(
          (
            await prisma.notificationTemplate.findUniqueOrThrow({
              where: { id: v1.id },
            })
          ).active,
        ).toBe(false);
        const o2 = await confirmedOrder();
        await drain(app);
        const fresh = (
          await forEntity(o2.id, {
            recipientUserId: admin.id,
            channel: 'IN_APP',
          })
        )[0]!;
        expect(fresh).toMatchObject({
          templateVersion: v2.version,
          title: `NEW: ${o2.orderNumber} is confirmed`,
        });
        expect(
          (
            await prisma.notification.findUniqueOrThrow({
              where: { id: old.id },
            })
          ).title,
        ).toBe(old.title); // history untouched
        expect(old.templateVersion).toBe(v1.version);
        expect(await auditActions(app, v2.id)).toContain(
          'notification_template.published',
        );
      } finally {
        await admin.api
          .post(`/admin/notification-templates/${v1.id}/activate`)
          .expect(200); // rollback
      }
      expect(
        (
          await prisma.notificationTemplate.findUniqueOrThrow({
            where: { id: v2.id },
          })
        ).active,
      ).toBe(false);
      await admin.api
        .post(`/admin/notification-templates/${v1.id}/activate`)
        .expect(409);
      expect(await auditActions(app, v1.id)).toContain(
        'notification_template.activated',
      );
    });

    it('rejects unsafe or unknown templates and protects published versions', async () => {
      const base = {
        code: 'ORDER_CONFIRMED_STAFF',
        channel: 'IN_APP',
        locale: 'en',
        subject: 'x',
      };
      for (const bodyTemplate of [
        'Hi {{password}}',
        'Hi {{ 1+1 }}',
        'Hi ${x}',
        '<script>alert(1)</script>',
        'Hi {{constructor.name}}',
        'Hi {% x %}',
      ])
        await admin.api
          .post('/admin/notification-templates', { ...base, bodyTemplate })
          .expect(400);
      await admin.api
        .post('/admin/notification-templates', {
          ...base,
          subject: 'Hi {{nope}}',
          bodyTemplate: 'ok',
        })
        .expect(400);
      await admin.api
        .post('/admin/notification-templates', {
          ...base,
          subject: undefined,
          bodyTemplate: 'ok',
        })
        .expect(400);
      await admin.api
        .post('/admin/notification-templates', {
          ...base,
          code: 'MADE_UP_CODE',
          bodyTemplate: 'ok',
        })
        .expect(400);
      await admin.api
        .post('/admin/notification-templates', {
          ...base,
          locale: 'english',
          bodyTemplate: 'ok',
        })
        .expect(400);
      await a.sales
        .post('/admin/notification-templates', { ...base, bodyTemplate: 'ok' })
        .expect(403);
      const vars = (
        await admin.api
          .get('/admin/notification-templates/variables')
          .expect(200)
      ).body;
      expect(vars.variables).toEqual(
        expect.arrayContaining(['customerName', 'orderNumber', 'trackingLink']),
      );
      const t = await prisma.notificationTemplate.findFirstOrThrow({
        where: { code: 'ORDER_CONFIRMED_STAFF', active: true },
      });
      await expect(
        prisma.notificationTemplate.update({
          where: { id: t.id },
          data: { bodyTemplate: 'tampered' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.notificationTemplate.delete({ where: { id: t.id } }),
      ).rejects.toThrow();
      expect(
        (
          await admin.api
            .get(
              '/admin/notification-templates?code=ORDER_CONFIRMED_STAFF&activeOnly=true',
            )
            .expect(200)
        ).body.length,
      ).toBeGreaterThan(0);
    });

    it('a deactivated template skips its messages instead of failing the event', async () => {
      const t = await prisma.notificationTemplate.findFirstOrThrow({
        where: {
          code: 'ORDER_CONFIRMED',
          channel: 'WHATSAPP',
          locale: 'en',
          active: true,
        },
      });
      await admin.api
        .post(`/admin/notification-templates/${t.id}/deactivate`)
        .expect(200);
      try {
        const o = await confirmedOrder();
        await drain(app);
        expect(await forEntity(o.id, { channel: 'WHATSAPP' })).toHaveLength(0);
        expect((await forEntity(o.id, { channel: 'EMAIL' })).length).toBe(1);
        expect(
          (
            await prisma.outboxEvent.findFirstOrThrow({
              where: { aggregateId: o.id },
            })
          ).status,
        ).toBe('PROCESSED');
      } finally {
        await admin.api
          .post(`/admin/notification-templates/${t.id}/activate`)
          .expect(200);
      }
    });
  });

  // ───────────────────────── preferences ─────────────────────────
  describe('preferences', () => {
    it('staff can switch categories and channels off, but critical rules ignore the choice', async () => {
      const crit = (
        await admin.api
          .post('/admin/automation/rules', {
            code: `T_CRIT_${Date.now()}`,
            eventType: 'ORDER_CONFIRMED',
            audience: 'ROLE',
            audienceValue: 'ADMIN',
            channels: ['IN_APP'],
            templateCode: 'ORDER_CONFIRMED_STAFF',
            critical: true,
          })
          .expect(201)
      ).body;
      try {
        const prefs = (
          await admin2.api.get('/staff/notification-preferences').expect(200)
        ).body;
        expect(
          prefs.categories.find(
            (c: { category: string }) => c.category === 'COMMERCIAL',
          ),
        ).toMatchObject({ inApp: true, email: true, whatsapp: false });
        await admin2.api
          .put('/staff/notification-preferences', {
            categories: [{ category: 'COMMERCIAL', inApp: false }],
          })
          .expect(200);
        const o = await confirmedOrder();
        await drain(app);
        const mine = await forEntity(o.id, {
          recipientUserId: admin2.id,
          channel: 'IN_APP',
        });
        // the normal rule respects the preference; the critical one does not
        expect(mine).toHaveLength(1);
        expect(mine[0]!.critical).toBe(true);
        const other = await forEntity(o.id, {
          recipientUserId: admin.id,
          channel: 'IN_APP',
        });
        expect(other).toHaveLength(2);
        // switching it off for everyone but critical: deactivate the critical rule and nothing reaches admin2
        await admin.api
          .put(`/admin/automation/rules/${crit.id}`, { active: false })
          .expect(200);
        const o2 = await confirmedOrder();
        await drain(app);
        expect(
          await forEntity(o2.id, { recipientUserId: admin2.id }),
        ).toHaveLength(0);
        await admin2.api
          .put('/staff/notification-preferences', {
            categories: [{ category: 'COMMERCIAL', inApp: true }],
          })
          .expect(200);
        await admin2.api
          .put('/staff/notification-preferences', {
            categories: [{ category: 'BOGUS', inApp: true }],
          })
          .expect(400);
      } finally {
        await deactivateRule(crit.code);
      }
    });

    it('customers can switch off optional milestone messages but not transactional ones', async () => {
      await a.admin
        .put(`/admin/customers/${s.customerId}/notification-preferences`, {
          categories: [
            { category: 'COMMERCIAL', email: false, whatsapp: true },
          ],
        })
        .expect(400);
      await a.admin
        .put(`/admin/customers/${s.customerId}/notification-preferences`, {
          categories: [
            { category: 'PRODUCTION_MILESTONE', email: false, whatsapp: false },
          ],
        })
        .expect(200);
      try {
        const view = (
          await a.admin
            .get(`/admin/customers/${s.customerId}/notification-preferences`)
            .expect(200)
        ).body;
        expect(
          view.categories.find(
            (c: { category: string }) => c.category === 'PRODUCTION_MILESTONE',
          ),
        ).toMatchObject({ optional: true, email: false, whatsapp: false });
        expect(
          view.categories.find(
            (c: { category: string }) => c.category === 'COMMERCIAL',
          ).optional,
        ).toBe(false);
        // milestone: nothing; confirmation: still sent
        const order = await readyOrder(a.admin, s, {});
        const job = (
          await a.admin
            .post(`/admin/orders/${order.id}/create-factory-job`)
            .expect(201)
        ).body;
        expect(
          (await runBulkStage(app, a, floor, job.id, 'FABRIC_PREPARATION'))
            .status,
        ).toBe(200);
        await drain(app);
        expect(
          await forEntity(order.id, {
            type: 'ORDER_MILESTONE',
            recipientKind: 'CUSTOMER',
          }),
        ).toHaveLength(0);
        expect(
          (
            await forEntity(order.id, {
              type: 'ORDER_CONFIRMED',
              recipientKind: 'CUSTOMER',
            })
          ).length,
        ).toBe(2);
        await a.sales
          .put(`/admin/customers/${s.customerId}/notification-preferences`, {})
          .expect(403);
        expect(await auditActions(app, s.customerId)).toContain(
          'customer_notification_preference.changed',
        );
      } finally {
        await a.admin
          .put(`/admin/customers/${s.customerId}/notification-preferences`, {
            categories: [
              { category: 'PRODUCTION_MILESTONE', email: true, whatsapp: true },
            ],
          })
          .expect(200);
      }
    });
  });

  // ───────────────────────── milestones ─────────────────────────
  describe('customer production milestones', () => {
    it('announces each milestone once, with customer-safe wording', async () => {
      const order = await readyOrder(a.admin, s, {});
      const job = (
        await a.admin
          .post(`/admin/orders/${order.id}/create-factory-job`)
          .expect(201)
      ).body;
      for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING', 'CUTTING'])
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      await drain(app);
      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: order.id, eventType: 'ORDER_MILESTONE' },
      });
      const milestones = events
        .map((e) => (e.payload as { milestone: string }).milestone)
        .sort();
      expect(milestones).toEqual([
        'PRODUCTION_IN_PROGRESS',
        'PRODUCTION_STARTED',
      ]); // fabric + pattern share one
      const msgs = await forEntity(order.id, {
        type: 'ORDER_MILESTONE',
        channel: 'WHATSAPP',
      });
      expect(msgs.map((m) => m.body).join(' ')).toMatch(
        /production has started/,
      );
      expect(msgs.map((m) => m.body).join(' ')).toMatch(
        /production is in progress/,
      );
      for (const m of msgs)
        expect(m.body).not.toMatch(
          /fail|rework|block|reject|QC_|FABRIC_PREPARATION|CUTTING/i,
        );
      // finishing more stages never repeats a milestone
      expect(
        (await runBulkStage(app, a, floor, job.id, 'QC_GATE_1')).status,
      ).toBe(200);
      await drain(app);
      const again = await prisma.outboxEvent.findMany({
        where: { aggregateId: order.id, eventType: 'ORDER_MILESTONE' },
      });
      expect(
        again.map((e) => (e.payload as { milestone: string }).milestone).sort(),
      ).toEqual([
        'PRODUCTION_IN_PROGRESS',
        'PRODUCTION_STARTED',
        'QUALITY_CHECK',
      ]);
      expect(new Set(again.map((e) => e.deduplicationKey)).size).toBe(
        again.length,
      );
    }, 60_000);

    it('internal failures are never sent to customers', async () => {
      const order = await readyOrder(a.admin, s, {});
      const job = (
        await a.admin
          .post(`/admin/orders/${order.id}/create-factory-job`)
          .expect(201)
      ).body;
      for (const code of ['FABRIC_PREPARATION', 'PATTERN_MAKING', 'CUTTING'])
        expect((await runBulkStage(app, a, floor, job.id, code)).status).toBe(
          200,
        );
      expect(
        (
          await runBulkStage(app, a, floor, job.id, 'QC_GATE_1', {
            failUnits: 3,
          })
        ).status,
      ).toBe(200);
      await drain(app);
      const toCustomer = await prisma.notification.findMany({
        where: {
          recipientKind: 'CUSTOMER',
          entityId: { in: [order.id, job.id] },
        },
      });
      expect(
        toCustomer.every((x) =>
          // customer-safe event types only (Phase 7C added "ready for production"); never QC / rework / alerts
          [
            'ORDER_MILESTONE',
            'ORDER_CONFIRMED',
            'ORDER_READY_FOR_PRODUCTION',
          ].includes(x.type),
        ),
      ).toBe(true);
      // staff were told: QC people and admins hear about the failure
      const qcMsgs = await prisma.notification.findMany({
        where: { type: 'QC_FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      expect(qcMsgs.some((x) => x.recipientUserId === floor.qc.id)).toBe(true);
      expect(qcMsgs.some((x) => x.recipientUserId === admin.id)).toBe(true);
      expect(qcMsgs.some((x) => x.recipientKind === 'CUSTOMER')).toBe(false);
      const rework = await prisma.notification.findFirst({
        where: { type: 'REWORK_CREATED', recipientUserId: admin.id },
      });
      expect(rework).toBeTruthy();
    }, 60_000);
  });

  // ───────────────────────── quiet hours ─────────────────────────
  describe('quiet hours', () => {
    it('hold customer messages until the window ends; in-app and critical are not held', async () => {
      Object.assign(n.quietHours, {
        start: '21:00',
        end: '08:00',
        appliesTo: 'customer',
      });
      // business zone in tests is Asia/Kolkata (UTC+5:30): 22:00 local = 16:30Z
      ctx.freeze(new Date('2031-06-01T16:30:00Z'));
      const o = await confirmedOrder();
      await drain(app);
      const customer = await forEntity(o.id, { recipientKind: 'CUSTOMER' });
      expect(customer).toHaveLength(2);
      for (const c of customer) {
        expect(c.status).toBe('PENDING');
        expect(c.scheduledAt!.toISOString()).toBe('2031-06-02T02:30:00.000Z'); // 08:00 local next morning
      }
      expect(
        emailOf().sent.filter((m) => m.metadata?.entityId === o.id),
      ).toHaveLength(0);
      // in-app for staff is immediate
      expect(
        (await forEntity(o.id, { channel: 'IN_APP' })).every(
          (x) => x.status === 'SENT',
        ),
      ).toBe(true);
      // still quiet at 07:59 local, released at 08:01
      ctx.freeze(new Date('2031-06-02T02:29:00Z'));
      await drain(app);
      expect(
        emailOf().sent.filter((m) => m.metadata?.entityId === o.id),
      ).toHaveLength(0);
      ctx.freeze(new Date('2031-06-02T02:31:00Z'));
      await drain(app);
      expect(
        emailOf().sent.filter((m) => m.metadata?.entityId === o.id),
      ).toHaveLength(1);
      expect(
        (await forEntity(o.id, { recipientKind: 'CUSTOMER' })).every(
          (c) => c.status === 'SENT',
        ),
      ).toBe(true);
    });

    it('outside the window messages go out immediately', async () => {
      Object.assign(n.quietHours, {
        start: '21:00',
        end: '08:00',
        appliesTo: 'customer',
      });
      ctx.freeze(new Date('2031-06-03T06:30:00Z')); // 12:00 local
      const o = await confirmedOrder();
      await drain(app);
      const rows = await forEntity(o.id, { recipientKind: 'CUSTOMER' });
      expect(
        rows.every((c) => c.status === 'SENT' && c.scheduledAt === null),
      ).toBe(true);
    });

    it('staff external channels follow quiet hours only when configured for everybody; critical rules bypass them', async () => {
      const code = `T_MAIL_${Date.now()}`;
      const normal = (
        await admin.api
          .post('/admin/automation/rules', {
            code,
            eventType: 'ORDER_CONFIRMED',
            audience: 'ROLE',
            audienceValue: 'ADMIN',
            channels: ['EMAIL'],
            templateCode: 'ORDER_CONFIRMED_STAFF',
          })
          .expect(201)
      ).body;
      const critical = (
        await admin.api
          .post('/admin/automation/rules', {
            code: `${code}_C`,
            eventType: 'ORDER_CONFIRMED',
            audience: 'PERMISSION',
            audienceValue: 'automation.manage',
            channels: ['EMAIL'],
            templateCode: 'ORDER_CONFIRMED_STAFF',
            critical: true,
          })
          .expect(201)
      ).body;
      try {
        ctx.freeze(new Date('2031-06-04T17:00:00Z')); // 22:30 local
        Object.assign(n.quietHours, {
          start: '21:00',
          end: '08:00',
          appliesTo: 'customer',
        });
        const o1 = await confirmedOrder();
        await drain(app);
        const staffMail1 = await forEntity(o1.id, {
          recipientKind: 'STAFF',
          channel: 'EMAIL',
        });
        expect(staffMail1.length).toBeGreaterThan(0);
        expect(staffMail1.every((x) => x.status === 'SENT')).toBe(true); // customers-only window
        Object.assign(n.quietHours, { appliesTo: 'all' });
        const o2 = await confirmedOrder();
        await drain(app);
        const staffMail2 = await forEntity(o2.id, {
          recipientKind: 'STAFF',
          channel: 'EMAIL',
        });
        const held = staffMail2.filter((x) => !x.critical);
        const bypass = staffMail2.filter((x) => x.critical);
        expect(held.length).toBeGreaterThan(0);
        expect(held.every((x) => x.status === 'PENDING' && x.scheduledAt)).toBe(
          true,
        );
        expect(bypass.length).toBeGreaterThan(0);
        expect(bypass.every((x) => x.status === 'SENT')).toBe(true);
      } finally {
        await deactivateRule(normal.code);
        await deactivateRule(critical.code);
        await prisma.notification.updateMany({
          where: { status: 'PENDING', channel: 'EMAIL' },
          data: { status: 'CANCELLED' },
        });
      }
    });
  });

  // ───────────────────────── admin visibility ─────────────────────────
  describe('admin view', () => {
    it('lists delivery with filters, masks destinations and hides bodies; detail shows the text', async () => {
      const o = await confirmedOrder();
      await drain(app);
      const list = async (q: string) =>
        (
          await admin.api
            .get(`/admin/notifications?pageSize=100${q}`)
            .expect(200)
        ).body;
      const all = await list('&type=ORDER_CONFIRMED&recipientKind=CUSTOMER');
      const mine = all.data.filter(
        (x: { entityId: string }) => x.entityId === o.id,
      );
      expect(mine).toHaveLength(2);
      const email = mine.find(
        (x: { channel: string }) => x.channel === 'EMAIL',
      );
      expect(email.recipientAddress).toBe('cu***@example.com');
      expect(
        mine.find((x: { channel: string }) => x.channel === 'WHATSAPP')
          .recipientAddress,
      ).toBe('+20***33');
      expect(email).not.toHaveProperty('body');
      expect(JSON.stringify(mine)).not.toContain('customer@example.com');
      expect(
        (await list('&channel=WHATSAPP&status=SENT')).data.every(
          (x: { channel: string; status: string }) =>
            x.channel === 'WHATSAPP' && x.status === 'SENT',
        ),
      ).toBe(true);
      expect(
        (await list('&recipientKind=STAFF')).data.every(
          (x: { recipientKind: string }) => x.recipientKind === 'STAFF',
        ),
      ).toBe(true);
      // "today" in the business timezone (test env: Asia/Kolkata), not UTC
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.BUSINESS_TIMEZONE,
      }).format(new Date());
      expect(
        (await list(`&from=${today}&to=${today}`)).meta.total,
      ).toBeGreaterThan(0);
      expect((await list('&from=2020-01-01&to=2020-01-02')).meta.total).toBe(0);
      const detail = (
        await admin.api.get(`/admin/notifications/${email.id}`).expect(200)
      ).body;
      expect(detail.body).toContain(o.orderNumber);
      expect(detail.recipientAddress).toBe('cu***@example.com');
      await a.sales.get('/admin/notifications').expect(403);
      await a.sales.get(`/admin/notifications/${email.id}`).expect(403);
      await admin.api.get('/admin/notifications?status=WRONG').expect(400);
    });

    it('summarises queue health for operations', async () => {
      const t0 = new Date('2031-07-01T08:00:00Z');
      ctx.freeze(t0);
      const o = await confirmedOrder();
      void o;
      const before = (
        await admin.api.get('/admin/notifications/summary').expect(200)
      ).body;
      expect(before.outbox.pending).toBeGreaterThanOrEqual(1);
      expect(before.outbox.oldestUnprocessedAt).toBeTruthy();
      await drain(app);
      const run = (
        await admin.api
          .post('/admin/automation/run', { tasks: ['outbox', 'dispatch'] })
          .expect(200)
      ).body;
      expect(run.outbox.status).toBe('OK');
      const after = (
        await admin.api.get('/admin/notifications/summary').expect(200)
      ).body;
      expect(after.outbox.pending).toBe(0);
      expect(after.outbox).toHaveProperty('failed');
      expect(after.externalNotifications).toHaveProperty('failed');
      expect(after.openAlerts).toHaveProperty('total');
      expect(after.providers.email).toMatchObject({
        name: 'log-email',
        enabled: true,
      });
      expect(after.scheduler.map((x: { task: string }) => x.task)).toEqual(
        expect.arrayContaining(['outbox', 'dispatch']),
      );
      await a.sales.get('/admin/notifications/summary').expect(403);
    });
  });

  // ───────────────────────── automation rules ─────────────────────────
  describe('automation rule configuration', () => {
    const rule = (over: Record<string, unknown> = {}) => ({
      code: `T_R_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      eventType: 'ORDER_CONFIRMED',
      audience: 'ROLE',
      audienceValue: 'ADMIN',
      channels: ['IN_APP'],
      templateCode: 'ORDER_CONFIRMED_STAFF',
      ...over,
    });

    it('only allows customer-safe events with customer templates and real roles / permissions', async () => {
      const post = (body: object) =>
        admin.api.post('/admin/automation/rules', body);
      await post(
        rule({
          eventType: 'QC_FAILED',
          audience: 'CUSTOMER',
          audienceValue: undefined,
          templateCode: 'ORDER_CONFIRMED',
          channels: ['EMAIL'],
        }),
      ).expect(400); // internal event
      await post(
        rule({
          audience: 'CUSTOMER',
          audienceValue: undefined,
          templateCode: 'ORDER_CONFIRMED_STAFF',
          channels: ['EMAIL'],
        }),
      ).expect(400); // staff text to a customer
      await post(
        rule({
          audience: 'CUSTOMER',
          audienceValue: undefined,
          templateCode: 'ORDER_CONFIRMED',
          channels: ['IN_APP'],
        }),
      ).expect(400); // no inbox
      await post(rule({ audienceValue: 'NO_SUCH_ROLE' })).expect(400);
      await post(
        rule({ audience: 'PERMISSION', audienceValue: 'not.a.permission' }),
      ).expect(400);
      await post(rule({ templateCode: 'ORDER_CONFIRMED' })).expect(400); // customer template to staff
      await post(rule({ templateCode: 'NO_SUCH_TEMPLATE' })).expect(400);
      await post(rule({ channels: [] })).expect(400);
      await post(rule({ eventType: 'NOPE' })).expect(400);
      await post(rule({ alertType: 'DELAYED_STAGE' })).expect(400); // not an ALERT event
      await post(
        rule({ eventType: 'ALERT_ESCALATED', audience: 'ROLE' }),
      ).expect(400);
      await a.sales.post('/admin/automation/rules', rule()).expect(403);
    });

    it('a new rule takes effect, can be changed and deactivated, and is audited', async () => {
      const body = rule({
        audience: 'ROLE',
        audienceValue: 'FINANCE',
        channels: ['IN_APP'],
      });
      const created = (
        await admin.api.post('/admin/automation/rules', body).expect(201)
      ).body;
      await admin.api.post('/admin/automation/rules', body).expect(409);
      try {
        const finance = await createUserAndLogin(app, {
          roleCodes: ['FINANCE'],
        });
        const o = await confirmedOrder();
        await drain(app);
        expect(
          (await forEntity(o.id, { recipientUserId: finance.user.id })).length,
        ).toBe(1);
        await admin.api
          .put(`/admin/automation/rules/${created.id}`, {
            channels: ['IN_APP', 'EMAIL'],
            severity: 'WARNING',
          })
          .expect(200);
        const o2 = await confirmedOrder();
        await drain(app);
        const rows = await forEntity(o2.id, {
          recipientUserId: finance.user.id,
        });
        expect(rows.map((r) => r.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
        expect(rows.every((r) => r.severity === 'WARNING')).toBe(true);
        await admin.api
          .put(`/admin/automation/rules/${created.id}`, {})
          .expect(400);
        await admin.api
          .put(`/admin/automation/rules/${created.id}`, {
            templateCode: 'ORDER_CONFIRMED',
          })
          .expect(400);
        expect(
          (
            await admin.api
              .get(
                '/admin/automation/rules?eventType=ORDER_CONFIRMED&activeOnly=true',
              )
              .expect(200)
          ).body.some((r: { id: string }) => r.id === created.id),
        ).toBe(true);
        expect(await auditActions(app, created.id)).toEqual([
          'automation_rule.created',
          'automation_rule.updated',
        ]);
      } finally {
        await admin.api
          .put(`/admin/automation/rules/${created.id}`, { active: false })
          .expect(200);
      }
      const o3 = await confirmedOrder();
      await drain(app);
      expect(
        await forEntity(o3.id, { channel: 'EMAIL', recipientKind: 'STAFF' }),
      ).toHaveLength(0);
    });
  });
});
