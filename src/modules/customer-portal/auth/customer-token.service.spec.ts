import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../../auth/token.service.js';
import { CustomerTokenService } from './customer-token.service.js';

const staffCfg = {
  secret: 'unit-test-staff-secret-unit-test-secret-123456',
  accessTtlSeconds: 60,
  refreshTtlDays: 1,
  issuer: 'benue-print',
  audience: 'benue-print-staff',
};
const customerCfg = {
  secret: 'unit-test-customer-secret-unit-test-secret-1234',
  audience: 'benue-print-customer',
};

const jwtFor = (secret: string, audience: string) =>
  new JwtService({
    secret,
    signOptions: {
      algorithm: 'HS256',
      expiresIn: 60,
      issuer: 'benue-print',
      audience,
    },
    verifyOptions: {
      algorithms: ['HS256'],
      issuer: 'benue-print',
      audience,
    },
  });

describe('customer vs staff tokens', () => {
  const staff = new TokenService(jwtFor(staffCfg.secret, staffCfg.audience), {
    getOrThrow: () => ({ jwt: staffCfg }),
  } as unknown as ConfigService);
  const customer = new CustomerTokenService(
    jwtFor(customerCfg.secret, customerCfg.audience),
    staff,
  );

  it('round-trips a customer access token', async () => {
    const account = staff.newSessionId();
    const sid = staff.newSessionId();
    const token = await customer.signAccessToken(account, sid);
    await expect(customer.verifyAccessToken(token)).resolves.toMatchObject({
      sub: account,
      sid,
      typ: 'customer',
    });
  });

  it('never verifies a staff token as a customer token', async () => {
    const token = await staff.signAccessToken(
      staff.newSessionId(),
      staff.newSessionId(),
    );
    await expect(customer.verifyAccessToken(token)).rejects.toThrow();
  });

  it('never verifies a customer token as a staff token', async () => {
    const token = await customer.signAccessToken(
      staff.newSessionId(),
      staff.newSessionId(),
    );
    await expect(staff.verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token signed with the customer key and audience but without the customer type', async () => {
    const forged = await jwtFor(
      customerCfg.secret,
      customerCfg.audience,
    ).signAsync({ sub: staff.newSessionId(), sid: staff.newSessionId() });
    await expect(customer.verifyAccessToken(forged)).rejects.toThrow();
  });
});
