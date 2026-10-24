# Benue Print Backend — Architecture

Benue Print is a factory operations and customer portal platform for clothing manufacturing. This backend is a **modular monolith**: one deployable NestJS application, internally split into modules with strict boundaries so it can scale organisationally (and, if ever needed, be split into services) without a rewrite.

**Stack:** Node.js 22, TypeScript (ESM), NestJS, PostgreSQL, Prisma 7 (`@prisma/adapter-pg`), Swagger/OpenAPI, Vitest, pnpm, Docker Compose.

## 1. Overall architecture

```
HTTP request
  → Helmet / CORS / request logging (pino)
  → Global ValidationPipe (DTO validation)
  → Guards: rate limit → JwtAuthGuard (session + user check) → PermissionsGuard (deny by default)
  → Controller (thin: parse input, call service, shape output)
  → Service (business logic, transactions, audit events)
  → Repository / Prisma (persistence only)
  → PostgreSQL
Errors anywhere → AllExceptionsFilter → uniform error body
```

```
src/
  main.ts            bootstrap only
  app.setup.ts       configureApp(): prefix, helmet, CORS, pipes, filters, Swagger (shared with e2e tests)
  app.module.ts      root module
  common/            framework-level, domain-agnostic building blocks
    decorators/ guards/ filters/ interceptors/ enums/ types/
  config/            typed, validated environment configuration
  database/          PrismaService + global DatabaseModule
  modules/           one folder per business module (health, auth, users, roles, audit as of Phase 1; customers, brands, assets, storage, master-data as of Phase 2; samples, artwork, commercial, quotations, payments, approvals, configurator as of Phase 3)
prisma/              schema.prisma and (from Phase 1) committed migrations
docs/                architecture and planning documents
```

## 2. Module boundaries

- Each folder in `src/modules/` is a NestJS module that owns one domain (see `DOMAIN_MODEL.md`): its controllers, services, repositories, DTOs, and tests.
- A module owns its tables. Only that module reads or writes them.
- A module exposes behaviour to other modules **only through exported services** (its public API). It never exports repositories or Prisma delegates.
- Modules never import another module's internal files (DTOs, repositories, entities); they import its `*.module.ts` and exported service types.
- Cross-module reads that need joins are done through the owning module's service (or a dedicated read-model/query service when performance requires it).
- Side effects across domains (e.g. "sample approved → notify customer") go through **domain events** (`@nestjs/event-emitter`, to be added when first needed), not direct calls, to avoid circular dependencies.
- **Factory module (Phase 4):** `src/modules/factory` owns jobs, workflow templates, stages, blockers, QC and rework. `JobEngineService` is the single place that locks a job, writes the timeline and moves stages/jobs; `pure/` holds the unit-tested state machine, job-status derivation, workflow graph validation and task-view projections. It depends on `SamplesModule` (sample lock + spec) and `AssetsModule` (evidence uploads) only.
- Customer-facing and internal-factory endpoints are separated by route namespace and permission, not by duplicating domain logic (see §4).

The `factory` module (Phase 4) owns jobs, workflow templates, stages, blockers, QC and rework; it imports `SamplesModule` (sample lock, frozen spec), `AssetsModule` (uploads) and `AuthModule` (role/permission lookup). Admin routes live under `/admin`, floor routes under `/staff`.

The `orders` module (Phase 5A) owns orders, items, variants, batches and the order timeline; it imports `FactoryModule` (bulk job creation, quantity services) and `OrderCoreModule`. `OrderCoreModule` (order state machine, activity log and production sync) is a leaf module that the factory also imports, because production drives order status; this keeps the dependency graph acyclic. Locking order is always **order → job** (and sample → job): `JobEngineService.lockJob` takes an order job's order lock first.

Phase 5B extends `orders` with packaging, shipments, delivery staff routes, order commercial figures and public tracking. Commercial documents are generalised in place: `QuotationsService`, `PaymentsService` and `CommercialService` accept a sample **or** an order target (`CommercialTarget`), and both modules import the leaf `OrderCoreModule` for the order lock and timeline. The only unauthenticated business route is `GET /track/orders/:token` (`@Public`, per-IP `tracking` throttler); request logging and error bodies mask the token.

### Management intelligence *(Phase 6A)*

`ManagementModule` is a read-model layer: services that aggregate operational tables (SQL `groupBy` / `FILTER`, bounded lists) and pure
rule modules (`management/pure/`: business time, SLA, delay, ETA, capacity, attention ranking, pipelines) that are unit tested. It owns three
configuration tables (SLA rules, department / staff capacity) and writes nothing operational. It depends on `OrdersModule` only for the
commercial release gate and is depended on by nothing; Phase 6B notifications will consume its services. All "now" comes from
`ManagementContext`; reporting time uses `BUSINESS_TIMEZONE`. See `PHASE_6A_MANAGEMENT_INTELLIGENCE.md`.

### Automation and operational tools *(Phase 6B)*

Business modules never send messages. They write a domain event into the **transactional outbox** (`OutboxService.emit(tx, …)`, a global module) in the same transaction as the change;
`NotificationsModule` plans notifications from automation rules and delivers them through the `EmailProvider` / `WhatsAppProvider` ports; `AutomationModule` evaluates Needs Attention on a schedule into
`OperationalAlert`s with escalation; `CalendarModule` supplies the working-time clock used by SLA, ETA and escalation; `JobCardsModule` (QR identity + job card) and `TechPacksModule` (frozen, versioned documents + deterministic PDF)
sit on top of the factory and orders. Dependencies point one way: business → outbox; notifications/automation → management; nothing depends on delivery channels. See `PHASE_6B_AUTOMATION_OPERATIONAL_TOOLS.md`.

## 3. Dependency rules

Allowed direction (arrows = "may import"):

```
modules/*  →  common, config, database
common     →  (nothing in modules/, nothing in database/)
config     →  (nothing else)
database   →  config
module A   →  module B's exported service only, and only if no cycle results
```

- `common/` must stay domain-agnostic: no business terms, no Prisma models.
- Circular module dependencies are forbidden; resolve with events or by extracting a lower-level module.
- Controllers depend on services only. Services depend on repositories/`PrismaService`. Repositories depend on `PrismaService`.
- Import paths use the `.js` extension (ESM, `nodenext`).

## 4. API conventions

- Global prefix `/api/v1`. Breaking changes ship under a new prefix (`/api/v2`); additive changes do not.
- Swagger UI at `/api/docs`, JSON at `/api/docs-json` (controlled by `SWAGGER_ENABLED`; disable or protect in production).
- REST, plural kebab-case resources: `/api/v1/customers`, `/api/v1/factory-jobs/:id/stages`.
- Internal/staff endpoints live under the resource root; customer-portal endpoints are namespaced (`/api/v1/portal/...`) and scoped to the authenticated customer's own data server-side.
- Every controller carries `@ApiTags`; every DTO property carries `@ApiProperty`; documented success and error responses.
- Lists are paginated (`page`, `pageSize` with a hard max) and return `{ data, meta: { page, pageSize, total } }`. Filtering/sorting via explicit, whitelisted query parameters.
- IDs are opaque (UUID). Timestamps are ISO-8601 UTC.
- Use correct verbs/status codes: 201 create, 204 no body, 409 conflict, 422 only for domain-rule violations, 503 for dependency failure.
- State transitions are explicit actions (`POST /samples/:id/submit`), not arbitrary `PATCH status`.

## 5. Error handling conventions

- One global `AllExceptionsFilter` produces every error body:
  ```json
  { "statusCode": 404, "error": "Not Found", "message": "…", "path": "/api/v1/…", "timestamp": "…", "requestId": "…" }
  ```
- `message` is a string or, for validation failures, an array of strings.
- Throw Nest `HttpException` subclasses (or domain exceptions mapped to them) from services. Never return error objects.
- 5xx responses never leak internals; the stack goes to the log only, correlated by `requestId`.
- Map Prisma errors (unique violation → 409, not found → 404) in the persistence layer/filter; do not let raw Prisma errors reach clients.

## 6. Logging conventions

- Structured JSON logs via `nestjs-pino` (pretty-printed outside production). Level from `LOG_LEVEL`.
- Each request gets an id (`requestId` in logs and error bodies).
- `authorization` and `cookie` headers are redacted. **Never log** passwords, tokens, signed URLs, or full payment details.
- Use the Nest `Logger` with a class context. Log events (what happened + ids), not whole entities.
- Health-check traffic is excluded from request logging.
- Logs are operational diagnostics. They are **not** the audit trail (see §10).

## 7. Validation conventions

- Environment is validated at boot with `zod` (`src/config/env.validation.ts`); the app refuses to start on invalid config.
- Every request body, query and param goes through a DTO class using `class-validator`/`class-transformer`.
- The global `ValidationPipe` runs with `whitelist`, `forbidNonWhitelisted` and `transform` — unknown properties are rejected.
- DTOs are never reused as persistence models; map explicitly.
- Validation checks shape and format. Business rules (state transitions, permissions, uniqueness) are enforced in services.

## 8. Database conventions

- PostgreSQL via Prisma. Connection through `@prisma/adapter-pg`; one global `PrismaService`.
- Migrations are generated with `pnpm prisma:migrate`, reviewed, and **committed**. Production uses `prisma migrate deploy`. Never edit an applied migration.
- Tables: `snake_case` plural via `@@map`; Prisma models `PascalCase` singular; columns `snake_case` via `@map`.
- Primary keys: UUID. Every table has `created_at`, `updated_at`; important tables have `deleted_at`/`archived_at` (soft delete) and `created_by`/`updated_by`.
- Money: integer minor units (or `Decimal`) plus an explicit currency; never floats. (Phase 2 stores `Decimal(12,2)` fees with one implicit currency until the pricing phase.)
- Human-readable references (`CUS-000001`) come from `ReferenceSequence` via `nextReference(tx, prefix)` inside the creating transaction (row-locked, race-free); never `count + 1`.
- Business invariants that must hold under concurrency are also enforced by the database: partial unique indexes (one live quotation version, one approved artwork version, one pending approval per target), `CHECK`s (exactly-one targets, exclusive pairs, money consistency) and triggers (append-only history, immutable decided/approved/sent records).
- Constraints Prisma cannot express (partial unique indexes, CHECKs, triggers) are hand-added to the migration SQL and documented in the phase doc.
- Enums for closed sets that rarely change; lookup tables for admin-configurable sets (roles, permissions, product types, workflow templates).
- Multi-step writes use `prisma.$transaction`. Audit entries are written in the same transaction as the change.
- Add indexes for every foreign key and every filtered/sorted column used by list endpoints.
- The generated client lives in `src/generated/prisma` and is git-ignored; it is regenerated on `pnpm install` and `pnpm build`.

## 9. File storage strategy

- Files (designs, artwork, patterns, photos, invoices, proofs) live in **S3-compatible object storage**, never in PostgreSQL.
- PostgreSQL stores metadata only in a `files`/`assets` table: id, owner reference, bucket, object key, original name, MIME type, size, checksum, uploader, `created_at`, version info.
- The `StorageService` port (`put`, `exists`, `delete`, `getDownloadUrl`) hides the provider. Phase 2 ships `LocalStorageProvider` (private directory + HMAC-signed, expiring URLs); S3/R2/MinIO implement the same port. See `PHASE_2_CUSTOMER_MASTER_DATA.md`.
- Buckets are **private**. Clients receive short-lived signed URLs after a server-side permission check; uploads use pre-signed upload URLs or streamed multipart with size/MIME limits.
- Object keys are server-generated (`<domain>/<yyyy>/<mm>/<uuid>`); user-supplied filenames are metadata only.
- Approved files and specifications are immutable and versioned: a new upload creates a new version; old versions are retained.
- Uploads are validated (MIME sniffing, size caps) and, where appropriate, virus-scanned before being marked available.

## 10. Security principles

- Authorization is **always enforced server-side**. The UI hides things for convenience only.
- Authorization is permission-based (`Role → Permission`), never role-name checks in code. See `ROLES_AND_PERMISSIONS.md`.
- Deny by default: once auth exists, every route requires authentication and a declared permission unless explicitly marked public.
- Customers can only access their own records; ownership is checked in the service layer, not trusted from the request.
- Helmet is enabled; CORS is an explicit allow-list from `CORS_ORIGINS` (never `*` with credentials).
- Passwords: Argon2id hashing; short-lived access tokens + rotating, hashed, revocable refresh tokens; rate limiting on auth endpoints (implemented in Phase 1; see `PHASE_1_ACCESS_CONTROL.md`).
- Decorators: `@Public()`, `@AllowAuthenticated()`, `@RequirePermissions()`; request principal via `@CurrentUser()`; client IP/user agent via `@ReqMeta()`.
- Seeding: `prisma/` holds schema and migrations; `src/database/seed` holds the idempotent seed (catalogue, system roles, initial SUPER_ADMIN from env).
- Secrets come from environment variables only; `.env` is git-ignored; `.env.example` holds placeholders.
- Validate and whitelist all input; use Prisma parameterised queries (raw SQL only via tagged templates).
- Least privilege for DB users and storage credentials. Dependencies are kept current and pnpm build scripts are allow-listed (`pnpm-workspace.yaml`).

## 11. Auditability requirements

- **Activity log** (user-visible timeline, e.g. "stage started by X") and **audit log** (immutable security/compliance record) are separate concepts (see `DOMAIN_MODEL.md`).
- Audit entries record: actor (user/customer/system), action, entity type + id, before/after (or diff), timestamp, request id, IP/user agent where relevant.
- Audit logs are append-only: no update or delete paths in application code.
- Always audited: authentication events, role/permission changes, user management, price/quotation changes and approvals, payment verification, approvals/rejections, file version changes, workflow/assignment changes, settings changes, deletes/archives.
- Soft-deleted/archived records remain queryable by authorised staff and referenced by audit entries.
- State changes of business aggregates go through a data-driven state machine plus a row-locked transition service (`SampleTransitionsService`): validate, update, append history and audit in one transaction. Cross-module effects (a quotation accepted, a payment verified) call the owning service inside the caller's transaction instead of publishing events, so they are atomic.
- Audit writes happen in the same DB transaction as the change they describe (`AuditService.record(entry, tx)`).
- `audit_logs` is append-only, enforced by a database trigger as well as by code.
