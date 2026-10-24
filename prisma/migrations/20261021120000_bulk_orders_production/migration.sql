
-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'READY_FOR_PRODUCTION', 'IN_PRODUCTION', 'PARTIALLY_COMPLETED', 'PRODUCTION_COMPLETED', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderBatchStatus" AS ENUM ('PLANNED', 'READY', 'IN_PRODUCTION', 'PARTIALLY_COMPLETED', 'COMPLETED', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderActivityType" AS ENUM ('ORDER_CREATED', 'ORDER_UPDATED', 'ORDER_SUBMITTED', 'ORDER_CONFIRMED', 'ORDER_REVISED', 'PRODUCTION_READY', 'PRODUCTION_STARTED', 'BATCH_CREATED', 'BATCH_UPDATED', 'BATCH_STARTED', 'PRODUCTION_COMPLETED', 'ORDER_HELD', 'ORDER_RESUMED', 'ORDER_CANCELLED', 'PRIORITY_CHANGED', 'JOB_CREATED', 'REORDER_CREATED');

-- AlterEnum
ALTER TYPE "JobActivityType" ADD VALUE 'QUANTITY_REPORTED';

-- AlterTable
ALTER TABLE "factory_jobs" ADD COLUMN     "completed_quantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "order_batch_id" UUID,
ADD COLUMN     "order_id" UUID,
ADD COLUMN     "order_production_spec_id" UUID,
ADD COLUMN     "planned_quantity" INTEGER,
ADD COLUMN     "rejected_quantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "qc_inspections" ADD COLUMN     "failed_quantity" INTEGER,
ADD COLUMN     "inspected_quantity" INTEGER,
ADD COLUMN     "passed_quantity" INTEGER;

-- AlterTable
ALTER TABLE "rework_records" ADD COLUMN     "affected_quantity" INTEGER;

-- AlterTable
ALTER TABLE "sample_production_specs" ADD COLUMN     "source_factory_job_id" UUID;

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "source_sample_id" UUID NOT NULL,
    "approved_production_spec_id" UUID NOT NULL,
    "reorder_of_order_id" UUID,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "revision_number" INTEGER NOT NULL DEFAULT 0,
    "current_spec_id" UUID,
    "target_delivery_date" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "production_start_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "hold_reason" TEXT,
    "held_at" TIMESTAMP(3),
    "hold_previous_status" "OrderStatus",
    "assigned_sales_user_id" UUID,
    "internal_notes" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "approved_production_spec_id" UUID NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "product_type_id" UUID,
    "quantity" INTEGER NOT NULL,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_variants" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "size_option_id" UUID,
    "custom_size_name" TEXT,
    "fabric_color_id" UUID,
    "custom_color_name" TEXT,
    "pantone" TEXT,
    "hex" TEXT,
    "quantity" INTEGER NOT NULL,
    "completed_quantity" INTEGER NOT NULL DEFAULT 0,
    "rejected_quantity" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_production_specs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "approved_production_spec_id" UUID NOT NULL,
    "total_quantity" INTEGER NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_production_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_revisions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "previous_snapshot" JSONB NOT NULL,
    "spec_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_batches" (
    "id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "OrderBatchStatus" NOT NULL DEFAULT 'PLANNED',
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "target_start_date" TIMESTAMP(3),
    "target_completion_date" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "hold_reason" TEXT,
    "hold_previous_status" "OrderBatchStatus",
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_batch_variants" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "order_variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_batch_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_activities" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "type" "OrderActivityType" NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_production_reports" (
    "id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "produced_quantity" INTEGER NOT NULL DEFAULT 0,
    "rejected_quantity" INTEGER NOT NULL DEFAULT 0,
    "rework_quantity" INTEGER NOT NULL DEFAULT 0,
    "order_variant_id" UUID,
    "notes" TEXT,
    "reported_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_production_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- CreateIndex
CREATE INDEX "orders_brand_id_idx" ON "orders"("brand_id");

-- CreateIndex
CREATE INDEX "orders_source_sample_id_idx" ON "orders"("source_sample_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_priority_idx" ON "orders"("priority");

-- CreateIndex
CREATE INDEX "orders_assigned_sales_user_id_idx" ON "orders"("assigned_sales_user_id");

-- CreateIndex
CREATE INDEX "orders_target_delivery_date_idx" ON "orders"("target_delivery_date");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "orders_reorder_of_order_id_idx" ON "orders"("reorder_of_order_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_variants_order_item_id_idx" ON "order_variants"("order_item_id");

-- CreateIndex
CREATE INDEX "order_variants_size_option_id_idx" ON "order_variants"("size_option_id");

-- CreateIndex
CREATE INDEX "order_variants_fabric_color_id_idx" ON "order_variants"("fabric_color_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_production_specs_order_id_revision_key" ON "order_production_specs"("order_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "order_revisions_spec_id_key" ON "order_revisions"("spec_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_revisions_order_id_revision_number_key" ON "order_revisions"("order_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "order_batches_batch_number_key" ON "order_batches"("batch_number");

-- CreateIndex
CREATE INDEX "order_batches_order_id_idx" ON "order_batches"("order_id");

-- CreateIndex
CREATE INDEX "order_batches_status_idx" ON "order_batches"("status");

-- CreateIndex
CREATE INDEX "order_batch_variants_order_variant_id_idx" ON "order_batch_variants"("order_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_batch_variants_batch_id_order_variant_id_key" ON "order_batch_variants"("batch_id", "order_variant_id");

-- CreateIndex
CREATE INDEX "order_activities_order_id_created_at_idx" ON "order_activities"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "stage_production_reports_job_stage_id_idx" ON "stage_production_reports"("job_stage_id");

-- CreateIndex
CREATE INDEX "stage_production_reports_order_variant_id_idx" ON "stage_production_reports"("order_variant_id");

-- CreateIndex
CREATE INDEX "factory_jobs_order_id_idx" ON "factory_jobs"("order_id");

-- CreateIndex
CREATE INDEX "factory_jobs_order_batch_id_idx" ON "factory_jobs"("order_batch_id");

-- CreateIndex
CREATE INDEX "sample_production_specs_source_factory_job_id_idx" ON "sample_production_specs"("source_factory_job_id");

-- AddForeignKey
ALTER TABLE "sample_production_specs" ADD CONSTRAINT "sample_production_specs_source_factory_job_id_fkey" FOREIGN KEY ("source_factory_job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_order_batch_id_fkey" FOREIGN KEY ("order_batch_id") REFERENCES "order_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_order_production_spec_id_fkey" FOREIGN KEY ("order_production_spec_id") REFERENCES "order_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_sample_id_fkey" FOREIGN KEY ("source_sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_approved_production_spec_id_fkey" FOREIGN KEY ("approved_production_spec_id") REFERENCES "sample_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_reorder_of_order_id_fkey" FOREIGN KEY ("reorder_of_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_approved_production_spec_id_fkey" FOREIGN KEY ("approved_production_spec_id") REFERENCES "sample_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_variants" ADD CONSTRAINT "order_variants_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_production_specs" ADD CONSTRAINT "order_production_specs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_production_specs" ADD CONSTRAINT "order_production_specs_approved_production_spec_id_fkey" FOREIGN KEY ("approved_production_spec_id") REFERENCES "sample_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_spec_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "order_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_batches" ADD CONSTRAINT "order_batches_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_batch_variants" ADD CONSTRAINT "order_batch_variants_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "order_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_batch_variants" ADD CONSTRAINT "order_batch_variants_order_variant_id_fkey" FOREIGN KEY ("order_variant_id") REFERENCES "order_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_activities" ADD CONSTRAINT "order_activities_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_production_reports" ADD CONSTRAINT "stage_production_reports_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_production_reports" ADD CONSTRAINT "stage_production_reports_order_variant_id_fkey" FOREIGN KEY ("order_variant_id") REFERENCES "order_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════ Phase 5A hand-written guards ═══════════════════════

-- ---- factory job sources: exactly the right source columns for each job type ----
ALTER TABLE "factory_jobs" DROP CONSTRAINT "factory_jobs_source_matches_type";
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_source_matches_type" CHECK (
  ("source_type" = 'SAMPLE_PRODUCTION' AND "sample_id" IS NOT NULL AND "order_id" IS NULL AND "order_batch_id" IS NULL
     AND "order_production_spec_id" IS NULL AND "planned_quantity" IS NULL)
  OR ("source_type" = 'BULK_ORDER' AND "sample_id" IS NULL AND "order_id" IS NOT NULL AND "order_batch_id" IS NULL
     AND "order_production_spec_id" IS NOT NULL AND "planned_quantity" IS NOT NULL)
  OR ("source_type" = 'ORDER_BATCH' AND "sample_id" IS NULL AND "order_id" IS NOT NULL AND "order_batch_id" IS NOT NULL
     AND "order_production_spec_id" IS NOT NULL AND "planned_quantity" IS NOT NULL));
ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_quantities" CHECK (
  ("planned_quantity" IS NULL OR "planned_quantity" > 0) AND "completed_quantity" >= 0 AND "rejected_quantity" >= 0);

-- one (non-cancelled) job per order for whole-order production, one per batch for batch production
CREATE UNIQUE INDEX "factory_jobs_one_bulk_per_order_key" ON "factory_jobs" ("order_id")
  WHERE "source_type" = 'BULK_ORDER' AND "status" <> 'CANCELLED';
CREATE UNIQUE INDEX "factory_jobs_one_job_per_batch_key" ON "factory_jobs" ("order_batch_id")
  WHERE "order_batch_id" IS NOT NULL AND "status" <> 'CANCELLED';

-- immutable source columns (extends the Phase 4 guard)
CREATE OR REPLACE FUNCTION factory_jobs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'factory_jobs are never deleted';
  END IF;
  IF NEW.job_number <> OLD.job_number OR NEW.source_type <> OLD.source_type
     OR NEW.sample_id IS DISTINCT FROM OLD.sample_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.order_batch_id IS DISTINCT FROM OLD.order_batch_id
     OR NEW.order_production_spec_id IS DISTINCT FROM OLD.order_production_spec_id
     OR NEW.planned_quantity IS DISTINCT FROM OLD.planned_quantity
     OR NEW.sample_production_spec_id <> OLD.sample_production_spec_id
     OR NEW.workflow_template_version_id <> OLD.workflow_template_version_id
     OR NEW.customer_id <> OLD.customer_id OR NEW.brand_id <> OLD.brand_id
     OR NEW.product_type_id IS DISTINCT FROM OLD.product_type_id
     OR NEW.product_name <> OLD.product_name OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
    RAISE EXCEPTION 'a factory job''s source, specification, quantity and workflow version are immutable';
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

-- Sample production pins a PRE_PRODUCTION spec; bulk jobs pin the APPROVED_REFERENCE and its frozen order spec.
CREATE OR REPLACE FUNCTION factory_jobs_spec_kind_guard() RETURNS trigger AS $$
DECLARE
  spec_kind "SampleSpecKind";
  ord_spec_ref uuid;
  ord_spec_order uuid;
  batch_order uuid;
BEGIN
  SELECT "kind" INTO spec_kind FROM "sample_production_specs" WHERE "id" = NEW."sample_production_spec_id";
  IF NEW."source_type" = 'SAMPLE_PRODUCTION' THEN
    IF spec_kind IS DISTINCT FROM 'PRE_PRODUCTION' THEN
      RAISE EXCEPTION 'a SAMPLE_PRODUCTION job must pin a PRE_PRODUCTION specification';
    END IF;
    RETURN NEW;
  END IF;
  IF spec_kind IS DISTINCT FROM 'APPROVED_REFERENCE' THEN
    RAISE EXCEPTION 'a bulk job must pin an APPROVED_REFERENCE specification, never a pre-production one';
  END IF;
  SELECT "approved_production_spec_id", "order_id" INTO ord_spec_ref, ord_spec_order
    FROM "order_production_specs" WHERE "id" = NEW."order_production_spec_id";
  IF ord_spec_ref IS DISTINCT FROM NEW."sample_production_spec_id" OR ord_spec_order IS DISTINCT FROM NEW."order_id" THEN
    RAISE EXCEPTION 'the order production spec must belong to the job''s order and its approved reference';
  END IF;
  IF NEW."source_type" = 'ORDER_BATCH' THEN
    SELECT "order_id" INTO batch_order FROM "order_batches" WHERE "id" = NEW."order_batch_id";
    IF batch_order IS DISTINCT FROM NEW."order_id" THEN
      RAISE EXCEPTION 'the batch does not belong to the job''s order';
    END IF;
  END IF;
  -- whole-order and per-batch production never overlap
  IF NEW."source_type" = 'ORDER_BATCH' AND EXISTS (
       SELECT 1 FROM "factory_jobs" WHERE "order_id" = NEW."order_id" AND "source_type" = 'BULK_ORDER' AND "status" <> 'CANCELLED') THEN
    RAISE EXCEPTION 'the order already runs as a whole-order job';
  END IF;
  IF NEW."source_type" = 'BULK_ORDER' AND EXISTS (
       SELECT 1 FROM "factory_jobs" WHERE "order_id" = NEW."order_id" AND "source_type" = 'ORDER_BATCH' AND "status" <> 'CANCELLED') THEN
    RAISE EXCEPTION 'the order already runs as batch jobs';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- orders ----
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_consistent" CHECK (
  ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR "cancellation_reason" IS NOT NULL)
  AND ("status" <> 'ON_HOLD' OR ("hold_reason" IS NOT NULL AND "hold_previous_status" IS NOT NULL))
  AND "revision_number" >= 0);

CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger AS $$
DECLARE
  spec_kind "SampleSpecKind";
  spec_sample uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "kind", "sample_id" INTO spec_kind, spec_sample
      FROM "sample_production_specs" WHERE "id" = NEW."approved_production_spec_id";
    IF spec_kind IS DISTINCT FROM 'APPROVED_REFERENCE' THEN
      RAISE EXCEPTION 'an order must pin an APPROVED_REFERENCE specification';
    END IF;
    IF spec_sample IS DISTINCT FROM NEW."source_sample_id" THEN
      RAISE EXCEPTION 'the approved reference does not belong to the order''s source sample';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.order_number <> OLD.order_number OR NEW.customer_id <> OLD.customer_id OR NEW.brand_id <> OLD.brand_id
     OR NEW.source_sample_id <> OLD.source_sample_id
     OR NEW.approved_production_spec_id <> OLD.approved_production_spec_id
     OR NEW.reorder_of_order_id IS DISTINCT FROM OLD.reorder_of_order_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
    RAISE EXCEPTION 'an order''s number, parties, source sample and approved reference are immutable';
  END IF;
  IF OLD.status = 'CANCELLED' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a cancelled order cannot change status';
  END IF;
  IF (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'order timestamps are set once and never changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER orders_guard BEFORE INSERT OR UPDATE OR DELETE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION orders_guard();

-- items always belong to the order's approved reference
CREATE OR REPLACE FUNCTION order_items_guard() RETURNS trigger AS $$
DECLARE order_spec uuid;
BEGIN
  SELECT "approved_production_spec_id" INTO order_spec FROM "orders" WHERE "id" = NEW."order_id";
  IF order_spec IS DISTINCT FROM NEW."approved_production_spec_id" THEN
    RAISE EXCEPTION 'an order item must use the order''s approved reference';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER order_items_guard BEFORE INSERT ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION order_items_guard();
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity" CHECK ("quantity" >= 0);

-- variants: positive quantities, size / colour either catalogue or custom
ALTER TABLE "order_variants" ADD CONSTRAINT "order_variants_values" CHECK (
  "quantity" > 0 AND "completed_quantity" >= 0 AND "rejected_quantity" >= 0
  AND ("size_option_id" IS NULL OR "custom_size_name" IS NULL)
  AND ("fabric_color_id" IS NULL OR "custom_color_name" IS NULL));

-- ---- batches ----
ALTER TABLE "order_batches" ADD CONSTRAINT "order_batches_values" CHECK (
  "quantity" >= 0
  AND ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
  AND ("status" <> 'ON_HOLD' OR ("hold_reason" IS NOT NULL AND "hold_previous_status" IS NOT NULL)));
ALTER TABLE "order_batch_variants" ADD CONSTRAINT "order_batch_variants_quantity" CHECK ("quantity" > 0);

-- A batch can never hold more of a variant than the order has left. The variant row is locked first,
-- so two concurrent allocations are serialised and the second sees the first.
CREATE OR REPLACE FUNCTION order_batch_variants_guard() RETURNS trigger AS $$
DECLARE
  variant_qty int;
  variant_order uuid;
  batch_order uuid;
  allocated int;
BEGIN
  SELECT v."quantity", i."order_id" INTO variant_qty, variant_order
    FROM "order_variants" v JOIN "order_items" i ON i."id" = v."order_item_id"
    WHERE v."id" = NEW."order_variant_id" FOR UPDATE OF v;
  SELECT "order_id" INTO batch_order FROM "order_batches" WHERE "id" = NEW."batch_id";
  IF variant_order IS DISTINCT FROM batch_order THEN
    RAISE EXCEPTION 'the variant does not belong to the batch''s order';
  END IF;
  SELECT COALESCE(SUM(bv."quantity"), 0) INTO allocated
    FROM "order_batch_variants" bv JOIN "order_batches" b ON b."id" = bv."batch_id"
    WHERE bv."order_variant_id" = NEW."order_variant_id" AND b."status" <> 'CANCELLED'
      AND bv."id" <> NEW."id";
  IF allocated + NEW."quantity" > variant_qty THEN
    RAISE EXCEPTION 'over-allocation: % of % units already allocated, % more requested', allocated, variant_qty, NEW."quantity";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER order_batch_variants_guard BEFORE INSERT OR UPDATE ON "order_batch_variants"
  FOR EACH ROW EXECUTE FUNCTION order_batch_variants_guard();

-- a variant cannot shrink below what batches already hold
CREATE OR REPLACE FUNCTION order_variants_shrink_guard() RETURNS trigger AS $$
DECLARE allocated int;
BEGIN
  IF NEW."quantity" < OLD."quantity" THEN
    SELECT COALESCE(SUM(bv."quantity"), 0) INTO allocated
      FROM "order_batch_variants" bv JOIN "order_batches" b ON b."id" = bv."batch_id"
      WHERE bv."order_variant_id" = NEW."id" AND b."status" <> 'CANCELLED';
    IF NEW."quantity" < allocated THEN
      RAISE EXCEPTION 'variant quantity % is below the % units already allocated to batches', NEW."quantity", allocated;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER order_variants_shrink_guard BEFORE UPDATE ON "order_variants"
  FOR EACH ROW EXECUTE FUNCTION order_variants_shrink_guard();

-- ---- append-only records ----
CREATE TRIGGER order_production_specs_immutable BEFORE UPDATE OR DELETE ON "order_production_specs"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER order_revisions_immutable BEFORE UPDATE OR DELETE ON "order_revisions"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER order_activities_immutable BEFORE UPDATE OR DELETE ON "order_activities"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER stage_production_reports_immutable BEFORE UPDATE OR DELETE ON "stage_production_reports"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

-- ---- quantities on stages, QC and rework ----
ALTER TABLE "stage_production_reports" ADD CONSTRAINT "stage_production_reports_values" CHECK (
  "produced_quantity" >= 0 AND "rejected_quantity" >= 0 AND "rework_quantity" >= 0
  AND ("produced_quantity" + "rejected_quantity" + "rework_quantity") > 0);
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_affected_quantity" CHECK ("affected_quantity" IS NULL OR "affected_quantity" > 0);
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_quantities" CHECK (
  ("inspected_quantity" IS NULL AND "passed_quantity" IS NULL AND "failed_quantity" IS NULL)
  OR ("inspected_quantity" IS NOT NULL AND "passed_quantity" IS NOT NULL AND "failed_quantity" IS NOT NULL
      AND "inspected_quantity" > 0 AND "passed_quantity" >= 0 AND "failed_quantity" >= 0
      AND "passed_quantity" + "failed_quantity" = "inspected_quantity"));

-- ---- approved reference ↔ the sample job that built the physical sample ----
-- (the spec rows are append-only, so the link is written at insert time)
ALTER TABLE "sample_production_specs" ADD CONSTRAINT "sample_production_specs_source_job_only_on_reference"
  CHECK ("source_factory_job_id" IS NULL OR "kind" = 'APPROVED_REFERENCE');
