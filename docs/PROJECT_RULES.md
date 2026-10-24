# Project Rules

Rules for all future implementation. Reviewers should reject changes that break them.

## Code structure
1. **No business logic in controllers.** Controllers parse input, call one service method, return the result.
2. **No direct Prisma usage in controllers.** Prisma is used in repositories (or services for trivial cases) only.
3. Use **services** for business logic and **repositories** for non-trivial persistence; modules only talk to each other through exported services.
4. **DTO validation is required** for every body, query and param (`class-validator`), and DTOs are documented for Swagger.
5. **Authorization is enforced server-side** via permission guards; never rely on the client. Do not hardcode role names (see `ROLES_AND_PERMISSIONS.md`).

## Access control (Phase 1+)
- Every new route declares `@RequirePermissions(...)`, `@AllowAuthenticated()` or `@Public()`. Add new permission codes to `src/common/enums/permissions.ts` and the role defaults; run the seed.
- Never branch on role codes for authorization. (Role codes may be referenced only for invariants such as last-SUPER_ADMIN protection.)
- Respond with explicit response DTO mappers; never return Prisma entities containing credentials.
- Admin mutations must call `AuditService.record(..., tx)` inside the same transaction. Never put passwords, tokens or secrets in audit metadata or logs.
- New e2e tests must include unauthenticated (401) and unauthorised (403) cases.

## Master data, files and references (Phase 2+)
- New default permissions for system roles ship as a **new grant batch** in `system-roles.ts`; never edit a shipped batch.
- Human-readable references come from `nextReference(tx, prefix)` inside the creating transaction. Never `count + 1`.
- Master-data codes are immutable and stay reserved after archiving; archive instead of delete.
- File bytes go through `StorageService` only. Validate content by magic bytes, generate keys server-side, never expose storage keys or paths, and hand out only short-lived signed URLs.
- Approved versions (patterns today, artwork later) are immutable: change = new version. Files of an approved version can't be attached, detached or archived.
- Attachments to a new entity add a nullable FK column to `asset_attachments` and extend its CHECK; do not introduce a polymorphic `type + id` pair.
- One-time tokens (invitation, reset) are random, stored hashed, expiring and single-use; never log or audit raw tokens.
- e2e tests run on a database recreated every run; do not rely on data from earlier runs or on list page size.

## Commercial workflow (Phase 3+)
- Never write `Sample.status` directly: use a named action through `SampleTransitionsService` (state machine table + row lock + history + audit).
- Money is `Decimal`, computed on the server (`computeTotals`); clients never send totals or balances. Format money as 2-decimal strings in responses.
- Anything customers saw or agreed to is immutable: sent/accepted quotation versions, approved artwork versions, decided payments/approvals, frozen production specs. Change = new version / revision.
- Production must read `SampleProductionSpec`, never live master data, for what was approved.
- Decisions recorded by staff for a customer need an evidence note and are labelled `STAFF_RECORDED_ON_BEHALF`; never present them as authenticated customer actions.
- Separate duties: the person who records money cannot verify it.
- Never put payment details, card numbers, note contents or file contents in logs or audit metadata.
- New invariants that matter under concurrency get a database constraint/index, not only a service check.

## Factory operations (Phase 4+)
- Never write `JobStage.status` / `FactoryJob.status` outside `JobEngineService` and the named actions; every job mutation takes the job row lock first. A DB trigger enforces the stage transition whitelist.
- Jobs read the pinned `SampleProductionSpec` and the pinned workflow version, never live master data or the live template; stage flags are snapshotted at creation.
- History is never rewritten: rework creates new stage occurrences; blockers/assignments/inspections are closed, not deleted; `JobActivity` is append-only.
- Staff only see and act on stages assigned to them; task views never expose prices, payments, terms or customer contact data.
- Routine floor events go to `JobActivity`; admin/security-relevant events also go to `AuditLog`.
- Admin overrides need a reason and are audited; overriding a QC gate also needs `qc.manage`.

## Factory operations (Phase 4+)
- Never write `JobStage.status` / `FactoryJob.status` directly: go through `JobEngineService` (state machine + job row lock + activity log). Every job mutation locks the job row.
- Jobs read the pinned `SampleProductionSpec`, never live master data. Staff task views are projections of the snapshot and must not expose prices, payments, terms or customer contact data.
- History is never rewritten: rework creates new stage occurrences (attempt + 1); stages, blockers, inspections and activities are never deleted.
- Routine floor events go to `JobActivity`; administrative/security events go to `AuditLog`.
- Production evidence (stage/QC files) cannot be archived or detached.

## Orders and bulk production (Phase 5A+)
- Bulk production reads the `APPROVED_REFERENCE` and the frozen `OrderProductionSpec`, never a pre-production spec or live master data; the database rejects anything else.
- Never write `Order.status` directly: use `OrderTransitionsService` (state machine + timeline). Production-driven states come from `OrderSyncService`.
- Lock order is **order → job** (sample → job); take the order lock first for anything that touches an order's batches, jobs or reports.
- Quantities are validated on the server and enforced where concurrency matters (allocation trigger, report checks under the job lock); history (reports, activities, revisions, specs) is append-only.
- A reorder never copies production history; changes to fabric, construction, fit, pattern, print method or artwork need a new sample.

## Fulfilment and tracking (Phase 5B+)
- Order statuses after production are derived (`deriveOrderStatus` → `fulfillment-sync`); never set them by hand. `COMPLETED` is an explicit, checked action.
- Units are shipped at most once: validate under the order lock **and** keep the `shipment_lines` trigger. A shipment's destination is a snapshot, never a live reference.
- Commercial documents belong to a sample or an order (exactly one); the order lock is taken before any payment, quotation, shipment or token work on that order.
- Public tracking tokens are bearer credentials: store the hash only, show the token once, never log or audit it, answer every invalid / revoked / expired token with the same generic 404, rate-limit the route.
- Delivery staff see their own assigned deliveries only; no commercial, production or audit data reaches factory or delivery roles.
- Delivery proof is a private asset: signed URLs only, never archived or reused.

## Management intelligence (Phase 6A+)

- Analytics are read-models: they derive from operational data at request time and never mutate it. Do not store delay flags, SLA results or ETAs.
- "Now" comes from `ManagementContext.now()`; "today / this week / daily buckets" use `BUSINESS_TIMEZONE`, never the server zone.
- Every analytics query is bounded (date range ≤ `MANAGEMENT_MAX_RANGE_DAYS`, capped lists, pagination) and aggregates in SQL; raw SQL only with bound parameters.
- A metric the data cannot support is not reported (or is reported as `null`) rather than approximated silently.
- No employee scores, rankings or hidden weights. Ranking rules (Needs Attention) are explicit and documented.
- Commercial figures need `commercial_kpis.read`; money is Decimal, per currency, never summed across currencies.
- Management conditions stay free of delivery channels (Phase 6B consumes them).

## Automation and operational tools (Phase 6B+)

- Never send a message inside a business transaction: write an outbox event in it and let the worker deliver. Delivery failures must never affect business state.
- Every notification is idempotent (deduplication key + provider idempotency key) and bounded (max attempts, backoff). Retry only transient errors.
- No secrets, tokens, passwords, payment details or signed URLs in outbox payloads, notification text or audit metadata. Customers only receive customer-safe events with customer templates.
- Templates are data: versioned, immutable, whitelisted `{{variables}}` only; never build message text in services.
- A QR code identifies, it never authenticates; authorization stays with the signed-in user's assignments and permissions.
- Tech packs are generated only from frozen production truth, never edited once generated, and issuing is not a customer approval.
- Business time (SLA, ETA, escalation) goes through `BusinessClock` / the working calendar; the zone is configuration.

## Data
6. **Important records use soft delete / archive** (`deleted_at`/`archived_at`); hard deletes only for non-important or purged data, with justification.
7. **Files live in object storage, not PostgreSQL blobs.** The database holds metadata only.
8. **File access must support private buckets and signed URLs.** No public permanent file URLs.
9. **All important changes must be auditable** (actor, action, entity, before/after) in the same transaction as the change.
10. **Approved files and specifications are versioned** and immutable once approved; changes create a new version.
11. **Database migrations must be committed**, reviewed, and never edited after being applied.

## Quality
12. **Every feature includes tests**: unit tests for services/state machines, e2e tests for endpoints, including permission-denied and validation-failure cases.
13. `pnpm build`, `pnpm test`, `pnpm test:e2e`, `pnpm lint` and `pnpm format:check` must pass before merge.
14. No secrets in the repository; add new env vars to `.env.example` and the zod schema together.

## Scope discipline
15. **Avoid premature 3D implementation. 3D is the final phase.** No 3D dependencies, models, or endpoints before then.
16. Don't add technology or change the stack without recording the reason first.
17. Build in phases; do not start a later phase's domains early.
