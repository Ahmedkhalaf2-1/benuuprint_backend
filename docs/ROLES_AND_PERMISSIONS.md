# Roles and Permissions

## Principle

Authorization is **data-driven RBAC**. Code checks **permissions**, never role names. Roles are rows in the database that group permissions, so new custom roles can be created later without a deploy.

> Forbidden: `if (user.role === 'ADMIN')`, `@Roles('SALES')`.
> Required: `@RequirePermissions('samples.manage')`, enforced by a guard on the server.

> **Status: implemented in Phase 1.** See `PHASE_1_ACCESS_CONTROL.md` for the shipped model, seeded matrix and security decisions. The sections below remain the design rationale; where they differ, Phase 1 wins.

## Data model

| Table | Purpose |
|---|---|
| `Role` | id, key (e.g. `SALES`), name, description, `isSystem`, timestamps. System roles can't be deleted; custom roles can. |
| `Permission` | id, key (e.g. `samples.manage`), description, group. Seeded from a code-defined catalogue. |
| `UserRole` | userId, roleId (many-to-many; a user may hold several roles). |
| `RolePermission` | roleId, permissionId (many-to-many). |

- A user's effective permissions are the **union** of the permissions of all their roles.
- Permission keys are the contract between code and data: code defines the catalogue, a seed/sync step upserts it, admins assign permissions to roles.
- Role/permission changes are audited and take effect on the next request (or token refresh, whichever the auth design chooses).
- `SUPER_ADMIN` is seeded with every permission; "all permissions" is expressed by data (re-synced by the seed on every run), not by a bypass in guards. Phase 1 implements **no bypass**.
- Escalation guard: an actor can only grant, revoke or manage permissions they hold themselves.
- Customer-portal users are a separate principal type and are scoped by ownership, not by staff permissions.

## Planned system roles (default seed)

| Role | Intent |
|---|---|
| SUPER_ADMIN | Full system control, including roles and settings. |
| ADMIN | Day-to-day administration; users, customers, reports. |
| SALES | Customer relationship, samples, quotations. |
| FABRIC | Fabric sourcing/preparation stage. |
| PATTERN_MAKER | Pattern-making stage. |
| CUTTING | Cutting stage. |
| PRINTING | Printing / embroidery stage. |
| SEWING | Sewing stage. |
| QC | Quality inspections at all gates. |
| PACKAGING | Packaging stage. |
| DELIVERY | Dispatch and delivery. |
| FINANCE | Payments verification and financial reports. |

These are defaults only; their permission sets below are editable data.

## Phase 4 factory permissions

`factory_jobs.manage`, `production_board.read`, `workflow_templates.read`, `workflow_templates.manage`, `stages.block`, `stages.override`, `qc.read`, `qc.manage`, `rework.manage`, `production_notes.create` (plus existing `jobs.read_assigned`, `jobs.read_all`, `jobs.assign`, `stages.start`, `stages.complete`, `qc.perform`). Delivered by the `phase4-factory` grant batch: ADMIN all; SALES `production_board.read`; floor roles `stages.block` + `production_notes.create`; QC also `qc.read`; FINANCE none.

## Phase 5A order permissions

`orders.read`, `orders.manage`, `orders.confirm`, `orders.cancel`, `orders.reorder`, `order_batches.read`, `order_batches.manage`, `production_quantity.report`. Delivered by the `phase5a-orders` grant batch: ADMIN all; SALES read/manage/confirm/reorder orders + read batches; FINANCE `orders.read`; floor roles `production_quantity.report`. Bulk jobs are created with `factory_jobs.manage`.

## Phase 5B fulfilment permissions

`packaging.manage`, `shipments.read`, `shipments.manage`, `shipments.dispatch`, `shipments.complete`, `deliveries.read_assigned`, `public_tracking.manage`, `orders.commercial.read`, `orders.commercial.manage`, `orders.override`. Delivered by `phase5b-fulfillment`: ADMIN all; SALES packaging, `shipments.read`, tracking and commercial read/manage; FINANCE `orders.commercial.read`; DELIVERY `deliveries.read_assigned`, `shipments.dispatch`, `shipments.complete`. Factory and delivery roles never receive commercial permissions.

## Phase 6A management permissions

`dashboard.read` (dashboard, Needs Attention), `management_kpis.read` (production / order / delivery KPIs, bottlenecks), `quality_kpis.read`,
`commercial_kpis.read` (finance figures; never visible to production roles), `workload.read` (department / staff / WIP), `capacity.read`,
`capacity.manage`, `sla.read`, `sla.manage`, `eta.read` — 73 permissions in total. Defaults (batch `phase6a-management`): ADMIN all ten;
SALES dashboard / management KPIs / SLA read / ETA; FINANCE dashboard + commercial KPIs; QC quality KPIs. Factory floor roles have no executive
access and read only their own workload through `GET /staff/my-workload` (`jobs.read_assigned`). Dashboard sections and Needs Attention categories are
filtered by these permissions.

## Phase 6B automation permissions

`notifications.read_all`, `notifications.manage`, `notification_templates.read|manage`, `automation.read|manage`, `qr_job_cards.read|manage`, `tech_packs.read|generate|issue`, `working_calendar.read|manage` (86 permissions in total).
Defaults (batch `phase6b-automation`): ADMIN all thirteen; SALES `tech_packs.read` and `working_calendar.read`; nobody else. Staff notifications are own-data and need authentication only. Floor staff read the issued tech pack of jobs they are assigned to
through the staff API (`jobs.read_assigned` + assignment), and resolve QR codes the same way — assignments, not new permissions, decide what they see.

## Example permission catalogue

Naming: `<resource>.<action>`, lowercase, snake_case actions.

| Permission | Allows |
|---|---|
| `users.manage` | Create/update/deactivate staff users, assign roles. |
| `roles.manage` | Create/edit roles, assign permissions. |
| `customers.read` | View customers and brands. |
| `customers.manage` | Create/update/archive customers and brands. |
| `samples.read` | View samples. |
| `samples.manage` | Create/update samples, move them through the lifecycle. |
| `jobs.read_assigned` | View only jobs/stages assigned to the user. |
| `jobs.read_all` | View all factory jobs. |
| `jobs.assign` | Assign/reassign stages to staff. |
| `stages.start` | Start a stage the user is assigned to. |
| `stages.complete` | Complete a stage the user is assigned to. |
| `qc.perform` | Record QC results, pass/fail, trigger rework. |
| `quotations.create` | Draft and submit quotations. |
| `quotations.approve` | Approve quotations internally. |
| `payments.read` | View payments. |
| `payments.verify` | Verify/reject payment proofs. |
| `reports.read` | View reports and dashboards. |
| `settings.manage` | Change system settings, workflow templates, catalogues. |

Added since: `audit.read` (Phase 1); `master_data.read`, `master_data.manage`, `patterns.manage`, `assets.read`, `assets.manage` (Phase 2). Phase 3 added `samples.submit`, `samples.review`, `samples.assign`, `samples.approve`, `payments.manage`, `approvals.manage`, `terms.manage` (grant batch `phase3-samples`; matrix in `PHASE_3_SAMPLE_COMMERCIAL_WORKFLOW.md`). Likely additions: `orders.read`, `orders.manage`, `deliveries.manage`, `notifications.manage`.

Default grants are delivered in versioned **grant batches** (`phase1-initial`, `phase2-master-data`), applied to existing roles once so admin customisations survive deploys. The Phase 2 matrix is in `PHASE_2_CUSTOMER_MASTER_DATA.md`.

## Phase 4 permissions

`factory_jobs.manage` (create/release/hold/resume/cancel/priority, admin blockers), `production_board.read`, `workflow_templates.read|manage`, `stages.block` (raise blockers), `stages.override` (force-complete/skip, job force-complete), `qc.read`, `qc.manage` (publish checklists, override QC gates), `rework.manage`, `production_notes.create` (notes and evidence files). Reused from earlier phases: `jobs.read_assigned`, `jobs.read_all`, `jobs.assign`, `stages.start`, `stages.complete`, `qc.perform`. Default grants are delivered by the `phase4-factory` grant batch (see `PHASE_4_FACTORY_OPERATIONS.md` §12).

## Illustrative default mappings (seed data, not code)

| Role | Permissions |
|---|---|
| SUPER_ADMIN | all |
| ADMIN | users.read/manage, roles.read, permissions.read, customers.*, samples.*, jobs.read_all, jobs.assign, quotations.*, payments.read, reports.read, audit.read (no roles.manage, settings.manage, payments.verify) |
| SALES | customers.read, customers.manage, samples.read, samples.manage, quotations.create, jobs.read_all |
| FABRIC / PATTERN_MAKER / CUTTING / PRINTING / SEWING / PACKAGING | jobs.read_assigned, stages.start, stages.complete |
| QC | jobs.read_assigned, stages.start, stages.complete, qc.perform |
| DELIVERY | jobs.read_assigned, stages.start, stages.complete, deliveries.manage |
| FINANCE | payments.read, payments.verify, reports.read, customers.read |

## Enforcement rules

1. Every route declares `@RequirePermissions(...)`, `@AllowAuthenticated()` or `@Public()`; undeclared routes are denied by default (implemented).
2. A global guard resolves the user's effective permissions and compares; controllers contain no checks.
3. Ownership/assignment constraints (e.g. `jobs.read_assigned`, customer-owns-record) are enforced in services, in addition to the permission.
4. Permission checks are unit-tested per feature, including the negative case.
