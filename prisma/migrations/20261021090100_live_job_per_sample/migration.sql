-- A COMPLETED physical-sample job stays on record; a rejected sample may get a new job.
-- "Live" now means neither CANCELLED nor COMPLETED.
DROP INDEX "factory_jobs_one_live_per_sample_key";
CREATE UNIQUE INDEX "factory_jobs_one_live_per_sample_key" ON "factory_jobs" ("sample_id")
  WHERE "sample_id" IS NOT NULL AND "status" NOT IN ('CANCELLED', 'COMPLETED');
