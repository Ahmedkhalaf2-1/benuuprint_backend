-- Email verification can be switched off by configuration (CUSTOMER_EMAIL_VERIFICATION_REQUIRED=false):
-- a self-registered account is then ACTIVE with email_verified_at still NULL. The "verified" claim stays
-- truthful (it is never set without a verification), so the ACTIVE => verified guard is dropped.
-- The self-signup acceptance guard stays.
ALTER TABLE "customer_accounts" DROP CONSTRAINT "customer_accounts_active_email_verified";
