# Phase 6A — Management Intelligence

Read-models over the operational data of Phases 3–5B.1 plus three small configuration tables. Nothing here
changes operational state, sends a message or talks to a delivery channel (that is Phase 6B).

## 1. Principles

* **Derived, not stored.** Delay, SLA state, ETA, utilization and every KPI are computed on request. The only new
  tables are configuration: `SlaRule`, `DepartmentCapacity`, `StaffCapacity`.
* **One definition per concept.** The pure modules in `src/modules/management/pure/` (unit tested) own the rules;
  `queries.ts` mirrors the delay rules as Prisma `where` fragments so counts, lists and KPIs always agree.
* **Explicit clock.** Services never call `new Date()`; they use `ManagementContext.now()` so tests freeze time.
* **Honest about data.** Rates are `null` (not 0) when there is nothing to divide; a day without configured capacity
  has no utilization; an ETA says how much it can be trusted; fabric-level quality is not reported because the data
  does not exist.
* **No people scoring.** Staff endpoints show assignment and delivery facts for planning. No score, no ranking, rows
  ordered by name.

## 2. Time zone

Timestamps are stored in UTC. "Today", "this week" (Monday start), daily capacity buckets and plain-date range bounds
use `BUSINESS_TIMEZONE` (IANA name, validated at startup, default `UTC`; set the factory's zone, e.g. `Africa/Cairo`).
`from=2026-10-01` means the start of that business day, `to=2026-10-31` the end of that business day (inclusive); a full
date-time is taken as given. Conversion is DST-safe (`pure/business-time.ts`).

Range limits: `MANAGEMENT_DEFAULT_RANGE_DAYS` (30) when `from` is omitted, `MANAGEMENT_MAX_RANGE_DAYS` (92) maximum;
utilization is limited to 31 days. Invalid, inverted or oversized ranges → 400.

## 3. Delay rules

**Job** (open = not COMPLETED / CANCELLED / ON_HOLD) is delayed when any reason holds:

| Reason | Meaning | Minutes |
|---|---|---|
| `STAGE_OVERDUE` | a current stage is open (WAITING/READY/IN_PROGRESS/BLOCKED), not held, past `dueAt` | time past due |
| `OPEN_BLOCKER` | an unresolved blocker exists | age of the blocker |
| `TARGET_DATE_EXCEEDED` | `targetCompletionDate` has passed | time past target |

A completed, superseded or held stage is never delayed. Superseded rework attempts are ignored.

**Order** (live phase CONFIRMED … OUT_FOR_DELIVERY) is delayed when any reason holds:
`DELIVERY_DATE_EXCEEDED`, `JOB_DELAYED` (+ `PACKAGING_DELAYED` when the late stage is packaging),
`BATCH_TARGET_EXCEEDED` (batch unfinished past its own target), `SHIPMENT_FAILED`, `SHIPMENT_OVERDUE`
(unfinished shipment past its scheduled date or SLA). `delayMinutes` is the largest reason; `delayDays` is rounded.
Delivered / completed / cancelled / held / draft orders are never delayed.

Endpoints: `GET /admin/management/jobs/:id/delay`, `…/orders/:id/delay` (`sla.read`).

## 4. SLA model

`SlaRule { code, name, targetType JOB|STAGE|ORDER|SHIPMENT, stageDefinitionId?, thresholdMinutes, warningBeforeMinutes?,
priorityMultipliers?, active }`. One active rule per target type (per stage definition for STAGE; a STAGE rule with no
definition is the default for every stage). Rules are deactivated, never deleted; every change is audited.

A rule only decides **the deadline**; operational dates win where they exist:

| Target | Clock | Deadline |
|---|---|---|
| STAGE | `readyAt` → `completedAt` | `readyAt` + rule threshold; else `dueAt`; else `readyAt` + `expectedDurationMinutes` |
| JOB | `createdAt` → `completedAt` | `targetCompletionDate`; else `createdAt` + rule threshold |
| ORDER | `confirmedAt` → `deliveredAt` | `targetDeliveryDate`; else `confirmedAt` + rule threshold |
| SHIPMENT | `readyAt` → `deliveredAt` | `scheduledAt`; else `readyAt` + rule threshold |

`priorityMultipliers` (`{"URGENT":0.5}`) scale the threshold (0.1–10). Warning: the last `warningBeforeMinutes` before the
deadline (default 20% of the threshold; for explicit dates 20% of the span from the clock start).

Stage SLA output: `state` (`NO_SLA | ON_TRACK | WARNING | BREACHED | COMPLETED_ON_TIME | COMPLETED_LATE`), `deadline`,
`deadlineSource`, `expectedDurationMinutes`, `actualDurationMinutes` (startedAt→completedAt), `elapsedMinutes`,
`remainingMinutes`, `breached`, `breachMinutes`, `warning`. Exactly at the deadline is not a breach. A completed stage is
reported historically (`COMPLETED_LATE`) and is never a current delay.

Seed: one rule, `SHIPMENT_DEFAULT` (72 h), created once and never overwritten. Stage/job/order SLAs stay unset until the
business sets them.

## 5. Needs Attention

`GET /admin/management/needs-attention?limit&type&minSeverity` and the top 10 inside the dashboard. Each item:
`type, severity, score, entityType, entityId, reference, title, reason, priority, responsible{department,users}, ageMinutes,
dueAt, context{orderId, orderNumber, sampleId, jobId, jobNumber, stageId, shipmentId}`.

| Type | Condition |
|---|---|
| BLOCKED_STAGE | current stage BLOCKED in a live job |
| DELAYED_STAGE / PACKAGING_DELAY | READY/IN_PROGRESS stage past `dueAt` (packaging stages → PACKAGING_DELAY) |
| OVERDUE_JOB | open job past `targetCompletionDate` |
| OVERDUE_ORDER | live order past `targetDeliveryDate` |
| FAILED_QC | QC inspection FAILED within the look-back (`MANAGEMENT_QC_LOOKBACK_HOURS`, 72) in a live job |
| OPEN_REWORK | rework OPEN / IN_PROGRESS |
| PAYMENT_BLOCK | CONFIRMED order the commercial gate refuses (never reported again as re-approval), or a job blocker of type PAYMENT_PENDING |
| COMMERCIAL_REAPPROVAL_REQUIRED | accepted quotation ended by a revision, none accepted since (Phase 5B.1) |
| UNASSIGNED_READY_STAGE | READY stage that needs assignment and has none |
| APPROACHING_DEADLINE | job / order target within `MANAGEMENT_DEADLINE_WINDOW_HOURS` (48) and not yet late |
| SHIPMENT_FAILED | shipment FAILED |
| DELIVERY_DELAY | READY/DISPATCHED/IN_TRANSIT shipment past its scheduled date or shipment SLA |

**Ranking (deterministic, additive):** `score = BASE[type] + PRIORITY[priority] + min(daysOverdue,30)×10 + min(ageDays,14)×5
+ closeness`. Base: SHIPMENT_FAILED 750, BLOCKED_STAGE 700, OVERDUE_ORDER 650, FAILED_QC 650, OVERDUE_JOB 600,
PAYMENT_BLOCK 550, DELIVERY_DELAY 550, DELAYED_STAGE 500, COMMERCIAL_REAPPROVAL_REQUIRED 500, PACKAGING_DELAY 480,
OPEN_REWORK 450, UNASSIGNED_READY_STAGE 300, APPROACHING_DEADLINE 200. Priority: URGENT +200, HIGH +100, NORMAL 0, LOW −50.
Closeness (approaching only): 0–48, higher the nearer the deadline. **Severity:** CRITICAL ≥ 800, WARNING ≥ 450, else INFO.
Ties: earlier due date, then entity id. Each category is read up to 200 rows (urgent first), so counts are exact up to 200.

**Visibility:** commercial types need `commercial_kpis.read`, QC types need `quality_kpis.read`; they are filtered out otherwise.
Conditions are plain functions of current data (nothing stored), so Phase 6B can evaluate the same categories as
notification conditions without touching this layer.

## 6. KPI definitions

All under `/admin/management/kpis/*` with `from`/`to`. Snapshot figures describe the moment of the request.

**Production** (`management_kpis.read`): `activeJobs` (READY/IN_PROGRESS/BLOCKED), `plannedJobs`, `onHoldJobs`, `blockedJobs`,
`delayedJobs` (§3), `completedJobs` (completed in range), `completedToday`, `completedThisWeek` (business zone),
`averageLeadTimeMinutes` (createdAt→completedAt, jobs completed in range), `averageStageDurationMinutes`
(startedAt→completedAt, stages completed in range), `onTimeCompletion` (jobs completed in range that have a target:
completedAt ≤ target).

**Orders** (`management_kpis.read`): `current` {inProduction, productionCompleted, readyForDelivery (READY_FOR_PACKAGING /
PACKAGING / READY_FOR_DELIVERY), partiallyShipped, outForDelivery, delivered, completed, cancelled, onHold, delayed};
`inRange` {delivered, completed, cancelled}; `averageCycleTimeMinutes` (confirmedAt→deliveredAt);
`onTimeDelivery` (deliveredAt ≤ targetDeliveryDate).

**Quality** (`quality_kpis.read`): completed inspections, pass/fail/conditional counts and rates, failed units, rework
created/open/affected quantity (rework without a quantity adds 0), `rejectedUnits` (production reports), failures by
stage, failures by product (job's product snapshot), `repeatFailure` (share of (job, QC stage) pairs that failed more than
once in the range). Failures by fabric are not reported: the fabric is not stored on the job.

**Commercial** (`commercial_kpis.read`, Decimal strings, **per currency, never summed across currencies**): for orders that are
not cancelled/draft/pending: `acceptedQuotationValue`, `verifiedPayments`, `outstandingBalance` (per order max(total − verified, 0)),
`overpaidAmount` (verified above the accepted total, e.g. after a smaller re-quote; not refunded); `verifiedInRange` by currency and
target (order/sample); order counts `unpaid / partiallyPaid / paid / withoutAcceptedQuotation / commercialReapprovalRequired`.

**Delivery** (`management_kpis.read`): open shipments by status, delivered/returned in range, `averageDispatchToDeliveryMinutes`,
`partialDeliveryOrders` (PARTIALLY_SHIPPED), overdue commitments (orders past target date, shipments past scheduled date).

## 7. Bottlenecks

`GET /admin/management/bottlenecks` per stage: completed in range, average duration, started in range, average wait before start
(`readyAt`→`startedAt`), queued/blocked/overdue now, QC failure rate, rework targeting the stage and its rate.
Ordered by `totalWaitMinutes` = time stages waited in READY before starting (started in range) + how long the stages queued now
have already waited. Descriptive only — it shows where work accumulates, not why.

## 8. Workload

* **Departments** (`workload.read`): per FABRIC … GENERAL plus a derived DELIVERY row (shipments): ready / in progress / blocked,
  jobs involved, planned units, remaining units (rework: affected units; job quantity minus produced + rejected), overdue,
  unassigned ready, assigned staff count, eligible staff count (users with a role listed in the department's active stage
  definitions' `eligibleRoleCodes`). Paused jobs/stages are excluded; sample jobs have no quantity so they count as stages, not units.
* **WIP** (`/wip`): per stage definition: queued (READY), active (IN_PROGRESS), blocked — each as stages, jobs, units — upcoming (WAITING)
  and completed today.
* **Staff** (`/workload/staff`, paged, `from/to`, `department`): active/ready/in-progress/blocked/overdue assignments, planned quantity,
  assigned expected minutes, configured minutes per day, stages completed in range, produced/rejected units reported, average completion
  minutes, on-time completion rate, rework on assigned stages. No score or ranking.
* **My workload** (`GET /staff/my-workload`, `jobs.read_assigned`): the caller's own ready / in progress / blocked / overdue / due soon
  (`MANAGEMENT_DUE_SOON_HOURS`, 24) / completed today and the next 5 stages. Never team data.

## 9. Capacity

`DepartmentCapacity { departmentType, stageDefinitionId?, capacityUnit PIECES|JOBS|MINUTES, dailyCapacity, workingMinutesPerDay?,
effectiveFrom, effectiveTo?, active }` and optional `StaffCapacity { userId, stageDefinitionId?, workingMinutesPerDay, … }`.
Active ranges of one scope may not overlap (409; advisory lock + service check); changes are audited, deactivation instead of delete.

`GET /admin/management/capacity/utilization?from&to&department` (≤ 31 days, default today + 6): per scope and day —
`demand, capacity, utilizationPercent, overloaded (demand > capacity), remainingCapacity, capacityUnit`.
Demand = remaining work of **released** stages (READY / IN_PROGRESS / BLOCKED, live unpaused jobs) placed on the **day each stage is due**;
overdue or undated stages count today. PIECES = remaining units, JOBS = distinct jobs, MINUTES = stages' expected minutes.

**Limitations:** every calendar day is a working day (no working calendar); demand is bucketed by due date, not scheduled; sample jobs
have no pieces; WAITING stages are not yet demand; staff capacity is informational (shown on the staff row), not used for utilization.
A day with no configured capacity has no utilization, and departments with demand but no configuration are listed separately.

## 10. ETA (`eta.read`)

`GET /admin/management/jobs/:id/eta`, `…/orders/:id/eta`. Computed on request; **not persisted** (an ETA snapshot is cheap to add later when
Phase 6B needs history for escalation, but storing every computation would only record noise).

Algorithm (job): remaining stages = current WAITING/READY/IN_PROGRESS/BLOCKED stages, scheduled on the dependency graph (start = latest
finish of remaining dependencies, else now; ETA = latest finish = critical path). Duration per stage: **historical average** of completed
occurrences of that stage definition within `ETA_HISTORY_DAYS` (90) when at least `ETA_MIN_SAMPLES` (5) exist → `HISTORICAL`; else the
configured `expectedDurationMinutes` → `CONFIGURED`; else unknown → `NONE` (counted as 0 and reported). IN_PROGRESS contributes what is left of its
estimate (≥ 0). A READY stage adds queue time = stages ahead in the same definition × average duration ÷ workers (eligible staff, ≥ 1); queues of
stages that are still WAITING are not modelled. Calendar time, no working-hours calendar.

**Data quality:** `HIGH` every remaining stage uses history, not blocked/held; `MEDIUM` every stage has an estimate (history or configured), not blocked/held;
`LOW` any stage without an estimate, blocked job (assumed resolved now, with the oldest blocker shown), job on hold, or nothing to base it on.
`basis[]` lists the reasoning ("3 stages remaining", "Sewing: historical average 4.2h", "queue adds 6h"). `projectedLate` compares with the target date.
Completed job → actual completion, HIGH; cancelled → none.

**Order:** production ETA = slowest job/batch (`jobs[]` listed), LOW if units are in no batch (a whole-order job covers everything); packaging is part of
each job's stages. **Delivery ETA is separate and never invented:** latest scheduled date of the open shipments only if every open shipment has one,
the actual delivery time once delivered, otherwise `null` with the reason.

## 11. Dashboard and pipelines

`GET /admin/dashboard` (`dashboard.read`): `needsAttention` (top 10), `pipeline` (samples / orders grouped by real enum values;
unit-tested so no status can fall out of a group) and, only where the caller holds the permission, `production`, `orders`, `delivery`
(`management_kpis.read`), `quality` (`quality_kpis.read`), `workload` (`workload.read`), `commercial` (`commercial_kpis.read`). A hidden
section is absent, not empty.

`GET /admin/management/production-board` (`production_board.read`): one row per live job — job/order/sample/batch numbers, customer/brand,
priority, status, current stage(s) with assignees, progress (stages and quantity), blocked, delayed + reason codes, target date, and
`estimatedCompletionAt / etaDataQuality / projectedLate` only for callers with `eta.read`. Filters: stage, department, staff, priority, blocked,
delayed, kind (SAMPLE/BULK), customer, brand; paginated; urgent first.

## 12. Permissions

| Permission | Grants | Default roles |
|---|---|---|
| `dashboard.read` | dashboard, Needs Attention | ADMIN, SALES, FINANCE |
| `management_kpis.read` | production / order / delivery KPIs, bottlenecks | ADMIN, SALES |
| `quality_kpis.read` | quality KPIs, QC attention items | ADMIN, QC |
| `commercial_kpis.read` | commercial KPIs, commercial attention items | ADMIN, FINANCE |
| `workload.read` | department / staff / WIP workload | ADMIN |
| `capacity.read` / `capacity.manage` | view / configure capacity, utilization | ADMIN |
| `sla.read` / `sla.manage` | view / configure SLA rules, job & order delay | ADMIN (`sla.read` also SALES) |
| `eta.read` | ETA, ETA on the board | ADMIN, SALES |

SUPER_ADMIN has all (73 permissions in total). Factory floor roles get nothing executive; they use `GET /staff/my-workload`
(`jobs.read_assigned`). Grants arrive through the `phase6a-management` batch (applied once, never re-granting what an admin removed).

## 13. API summary

`GET /admin/dashboard` · `/admin/management/needs-attention` · `/kpis/{production,orders,quality,commercial,delivery}` · `/bottlenecks` ·
`/workload/departments` · `/workload/staff` · `/wip` · `/production-board` · `/jobs/:id/{delay,eta}` · `/orders/:id/{delay,eta}` ·
`/capacity/departments` (GET, POST, PUT :id, POST :id/deactivate) · `/capacity/staff` (same) · `/capacity/utilization` ·
`/sla-rules` (GET, GET :id, POST, PUT :id, POST :id/deactivate) · `GET /staff/my-workload`.

Audit: `sla_rule.created|updated|deactivated`, `department_capacity.*`, `staff_capacity.*`. Reading analytics is not audited.

## 14. Queries and indexes

Aggregates run in SQL (`groupBy`, `FILTER`, CTEs; raw SQL only for what Prisma cannot express, all values bound). Lists are bounded (200 rows per
attention category, 100 per page). New/changed indexes: `job_stages (status, due_at)`, `(stage_definition_id, status)`, `(completed_at)`;
`factory_jobs (status, target_completion_date)`, `(completed_at)`; `orders (status, target_delivery_date)`, `(delivered_at)`;
`qc_inspections (completed_at)`, `(overall_result, completed_at)`; `rework_records (created_at)`; `shipments (status, scheduled_at)`, `(delivered_at)`;
`payments (status, verified_at)`; `blockers (status, type)`; `stage_production_reports (created_at)`, `(reported_by_user_id, created_at)`;
partial `stage_assignments (user_id, job_stage_id) WHERE removed_at IS NULL`. Single-column `status` indexes on `job_stages`, `factory_jobs`,
`orders`, `shipments`, `blockers` were dropped as redundant prefixes. Order/job activity tables are not queried by analytics, so they got no new index.
No materialised views or caches: direct queries are fast at this scale. **Scaling path:** per-day rollup tables fed by the operational events,
or a read replica, behind the same service interfaces.

## 15. Known limitations

* Working calendar (Phase 6B): SLA, ETA and escalation count working minutes when a non-24/7 default calendar is configured; capacity utilization and the delay engine still use calendar days / absolute due dates.
* Capacity is a baseline, not a scheduler; demand is bucketed by due date.
* Stage/job/order SLAs are unset by default; without them deadlines fall back to due dates and expected durations.
* ETA history is global per stage definition (not per product or fabric); with few samples it falls back to configured durations.
* Quality by fabric is not derivable; "failures by product" uses the job's product snapshot.
* `PAYMENT_BLOCK` evaluates the commercial gate per confirmed order (up to 200), which is the slowest category.
* Attention counts are exact up to 200 per category.
* Response bodies are documented as generic objects in Swagger; the shapes are defined by this document and the tests.

## 16. Phase 6B compatibility *(implemented: see `PHASE_6B_AUTOMATION_OPERATIONAL_TOOLS.md`)*

Attention categories, delay reasons and SLA states are pure, side-effect-free evaluations of current data, available as services
(`AttentionService`, `DelayService`, `EtaService`, `SlaService`, `ManagementContext`) exported from `ManagementModule`. A notification worker
can evaluate them on a schedule, diff against what was already sent, and hand the result to any channel; nothing in Phase 6A stores
notifications, knows about channels, or sends anything.
