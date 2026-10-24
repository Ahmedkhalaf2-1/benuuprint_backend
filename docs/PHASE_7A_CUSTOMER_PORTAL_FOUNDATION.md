# Phase 7A — Customer Portal Foundation

The secure customer-facing backend: customer login, customer-owned sample requests (draft, edit, upload,
terms, submit), a customer-safe projection of status and activity, and the configurator for the request form.
Nothing commercial yet (quotation acceptance, payments, approvals, bulk orders and tracking are Backend 7B/7C).

Module: `src/modules/customer-portal/`. Swagger groups: **Customer Auth**, **Customer Profile**,
**Customer Samples**, **Customer Assets**, **Customer Configurator** (plus the staff-side *Customers* group for
provisioning). Customer routes use the `customer-bearer` security scheme.

## 1. Auth architecture and isolation

A portal login is **not** a staff `User`. It is a separate identity:

| Concern | Staff | Customer portal |
|---|---|---|
| Identity | `users` (+ roles/permissions) | `customer_accounts` — exactly one per `Customer` (`customer_id` UNIQUE) |
| Sessions | `sessions` | `customer_sessions` |
| Invite / reset tokens | `user_tokens` | `customer_account_tokens` |
| Access token | HS256, aud `benue-print-staff`, key `JWT_ACCESS_SECRET` | HS256, aud `benue-print-customer`, **different key** (`JWT_CUSTOMER_SECRET`, or an HMAC-derived key of `JWT_ACCESS_SECRET` when unset), claim `typ: customer` |
| Guard | global `JwtAuthGuard` → `PermissionsGuard` (deny by default) | `CustomerAuthGuard` (controller-level, via `@CustomerRoute()`) |
| Principal | `request.user` (`AuthUser`, permissions) | `request.customer` (`CustomerPrincipal`, no permissions) |

* A staff token fails customer verification (wrong key *and* audience); a customer token fails staff
  verification and the global guard answers 401 on every `/admin/*`, `/auth/*`, `/configurator/*` route.
  Both directions are covered by unit tests (`customer-token.service.spec.ts`) and e2e tests.
* `@CustomerRoute()` marks a controller: the staff guards step aside for it (`IS_CUSTOMER_ROUTE_KEY`), the
  customer guard authenticates. A forgotten decorator keeps the old behaviour: a staff route without
  permissions is still denied by default, so isolation fails closed.
* The guard re-reads the session and account **on every request** (account `ACTIVE`, customer not
  `ARCHIVED`/`BLOCKED`, session unrevoked and unexpired), so disabling an account, blocking a customer,
  logging out or a password change takes effect immediately.
* Password hashing is the same Argon2id `PasswordService`; refresh tokens are `<session id>.<256-bit secret>`
  with only a hash stored, rotated on every refresh; replaying a rotated token revokes the session and writes
  `customer_auth.refresh_reuse_detected`.

### Account lifecycle (staff provisions, customer activates)

1. Staff: `POST /admin/customers/:customerId/portal-account {email}` (`customers.manage`) → account `INVITED`
   + single-use invitation (`inviteToken` is returned only when `EXPOSE_ONE_TIME_TOKENS` is on, i.e. outside
   production; delivery goes through the existing `TokenDelivery` port).
2. Customer: `POST /customer/auth/activate {token, password}` → `ACTIVE`; then log in.
3. Staff can `GET` the account, `POST …/reinvite` (INVITED only; revokes the previous token), `POST …/disable`
   (revokes all sessions and open tokens) and `POST …/enable` (needs an activated account).
4. Forgotten password: `POST /customer/auth/forgot-password` (identical answer whether or not the email
   exists) → `POST /customer/auth/reset-password` (single use, revokes all sessions).

No permanent customer passwords are seeded; the seed is unchanged (no new permissions were needed).

## 2. Endpoints

Customer auth (`@Public` where marked, strict per-IP `auth` throttle):

* `POST /customer/auth/login` (public) → `{accessToken, refreshToken, tokenType, expiresIn, customer:{id, customerNumber, name, email}}`
* `POST /customer/auth/refresh` (public) · `POST /customer/auth/logout` · `GET /customer/auth/me`
* `POST /customer/auth/change-password` · `POST /customer/auth/activate` (public) ·
  `POST /customer/auth/forgot-password` (public) · `POST /customer/auth/reset-password` (public)

Profile: `GET|PATCH /customer/profile` (phone, WhatsApp, country, city, Instagram, preferred language only —
name and login email are staff-managed), `GET /customer/brands`, `GET /customer/brands/:id` (read-only;
archived brands hidden; staff create brands), `GET|POST /customer/addresses`, `PATCH /customer/addresses/:id`.

Samples: `GET /customer/samples` (filters: `status` (customer statuses, comma-separated), `search`, `brandId`,
`sort`, `page`, `pageSize`), `POST /customer/samples`, `GET|PATCH /customer/samples/:id`,
`GET /customer/samples/:id/submission-check`, `POST /customer/samples/:id/submit`,
`GET /customer/samples/:id/activity`, `GET /customer/samples/:id/messages`, and the specification parts
`POST|PATCH|DELETE /customer/samples/:id/{decorations|accessories|components}[/:partId]`.

Terms: `GET /customer/terms/sample`, `POST /customer/samples/:id/terms/accept`.

Files: `GET|POST /customer/samples/:id/files` (multipart `file`, `type`, optional `description`,
`decorationId`), `DELETE /customer/samples/:id/files/:attachmentId`,
`GET /customer/samples/:id/files/:attachmentId/download-url`.

Configurator: `GET /customer/configurator/sample-options`.

Rate limits: upload, submit and terms-accept use the `customerAction` throttle
(`CUSTOMER_ACTION_RATE_LIMIT_PER_MINUTE`, default 30/min/IP); login, refresh, activate and reset use the
existing strict `auth` throttle.

## 3. Ownership model (no IDOR)

* The customer comes only from the session (`CurrentCustomer`); the request body/query never names an owner.
  DTOs omit `customerId`, and the global `forbidNonWhitelisted` pipe rejects it (and `status`,
  `assignedSalesUserId`, `factoryInstructions`, …) with 400.
* Every lookup is scoped by the session's customer id (`findFirst({id, customerId})`). A foreign or unknown id
  is a plain **404**; nothing distinguishes "someone else's" from "does not exist". Child routes
  (`/samples/:id/decorations/:partId`, files) are matched on both ids, so a valid child id under the wrong
  parent also 404s.
* A `brandId` in the body is validated against the customer's own non-archived brands (one uniform 400,
  `brandId: brand not found`).
* A signed download URL is minted only after proving sample ownership **and** that the attachment belongs to
  that sample **and** the asset was uploaded by that customer.

## 4. Sample draft, edit, submit

The customer works on the *same* `Sample` table and rules as staff: the portal calls the shared
`SamplesService.createFor/update`, `SampleSpecService` (decorations, accessories, components),
`SampleTermsService.recordCustomerAcceptance` and `SampleWorkflowService.submitForCustomer`; the master-data
validation (product/fabric/colour/size/pattern/print method, mutual exclusions, approved pattern versions,
custom options with Pantone/HEX) is therefore identical. `ActorRef` (`{id, customer?}`) carries who acted;
audit rows and status history record `actor_customer_id` (and history `source = CUSTOMER`) instead of a user.

* `POST /customer/samples` creates a `DRAFT` (only `brandId` required) with `created_by_customer_id` set.
* `PATCH` is allowed only while `DRAFT` (a request returned for changes is a `DRAFT` again) → 409 afterwards.
  Draft saves do not run submit validation. Status cannot be patched.
* `POST …/submit` runs the full submission validation (all problems reported together; the active sample terms
  must be accepted) and applies the normal `submit` transition: status `SUBMITTED`, outbox event
  `SAMPLE_SUBMITTED`, status history, audit. Sales assignment is not required.
  `GET …/submission-check` returns `{ready, problems[]}` without changing anything.
* Staff see the request in Admin `/samples` (`createdVia: CUSTOMER_PORTAL`), in the Command Center "new
  requests"/review pipeline (status `SUBMITTED`) and through the normal review → quote → pay flow.

## 5. Customer status projection

No new enum, no second state machine: `toCustomerStatus()` derives the customer status from `SampleStatus`.

| Customer status | Internal |
|---|---|
| DRAFT | DRAFT (never returned for changes) |
| SUBMITTED | SUBMITTED |
| UNDER_REVIEW | UNDER_REVIEW (a hold keeps the status it interrupted) |
| QUOTATION_READY | QUOTED |
| PAYMENT_REQUIRED | AWAITING_PAYMENT |
| IN_SAMPLE_PRODUCTION | READY_FOR_PRODUCTION, IN_PRODUCTION |
| AWAITING_CUSTOMER_APPROVAL | AWAITING_APPROVAL |
| APPROVED | APPROVED, COMPLETED |
| CHANGES_REQUESTED | DRAFT with a `request-changes` history row |
| CANCELLED | CANCELLED, REJECTED |

Each response carries `status`, `statusLabel`, `nextStep` (plain customer language) and `editable`.
`GET …/activity` is a customer-safe timeline: one event per change the customer can tell apart (holds,
resumes, assignments, notes and review internals are dropped). The only staff text ever copied is the message of
a *request for changes*, which is addressed to the customer. `GET …/messages` returns only notes staff
explicitly marked `CUSTOMER_VISIBLE`, as "Benue Print team" (no author names).

Never exposed: internal notes, `factoryInstructions`, sales assignment, blockers, QC, rework, factory staff,
audit data, payment state, cost/margins, production snapshots.

## 6. Configurator projection

`GET /customer/configurator/sample-options` serves the staff configurator data (extracted into
`ConfiguratorService`; the staff route is unchanged) behind the customer principal: active catalogue only
(product types, fabrics with colours, size scales, print methods, accessories, components, fit methods, fabric
providers, decoration sides, units, active terms). **Patterns** are reduced to
`{patternVersionId, name, fitType, productTypeId}` — no `PAT-…` reference, code, notes, draft or superseded
versions (the source lists only the current APPROVED version of active patterns). The approved
`patternVersionId` is what the sample stores. No prices, fees, margins or storage details exist in the source.

## 7. Files and artwork

* Upload reuses the private Asset pipeline (`AssetsService.uploadForCustomer`): magic-byte sniffing (png, jpeg,
  gif, webp, pdf; client type/extension ignored), size cap enforced at the multipart parser and again in the
  service, random server-side storage key, never exposed. Customers may upload `REFERENCE`, `ARTWORK`,
  `SIZE_CHART`, `OTHER` (internal types such as `PAYMENT_PROOF` or `TECH_PACK` → 400), to their own `DRAFT`
  only, at most 25 files per request.
* `assets.uploaded_by_customer_id` records ownership. The customer sees and downloads only the files **they**
  uploaded; files staff attached to the same sample are not listed and not downloadable (404).
* Artwork: with `type=ARTWORK` and a `decorationId` the file becomes a `DRAFT` version of the placement's
  sample-owned `Artwork` (created on first upload, linked to the decoration), which satisfies the "artwork
  required" submission rule. No approval controls are exposed. Artwork versions are append-only in the
  database, so deleting such a file **retires** its version as `REJECTED` and unlinks a placement left without
  a usable version.
* Download: a short-lived signed URL from the existing storage layer, issued after the ownership proof above.

## 8. Terms

`GET /customer/terms/sample` returns the active `SAMPLE_TERMS`; `POST …/terms/accept` stores a
`CUSTOMER_AUTHENTICATED` acceptance for that exact version with the authenticated customer, time, IP and user
agent (`recorded_by_staff_user_id` stays empty; staff-recorded acceptance keeps its own mode). Draft only;
once per version; submission requires it.

## 9. Audit

Customer actions write audit rows with `actor_customer_id` (a CHECK allows at most one actor kind):
`customer_auth.{login_success,login_failed,logout,refresh_reuse_detected,password_*}`,
`customer_portal.{account_created,invitation_created,invitation_accepted,account_status_changed}`,
`sample.created|updated|submitted|status_changed`, `sample_decoration/accessory/component.*`,
`sample.file_uploaded_by_customer|file_removed_by_customer`, `sample.terms_accepted`,
`customer.profile_updated_by_customer`, address and asset events. Audit data is never returned to customers.

## 10. Migration

`20261023090000_customer_portal_foundation` (additive, no data changes): enum `CustomerAccountStatus`;
`TransitionSource` + `CUSTOMER`; tables `customer_accounts`, `customer_sessions`, `customer_account_tokens`;
columns `assets.uploaded_by_customer_id`, `audit_logs.actor_customer_id`,
`sample_status_history.actor_customer_id`, `samples.created_by_customer_id`; hand-written CHECKs
(`customer_accounts_active_has_password`, `customer_accounts_email_normalised`, `audit_logs_single_actor`).

Config: `JWT_CUSTOMER_SECRET` (optional), `CUSTOMER_ACTION_RATE_LIMIT_PER_MINUTE` (default 30).

## 11. Tests

* Unit: status projection and activity safety (`customer-sample-status.spec.ts`), staff/customer token
  isolation (`customer-token.service.spec.ts`), `PermissionsGuard` steps aside for portal controllers.
* e2e `test/customer-portal.e2e-spec.ts` (26 tests): provision/activate/login/refresh rotation and replay/
  logout/disable/block/reset; staff↔customer token isolation both ways; IDOR on reads, writes, parts, files and
  downloads; brand ownership; mass-assignment (customerId, status, factoryInstructions…); minimal and
  incomplete drafts; submission validation; full flow with artwork + terms + submit; locked-after-submit;
  staff integration (Admin list/detail, status history source, audit); projection and timeline leak checks;
  changes-requested loop; file validation/ownership/removal; configurator; profile, brands, addresses; staff
  provisioning rules.

## 12. Known limitations

* Brands are read-only for customers (staff create them); a customer with no brand cannot start a request until
  staff add one.
* Invitation/reset tokens go through the existing `TokenDelivery` port (log-only stand-in); wiring them to the
  Phase 6B notification templates (email/WhatsApp) is a follow-up.
* One portal login per customer (no multi-user companies yet); login email changes are staff-side only.
* Customers see only files they uploaded; staff-provided mockups are not yet customer-visible.
* Sessions are listed/revoked by logout only (no "my devices" screen yet).
* Throttling is per IP (customer-id based limits would need a shared store).

## 13. Backend 7B readiness

Ready: customer identity/guard/principal, ownership pattern (`CurrentCustomer` + scoped lookups), `ActorRef`
audit/history for customer actors, `CUSTOMER_AUTHENTICATED` terms mode, the customer status projection
(`QUOTATION_READY`, `PAYMENT_REQUIRED`, `AWAITING_CUSTOMER_APPROVAL` already mapped), customer-safe files and
signed downloads, and the throttle for sensitive actions.

7B needs: customer quotation view/accept/reject (projection without internal pricing fields, acceptance via the
existing quotation transitions with a customer actor), payment submission with proof upload
(`PAYMENT_PROOF` attached to a payment, verification stays staff-only), sample approval/revision requests
(approval records with a customer actor), the customer-visible staff files decision, and moving token delivery
onto the notification templates.
