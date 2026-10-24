# Responsibility rules + process visibility

Two backend features for the Admin: (A) configure who owns each factory area **once**, and (B) see, from real production data, where any customer's work is, who has it, and what comes next. No frontend yet; staff data only (the customer portal never receives staff names).

## Responsibility model
`responsibility_rules` (`ResponsibilityRule`): `scope` (`GLOBAL` | `CUSTOMER`), `customerId` (null for GLOBAL), `stageKey`, `primaryUserId`, optional `additionalUserIds`, created/updated by + timestamps.

- **Stage key** = the stable `ProductionStageDefinition.code` (`FABRIC_PREPARATION`, `PATTERN_MAKING`, `CUTTING`, `QC_GATE_1/2/3`, `PRINTING_EMBROIDERY`, `SEWING`, `PACKAGING`) plus the virtual key `DELIVERY` (shipments). Never display names. `READY` needs no assignment so it is not an area. Each QC gate is its own area.
- Constraints: one GLOBAL rule per `stageKey` (partial unique index), one CUSTOMER rule per `(customerId, stageKey)`, CHECK scope/customer consistency, CHECK stage-key format.
- Rules start **empty**. Nothing is inferred from history.
- A stage can have several assignees already (`stage_assignments`, one primary); a rule's `additionalUserIds` map to additional non-primary assignees. Only the primary owner is shown as "responsible".

## Precedence (resolved by the backend)
`CUSTOMER override → GLOBAL default → nobody`. If the winning rule's owner is not healthy, the effective user is `null` (it does **not** silently fall back to the global default) and the rule is flagged `NEEDS_ATTENTION`.

## Eligibility and health
A rule owner must be eligible exactly like a manual stage assignment: active non-deleted user, holds `stages.start` (or `shipments.dispatch` for DELIVERY) and, when the stage definition lists `eligibleRoleCodes`, one of those roles. No role-name bypass. Invalid assignees are rejected (400) on write. Later, if the owner is disabled (`ASSIGNEE_DISABLED`) or loses the role/permission (`ASSIGNEE_INELIGIBLE`), future work is not assigned to them and health is `NEEDS_ATTENTION`.

## Auto-assignment of new work
`FactoryJobsService.instantiate` (sample jobs, whole-order jobs and batch jobs) calls `StageAutoAssignService.autoAssignJob` inside the job-creation transaction: for every assignable open stage with no assignee it writes a normal `stage_assignments` row (+ `STAGE_ASSIGNED` job activity, which also fires the existing domain event, + an audit entry with `auto: true`). The assignment carries `source`: `GLOBAL_DEFAULT` or `CUSTOMER_OVERRIDE`. Manual assignment is unchanged and stays `MANUAL`. Rule changes **never** rewrite existing assignments.

New shipments without `assignedDeliveryUserId` get the effective DELIVERY owner of the order's customer; an explicit delivery person always wins.

## Apply to active work
`POST /admin/responsibilities/:stageKey/apply-active` (all customers; each stage is resolved through its own customer, so overrides still win) and `POST /admin/customers/:customerId/responsibilities/:stageKey/apply-active`. Body `{ mode }`:
- `UNASSIGNED_ONLY` (default): fill open stages that nobody owns.
- `REPLACE`: also replace the owners of stages that have not started (waiting, ready, blocked). Replaced assignments are kept with `removedAt`.
Never touched: stages in progress (reported as `skipped.started`), completed/skipped/cancelled/superseded stages, cancelled or completed jobs. For `DELIVERY`: live shipments; replace never touches a shipment already dispatched/in transit. Needs `responsibilities.manage` **and** `jobs.assign`. Each stage is processed in its own transaction under the job lock and re-checked, and one audit entry records mode, scope, new users and affected count.

## Endpoints
| | |
|---|---|
| `GET /admin/responsibilities` | every area: global default, effective user, source, health, active workload |
| `PUT /admin/responsibilities/:stageKey` `{ userId, additionalUserIds? }` | set the global default |
| `DELETE /admin/responsibilities/:stageKey` | clear it |
| `POST /admin/responsibilities/:stageKey/apply-active` `{ mode? }` | apply to open work |
| `GET /admin/responsibilities/attention` | command-centre feed |
| `POST /admin/responsibilities/bulk-customer-overrides` `{ customerIds, stageKey, userId }` or `{ …, clear: true }` | all-or-nothing, one audit entry |
| `GET /admin/customers/:id/responsibilities` | matrix |
| `PUT` / `DELETE /admin/customers/:id/responsibilities/:stageKey` | customer override |
| `POST /admin/customers/:id/responsibilities/:stageKey/apply-active` | apply for one customer |
| `GET /admin/customers/:id/operations` | the customer's operational picture |
| `GET /admin/orders/:id/process`, `/admin/samples/:id/process`, `/admin/jobs/:id/process` | stage timelines |
| `GET /admin/customers?includeOperations=true`, `GET /admin/customers/:id?includeOperations=true` | list/detail summaries |

No-op writes (same user, same extras) are not audited again.

### Matrix item
`{ stageKey, label, group: FACTORY|FULFILLMENT, eligibleRoleCodes, source: CUSTOMER_OVERRIDE|GLOBAL_DEFAULT|UNASSIGNED, effectiveUser, globalDefaultUser, customerOverrideUser, health: OK|NEEDS_ATTENTION|NOT_CONFIGURED, reason, activeWork }` plus `commercial.salesOwner`. `activeWork` is the number of open stages (live shipments for DELIVERY) the effective user holds now; no capacity numbers are invented.

### Sales owner
Sales ownership lives on samples and orders (`assignedSalesUserId`), not on the customer. It is not replaced. The matrix and summaries report the owner of the customer's most recent live order/sample that has one (with its reference number); work items carry their own sales owner for orders/samples.

### Command-centre feed
`GET /admin/responsibilities/attention` → `rulesNeedingAttention { count, items[{ scope, customerId, stageKey, configuredUser, effectiveUser: null, health, reason }] }` and `unassignedActiveStages { count, byStageKey[] }` (ready, in-progress or blocked stages nobody owns, on released jobs).

## Stage timing and assignment source
`JobStage` already had `readyAt`, `startedAt`, `completedAt`, `blockedAt`, `dueAt`; `StageAssignment.assignedAt` is the assignment time. Added: `stage_assignments.source` (`MANUAL` | `GLOBAL_DEFAULT` | `CUSTOMER_OVERRIDE`, default `MANUAL`, so history is MANUAL). "Who started / who completed" come from the latest `STAGE_STARTED` / `STAGE_COMPLETED` job activity of that stage (a real actor, never fabricated). Duration = `completedAt − startedAt`, or elapsed time while in progress.

## Process projection
Per job (`JobProcess`): `currentStage`, `nextStage`, `lastCompleted`, `activeStages`, `stages[]`, `progress {completedStages,totalStages,percent}`, `blocker {active, reason}`, `attention`.
- **currentStage**: the first stage (lowest sequence) that is `IN_PROGRESS`, else `BLOCKED`, else `READY`, else `WAITING`; `null` for completed/cancelled jobs. Parallel branches show in `activeStages`.
- **nextStage**: the next open stage after the current one, with its **actual** owner (`responsibleUser`, `null` if unassigned).
- **Stage item**: `stageKey, label, sequence, attempt, status, isOnHold, responsibleUser, additionalUsers, assignmentSource (GLOBAL_DEFAULT|CUSTOMER_OVERRIDE|MANUAL|UNASSIGNED), assignedAt, readyAt, startedAt, startedBy, completedAt, completedBy, durationMinutes, dueAt, blocker {active, reason, type, since}, handoff`.
- `responsibleUser` is the actual primary assignment, never the default rule: a manual reassignment shows the manual assignee; no assignment shows `null`.
- Rework occurrences: superseded stages are excluded; the latest attempt is shown with its `attempt`.

### Handoff interpretation
No handoff entity exists. For every `COMPLETED` stage, `handoff` = the next open stage by sequence (`toStageKey`, `toLabel`, `toStatus`, `toUser`). The frontend can say "Mahmoud completed Cutting and handed work to Sewing (Ahmed)" from `completedBy` + `handoff`. `lastCompleted` is the most recently completed stage.

### Multiple active work and ordering
A customer can have many samples, orders and jobs. `operations.currentWork` lists every live job (planned, ready, in progress, blocked, on hold) sorted: **blocked → overdue → in progress → ready → planned**, then priority (urgent first), then job number, so the order is deterministic. Overdue = job target date or the current stage's due date has passed. Each item is compact: `referenceType (SAMPLE|ORDER), referenceId, referenceNumber, jobId, jobNumber, batchNumber, currentStage, nextStage, progress, blocker, attention, priority, productName, eta`. `eta` (existing ETA service, one batched call) is included only for callers with `eta.read`, otherwise `null`. `activeSamples` / `activeOrders` list the live sample/order references with their jobs and sales owner.

### Customer list / detail summary
`includeOperations=true` (needs `responsibilities.read`, otherwise 403) adds to each customer: `responsibilitySummary { salesOwner, areas[{stageKey,label,user,source,health}], configuredCount, totalAreas, needsAttention }`, `currentProcess` (highest-priority live item: referenceNumber, jobNumber, stage, stageLabel, status, attention, responsibleUser, startedAt, progressPercent, blocked), `currentProcesses` (up to 5) and `activeJobCount`. **Query strategy**: a fixed number of queries per page regardless of page size (global + customer rules, sales owners, live jobs with stages/assignments/blockers, job activity events, reference numbers, user names). No per-customer fetches.

## Delivery
Delivery is not a factory stage here: it lives on `Shipment.assignedDeliveryUserId`. `DELIVERY` is an area in the matrix (group `FULFILLMENT`); the default fills new shipments and `apply-active` fills live shipments. Shipment assignment source is not stored (no column); the matrix still shows the rule source.

## Permissions (database RBAC, grant batch `responsibilities`)
`responsibilities.read` → ADMIN, SALES (SUPER_ADMIN gets all). `responsibilities.manage` → ADMIN. Apply-active additionally needs `jobs.assign`. Factory staff and customers have none (customer tokens get 401 on `/admin/*`). Finance can still read customers but not `includeOperations`.

## Audit
`responsibility.set` (created or changed, with `scope, customerId, stageKey, created, oldUserId, newUserId, additionalUserIds`), `responsibility.cleared`, `responsibility.bulk_overrides` (`customerIds, cleared, newUserId, affectedCount`), `responsibility.applied_to_active` (`scope, customerId, stageKey, mode, newUserIds, affectedCount` and the skip counts), and auto-assignments write the usual `job_stage.assigned` with `auto: true, source`.

## Known limitations
- A rule whose owner becomes unhealthy leaves new work unassigned (visible in `attention`); it does not fall back to the global default.
- Rework occurrences are not auto-assigned from rules.
- QC gates are separate areas (no combined "QC" key).
- Shipments do not store an assignment source.
- Customers have no own sales-owner field; the summary reports the owner of their latest live order/sample.
- Customer ETA is only attached for staff with `eta.read`.

## Frontend-ready contracts
See the endpoint table; item shapes above are the response bodies. Staff-only: never render these in the customer portal.
