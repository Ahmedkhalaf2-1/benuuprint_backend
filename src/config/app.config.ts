import { createHmac } from 'node:crypto';
import { registerAs } from '@nestjs/config';
import { validateEnv } from './env.validation.js';

export const appConfig = registerAs('app', () => {
  const env = validateEnv(process.env);
  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    swaggerEnabled: env.SWAGGER_ENABLED,
    trustProxy: env.TRUST_PROXY,
    jwt: {
      secret: env.JWT_ACCESS_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      issuer: 'benue-print',
      // Staff tokens only; a future customer portal uses a different audience.
      audience: 'benue-print-staff',
    },
    // Customer portal tokens: different audience AND different key, so a staff token can never verify here
    // and a customer token can never verify as staff.
    customerJwt: {
      secret:
        env.JWT_CUSTOMER_SECRET ??
        createHmac('sha256', env.JWT_ACCESS_SECRET)
          .update('benue-print:customer-portal')
          .digest('hex'),
      audience: 'benue-print-customer',
    },
    storage: {
      provider: env.STORAGE_PROVIDER,
      localRoot: env.STORAGE_LOCAL_ROOT,
      maxFileBytes: env.STORAGE_MAX_FILE_BYTES,
      signedUrlTtlSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS,
    },
    publicAppUrl: env.PUBLIC_APP_URL,
    defaultCurrency: env.DEFAULT_CURRENCY,
    customerAuth: {
      emailVerificationRequired: env.CUSTOMER_EMAIL_VERIFICATION_REQUIRED,
    },
    accountTokens: {
      invitationTtlHours: env.INVITATION_TTL_HOURS,
      passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
      emailVerificationTtlHours: env.EMAIL_VERIFICATION_TTL_HOURS,
      exposeTokens: env.EXPOSE_ONE_TIME_TOKENS ?? env.NODE_ENV !== 'production',
    },
    orders: {
      requireAcceptedQuotation: env.ORDER_REQUIRE_ACCEPTED_QUOTATION,
      requiredPaidPercent: env.ORDER_REQUIRED_PAID_PERCENT,
    },
    management: {
      timezone: env.BUSINESS_TIMEZONE,
      defaultRangeDays: env.MANAGEMENT_DEFAULT_RANGE_DAYS,
      maxRangeDays: env.MANAGEMENT_MAX_RANGE_DAYS,
      dueSoonHours: env.MANAGEMENT_DUE_SOON_HOURS,
      deadlineWindowHours: env.MANAGEMENT_DEADLINE_WINDOW_HOURS,
      qcLookbackHours: env.MANAGEMENT_QC_LOOKBACK_HOURS,
      etaHistoryDays: env.ETA_HISTORY_DAYS,
      etaMinSamples: env.ETA_MIN_SAMPLES,
    },
    notifications: {
      emailProvider:
        env.EMAIL_PROVIDER ??
        (env.NODE_ENV === 'production' ? 'disabled' : 'log'),
      whatsappProvider:
        env.WHATSAPP_PROVIDER ??
        (env.NODE_ENV === 'production' ? 'disabled' : 'log'),
      emailFrom: env.EMAIL_FROM,
      defaultLocale: env.NOTIFICATION_DEFAULT_LOCALE,
      maxAttempts: env.NOTIFICATION_MAX_ATTEMPTS,
      retryBaseSeconds: env.NOTIFICATION_RETRY_BASE_SECONDS,
      retryMaxSeconds: env.NOTIFICATION_RETRY_MAX_SECONDS,
      outboxMaxAttempts: env.OUTBOX_MAX_ATTEMPTS,
      outboxBatchSize: env.OUTBOX_BATCH_SIZE,
      outboxLeaseSeconds: env.OUTBOX_LEASE_SECONDS,
      quietHours: {
        start: env.NOTIFICATION_QUIET_HOURS_START || null,
        end: env.NOTIFICATION_QUIET_HOURS_END || null,
        appliesTo: env.NOTIFICATION_QUIET_HOURS_APPLIES_TO,
      },
    },
    scheduler: {
      // Runs inside the API process (single node). Off in tests; they call the tasks explicitly.
      enabled: env.SCHEDULER_ENABLED ?? env.NODE_ENV !== 'test',
      outboxIntervalSeconds: env.SCHEDULER_OUTBOX_INTERVAL_SECONDS,
      dispatchIntervalSeconds: env.SCHEDULER_DISPATCH_INTERVAL_SECONDS,
      alertsIntervalSeconds: env.SCHEDULER_ALERTS_INTERVAL_SECONDS,
    },
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED,
      trackingPerMinute: env.TRACKING_RATE_LIMIT_PER_MINUTE,
      authPerMinute: env.AUTH_RATE_LIMIT_PER_MINUTE,
      customerActionPerMinute: env.CUSTOMER_ACTION_RATE_LIMIT_PER_MINUTE,
    },
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
