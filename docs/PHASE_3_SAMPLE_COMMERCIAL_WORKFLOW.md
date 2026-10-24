# Phase 3 — Samples and the Commercial Workflow

Phase 3 takes a sample request from draft to an approved, frozen production reference: specification, review, quotation, payment, customer approval and the immutable `SampleProductionSpec`. (Phase 4/4.1 inserts the factory between payment and customer approval: the physical sample is built from a `PRE_PRODUCTION` spec, and approval of the finished sample freezes the `APPROVED_REFERENCE`.) Phase 3 itself stops there. No Factory Job, workflow template, production stage, order, inventory, notification or 3D exists.

## Sample model

`Sample` (`samples`) belongs to a **Customer** and a **Brand** (the brand must belong to the customer). `sampleNumber` (`SMP-000001`) comes from `ReferenceSequence` inside the creating transaction and is immutable (a database trigger also forbids changing it or the customer).

| Group | Fields |
|---|---|
| Product | `productTypeId` **XOR** `customProductName` (+ `customProductDescription`) |
| Fabric | `fabricId` **XOR** `customFabricName` (+ description); `fabricProvider` = `CUSTOMER / BENUE_PRINT / NOT_DECIDED`; `gsm` |
| Colour | `fabricColorId` **XOR** custom colour (`customColorName`, `customPantone`, `customHex`) |
| Size / fit | `sampleSizeOptionId` (any `SizeOption`, not tied to the seeded sizes); `fitMethod` = `BENUE_PATTERN / COPY_CUSTOMER_PIECE / CUSTOM_SIZE_CHART / NOT_SURE`; `patternVersionId` |
| Notes | customer-facing: `notes`, `fitNotes`, `printNotes`, `fabricNotes`, `specialInstructions`; internal: `factoryInstructions` |
| Lifecycle | `status`, `holdPreviousStatus`, `submittedAt / reviewedAt / approvedAt / completedAt`, `archivedAt`, `revisionNumber`, `revisionOfId` |
| Ownership | `createdByStaffUserId`, `assignedSalesUserId` |
| Cache | `paymentState` (see Payments) |

Decisions:
- **Exclusive pairs, not "both allowed".** Having a catalogue product *and* a custom product name is contradictory, so it is rejected (service **and** `CHECK` constraints). Switching is explicit (`productTypeId: X, customProductName: null`); nothing is silently auto-fixed.
- **Fabric provider lives on the Sample**, never on the Fabric master data. "Other / Not Sure" is the seeded fabric `OTHER_NOT_SURE`; a fabric that is not in the catalogue is `customFabricName`. Custom colours (name / Pantone / hex, any combination) are always possible and never need a `FabricColor` row.
- **A Sample references a `PatternVersion`, never a `Pattern`**, and only an `APPROVED` one (`patternVersionId` is only allowed with `BENUE_PATTERN`).
- Drafts may be incomplete; completeness is checked at submit. The database only enforces what is always true (exclusivity, positive gsm, "has a product once it leaves DRAFT").
- **No print** = zero `SampleDecoration` rows (no extra flag to keep consistent). A decoration has print method, free-text placement, side (`FRONT, BACK, LEFT_SLEEVE, RIGHT_SLEEVE, OTHER`), optional size + unit, colour count, notes, `artworkRequired`, optional `artworkId`.
- **Accessories** (`SampleAccessory`) and **labels/packaging** (`SampleComponent`) select master-data rows **or** free-text custom names (exactly one), with quantity/notes.
- Spec parts (decorations, accessories, components, files) are removed with a real delete while the sample is a DRAFT (an edit of a working copy, audited); the approved state is preserved by the snapshot.

## Lifecycle state machine

`src/modules/samples/sample-state-machine.ts` is the single source of truth (unit-tested: every action × every status). There is no "set status" endpoint; `PATCH` rejects `status`.

```
DRAFT ─submit→ SUBMITTED ─review→ UNDER_REVIEW ─(quotation sent)→ QUOTED ─(quotation accepted)→ AWAITING_PAYMENT
  ─(payment covers total)→ READY_FOR_PRODUCTION ─start-production→ IN_PRODUCTION ─finish-production→ AWAITING_APPROVAL
  ─(customer approval recorded)→ APPROVED ─complete→ COMPLETED
```

| Action | From | To | Reason | Origin |
|---|---|---|---|---|
| submit | DRAFT | SUBMITTED | – | staff (validated) |
| review | SUBMITTED | UNDER_REVIEW | – | staff |
| request-changes | SUBMITTED, UNDER_REVIEW | DRAFT | required | staff |
| quote-sent | UNDER_REVIEW | QUOTED | – | system (quotation sent) |
| quote-accepted | QUOTED | AWAITING_PAYMENT | – | system (acceptance recorded) |
| quote-rejected | QUOTED | UNDER_REVIEW | – | system (rejection recorded) |
| payment-covered | AWAITING_PAYMENT | READY_FOR_PRODUCTION | – | system (verified payments ≥ total; zero-value quotes immediately) |
| start-production / finish-production | READY_FOR_PRODUCTION / IN_PRODUCTION | IN_PRODUCTION / AWAITING_APPROVAL | – | driven by the **sample-production factory job** (created / completed); the manual endpoints are refused while a live job exists |
| sample-approved | AWAITING_APPROVAL | APPROVED | – | system (creates the frozen spec) |
| sample-rejected | AWAITING_APPROVAL | IN_PRODUCTION | required | system (rework) |
| complete | APPROVED | COMPLETED | – | staff |
| hold / resume | in-flight ↔ ON_HOLD | previous | hold: required | staff |
| reject | SUBMITTED, UNDER_REVIEW, QUOTED, AWAITING_PAYMENT, ON_HOLD | REJECTED | required | staff |
| cancel | DRAFT … READY_FOR_PRODUCTION, ON_HOLD | CANCELLED | required | staff |

`COMPLETED`, `REJECTED`, `CANCELLED` are terminal. Cancelling once production started means hold first. Each transition takes a **row lock**, validates, updates timestamps, appends `sample_status_history` (append-only) and writes an audit entry in one transaction; `source` distinguishes staff actions from automatic consequences. Cancel/reject audit entries record any `verifiedPaid` amount (refunds are not modelled).

### Editing rules
| Status | Specification (product, fabric, colour, size, fit, parts, files) | Note fields |
|---|---|---|
| DRAFT | editable | editable |
| SUBMITTED, UNDER_REVIEW | **locked** (use `request-changes` to reopen) | editable (staff refinement) |
| QUOTED and later | locked | locked |

## Submission validation

`POST …/submit` runs `collectSubmissionProblems` (pure, unit-tested) inside the row-locked transaction and returns **all** problems at once as a 400 message list: customer not blocked/archived, brand belongs to the customer and is live; product (catalogue and usable, or custom name); fabric; colour (catalogue colour of *that* fabric and available, or custom); gsm within the fabric range; size; fit (BENUE_PATTERN needs an APPROVED, current, non-archived pattern version for the same product type; CUSTOM_SIZE_CHART needs a live `SIZE_CHART` attachment); decorations (usable print method, placement, colour count ≤ method maximum, artwork present and usable when `artworkRequired`, artwork belongs to the brand/sample); acceptance of the **active** terms. Concurrent submits: one wins, the rest get 409.

## Pattern approval needs a file (Phase 2 rule tightened)

A `PatternVersion` can only be approved if at least one live (non-archived) **`PATTERN`-type** asset is attached. Checked under the pattern row lock; detaching also locks it so the last file cannot disappear mid-approval. Draft versions may still have no files. (Phase 2 tests were updated to attach a file first, and new tests cover the rule.)

## Artwork versioning

`Artwork` (named design, owned by a **brand** — reusable — or by one **sample**, `CHECK` exactly one) has immutable `ArtworkVersion`s (`DRAFT → APPROVED → SUPERSEDED`, or `REJECTED`). Purposes: `FRONT_PRINT, BACK_PRINT, EMBROIDERY, LABEL, PACKAGING, GENERAL_REFERENCE, OTHER`.

- A new file is always a new version (one open DRAFT at a time); versions are never edited in place. Notes of a DRAFT can change.
- Approval is recorded through the **approvals flow** (type `ARTWORK`): approving promotes the draft and supersedes the previous approved version in the same transaction under an artwork row lock. A partial unique index guarantees **at most one APPROVED version per artwork**, and a trigger makes approved/superseded/rejected versions immutable (identity, file and status; only APPROVED → SUPERSEDED is allowed).
- `SampleDecoration.artworkId` points at the artwork; when the sample is approved the snapshot records the **approved version** and its file checksum. Approving a sample whose required artwork has no approved version is refused.
- Files are private assets (Phase 2 storage); responses show metadata only. An asset used by a non-rejected artwork version, a payment proof or a non-draft sample cannot be archived.

## Attachments

`asset_attachments` gained `sample_id` (real FK; the exactly-one-target `CHECK` now covers seven targets). Allowed types on a sample: `REFERENCE, MOCKUP, SIZE_CHART, ARTWORK, OTHER`; attaching/detaching is DRAFT-only and needs `samples.manage` even through the generic asset route (no side door). `PAYMENT_PROOF` goes through `Payment.proofAssetId`.

## Quotations

`Quotation` (`QTN-000001`, currency, `status` mirroring its live version) → immutable-once-sent `QuotationVersion` (`DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED, SUPERSEDED`) → `QuotationLineItem` (`SAMPLE_FEE, PATTERN_FEE, PRINTING, EMBROIDERY, DESIGN_SERVICE, FABRIC, ACCESSORIES, PACKAGING, DISCOUNT_ADJUSTMENT, OTHER`, quantity × unit price, free-form `metadata` for future pricing rules).

- **Money is `Decimal`, calculated by the server only** (`computeTotals`, `decimal.js` via Prisma): `amount = round(qty × unit)`, `subtotal = Σ`, `tax = round((subtotal − discount) × taxPercent / 100)`, `total = subtotal − discount + tax`, half-up to 2 places. Clients never send totals (unknown fields are rejected). A database `CHECK` re-verifies `total = subtotal − discount + tax`. Only `DISCOUNT_ADJUSTMENT` lines may be negative; the subtotal cannot go negative.
- Currency is per quotation (ISO 4217), defaulting to `DEFAULT_CURRENCY` (`EGP`), never hard-coded in the logic.
- A quotation is created while the sample is `UNDER_REVIEW`; one live quotation per sample. **Only the latest version is ever live** (partial unique index): creating version N+1 supersedes a SENT predecessor immediately; an open DRAFT must be edited or sent; an ACCEPTED quotation is final (changes mean revising the sample). A trigger freezes every non-DRAFT version and its line items.
- `send`: ≥ 1 line, `validUntil` in the future, first send moves the sample to QUOTED. Offers expire lazily: a decision after `validUntil` is refused and the version is recorded `EXPIRED`.
- `accept` / `reject` (`approvals.manage`, with a mandatory source note) open and answer a QUOTATION approval in one step and apply the effect atomically (acceptance → AWAITING_PAYMENT; rejection → UNDER_REVIEW). Superseded, expired or on-hold cases are refused with a clean rollback.

## Payments

`Payment` (`PAY-000001`): amount (`Decimal`, > 0, cannot exceed the remaining balance), currency (must equal the quotation's), method (`INSTAPAY, VODAFONE_CASH, TELDA, BANK_TRANSFER, CASH, OTHER`), `status` (`SUBMITTED → UNDER_REVIEW → VERIFIED | REJECTED | CANCELLED`), optional transaction reference, `proofAssetId` (a `PAYMENT_PROOF` asset, one payment per proof), `receivedAt`, verification fields. No gateway; no card data: references that look like card numbers (Luhn) are refused, and the audit log stores amount/method/currency only.

- Recorded against the **accepted** quotation version; the sample must have one and be in a payable status.
- **Verification is row-locked** on the sample: two payments verified at once cannot together exceed the total (one gets 409). The person who recorded a payment cannot verify it, and the `ADMIN` role does not hold `payments.verify` (finance does) — separation of duties.
- Decided payments are final (API + trigger). Verified payments that cover the accepted total move the sample to `READY_FOR_PRODUCTION` automatically.
- **Commercial summary** (`GET …/commercial-summary`): `quotedTotal`, `acceptedTotal`, `verifiedPaid`, `pendingPayments` (submitted/under review are *not* paid), `remaining` (never negative), `paymentState` (`UNPAID / PARTIALLY_PAID / PAID`). Computed from the accepted quotation and verified payments. `Sample.paymentState` is a stored **cache** of that derivation, refreshed in the same transaction as every event that affects it, kept only so lists can filter/sort on it.

## Approvals

One model for recorded decisions: `QUOTATION`, `ARTWORK`, `SAMPLE`, `PRODUCTION_SPEC` (`CHECK` ties the target column to the type; one pending request per target). Statuses `PENDING / APPROVED / REJECTED / CANCELLED / EXPIRED` (optional `expiresAt`, evaluated lazily).

- **Modes:** `STAFF_RECORDED_ON_BEHALF` (customer decisions: quotation, sample, artwork) and `STAFF_INTERNAL` (internal sign-offs; not allowed for quotation/sample decisions). `CUSTOMER_AUTHENTICATED` is reserved: the API cannot record it until customer sign-in exists, and `respondedByCustomerId` is already in the schema for it. Staff-recorded decisions are never presented as customer actions: the response says `staffRecorded: true`, an evidence **source note is mandatory**, and the audit entry carries actor, mode and note.
- `SAMPLE` and `PRODUCTION_SPEC` additionally need `samples.approve`.
- Effects run in the **same transaction** as the decision: quotation accepted/rejected, artwork version approved (previous superseded)/rejected, sample approved (frozen spec + APPROVED) or rejected (back to IN_PRODUCTION with the reason). `PRODUCTION_SPEC` is a recorded sign-off only.
- Decided approvals are final (trigger).

## Terms

`TermsVersion` (`code`, `version`, `title`, `content`, `isActive`): content is immutable (trigger), one active version per code (partial unique index). `POST /admin/terms` publishes the next version (optionally activating it); activation switches atomically. `SampleTermsAcceptance` is append-only and unique per (sample, version): mode `STAFF_RECORDED_ON_BEHALF`, recording staff member, evidence note, request IP/user agent. Submitting requires acceptance of the **active** `SAMPLE_TERMS` version; with none active nothing is required. The seed creates a **placeholder** v1 (clearly marked "to be confirmed by Benue Print") only if no active version exists; it never steals activation. No legal text lives in code.

## The frozen production specification

When the customer's approval of the produced sample is recorded, `SampleProductionSpec` is written (append-only trigger, unique `(sample, revision)`) in the same transaction that moves the sample to APPROVED. It stores a **self-contained JSON snapshot** (schema v1) plus a SHA-256 `specHash` of its canonical form, and plain id columns (product, fabric, colour, pattern version, size, quotation version, terms version, customer, brand) next to the values. The snapshot holds:

- sample number/revision, customer and brand (ids + numbers + names)
- product, fabric, colour (catalogue **or** custom, with `source`), fabric provider, gsm, size (+ scale)
- fit method, the **pattern version** (id, number, reference, name, fit type, approved files with checksums) and size charts
- decorations with print method (code/name/type), placement, size, colours, notes and the **approved artwork version + file checksum**
- accessories, labels/packaging (catalogue or custom), all sample attachments (checksums), all instruction fields
- the accepted quotation (number, version, total, currency, accepted time), terms acceptances, and the approval (mode, recorder, source note)

Because it carries values, later edits to master data (renames, colour changes, archiving) cannot change it; tests prove this and prove direct SQL `UPDATE`/`DELETE` fail. Freezing is refused if the sample has no accepted quotation, an unapproved pattern version, or required artwork without an approved version.

**Revisions:** an approved (or any non-draft) sample is never edited. `POST …/revise` clones the specification, decorations, accessories, components and files into a **new DRAFT sample** (new SMP number, `revisionNumber + 1`, `revisionOfId`), re-creating sample-owned artwork as a draft version of the same file; quotations, payments, approvals, notes and terms acceptance are not copied. One open revision at a time. The `revision` column on the spec is there for a future in-place re-approval flow.

## Permissions

New: `samples.submit`, `samples.review`, `samples.assign`, `samples.approve`, `payments.manage`, `approvals.manage`, `terms.manage` (grant batch `phase3-samples`, applied once to existing roles). Existing permissions reused: `samples.read/manage`, `quotations.read/create`, `payments.read/verify`, `assets.*`, `master_data.read`.

| Role | Phase 3 grants (in addition to earlier phases) |
|---|---|
| SALES | submit, review, approve (record customer approval), `approvals.manage`, `payments.read`, `payments.manage` |
| FINANCE | `samples.read`, `payments.manage` (verify/read were already theirs) |
| PATTERN_MAKER | `samples.read` |
| ADMIN | submit, review, assign, approve, `payments.manage`, `approvals.manage`, `terms.manage` (no `payments.verify`) |
| other production roles | nothing: they get task-specific views in Phase 4 |
| SUPER_ADMIN | all |

`quotations.approve` is unchanged and reserved (e.g. for a future discount-approval rule); sending a quotation needs `quotations.create`. Tests assert the matrix per role.

## API summary (`/api/v1`)

| Area | Endpoints |
|---|---|
| Samples | `GET/POST /admin/samples`, `GET/PATCH/DELETE /admin/samples/:id`, `POST …/:id/revise`, `GET …/:id/status-history`, `GET …/:id/production-spec(s)` |
| Workflow | `POST /admin/samples/:id/{submit,review,request-changes,hold,resume,reject,cancel,start-production,finish-production,complete,assign-sales}` |
| Parts | `POST /admin/samples/:id/{decorations,accessories,components}`, `PATCH/DELETE /admin/{sample-decorations,sample-accessories,sample-components}/:id` |
| Files / notes / terms | `GET/POST/DELETE /admin/samples/:id/assets`, `GET/POST/DELETE …/:id/notes`, `POST …/:id/terms-acceptances`, `GET/POST /admin/terms`, `POST /admin/terms/:id/{activate,deactivate}` |
| Artwork | `GET/POST /admin/artworks`, `GET/PATCH/DELETE …/:id`, `POST …/:id/versions`, `PATCH /admin/artwork-versions/:id` |
| Quotations | `GET/POST /admin/samples/:id/quotations`, `GET /admin/quotations/:id`, `POST …/:id/versions`, `GET/PATCH /admin/quotation-versions/:id`, `POST …/:id/{send,accept,reject}` |
| Payments | `GET/POST /admin/samples/:id/payments`, `GET/PATCH /admin/payments/:id`, `POST …/:id/{review,verify,reject,cancel}` |
| Approvals | `GET/POST /admin/samples/:id/approvals`, `POST /admin/approvals/:id/{approve,reject,cancel}` |
| Summary / configurator | `GET /admin/samples/:id/commercial-summary`, `GET /configurator/sample-options` |

Swagger tags: Samples, Sample Decorations, Sample Assets, Sample Notes, Artwork, Quotations, Payments, Approvals, Terms, Configurator. Sample list: search (number, customer number/name/email/phone, brand), filters (status list, customer, brand, sales owner / unassigned, product, fabric, payment state, approval state, created/submitted ranges), sorts (newest, oldest, updated, submitted, sampleNumber); one query with joins (no N+1).

## Configurator

`GET /configurator/sample-options`: product types, fabrics with available colours and allowed products, size scales, patterns that have an approved current version (with the `patternVersionId` to use), print methods, accessories, labels/packaging, enum choices and the active terms. Active records only; no prices, fees, internal notes or storage details (tests assert this). Requires `master_data.read` until customer authentication exists.

## Concurrency and integrity summary

Row locks (`SELECT … FOR UPDATE`) on the sample serialise transitions, quotation/payment/approval operations and part edits; approvals, artworks and patterns are locked where they are decided. Partial unique indexes guarantee: one live quotation version, one approved artwork version, one pending approval per target, one active terms version per code, one payment per proof. Triggers make history append-only (status history, terms acceptances, production specs) and freeze decided/sent/approved records. All covered by concurrent-request tests.

## Decisions affecting Phase 4 (Factory Operations) — resolved in Phase 4 / 4.1

- The factory manufactures the **physical sample** before the customer's final approval: a `SAMPLE_PRODUCTION` job is created from a `READY_FOR_PRODUCTION` (paid) sample and pins a **`PRE_PRODUCTION`** `SampleProductionSpec` frozen at that moment. The spec written at customer approval is the **`APPROVED_REFERENCE`** (`kind`) later bulk production uses. See `PHASE_4_FACTORY_OPERATIONS.md` §2.
- Job creation moves the sample to `IN_PRODUCTION`; job completion moves it to `AWAITING_APPROVAL`. Approval itself stays a customer/staff-recorded decision and is never automatic.
- `GET …/production-spec` returns the latest `APPROVED_REFERENCE` only (404 until approval); `GET …/production-specs` lists both kinds. `PRODUCTION_SPEC` approvals can only target an `APPROVED_REFERENCE`.
- Factory staff get **task-specific projections** of the pinned snapshot; production roles still have no sample permissions.
- The job source is generic (`SAMPLE_PRODUCTION` now; `BULK_ORDER`/`ORDER_BATCH` in Phase 5).

## Phase 5B note

Quotations and payments now target a sample **or** an order (`sample_id` / `order_id`, exactly one). Every sample behaviour above is unchanged; `start-production` / `finish-production` are deprecated and refused once the sample has any factory job.

## Known limitations

No authenticated customer actions yet (staff record decisions with evidence); no refunds/credit notes (cancelling after payment only records `verifiedPaid` in the audit log); no automatic quotation-expiry sweeper (expiry is evaluated when a decision is attempted); sample quantities/variants and pricing rules belong to later phases; local file storage is single-node.
