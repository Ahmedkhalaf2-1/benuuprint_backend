import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './support/app.js';

describe('Public tracking rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.TRACKING_RATE_LIMIT_PER_MINUTE = '4';
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    process.env.RATE_LIMIT_ENABLED = 'false';
    delete process.env.TRACKING_RATE_LIMIT_PER_MINUTE;
  });

  it('answers 429 after too many tracking lookups from one IP, without touching other routes', async () => {
    const lookup = () =>
      request(app.getHttpServer()).get(
        `/api/v1/track/orders/${'x'.repeat(43)}`,
      );
    for (let i = 0; i < 4; i++) await lookup().expect(404); // always the same generic answer
    const res = await lookup().expect(429);
    expect(res.body.statusCode).toBe(429);
    expect(JSON.stringify(res.body)).not.toContain('x'.repeat(43));
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    // the auth limiter is a separate bucket
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.benue.local', password: 'Wrong-Passw0rd-1' })
      .expect(401);
  });
});
