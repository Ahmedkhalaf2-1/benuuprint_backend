import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { RESEND_MAX_PER_HOUR } from '../src/modules/customer-portal/auth/customer-signup.service.js';
import type { LogEmailProvider } from '../src/modules/notifications/providers/dev-providers.js';
import { EmailProvider } from '../src/modules/notifications/providers/provider.ports.js';
import { auth, createTestApp, uniq } from './support/app.js';
import { customerLogin } from './support/customer.js';
import { createCustomerWithBrand, makeActors } from './support/factory.js';

const PASSWORD = 'Signup-Passw0rd-123';

describe('Customer self-signup + email verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mail: LogEmailProvider;
  let adminToken: string;
  let admin: Awaited<ReturnType<typeof makeActors>>['admin'];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mail = app.get(EmailProvider, { strict: false }) as LogEmailProvider;
    const a = await makeActors(app);
    adminToken = a.adminToken;
    admin = a.admin;
  });
  afterAll(() => app.close());

  const email = () => `${uniq('signup')}@test.benue.local`;
  const body = (over: Record<string, unknown> = {}) => ({
    name: 'Amina Yusuf',
    email: email(),
    password: PASSWORD,
    acceptedTerms: true,
    acceptedPrivacy: true,
    ...over,
  });
  const register = (b: object) =>
    http().post('/api/v1/customer/auth/register').send(b);
  const verify = (token: string) =>
    http().post('/api/v1/customer/auth/verify-email').send({ token });
  const resend = (e: string) =>
    http().post('/api/v1/customer/auth/resend-verification').send({ email: e });

  /** The newest verification mail to an address, and the token inside its link. */
  const mailsTo = (to: string) =>
    mail.sent.filter((m) => m.to === to && m.subject.includes('Verify'));
  const tokenFor = (to: string): string => {
    const m = mailsTo(to).at(-1);
    const url = /https?:\/\/\S+verify-email\?token=([^\s]+)/.exec(
      m?.text ?? '',
    );
    if (!url?.[1]) throw new Error(`no verification mail for ${to}`);
    return decodeURIComponent(url[1]);
  };
  const registered = async () => {
    const b = body();
    await register(b).expect(201);
    return b;
  };

  it('registers a customer in PENDING_VERIFICATION and emails a link (no token, hash or session returned)', async () => {
    const b = body({ phone: '+201001234567' });
    const res = await register(b).expect(201);
    expect(res.body).toEqual({
      status: 'verification_required',
      email: expect.stringMatching(/^s\*\*\*@test\.benue\.local$/),
      emailVerificationRequired: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token|hash|accessToken/i);

    const account = await prisma.customerAccount.findUniqueOrThrow({
      where: { email: b.email },
      include: { customer: true, tokens: true },
    });
    expect(account).toMatchObject({
      status: 'PENDING_VERIFICATION',
      selfRegistered: true,
      emailVerifiedAt: null,
      createdByUserId: null,
    });
    expect(account.passwordHash).toMatch(/^\$argon2id\$/);
    expect(account.termsAcceptedAt).toBeInstanceOf(Date);
    expect(account.privacyAcceptedAt).toBeInstanceOf(Date);
    expect(account.customer).toMatchObject({
      displayName: 'Amina Yusuf',
      phone: '+201001234567',
      source: 'SELF_SIGNUP',
    });
    expect(await prisma.user.count({ where: { email: b.email } })).toBe(0);
    expect(
      await prisma.customerSession.count({ where: { accountId: account.id } }),
    ).toBe(0);

    // the raw token lives only in the email; the DB keeps a hash
    const token = tokenFor(b.email);
    const secret = token.split('.')[1] ?? '';
    expect(account.tokens).toHaveLength(1);
    expect(account.tokens[0]).toMatchObject({
      type: 'EMAIL_VERIFICATION',
      consumedAt: null,
    });
    expect(account.tokens[0]?.tokenHash).not.toContain(secret);
    expect(mailsTo(b.email)[0]?.text).toContain('expires in 24 hours');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'customer_auth.self_registered', entityId: account.id },
    });
    expect(audit?.actorCustomerId).toBe(account.customerId);
    expect(JSON.stringify(audit?.metadata)).not.toContain(secret);
  });

  it('answers 409 for a duplicate email, also when only case/whitespace differ', async () => {
    const b = await registered();
    await register({ ...b }).expect(409);
    await register({ ...b, email: `  ${b.email.toUpperCase()} ` }).expect(409);
    expect(
      await prisma.customerAccount.count({ where: { email: b.email } }),
    ).toBe(1);
    // a staff-provisioned account's email is protected the same way
    const { customer } = await createCustomerWithBrand(admin);
    const invited = email();
    await admin
      .post(`/admin/customers/${customer.id}/portal-account`, {
        email: invited,
      })
      .expect(201);
    await register(body({ email: invited })).expect(409);
  });

  it('rejects a malformed email, a weak password, missing acceptances and smuggled fields', async () => {
    await register(body({ email: 'not-an-email' })).expect(400);
    for (const password of [
      'short1A',
      'alllowercase123',
      'NoDigitsHereAtAll',
    ]) {
      await register(body({ password })).expect(400);
    }
    await register(body({ acceptedTerms: false })).expect(400);
    await register(body({ acceptedPrivacy: false })).expect(400);
    await register(body({ acceptedTerms: 'true' })).expect(400);
    const { acceptedPrivacy: _drop, ...noPrivacy } = body();
    await register(noPrivacy).expect(400);
    for (const extra of [
      { customerId: '00000000-0000-4000-8000-000000000000' },
      { status: 'ACTIVE' },
      { roles: ['SUPER_ADMIN'] },
      { permissions: ['*'] },
      { emailVerified: true },
      { companyName: 'x' },
    ]) {
      await register(body(extra)).expect(400);
    }
  });

  it('verifies with the emailed token, then the customer signs in normally and reaches the portal', async () => {
    const b = await registered();
    const res = await verify(tokenFor(b.email)).expect(200);
    expect(res.body).toEqual({ status: 'verified' });
    // verification does not log anyone in
    expect(res.body.accessToken).toBeUndefined();

    const account = await prisma.customerAccount.findUniqueOrThrow({
      where: { email: b.email },
    });
    expect(account.status).toBe('ACTIVE');
    expect(account.emailVerifiedAt).toBeInstanceOf(Date);

    const login = await customerLogin(app, b.email, PASSWORD).expect(200);
    const token: string = login.body.accessToken;
    const me = await http()
      .get('/api/v1/customer/auth/me')
      .set(auth(token))
      .expect(200);
    expect(me.body).toMatchObject({
      name: 'Amina Yusuf',
      email: b.email,
      accountStatus: 'ACTIVE',
    });
    await http().get('/api/v1/customer/profile').set(auth(token)).expect(200);
    await http()
      .patch('/api/v1/customer/profile')
      .set(auth(token))
      .send({ city: 'Cairo' })
      .expect(200);
    // no brand yet: a brand is created by staff, the frontend detects it from the empty list
    const brands = await http()
      .get('/api/v1/customer/brands')
      .set(auth(token))
      .expect(200);
    expect(brands.body).toEqual([]);
    await http().get('/api/v1/customer/samples').set(auth(token)).expect(200);

    expect(
      await prisma.auditLog.count({
        where: { action: 'customer_auth.email_verified', entityId: account.id },
      }),
    ).toBe(1);
  });

  it('refuses an expired token and keeps the account unverified', async () => {
    const b = await registered();
    await prisma.customerAccountToken.updateMany({
      where: { account: { email: b.email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await verify(tokenFor(b.email)).expect(400);
    const account = await prisma.customerAccount.findUniqueOrThrow({
      where: { email: b.email },
    });
    expect(account.status).toBe('PENDING_VERIFICATION');
  });

  it('refuses a replayed token, malformed tokens, and tokens of another type', async () => {
    const b = await registered();
    const token = tokenFor(b.email);
    await verify(token).expect(200);
    await verify(token).expect(400);
    await verify('garbage').expect(400);
    await verify(`${token.split('.')[0]}.${'x'.repeat(43)}`).expect(400);
    // a reset/invitation token is not an email-verification token
    const { customer } = await createCustomerWithBrand(admin);
    const invite = (
      await admin
        .post(`/admin/customers/${customer.id}/portal-account`, {
          email: email(),
        })
        .expect(201)
    ).body;
    await verify(invite.inviteToken).expect(400);
  });

  it('denies login before verification with EMAIL_NOT_VERIFIED and issues no session', async () => {
    const b = await registered();
    const res = await customerLogin(app, b.email, PASSWORD).expect(403);
    expect(res.body.error).toBe('EMAIL_NOT_VERIFIED');
    expect(res.body.accessToken).toBeUndefined();
    const account = await prisma.customerAccount.findUniqueOrThrow({
      where: { email: b.email },
    });
    expect(
      await prisma.customerSession.count({ where: { accountId: account.id } }),
    ).toBe(0);
    // a wrong password is still the uniform 401: unverified state is not revealed to strangers
    await customerLogin(app, b.email, 'Wrong-Passw0rd-123').expect(401);
    await customerLogin(app, email(), PASSWORD).expect(401);
    // forgot-password does not bypass verification
    await http()
      .post('/api/v1/customer/auth/forgot-password')
      .send({ email: b.email })
      .expect(200);
    await customerLogin(app, b.email, PASSWORD).expect(403);
    // staff cannot flip an unverified account to ACTIVE either
    await admin
      .post(`/admin/customers/${account.customerId}/portal-account/enable`)
      .expect(409);
  });

  it('resend is generic, only serves pending accounts, and is rate-limited per account', async () => {
    const b = await registered();
    const generic = (await resend(b.email).expect(200)).body;
    expect((await resend(email()).expect(200)).body).toEqual(generic); // unknown
    const active = await registered();
    await verify(tokenFor(active.email)).expect(200);
    const before = mailsTo(active.email).length;
    expect((await resend(active.email).expect(200)).body).toEqual(generic); // already active
    expect(mailsTo(active.email)).toHaveLength(before);

    // within the cooldown the pending account gets nothing new
    expect(mailsTo(b.email)).toHaveLength(1);
    const first = tokenFor(b.email);

    // after the cooldown: a new mail, and the previous link stops working
    const backdate = () =>
      prisma.customerAccountToken.updateMany({
        where: { account: { email: b.email } },
        data: { createdAt: new Date(Date.now() - 120_000) },
      });
    await backdate();
    await resend(b.email).expect(200);
    expect(mailsTo(b.email)).toHaveLength(2);
    await verify(first).expect(400);

    // hourly cap
    for (let i = 0; i < RESEND_MAX_PER_HOUR + 2; i++) {
      await backdate();
      await resend(b.email).expect(200);
    }
    expect(mailsTo(b.email).length).toBeLessThanOrEqual(
      RESEND_MAX_PER_HOUR + 1,
    );
    const audits = await prisma.auditLog.count({
      where: {
        action: 'customer_auth.verification_resent',
        entityType: 'CustomerAccount',
      },
    });
    expect(audits).toBeGreaterThan(0);
    await verify(tokenFor(b.email)).expect(200);
  });

  it('is rate limited per IP on register, resend and verify', async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_RATE_LIMIT_PER_MINUTE = '3';
    const limited = await createTestApp();
    try {
      const h = () => request(limited.getHttpServer());
      for (const [path, payload, ok] of [
        ['register', () => ({ ...body(), email: 'bad' }), 400],
        ['resend-verification', () => ({ email: email() }), 200],
        ['verify-email', () => ({ token: 'x' }), 400],
      ] as const) {
        const hit = () =>
          h().post(`/api/v1/customer/auth/${path}`).send(payload());
        for (let i = 0; i < 3; i++) await hit().expect(ok);
        await hit().expect(429);
      }
    } finally {
      await limited.close();
      process.env.RATE_LIMIT_ENABLED = 'false';
      delete process.env.AUTH_RATE_LIMIT_PER_MINUTE;
    }
  });

  it('keeps staff and customer identities apart and grants no privileges', async () => {
    const b = await registered();
    await verify(tokenFor(b.email)).expect(200);
    const token: string = (
      await customerLogin(app, b.email, PASSWORD).expect(200)
    ).body.accessToken;
    // the public routes never accept a staff token as a customer identity and vice versa
    await http()
      .get('/api/v1/customer/auth/me')
      .set(auth(adminToken))
      .expect(401);
    for (const path of [
      '/auth/me',
      '/admin/customers',
      '/admin/samples',
      '/admin/audit-logs',
      '/admin/users',
    ]) {
      await http().get(`/api/v1${path}`).set(auth(token)).expect(401);
    }
    // a staff login with the new credentials fails: there is no User behind a self-signup
    await http()
      .post('/api/v1/auth/login')
      .send({ email: b.email, password: PASSWORD })
      .expect(401);
    expect(await prisma.user.count({ where: { email: b.email } })).toBe(0);
    // the customer sees nobody else's data
    expect(
      (
        await http()
          .get('/api/v1/customer/samples')
          .set(auth(token))
          .expect(200)
      ).body.data ?? [],
    ).toHaveLength(0);
  });

  it('rolls everything back when the registration transaction fails', async () => {
    const b = body();
    const audit = app.get(AuditService);
    const spy = vi
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('boom'));
    await register(b).expect(500);
    spy.mockRestore();
    expect(
      await prisma.customerAccount.count({ where: { email: b.email } }),
    ).toBe(0);
    expect(await prisma.customer.count({ where: { email: b.email } })).toBe(0);
    expect(mailsTo(b.email)).toHaveLength(0);
    // and the same email can register afterwards
    await register(b).expect(201);
  });
  it('exposes the verification requirement through the public config endpoint', async () => {
    const res = await http().get('/api/v1/customer/auth/config').expect(200);
    expect(res.body).toEqual({ emailVerificationRequired: true });
    expect(
      (await register(body()).expect(201)).body.emailVerificationRequired,
    ).toBe(true);
  });

  describe('CUSTOMER_EMAIL_VERIFICATION_REQUIRED=false', () => {
    let off: INestApplication;
    let offMail: LogEmailProvider;
    const h = () => request(off.getHttpServer());
    const post = (path: string, b: object) =>
      h().post(`/api/v1/customer/auth/${path}`).send(b);

    beforeAll(async () => {
      process.env.CUSTOMER_EMAIL_VERIFICATION_REQUIRED = 'false';
      off = await createTestApp();
      offMail = off.get(EmailProvider, { strict: false }) as LogEmailProvider;
    });
    afterAll(async () => {
      await off.close();
      delete process.env.CUSTOMER_EMAIL_VERIFICATION_REQUIRED;
    });

    it('registers an ACTIVE account without a token or email, and signs in immediately', async () => {
      expect(
        (await h().get('/api/v1/customer/auth/config').expect(200)).body,
      ).toEqual({
        emailVerificationRequired: false,
      });
      const b = body();
      const res = await post('register', b).expect(201);
      expect(res.body).toMatchObject({
        status: 'registered',
        emailVerificationRequired: false,
      });
      const account = await prisma.customerAccount.findUniqueOrThrow({
        where: { email: b.email },
        include: { tokens: true },
      });
      expect(account).toMatchObject({
        status: 'ACTIVE',
        selfRegistered: true,
        emailVerifiedAt: null,
      });
      expect(account.passwordHash).toMatch(/^\$argon2id\$/);
      expect(account.tokens).toHaveLength(0);
      expect(offMail.sent.filter((m) => m.to === b.email)).toHaveLength(0);

      const login = await post('login', {
        email: b.email,
        password: PASSWORD,
      }).expect(200);
      const token: string = login.body.accessToken;
      await h().get('/api/v1/customer/auth/me').set(auth(token)).expect(200);
      await h().get('/api/v1/customer/profile').set(auth(token)).expect(200);
      await h().get('/api/v1/customer/samples').set(auth(token)).expect(200);
      // staff isolation and duplicate protection are unchanged
      await h().get('/api/v1/admin/customers').set(auth(token)).expect(401);
      await post('register', b).expect(409);
      await post('register', { ...b, password: 'weak' }).expect(400);
    });

    it('keeps verify-email and resend-verification working', async () => {
      await post('verify-email', { token: 'garbage' }).expect(400);
      const res = await post('resend-verification', { email: email() }).expect(
        200,
      );
      expect(res.body.message).toBeTruthy();
    });

    it('lets in an account that registered while verification was required', async () => {
      const b = await registered(); // created by the verification-required app
      expect((await customerLogin(app, b.email, PASSWORD)).status).toBe(403);
      await post('login', { email: b.email, password: PASSWORD }).expect(200);
      const account = await prisma.customerAccount.findUniqueOrThrow({
        where: { email: b.email },
      });
      expect(account.status).toBe('ACTIVE');
      expect(account.emailVerifiedAt).toBeNull();
    });
  });
});
