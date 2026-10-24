# Phase 2 — Customers, Assets and Master Data

Phase 2 builds the data foundation Samples, Quotations and Factory Jobs will reference. It adds no commercial workflow: no Sample, Quotation, Payment, Order, Job, Inventory, Notification or 3D code exists.

## Entities and relationships

```
Customer 1─* Brand
Customer 1─* CustomerContact           Customer 1─* CustomerAddress
Asset *─* {Customer | Brand | Fabric | PatternVersion | ProductType | PrintMethod}   via AssetAttachment
ProductType 1─* Pattern 1─* PatternVersion ──(current)──> Pattern.currentVersionId
ProductType *─* Fabric                 via ProductTypeFabric (recommended / allowed / notes)
Fabric 1─* FabricColor ──(swatch)──> Asset
SizeScale 1─* SizeOption
PrintMethod, Accessory, ComponentOption (labels/packaging)   standalone, code-addressed
ReferenceSequence (CUS/BRD/FAB/PAT counters)     UserToken (invitation / password reset)     SeedGrantBatch
```

Everything is soft-archived (`archivedAt`) and nothing is hard-deleted by the API. Foreign keys are `ON DELETE RESTRICT` (or `SET NULL` for optional links), so history can't be orphaned.

## Customers

A **Customer** is an external client/brand owner and is unrelated to Staff Users (no login in this phase).

- Fields: `customerNumber` (`CUS-000001`, generated, unique, the visible reference), `displayName`, optional `email`, `phone`, `whatsapp`, `country`, `city`, `instagram`, `source`, `notes`, `status` (`ACTIVE | LEAD | INACTIVE | BLOCKED | ARCHIVED`), `archivedAt`.
- Email is optional and **not unique**: leads often arrive via WhatsApp and the same company can legitimately be entered twice by different sales people. Duplicate detection is a later concern (indexes exist on email/phone/whatsapp).
- Normalisation: email trimmed + lower-cased; phone/WhatsApp stripped of spaces, dashes, parentheses and dots, `00` → `+`, then validated (6–15 digits, optional `+`); Instagram stored without `@`. Search normalises phone input the same way.
- Archiving (`DELETE`) sets `status=ARCHIVED` + `archivedAt` and archives the customer's live brands. Archived customers are hidden by default (`includeArchived=true` or `status=ARCHIVED` shows them), can't be edited or get new brands, and are restored by setting a status (brands stay archived until restored individually).
- Search (`search=`) matches customer number, name, email, phone, WhatsApp and the names of **non-archived** brands. Filter by `status`; sort by `createdAt | displayName | customerNumber`.
- **Contacts** (`OWNER | PRODUCTION | FINANCE | SHIPPING | OTHER`) with at most one primary (partial unique index; setting a new primary demotes the old one). **Addresses** (`BILLING | SHIPPING | PICKUP | OTHER`) with at most one default per type. Both archive instead of delete.

## Brands

- `brandNumber` (`BRD-000001`), `customerId`, `name`, optional `instagram`, `website` (http/https), `description`, `primaryColor`/`secondaryColor` (`#RRGGBB`), `status` (`ACTIVE | INACTIVE | ARCHIVED`).
- A customer may own many brands. Names are not globally unique; **per customer a live brand name is unique, case-insensitively** (service pre-check for a friendly 409 plus a partial unique index). An archived brand frees its name; restoring it re-checks.
- Brands are managed under `/admin/customers/:customerId/brands` and `/admin/brands/:id`.

## Reference numbers

`ReferenceSequence(prefix PK, lastValue)`. `nextReference(tx, 'CUS')` runs one `INSERT … ON CONFLICT DO UPDATE … RETURNING` which takes a row lock, so concurrent creators are serialised and can never get the same number; because it runs in the creating transaction a rollback also rolls the counter back (no gaps). Never use `count + 1`. Prefixes in use: `CUS`, `BRD`, `FAB`, `PAT`; Phase 3 added `SMP`, `QTN`, `PAY`; later phases add `ORD`, `JOB` by extending `ReferencePrefix`. Tests create 10 customers concurrently and assert contiguous unique numbers.

## Asset and storage architecture

- **Metadata only in PostgreSQL**: `Asset(type, originalName, description, mimeType, sizeBytes, checksum (sha256), storageProvider, storageKey, uploadedByStaffUserId, createdAt, archivedAt)`. Bytes live in private object storage. Asset types: `LOGO, ARTWORK, MOCKUP, REFERENCE, SIZE_CHART, PATTERN, FABRIC_SWATCH, PAYMENT_PROOF, QC_PHOTO, TECH_PACK, LABEL, PACKAGING_REFERENCE, OTHER`.
- **`StorageService` port** (`put`, `exists`, `delete`, `getDownloadUrl`). Business modules depend only on it. `LocalStorageProvider` is the only implementation today (files under `STORAGE_LOCAL_ROOT`, mode 0600, never served statically). S3 / Cloudflare R2 / MinIO providers implement the same port with presigned GET URLs; nothing else changes. No MinIO container was added: it would add infrastructure and a failure mode with no Phase 2 benefit, and the port isolates the swap.
- **Private by construction**: there is no public or id-based file URL. `GET /admin/assets/:id/download-url` (needs `assets.read`) returns a short-lived signed URL (`STORAGE_SIGNED_URL_TTL_SECONDS`, default 300 s). The token is HMAC-SHA256 over `{key, expiry, filename, type, disposition}` with a key derived from `JWT_ACCESS_SECRET`; the signed token is the credential (same model as an S3 presigned URL) so the download route is unauthenticated, serves `Cache-Control: private, no-store`, `nosniff` and `attachment` by default (`inline` only for the image/PDF types we accept). Tampered, forged or expired tokens return 403.
- **Upload safety**: multipart `file` + `type`. Content is identified by **magic bytes** (png, jpeg, gif, webp, pdf); client Content-Type and extension are ignored, and SVG/HTML/executables are rejected (415). Size is capped by `STORAGE_MAX_FILE_BYTES` (default 20 MiB, 413), empty files are rejected (400). Storage keys are server-generated (`assets/YYYY/MM/<uuid>.<ext>`) and validated against a strict pattern; the local provider additionally resolves the path and rejects anything outside its root. The original file name is sanitised display metadata only and never used in a key.
- **Responses never expose** the storage key, provider or any filesystem path.
- **Archiving** hides an asset and blocks downloads but keeps bytes and metadata; it is refused for assets attached to an approved/superseded pattern version.
- **Attachments** use `AssetAttachment` with one real foreign-key column per target (`customer_id, brand_id, fabric_id, pattern_version_id, product_type_id, print_method_id`) and a `CHECK` that exactly one is set, plus a unique pair per (asset, target). This keeps referential integrity (unlike a `type + id` polymorphic pair). Attaching to a pattern version is only allowed while it is a DRAFT. **Future phases** add a nullable column (e.g. `sample_id`) and extend the `CHECK` in their migration.
- Local storage is single-node. Multi-node deployments must switch `STORAGE_PROVIDER` to an object store (or share the volume).

## Master data

Code-addressed entities share one base service: unique, immutable `UPPER_SNAKE_CASE` code (archived codes stay reserved), `isActive` (selectable or not) vs `archivedAt` (retired), search by code/name, `isActive`/`includeArchived` filters, sorting by `sortOrder | name | code | createdAt`, pagination, audited create/update/archive.

| Entity | Notes |
|---|---|
| ProductType | `category` (`TOPS, BOTTOMS, OUTERWEAR, HEADWEAR, DRESSES, OTHER`), `sortOrder`, `defaultSampleFee` (decimal, returned as a 2-decimal string). |
| Fabric | `referenceNumber` `FAB-…`, composition, `minGsm/maxGsm/defaultGsm` (validated min ≤ default ≤ max, also by a DB check), `unit`, notes. No stock fields; inventory will link by `fabric_id` later. |
| FabricColor | Per fabric: name (unique among live colours, case-insensitive), `internalCode`, `hex`, `pantone`, optional swatch asset (must be an image of type `FABRIC_SWATCH`), `isAvailable`, `isActive`. Predefined only: a future Sample may carry free-form custom colour values that never reference this table. |
| ProductTypeFabric | `isRecommended`, `isAllowed` (default true), notes. Guidance for the configurator, never a hard rule. `GET /admin/fabrics?productTypeId=` lists fabrics allowed for a product. |
| Pattern / PatternVersion | See below. |
| SizeScale / SizeOption | Scales (seeded `STANDARD`) hold ordered sizes; add kids/numeric scales later without schema change. Measurements per size are a later phase. |
| PrintMethod | `type` (`PRINT, EMBROIDERY, OTHER`), `minQuantity`, `maxColors`, `supportsFullColor`, `setupFee`. Pricing rules arrive with quotations. Method↔fabric/product compatibility was **not** added (no clear requirement; the `ProductTypeFabric` pattern can be copied when needed). |
| Accessory | code, category (free text), unit. No stock. |
| ComponentOption | One table for labels and packaging (`category` `LABEL | PACKAGING | OTHER`): neck/care/size label, hang tag, polybag, box, custom packaging. A generic table was chosen over many tiny ones because they share one shape and the goal is only "select from managed data". |

**Catalog (configurator view)**: `GET /catalog/{product-types,fabrics,print-methods,size-scales}` returns slim, active-only projections (no fees, notes, reference numbers or audit fields). Bounded lists, not paginated. They require `master_data.read` today; the customer-portal principal will reuse the projections behind its own guard.

## Patterns and versions

`Pattern` is the reusable identity of a fit (code, `PAT-…`, product type, fit type, status `DRAFT | ACTIVE | ARCHIVED`). `PatternVersion` is what gets approved (`DRAFT → APPROVED → SUPERSEDED`).

- Creating a pattern creates DRAFT version 1. Only one DRAFT exists at a time; new versions are `max + 1` under a `SELECT … FOR UPDATE` on the pattern (5 concurrent requests → exactly one succeeds).
- **Approving** promotes a draft to `Pattern.currentVersionId`, supersedes the previous current version, sets the pattern `ACTIVE` and records approver and time.
- **Approved/superseded versions are immutable**: no edits, no new or removed files (attach/detach return 409), their assets can't be archived, and the pattern's product type can't change after the first approval. Changes need a new version.
- Files attach to the **version** (`PATTERN_VERSION`), not the pattern, so each approved version keeps its exact files. Later: measurements and size charts hang off `PatternVersion` too.
- Since Phase 3, approval **requires at least one attached `PATTERN` file** (see `PHASE_3_SAMPLE_COMMERCIAL_WORKFLOW.md`).

## Staff invitations

`UserToken(type INVITATION | PASSWORD_RESET, tokenHash, expiresAt, consumedAt, revokedAt)`. Token = `<id>.<256-bit secret>`; only `sha256(secret)` is stored; lookup by primary key and constant-time compare; every failure returns the same `400 Invalid or expired token`.

1. `POST /admin/users` without a password creates the user as `INVITED` (unusable random hash).
2. `POST /admin/users/:id/invite` (`users.manage`; target must be `INVITED`; privilege-escalation guard applies) issues an invitation (`INVITATION_TTL_HOURS`, default 72). Re-inviting revokes the previous token.
3. `POST /auth/accept-invitation {token, password}` (public, rate-limited) sets the password (policy enforced), activates the user, consumes the token (atomic single use) and revokes sessions. The user then logs in normally. Suspended/archived users can't accept.
- **Delivery**: the raw token goes to the `TokenDelivery` port (default: logs that a token was issued for a user id, never the token or email). Attach an email/WhatsApp provider by binding another implementation in `AuthModule`.
- **Exposure**: with no email provider the admin needs the link. `EXPOSE_ONE_TIME_TOKENS` (default **true outside production, false in production**) returns `inviteToken`/`inviteUrl` (needs `PUBLIC_APP_URL`) in the admin response, once. Risk: an admin who sees the token could accept it and set the invitee's password; this is audited (`user.invitation_created`, `tokenExposedToAdmin`), limited by the escalation guard, and off in production by default. In production keep it off and wire real delivery.

## Password reset

- `POST /auth/forgot-password {email}` always returns `200` with the same message. Only for an `ACTIVE`, non-archived account does it create a token (`PASSWORD_RESET_TTL_MINUTES`, default 60; previous open token revoked), audit `auth.password_reset_requested`, and hand it to `TokenDelivery`. A dummy hash check evens out timing for unknown emails.
- `POST /auth/reset-password {token, newPassword}` validates and consumes the token, applies the password policy, **revokes all sessions**, revokes other open reset tokens and audits `auth.password_reset_completed`. Used, expired, superseded, malformed or suspended-account tokens all fail identically.
- A user's own password change and an admin password reset also revoke outstanding reset tokens.
- Both endpoints (and accept-invitation) use the strict per-IP auth rate limit.

## Permissions added

| Permission | Purpose | Seeded to |
|---|---|---|
| `master_data.read` | View master data, patterns and the catalog | ADMIN, SALES, FABRIC, PATTERN_MAKER, CUTTING, PRINTING, SEWING, QC, PACKAGING, FINANCE (not DELIVERY) |
| `master_data.manage` | Create/update/archive master data | ADMIN |
| `patterns.manage` | Create pattern versions and approve | ADMIN, PATTERN_MAKER |
| `assets.read` | View file metadata, get download links | ADMIN, SALES, FABRIC, PATTERN_MAKER, CUTTING, PRINTING, SEWING, QC, PACKAGING, FINANCE |
| `assets.manage` | Upload, attach, update, archive files | ADMIN, SALES, PATTERN_MAKER |

SUPER_ADMIN holds all. Customers, brands, contacts and addresses reuse `customers.read` / `customers.manage` (SALES manages, FINANCE reads). Invitations use `users.manage`. Existing databases receive the new defaults exactly once through the **grant batch** mechanism (`phase2-master-data` in `seed_grant_batches`): the seed applies a batch to existing roles only when it hasn't been recorded, so permissions an admin later removes are never silently re-added, and Phase 1 databases are baselined by the migration.

## API summary (all under `/api/v1`)

| Area | Endpoints | Permission |
|---|---|---|
| Customers | `GET/POST /admin/customers`, `GET/PATCH/DELETE /admin/customers/:id`, `PATCH …/:id/status` | `customers.read` / `.manage` |
| Contacts / addresses | `GET/POST /admin/customers/:id/{contacts,addresses}`, `PATCH/DELETE /admin/{customer-contacts,customer-addresses}/:id` | `customers.read` / `.manage` |
| Brands | `GET/POST /admin/customers/:customerId/brands`, `GET/PATCH/DELETE /admin/brands/:id` | `customers.read` / `.manage` |
| Assets | `POST /admin/assets` (multipart), `GET /admin/assets`, `GET/PATCH/DELETE /admin/assets/:id`, `GET …/:id/download-url`, `GET/POST …/:id/attachments`, `DELETE …/:id/attachments/:attachmentId`, `GET /storage/local/:token` (signed, public) | `assets.read` / `.manage` |
| Master data | `/admin/{product-types,fabrics,print-methods,accessories,component-options,size-scales}` (list/get/create/patch/archive); `/admin/fabrics/:id/colors`, `/admin/fabric-colors/:id`; `/admin/size-scales/:id/sizes`, `/admin/size-options/:id`; `PUT/DELETE /admin/product-types/:id/fabrics/:fabricId`, `GET …/fabrics` | `master_data.read` / `.manage` |
| Patterns | `/admin/patterns` CRUD, `POST …/:id/versions`, `PATCH …/:id/versions/:versionId`, `POST …/versions/:versionId/approve` | read: `master_data.read`; write: `patterns.manage` |
| Catalog | `GET /catalog/{product-types,fabrics,print-methods,size-scales}` | `master_data.read` |
| Invitations | `POST /admin/users/:id/invite`, `POST /auth/accept-invitation` | `users.manage` / public |
| Password reset | `POST /auth/forgot-password`, `POST /auth/reset-password` | public (rate-limited) |

Swagger tags: Customers, Brands, Assets, Master Data, Patterns, Staff Invitations, Password Reset.

## Seed data

Idempotent and create-if-missing keyed by `code`: re-running never duplicates rows and never overwrites admin edits (so later description changes in code don't propagate; edit through the API). Seeded: 13 product types, 13 fabrics (Milton … Other / Not Sure; GSM/composition only where reasonably standard, to be curated by Benue Print), 8 fabric↔product hints (e.g. French Terry → Hoodie/Crewneck recommended), 5 print methods, 7 accessories, 7 label/packaging components, size scale `STANDARD` (XXS–XXL, ONE_SIZE). No customers or other business records are seeded.

## Audit coverage

Customer create/update/status/archive; brand create/update/archive; contact and address create/update/archive; asset upload/update/archive/attach/detach (metadata only, never content); every master-data create/update/archive (product types, fabrics, fabric colours, print methods, accessories, components, size scales/options, patterns); pattern version create/update/approve; product↔fabric set/remove; invitation created/accepted; password reset requested/completed. Raw tokens, passwords and file contents are never recorded (tests assert it).

## Architecture decisions affecting Phase 3

- Samples should reference `customer_id`, `brand_id`, `product_type_id`, `fabric_id` (nullable), `fabric_color_id` (nullable) **plus** free-form custom colour fields (name/hex/pantone), `pattern_version_id` (pin the approved version, not the pattern), size via `size_option_id`/size scale, `print_method_id`, and join tables for accessories and components. "Other / Not Sure" exists as fabric `OTHER_NOT_SURE`; add a custom-text field on the sample for requests that fit no master row. Product types have no "other" row: either seed one or allow a custom product name on the sample.
- Fabric supplied by customer vs factory is a sample/order attribute, not a fabric attribute.
- Sample files attach through a new `sample_id` column on `asset_attachments` (extend the CHECK). Approved artwork needs versioning like patterns (consider an `ArtworkVersion` analogous to `PatternVersion`).
- Money: `Decimal(12,2)` with a single implicit currency until pricing; add an explicit currency with the pricing model.
- New reference prefixes: extend `ReferencePrefix` (`SMP`, `QTN`, `ORD`, `JOB`).
- Remember to add new default role grants as a new grant batch, never by editing shipped ones.

## Known limitations

Local storage is single-node; customers have no portal login yet; no malware scanning of uploads; contacts/addresses have no duplicate detection; email is not unique; archived master-data rows can't be restored through the API (only customers/brands can); list search uses `ILIKE` (add `pg_trgm` indexes if tables grow large).
