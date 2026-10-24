-- CreateEnum
CREATE TYPE "StageAssignmentSource" AS ENUM ('MANUAL', 'GLOBAL_DEFAULT', 'CUSTOMER_OVERRIDE');

-- CreateEnum
CREATE TYPE "ResponsibilityScope" AS ENUM ('GLOBAL', 'CUSTOMER');

-- AlterTable
ALTER TABLE "stage_assignments" ADD COLUMN     "source" "StageAssignmentSource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "responsibility_rules" (
    "id" UUID NOT NULL,
    "scope" "ResponsibilityScope" NOT NULL,
    "customer_id" UUID,
    "stage_key" TEXT NOT NULL,
    "primary_user_id" UUID NOT NULL,
    "additional_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "responsibility_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "responsibility_rules_stage_key_idx" ON "responsibility_rules"("stage_key");

-- CreateIndex
CREATE INDEX "responsibility_rules_primary_user_id_idx" ON "responsibility_rules"("primary_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "responsibility_rules_customer_id_stage_key_key" ON "responsibility_rules"("customer_id", "stage_key");

-- AddForeignKey
ALTER TABLE "responsibility_rules" ADD CONSTRAINT "responsibility_rules_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_rules" ADD CONSTRAINT "responsibility_rules_primary_user_id_fkey" FOREIGN KEY ("primary_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written guards (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

-- A GLOBAL rule has no customer, a CUSTOMER rule always has one.
ALTER TABLE "responsibility_rules"
  ADD CONSTRAINT "responsibility_rules_scope_customer"
  CHECK (("scope" = 'GLOBAL' AND "customer_id" IS NULL) OR ("scope" = 'CUSTOMER' AND "customer_id" IS NOT NULL));

-- (customer_id, stage_key) treats NULL customers as distinct, so one GLOBAL rule per stage key needs its own index.
CREATE UNIQUE INDEX "responsibility_rules_global_stage_key_key"
  ON "responsibility_rules" ("stage_key") WHERE "scope" = 'GLOBAL';

-- Stage keys are machine codes, never display names.
ALTER TABLE "responsibility_rules"
  ADD CONSTRAINT "responsibility_rules_stage_key_format"
  CHECK ("stage_key" ~ '^[A-Z][A-Z0-9_]{1,63}$');

-- Fast lookup of a customer's open stages by owner and of open assignments.
CREATE INDEX "stage_assignments_open_idx" ON "stage_assignments" ("job_stage_id") WHERE "removed_at" IS NULL;
