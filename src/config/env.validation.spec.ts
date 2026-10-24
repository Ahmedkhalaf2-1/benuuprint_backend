import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
  };

  it('applies defaults', () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('coerces PORT and booleans', () => {
    const env = validateEnv({
      ...base,
      PORT: '4000',
      SWAGGER_ENABLED: 'false',
    });
    expect(env.PORT).toBe(4000);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a short JWT_ACCESS_SECRET', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('accepts a valid BUSINESS_TIMEZONE, defaults to UTC and rejects unknown zones', () => {
    expect(validateEnv(base).BUSINESS_TIMEZONE).toBe('UTC');
    expect(
      validateEnv({ ...base, BUSINESS_TIMEZONE: 'Africa/Cairo' })
        .BUSINESS_TIMEZONE,
    ).toBe('Africa/Cairo');
    expect(() =>
      validateEnv({ ...base, BUSINESS_TIMEZONE: 'Mars/Olympus' }),
    ).toThrow(/BUSINESS_TIMEZONE/);
  });

  it('bounds the management analytics settings', () => {
    const env = validateEnv(base);
    expect(env.MANAGEMENT_DEFAULT_RANGE_DAYS).toBe(30);
    expect(env.MANAGEMENT_MAX_RANGE_DAYS).toBe(92);
    expect(env.ETA_MIN_SAMPLES).toBe(5);
    expect(() =>
      validateEnv({ ...base, MANAGEMENT_MAX_RANGE_DAYS: '5000' }),
    ).toThrow();
    expect(() => validateEnv({ ...base, ETA_MIN_SAMPLES: '0' })).toThrow();
  });

  it('validates the notification and scheduler settings', () => {
    const env = validateEnv(base);
    expect(env).toMatchObject({
      NOTIFICATION_MAX_ATTEMPTS: 6,
      NOTIFICATION_RETRY_BASE_SECONDS: 60,
      NOTIFICATION_QUIET_HOURS_APPLIES_TO: 'customer',
      NOTIFICATION_DEFAULT_LOCALE: 'en',
    });
    expect(env.EMAIL_PROVIDER).toBeUndefined();
    expect(
      validateEnv({ ...base, EMAIL_PROVIDER: 'disabled' }).EMAIL_PROVIDER,
    ).toBe('disabled');
    expect(() => validateEnv({ ...base, EMAIL_PROVIDER: 'resend' })).toThrow();
    expect(
      validateEnv({
        ...base,
        NOTIFICATION_QUIET_HOURS_START: '21:00',
        NOTIFICATION_QUIET_HOURS_END: '08:00',
      }).NOTIFICATION_QUIET_HOURS_START,
    ).toBe('21:00');
    expect(
      validateEnv({
        ...base,
        NOTIFICATION_QUIET_HOURS_START: '',
        NOTIFICATION_QUIET_HOURS_END: '',
      }).NOTIFICATION_QUIET_HOURS_END,
    ).toBeUndefined(); // an empty value means "not configured"
    expect(() =>
      validateEnv({ ...base, NOTIFICATION_QUIET_HOURS_START: '25:00' }),
    ).toThrow();
    expect(() =>
      validateEnv({ ...base, NOTIFICATION_MAX_ATTEMPTS: '0' }),
    ).toThrow();
    expect(() =>
      validateEnv({ ...base, SCHEDULER_ALERTS_INTERVAL_SECONDS: '1' }),
    ).toThrow();
    expect(
      validateEnv({ ...base, SCHEDULER_ENABLED: 'false' }).SCHEDULER_ENABLED,
    ).toBe(false);
  });
});
