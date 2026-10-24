# Phase 5A — Bulk Orders and Production Control

Builds the bulk-manufacturing foundation on top of Phases 3–4.1: orders pinned to an approved production reference, items and variants, confirmation and controlled revision, production batches, bulk factory jobs, quantity-aware reporting, bulk QC, quantity-aware rework, progress summaries and reorders. **Not included (Phase 5B):** packaging fulfilment, shipments, delivery, public tracking, courier integration, delivery completion, order payments, notifications, inventory, purchasing, analytics, capacity planning, QR, 3D.

## 1. The rule that matters

```
SAMPLE_PRODUCTION job → physical sample → customer approval → APPROVED_REFERENCE → Order → BULK_ORDER / ORDER_BATCH job
```

Bulk production uses the `APPROVED_REFERENCE` and **never** a `PRE_PRODUCTION` spec. This is enforced by triggers, not only by services:

| Where | Rule |
|---|---|
| `orders` insert trigger | `approved_production_spec_id` must be `kind = APPROVED_REFERENCE` and belong to the order's source sample |
| `orders` update trigger | order number, customer, brand, source sample, approved reference, `reorder_of` and creator are immutable; CANCELLED is terminal; confirmed/cancelled timestamps are set once |
| `order_items` insert trigger | an item uses the order's approved reference |
| `factory_jobs` insert triggers | `SAMPLE_PRODUCTION` → `PRE_PRODUCTION`; `BULK_ORDER` / `ORDER_BATCH` → `APPROVED_REFERENCE` **and** an `order_production_spec` of the same order and reference; a batch job's batch belongs to the job's order; whole-order and batch jobs never overlap |
| `factory_jobs` CHECK | exactly the right source columns per source type, `planned_quantity` required for bulk jobs and null for samples |
| unique indexes | one non-cancelled `BULK_ORDER` job per order; one non-cancelled job per batch; one live job per sample |

### Traceability

`SampleProductionSpec.sourceFactoryJobId` (nullable FK, only on `APPROVED_REFERENCE`, written at insert because specs are append-only) links the approved reference to the `SAMPLE_PRODUCTION` job that built the approved physical sample: **Sample → revision → SAMPLE_PRODUCTION job → customer approval → APPROVED_REFERENCE → Order**. It is exposed on the spec responses and on the order's `approvedReference`. It is null when the sample was made without a job (manual stand-ins).

## 2. Model

| Model | Purpose |
|---|---|
| `Order` (`ORD-000001`) | customer, brand, `sourceSampleId`, pinned `approvedProductionSpecId`, `reorderOfOrderId`, status, priority, `revisionNumber`, `currentSpecId`, target delivery date, hold/cancel fields, sales owner, internal notes |
| `OrderItem` | `approvedProductionSpecId`, product name snapshot, product type, quantity, notes. The API writes one product per order today; the table allows several |
| `OrderVariant` | size (catalogue **or** custom), colour (catalogue **or** custom + pantone/hex), `quantity`, `completedQuantity`, `rejectedQuantity` |
| `OrderProductionSpec` | what the order commits the factory to: approved baseline + order-specific choices (quantities, size/colour breakdown, item notes), frozen at confirmation with a SHA-256 hash; append-only; `(order, revision)` unique |
| `OrderRevision` | controlled change of a confirmed order: revision number, reason, actor, `previousSnapshot`, link to the new spec; append-only |
| `OrderBatch` (`BAT-000001`) + `OrderBatchVariant` | a production batch and its per-variant allocations |
| `OrderActivity` | order timeline, separate from `AuditLog` and `JobActivity`; append-only |
| `StageProductionReport` | append-only quantity report on a stage occurrence (produced / rejected / rework, optional variant) |
| `FactoryJob` (extended) | `orderId`, `orderBatchId`, `orderProductionSpecId`, `plannedQuantity`, `completedQuantity`, `rejectedQuantity` |
| `ReworkRecord` / `QcInspection` (extended) | `affectedQuantity`; `inspectedQuantity` / `passedQuantity` / `failedQuantity` |

Migration: `20261021120000_bulk_orders_production` (generated SQL + hand-written triggers, CHECKs and indexes). Indexes cover order number/customer/brand/status/priority/sales user/target date/created date, variant item/size/colour, batch number/order/status and activity (order, time).

## 3. Orders

`POST /admin/samples/:id/create-order` (`orders.manage`): the sample must be `APPROVED` (or `COMPLETED`, i.e. closed after approval), have an `APPROVED_REFERENCE` whose hash still matches, and the customer and brand must be `ACTIVE`, not archived, and match. Creates a `DRAFT` order, optionally with starting items.

### Status machine (`orders/pure/order-state-machine.ts`, data-driven, unit-tested)

```
DRAFT ─submit→ PENDING_CONFIRMATION ─confirm→ CONFIRMED ─ready→ READY_FOR_PRODUCTION
  ─(job starts)→ IN_PRODUCTION ⇄ PARTIALLY_COMPLETED ─(all units covered)→ PRODUCTION_COMPLETED
hold/resume (reason on hold) · cancel (reason) · request-changes (PENDING → DRAFT)
```

`production-started / -partial / -completed / -reset` are system actions derived from jobs and batches (`OrderSyncService`); nobody sets them. There are no delivery statuses yet. Every change goes through `OrderTransitionsService` (state machine + timeline entry).

### Items, variants and confirmation

`PUT /admin/orders/:id/items` (DRAFT only) replaces items and variants: rows with an id are updated in place, rows without are created, missing rows are removed (so history that references a variant stays valid). Per-row rules apply even to drafts: catalogue size XOR custom size, catalogue colour XOR custom colour, at least a size or a colour, positive integer quantities, no duplicate combination, catalogue colours must belong to **the approved sample's fabric** (another fabric is a different material and needs a new sample). Totals are *not* checked in a draft.

`POST …/confirm` (`orders.confirm`) recomputes everything on the server: at least one item, every item has variants, every item's quantity equals the sum of its variants, positive quantities; the approved reference is re-verified; customer/brand still active. It freezes an `OrderProductionSpec` revision 1 (size/colour names are snapshotted, so master-data edits can't change it) and moves the order to `CONFIRMED`. Confirmation is race-safe (order row lock): concurrent confirms produce one spec.

### Revisions

`POST …/revise` (reason required) on a confirmed order, history preserved (`OrderRevision` + a new spec revision; the previous spec stays):

* quantities / variants may change **only** before production starts and **while no batch and no non-cancelled job exists** (cancel them first);
* once production has started (`IN_PRODUCTION`, `PARTIALLY_COMPLETED`, …) only the target delivery date and notes can be revised;
* a draft is edited directly, a held order must be resumed first.

### Priority, hold, cancel

`PATCH …/priority` is audited and pushed to live jobs (each job gets a `PRIORITY_CHANGED` activity); jobs inherit the order's priority at creation. A held order stops floor work: `assertOperable` refuses start / complete / report / QC on its jobs. Cancelling needs a reason, cancels the live jobs (`cancelInTx`) and batches, and **keeps** all stages, reports, QC, rework, activity and files.

## 4. Batches

`POST /admin/orders/:id/batches` (`order_batches.manage`) plans a batch from `{orderVariantId, quantity}` allocations on a confirmed, not-held, unfinished order with no whole-order job. The batch quantity is the sum of its allocations.

**Over-allocation is impossible, including under concurrency:** the service gives clear messages, and a database trigger on `order_batch_variants` locks the variant row (`FOR UPDATE`), re-sums the non-cancelled allocations and rejects the loser. A trigger also stops a variant shrinking below what batches hold. Cancelling a batch frees its units.

Batch status: `PLANNED → READY` (explicit; needs a released order and a valid allocation) `→ IN_PRODUCTION → PARTIALLY_COMPLETED → COMPLETED`, plus `ON_HOLD` and `CANCELLED`; production states are derived from the batch's job. Allocations change only while `PLANNED`.

## 5. Bulk factory jobs

* `POST /admin/orders/:id/create-factory-job` → `BULK_ORDER`, `plannedQuantity` = order total. Needs `READY_FOR_PRODUCTION`, a frozen order spec, **no batches** and no other job.
* `POST /admin/order-batches/:id/create-factory-job` → `ORDER_BATCH`, `plannedQuantity` = batch quantity. Needs a `READY` batch with a valid allocation and **no whole-order job**.

Both require `factory_jobs.manage`, verify the approved reference **and** the order spec hashes, lock the order first, and use the shared `FactoryJobsService.instantiate` (same workflow, stages, QC, timeline as sample jobs). Locking order is always **order → job** (`lockJob` takes the order lock first for order jobs), so order-level and job-level operations cannot deadlock. Priority and target date are inherited (batch target date wins when set).

## 6. Quantities

A bulk job has `plannedQuantity`; a sample job has none and behaves exactly as before.

* **Required units of a stage occurrence** = `planned − units scrapped by earlier stages (any attempt)`, or, for an occurrence created by rework, the rework's `affectedQuantity`.
* **Reports** (`POST /staff/job-stages/:id/production-reports`, `production_quantity.report`, assigned staff only, stage `IN_PROGRESS`) add `producedQuantity`, `rejectedQuantity`, `reworkQuantity` (informational flag) and optionally an `orderVariantId`. They are append-only (trigger). The service locks the job and refuses any report that would push `produced + rejected` above the required units, so over-reporting is impossible under concurrency.
* A stage **cannot complete** until every required unit is accounted for (`produced + rejected = required`). Admin override/force-complete bypass this deliberately and are audited.
* Partial production: 500 units can be reported as 300 then 200.
* `completedQuantity` of the job = units produced by the final stage (capped at planned − rejected); `rejectedQuantity` = all scrapped units. Variant counters update from **final-stage** reports that name the variant (capped by the variant's quantity or batch allocation).
* QC stages take quantities through their inspection, not reports.

## 7. Bulk QC and rework

`complete` on a bulk inspection requires `inspectedQuantity` (must equal the units the gate handles), `passedQuantity` and `failedQuantity` (sum = inspected; DB CHECK). Any failed unit forces result `FAIL`; `FAIL` needs at least one failed unit and notes. No AQL sampling is implemented; the three columns leave room for it.

A `FAIL` creates rework with `affectedQuantity = failedQuantity`: the redone stage and the QC re-check occurrences handle **only those units** — e.g. 500 printed, 20 fail → 20 are redone and re-inspected, the other 480 are not restarted. Downstream stages wait for the re-check (the Phase 4 dependency rule) and then handle `planned − scrapped` units. Manual admin rework on a bulk job needs `affectedQuantity` (1 … units the stage handles). The rework record is `OPEN → IN_PROGRESS → RESOLVED` as before.

## 8. Order status from production

`OrderSyncService` (called by the job engine after every job/quantity change, order lock held) keeps batches and the order in step: job starts → `IN_PRODUCTION`; units through the final stage but not all covered → `PARTIALLY_COMPLETED`; every unit covered → `PRODUCTION_COMPLETED` (a whole-order job completed, or batches that together hold the full quantity and are all completed); a cancelled job returns the order/batch to `READY…`. A finished order never moves back.

## 9. Production summary

`GET /admin/orders/:id/production-summary`: total / completed / rejected / remaining / rework (units currently sent back) / rework-flagged units, batches, jobs, active / blocked / delayed stages, each job's current stage with `required` and `accounted`, target date and `isPastTargetDate`. `progressPercent` = units through the final stage ÷ units that can still be delivered (total − rejected). It is **not** an average of stage percentages (a line where cutting is 100% and sewing 0% is 0%, not 50%).

## 10. Reorders

`POST /admin/orders/:id/reorder` (`orders.reorder`): requires a previously confirmed order. Creates a new `DRAFT` with `reorderOfOrderId`, the same customer/brand/sample/approved reference, and (default) a copy of the quantities and size/colour breakdown with zeroed counters. It never copies jobs, batches, QC, rework, reports, payments, activities or future shipment records. Both orders get a timeline entry; the reorder is audited.

| Simple changes (allowed on the draft) | Major changes (rejected — they need a new sample and approval) |
|---|---|
| quantities, size breakdown, colour selections of the approved fabric, custom colours/sizes, target date, notes | fabric, construction, fit, pattern, print method, unapproved artwork |

Major changes are not order fields at all: the API's strict DTOs answer 400 to `fabricId`, `patternVersionId`, `printMethodId`, `fitMethod`, `artworkId`, …, and a colour of another fabric is rejected.

## 11. Permissions (53 total; 8 new)

`orders.read`, `orders.manage`, `orders.confirm`, `orders.cancel`, `orders.reorder`, `order_batches.read`, `order_batches.manage`, `production_quantity.report`. Grant batch `phase5a-orders` (applied once, never overwrites admin edits):

| Role | Grants |
|---|---|
| SUPER_ADMIN / ADMIN | all eight |
| SALES | `orders.read/manage/confirm/reorder`, `order_batches.read` (no cancel, no batch planning, no job creation) |
| FINANCE | `orders.read` |
| Floor roles (incl. QC) | `production_quantity.report` (only on stages assigned to them) |

Creating bulk jobs needs `factory_jobs.manage` (ADMIN); the production summary needs `orders.read`.

## 12. API (`/api/v1`)

Swagger tags: Orders, Order Batches, Production Quantities (plus Factory Jobs, QC, Rework).

| Area | Endpoints |
|---|---|
| Orders | `POST /admin/samples/:id/create-order`, `GET /admin/orders`, `GET/PATCH /admin/orders/:id`, `PUT …/items`, `PATCH …/priority`, `POST …/{submit,request-changes,confirm,revise,ready,hold,resume,cancel,reorder}`, `GET …/{production-summary,activities,revisions,production-specs}` |
| Batches | `GET/POST /admin/orders/:id/batches`, `GET /admin/order-batches/:id`, `PUT …/allocations`, `POST …/{ready,hold,resume,cancel}` |
| Bulk jobs | `POST /admin/orders/:id/create-factory-job`, `POST /admin/order-batches/:id/create-factory-job`; jobs list filters `sourceType`, `orderId` |
| Quantities | `POST/GET /staff/job-stages/:id/production-reports`, `GET /admin/job-stages/:id/production-reports`; staff stage detail gains `quantity` and `orderView` (frozen size/colour breakdown, narrowed to the batch; no prices or customer data) |

## 13. Audit vs timelines

`AuditLog`: order created / updated / items changed / submitted / confirmed / revised / marked ready / held / resumed / cancelled / priority / reordered; batch created / allocated / ready / held / resumed / cancelled; bulk `factory_job.created` (with source, quantity and spec ids). `OrderActivity`: ORDER_CREATED, ORDER_UPDATED, ORDER_SUBMITTED, ORDER_CONFIRMED, ORDER_REVISED, PRODUCTION_READY, PRODUCTION_STARTED, BATCH_CREATED, BATCH_UPDATED, BATCH_STARTED, PRODUCTION_COMPLETED, ORDER_HELD, ORDER_RESUMED, ORDER_CANCELLED, PRIORITY_CHANGED, JOB_CREATED, REORDER_CREATED. Routine quantity reports go to `JobActivity` (`QUANTITY_REPORTED`). No notes text, prices or tokens in audit metadata.

## 14. Known limitations

* Orders have no payment/price model yet (Phase 5B decides how order commercials and deposits integrate); confirmation checks production conditions only.
* One product per order through the API (the schema allows several items).
* Per-variant production tracking exists only where reports name a variant on the final stage; otherwise counters stay at 0 and job-level totals are authoritative.
* Revisions that change quantities require cancelling batches/jobs first; after production starts they are refused.
* A rework target must be a completed non-QC stage earlier than the failed stage; stages in between are not repeated automatically.
* Downstream stages wait for a rework re-check; the 480 good units do not move ahead while 20 are redone.
* Delay/ETA is derived from stage due dates only (no capacity planning).

## 15. Decisions affecting Phase 5B *(all implemented — see `PHASE_5B_FULFILLMENT_DELIVERY.md`)*

* Add packaging/fulfilment stages and shipments on top of `PRODUCTION_COMPLETED` / `PARTIALLY_COMPLETED`; batch completion gives natural partial-shipment boundaries (`OrderBatchVariant` / variant `completedQuantity`).
* Order statuses stop at production; delivery statuses extend `OrderStatus` and the state-machine table.
* `OrderActivity` and the order lock (`OrderTransitionsService.lock`) are the extension points for delivery events and concurrency.
* Reports can name variants, so shipments can later allocate per variant.
