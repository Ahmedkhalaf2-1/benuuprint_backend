# Benue Print — Planned Domain Model

High-level planning. **Implemented so far: Staff Users, Roles, Permissions and the Audit Log foundation (Phase 1, `PHASE_1_ACCESS_CONTROL.md`); Customers, Brands (+contacts/addresses), Files/Assets, Product Types, Fabrics (+colours), Patterns (+versions), Print Methods, Accessories, sizes and label/packaging components (Phase 2, `PHASE_2_CUSTOMER_MASTER_DATA.md`). Samples, Quotations, Payments and Approvals (+ Artwork, Terms and the frozen production specification) are implemented in Phase 3 (`PHASE_3_SAMPLE_COMMERCIAL_WORKFLOW.md`). Factory Jobs, Workflow Templates, Production Stages, Assignments, QC (Phase 4/4.1) and Orders, Batches, quantity-aware production control (Phase 5A, `PHASE_5A_BULK_ORDERS_PRODUCTION.md`) are implemented; Packaging, Shipments / Delivery, public tracking and order commercial documents (Phase 5B, `PHASE_5B_FULFILLMENT_DELIVERY.md`) are implemented; Notifications are still planned.** Each domain becomes a module under `src/modules/` when its phase starts. "Audience" is either **Internal** (factory operations) or **Customer-facing** (visible/usable in the customer portal) or **Both**.

## Identity & Access

### Staff Users *(implemented in Phase 1)*
- **Purpose:** Authenticated factory/office employees who operate the system.
- **Relationships:** many-to-many with Roles via UserRole; created/updated-by on most records; assigned to Stages (Assignments); authors of Activity/Audit entries.
- **Audience:** Internal.

### Roles *(implemented in Phase 1)*
- **Purpose:** Named, data-driven bundles of permissions (system roles such as SUPER_ADMIN, plus custom roles).
- **Relationships:** UserRole ↔ Staff Users; RolePermission ↔ Permissions.
- **Audience:** Internal.

### Permissions *(implemented in Phase 1)*
- **Purpose:** Granular capabilities (`samples.manage`, `payments.verify`) checked by guards. Defined by the code base, assigned to roles via data.
- **Relationships:** RolePermission ↔ Roles.
- **Audience:** Internal.

## Customer side

### Customers *(implemented in Phase 2)*
- **Purpose:** Client companies/individuals who order from the factory; may log into the portal.
- **Relationships:** has many Brands, Samples, Quotations, Orders, Payments, Notifications; has Files.
- **Audience:** Both (portal users see their own data; staff manage all).

### Brands *(implemented in Phase 2)*
- **Purpose:** The labels/brands a customer produces under; groups designs and orders.
- **Relationships:** belongs to a Customer; has many Samples/Orders and brand Assets (logos, guidelines).
- **Audience:** Both.

### Files / Assets *(implemented in Phase 2)*
- **Purpose:** Metadata for objects in private object storage (artwork, tech packs, patterns, photos, proofs, invoices) with versioning.
- **Relationships:** polymorphically attached to Samples, Orders, Stages, Payments, Brands, etc.; uploader (user or customer); version chain.
- **Audience:** Both (access via signed URLs after permission checks).

## Catalogue / Specification

### Product Types *(implemented in Phase 2)*
- **Purpose:** What is being made (t-shirt, hoodie, jacket…); drives default workflow and measurements.
- **Relationships:** referenced by Samples/Orders; optionally linked to a default Workflow Template.
- **Audience:** Both (selectable by customers, managed internally).

### Fabrics / Materials *(implemented in Phase 2)*
- **Purpose:** Fabric and material options (composition, weight, colour, supplier, stock-relevant info).
- **Relationships:** used by Samples/Orders; sourced in the Fabric stage.
- **Audience:** Both (catalogue visible, sourcing details internal).

### Patterns *(implemented in Phase 2)*
- **Purpose:** Pattern/size-chart definitions per product type, versioned once approved.
- **Relationships:** belongs to Product Type; linked to Samples/Orders; has Files (pattern files).
- **Audience:** Internal (customers may view approved outputs).

### Print Methods *(implemented in Phase 2)*
- **Purpose:** Decoration techniques (screen print, DTG, sublimation, embroidery) with constraints and pricing inputs.
- **Relationships:** used by Samples/Orders; drives the Printing/Embroidery stage and Quotation lines.
- **Audience:** Both.

### Accessories *(implemented in Phase 2)*
- **Purpose:** Labels, zips, buttons, packaging items attached to a product spec.
- **Relationships:** used by Samples/Orders; priced into Quotations.
- **Audience:** Both.

## Commercial flow

### Samples *(implemented in Phase 3)*
- **Purpose:** A customer's request for a prototype/sample; the entry point of the business flow, with its own lifecycle (see `WORKFLOWS.md`).
- **Relationships:** belongs to Customer/Brand; references Product Type, Fabrics, Patterns, Print Methods, Accessories; has Files, Quotations, Approvals, Payments, and spawns Factory Jobs; may convert to an Order.
- **Audience:** Both.

### Quotations *(implemented in Phase 3)*
- **Purpose:** Priced offers for a Sample or Order, with line items and validity; versioned; require internal approval.
- **Relationships:** belongs to Sample/Order and Customer; has Approvals and Payments.
- **Audience:** Both (staff build/approve; customers view/accept).

### Payments *(implemented in Phase 3)*
- **Purpose:** Records and verification of payments (deposits, balances) against Quotations/Orders; gates production.
- **Quotation validity (orders):** each QuotationVersion stamps the `orderRevision` it priced; a commercially relevant order revision ends live versions (`SUPERSEDED` + `invalidatedAt/invalidatedByRevision/invalidationReason`, write-once) while keeping terms and the accepted decision. `Order.commercialRevision` = last revision that changed commercial terms; `OrderRevision.commercialImpact/commercialChanges` record the classification. Payments are never tied to one version for balance purposes.
- **Relationships:** belongs to Quotation/Order/Customer; proof Files; verified by a Staff User.
- **Audience:** Both (customers submit proof; finance verifies).

### Approvals *(implemented in Phase 3)*
- **Purpose:** Explicit, recorded sign-offs (internal quotation approval, customer sample/specification approval), tied to a specific version.
- **Relationships:** targets Samples/Quotations/Files/Orders; approver is a Staff User or Customer.
- **Audience:** Both.

### Orders *(implemented in Phase 5A; see `PHASE_5A_BULK_ORDERS_PRODUCTION.md`)*
- **Implemented:** Order, OrderItem, OrderVariant, OrderProductionSpec, OrderRevision, OrderBatch, OrderBatchVariant, OrderActivity, StageProductionReport. An order pins the `APPROVED_REFERENCE` of an approved sample; bulk jobs (`BULK_ORDER` / `ORDER_BATCH`) pin it plus the frozen order spec. Delivery is still planned (Phase 5B).
- **Purpose:** Confirmed production orders (bulk or sample-to-order) with quantities, size breakdowns, and due dates.
- **Relationships:** belongs to Customer/Brand; from Sample/Quotation; has Factory Jobs, Payments, Deliveries.
- **Audience:** Both.

### Deliveries *(implemented in Phase 5B as Shipments; see `PHASE_5B_FULFILLMENT_DELIVERY.md`)*
- **Implemented:** OrderPackagingSpec (+components), PackagingReport, Shipment, ShipmentLine, OrderTrackingToken; Quotations and Payments now target a Sample or an Order.
- **Purpose:** Dispatch and handover of finished goods, with carrier, tracking and proof of delivery.
- **Relationships:** belongs to Order (and Job); proof Files; handled by DELIVERY staff.
- **Audience:** Both.

### Management configuration *(implemented in Phase 6A; see `PHASE_6A_MANAGEMENT_INTELLIGENCE.md`)*
- **SlaRule:** configurable service target (JOB / STAGE / ORDER / SHIPMENT) with threshold, warning window and priority multipliers; decides a deadline, never stores a result.
- **DepartmentCapacity / StaffCapacity:** daily capacity (PIECES / JOBS / MINUTES) per department (optionally per stage definition) and optionally per person, with effective dates; no overlapping active ranges.
- Everything else in the management layer (delay, SLA state, KPIs, workload, utilization, ETA) is derived at read time from jobs, stages, assignments, reports, QC, rework, orders, batches, shipments, quotations and payments.

### Automation and operational tools *(implemented in Phase 6B; see `PHASE_6B_AUTOMATION_OPERATIONAL_TOOLS.md`)*
- **WorkingCalendar / Day / Exception:** weekly hours plus holidays, exceptional and shortened days in an IANA zone; one default.
- **OutboxEvent / Notification / NotificationTemplate / User- and CustomerNotificationPreference:** reliable event delivery, per-recipient messages with a snapshot of the destination, immutable template versions (en/ar), preferences.
- **OperationalAlert / EscalationRule / AutomationRule / SchedulerRun:** incident memory so unchanged problems notify once, bounded escalation levels, event → audience mapping, scheduler heartbeat.
- **FactoryJobQrToken:** hashed, rotatable QR identity of a job (an identifier, never a credential).
- **TechPack / TechPackVersion:** operational document per sample or order, immutable versions generated from frozen specifications, PDF stored as a private `TECH_PACK` asset.

## Factory operations *(implemented in Phase 4; see `PHASE_4_FACTORY_OPERATIONS.md`)*

Job sources: `SAMPLE_PRODUCTION` (implemented; builds the physical sample from a `PRE_PRODUCTION` `SampleProductionSpec`), `BULK_ORDER` and `ORDER_BATCH` (reserved; will pin an `APPROVED_REFERENCE`). `SampleProductionSpec.kind` distinguishes the two frozen specifications.

Implemented models: FactoryJob, ProductionStageDefinition, WorkflowTemplate/Version/Stage/Dependency, JobStage/JobStageDependency, StageAssignment, Blocker, ReworkRecord, QcTemplate/ChecklistItem/Inspection/Result, JobActivity, JobNote. Delivery is still planned.

### Factory Jobs *(implemented in Phase 4)*
- **Purpose:** The unit of production work for a Sample/Order; instantiated from a Workflow Template; **not** a single status field.
- **Relationships:** belongs to Order/Sample; has Job Stages, Blockers, Files, QC records.
- **Audience:** Internal (customers see a simplified progress view derived from it).

### Workflow Templates *(implemented in Phase 4)*
- **Purpose:** Configurable definition of the stage sequence (and later parallel branches/gates) for a kind of job.
- **Relationships:** has template stages; referenced by Product Types and Factory Jobs (snapshotted at job creation).
- **Audience:** Internal.

### Production Stages *(implemented in Phase 4)*
- **Purpose:** The concrete stages of a job (Fabric, Pattern Making, Cutting, QC Gates, Printing/Embroidery, Sewing, Packaging, Ready, Delivery) with status, timestamps, notes, attachments, rework counters.
- **Relationships:** belongs to a Factory Job; has Assignments, Blockers, Notes, Files, QC results.
- **Audience:** Internal.

### Assignments *(implemented in Phase 4)*
- **Purpose:** Who (user/team) is responsible for a stage and when; supports reassignment history.
- **Relationships:** links Staff Users to Production Stages.
- **Audience:** Internal.

### QC *(implemented in Phase 4)*
- **Purpose:** Quality gate inspections (pass/fail, defects, photos, rework triggers) at gates 1–3.
- **Relationships:** belongs to a Production Stage/Job; performed by a Staff User; may reopen earlier stages (rework).
- **Audience:** Internal (summary may surface to customers).

Phase 4 also adds: **Stage definitions** (configurable catalogue), **Workflow versions** (immutable once active), **Job stage dependencies** (explicit edges), **Blockers**, **Rework records**, **QC templates/inspections/results**, **Job activities** (operational timeline) and **Job notes**. Details: `PHASE_4_FACTORY_OPERATIONS.md`.

## Cross-cutting

### Notifications
- **Purpose:** Messages to staff and customers (in-app, email, later WhatsApp/SMS) on key events.
- **Relationships:** targets Staff Users or Customers; references the triggering entity.
- **Audience:** Both.

### Activity Logs *(job timeline implemented in Phase 4 as `JobActivity`)*
- **Purpose:** Human-readable timeline of what happened on an entity (status changes, comments, uploads).
- **Relationships:** polymorphic to Samples, Orders, Jobs, Stages; actor is a user/customer/system.
- **Audience:** Both (customer-visible entries are flagged; internal ones hidden).

### Audit Logs *(foundation implemented in Phase 1: security/admin actions only)*
- **Purpose:** Immutable, append-only record of security- and compliance-relevant changes with before/after data.
- **Relationships:** polymorphic to any entity; actor, request id.
- **Audience:** Internal (admins/finance with `audit.read`).
