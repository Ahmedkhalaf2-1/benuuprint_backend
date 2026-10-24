-- AlterEnum
ALTER TYPE "CustomerAccountStatus" ADD VALUE 'PENDING_VERIFICATION';

-- AlterEnum
ALTER TYPE "UserTokenType" ADD VALUE 'EMAIL_VERIFICATION';

-- AlterTable
ALTER TABLE "customer_accounts" ADD COLUMN     "email_verified_at" TIMESTAMP(3),
ADD COLUMN     "privacy_accepted_at" TIMESTAMP(3),
ADD COLUMN     "self_registered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "terms_accepted_at" TIMESTAMP(3);


-- Existing activated accounts proved their email by following the invitation link.
UPDATE "customer_accounts"
SET "email_verified_at" = COALESCE("password_changed_at", "created_at")
WHERE "status" = 'ACTIVE' AND "email_verified_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Hand-written guards (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

-- A login can only be ACTIVE once the email is verified, and a self-registered account always carries
-- both acceptances. (The new enum value cannot be referenced in the migration that adds it.)
ALTER TABLE "customer_accounts"
  ADD CONSTRAINT "customer_accounts_active_email_verified"
  CHECK ("status" <> 'ACTIVE' OR "email_verified_at" IS NOT NULL);
ALTER TABLE "customer_accounts"
  ADD CONSTRAINT "customer_accounts_self_signup_accepted"
  CHECK (NOT "self_registered" OR ("terms_accepted_at" IS NOT NULL AND "privacy_accepted_at" IS NOT NULL));
