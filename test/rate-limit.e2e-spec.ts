import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './support/app.js';

describe('Auth rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_RATE_LIMIT_PER_MINUTE = '3';
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    process.env.RATE_LIMIT_ENABLED = 'false';
    delete process.env.AUTH_RATE_LIMIT_PER_MINUTE;
  });

  it('returns 429 after too many login attempts from one IP', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'a@test.benue.local', password: 'Wrong-Passw0rd-1' });
    for (let i = 0; i < 3; i++) await attempt().expect(401);
    const res = await attempt().expect(429);
    expect(res.body.statusCode).toBe(429);
    // Other routes are unaffected by the strict auth limit.
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });
});
