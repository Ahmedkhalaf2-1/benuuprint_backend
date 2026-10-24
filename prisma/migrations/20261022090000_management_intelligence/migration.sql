-- CreateEnum
CREATE TYPE "SlaTargetType" AS ENUM ('JOB', 'STAGE', 'ORDER', 'SHIPMENT');

-- CreateEnum
CREATE TYPE "CapacityUnit" AS ENUM ('PIECES', 'JOBS', 'MINUTES');

-- DropIndex
DROP INDEX "blockers_status_idx";

-- DropIndex
DROP INDEX "factory_jobs_status_idx";

-- DropIndex
DROP INDEX "job_stages_status_idx";

-- DropIndex
DROP INDEX "orders_status_idx";

-- DropIndex
DROP INDEX "shipments_status_idx";

-- CreateTable
CREATE TABLE "sla_rules" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_type" "SlaTargetType" NOT NULL,
    "stage_definition_id" UUID,
    "threshold_minutes" INTEGER NOT NULL,
    "warning_before_minutes" INTEGER,
    "priority_multipliers" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_capacities" (
    "id" UUID NOT NULL,
    "department_type" "DepartmentType" NOT NULL,
    "stage_definition_id" UUID,
    "capacity_unit" "CapacityUnit" NOT NULL,
    "daily_capacity" INTEGER NOT NULL,
    "working_minutes_per_day" INTEGER,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_capacities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stage_definition_id" UUID,
    "working_minutes_per_day" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sla_rules_code_key" ON "sla_rules"("code");

-- CreateIndex
CREATE INDEX "sla_rules_target_type_active_idx" ON "sla_rules"("target_type", "active");

-- CreateIndex
CREATE INDEX "sla_rules_stage_definition_id_idx" ON "sla_rules"("stage_definition_id");

-- CreateIndex
CREATE INDEX "department_capacities_department_type_active_idx" ON "department_capacities"("department_type", "active");

-- CreateIndex
CREATE INDEX "department_capacities_effective_from_effective_to_idx" ON "department_capacities"("effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "staff_capacities_user_id_active_idx" ON "staff_capacities"("user_id", "active");

-- CreateIndex
CREATE INDEX "blockers_status_type_idx" ON "blockers"("status", "type");

-- CreateIndex
CREATE INDEX "factory_jobs_status_target_completion_date_idx" ON "factory_jobs"("status", "target_completion_date");

-- CreateIndex
CREATE INDEX "factory_jobs_completed_at_idx" ON "factory_jobs"("completed_at");

-- CreateIndex
CREATE INDEX "job_stages_status_due_at_idx" ON "job_stages"("status", "due_at");

-- CreateIndex
CREATE INDEX "job_stages_stage_definition_id_status_idx" ON "job_stages"("stage_definition_id", "status");

-- CreateIndex
CREATE INDEX "job_stages_completed_at_idx" ON "job_stages"("completed_at");

-- CreateIndex
CREATE INDEX "orders_status_target_delivery_date_idx" ON "orders"("status", "target_delivery_date");

-- CreateIndex
CREATE INDEX "orders_delivered_at_idx" ON "orders"("delivered_at");

-- CreateIndex
CREATE INDEX "payments_status_verified_at_idx" ON "payments"("status", "verified_at");

-- CreateIndex
CREATE INDEX "qc_inspections_completed_at_idx" ON "qc_inspections"("completed_at");

-- CreateIndex
CREATE INDEX "qc_inspections_overall_result_completed_at_idx" ON "qc_inspections"("overall_result", "completed_at");

-- CreateIndex
CREATE INDEX "rework_records_created_at_idx" ON "rework_records"("created_at");

-- CreateIndex
CREATE INDEX "shipments_status_scheduled_at_idx" ON "shipments"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "shipments_delivered_at_idx" ON "shipments"("delivered_at");

-- CreateIndex
CREATE INDEX "stage_production_reports_created_at_idx" ON "stage_production_reports"("created_at");

-- CreateIndex
CREATE INDEX "stage_production_reports_reported_by_user_id_created_at_idx" ON "stage_production_reports"("reported_by_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "sla_rules" ADD CONSTRAINT "sla_rules_stage_definition_id_fkey" FOREIGN KEY ("stage_definition_id") REFERENCES "production_stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_capacities" ADD CONSTRAINT "department_capacities_stage_definition_id_fkey" FOREIGN KEY ("stage_definition_id") REFERENCES "production_stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_capacities" ADD CONSTRAINT "staff_capacities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_capacities" ADD CONSTRAINT "staff_capacities_stage_definition_id_fkey" FOREIGN KEY ("stage_definition_id") REFERENCES "production_stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════ Phase 6A hand-written guards ═══════════════════════

ALTER TABLE "sla_rules" ADD CONSTRAINT "sla_rules_threshold_positive" CHECK ("threshold_minutes" > 0 AND "threshold_minutes" <= 525600);
ALTER TABLE "sla_rules" ADD CONSTRAINT "sla_rules_warning_range"
  CHECK ("warning_before_minutes" IS NULL OR ("warning_before_minutes" >= 0 AND "warning_before_minutes" < "threshold_minutes"));
ALTER TABLE "sla_rules" ADD CONSTRAINT "sla_rules_stage_scope" CHECK ("stage_definition_id" IS NULL OR "target_type" = 'STAGE');
ALTER TABLE "sla_rules" ADD CONSTRAINT "sla_rules_code_format" CHECK ("code" ~ '^[A-Z0-9_]{2,60}$');
-- one active rule per target type (and per stage definition for STAGE rules)
CREATE UNIQUE INDEX "sla_rules_one_active_key" ON "sla_rules"
  ("target_type", COALESCE("stage_definition_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "active";

ALTER TABLE "department_capacities" ADD CONSTRAINT "department_capacities_positive" CHECK ("daily_capacity" > 0);
ALTER TABLE "department_capacities" ADD CONSTRAINT "department_capacities_minutes" CHECK ("working_minutes_per_day" IS NULL OR ("working_minutes_per_day" > 0 AND "working_minutes_per_day" <= 1440));
ALTER TABLE "department_capacities" ADD CONSTRAINT "department_capacities_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");
ALTER TABLE "staff_capacities" ADD CONSTRAINT "staff_capacities_minutes" CHECK ("working_minutes_per_day" > 0 AND "working_minutes_per_day" <= 1440);
ALTER TABLE "staff_capacities" ADD CONSTRAINT "staff_capacities_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- active assignments are the hot path of every workload query
CREATE INDEX "stage_assignments_active_user_idx" ON "stage_assignments" ("user_id", "job_stage_id") WHERE "removed_at" IS NULL;
