import { Prisma } from '../../generated/prisma/client.js';

/**
 * Shared SQL building blocks of the management read-models. Everything user-controlled is passed
 * as a bound parameter (Prisma.sql); only these constant fragments are inlined.
 */

/** A stage that is released work: the current occurrence, in a live job, not paused. */
export const RELEASED_STAGE = Prisma.sql`js.superseded_at IS NULL
  AND js.status IN ('READY', 'IN_PROGRESS', 'BLOCKED')
  AND NOT js.is_on_hold
  AND fj.status NOT IN ('COMPLETED', 'CANCELLED', 'ON_HOLD')`;

/** Units a stage must still account for: rework → the affected units, otherwise the job quantity. */
export const REMAINING_UNITS = Prisma.sql`GREATEST(COALESCE(rw.affected_quantity, fj.planned_quantity, 0) - COALESCE(acc.accounted, 0), 0)`;
export const PLANNED_UNITS = Prisma.sql`COALESCE(rw.affected_quantity, fj.planned_quantity, 0)`;

export const ACCOUNTED_JOINS = Prisma.sql`LEFT JOIN rework_records rw ON rw.id = js.rework_record_id
  LEFT JOIN (SELECT job_stage_id, SUM(produced_quantity + rejected_quantity) AS accounted
             FROM stage_production_reports GROUP BY job_stage_id) acc ON acc.job_stage_id = js.id`;

export const NO_ACTIVE_ASSIGNMENT = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM stage_assignments sa0 WHERE sa0.job_stage_id = js.id AND sa0.removed_at IS NULL)`;

/** Prisma returns bigint for COUNT/SUM; the read-models cast to int in SQL, this is the safety net. */
export const num = (v: unknown): number =>
  v === null || v === undefined ? 0 : Number(v);
