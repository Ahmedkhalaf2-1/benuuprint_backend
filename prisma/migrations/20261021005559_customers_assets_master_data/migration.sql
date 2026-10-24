-- CreateEnum
CREATE TYPE "UserTokenType" AS ENUM ('INVITATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'LEAD', 'INACTIVE', 'BLOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BrandStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('OWNER', 'PRODUCTION', 'FINANCE', 'SHIPPING', 'OTHER');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('BILLING', 'SHIPPING', 'PICKUP', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('LOGO', 'ARTWORK', 'MOCKUP', 'REFERENCE', 'SIZE_CHART', 'PATTERN', 'FABRIC_SWATCH', 'PAYMENT_PROOF', 'QC_PHOTO', 'TECH_PACK', 'LABEL', 'PACKAGING_REFERENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('TOPS', 'BOTTOMS', 'OUTERWEAR', 'HEADWEAR', 'DRESSES', 'OTHER');

-- CreateEnum
CREATE TYPE "PatternStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PatternVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PrintMethodType" AS ENUM ('PRINT', 'EMBROIDERY', 'OTHER');

-- CreateEnum
CREATE TYPE "ComponentCategory" AS ENUM ('LABEL', 'PACKAGING', 'OTHER');

-- CreateTable
CREATE TABLE "reference_sequences" (
    "prefix" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_sequences_pkey" PRIMARY KEY ("prefix")
);

-- CreateTable
CREATE TABLE "seed_grant_batches" (
    "key" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_grant_batches_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "user_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "UserTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "customer_number" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "country" TEXT,
    "city" TEXT,
    "instagram" TEXT,
    "source" TEXT,
    "notes" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "brand_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "instagram" TEXT,
    "website" TEXT,
    "description" TEXT,
    "primary_color" TEXT,
    "secondary_color" TEXT,
    "status" "BrandStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "role" "ContactRole" NOT NULL DEFAULT 'OTHER',
    "name" TEXT NOT NULL,
    "job_title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "AddressType" NOT NULL DEFAULT 'SHIPPING',
    "country" TEXT NOT NULL,
    "state" TEXT,
    "city" TEXT NOT NULL,
    "area" TEXT,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "postal_code" TEXT,
    "notes" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "type" "AssetType" NOT NULL,
    "original_name" TEXT NOT NULL,
    "description" TEXT,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_provider" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum" TEXT,
    "uploaded_by_staff_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_attachments" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "customer_id" UUID,
    "brand_id" UUID,
    "fabric_id" UUID,
    "pattern_version_id" UUID,
    "product_type_id" UUID,
    "print_method_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "ProductCategory",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "default_sample_fee" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "product_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fabrics" (
    "id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "composition" TEXT,
    "min_gsm" INTEGER,
    "max_gsm" INTEGER,
    "default_gsm" INTEGER,
    "unit" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "fabrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fabric_colors" (
    "id" UUID NOT NULL,
    "fabric_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "internal_code" TEXT,
    "hex" TEXT,
    "pantone" TEXT,
    "swatch_asset_id" UUID,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "fabric_colors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_type_fabrics" (
    "product_type_id" UUID NOT NULL,
    "fabric_id" UUID NOT NULL,
    "is_recommended" BOOLEAN NOT NULL DEFAULT false,
    "is_allowed" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_type_fabrics_pkey" PRIMARY KEY ("product_type_id","fabric_id")
);

-- CreateTable
CREATE TABLE "patterns" (
    "id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "product_type_id" UUID NOT NULL,
    "description" TEXT,
    "fit_type" TEXT,
    "status" "PatternStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "current_version_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pattern_versions" (
    "id" UUID NOT NULL,
    "pattern_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "PatternVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pattern_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_scales" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "size_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_options" (
    "id" UUID NOT NULL,
    "scale_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "size_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_methods" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PrintMethodType" NOT NULL DEFAULT 'PRINT',
    "description" TEXT,
    "min_quantity" INTEGER,
    "max_colors" INTEGER,
    "supports_full_color" BOOLEAN NOT NULL DEFAULT false,
    "setup_fee" DECIMAL(12,2),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "print_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accessories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "unit" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "accessories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component_options" (
    "id" UUID NOT NULL,
    "category" "ComponentCategory" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "component_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_tokens_user_id_type_idx" ON "user_tokens"("user_id", "type");

-- CreateIndex
CREATE INDEX "user_tokens_expires_at_idx" ON "user_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_customer_number_key" ON "customers"("customer_number");

-- CreateIndex
CREATE INDEX "customers_email_idx" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_whatsapp_idx" ON "customers"("whatsapp");

-- CreateIndex
CREATE INDEX "customers_status_idx" ON "customers"("status");

-- CreateIndex
CREATE INDEX "customers_created_at_idx" ON "customers"("created_at");

-- CreateIndex
CREATE INDEX "customers_display_name_idx" ON "customers"("display_name");

-- CreateIndex
CREATE UNIQUE INDEX "brands_brand_number_key" ON "brands"("brand_number");

-- CreateIndex
CREATE INDEX "brands_customer_id_idx" ON "brands"("customer_id");

-- CreateIndex
CREATE INDEX "brands_name_idx" ON "brands"("name");

-- CreateIndex
CREATE INDEX "brands_status_idx" ON "brands"("status");

-- CreateIndex
CREATE INDEX "customer_contacts_customer_id_idx" ON "customer_contacts"("customer_id");

-- CreateIndex
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_storage_key_key" ON "assets"("storage_key");

-- CreateIndex
CREATE INDEX "assets_type_idx" ON "assets"("type");

-- CreateIndex
CREATE INDEX "assets_uploaded_by_staff_user_id_idx" ON "assets"("uploaded_by_staff_user_id");

-- CreateIndex
CREATE INDEX "assets_created_at_idx" ON "assets"("created_at");

-- CreateIndex
CREATE INDEX "asset_attachments_customer_id_idx" ON "asset_attachments"("customer_id");

-- CreateIndex
CREATE INDEX "asset_attachments_brand_id_idx" ON "asset_attachments"("brand_id");

-- CreateIndex
CREATE INDEX "asset_attachments_fabric_id_idx" ON "asset_attachments"("fabric_id");

-- CreateIndex
CREATE INDEX "asset_attachments_pattern_version_id_idx" ON "asset_attachments"("pattern_version_id");

-- CreateIndex
CREATE INDEX "asset_attachments_product_type_id_idx" ON "asset_attachments"("product_type_id");

-- CreateIndex
CREATE INDEX "asset_attachments_print_method_id_idx" ON "asset_attachments"("print_method_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_customer_id_key" ON "asset_attachments"("asset_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_brand_id_key" ON "asset_attachments"("asset_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_fabric_id_key" ON "asset_attachments"("asset_id", "fabric_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_pattern_version_id_key" ON "asset_attachments"("asset_id", "pattern_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_product_type_id_key" ON "asset_attachments"("asset_id", "product_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_attachments_asset_id_print_method_id_key" ON "asset_attachments"("asset_id", "print_method_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_types_code_key" ON "product_types"("code");

-- CreateIndex
CREATE INDEX "product_types_name_idx" ON "product_types"("name");

-- CreateIndex
CREATE INDEX "product_types_is_active_idx" ON "product_types"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "fabrics_reference_number_key" ON "fabrics"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "fabrics_code_key" ON "fabrics"("code");

-- CreateIndex
CREATE INDEX "fabrics_name_idx" ON "fabrics"("name");

-- CreateIndex
CREATE INDEX "fabrics_is_active_idx" ON "fabrics"("is_active");

-- CreateIndex
CREATE INDEX "fabric_colors_fabric_id_idx" ON "fabric_colors"("fabric_id");

-- CreateIndex
CREATE INDEX "fabric_colors_swatch_asset_id_idx" ON "fabric_colors"("swatch_asset_id");

-- CreateIndex
CREATE INDEX "product_type_fabrics_fabric_id_idx" ON "product_type_fabrics"("fabric_id");

-- CreateIndex
CREATE UNIQUE INDEX "patterns_reference_number_key" ON "patterns"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "patterns_code_key" ON "patterns"("code");

-- CreateIndex
CREATE UNIQUE INDEX "patterns_current_version_id_key" ON "patterns"("current_version_id");

-- CreateIndex
CREATE INDEX "patterns_product_type_id_idx" ON "patterns"("product_type_id");

-- CreateIndex
CREATE INDEX "patterns_status_idx" ON "patterns"("status");

-- CreateIndex
CREATE INDEX "patterns_name_idx" ON "patterns"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pattern_versions_pattern_id_version_number_key" ON "pattern_versions"("pattern_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "size_scales_code_key" ON "size_scales"("code");

-- CreateIndex
CREATE UNIQUE INDEX "size_options_scale_id_code_key" ON "size_options"("scale_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "print_methods_code_key" ON "print_methods"("code");

-- CreateIndex
CREATE INDEX "print_methods_name_idx" ON "print_methods"("name");

-- CreateIndex
CREATE INDEX "print_methods_is_active_idx" ON "print_methods"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "accessories_code_key" ON "accessories"("code");

-- CreateIndex
CREATE INDEX "accessories_name_idx" ON "accessories"("name");

-- CreateIndex
CREATE INDEX "accessories_is_active_idx" ON "accessories"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "component_options_code_key" ON "component_options"("code");

-- CreateIndex
CREATE INDEX "component_options_category_idx" ON "component_options"("category");

-- CreateIndex
CREATE INDEX "component_options_is_active_idx" ON "component_options"("is_active");

-- AddForeignKey
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_staff_user_id_fkey" FOREIGN KEY ("uploaded_by_staff_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_fabric_id_fkey" FOREIGN KEY ("fabric_id") REFERENCES "fabrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_pattern_version_id_fkey" FOREIGN KEY ("pattern_version_id") REFERENCES "pattern_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_print_method_id_fkey" FOREIGN KEY ("print_method_id") REFERENCES "print_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fabric_colors" ADD CONSTRAINT "fabric_colors_fabric_id_fkey" FOREIGN KEY ("fabric_id") REFERENCES "fabrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fabric_colors" ADD CONSTRAINT "fabric_colors_swatch_asset_id_fkey" FOREIGN KEY ("swatch_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_type_fabrics" ADD CONSTRAINT "product_type_fabrics_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_type_fabrics" ADD CONSTRAINT "product_type_fabrics_fabric_id_fkey" FOREIGN KEY ("fabric_id") REFERENCES "fabrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patterns" ADD CONSTRAINT "patterns_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patterns" ADD CONSTRAINT "patterns_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "pattern_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pattern_versions" ADD CONSTRAINT "pattern_versions_pattern_id_fkey" FOREIGN KEY ("pattern_id") REFERENCES "patterns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_options" ADD CONSTRAINT "size_options_scale_id_fkey" FOREIGN KEY ("scale_id") REFERENCES "size_scales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma cannot express
-- ---------------------------------------------------------------------------

-- A customer cannot have two live brands with the same name (case-insensitive).
CREATE UNIQUE INDEX "brands_customer_id_lower_name_live_key"
  ON "brands" ("customer_id", lower("name")) WHERE "archived_at" IS NULL;

-- A fabric cannot offer two live colours with the same name.
CREATE UNIQUE INDEX "fabric_colors_fabric_id_lower_name_live_key"
  ON "fabric_colors" ("fabric_id", lower("name")) WHERE "archived_at" IS NULL;

-- At most one primary contact per customer, one default address per customer and type.
CREATE UNIQUE INDEX "customer_contacts_one_primary_key"
  ON "customer_contacts" ("customer_id") WHERE "is_primary" AND "archived_at" IS NULL;
CREATE UNIQUE INDEX "customer_addresses_one_default_per_type_key"
  ON "customer_addresses" ("customer_id", "type") WHERE "is_default" AND "archived_at" IS NULL;

-- An attachment targets exactly one entity.
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_exactly_one_target"
  CHECK (num_nonnulls("customer_id", "brand_id", "fabric_id", "pattern_version_id", "product_type_id", "print_method_id") = 1);

ALTER TABLE "fabrics" ADD CONSTRAINT "fabrics_gsm_range_check"
  CHECK (("min_gsm" IS NULL OR "max_gsm" IS NULL OR "min_gsm" <= "max_gsm")
     AND ("min_gsm" IS NULL OR "min_gsm" > 0)
     AND ("default_gsm" IS NULL OR "default_gsm" > 0));

ALTER TABLE "assets" ADD CONSTRAINT "assets_size_positive_check" CHECK ("size_bytes" > 0);

-- Existing Phase 1 databases already have their default role grants: mark that
-- baseline applied so the seed does not re-add permissions admins removed.
INSERT INTO "seed_grant_batches" ("key", "applied_at")
SELECT 'phase1-initial', now() WHERE EXISTS (SELECT 1 FROM "roles");
