-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PRODUCTION', 'IN_PRODUCTION', 'AWAITING_APPROVAL', 'APPROVED', 'COMPLETED', 'ON_HOLD', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FabricProvider" AS ENUM ('CUSTOMER', 'BENUE_PRINT', 'NOT_DECIDED');

-- CreateEnum
CREATE TYPE "FitMethod" AS ENUM ('BENUE_PATTERN', 'COPY_CUSTOMER_PIECE', 'CUSTOM_SIZE_CHART', 'NOT_SURE');

-- CreateEnum
CREATE TYPE "DecorationSide" AS ENUM ('FRONT', 'BACK', 'LEFT_SLEEVE', 'RIGHT_SLEEVE', 'OTHER');

-- CreateEnum
CREATE TYPE "MeasurementUnit" AS ENUM ('CM', 'MM', 'IN');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "TransitionSource" AS ENUM ('STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NoteVisibility" AS ENUM ('INTERNAL', 'CUSTOMER_VISIBLE');

-- CreateEnum
CREATE TYPE "TermsAcceptanceMode" AS ENUM ('STAFF_RECORDED_ON_BEHALF', 'CUSTOMER_AUTHENTICATED');

-- CreateEnum
CREATE TYPE "ArtworkPurpose" AS ENUM ('FRONT_PRINT', 'BACK_PRINT', 'EMBROIDERY', 'LABEL', 'PACKAGING', 'GENERAL_REFERENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "ArtworkVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "QuotationLineType" AS ENUM ('SAMPLE_FEE', 'PATTERN_FEE', 'PRINTING', 'EMBROIDERY', 'DESIGN_SERVICE', 'FABRIC', 'ACCESSORIES', 'PACKAGING', 'DISCOUNT_ADJUSTMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('QUOTATION', 'ARTWORK', 'SAMPLE', 'PRODUCTION_SPEC');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('CUSTOMER_AUTHENTICATED', 'STAFF_RECORDED_ON_BEHALF', 'STAFF_INTERNAL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('INSTAPAY', 'VODAFONE_CASH', 'TELDA', 'BANK_TRANSFER', 'CASH', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "asset_attachments" ADD COLUMN     "sample_id" UUID;

-- CreateTable
CREATE TABLE "samples" (
    "id" UUID NOT NULL,
    "sample_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "status" "SampleStatus" NOT NULL DEFAULT 'DRAFT',
    "hold_previous_status" "SampleStatus",
    "revision_number" INTEGER NOT NULL DEFAULT 1,
    "revision_of_id" UUID,
    "product_type_id" UUID,
    "custom_product_name" TEXT,
    "custom_product_description" TEXT,
    "fabric_id" UUID,
    "custom_fabric_name" TEXT,
    "custom_fabric_description" TEXT,
    "fabric_color_id" UUID,
    "custom_color_name" TEXT,
    "custom_pantone" TEXT,
    "custom_hex" TEXT,
    "fabric_provider" "FabricProvider" NOT NULL DEFAULT 'NOT_DECIDED',
    "gsm" INTEGER,
    "sample_size_option_id" UUID,
    "fit_method" "FitMethod" NOT NULL DEFAULT 'NOT_SURE',
    "pattern_version_id" UUID,
    "notes" TEXT,
    "fit_notes" TEXT,
    "print_notes" TEXT,
    "fabric_notes" TEXT,
    "special_instructions" TEXT,
    "factory_instructions" TEXT,
    "payment_state" "PaymentState" NOT NULL DEFAULT 'UNPAID',
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by_staff_user_id" UUID,
    "assigned_sales_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_status_history" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "from_status" "SampleStatus",
    "to_status" "SampleStatus" NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "actor_user_id" UUID,
    "source" "TransitionSource" NOT NULL DEFAULT 'STAFF',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_decorations" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "print_method_id" UUID NOT NULL,
    "placement" TEXT NOT NULL,
    "side" "DecorationSide" NOT NULL DEFAULT 'FRONT',
    "width" DECIMAL(7,2),
    "height" DECIMAL(7,2),
    "unit" "MeasurementUnit",
    "color_count" INTEGER,
    "notes" TEXT,
    "artwork_required" BOOLEAN NOT NULL DEFAULT false,
    "artwork_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sample_decorations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_accessories" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "accessory_id" UUID,
    "custom_name" TEXT,
    "quantity" INTEGER,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sample_accessories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_components" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "component_option_id" UUID,
    "custom_name" TEXT,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sample_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_notes" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "visibility" "NoteVisibility" NOT NULL DEFAULT 'INTERNAL',
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "sample_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms_versions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_terms_acceptances" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "terms_version_id" UUID NOT NULL,
    "mode" "TermsAcceptanceMode" NOT NULL,
    "accepted_by_customer_id" UUID NOT NULL,
    "recorded_by_staff_user_id" UUID,
    "source_note" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sample_terms_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artworks" (
    "id" UUID NOT NULL,
    "brand_id" UUID,
    "sample_id" UUID,
    "name" TEXT NOT NULL,
    "purpose" "ArtworkPurpose" NOT NULL DEFAULT 'GENERAL_REFERENCE',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "artworks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artwork_versions" (
    "id" UUID NOT NULL,
    "artwork_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "ArtworkVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "asset_id" UUID NOT NULL,
    "notes" TEXT,
    "rejection_reason" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "rejected_at" TIMESTAMP(3),
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "artwork_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "quotation_number" TEXT NOT NULL,
    "sample_id" UUID NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EGP',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_versions" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "valid_until" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "quotation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_line_items" (
    "id" UUID NOT NULL,
    "quotation_version_id" UUID NOT NULL,
    "type" "QuotationLineType" NOT NULL DEFAULT 'OTHER',
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "quotation_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "sample_id" UUID NOT NULL,
    "quotation_version_id" UUID,
    "artwork_version_id" UUID,
    "production_spec_id" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "ApprovalMode",
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "responded_by_user_id" UUID,
    "responded_by_customer_id" UUID,
    "response_note" TEXT,
    "source_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "payment_number" TEXT NOT NULL,
    "sample_id" UUID NOT NULL,
    "quotation_version_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'SUBMITTED',
    "transaction_reference" TEXT,
    "proof_asset_id" UUID,
    "received_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "verified_by_user_id" UUID,
    "rejection_reason" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_production_specs" (
    "id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "approval_id" UUID,
    "spec_hash" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB NOT NULL,
    "customer_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "product_type_id" UUID,
    "fabric_id" UUID,
    "fabric_color_id" UUID,
    "pattern_version_id" UUID,
    "sample_size_option_id" UUID,
    "quotation_version_id" UUID,
    "terms_version_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_production_specs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "samples_sample_number_key" ON "samples"("sample_number");

-- CreateIndex
CREATE INDEX "samples_customer_id_idx" ON "samples"("customer_id");

-- CreateIndex
CREATE INDEX "samples_brand_id_idx" ON "samples"("brand_id");

-- CreateIndex
CREATE INDEX "samples_status_idx" ON "samples"("status");

-- CreateIndex
CREATE INDEX "samples_assigned_sales_user_id_idx" ON "samples"("assigned_sales_user_id");

-- CreateIndex
CREATE INDEX "samples_product_type_id_idx" ON "samples"("product_type_id");

-- CreateIndex
CREATE INDEX "samples_fabric_id_idx" ON "samples"("fabric_id");

-- CreateIndex
CREATE INDEX "samples_created_at_idx" ON "samples"("created_at");

-- CreateIndex
CREATE INDEX "samples_submitted_at_idx" ON "samples"("submitted_at");

-- CreateIndex
CREATE INDEX "samples_payment_state_idx" ON "samples"("payment_state");

-- CreateIndex
CREATE INDEX "samples_revision_of_id_idx" ON "samples"("revision_of_id");

-- CreateIndex
CREATE INDEX "sample_status_history_sample_id_created_at_idx" ON "sample_status_history"("sample_id", "created_at");

-- CreateIndex
CREATE INDEX "sample_decorations_sample_id_idx" ON "sample_decorations"("sample_id");

-- CreateIndex
CREATE INDEX "sample_decorations_print_method_id_idx" ON "sample_decorations"("print_method_id");

-- CreateIndex
CREATE INDEX "sample_decorations_artwork_id_idx" ON "sample_decorations"("artwork_id");

-- CreateIndex
CREATE INDEX "sample_accessories_sample_id_idx" ON "sample_accessories"("sample_id");

-- CreateIndex
CREATE INDEX "sample_accessories_accessory_id_idx" ON "sample_accessories"("accessory_id");

-- CreateIndex
CREATE INDEX "sample_components_sample_id_idx" ON "sample_components"("sample_id");

-- CreateIndex
CREATE UNIQUE INDEX "sample_components_sample_id_component_option_id_key" ON "sample_components"("sample_id", "component_option_id");

-- CreateIndex
CREATE INDEX "sample_notes_sample_id_created_at_idx" ON "sample_notes"("sample_id", "created_at");

-- CreateIndex
CREATE INDEX "terms_versions_code_is_active_idx" ON "terms_versions"("code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "terms_versions_code_version_key" ON "terms_versions"("code", "version");

-- CreateIndex
CREATE INDEX "sample_terms_acceptances_terms_version_id_idx" ON "sample_terms_acceptances"("terms_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "sample_terms_acceptances_sample_id_terms_version_id_key" ON "sample_terms_acceptances"("sample_id", "terms_version_id");

-- CreateIndex
CREATE INDEX "artworks_brand_id_idx" ON "artworks"("brand_id");

-- CreateIndex
CREATE INDEX "artworks_sample_id_idx" ON "artworks"("sample_id");

-- CreateIndex
CREATE INDEX "artwork_versions_asset_id_idx" ON "artwork_versions"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "artwork_versions_artwork_id_version_number_key" ON "artwork_versions"("artwork_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_quotation_number_key" ON "quotations"("quotation_number");

-- CreateIndex
CREATE INDEX "quotations_sample_id_idx" ON "quotations"("sample_id");

-- CreateIndex
CREATE INDEX "quotations_status_idx" ON "quotations"("status");

-- CreateIndex
CREATE INDEX "quotation_versions_status_idx" ON "quotation_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_versions_quotation_id_version_number_key" ON "quotation_versions"("quotation_id", "version_number");

-- CreateIndex
CREATE INDEX "quotation_line_items_quotation_version_id_idx" ON "quotation_line_items"("quotation_version_id");

-- CreateIndex
CREATE INDEX "approvals_sample_id_idx" ON "approvals"("sample_id");

-- CreateIndex
CREATE INDEX "approvals_type_idx" ON "approvals"("type");

-- CreateIndex
CREATE INDEX "approvals_status_idx" ON "approvals"("status");

-- CreateIndex
CREATE INDEX "approvals_quotation_version_id_idx" ON "approvals"("quotation_version_id");

-- CreateIndex
CREATE INDEX "approvals_artwork_version_id_idx" ON "approvals"("artwork_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_payment_number_key" ON "payments"("payment_number");

-- CreateIndex
CREATE INDEX "payments_sample_id_idx" ON "payments"("sample_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_quotation_version_id_idx" ON "payments"("quotation_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "sample_production_specs_approval_id_key" ON "sample_production_specs"("approval_id");

-- CreateIndex
CREATE UNIQUE INDEX "sample_production_specs_sample_id_revision_key" ON "sample_production_specs"("sample_id", "revision");

-- CreateIndex
CREATE INDEX "asset_attachments_sample_id_idx" ON "asset_attachments"("sample_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_sample_id_key" ON "asset_attachments"("asset_id", "sample_id");

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_fabric_id_fkey" FOREIGN KEY ("fabric_id") REFERENCES "fabrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_fabric_color_id_fkey" FOREIGN KEY ("fabric_color_id") REFERENCES "fabric_colors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_sample_size_option_id_fkey" FOREIGN KEY ("sample_size_option_id") REFERENCES "size_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_pattern_version_id_fkey" FOREIGN KEY ("pattern_version_id") REFERENCES "pattern_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_assigned_sales_user_id_fkey" FOREIGN KEY ("assigned_sales_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "samples" ADD CONSTRAINT "samples_revision_of_id_fkey" FOREIGN KEY ("revision_of_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_status_history" ADD CONSTRAINT "sample_status_history_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_decorations" ADD CONSTRAINT "sample_decorations_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_decorations" ADD CONSTRAINT "sample_decorations_print_method_id_fkey" FOREIGN KEY ("print_method_id") REFERENCES "print_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_decorations" ADD CONSTRAINT "sample_decorations_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_accessories" ADD CONSTRAINT "sample_accessories_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_accessories" ADD CONSTRAINT "sample_accessories_accessory_id_fkey" FOREIGN KEY ("accessory_id") REFERENCES "accessories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_components" ADD CONSTRAINT "sample_components_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_components" ADD CONSTRAINT "sample_components_component_option_id_fkey" FOREIGN KEY ("component_option_id") REFERENCES "component_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_notes" ADD CONSTRAINT "sample_notes_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_notes" ADD CONSTRAINT "sample_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_terms_acceptances" ADD CONSTRAINT "sample_terms_acceptances_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_terms_acceptances" ADD CONSTRAINT "sample_terms_acceptances_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "terms_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_terms_acceptances" ADD CONSTRAINT "sample_terms_acceptances_accepted_by_customer_id_fkey" FOREIGN KEY ("accepted_by_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_versions" ADD CONSTRAINT "artwork_versions_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_versions" ADD CONSTRAINT "artwork_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_line_items" ADD CONSTRAINT "quotation_line_items_quotation_version_id_fkey" FOREIGN KEY ("quotation_version_id") REFERENCES "quotation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_quotation_version_id_fkey" FOREIGN KEY ("quotation_version_id") REFERENCES "quotation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_artwork_version_id_fkey" FOREIGN KEY ("artwork_version_id") REFERENCES "artwork_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_production_spec_id_fkey" FOREIGN KEY ("production_spec_id") REFERENCES "sample_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_quotation_version_id_fkey" FOREIGN KEY ("quotation_version_id") REFERENCES "quotation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_proof_asset_id_fkey" FOREIGN KEY ("proof_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_production_specs" ADD CONSTRAINT "sample_production_specs_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_production_specs" ADD CONSTRAINT "sample_production_specs_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written constraints and guards Prisma cannot express
-- ===========================================================================

-- ---- assets: an attachment targets exactly one entity (now including samples) ----
ALTER TABLE "asset_attachments" DROP CONSTRAINT "asset_attachments_exactly_one_target";
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_exactly_one_target"
  CHECK (num_nonnulls("customer_id", "brand_id", "fabric_id", "pattern_version_id", "product_type_id", "print_method_id", "sample_id") = 1);

-- ---- samples ----
ALTER TABLE "samples" ADD CONSTRAINT "samples_product_present_unless_draft"
  CHECK ("status" = 'DRAFT' OR "product_type_id" IS NOT NULL OR "custom_product_name" IS NOT NULL);
ALTER TABLE "samples" ADD CONSTRAINT "samples_product_exclusive"
  CHECK (NOT ("product_type_id" IS NOT NULL AND "custom_product_name" IS NOT NULL));
ALTER TABLE "samples" ADD CONSTRAINT "samples_fabric_exclusive"
  CHECK (NOT ("fabric_id" IS NOT NULL AND "custom_fabric_name" IS NOT NULL));
ALTER TABLE "samples" ADD CONSTRAINT "samples_color_exclusive"
  CHECK (NOT ("fabric_color_id" IS NOT NULL AND ("custom_color_name" IS NOT NULL OR "custom_pantone" IS NOT NULL OR "custom_hex" IS NOT NULL)));
ALTER TABLE "samples" ADD CONSTRAINT "samples_pattern_only_for_benue_pattern"
  CHECK ("pattern_version_id" IS NULL OR "fit_method" = 'BENUE_PATTERN');
ALTER TABLE "samples" ADD CONSTRAINT "samples_gsm_positive" CHECK ("gsm" IS NULL OR "gsm" > 0);
ALTER TABLE "samples" ADD CONSTRAINT "samples_hold_previous_matches_status"
  CHECK (("status" = 'ON_HOLD') = ("hold_previous_status" IS NOT NULL));

-- sample number and owning customer never change after creation
CREATE OR REPLACE FUNCTION samples_identity_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.sample_number <> OLD.sample_number THEN
    RAISE EXCEPTION 'samples.sample_number is immutable';
  END IF;
  IF NEW.customer_id <> OLD.customer_id THEN
    RAISE EXCEPTION 'samples.customer_id is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER samples_identity_guard BEFORE UPDATE ON "samples"
  FOR EACH ROW EXECUTE FUNCTION samples_identity_guard();

-- ---- append-only tables ----
CREATE OR REPLACE FUNCTION block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sample_status_history_append_only BEFORE UPDATE OR DELETE ON "sample_status_history"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER sample_terms_acceptances_append_only BEFORE UPDATE OR DELETE ON "sample_terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER sample_production_specs_append_only BEFORE UPDATE OR DELETE ON "sample_production_specs"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

ALTER TABLE "sample_production_specs" ADD CONSTRAINT "sample_production_specs_revision_positive" CHECK ("revision" > 0);

-- ---- sample parts ----
ALTER TABLE "sample_decorations" ADD CONSTRAINT "sample_decorations_unit_with_size"
  CHECK (("width" IS NULL AND "height" IS NULL) OR "unit" IS NOT NULL);
ALTER TABLE "sample_decorations" ADD CONSTRAINT "sample_decorations_positive_size"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0) AND ("color_count" IS NULL OR "color_count" > 0));
ALTER TABLE "sample_accessories" ADD CONSTRAINT "sample_accessories_master_xor_custom"
  CHECK (("accessory_id" IS NOT NULL) <> ("custom_name" IS NOT NULL));
ALTER TABLE "sample_accessories" ADD CONSTRAINT "sample_accessories_quantity_positive"
  CHECK ("quantity" IS NULL OR "quantity" > 0);
ALTER TABLE "sample_components" ADD CONSTRAINT "sample_components_master_xor_custom"
  CHECK (("component_option_id" IS NOT NULL) <> ("custom_name" IS NOT NULL));

-- ---- terms ----
-- one active version per terms code
CREATE UNIQUE INDEX "terms_versions_one_active_per_code_key" ON "terms_versions" ("code") WHERE "is_active";
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_version_positive" CHECK ("version" > 0);
-- the legal text itself never changes; only activation does
CREATE OR REPLACE FUNCTION terms_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'terms_versions are never deleted';
  END IF;
  IF NEW.code <> OLD.code OR NEW.version <> OLD.version OR NEW.title <> OLD.title
     OR NEW.content <> OLD.content OR NEW.effective_at <> OLD.effective_at THEN
    RAISE EXCEPTION 'terms version content is immutable; publish a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER terms_versions_guard BEFORE UPDATE OR DELETE ON "terms_versions"
  FOR EACH ROW EXECUTE FUNCTION terms_versions_guard();

-- ---- artwork ----
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_exactly_one_owner" CHECK (num_nonnulls("brand_id", "sample_id") = 1);
-- at most one APPROVED version per artwork, enforced under concurrency by the database
CREATE UNIQUE INDEX "artwork_versions_one_approved_key" ON "artwork_versions" ("artwork_id") WHERE "status" = 'APPROVED';
CREATE OR REPLACE FUNCTION artwork_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'artwork_versions are never deleted';
  END IF;
  IF NEW.artwork_id <> OLD.artwork_id OR NEW.version_number <> OLD.version_number OR NEW.asset_id <> OLD.asset_id THEN
    RAISE EXCEPTION 'artwork version identity and file are immutable';
  END IF;
  IF OLD.status IN ('SUPERSEDED', 'REJECTED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % artwork version cannot change status', OLD.status;
  END IF;
  IF OLD.status = 'APPROVED' AND NEW.status NOT IN ('APPROVED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'an approved artwork version can only be superseded';
  END IF;
  IF OLD.status = 'APPROVED' AND NEW.status = 'APPROVED'
     AND (NEW.notes IS DISTINCT FROM OLD.notes OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
          OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id) THEN
    RAISE EXCEPTION 'an approved artwork version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER artwork_versions_guard BEFORE UPDATE OR DELETE ON "artwork_versions"
  FOR EACH ROW EXECUTE FUNCTION artwork_versions_guard();

-- ---- quotations ----
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_money_consistent"
  CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "discount" <= "subtotal" AND "tax" >= 0
         AND "tax_percent" >= 0 AND "tax_percent" <= 100
         AND "total" = "subtotal" - "discount" + "tax");
-- only one live (draft / sent / accepted) version per quotation: the latest one
CREATE UNIQUE INDEX "quotation_versions_one_live_key" ON "quotation_versions" ("quotation_id")
  WHERE "status" IN ('DRAFT', 'SENT', 'ACCEPTED');
ALTER TABLE "quotation_line_items" ADD CONSTRAINT "quotation_line_items_amounts"
  CHECK ("quantity" > 0 AND ("type" = 'DISCOUNT_ADJUSTMENT' OR "unit_price" >= 0));

CREATE OR REPLACE FUNCTION quotation_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quotation_versions are never deleted';
  END IF;
  IF NEW.quotation_id <> OLD.quotation_id OR NEW.version_number <> OLD.version_number THEN
    RAISE EXCEPTION 'quotation version identity is immutable';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.subtotal <> OLD.subtotal OR NEW.discount <> OLD.discount OR NEW.tax_percent <> OLD.tax_percent
       OR NEW.tax <> OLD.tax OR NEW.total <> OLD.total
       OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.valid_until IS DISTINCT FROM OLD.valid_until) THEN
    RAISE EXCEPTION 'a % quotation version is immutable; create a new version', OLD.status;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('SENT', 'SUPERSEDED'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'))) THEN
    RAISE EXCEPTION 'invalid quotation version status change % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER quotation_versions_guard BEFORE UPDATE OR DELETE ON "quotation_versions"
  FOR EACH ROW EXECUTE FUNCTION quotation_versions_guard();

CREATE OR REPLACE FUNCTION quotation_line_items_guard() RETURNS trigger AS $$
DECLARE
  version_id uuid := COALESCE(NEW.quotation_version_id, OLD.quotation_version_id);
  current_status "QuotationStatus";
BEGIN
  SELECT status INTO current_status FROM "quotation_versions" WHERE id = version_id;
  IF current_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'line items of a non-draft quotation version are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER quotation_line_items_guard BEFORE INSERT OR UPDATE OR DELETE ON "quotation_line_items"
  FOR EACH ROW EXECUTE FUNCTION quotation_line_items_guard();

-- ---- approvals ----
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_target_matches_type" CHECK (
     ("type" = 'QUOTATION' AND "quotation_version_id" IS NOT NULL AND "artwork_version_id" IS NULL AND "production_spec_id" IS NULL)
  OR ("type" = 'ARTWORK' AND "artwork_version_id" IS NOT NULL AND "quotation_version_id" IS NULL AND "production_spec_id" IS NULL)
  OR ("type" = 'PRODUCTION_SPEC' AND "production_spec_id" IS NOT NULL AND "quotation_version_id" IS NULL AND "artwork_version_id" IS NULL)
  OR ("type" = 'SAMPLE' AND "quotation_version_id" IS NULL AND "artwork_version_id" IS NULL AND "production_spec_id" IS NULL));
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_response_complete" CHECK (
  "status" IN ('PENDING', 'CANCELLED', 'EXPIRED') OR ("responded_at" IS NOT NULL AND "mode" IS NOT NULL));
-- at most one pending approval per target
CREATE UNIQUE INDEX "approvals_one_pending_quotation_key" ON "approvals" ("quotation_version_id") WHERE "status" = 'PENDING' AND "quotation_version_id" IS NOT NULL;
CREATE UNIQUE INDEX "approvals_one_pending_artwork_key" ON "approvals" ("artwork_version_id") WHERE "status" = 'PENDING' AND "artwork_version_id" IS NOT NULL;
CREATE UNIQUE INDEX "approvals_one_pending_spec_key" ON "approvals" ("production_spec_id") WHERE "status" = 'PENDING' AND "production_spec_id" IS NOT NULL;
CREATE UNIQUE INDEX "approvals_one_pending_sample_key" ON "approvals" ("sample_id") WHERE "status" = 'PENDING' AND "type" = 'SAMPLE';
CREATE OR REPLACE FUNCTION approvals_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals are never deleted';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a % approval is final', OLD.status;
  END IF;
  IF NEW.type <> OLD.type OR NEW.sample_id <> OLD.sample_id
     OR NEW.quotation_version_id IS DISTINCT FROM OLD.quotation_version_id
     OR NEW.artwork_version_id IS DISTINCT FROM OLD.artwork_version_id
     OR NEW.production_spec_id IS DISTINCT FROM OLD.production_spec_id THEN
    RAISE EXCEPTION 'approval target is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approvals_guard BEFORE UPDATE OR DELETE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION approvals_guard();

-- ---- payments ----
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_verification_complete" CHECK (
  ("status" = 'VERIFIED') = ("verified_at" IS NOT NULL AND "verified_by_user_id" IS NOT NULL)
  AND ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL));
-- a proof file proves one payment only
CREATE UNIQUE INDEX "payments_proof_asset_key" ON "payments" ("proof_asset_id") WHERE "proof_asset_id" IS NOT NULL;
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments are never deleted';
  END IF;
  IF OLD.status IN ('VERIFIED', 'REJECTED', 'CANCELLED') AND (
       NEW.status <> OLD.status OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
       OR NEW.method <> OLD.method OR NEW.sample_id <> OLD.sample_id
       OR NEW.proof_asset_id IS DISTINCT FROM OLD.proof_asset_id
       OR NEW.transaction_reference IS DISTINCT FROM OLD.transaction_reference
       OR NEW.quotation_version_id IS DISTINCT FROM OLD.quotation_version_id
       OR NEW.received_at IS DISTINCT FROM OLD.received_at) THEN
    RAISE EXCEPTION 'a % payment is final', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION payments_guard();
