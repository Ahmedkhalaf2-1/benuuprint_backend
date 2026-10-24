# Workflows (planned concepts)

The **sample lifecycle (section 1) is implemented in Phase 3** (see `PHASE_3_SAMPLE_COMMERCIAL_WORKFLOW.md` for the exact transition table). The factory production workflow (section 2) is **implemented in Phase 4** (see `PHASE_4_FACTORY_OPERATIONS.md` for the stage state machine, dependencies, QC and rework rules; the concept below is kept as the design rationale).

## 1. Sample lifecycle

A Sample moves through explicit states via named actions. Each transition is validated by a service-level state machine, recorded in the Activity Log, and audited.

| State | Meaning |
|---|---|
| `DRAFT` | Being prepared; editable by its creator; not visible to the factory. |
| `SUBMITTED` | Sent for review. |
| `UNDER_REVIEW` | Staff are assessing feasibility and cost. |
| `QUOTED` | A quotation has been issued to the customer. |
| `AWAITING_PAYMENT` | Customer accepted; waiting for payment. |
| `READY_FOR_PRODUCTION` | Payment verified; ready to create the sample-production job. |
| `IN_PRODUCTION` | Sample-production factory job in progress. |
| `AWAITING_APPROVAL` | Produced sample awaiting customer/internal approval. |
| `APPROVED` | Sample approved (specification version locked). |
| `COMPLETED` | Finished and delivered/closed. |
| `ON_HOLD` | Temporarily paused (records reason and previous state). |
| `REJECTED` | Declined (by staff or customer), with reason. |
| `CANCELLED` | Withdrawn; terminal. |

Main path:

```
DRAFT → SUBMITTED → UNDER_REVIEW → QUOTED → AWAITING_PAYMENT → READY_FOR_PRODUCTION
      → IN_PRODUCTION → AWAITING_APPROVAL → APPROVED → COMPLETED
```

Side transitions: `ON_HOLD` is reachable from any non-terminal state and resumes to the prior state; `REJECTED` from review/quote/approval states; `CANCELLED` from any non-terminal state. `COMPLETED`, `REJECTED`, `CANCELLED` are terminal (re-opening is a new record or an audited admin action).

Rules: transitions are actions (not free-form status edits); guards check permissions and preconditions; the allowed-transition table lives in `sample-state-machine.ts` and is covered by tests. Implemented specifics: `SUBMITTED → UNDER_REVIEW` is `review`; `QUOTED`, `AWAITING_PAYMENT`, `READY_FOR_PRODUCTION`, `APPROVED` are reached automatically by sending/accepting a quotation, verifying payments and recording the customer's approval; `request-changes` returns a sample to `DRAFT`; `IN_PRODUCTION`/`AWAITING_APPROVAL` are driven by the **sample-production factory job**: creating the job (from a paid `READY_FOR_PRODUCTION` sample, freezing a `PRE_PRODUCTION` spec) starts production and completing it moves the sample to `AWAITING_APPROVAL`; the customer's approval of the physical sample then freezes the `APPROVED_REFERENCE` (see `PHASE_4_FACTORY_OPERATIONS.md` §2).

## Bulk orders *(Phase 5A)*

`SAMPLE_PRODUCTION job → physical sample → customer approval → APPROVED_REFERENCE → Order (DRAFT → PENDING_CONFIRMATION → CONFIRMED → READY_FOR_PRODUCTION → IN_PRODUCTION ⇄ PARTIALLY_COMPLETED → PRODUCTION_COMPLETED) → BULK_ORDER job, or batches → ORDER_BATCH jobs`. Stages account for units (produced + rejected must equal what the stage handles), QC failures send back only the failed units, and order status follows the jobs. Details in `PHASE_5A_BULK_ORDERS_PRODUCTION.md`; delivery is Phase 5B.

## Fulfilment *(Phase 5B)*

`PRODUCTION_COMPLETED → READY_FOR_DELIVERY (packaging spec + all units packed) → PARTIALLY_SHIPPED / OUT_FOR_DELIVERY (shipments dispatched) → DELIVERED (every deliverable unit delivered) → COMPLETED (explicit close: nothing open, paid)`. Shipments run `DRAFT → READY → DISPATCHED → IN_TRANSIT → DELIVERED`, with `FAILED` (retry or return), `RETURNED` and `CANCELLED`; partial shipments allocate variant quantities and can never exceed what is produced and packed. Order statuses after production are derived from these facts. Customers follow progress through a tokenised, rate-limited public tracking link. Details in `PHASE_5B_FULFILLMENT_DELIVERY.md`.

**Order revision → re-quotation *(Phase 5B.1)*:** a commercially relevant revision (quantity, variant split, items, reference) supersedes every live quotation version of the order (history kept), pulls a `READY_FOR_PRODUCTION` order back to `CONFIRMED`, and requires a new quotation + recorded customer decision before `mark-ready` can pass again. Verified payments carry forward onto the new quotation. Non-commercial revisions (notes, target date, shade details) leave the accepted quotation valid. Details: `PHASE_5B_FULFILLMENT_DELIVERY.md` §7.1.

## Management intelligence *(Phase 6A)*

Delay, SLA, Needs Attention, KPIs, workload, capacity utilization and ETA are evaluated on request from operational data; they never move a job, stage or
order. A job is delayed by an overdue stage, an open blocker or a passed target date; an order by a passed delivery date, a delayed job/batch or a
failed/overdue shipment. SLA deadlines come from the operational dates first and from SLA rules as the fallback. ETA is the critical path over the remaining
stages using historical averages (≥ 5 samples) or configured durations, with an explicit data-quality level. Full definitions:
`PHASE_6A_MANAGEMENT_INTELLIGENCE.md`.

## Automation *(Phase 6B)*

Domain event → outbox (same transaction) → planner (rules, preferences, templates, quiet hours) → notification → provider with retry. A scheduler turns Needs Attention into alerts: open once, announce a higher severity once,
escalate each level once (working minutes), resolve when the condition disappears. Tech packs: generate (DRAFT) → issue (supersedes the previous issued version) → superseded; a changed source makes the issued version stale.
QR: generate / rotate / revoke the job's token; a scan identifies the job, the signed-in person's assignments decide the rest.

## 2. Factory production workflow *(implemented in Phase 4)*

Business flow: Draft → Submitted → Commercial review → Quotation → Payment → production-ready spec frozen → **SAMPLE_PRODUCTION job** → physical sample complete → customer reviews → customer approves → final approved reference frozen → (Phase 5) bulk orders use that reference.

Reference sequence for a standard job:

```
Fabric → Pattern Making → Cutting → QC Gate 1 → Printing / Embroidery
       → QC Gate 2 → Sewing → QC Gate 3 → Packaging → Ready → Delivery
```

### Architecture rule: production is NOT one status field

A single `status` column cannot represent per-stage ownership, timing, blockers, rework, or non-linear flows. Production is modelled as a graph of stages owned by a job:

| Concept | Role |
|---|---|
| **Job** | One unit of production for a Sample/Order. Holds overall progress (derived from its stages, not authoritative on its own). |
| **WorkflowTemplate** | Admin-configurable definition of stages, order, gates and dependencies. A job **snapshots** the template when created, so later template edits never alter in-flight jobs. |
| **JobStage** | A concrete stage instance: type, sequence/dependencies, `StageStatus`, planned/actual timestamps. |
| **StageAssignment** | Who is responsible (user/team), with history of reassignments. |
| **StageStatus** | e.g. `PENDING`, `READY`, `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, `SKIPPED`, `REWORK` (final set decided in Phase 3). |
| **Blockers** | Records of why a stage cannot proceed (missing fabric, awaiting approval, machine down), with owner, raised/resolved timestamps. |
| **Stage timestamps** | `readyAt`, `startedAt`, `completedAt`, plus due dates; used for lead-time reporting. |
| **Stage notes** | Time-stamped, authored comments per stage. |
| **Stage attachments** | Files (photos, proofs, work instructions) linked to a stage via the Files/Assets domain. |
| **Rework** | A failed QC gate reopens one or more earlier stages (new attempt, retained history, reason, counter) rather than overwriting prior results. |

### Design requirements

- **A stage becomes `READY` when its dependencies are completed** (and gates passed); only assigned users with `stages.start` can start it.
- **QC gates are stages** with pass/fail outcomes; failure creates rework against specific stages.
- **Configurable workflows (later):** templates can add, remove or reorder stages per product type/print method (e.g. skip Printing for plain garments, add Embroidery).
- **Possible parallel stages (later):** stage dependencies are stored as edges (a stage may depend on several others), so parallel branches (e.g. Fabric ‖ Pattern Making) need no schema redesign. Phase 3 may start linear, but must not hard-wire "next = sequence + 1".
- **History is append-only:** stage transitions emit Activity Log entries and audit records; attempts are never overwritten.
- **Customer visibility:** the portal shows a simplified, derived progress view; blockers, internal notes and QC details stay internal unless flagged.
