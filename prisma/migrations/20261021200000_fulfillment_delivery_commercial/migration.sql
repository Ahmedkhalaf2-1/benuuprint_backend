
-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DRAFT', 'READY', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('OWN_DELIVERY', 'COURIER', 'CUSTOMER_PICKUP');

-- AlterEnum
ALTER TYPE "AssetType" ADD VALUE 'DELIVERY_PROOF';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderActivityType" ADD VALUE 'PACKAGING_STARTED';
ALTER TYPE "OrderActivityType" ADD VALUE 'PACKAGING_COMPLETED';
ALTER TYPE "OrderActivityType" ADD VALUE 'SHIPMENT_CREATED';
ALTER TYPE "OrderActivityType" ADD VALUE 'SHIPMENT_READY';
ALTER TYPE "OrderActivityType" ADD VALUE 'SHIPMENT_DISPATCHED';
ALTER TYPE "OrderActivityType" ADD VALUE 'SHIPMENT_FAILED';
ALTER TYPE "OrderActivityType" ADD VALUE 'SHIPMENT_RETURNED';
ALTER TYPE "OrderActivityType" ADD VALUE 'SHIPMENT_DELIVERED';
ALTER TYPE "OrderActivityType" ADD VALUE 'ORDER_DELIVERED';
ALTER TYPE "OrderActivityType" ADD VALUE 'ORDER_COMPLETED';
ALTER TYPE "OrderActivityType" ADD VALUE 'QUOTATION_SENT';
ALTER TYPE "OrderActivityType" ADD VALUE 'QUOTATION_ACCEPTED';
ALTER TYPE "OrderActivityType" ADD VALUE 'PAYMENT_VERIFIED';
ALTER TYPE "OrderActivityType" ADD VALUE 'TRACKING_UPDATED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'READY_FOR_PACKAGING';
ALTER TYPE "OrderStatus" ADD VALUE 'PACKAGING';
ALTER TYPE "OrderStatus" ADD VALUE 'READY_FOR_DELIVERY';
ALTER TYPE "OrderStatus" ADD VALUE 'PARTIALLY_SHIPPED';
ALTER TYPE "OrderStatus" ADD VALUE 'OUT_FOR_DELIVERY';
ALTER TYPE "OrderStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "OrderStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_state" "PaymentState" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "order_id" UUID,
ALTER COLUMN "sample_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "quotation_versions" ADD COLUMN     "decided_by_user_id" UUID,
ADD COLUMN     "decision_note" TEXT;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "order_id" UUID,
ALTER COLUMN "sample_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "order_packaging_specs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "folding_instructions" TEXT,
    "polybag_required" BOOLEAN NOT NULL DEFAULT false,
    "labels_required" BOOLEAN NOT NULL DEFAULT false,
    "hang_tags_required" BOOLEAN NOT NULL DEFAULT false,
    "stickers_required" BOOLEAN NOT NULL DEFAULT false,
    "sticker_notes" TEXT,
    "units_per_carton" INTEGER,
    "carton_notes" TEXT,
    "special_instructions" TEXT,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_packaging_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_packaging_components" (
    "id" UUID NOT NULL,
    "packaging_spec_id" UUID NOT NULL,
    "component_option_id" UUID,
    "custom_name" TEXT,
    "quantity_per_unit" INTEGER,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_packaging_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packaging_reports" (
    "id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "stage_report_id" UUID NOT NULL,
    "packed_quantity" INTEGER NOT NULL,
    "damaged_quantity" INTEGER NOT NULL DEFAULT 0,
    "carton_count" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "reported_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "packaging_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "shipment_number" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "delivery_method" "DeliveryMethod" NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "recipient_phone" TEXT NOT NULL,
    "address_snapshot" JSONB NOT NULL,
    "customer_address_id" UUID,
    "courier_name" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "in_transit_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "return_reason" TEXT,
    "cancel_reason" TEXT,
    "proof_asset_id" UUID,
    "notes" TEXT,
    "delivery_notes" TEXT,
    "assigned_delivery_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_lines" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_tracking_tokens" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_tracking_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_packaging_specs_order_id_key" ON "order_packaging_specs"("order_id");

-- CreateIndex
CREATE INDEX "order_packaging_components_packaging_spec_id_idx" ON "order_packaging_components"("packaging_spec_id");

-- CreateIndex
CREATE INDEX "order_packaging_components_component_option_id_idx" ON "order_packaging_components"("component_option_id");

-- CreateIndex
CREATE UNIQUE INDEX "packaging_reports_stage_report_id_key" ON "packaging_reports"("stage_report_id");

-- CreateIndex
CREATE INDEX "packaging_reports_job_stage_id_idx" ON "packaging_reports"("job_stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_shipment_number_key" ON "shipments"("shipment_number");

-- CreateIndex
CREATE INDEX "shipments_order_id_idx" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "shipments"("status");

-- CreateIndex
CREATE INDEX "shipments_assigned_delivery_user_id_idx" ON "shipments"("assigned_delivery_user_id");

-- CreateIndex
CREATE INDEX "shipments_tracking_number_idx" ON "shipments"("tracking_number");

-- CreateIndex
CREATE INDEX "shipments_created_at_idx" ON "shipments"("created_at");

-- CreateIndex
CREATE INDEX "shipment_lines_shipment_id_idx" ON "shipment_lines"("shipment_id");

-- CreateIndex
CREATE INDEX "shipment_lines_order_variant_id_idx" ON "shipment_lines"("order_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_lines_shipment_id_order_variant_id_key" ON "shipment_lines"("shipment_id", "order_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_tracking_tokens_token_hash_key" ON "order_tracking_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "order_tracking_tokens_order_id_idx" ON "order_tracking_tokens"("order_id");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "quotations_order_id_idx" ON "quotations"("order_id");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_packaging_specs" ADD CONSTRAINT "order_packaging_specs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_packaging_components" ADD CONSTRAINT "order_packaging_components_packaging_spec_id_fkey" FOREIGN KEY ("packaging_spec_id") REFERENCES "order_packaging_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_packaging_components" ADD CONSTRAINT "order_packaging_components_component_option_id_fkey" FOREIGN KEY ("component_option_id") REFERENCES "component_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_reports" ADD CONSTRAINT "packaging_reports_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_reports" ADD CONSTRAINT "packaging_reports_stage_report_id_fkey" FOREIGN KEY ("stage_report_id") REFERENCES "stage_production_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_proof_asset_id_fkey" FOREIGN KEY ("proof_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_order_variant_id_fkey" FOREIGN KEY ("order_variant_id") REFERENCES "order_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_tracking_tokens" ADD CONSTRAINT "order_tracking_tokens_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════ Phase 5B hand-written guards ═══════════════════════

-- ---- commercial documents target a sample XOR an order ----
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_exactly_one_target"
  CHECK (num_nonnulls("sample_id", "order_id") = 1);
ALTER TABLE "payments" ADD CONSTRAINT "payments_exactly_one_target"
  CHECK (num_nonnulls("sample_id", "order_id") = 1);
-- one live quotation per order at a time (samples keep their service-level rule)
CREATE UNIQUE INDEX "quotations_one_live_per_order_key" ON "quotations" ("order_id")
  WHERE "order_id" IS NOT NULL AND "status" IN ('DRAFT', 'SENT', 'ACCEPTED');

-- ---- orders: COMPLETED is terminal too ----
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
  IF OLD.status IN ('CANCELLED', 'COMPLETED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % order cannot change status', OLD.status;
  END IF;
  IF (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'order timestamps are set once and never changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- packaging ----
ALTER TABLE "order_packaging_specs" ADD CONSTRAINT "order_packaging_specs_values"
  CHECK ("units_per_carton" IS NULL OR "units_per_carton" > 0);
ALTER TABLE "order_packaging_components" ADD CONSTRAINT "order_packaging_components_one_name"
  CHECK (num_nonnulls("component_option_id", "custom_name") = 1
         AND ("quantity_per_unit" IS NULL OR "quantity_per_unit" > 0));
ALTER TABLE "packaging_reports" ADD CONSTRAINT "packaging_reports_values"
  CHECK ("packed_quantity" >= 0 AND "damaged_quantity" >= 0 AND "carton_count" >= 0
         AND ("packed_quantity" + "damaged_quantity") > 0);
CREATE TRIGGER packaging_reports_immutable BEFORE UPDATE OR DELETE ON "packaging_reports"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

-- ---- shipments ----
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_consistent" CHECK (
  length(btrim("recipient_name")) > 0 AND length(btrim("recipient_phone")) > 0
  AND ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL)
  AND ("status" <> 'FAILED' OR ("failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL))
  AND ("status" <> 'RETURNED' OR ("returned_at" IS NOT NULL AND "return_reason" IS NOT NULL))
  AND ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL))
  AND ("status" NOT IN ('DISPATCHED', 'IN_TRANSIT', 'DELIVERED') OR "dispatched_at" IS NOT NULL));

CREATE OR REPLACE FUNCTION shipments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipments are never deleted';
  END IF;
  IF NEW.shipment_number <> OLD.shipment_number OR NEW.order_id <> OLD.order_id
     OR NEW.address_snapshot IS DISTINCT FROM OLD.address_snapshot
     OR NEW.customer_address_id IS DISTINCT FROM OLD.customer_address_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
    RAISE EXCEPTION 'a shipment''s number, order and destination snapshot are immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('READY', 'CANCELLED'))
    OR (OLD.status = 'READY' AND NEW.status IN ('DISPATCHED', 'CANCELLED'))
    OR (OLD.status = 'DISPATCHED' AND NEW.status IN ('IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED'))
    OR (OLD.status = 'IN_TRANSIT' AND NEW.status IN ('DELIVERED', 'FAILED', 'RETURNED'))
    OR (OLD.status = 'FAILED' AND NEW.status IN ('DISPATCHED', 'RETURNED'))) THEN
    RAISE EXCEPTION 'invalid shipment status change % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('DELIVERED', 'RETURNED', 'CANCELLED') AND (
       NEW.proof_asset_id IS DISTINCT FROM OLD.proof_asset_id
    OR NEW.recipient_name <> OLD.recipient_name OR NEW.recipient_phone <> OLD.recipient_phone
    OR NEW.assigned_delivery_user_id IS DISTINCT FROM OLD.assigned_delivery_user_id) THEN
    RAISE EXCEPTION 'a % shipment is final', OLD.status;
  END IF;
  IF (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
     OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
     OR (OLD.returned_at IS NOT NULL AND NEW.returned_at IS DISTINCT FROM OLD.returned_at)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'shipment timestamps are set once and never changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER shipments_guard BEFORE UPDATE OR DELETE ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION shipments_guard();

ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_quantity" CHECK ("quantity" > 0);

-- Lines are only editable while the shipment is a DRAFT. Units can never be shipped twice:
-- the variant row is locked first, so concurrent allocations are serialised, and units on
-- cancelled or returned shipments are available again.
CREATE OR REPLACE FUNCTION shipment_lines_guard() RETURNS trigger AS $$
DECLARE
  ship_status "ShipmentStatus";
  ship_order uuid;
  variant_qty int;
  variant_order uuid;
  committed int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "status" INTO ship_status FROM "shipments" WHERE "id" = OLD."shipment_id";
    IF ship_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'shipment lines can only change while the shipment is DRAFT';
    END IF;
    RETURN OLD;
  END IF;
  SELECT "status", "order_id" INTO ship_status, ship_order FROM "shipments" WHERE "id" = NEW."shipment_id";
  IF ship_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'shipment lines can only change while the shipment is DRAFT';
  END IF;
  SELECT v."quantity", i."order_id" INTO variant_qty, variant_order
    FROM "order_variants" v JOIN "order_items" i ON i."id" = v."order_item_id"
    WHERE v."id" = NEW."order_variant_id" FOR UPDATE OF v;
  IF variant_order IS DISTINCT FROM ship_order THEN
    RAISE EXCEPTION 'the variant does not belong to the shipment''s order';
  END IF;
  SELECT COALESCE(SUM(l."quantity"), 0) INTO committed
    FROM "shipment_lines" l JOIN "shipments" s ON s."id" = l."shipment_id"
    WHERE l."order_variant_id" = NEW."order_variant_id" AND s."status" NOT IN ('CANCELLED', 'RETURNED')
      AND l."id" <> NEW."id";
  IF committed + NEW."quantity" > variant_qty THEN
    RAISE EXCEPTION 'over-shipping: % of % units already on shipments, % more requested', committed, variant_qty, NEW."quantity";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER shipment_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "shipment_lines"
  FOR EACH ROW EXECUTE FUNCTION shipment_lines_guard();

-- ---- tracking tokens: one active token per order; only revocation / last-use may change ----
CREATE UNIQUE INDEX "order_tracking_tokens_one_active_key" ON "order_tracking_tokens" ("order_id")
  WHERE "revoked_at" IS NULL;
CREATE OR REPLACE FUNCTION order_tracking_tokens_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tracking tokens are never deleted (revoke them)';
  END IF;
  IF NEW.token_hash <> OLD.token_hash OR NEW.order_id <> OLD.order_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a tracking token''s hash, order and expiry are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked token stays revoked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER order_tracking_tokens_guard BEFORE UPDATE OR DELETE ON "order_tracking_tokens"
  FOR EACH ROW EXECUTE FUNCTION order_tracking_tokens_guard();
