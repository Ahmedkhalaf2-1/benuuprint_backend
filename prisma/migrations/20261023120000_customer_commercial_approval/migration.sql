-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "requested_by_customer_id" UUID,
ALTER COLUMN "requested_by_user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "asset_attachments" ADD COLUMN     "customer_visible" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "created_by_customer_id" UUID,
ADD COLUMN     "customer_message" TEXT;

-- AlterTable
ALTER TABLE "quotation_versions" ADD COLUMN     "customer_notes" TEXT;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_customer_id_fkey" FOREIGN KEY ("requested_by_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_responded_by_customer_id_fkey" FOREIGN KEY ("responded_by_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_customer_id_fkey" FOREIGN KEY ("created_by_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written guards (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

-- An approval is requested by exactly one party: a staff member or the customer themselves.
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_single_requester"
  CHECK (num_nonnulls("requested_by_user_id", "requested_by_customer_id") = 1);

-- A CUSTOMER_AUTHENTICATED response is by a customer and never by a staff member; staff modes never name a customer.
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_customer_mode_matches_responder"
  CHECK (("mode" IS NOT DISTINCT FROM 'CUSTOMER_AUTHENTICATED') = ("responded_by_customer_id" IS NOT NULL)
         AND NOT ("mode" IS NOT DISTINCT FROM 'CUSTOMER_AUTHENTICATED' AND "responded_by_user_id" IS NOT NULL));

-- A payment is recorded by a staff member OR by the customer, never both.
ALTER TABLE "payments" ADD CONSTRAINT "payments_single_creator"
  CHECK ("created_by_user_id" IS NULL OR "created_by_customer_id" IS NULL);

-- Only sample attachments can be exposed to a customer.
ALTER TABLE "asset_attachments" ADD CONSTRAINT "asset_attachments_customer_visible_sample_only"
  CHECK (NOT "customer_visible" OR "sample_id" IS NOT NULL);

-- The customer-facing note of a sent quotation version is as immutable as its prices.
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
       OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.customer_notes IS DISTINCT FROM OLD.customer_notes
       OR NEW.valid_until IS DISTINCT FROM OLD.valid_until) THEN
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
