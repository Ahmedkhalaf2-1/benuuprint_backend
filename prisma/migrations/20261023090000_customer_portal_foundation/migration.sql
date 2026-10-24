-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- AlterEnum
ALTER TYPE "TransitionSource" ADD VALUE 'CUSTOMER';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "uploaded_by_customer_id" UUID;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_customer_id" UUID;

-- AlterTable
ALTER TABLE "sample_status_history" ADD COLUMN     "actor_customer_id" UUID;

-- AlterTable
ALTER TABLE "samples" ADD COLUMN     "created_by_customer_id" UUID;

-- CreateTable
CREATE TABLE "customer_accounts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" "CustomerAccountStatus" NOT NULL DEFAULT 'INVITED',
    "last_login_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_account_tokens" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" "UserTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_account_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_customer_id_key" ON "customer_accounts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_email_key" ON "customer_accounts"("email");

-- CreateIndex
CREATE INDEX "customer_accounts_status_idx" ON "customer_accounts"("status");

-- CreateIndex
CREATE INDEX "customer_sessions_account_id_idx" ON "customer_sessions"("account_id");

-- CreateIndex
CREATE INDEX "customer_sessions_expires_at_idx" ON "customer_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "customer_account_tokens_account_id_type_idx" ON "customer_account_tokens"("account_id", "type");

-- CreateIndex
CREATE INDEX "customer_account_tokens_expires_at_idx" ON "customer_account_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "assets_uploaded_by_customer_id_idx" ON "assets"("uploaded_by_customer_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_customer_id_idx" ON "audit_logs"("actor_customer_id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_customer_id_fkey" FOREIGN KEY ("actor_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_account_tokens" ADD CONSTRAINT "customer_account_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_customer_id_fkey" FOREIGN KEY ("uploaded_by_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_created_by_customer_id_fkey" FOREIGN KEY ("created_by_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_status_history" ADD CONSTRAINT "sample_status_history_actor_customer_id_fkey" FOREIGN KEY ("actor_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written guards (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

-- A portal login can only be ACTIVE once a password exists, and e-mails are always stored normalised.
ALTER TABLE "customer_accounts"
  ADD CONSTRAINT "customer_accounts_active_has_password"
  CHECK ("status" <> 'ACTIVE' OR "password_hash" IS NOT NULL);
ALTER TABLE "customer_accounts"
  ADD CONSTRAINT "customer_accounts_email_normalised"
  CHECK ("email" = lower(btrim("email")) AND "email" <> '');

-- An audit entry has at most one kind of actor.
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_single_actor"
  CHECK ("actor_user_id" IS NULL OR "actor_customer_id" IS NULL);
