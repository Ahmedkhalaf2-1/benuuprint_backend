-- Phase 4.1: the factory manufactures the physical sample BEFORE final customer approval.
-- Job sources are renamed to say what they produce; specifications gain a kind.

ALTER TYPE "FactoryJobSourceType" RENAME VALUE 'SAMPLE' TO 'SAMPLE_PRODUCTION';
ALTER TYPE "FactoryJobSourceType" RENAME VALUE 'ORDER' TO 'BULK_ORDER';

CREATE TYPE "SampleSpecKind" AS ENUM ('PRE_PRODUCTION', 'APPROVED_REFERENCE');
-- every spec frozen before this migration was created at customer approval
ALTER TABLE "sample_production_specs" ADD COLUMN "kind" "SampleSpecKind" NOT NULL DEFAULT 'APPROVED_REFERENCE';
CREATE INDEX "sample_production_specs_sample_id_kind_idx" ON "sample_production_specs"("sample_id", "kind");

-- A SAMPLE_PRODUCTION job can only be built from a PRE_PRODUCTION specification (never the final reference).
CREATE OR REPLACE FUNCTION factory_jobs_spec_kind_guard() RETURNS trigger AS $$
DECLARE spec_kind "SampleSpecKind";
BEGIN
  SELECT "kind" INTO spec_kind FROM "sample_production_specs" WHERE "id" = NEW."sample_production_spec_id";
  IF NEW."source_type" = 'SAMPLE_PRODUCTION' AND spec_kind IS DISTINCT FROM 'PRE_PRODUCTION' THEN
    RAISE EXCEPTION 'a SAMPLE_PRODUCTION job must pin a PRE_PRODUCTION specification';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER factory_jobs_spec_kind_guard BEFORE INSERT ON "factory_jobs"
  FOR EACH ROW EXECUTE FUNCTION factory_jobs_spec_kind_guard();
