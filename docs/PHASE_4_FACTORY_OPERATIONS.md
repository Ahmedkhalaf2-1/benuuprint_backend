# Phase 4 — Factory Operations

Turns a paid sample into factory work (the physical sample is built before the customer's final approval): jobs, a configurable workflow graph, stage ownership, blockers, QC gates, rework and an operational timeline. Orders, inventory, purchasing, capacity/ETA engine, QR cards, notifications, delivery and 3D are **not** part of this phase.

## 1. Model

| Model | Purpose |
|---|---|
| `FactoryJob` (`JOB-000001`) | One unit of production. `sourceType` (SAMPLE now; ORDER / ORDER_BATCH reserved), `sampleId`, **pinned** `sampleProductionSpecId` and `workflowTemplateVersionId`, status, priority, hold/cancel fields. Customer/brand/product are copied from the frozen spec for filtering. |
| `ProductionStageDefinition` | Configurable catalogue (10 seeded stages): department, expected duration, `requiresAssignment`, `requiresCompletionNote`, `requiresAttachment`, `isQcStage`, `eligibleRoleCodes` (role codes are data). |
| `WorkflowTemplate` → `WorkflowTemplateVersion` → `WorkflowTemplateStage` (+ `…StageDependency` edges) | Versioned workflow. Only DRAFT versions are editable; ACTIVE/ARCHIVED are frozen by triggers. One default template, one ACTIVE version per template. Seed: `BENUE_STANDARD_APPAREL` v1. |
| `JobStage` (+ `JobStageDependency`) | Concrete stage occurrence. Snapshot of the definition flags, `attempt`, `readyAt`/`dueAt`/`startedAt`/`completedAt`, `isOnHold`, `supersededAt`. Dependencies are explicit edges, not "sequence + 1". |
| `StageAssignment` | Several assignees per stage, one primary, removal keeps history. |
| `Blocker` | First-class (stage or whole job): type, description, OPEN/RESOLVED/CANCELLED. |
| `ReworkRecord` | Failed gate → target stage; links the new occurrences. |
| `QcTemplate` / `QcChecklistItemDefinition` / `QcInspection` / `QcInspectionResult` | Configurable, versioned checklists (PASS_FAIL, TEXT, NUMBER, MEASUREMENT, PHOTO_REQUIRED); inspections pin the template version. Photos are `AssetAttachment` rows on the inspection. |
| `JobActivity` | Append-only operational timeline (who did what, when) — distinct from the security `AuditLog`. |
| `JobNote` | Internal notes (visibility `INTERNAL` only). |
| `AssetAttachment` | Now has 10 targets incl. `FACTORY_JOB`, `JOB_STAGE`, `QC_INSPECTION` (real FKs + exactly-one-target CHECK). |

## 2. Creating a job

**Phase 4.1 correction: the factory builds the physical sample *before* the customer's final approval.**

`POST /admin/samples/:id/create-factory-job` (`factory_jobs.manage`) creates a `SAMPLE_PRODUCTION` job. Requires: the sample is `READY_FOR_PRODUCTION` (reviewed, quoted, accepted, paid) with `paymentState = PAID` — or `IN_PRODUCTION` with **no live job** (the previous job was cancelled, or the customer sent the sample back); an accepted quotation, an approved pattern and approved required artwork (the same freeze checks as final approval); no live job for the sample; and an ACTIVE version of the chosen (or default) template. Final customer approval is **not** required.

In one transaction under the sample row lock it:
1. freezes a **`PRE_PRODUCTION` specification** (`SampleProductionSpec.kind`, `approvalId = null`, snapshot `approval = null`, SHA-256 `specHash`; append-only) — what the physical sample is built from; later master-data edits cannot reach it, and the hash is re-verified;
2. creates the job pinning that spec and the workflow version, the stages and the dependency edges, the `JOB_CREATED` activity and the `factory_job.created` audit entry;
3. moves the sample `READY_FOR_PRODUCTION → IN_PRODUCTION` (`start-production`, audited).

A database trigger refuses a `SAMPLE_PRODUCTION` job that pins anything but a `PRE_PRODUCTION` spec. `release:false` creates the job `PLANNED`; `POST …/release` makes root stages READY. "Live" means neither `CANCELLED` nor `COMPLETED` (partial unique index), so a finished job stays on record and a rejected sample can be built again.

### Two kinds of specification

| Kind | Frozen when | Used for |
|---|---|---|
| `PRE_PRODUCTION` | a `SAMPLE_PRODUCTION` job is created | manufacturing the physical sample |
| `APPROVED_REFERENCE` | the customer approves the physical sample (`AWAITING_APPROVAL → APPROVED`) | later bulk production (Phase 5); `GET …/production-spec` returns only this kind, `…/production-specs` lists both |

### Sample ↔ job lifecycle

* Job `COMPLETED` (all stages done, or admin force-complete) → the sample goes `IN_PRODUCTION → AWAITING_APPROVAL` automatically (`finish-production`, audited, actor = whoever finished the job). It is **never** approved automatically. If the sample is held, cancelled or already moved on, it is left alone.
* While a live job exists the manual `start-production` / `finish-production` endpoints answer 409: the factory drives the sample. They remain only for sample-making without a job (and for older flows/tests).
* Approval rejected → sample back to `IN_PRODUCTION` (existing Phase 3 rule) and a **new** job (new `PRE_PRODUCTION` revision, new stages) can be created; the old job, its QC, rework, activity, blockers, assignments and files are untouched.
* A revised sample (`POST …/revise`) is a new sample; once quoted and paid it gets its own job and spec.
* `sourceType` is `SAMPLE_PRODUCTION` today; `BULK_ORDER` and `ORDER_BATCH` are reserved for Phase 5 (bulk jobs will pin an `APPROVED_REFERENCE`).

## 3. Stage state machine

`WAITING → READY → IN_PROGRESS → COMPLETED`, plus `BLOCKED` (returns to the status it came from), `FAILED` (QC), `SKIPPED`, `CANCELLED`. Actions are named (`make-ready`, `start`, `complete`, `force-complete`, `fail`, `block`, `unblock`, `skip`, `cancel`) in `pure/job-stage-state-machine.ts` and re-checked by a DB trigger. A stage becomes READY when every dependency is COMPLETED/SKIPPED; completing one unlocks dependents (parallel branches join naturally). Job status is derived (`pure/job-status.ts`): PLANNED/READY/IN_PROGRESS/BLOCKED/COMPLETED automatically; ON_HOLD/CANCELLED are explicit. The job completes when every current required stage is done.

* Staff start/complete only stages they are assigned to. A stage with `requiresAssignment=false` (READY) is claimed by the first eligible-role worker who starts it.
* `requiresCompletionNote`, `requiresAttachment` are enforced on completion. QC stages complete only through their inspection.
* Hold: stage hold is a flag (state kept); job hold is `ON_HOLD` and remembers the previous status.
* **Delay is derived**: open stage with `dueAt < now` (`dueAt = readyAt + expectedDurationMinutes`). Never stored as a status.

## 4. Blockers

Raised on READY/IN_PROGRESS stages by an assignee (`stages.block`) or by admins (stage or job level). Several may be open; the stage returns to its prior status when the last open blocker is resolved/cancelled. A job-level blocker stops all work. Resolution: the reporter, an assignee, or an admin.

## 5. QC and rework

Start (`/staff/job-stages/:id/qc/start`, assigned + `qc.perform`, stage IN_PROGRESS) → record results (`PUT …/results`, repeatable) → attach photos → complete with PASS / CONDITIONAL_PASS / FAIL. Required items must be answered; required PHOTO_REQUIRED items need that many photos; PASS is refused if any item failed; FAIL/CONDITIONAL_PASS need notes. PASS/CONDITIONAL_PASS complete the stage. **FAIL creates rework without rewriting history:** the failed gate becomes `FAILED` + superseded, the target stage (default: the non-QC stage the gate checked, or an explicit `reworkTargetStageCode`) gets a new occurrence (attempt+1, READY, assignees copied), a new re-check occurrence of the gate depends on it, and waiting downstream edges move to the re-check. The `ReworkRecord` goes OPEN → IN_PROGRESS (redo started) → RESOLVED (redo completed). Admins can also send work back from an IN_PROGRESS stage (`rework.manage`). Intermediate completed stages between target and failed stage are not repeated automatically; chain another rework if needed. Checklists are immutable; `POST /admin/qc-templates` publishes version N+1 (running inspections keep theirs).

## 6. Staff views

`/staff/my-jobs`, `/staff/my-stages` (open stages by default), `/staff/job-stages/:id` (alias `/staff/my-stages/:id`). The detail returns a **department-specific task view built from the frozen spec** (`pure/task-view.ts`): never prices, quotations, payments, terms, approvals, customer contact data or storage keys, plus blockers, notes, files, `allowedActions` and the QC inspection. Files are fetched with short-lived URLs from `/staff/job-stages/:id/files/:assetId/download-url` (only files the stage shows). Unassigned staff get 404/403. Evidence upload: `POST /staff/job-stages/:id/assets` and `/staff/qc-inspections/:id/photos` (multipart; same content sniffing/size limits as Phase 2). Evidence is part of the record: it cannot be archived or detached.

## 7. Admin API

Tags: Factory Jobs, Production Board, Workflow Templates, Production Stages, Stage Assignments, Blockers, QC, Rework, Production Timeline, Staff Factory Tasks.

* Jobs: create from sample, list/get (filters: search, status[], priority, customer, brand, product type, delayed, dates, sort), release, priority, hold/resume/cancel, force-complete, internal notes, notes, timeline, stages, blockers, rework, QC inspections.
* Stages: get, assign/unassign, hold/resume, override (complete|skip), manual rework, blockers, unblock; blocker resolve/cancel.
* Workflow/QC admin: templates, versions, stage definitions, QC templates.
* **Board** `GET /admin/production/board`: a column per stage with per-status counts and up to `columnLimit` cards (priority, then due date); `stageCode` pages a single column. Filters: status, assigned user, unassigned, priority, delayed, blocked, product type, customer, brand, dates.

## 8. Permissions (45 total; 10 new)

New: `factory_jobs.manage`, `production_board.read`, `workflow_templates.read/manage`, `stages.block`, `stages.override`, `qc.read`, `qc.manage`, `rework.manage`, `production_notes.create`. Reused: `jobs.read_assigned`, `jobs.read_all`, `jobs.assign`, `stages.start`, `stages.complete`, `qc.perform`. Grant batch `phase4-factory` (applied once to existing roles; admin edits are never overwritten): ADMIN all new; SALES `production_board.read`; floor roles `stages.block` + `production_notes.create`; QC also `qc.read`; FINANCE none. SUPER_ADMIN holds everything. Overriding a QC gate additionally needs `qc.manage`; attaching production files through the generic asset API needs `production_notes.create`.

## 9. Audit vs timeline

`JobActivity` (append-only, actor-stamped) records every routine floor event (ready, assigned, started, completed, blocked, QC, rework, notes, files). `AuditLog` records administrative/security events: job created/released/priority/held/resumed/cancelled/force-completed, assignments, stage hold/resume/override, admin blocker actions, QC template publication and QC override, manual rework, workflow/stage-definition changes. No file contents, note texts or tokens are logged.

## 10. Concurrency and integrity

Every job mutation takes `SELECT … FOR UPDATE` on the job row (sample row for creation), so start/complete/blocker/QC/rework on one job never interleave. Database constraints: one live job per sample, exactly-one source, stage-transition whitelist and immutable identity/once-set timestamps (trigger), one active/primary assignment, one live inspection per stage, finished inspections/results immutable, template/checklist immutability, append-only `job_activities`, no deletes of stages/blockers/inspections. Covered by concurrent-request tests (job creation, double start, double complete, QC completion, blocker resolution, job numbers).

## 10b. Phase 5A additions

`BULK_ORDER` / `ORDER_BATCH` jobs, job quantities, `StageProductionReport`, bulk QC quantities and quantity-aware rework are described in `PHASE_5A_BULK_ORDERS_PRODUCTION.md`. The trigger on `factory_jobs` now enforces the source/spec combination for all three job types, and `JobEngineService.lockJob` locks an order job's order first. Sample-production jobs are unchanged (no planned quantity, no reports).

## 11. Decisions affecting Phase 5

* A job's source is generic (`sourceType` SAMPLE_PRODUCTION / BULK_ORDER / ORDER_BATCH + one nullable FK + CHECK); add `order_id` / `order_batch_id` and extend the CHECK/unique index for orders. Bulk jobs must pin an `APPROVED_REFERENCE` spec (extend the spec-kind trigger).
* Quantity/variants are not modelled on jobs yet (a sample job is one piece); order jobs will need them.
* `dueAt` is a simple per-stage clock; no capacity/ETA engine.
* Delivery stage is not in the seeded workflow (READY is the last stage).
* Notifications and customer-visible progress are not implemented; derive customer progress from stage status later.
