-- AlterEnum
ALTER TYPE "OrderActivityType" ADD VALUE 'COMMERCIAL_REAPPROVAL_REQUIRED';

-- AlterTable
ALTER TABLE "order_revisions" ADD COLUMN     "commercial_changes" JSONB,
ADD COLUMN     "commercial_impact" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "commercial_revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "quotation_versions" ADD COLUMN     "invalidated_at" TIMESTAMP(3),
ADD COLUMN     "invalidated_by_revision" INTEGER,
ADD COLUMN     "invalidation_reason" TEXT,
ADD COLUMN     "order_revision" INTEGER;


-- ═══════════════════════ Phase 5B.1 hand-written guards ═══════════════════════

-- versions that already exist priced the revision the order was at
UPDATE "quotation_versions" v SET "order_revision" = o."revision_number"
  FROM "quotations" q JOIN "orders" o ON o."id" = q."order_id"
  WHERE v."quotation_id" = q."id";

ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_invalidation_complete"
  CHECK (("invalidated_at" IS NULL) = ("invalidated_by_revision" IS NULL));
ALTER TABLE "orders" ADD CONSTRAINT "orders_commercial_revision_range"
  CHECK ("commercial_revision" >= 0 AND "commercial_revision" <= "revision_number");

-- An ACCEPTED version may only end through a recorded invalidation (order revision); its terms,
-- acceptance and decision stay untouched. The invalidation itself and the priced revision are write-once.
CREATE OR REPLACE FUNCTION quotation_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quotation_versions are never deleted';
  END IF;
  IF NEW.quotation_id <> OLD.quotation_id OR NEW.version_number <> OLD.version_number THEN
    RAISE EXCEPTION 'quotation version identity is immutable';
  END IF;
  IF NEW.order_revision IS DISTINCT FROM OLD.order_revision THEN
    RAISE EXCEPTION 'the order revision a quotation version priced is immutable';
  END IF;
  IF OLD.invalidated_at IS NOT NULL AND (
       NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at
       OR NEW.invalidated_by_revision IS DISTINCT FROM OLD.invalidated_by_revision
       OR NEW.invalidation_reason IS DISTINCT FROM OLD.invalidation_reason) THEN
    RAISE EXCEPTION 'a quotation version invalidation is write-once';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.subtotal <> OLD.subtotal OR NEW.discount <> OLD.discount OR NEW.tax_percent <> OLD.tax_percent
       OR NEW.tax <> OLD.tax OR NEW.total <> OLD.total
       OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.valid_until IS DISTINCT FROM OLD.valid_until) THEN
    RAISE EXCEPTION 'a % quotation version is immutable; create a new version', OLD.status;
  END IF;
  IF OLD.status = 'ACCEPTED' AND NEW.status = 'SUPERSEDED' AND (
       OLD.invalidated_at IS NOT NULL OR NEW.invalidated_at IS NULL
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
       OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id) THEN
    RAISE EXCEPTION 'an accepted quotation version can only be superseded by a recorded order revision';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('SENT', 'SUPERSEDED'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'))
    OR (OLD.status = 'ACCEPTED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'invalid quotation version status change % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.invalidated_at IS NOT NULL AND OLD.invalidated_at IS NULL AND NEW.status <> 'SUPERSEDED' THEN
    RAISE EXCEPTION 'only a superseded quotation version can be invalidated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
