-- CreateEnum
CREATE TYPE "FactoryJobSourceType" AS ENUM ('SAMPLE', 'ORDER', 'ORDER_BATCH');

-- CreateEnum
CREATE TYPE "FactoryJobStatus" AS ENUM ('PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "DepartmentType" AS ENUM ('FABRIC', 'PATTERN', 'CUTTING', 'PRINTING', 'SEWING', 'QC', 'PACKAGING', 'GENERAL');

-- CreateEnum
CREATE TYPE "WorkflowVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "JobStageStatus" AS ENUM ('WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'SKIPPED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BlockerType" AS ENUM ('WAITING_FOR_CUSTOMER', 'MATERIAL_UNAVAILABLE', 'ARTWORK_ISSUE', 'PATTERN_REVISION', 'MACHINE_MAINTENANCE', 'PAYMENT_PENDING', 'SUPPLIER_DELAY', 'QUALITY_ISSUE', 'STAFFING', 'OTHER');

-- CreateEnum
CREATE TYPE "BlockerStatus" AS ENUM ('OPEN', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReworkStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QcResultType" AS ENUM ('PASS_FAIL', 'TEXT', 'NUMBER', 'MEASUREMENT', 'PHOTO_REQUIRED');

-- CreateEnum
CREATE TYPE "QcItemResult" AS ENUM ('PASS', 'FAIL', 'NA');

-- CreateEnum
CREATE TYPE "QcInspectionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QcOverallResult" AS ENUM ('PASS', 'FAIL', 'CONDITIONAL_PASS');

-- CreateEnum
CREATE TYPE "JobNoteVisibility" AS ENUM ('INTERNAL');

-- CreateEnum
CREATE TYPE "JobActivityType" AS ENUM ('JOB_CREATED', 'JOB_RELEASED', 'STAGE_READY', 'STAGE_ASSIGNED', 'STAGE_UNASSIGNED', 'STAGE_STARTED', 'STAGE_COMPLETED', 'STAGE_SKIPPED', 'STAGE_BLOCKED', 'BLOCKER_RESOLVED', 'BLOCKER_CANCELLED', 'STAGE_HELD', 'STAGE_RESUMED', 'QC_STARTED', 'QC_PASSED', 'QC_CONDITIONAL_PASS', 'QC_FAILED', 'REWORK_CREATED', 'REWORK_RESOLVED', 'JOB_HOLD', 'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_COMPLETED', 'PRIORITY_CHANGED', 'NOTE_ADDED', 'ASSET_ATTACHED', 'ADMIN_OVERRIDE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AssetType" ADD VALUE 'PRODUCTION_REFERENCE';
ALTER TYPE "AssetType" ADD VALUE 'STAGE_PHOTO';
ALTER TYPE "AssetType" ADD VALUE 'PATTERN_OUTPUT';
ALTER TYPE "AssetType" ADD VALUE 'PRINT_PROOF';

-- AlterTable
ALTER TABLE "asset_attachments" ADD COLUMN     "factory_job_id" UUID,
ADD COLUMN     "job_stage_id" UUID,
ADD COLUMN     "qc_inspection_id" UUID;

-- CreateTable
CREATE TABLE "factory_jobs" (
    "id" UUID NOT NULL,
    "job_number" TEXT NOT NULL,
    "source_type" "FactoryJobSourceType" NOT NULL DEFAULT 'SAMPLE',
    "sample_id" UUID,
    "sample_production_spec_id" UUID NOT NULL,
    "workflow_template_version_id" UUID NOT NULL,
    "status" "FactoryJobStatus" NOT NULL DEFAULT 'READY',
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "assigned_sales_user_id" UUID,
    "customer_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "product_type_id" UUID,
    "product_name" TEXT NOT NULL,
    "requested_start_date" TIMESTAMP(3),
    "target_completion_date" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "hold_reason" TEXT,
    "held_at" TIMESTAMP(3),
    "hold_previous_status" "FactoryJobStatus",
    "cancel_reason" TEXT,
    "internal_notes" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "factory_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "department_type" "DepartmentType" NOT NULL,
    "default_sequence" INTEGER NOT NULL DEFAULT 0,
    "expected_duration_minutes" INTEGER,
    "requires_assignment" BOOLEAN NOT NULL DEFAULT true,
    "requires_completion_note" BOOLEAN NOT NULL DEFAULT false,
    "requires_attachment" BOOLEAN NOT NULL DEFAULT false,
    "is_qc_stage" BOOLEAN NOT NULL DEFAULT false,
    "eligible_role_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "production_stage_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "WorkflowVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "activated_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_template_stages" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "stage_definition_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "expected_duration_minutes" INTEGER,
    "can_run_in_parallel" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_template_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_template_stage_dependencies" (
    "stage_id" UUID NOT NULL,
    "depends_on_stage_id" UUID NOT NULL,

    CONSTRAINT "workflow_template_stage_dependencies_pkey" PRIMARY KEY ("stage_id","depends_on_stage_id")
);

-- CreateTable
CREATE TABLE "job_stages" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage_definition_id" UUID NOT NULL,
    "template_stage_id" UUID,
    "sequence" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "rework_record_id" UUID,
    "status" "JobStageStatus" NOT NULL DEFAULT 'WAITING',
    "stage_code" TEXT NOT NULL,
    "stage_name" TEXT NOT NULL,
    "department_type" "DepartmentType" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "is_qc_stage" BOOLEAN NOT NULL DEFAULT false,
    "requires_assignment" BOOLEAN NOT NULL DEFAULT true,
    "requires_completion_note" BOOLEAN NOT NULL DEFAULT false,
    "requires_attachment" BOOLEAN NOT NULL DEFAULT false,
    "expected_duration_minutes" INTEGER,
    "ready_at" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "blocked_at" TIMESTAMP(3),
    "block_reason" TEXT,
    "blocked_from_status" "JobStageStatus",
    "is_on_hold" BOOLEAN NOT NULL DEFAULT false,
    "hold_reason" TEXT,
    "held_at" TIMESTAMP(3),
    "completion_note" TEXT,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_stage_dependencies" (
    "job_stage_id" UUID NOT NULL,
    "depends_on_job_stage_id" UUID NOT NULL,

    CONSTRAINT "job_stage_dependencies_pkey" PRIMARY KEY ("job_stage_id","depends_on_job_stage_id")
);

-- CreateTable
CREATE TABLE "stage_assignments" (
    "id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_by_user_id" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "context" TEXT,
    "removed_at" TIMESTAMP(3),
    "removed_by_user_id" UUID,

    CONSTRAINT "stage_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockers" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_stage_id" UUID,
    "type" "BlockerType" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "BlockerStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_user_id" UUID NOT NULL,
    "resolved_by_user_id" UUID,
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "blockers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rework_records" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "failed_stage_id" UUID NOT NULL,
    "qc_inspection_id" UUID,
    "target_stage_definition_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReworkStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "rework_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_templates" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stage_definition_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_checklist_item_definitions" (
    "id" UUID NOT NULL,
    "qc_template_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "result_type" "QcResultType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,

    CONSTRAINT "qc_checklist_item_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_inspections" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "qc_template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "inspector_user_id" UUID NOT NULL,
    "status" "QcInspectionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "overall_result" "QcOverallResult",
    "notes" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "qc_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_inspection_results" (
    "id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "checklist_item_id" UUID NOT NULL,
    "result" "QcItemResult",
    "numeric_value" DECIMAL(14,4),
    "text_value" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qc_inspection_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_activities" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_stage_id" UUID,
    "actor_user_id" UUID,
    "type" "JobActivityType" NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_notes" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_stage_id" UUID,
    "author_user_id" UUID NOT NULL,
    "visibility" "JobNoteVisibility" NOT NULL DEFAULT 'INTERNAL',
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "job_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "factory_jobs_job_number_key" ON "factory_jobs"("job_number");

-- CreateIndex
CREATE INDEX "factory_jobs_status_idx" ON "factory_jobs"("status");

-- CreateIndex
CREATE INDEX "factory_jobs_priority_idx" ON "factory_jobs"("priority");

-- CreateIndex
CREATE INDEX "factory_jobs_sample_id_idx" ON "factory_jobs"("sample_id");

-- CreateIndex
CREATE INDEX "factory_jobs_workflow_template_version_id_idx" ON "factory_jobs"("workflow_template_version_id");

-- CreateIndex
CREATE INDEX "factory_jobs_sample_production_spec_id_idx" ON "factory_jobs"("sample_production_spec_id");

-- CreateIndex
CREATE INDEX "factory_jobs_created_at_idx" ON "factory_jobs"("created_at");

-- CreateIndex
CREATE INDEX "factory_jobs_target_completion_date_idx" ON "factory_jobs"("target_completion_date");

-- CreateIndex
CREATE INDEX "factory_jobs_customer_id_idx" ON "factory_jobs"("customer_id");

-- CreateIndex
CREATE INDEX "factory_jobs_brand_id_idx" ON "factory_jobs"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_stage_definitions_code_key" ON "production_stage_definitions"("code");

-- CreateIndex
CREATE INDEX "production_stage_definitions_department_type_idx" ON "production_stage_definitions"("department_type");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_code_key" ON "workflow_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_versions_template_id_version_key" ON "workflow_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "workflow_template_stages_stage_definition_id_idx" ON "workflow_template_stages"("stage_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_stages_version_id_sequence_key" ON "workflow_template_stages"("version_id", "sequence");

-- CreateIndex
CREATE INDEX "workflow_template_stage_dependencies_depends_on_stage_id_idx" ON "workflow_template_stage_dependencies"("depends_on_stage_id");

-- CreateIndex
CREATE INDEX "job_stages_job_id_idx" ON "job_stages"("job_id");

-- CreateIndex
CREATE INDEX "job_stages_status_idx" ON "job_stages"("status");

-- CreateIndex
CREATE INDEX "job_stages_stage_definition_id_idx" ON "job_stages"("stage_definition_id");

-- CreateIndex
CREATE INDEX "job_stages_due_at_idx" ON "job_stages"("due_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_stages_job_id_sequence_attempt_key" ON "job_stages"("job_id", "sequence", "attempt");

-- CreateIndex
CREATE INDEX "job_stage_dependencies_depends_on_job_stage_id_idx" ON "job_stage_dependencies"("depends_on_job_stage_id");

-- CreateIndex
CREATE INDEX "stage_assignments_user_id_idx" ON "stage_assignments"("user_id");

-- CreateIndex
CREATE INDEX "stage_assignments_job_stage_id_idx" ON "stage_assignments"("job_stage_id");

-- CreateIndex
CREATE INDEX "stage_assignments_removed_at_idx" ON "stage_assignments"("removed_at");

-- CreateIndex
CREATE INDEX "blockers_job_id_idx" ON "blockers"("job_id");

-- CreateIndex
CREATE INDEX "blockers_job_stage_id_idx" ON "blockers"("job_stage_id");

-- CreateIndex
CREATE INDEX "blockers_status_idx" ON "blockers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rework_records_failed_stage_id_key" ON "rework_records"("failed_stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "rework_records_qc_inspection_id_key" ON "rework_records"("qc_inspection_id");

-- CreateIndex
CREATE INDEX "rework_records_job_id_idx" ON "rework_records"("job_id");

-- CreateIndex
CREATE INDEX "rework_records_status_idx" ON "rework_records"("status");

-- CreateIndex
CREATE INDEX "qc_templates_stage_definition_id_is_active_idx" ON "qc_templates"("stage_definition_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "qc_templates_code_version_key" ON "qc_templates"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "qc_checklist_item_definitions_qc_template_id_code_key" ON "qc_checklist_item_definitions"("qc_template_id", "code");

-- CreateIndex
CREATE INDEX "qc_inspections_job_id_idx" ON "qc_inspections"("job_id");

-- CreateIndex
CREATE INDEX "qc_inspections_job_stage_id_idx" ON "qc_inspections"("job_stage_id");

-- CreateIndex
CREATE INDEX "qc_inspections_status_idx" ON "qc_inspections"("status");

-- CreateIndex
CREATE INDEX "qc_inspections_inspector_user_id_idx" ON "qc_inspections"("inspector_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "qc_inspection_results_inspection_id_checklist_item_id_key" ON "qc_inspection_results"("inspection_id", "checklist_item_id");

-- CreateIndex
CREATE INDEX "job_activities_job_id_created_at_idx" ON "job_activities"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "job_activities_job_stage_id_idx" ON "job_activities"("job_stage_id");

-- CreateIndex
CREATE INDEX "job_notes_job_id_created_at_idx" ON "job_notes"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "job_notes_job_stage_id_idx" ON "job_notes"("job_stage_id");

-- CreateIndex
CREATE INDEX "asset_attachments_factory_job_id_idx" ON "asset_attachments"("factory_job_id");

-- CreateIndex
CREATE INDEX "asset_attachments_job_stage_id_idx" ON "asset_attachments"("job_stage_id");

-- CreateIndex
CREATE INDEX "asset_attachments_qc_inspection_id_idx" ON "asset_attachments"("qc_inspection_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_factory_job_id_key" ON "asset_attachments"("asset_id", "factory_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_job_stage_id_key" ON "asset_attachments"("asset_id", "job_stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_qc_inspection_id_key" ON "asset_attachments"("asset_id", "qc_inspection_id");

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_factory_job_id_fkey" FOREIGN KEY ("factory_job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_qc_inspection_id_fkey" FOREIGN KEY ("qc_inspection_id") REFERENCES "qc_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_sample_production_spec_id_fkey" FOREIGN KEY ("sample_production_spec_id") REFERENCES "sample_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_workflow_template_version_id_fkey" FOREIGN KEY ("workflow_template_version_id") REFERENCES "workflow_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_stages" ADD CONSTRAINT "workflow_template_stages_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "workflow_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_stages" ADD CONSTRAINT "workflow_template_stages_stage_definition_id_fkey" FOREIGN KEY ("stage_definition_id") REFERENCES "production_stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_stage_dependencies" ADD CONSTRAINT "workflow_template_stage_dependencies_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "workflow_template_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_stage_dependencies" ADD CONSTRAINT "workflow_template_stage_dependencies_depends_on_stage_id_fkey" FOREIGN KEY ("depends_on_stage_id") REFERENCES "workflow_template_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_stage_definition_id_fkey" FOREIGN KEY ("stage_definition_id") REFERENCES "production_stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_template_stage_id_fkey" FOREIGN KEY ("template_stage_id") REFERENCES "workflow_template_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_rework_record_id_fkey" FOREIGN KEY ("rework_record_id") REFERENCES "rework_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stage_dependencies" ADD CONSTRAINT "job_stage_dependencies_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stage_dependencies" ADD CONSTRAINT "job_stage_dependencies_depends_on_job_stage_id_fkey" FOREIGN KEY ("depends_on_job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_assignments" ADD CONSTRAINT "stage_assignments_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_assignments" ADD CONSTRAINT "stage_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_failed_stage_id_fkey" FOREIGN KEY ("failed_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_qc_inspection_id_fkey" FOREIGN KEY ("qc_inspection_id") REFERENCES "qc_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_target_stage_definition_id_fkey" FOREIGN KEY ("target_stage_definition_id") REFERENCES "production_stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_templates" ADD CONSTRAINT "qc_templates_stage_definition_id_fkey" FOREIGN KEY ("stage_definition_id") REFERENCES "production_stage_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_checklist_item_definitions" ADD CONSTRAINT "qc_checklist_item_definitions_qc_template_id_fkey" FOREIGN KEY ("qc_template_id") REFERENCES "qc_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_qc_template_id_fkey" FOREIGN KEY ("qc_template_id") REFERENCES "qc_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_inspector_user_id_fkey" FOREIGN KEY ("inspector_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspection_results" ADD CONSTRAINT "qc_inspection_results_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "qc_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspection_results" ADD CONSTRAINT "qc_inspection_results_checklist_item_id_fkey" FOREIGN KEY ("checklist_item_id") REFERENCES "qc_checklist_item_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_activities" ADD CONSTRAINT "job_activities_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_activities" ADD CONSTRAINT "job_activities_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_activities" ADD CONSTRAINT "job_activities_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written constraints and guards Prisma cannot express
-- ===========================================================================

-- ---- assets: an attachment targets exactly one entity (now ten targets) ----
ALTER TABLE "asset_attachments" DROP CONSTRAINT "asset_attachments_exactly_one_target";
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_exactly_one_target"
  CHECK (num_nonnulls("customer_id", "brand_id", "fabric_id", "pattern_version_id", "product_type_id",
                      "print_method_id", "sample_id", "factory_job_id", "job_stage_id", "qc_inspection_id") = 1);

-- ---- factory jobs ----
-- Exactly one source id. Phase 5 adds order_id / order_batch_id and extends this CHECK.
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_source_matches_type"
  CHECK (num_nonnulls("sample_id") = 1 AND ("source_type" = 'SAMPLE') = ("sample_id" IS NOT NULL));
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_hold_consistent"
  CHECK (("status" = 'ON_HOLD') = ("hold_reason" IS NOT NULL AND "hold_previous_status" IS NOT NULL AND "held_at" IS NOT NULL));
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_cancelled_consistent"
  CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_completed_consistent"
  CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL));
-- one live (non-cancelled) job per sample, even under concurrent creation
CREATE UNIQUE INDEX "factory_jobs_one_live_per_sample_key" ON "factory_jobs" ("sample_id")
  WHERE "sample_id" IS NOT NULL AND "status" <> 'CANCELLED';

CREATE OR REPLACE FUNCTION factory_jobs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'factory_jobs are never deleted';
  END IF;
  IF NEW.job_number <> OLD.job_number OR NEW.source_type <> OLD.source_type
     OR NEW.sample_id IS DISTINCT FROM OLD.sample_id
     OR NEW.sample_production_spec_id <> OLD.sample_production_spec_id
     OR NEW.workflow_template_version_id <> OLD.workflow_template_version_id
     OR NEW.customer_id <> OLD.customer_id OR NEW.brand_id <> OLD.brand_id
     OR NEW.product_type_id IS DISTINCT FROM OLD.product_type_id
     OR NEW.product_name <> OLD.product_name OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
    RAISE EXCEPTION 'a factory job''s source, specification and workflow version are immutable';
  END IF;
  IF OLD.status IN ('COMPLETED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % factory job cannot change status', OLD.status;
  END IF;
  IF (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'job timestamps are set once and never changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER factory_jobs_guard BEFORE UPDATE OR DELETE ON "factory_jobs"
  FOR EACH ROW EXECUTE FUNCTION factory_jobs_guard();

-- ---- stage definitions / workflow templates ----
ALTER TABLE "production_stage_definitions" ADD CONSTRAINT "stage_definitions_duration_positive"
  CHECK ("expected_duration_minutes" IS NULL OR "expected_duration_minutes" > 0);
-- at most one default template and one ACTIVE version per template
CREATE UNIQUE INDEX "workflow_templates_one_default_key" ON "workflow_templates" ((true)) WHERE "is_default";
CREATE UNIQUE INDEX "workflow_template_versions_one_active_key" ON "workflow_template_versions" ("template_id")
  WHERE "status" = 'ACTIVE';
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_version_positive" CHECK ("version" > 0);
ALTER TABLE "workflow_template_stages" ADD CONSTRAINT "workflow_template_stages_values"
  CHECK ("sequence" >= 0 AND ("expected_duration_minutes" IS NULL OR "expected_duration_minutes" > 0));
ALTER TABLE "workflow_template_stage_dependencies" ADD CONSTRAINT "workflow_template_stage_dependencies_no_self"
  CHECK ("stage_id" <> "depends_on_stage_id");

-- A workflow version is only editable while DRAFT; ACTIVE -> ARCHIVED is one-way.
CREATE OR REPLACE FUNCTION workflow_template_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow template versions are never deleted';
  END IF;
  IF NEW.template_id <> OLD.template_id OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'workflow template version identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE') OR (OLD.status = 'ACTIVE' AND NEW.status = 'ARCHIVED')
       OR (OLD.status = 'DRAFT' AND NEW.status = 'ARCHIVED')) THEN
    RAISE EXCEPTION 'invalid workflow version status change % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'DRAFT' AND NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'a % workflow version is immutable', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_template_versions_guard BEFORE UPDATE OR DELETE ON "workflow_template_versions"
  FOR EACH ROW EXECUTE FUNCTION workflow_template_versions_guard();

CREATE OR REPLACE FUNCTION workflow_template_stages_guard() RETURNS trigger AS $$
DECLARE
  vid uuid := COALESCE(NEW.version_id, OLD.version_id);
  vstatus "WorkflowVersionStatus";
BEGIN
  SELECT status INTO vstatus FROM "workflow_template_versions" WHERE id = vid;
  IF vstatus IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'stages of a non-draft workflow version are immutable (jobs depend on them)';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_template_stages_guard BEFORE INSERT OR UPDATE OR DELETE ON "workflow_template_stages"
  FOR EACH ROW EXECUTE FUNCTION workflow_template_stages_guard();

CREATE OR REPLACE FUNCTION workflow_template_stage_dependencies_guard() RETURNS trigger AS $$
DECLARE
  sid uuid := COALESCE(NEW.stage_id, OLD.stage_id);
  did uuid := COALESCE(NEW.depends_on_stage_id, OLD.depends_on_stage_id);
  v1 uuid; v2 uuid;
  vstatus "WorkflowVersionStatus";
BEGIN
  SELECT version_id INTO v1 FROM "workflow_template_stages" WHERE id = sid;
  SELECT version_id INTO v2 FROM "workflow_template_stages" WHERE id = did;
  IF v1 IS DISTINCT FROM v2 THEN
    RAISE EXCEPTION 'a stage can only depend on a stage of the same workflow version';
  END IF;
  SELECT status INTO vstatus FROM "workflow_template_versions" WHERE id = v1;
  IF vstatus IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'dependencies of a non-draft workflow version are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_template_stage_dependencies_guard BEFORE INSERT OR DELETE ON "workflow_template_stage_dependencies"
  FOR EACH ROW EXECUTE FUNCTION workflow_template_stage_dependencies_guard();

-- ---- job stages ----
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_values"
  CHECK ("attempt" >= 1 AND "sequence" >= 0 AND ("expected_duration_minutes" IS NULL OR "expected_duration_minutes" > 0));
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_blocked_consistent"
  CHECK (("status" = 'BLOCKED') = ("blocked_from_status" IS NOT NULL));
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_hold_consistent"
  CHECK ("is_on_hold" = ("hold_reason" IS NOT NULL));
ALTER TABLE "job_stage_dependencies" ADD CONSTRAINT "job_stage_dependencies_no_self"
  CHECK ("job_stage_id" <> "depends_on_job_stage_id");

CREATE OR REPLACE FUNCTION job_stages_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'job stages are never deleted';
  END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.stage_definition_id <> OLD.stage_definition_id
     OR NEW.sequence <> OLD.sequence OR NEW.attempt <> OLD.attempt
     OR NEW.stage_code <> OLD.stage_code OR NEW.template_stage_id IS DISTINCT FROM OLD.template_stage_id THEN
    RAISE EXCEPTION 'job stage identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'WAITING' AND NEW.status IN ('READY', 'SKIPPED', 'CANCELLED'))
    OR (OLD.status = 'READY' AND NEW.status IN ('IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'SKIPPED', 'CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'))
    OR (OLD.status = 'BLOCKED' AND NEW.status IN ('READY', 'IN_PROGRESS', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'invalid job stage status change % -> %', OLD.status, NEW.status;
  END IF;
  IF (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'stage timestamps are set once and never changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER job_stages_guard BEFORE UPDATE OR DELETE ON "job_stages"
  FOR EACH ROW EXECUTE FUNCTION job_stages_guard();

-- ---- assignments / blockers ----
CREATE UNIQUE INDEX "stage_assignments_active_key" ON "stage_assignments" ("job_stage_id", "user_id") WHERE "removed_at" IS NULL;
CREATE UNIQUE INDEX "stage_assignments_one_primary_key" ON "stage_assignments" ("job_stage_id") WHERE "is_primary" AND "removed_at" IS NULL;
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_resolution_consistent" CHECK (
  ("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL)
  AND ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));
CREATE OR REPLACE FUNCTION blockers_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'blockers are never deleted';
  END IF;
  IF OLD.status <> 'OPEN' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % blocker cannot change status', OLD.status;
  END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.job_stage_id IS DISTINCT FROM OLD.job_stage_id
     OR NEW.type <> OLD.type OR NEW.description <> OLD.description THEN
    RAISE EXCEPTION 'blocker identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER blockers_guard BEFORE UPDATE OR DELETE ON "blockers"
  FOR EACH ROW EXECUTE FUNCTION blockers_guard();

-- ---- rework ----
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_status_consistent" CHECK (
  ("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL) AND ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));

-- ---- QC ----
CREATE UNIQUE INDEX "qc_templates_one_active_per_stage_key" ON "qc_templates" ("stage_definition_id") WHERE "is_active";
CREATE UNIQUE INDEX "qc_inspections_one_live_per_stage_key" ON "qc_inspections" ("job_stage_id")
  WHERE "status" IN ('IN_PROGRESS', 'COMPLETED');
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_completion_consistent" CHECK (
  ("status" = 'COMPLETED') = ("overall_result" IS NOT NULL AND "completed_at" IS NOT NULL));

-- template content is immutable; only activation may change
CREATE OR REPLACE FUNCTION qc_templates_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'qc_templates are never deleted';
  END IF;
  IF NEW.code <> OLD.code OR NEW.version <> OLD.version OR NEW.name <> OLD.name
     OR NEW.stage_definition_id <> OLD.stage_definition_id THEN
    RAISE EXCEPTION 'QC template content is immutable; publish a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qc_templates_guard BEFORE UPDATE OR DELETE ON "qc_templates"
  FOR EACH ROW EXECUTE FUNCTION qc_templates_guard();
CREATE TRIGGER qc_checklist_items_immutable BEFORE UPDATE OR DELETE ON "qc_checklist_item_definitions"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

-- a finished inspection and its results never change
CREATE OR REPLACE FUNCTION qc_inspections_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'qc_inspections are never deleted';
  END IF;
  IF OLD.status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'a % QC inspection is final', OLD.status;
  END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.job_stage_id <> OLD.job_stage_id
     OR NEW.qc_template_id <> OLD.qc_template_id OR NEW.inspector_user_id <> OLD.inspector_user_id THEN
    RAISE EXCEPTION 'QC inspection identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qc_inspections_guard BEFORE UPDATE OR DELETE ON "qc_inspections"
  FOR EACH ROW EXECUTE FUNCTION qc_inspections_guard();

CREATE OR REPLACE FUNCTION qc_inspection_results_guard() RETURNS trigger AS $$
DECLARE
  iid uuid := COALESCE(NEW.inspection_id, OLD.inspection_id);
  istatus "QcInspectionStatus";
BEGIN
  SELECT status INTO istatus FROM "qc_inspections" WHERE id = iid;
  IF istatus IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'results of a finished QC inspection are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qc_inspection_results_guard BEFORE INSERT OR UPDATE OR DELETE ON "qc_inspection_results"
  FOR EACH ROW EXECUTE FUNCTION qc_inspection_results_guard();

-- ---- operational timeline is append-only ----
CREATE TRIGGER job_activities_append_only BEFORE UPDATE OR DELETE ON "job_activities"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
