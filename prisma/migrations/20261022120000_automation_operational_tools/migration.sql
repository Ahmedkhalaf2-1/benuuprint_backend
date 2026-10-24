-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationRecipientKind" AS ENUM ('STAFF', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AutomationAudience" AS ENUM ('ROLE', 'PERMISSION', 'STAGE_ASSIGNEES', 'JOB_ASSIGNEES', 'ALERT_RESPONSIBLE', 'SALES_OWNER', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "EscalationRecipientKind" AS ENUM ('ROLE', 'RESPONSIBLE_DEPARTMENT');

-- CreateEnum
CREATE TYPE "TechPackStatus" AS ENUM ('DRAFT', 'ISSUED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TechPackSource" AS ENUM ('SAMPLE', 'ORDER');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "preferred_locale" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notification_locale" TEXT;

-- CreateTable
CREATE TABLE "working_calendars" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "working_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_calendar_days" (
    "id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "is_working_day" BOOLEAN NOT NULL,
    "start_minute" INTEGER,
    "end_minute" INTEGER,

    CONSTRAINT "working_calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_calendar_exceptions" (
    "id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "is_working_day" BOOLEAN NOT NULL,
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "reason" TEXT,

    CONSTRAINT "working_calendar_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "deduplication_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "recipient_kind" "NotificationRecipientKind" NOT NULL,
    "recipient_user_id" UUID,
    "customer_id" UUID,
    "customer_contact_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "recipient_address" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "template_code" TEXT,
    "template_version" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "provider_message_id" TEXT,
    "deduplication_key" TEXT,
    "outbox_event_id" UUID,
    "alert_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "subject" TEXT,
    "body_template" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notification_preferences" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_alerts" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "NotificationSeverity" NOT NULL,
    "last_notified_severity" "NotificationSeverity",
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "department" TEXT,
    "context" JSONB,
    "first_detected_at" TIMESTAMP(3) NOT NULL,
    "last_detected_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "last_notified_at" TIMESTAMP(3),
    "escalation_level" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_rules" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "min_severity" "NotificationSeverity",
    "level" INTEGER NOT NULL,
    "after_minutes" INTEGER NOT NULL,
    "recipient_kind" "EscalationRecipientKind" NOT NULL,
    "recipient_role_code" TEXT,
    "channels" "NotificationChannel"[],
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "alert_type" TEXT,
    "min_severity" "NotificationSeverity",
    "audience" "AutomationAudience" NOT NULL,
    "audience_value" TEXT,
    "channels" "NotificationChannel"[],
    "template_code" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduler_runs" (
    "id" UUID NOT NULL,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "details" JSONB,
    "error" TEXT,

    CONSTRAINT "scheduler_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factory_job_qr_tokens" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "rotated_from_id" UUID,
    "last_scanned_at" TIMESTAMP(3),

    CONSTRAINT "factory_job_qr_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_packs" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "source_type" "TechPackSource" NOT NULL,
    "sample_id" UUID,
    "order_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tech_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_pack_versions" (
    "id" UUID NOT NULL,
    "tech_pack_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TechPackStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "sample_production_spec_id" UUID NOT NULL,
    "order_production_spec_id" UUID,
    "document_asset_id" UUID,
    "generated_by_user_id" UUID NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by_user_id" UUID,
    "issued_at" TIMESTAMP(3),
    "superseded_at" TIMESTAMP(3),
    "superseded_reason" TEXT,

    CONSTRAINT "tech_pack_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "working_calendars_code_key" ON "working_calendars"("code");

-- CreateIndex
CREATE UNIQUE INDEX "working_calendar_days_calendar_id_weekday_key" ON "working_calendar_days"("calendar_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "working_calendar_exceptions_calendar_id_date_key" ON "working_calendar_exceptions"("calendar_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_deduplication_key_key" ON "outbox_events"("deduplication_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_deduplication_key_key" ON "notifications"("deduplication_key");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_channel_read_at_created_at_idx" ON "notifications"("recipient_user_id", "channel", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notifications_type_created_at_idx" ON "notifications"("type", "created_at");

-- CreateIndex
CREATE INDEX "notifications_customer_id_idx" ON "notifications"("customer_id");

-- CreateIndex
CREATE INDEX "notifications_outbox_event_id_idx" ON "notifications"("outbox_event_id");

-- CreateIndex
CREATE INDEX "notification_templates_code_channel_locale_active_idx" ON "notification_templates"("code", "channel", "locale", "active");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_code_channel_locale_version_key" ON "notification_templates"("code", "channel", "locale", "version");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_preferences_user_id_category_key" ON "user_notification_preferences"("user_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "customer_notification_preferences_customer_id_category_key" ON "customer_notification_preferences"("customer_id", "category");

-- CreateIndex
CREATE INDEX "operational_alerts_status_type_idx" ON "operational_alerts"("status", "type");

-- CreateIndex
CREATE INDEX "operational_alerts_entity_type_entity_id_idx" ON "operational_alerts"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "operational_alerts_fingerprint_idx" ON "operational_alerts"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "escalation_rules_code_key" ON "escalation_rules"("code");

-- CreateIndex
CREATE INDEX "escalation_rules_alert_type_active_idx" ON "escalation_rules"("alert_type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_code_key" ON "automation_rules"("code");

-- CreateIndex
CREATE INDEX "automation_rules_event_type_active_idx" ON "automation_rules"("event_type", "active");

-- CreateIndex
CREATE INDEX "scheduler_runs_task_started_at_idx" ON "scheduler_runs"("task", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "factory_job_qr_tokens_token_hash_key" ON "factory_job_qr_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "factory_job_qr_tokens_job_id_idx" ON "factory_job_qr_tokens"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "tech_packs_reference_key" ON "tech_packs"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "tech_packs_sample_id_key" ON "tech_packs"("sample_id");

-- CreateIndex
CREATE UNIQUE INDEX "tech_packs_order_id_key" ON "tech_packs"("order_id");

-- CreateIndex
CREATE INDEX "tech_pack_versions_status_idx" ON "tech_pack_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tech_pack_versions_tech_pack_id_version_key" ON "tech_pack_versions"("tech_pack_id", "version");

-- AddForeignKey
ALTER TABLE "working_calendar_days" ADD CONSTRAINT "working_calendar_days_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "working_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_calendar_exceptions" ADD CONSTRAINT "working_calendar_exceptions_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "working_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_contact_id_fkey" FOREIGN KEY ("customer_contact_id") REFERENCES "customer_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "operational_alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notification_preferences" ADD CONSTRAINT "customer_notification_preferences_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_job_qr_tokens" ADD CONSTRAINT "factory_job_qr_tokens_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "factory_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_job_qr_tokens" ADD CONSTRAINT "factory_job_qr_tokens_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factory_job_qr_tokens" ADD CONSTRAINT "factory_job_qr_tokens_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_packs" ADD CONSTRAINT "tech_packs_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "samples"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_packs" ADD CONSTRAINT "tech_packs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_pack_versions" ADD CONSTRAINT "tech_pack_versions_tech_pack_id_fkey" FOREIGN KEY ("tech_pack_id") REFERENCES "tech_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_pack_versions" ADD CONSTRAINT "tech_pack_versions_sample_production_spec_id_fkey" FOREIGN KEY ("sample_production_spec_id") REFERENCES "sample_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_pack_versions" ADD CONSTRAINT "tech_pack_versions_order_production_spec_id_fkey" FOREIGN KEY ("order_production_spec_id") REFERENCES "order_production_specs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_pack_versions" ADD CONSTRAINT "tech_pack_versions_document_asset_id_fkey" FOREIGN KEY ("document_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_pack_versions" ADD CONSTRAINT "tech_pack_versions_generated_by_user_id_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_pack_versions" ADD CONSTRAINT "tech_pack_versions_issued_by_user_id_fkey" FOREIGN KEY ("issued_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════ Phase 6B hand-written guards ═══════════════════════

-- ---- working calendar ----
ALTER TABLE "working_calendars" ADD CONSTRAINT "working_calendars_code_format" CHECK ("code" ~ '^[A-Z0-9_]{2,60}$');
ALTER TABLE "working_calendars" ADD CONSTRAINT "working_calendars_default_active" CHECK (NOT "is_default" OR "active");
CREATE UNIQUE INDEX "working_calendars_one_default_key" ON "working_calendars" ((1)) WHERE "is_default";
ALTER TABLE "working_calendar_days" ADD CONSTRAINT "working_calendar_days_weekday" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "working_calendar_days" ADD CONSTRAINT "working_calendar_days_hours" CHECK (
     ("is_working_day" AND "start_minute" IS NOT NULL AND "end_minute" IS NOT NULL
        AND "start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")
  OR (NOT "is_working_day" AND "start_minute" IS NULL AND "end_minute" IS NULL));
ALTER TABLE "working_calendar_exceptions" ADD CONSTRAINT "working_calendar_exceptions_hours" CHECK (
     ("is_working_day" AND "start_minute" IS NOT NULL AND "end_minute" IS NOT NULL
        AND "start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")
  OR (NOT "is_working_day" AND "start_minute" IS NULL AND "end_minute" IS NULL));

-- ---- outbox / notifications ----
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_one_recipient" CHECK (
     ("recipient_kind" = 'STAFF' AND "recipient_user_id" IS NOT NULL AND "customer_id" IS NULL)
  OR ("recipient_kind" = 'CUSTOMER' AND "customer_id" IS NOT NULL AND "recipient_user_id" IS NULL));
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_rules" CHECK (
     ("channel" = 'IN_APP' AND "recipient_kind" = 'STAFF')
  OR ("channel" <> 'IN_APP' AND "recipient_address" IS NOT NULL));
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_attempts" CHECK ("attempts" >= 0);

CREATE OR REPLACE FUNCTION notification_templates_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification templates are never deleted';
  END IF;
  IF NEW.code <> OLD.code OR NEW.channel <> OLD.channel OR NEW.locale <> OLD.locale OR NEW.version <> OLD.version
     OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body_template <> OLD.body_template THEN
    RAISE EXCEPTION 'a notification template version is immutable; publish a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER notification_templates_guard BEFORE UPDATE OR DELETE ON "notification_templates"
  FOR EACH ROW EXECUTE FUNCTION notification_templates_guard();
CREATE UNIQUE INDEX "notification_templates_one_active_key" ON "notification_templates" ("code", "channel", "locale") WHERE "active";
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_locale" CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$');

-- ---- alerts, escalation, automation ----
CREATE UNIQUE INDEX "operational_alerts_one_open_key" ON "operational_alerts" ("fingerprint") WHERE "status" = 'OPEN';
ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_resolution" CHECK (("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL));
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_level" CHECK ("level" BETWEEN 1 AND 5);
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_after" CHECK ("after_minutes" >= 0 AND "after_minutes" <= 525600);
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_recipient" CHECK (
     ("recipient_kind" = 'ROLE' AND "recipient_role_code" IS NOT NULL)
  OR ("recipient_kind" = 'RESPONSIBLE_DEPARTMENT' AND "recipient_role_code" IS NULL));
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_channels" CHECK (cardinality("channels") > 0);
CREATE UNIQUE INDEX "escalation_rules_one_active_level_key" ON "escalation_rules" ("alert_type", "level") WHERE "active";
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_channels" CHECK (cardinality("channels") > 0);
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_audience_value" CHECK (
     ("audience" IN ('ROLE', 'PERMISSION') AND "audience_value" IS NOT NULL)
  OR ("audience" NOT IN ('ROLE', 'PERMISSION')));

-- ---- QR tokens ----
CREATE UNIQUE INDEX "factory_job_qr_tokens_one_active_key" ON "factory_job_qr_tokens" ("job_id") WHERE "revoked_at" IS NULL;
CREATE OR REPLACE FUNCTION factory_job_qr_tokens_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'QR tokens are never deleted';
  END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.token_hash <> OLD.token_hash OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.rotated_from_id IS DISTINCT FROM OLD.rotated_from_id THEN
    RAISE EXCEPTION 'a QR token''s identity is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id) THEN
    RAISE EXCEPTION 'a revoked QR token cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER factory_job_qr_tokens_guard BEFORE UPDATE OR DELETE ON "factory_job_qr_tokens"
  FOR EACH ROW EXECUTE FUNCTION factory_job_qr_tokens_guard();

-- ---- tech packs ----
ALTER TABLE "tech_packs" ADD CONSTRAINT "tech_packs_source" CHECK (
     ("source_type" = 'SAMPLE' AND "sample_id" IS NOT NULL AND "order_id" IS NULL)
  OR ("source_type" = 'ORDER' AND "order_id" IS NOT NULL AND "sample_id" IS NULL));
CREATE UNIQUE INDEX "tech_pack_versions_one_issued_key" ON "tech_pack_versions" ("tech_pack_id") WHERE "status" = 'ISSUED';
CREATE UNIQUE INDEX "tech_pack_versions_one_draft_key" ON "tech_pack_versions" ("tech_pack_id") WHERE "status" = 'DRAFT';
ALTER TABLE "tech_pack_versions" ADD CONSTRAINT "tech_pack_versions_issue_complete" CHECK (
     ("status" = 'DRAFT' AND "issued_at" IS NULL)
  OR ("status" <> 'DRAFT'));
CREATE OR REPLACE FUNCTION tech_pack_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tech pack versions are never deleted';
  END IF;
  IF NEW.tech_pack_id <> OLD.tech_pack_id OR NEW.version <> OLD.version OR NEW.content <> OLD.content
     OR NEW.content_hash <> OLD.content_hash OR NEW.sample_production_spec_id <> OLD.sample_production_spec_id
     OR NEW.order_production_spec_id IS DISTINCT FROM OLD.order_production_spec_id
     OR NEW.generated_by_user_id <> OLD.generated_by_user_id OR NEW.generated_at <> OLD.generated_at THEN
    RAISE EXCEPTION 'a tech pack version is a frozen snapshot; generate a new version';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('ISSUED', 'SUPERSEDED'))
    OR (OLD.status = 'ISSUED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'invalid tech pack status change % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'DRAFT' AND NEW.document_asset_id IS DISTINCT FROM OLD.document_asset_id THEN
    RAISE EXCEPTION 'the document of an issued tech pack cannot change';
  END IF;
  IF OLD.issued_at IS NOT NULL AND (NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id) THEN
    RAISE EXCEPTION 'issue details are write-once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tech_pack_versions_guard BEFORE UPDATE OR DELETE ON "tech_pack_versions"
  FOR EACH ROW EXECUTE FUNCTION tech_pack_versions_guard();
