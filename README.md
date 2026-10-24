# Benue Print — Backend

NestJS + TypeScript (ESM) + PostgreSQL + Prisma API for the Benue Print factory operations and customer portal platform.

**Status: Phase 6B (automation and operational tools).** Working calendar, transactional outbox, in-app / email / WhatsApp notifications with English and Arabic templates, preferences and quiet hours, scheduled alerts with escalation, QR job cards and versioned tech packs with a deterministic PDF (`docs/PHASE_6B_AUTOMATION_OPERATIONAL_TOOLS.md`; set `BUSINESS_TIMEZONE`, e.g. `Africa/Cairo`). Earlier: **Phase 6A (management intelligence).** On top of bulk orders, production control, packaging, shipments, tracking and order commercial integrity (Phases 5A–5B.1): a management dashboard, a ranked Needs Attention list, production / order / quality / commercial / delivery KPIs, SLA rules and delay engines, bottleneck analysis, department / staff workload, capacity utilization, deterministic ETA and a management production board (`docs/PHASE_6A_MANAGEMENT_INTELLIGENCE.md`; set `BUSINESS_TIMEZONE`). Earlier: **Phase 4 (factory operations).** Factory jobs built from an approved sample's frozen production specification, versioned workflow templates with explicit stage dependencies, assignments, a stage state machine, blockers, QC gates with configurable checklists, rework with preserved history, a production board and floor-facing task APIs, on top of samples, quotations, payments and approvals (Phase 3), customers, brands, private file assets, master data and patterns (Phase 2) and staff auth/roles/audit (Phase 1). No orders, inventory, purchasing, notifications or delivery yet. See `docs/` for architecture, domain model, roles/permissions, workflows and project rules.

## Requirements
- Node.js 22 (`nvm use`), pnpm 12 (`packageManager` is pinned), Docker (for PostgreSQL)

## Quick start
```bash
pnpm install
cp .env.example .env
pnpm db:up            # PostgreSQL via Docker Compose (host port 5433)
pnpm prisma:migrate   # apply migrations
pnpm db:seed          # permissions, system roles, initial SUPER_ADMIN
pnpm dev              # http://localhost:3000
```
- Health: `GET http://localhost:3000/api/v1/health`
- Swagger UI: `http://localhost:3000/api/docs`

## Scripts
| Script | Purpose |
|---|---|
| `pnpm dev` | Start with watch mode |
| `pnpm build` | Generate Prisma client and compile to `dist/` |
| `pnpm start:prod` | Run the compiled app |
| `pnpm test` / `pnpm test:e2e` | Unit tests / e2e tests (e2e needs the database running) |
| `pnpm lint` / `pnpm format` | oxlint / prettier |
| `pnpm prisma:generate` / `prisma:migrate` / `prisma:studio` | Prisma tooling |
| `pnpm db:up` / `pnpm db:down` | Start/stop local PostgreSQL |
| `pnpm db:seed` / `pnpm db:seed:prod` | Idempotent seed (dev via tsx / compiled) |

## First-time setup notes
1. In `.env` set `JWT_ACCESS_SECRET` (`openssl rand -base64 48`).
2. To create the initial Super Admin set `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_NAME` and `SEED_SUPER_ADMIN_PASSWORD` (12+ chars, upper, lower, digit) before `pnpm db:seed`. The seed is idempotent and never changes an existing account. Never commit real credentials; change the password after first login.
3. Production: run `prisma migrate deploy` from CI/a one-off job, then `pnpm db:seed:prod` (compiled seed) with the env vars injected by your platform; remove the seed password afterwards.
4. `pnpm test:e2e` uses a separate `<db>_test` database that is **dropped, recreated, migrated and seeded on every run**, so dev data is never touched and runs are deterministic.

## File storage
Uploads are stored privately (default `./storage`, git-ignored) and served only through short-lived signed URLs; see `docs/PHASE_2_CUSTOMER_MASTER_DATA.md`. In Docker the `benue_api_storage` volume holds them. Invitation and password-reset tokens have no email provider yet: outside production the admin API returns the invitation token (`EXPOSE_ONE_TIME_TOKENS`); in production wire a `TokenDelivery` implementation first.

## Currency
Quotations default to `DEFAULT_CURRENCY` (`EGP`); each quotation carries its own ISO currency and payments must match it.

## Docker
- **Development (preferred):** only PostgreSQL runs in Docker (`pnpm db:up`); the API runs locally with `pnpm dev`. Data persists in the `benue_postgres_data` volume; `docker compose down -v` wipes it.
- **Production-style image:** `pnpm docker:build` builds a multi-stage Node 22 Alpine image (non-root, healthcheck). `pnpm docker:app` runs it with PostgreSQL via the opt-in `app` compose profile.
- Credentials come from `.env` (compose refuses to start if `POSTGRES_*` are unset). Changing `POSTGRES_PASSWORD` after the volume exists requires recreating the volume.
- The image contains no Prisma CLI; run `prisma migrate deploy` from CI or a one-off job (Phase 1).

## Configuration
All environment variables are documented in `.env.example` and validated at boot (`src/config/env.validation.ts`).

## Docs
- `docs/PHASE_6B_AUTOMATION_OPERATIONAL_TOOLS.md` · `docs/PHASE_6A_MANAGEMENT_INTELLIGENCE.md` · `docs/PHASE_5B_FULFILLMENT_DELIVERY.md` · `docs/PHASE_5A_BULK_ORDERS_PRODUCTION.md` · `docs/PHASE_4_FACTORY_OPERATIONS.md` · `docs/PHASE_3_SAMPLE_COMMERCIAL_WORKFLOW.md` · `docs/PHASE_2_CUSTOMER_MASTER_DATA.md` · `docs/PHASE_1_ACCESS_CONTROL.md` · `docs/ARCHITECTURE.md` · `docs/DOMAIN_MODEL.md` · `docs/ROLES_AND_PERMISSIONS.md` · `docs/WORKFLOWS.md` · `docs/PROJECT_RULES.md`
