-- AlterTable
ALTER TABLE "order_activities" ADD COLUMN     "actor_customer_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "created_by_customer_id" UUID,
ADD COLUMN     "customer_notes" TEXT,
ADD COLUMN     "preferred_address_id" UUID,
ALTER COLUMN "created_by_user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "quotation_versions" ADD COLUMN     "decided_by_customer_id" UUID;

-- AddForeignKey
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_decided_by_customer_id_fkey" FOREIGN KEY ("decided_by_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_customer_id_fkey" FOREIGN KEY ("created_by_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_preferred_address_id_fkey" FOREIGN KEY ("preferred_address_id") REFERENCES "customer_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_activities" ADD CONSTRAINT "order_activities_actor_customer_id_fkey" FOREIGN KEY ("actor_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written guards (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

-- An order is placed by a staff member OR by the customer through the portal.
ALTER TABLE "orders" ADD CONSTRAINT "orders_single_creator"
  CHECK (num_nonnulls("created_by_user_id", "created_by_customer_id") = 1);

-- A quotation version is decided by staff (on behalf) or by the customer, never both.
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_single_decider"
  CHECK ("decided_by_user_id" IS NULL OR "decided_by_customer_id" IS NULL);

-- An order timeline entry has at most one kind of actor.
ALTER TABLE "order_activities" ADD CONSTRAINT "order_activities_single_actor"
  CHECK ("actor_user_id" IS NULL OR "actor_customer_id" IS NULL);

-- The customer's decision on an accepted order quotation stays as write-once as the staff one.
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
       OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
       OR NEW.decided_by_customer_id IS DISTINCT FROM OLD.decided_by_customer_id) THEN
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
