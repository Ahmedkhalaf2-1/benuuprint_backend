import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGINS: z.string().default(''),
  SWAGGER_ENABLED: booleanString.default(true),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TRUST_PROXY: booleanString.default(false),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  /** Optional dedicated signing key for customer-portal tokens; derived from JWT_ACCESS_SECRET when unset. */
  JWT_CUSTOMER_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  STORAGE_PROVIDER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./storage'),
  STORAGE_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(20 * 1024 * 1024),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(86400)
    .default(300),
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  // Phase 7D: when false, self-signup accounts are ACTIVE immediately and may sign in without verifying
  // (development convenience). Default true; the verification code and endpoints stay in place.
  CUSTOMER_EMAIL_VERIFICATION_REQUIRED: booleanString.default(true),
  // Phase 7D: lifetime of the customer self-signup email verification link.
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(1440)
    .default(60),
  // Return one-time tokens in admin API responses. Defaults to on outside production
  // because no email provider exists yet; in production tokens are only handed to
  // the TokenDelivery hook.
  DEFAULT_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/, 'DEFAULT_CURRENCY must be an ISO 4217 code like EGP')
    .default('EGP'),
  PUBLIC_APP_URL: z.string().url().optional(),
  EXPOSE_ONE_TIME_TOKENS: booleanString.optional(),
  // Release gate for bulk orders (READY_FOR_PRODUCTION): needs an accepted quotation and
  // this share of its total verified. 100 = full payment (the default business rule);
  // lower it for a deposit, 0 for none.
  ORDER_REQUIRE_ACCEPTED_QUOTATION: booleanString.default(true),
  ORDER_REQUIRED_PAID_PERCENT: z.coerce.number().min(0).max(100).default(100),
  // Phase 6A: "today", "this week" and daily buckets follow this IANA zone; timestamps stay UTC.
  BUSINESS_TIMEZONE: z
    .string()
    .default('UTC')
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'BUSINESS_TIMEZONE must be a valid IANA time zone' },
    ),
  MANAGEMENT_DEFAULT_RANGE_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(366)
    .default(30),
  MANAGEMENT_MAX_RANGE_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(731)
    .default(92),
  MANAGEMENT_DUE_SOON_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(720)
    .default(24),
  MANAGEMENT_DEADLINE_WINDOW_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(720)
    .default(48),
  MANAGEMENT_QC_LOOKBACK_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(720)
    .default(72),
  // Phase 6B: notification delivery, scheduler, quiet hours. Provider selection is environment-driven;
  // `log` records deliveries in memory/logs (development), `disabled` skips the channel.
  EMAIL_PROVIDER: z.enum(['log', 'disabled']).optional(),
  WHATSAPP_PROVIDER: z.enum(['log', 'disabled']).optional(),
  EMAIL_FROM: z.string().default('Benue Print <no-reply@benue-print.local>'),
  NOTIFICATION_DEFAULT_LOCALE: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default('en'),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  NOTIFICATION_RETRY_BASE_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(60),
  NOTIFICATION_RETRY_MAX_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86400)
    .default(3600),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  NOTIFICATION_QUIET_HOURS_START: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional()
    .or(z.literal('')),
  NOTIFICATION_QUIET_HOURS_END: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional()
    .or(z.literal('')),
  NOTIFICATION_QUIET_HOURS_APPLIES_TO: z
    .enum(['customer', 'all'])
    .default('customer'),
  SCHEDULER_ENABLED: booleanString.optional(),
  SCHEDULER_OUTBOX_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(10),
  SCHEDULER_DISPATCH_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(15),
  SCHEDULER_ALERTS_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(86400)
    .default(300),
  ETA_HISTORY_DAYS: z.coerce.number().int().min(7).max(730).default(90),
  ETA_MIN_SAMPLES: z.coerce.number().int().min(1).max(1000).default(5),
  TRACKING_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_ENABLED: booleanString.default(true),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /** Customer-portal uploads and submit actions, per IP per minute. */
  CUSTOMER_ACTION_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .default(30),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  // Docker/compose pass unset optional variables as empty strings; treat them as absent.
  const present = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== ''),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}
