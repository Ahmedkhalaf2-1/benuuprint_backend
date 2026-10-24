# Phase 7D — Customer self-signup + email verification

Journey: public site → `POST /customer/auth/register` → verification email → `POST /customer/auth/verify-email` → normal `POST /customer/auth/login` → `GET/PATCH /customer/profile` → sample flow. It reuses the Phase 7A identity (`Customer` + `CustomerAccount`, own JWT key/audience, own sessions and tokens). No second identity model, no staff `User`, no change to staff auth or to the login/session architecture.

## Register
`POST /customer/auth/register` (public, per-IP auth throttle). Body (whitelisted; any other field, e.g. `customerId`, `status`, `roles`, `emailVerified`, `companyName`, is a 400):

| field | rules |
|---|---|
| `name` | 2–120 chars, trimmed |
| `email` | valid, trimmed + lower-cased (same normalisation as login/provisioning) |
| `phone` | optional, `+`/digits 6–15 (same pattern as the profile) |
| `password` | existing policy: min length, upper + lower + digit |
| `acceptedTerms`, `acceptedPrivacy` | must be boolean `true` |

Response `201 { status: "verification_required", email: "a***@example.com" }`. No token, hash, session or internal id.

In ONE transaction: `Customer` (`source: SELF_SIGNUP`, status `ACTIVE`, number `CUS-…`), `CustomerAccount` (`PENDING_VERIFICATION`, Argon2id hash via the existing `PasswordService`, `selfRegistered`, `termsAcceptedAt`/`privacyAcceptedAt`), an `EMAIL_VERIFICATION` token and the audit entry. Any failure rolls all of it back (tested). The email is sent after commit; a delivery failure never fails the request (the visitor can resend).

Company/brand: not accepted. Customers create their own brand with `POST /customer/brands` (see below); a new customer starts with an empty list. Sample business rules are unchanged.

## Verification
- Token: existing `customer_account_tokens` (`<id>.<secret>`, sha256 stored, constant-time compare, atomic single use), new type `EMAIL_VERIFICATION`, TTL `EMAIL_VERIFICATION_TTL_HOURS` (default 24). Issuing a new one revokes the previous.
- `POST /customer/auth/verify-email {token}` → `200 { status: "verified" }`. Invalid, expired, replayed, wrong-type or malformed tokens all give the same 400. The account becomes `ACTIVE` with `emailVerifiedAt`. **No automatic login**: the customer signs in normally (the session architecture stays untouched).
- Link: `${PUBLIC_APP_URL}/account/verify-email?token=…` (never hard-coded). If `PUBLIC_APP_URL` is unset or the email channel is disabled, sending is skipped with a warning.
- Delivery: the email goes through the existing `EmailProvider` port (`EMAIL_PROVIDER`, `EMAIL_FROM`), idempotent per token. It does **not** use the notification outbox: outbox payloads and stored notification bodies are forbidden from holding secrets, and the link is a credential. So the token exists only in the email. English only for now. With `EXPOSE_ONE_TIME_TOKENS=true` (dev only, same switch as admin invitation tokens) the link is written to the debug log.

## Login before verification
Correct password on a `PENDING_VERIFICATION` account → `403 { error: "EMAIL_NOT_VERIFIED" }`, no session, audited. Wrong password / unknown email stay the uniform 401, so strangers cannot probe verification state. Refresh and the auth guard already require `ACTIVE`. Forgot-password does not bypass verification. Staff cannot enable an unverified account (409).

## Resend
`POST /customer/auth/resend-verification {email}` → always `200 { message }`. Only a `PENDING_VERIFICATION` account gets a link, at most one per 60 s and 5 per rolling hour per account (counted from token rows); the previous link is revoked. Plus the per-IP throttle.

## Duplicates and enumeration
Register answers **409** for an existing email (also case/whitespace variants, also staff-provisioned accounts). This is an explicit UX choice; resend and forgot-password stay generic. A race on the unique index also becomes 409.

## Terms / privacy
There is no site-level Terms/Privacy version model (only sample terms). The acceptance is stored as timestamps on the account (DB CHECK: a self-registered account always has both) and in the `customer_auth.self_registered` audit entry. No version is recorded because none exists.

## Rate limiting
`register`, `verify-email`, `resend-verification` use `@AuthThrottle` (per IP, `AUTH_RATE_LIMIT_PER_MINUTE`); resend adds the per-account cooldown/cap.

## Audit
`customer_auth.self_registered`, `customer_auth.email_verified`, `customer_auth.verification_resent`, plus `login_failed` with reason `email_not_verified`. The actor is the customer record created/owned by the account; tokens are never audited.

## Schema (migration `20261024090000_customer_self_signup`)
`CustomerAccountStatus.PENDING_VERIFICATION`, `UserTokenType.EMAIL_VERIFICATION`; `customer_accounts.email_verified_at`, `self_registered`, `terms_accepted_at`, `privacy_accepted_at`; existing active accounts backfilled; CHECKs `active_email_verified` and `self_signup_accepted`. Invitation acceptance now also sets `email_verified_at`.

## Tests
`test/customer-signup.e2e-spec.ts` (11 tests): success and DB state, duplicates and normalisation, validation and smuggled fields, verification and portal access, expiry, replay/wrong token, unverified login, resend, throttling, isolation/no privilege, rollback. Also fixed a time-of-day bug in `notifications.e2e-spec` ("today" was UTC but the test business timezone is Asia/Kolkata).

## Known limitations
English-only email; no email-change flow; no CAPTCHA/bot protection beyond throttling; unverified accounts are not auto-expired/cleaned; legal acceptance has no version; a self-signup customer is `ACTIVE` immediately (not a LEAD) so the order flow works; no brand until the customer creates one.

## Frontend 7D contract
- `POST /customer/auth/register` → 201 `{status, email}` | 400 (messages array) | 409 | 429. Show "check your inbox".
- `/account/verify-email?token=` → `POST /customer/auth/verify-email {token}` → 200 → redirect to sign-in (keep the `returnTo=/account/samples/new`); 400 → offer resend.
- `/account/resend-verification` → `POST /customer/auth/resend-verification {email}` → always 200 generic message.
- Login `403` with `error === "EMAIL_NOT_VERIFIED"` → send to resend page.

## Switching verification off (development)
`CUSTOMER_EMAIL_VERIFICATION_REQUIRED` (default `true`; set `false` in the git-ignored `.env` for development).

When `false`:
- `register` creates the Customer and an **ACTIVE** account (no token, no email) and answers `201 { status: "registered", email, emailVerificationRequired: false }`. `email_verified_at` stays `NULL` (never claimed without a verification); migration `20261024120000_customer_email_verification_optional` drops the `ACTIVE ⇒ verified` CHECK for this reason.
- `login` never answers `EMAIL_NOT_VERIFIED`; an account that registered while verification was required is let in (promoted to ACTIVE, still unverified). Staff may enable such an account.
- `verify-email` and `resend-verification` are untouched and keep working.
- Password hashing, duplicate protection (409), throttling and customer/staff isolation are unchanged.

To restore verification: set the flag to `true` (or remove it) and restart. No code change. Accounts created while it was off stay ACTIVE.

Frontend: `GET /customer/auth/config` (public) returns `{ emailVerificationRequired }`. When `false`: after register go to sign-in (keep `returnTo`), do not show "check your email" or resend-verification UI. The register response carries the same flag and `status: "registered"`.

## Customer brand self-creation
Onboarding: Register → Sign in → create first brand → start a sample.
- `POST /customer/brands` body `{ name (1–120), instagram?, website? (http/https), description?, primaryColor?, secondaryColor? (#RRGGBB) }` → `201` brand (`id, brandNumber, name, instagram, website, description, primaryColor, secondaryColor`). `status`, `customerId`, notes, archive state or any other field is a 400. The owner is always the session's customer.
- `PATCH /customer/brands/:id` (same fields, all optional, `null` clears optional ones). A foreign or archived id is 404. No delete.
- Created through the same `BrandsService` as staff (same `BRD-` numbering, same case-insensitive per-customer duplicate rule → 409, same `brand.created` / `brand.updated` audit, with the customer as actor). Brands are `ACTIVE` immediately; no staff review exists in the domain.
- Samples reference the real Brand row; using another customer's brand stays the existing 400 "brand not found". Staff brand routes are unchanged.
