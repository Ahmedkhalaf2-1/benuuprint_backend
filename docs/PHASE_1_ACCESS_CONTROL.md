# Phase 1 — Access Control Foundation

Implemented: staff users, authentication, sessions, database-driven roles/permissions, server-side authorization, seeded Super Admin, and a security audit trail. No business domains (customers, samples, orders, …) exist yet.

## Models (Prisma)

| Model | Notes |
|---|---|
| `User` | uuid id, name, unique lower-cased `email`, `phone?`, `passwordHash` (argon2id), `status` (`ACTIVE`/`SUSPENDED`/`INVITED`/`DISABLED`), `isActive` (denormalised, true only when ACTIVE), `lastLoginAt?`, `passwordChangedAt?`, timestamps, `deletedAt?` (soft delete). Email stays reserved after archiving. |
| `Role` | `name`, unique immutable `code`, `description?`, `isSystem`, `isActive`, `deletedAt?`. |
| `Permission` | unique `code`, `description`. Catalogue lives in `src/common/enums/permissions.ts`; the seed upserts it. |
| `UserRole` | (`userId`,`roleId`) PK, `assignedAt`, `assignedBy?`. |
| `RolePermission` | (`roleId`,`permissionId`) PK. |
| `Session` | `refreshTokenHash` (SHA-256 of the secret), `userAgent?`, `ipAddress?`, `lastUsedAt?`, `expiresAt`, `revokedAt?`. Indexed by `userId`, `expiresAt`. |
| `AuditLog` | `actorUserId?`, `action`, `entityType`, `entityId?`, `metadata` (JSON), `ipAddress?`, `userAgent?`, `createdAt`. Indexed on `createdAt`, `actorUserId`, `action`, (`entityType`,`entityId`). **Append-only: a DB trigger rejects UPDATE/DELETE.** |

Migration: `prisma/migrations/*_access_control_foundation` (schema + audit trigger).

## Authentication flow

1. `POST /auth/login {email,password}` → `{accessToken, refreshToken, tokenType, expiresIn, user}`. Unknown email, wrong password and non-ACTIVE accounts all return the same `401 Invalid email or password` (a dummy hash check equalises timing). The real reason is stored in the audit log only.
2. Access token: JWT HS256, 15 min (configurable), claims `sub` (user), `sid` (session), issuer `benue-print`, audience `benue-print-staff` (a future customer portal uses another audience).
3. Every authenticated request re-checks the session and user in the database (not revoked, not expired, user ACTIVE and not archived) and re-resolves roles → permissions. Suspension, role changes and logout therefore take effect on the very next request.
4. `POST /auth/refresh {refreshToken}` rotates the refresh token. **Replaying an already-rotated token revokes the whole session** (theft detection) and is audited.
5. `POST /auth/change-password` verifies the current password, sets the new one and **revokes all sessions** (including the current one). Admin password resets do the same.

## Session flow

- Refresh token = `<sessionId>.<256-bit random secret>`; only `sha256(secret)` is stored. Lookup is by session primary key; comparison is constant-time.
- Session lifetime is absolute (`REFRESH_TOKEN_TTL_DAYS`, default 14); rotation does not extend it.
- `logout` revokes the current session, `logout-all` every session, `GET /auth/sessions` lists active sessions (current flagged), `DELETE /auth/sessions/:id` terminates one of your own (someone else's id returns 404).
- Suspending/disabling/archiving a user revokes all their sessions.

## Role / permission architecture

- Code never checks role names. Routes declare `@RequirePermissions('users.manage')`; `PermissionsGuard` compares against the **union of permissions of all the user's active, non-deleted roles**.
- **Deny by default.** Global guard order: `ThrottlerGuard` → `JwtAuthGuard` → `PermissionsGuard`. A route needs `@Public()`, `@AllowAuthenticated()` or `@RequirePermissions(...)`; otherwise it returns 403.
- **No SUPER_ADMIN bypass.** SUPER_ADMIN is simply a role holding every permission (re-synced by the seed on every run), so there is nothing to bypass and nothing special to audit. Run the seed after deploys that add permissions.
- **Privilege-escalation guard:** an actor can only grant/revoke permissions they hold, assign roles whose permissions they hold, and manage users whose effective permissions they hold. (An ADMIN cannot create SUPER_ADMINs or suspend one.)
- **System roles:** cannot be deleted, deactivated or renamed-by-code; SUPER_ADMIN's permissions are immutable via the API. Other system roles' permissions are editable and the seed never overwrites those edits (defaults apply only at first creation).
- **Last SUPER_ADMIN protection:** suspending, disabling, archiving or de-roling the last active SUPER_ADMIN is refused (409, serializable transaction). Users cannot change their own status or archive themselves.
- Roles are soft-deleted; a role assigned to users can't be deleted.

## Seeded roles

`SUPER_ADMIN, ADMIN, SALES, FABRIC, PATTERN_MAKER, CUTTING, PRINTING, SEWING, QC, PACKAGING, DELIVERY, FINANCE`

## Seeded permissions (23 in Phase 1; Phase 2 added 5, see `PHASE_2_CUSTOMER_MASTER_DATA.md`)

`users.read`, `users.manage`, `roles.read`, `roles.manage`, `permissions.read`, `customers.read`, `customers.manage`, `samples.read`, `samples.manage`, `jobs.read_assigned`, `jobs.read_all`, `jobs.assign`, `stages.start`, `stages.complete`, `qc.perform`, `quotations.read`, `quotations.create`, `quotations.approve`, `payments.read`, `payments.verify`, `reports.read`, `settings.manage`, `audit.read`

## Initial permission matrix

Source of truth: `src/modules/roles/catalog/system-roles.ts`.

| Permission | SUPER_ADMIN | ADMIN | SALES | FABRIC / PATTERN_MAKER / CUTTING / PRINTING / SEWING / PACKAGING / DELIVERY | QC | FINANCE |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| users.read | ✔ | ✔ | | | | |
| users.manage | ✔ | ✔ | | | | |
| roles.read | ✔ | ✔ | | | | |
| roles.manage | ✔ | | | | | |
| permissions.read | ✔ | ✔ | | | | |
| customers.read | ✔ | ✔ | ✔ | | | ✔ |
| customers.manage | ✔ | ✔ | ✔ | | | |
| samples.read | ✔ | ✔ | ✔ | | | |
| samples.manage | ✔ | ✔ | ✔ | | | |
| jobs.read_assigned | ✔ | | | ✔ | ✔ | |
| jobs.read_all | ✔ | ✔ | ✔ | | | |
| jobs.assign | ✔ | ✔ | | | | |
| stages.start | ✔ | | | ✔ | ✔ | |
| stages.complete | ✔ | | | ✔ | ✔ | |
| qc.perform | ✔ | | | | ✔ | |
| quotations.read | ✔ | ✔ | ✔ | | | ✔ |
| quotations.create | ✔ | ✔ | ✔ | | | |
| quotations.approve | ✔ | ✔ | | | | |
| payments.read | ✔ | ✔ | | | | ✔ |
| payments.verify | ✔ | | | | | ✔ |
| reports.read | ✔ | ✔ | | | | ✔ |
| settings.manage | ✔ | | | | | |
| audit.read | ✔ | ✔ | | | | |

## Security decisions

- argon2id (`@node-rs/argon2`, OWASP parameters; prebuilt binaries, no install scripts). Password policy: 12–128 chars with lowercase, uppercase and a digit.
- Rate limiting (`@nestjs/throttler`): login/refresh limited per IP (`AUTH_RATE_LIMIT_PER_MINUTE`, default 10) plus a generous global ceiling. Set `TRUST_PROXY=true` behind a reverse proxy so the client IP is correct. The in-memory store is per instance; use a Redis store when scaling horizontally.
- Whitelist-only DTO validation (unknown properties → 400). Responses are mapped explicitly, so `passwordHash`/`refreshTokenHash` can never serialize.
- Audit metadata is additionally scrubbed of keys matching password/token/secret/hash. Never logged: passwords, access or refresh tokens. The request logger redacts `authorization` and `cookie`.
- Admin mutations write their audit row in the same transaction as the change.
- Prisma errors are translated (unique → 409, not found → 404, serialization conflict → 409); 5xx never leak details.
- Bearer tokens in the `Authorization` header (no cookies yet), so CSRF is not applicable.

## Seed

`pnpm db:seed` (dev) / `pnpm db:seed:prod` (compiled; `node dist/database/seed/run-seed.js`). Idempotent. Creates permissions, system roles and, if `SEED_SUPER_ADMIN_EMAIL` + `SEED_SUPER_ADMIN_PASSWORD` are set and the email does not exist, the initial SUPER_ADMIN (password must satisfy the policy). An existing account is never modified. Credentials are never stored in the repository; rotate the seeded password after first login.

## API summary

| Method & path | Permission |
|---|---|
| `POST /auth/login`, `POST /auth/refresh` | public (rate-limited) |
| `POST /auth/logout`, `/auth/logout-all`, `/auth/change-password`, `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id` | authenticated |
| `GET /admin/users`, `GET /admin/users/:id` | `users.read` |
| `POST /admin/users`, `PATCH /admin/users/:id`, `PATCH /admin/users/:id/status`, `DELETE /admin/users/:id`, `POST /admin/users/:id/roles` | `users.manage` |
| `GET /admin/roles`, `GET /admin/roles/:id` | `roles.read` |
| `POST /admin/roles`, `PATCH /admin/roles/:id`, `DELETE /admin/roles/:id`, `POST /admin/roles/:id/permissions` | `roles.manage` |
| `GET /admin/permissions` | `permissions.read` |
| `GET /admin/audit-logs` (filters: actorUserId, action, entityType, from, to) | `audit.read` |

All under `/api/v1`. Role/permission "assign" endpoints use replace semantics. Documented in Swagger at `/api/docs`.

## Audited actions

`auth.login_success`, `auth.login_failed`, `auth.logout`, `auth.logout_all`, `auth.session_revoked`, `auth.refresh_reuse_detected`, `auth.password_changed`, `user.created`, `user.updated`, `user.password_reset`, `user.status_changed`, `user.archived`, `user.roles_changed`, `role.created`, `role.updated`, `role.deleted`, `role.permissions_changed`.

## Known future considerations

- ~~Invitation / password-reset flows~~ (delivered in Phase 2; email delivery itself is still a port with no provider); optional MFA.
- Account lockout / progressive delays beyond per-IP rate limiting; Redis-backed throttling.
- Per-request permission lookups hit the database; add a short-TTL cache if it becomes a bottleneck.
- Customer-portal authentication (separate principal, audience and tables) reuses `TokenService`/session patterns.
- Audit log retention/archival and export; a partial unique index so archived users' emails can be reused.
- Permission catalogue grows with each phase; the seed must run on deploy.
