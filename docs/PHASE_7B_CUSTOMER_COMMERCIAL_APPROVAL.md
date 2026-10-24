# Phase 7B — Customer Commercial and Sample Approval

The signed-in customer can now read their quotation, accept or reject it, pay (submit proof), follow the
physical sample in simple steps, see the files staff chose to share, and approve the finished sample or send it
back with changes. There is **no second commercial domain**: every action runs the existing staff services
(`QuotationsService`, `ApprovalsService`, `PaymentsService`, `CommercialService`,
`SampleProductionSpecService`, the sample state machine) with a customer actor.

Swagger groups: **Customer Commercial** and **Customer Approvals** (customer bearer scheme, same guard as 7A).
Customer token isolation is unchanged: `@CustomerRoute()` / `CustomerAuthGuard` are untouched.

## 1. Ownership

Customer identity comes only from the session. Every route proves ownership through the sample
(`sample.customerId = session customer`, not archived); a foreign or unknown id is a plain 404:

* quotation versions → via `quotation.sample`; payments → via `sample` **and** `createdByCustomerId`;
  files → sample + attachment + visibility; approvals → via the sample.
* Nothing in a body or query is trusted for ownership (`forbidNonWhitelisted` still applies).

## 2. Quotation

* `GET /customer/samples/:id/quotation` — only versions that were **sent** (a draft or never-sent version does not
  exist for the customer). Per version: status (`SENT/ACCEPTED/REJECTED/EXPIRED/SUPERSEDED`), `isCurrent`,
  `actionable`, currency, line items (`type, description, quantity, unitPrice, amount`), subtotal, discount,
  tax %, tax, total, dates, and `notes`.
* `notes` is **`QuotationVersion.customerNotes`**, a new field staff fill in on purpose (staff DTOs accept
  `customerNotes`); the existing internal `notes` is never exposed. It is frozen after sending like the prices (guard
  trigger extended). Line-item `metadata`, creator ids, invalidation/order-revision fields are never exposed.
* `actionableVersionId`: the one SENT, unexpired, not-invalidated version while the sample is `QUOTED`.
  `requiresReview` + `notice` ("A new quotation requires your review.") when the customer already received an
  earlier version and is now asked to decide on a newer one. Old accepted/rejected versions stay visible as history;
  a decision is never carried forward to a new version.
* `POST /customer/quotation-versions/:id/accept` and `/reject {reason?}` (throttled): the version id is the target,
  so the customer decides exactly what they saw. Rules are the staff ones, enforced in the same transaction as
  staff decisions: only a SENT version of the live offer; superseded, draft, expired, already decided → 409.
  Accept → sample `AWAITING_PAYMENT` (a zero-value quotation goes straight to ready); reject → `UNDER_REVIEW`
  (staff can send a new version). Both answer with the refreshed customer sample.
* Recorded as an `Approval` (`type QUOTATION`, **`mode CUSTOMER_AUTHENTICATED`**, `respondedByCustomerId`,
  `requestedByCustomerId`; no source note) — the mode the schema had reserved for the portal. Quotation-version
  audit, status history (`source CUSTOMER`) and the `QUOTATION_ACCEPTED` outbox event come from the same code as
  staff-recorded decisions.

## 3. Payments

* `GET /customer/samples/:id/payments` — `summary` (`NOT_REQUIRED_YET | PAYMENT_REQUIRED | PAYMENT_UNDER_REVIEW | PAID`,
  required / verified / pending / remaining amounts, one currency — the quotation's) and the sample's payments
  with a customer state `PENDING_VERIFICATION | VERIFIED | REJECTED | CANCELLED`. The numbers are
  `CommercialService.summary()` (accepted quotation vs VERIFIED payments) — nothing is recalculated; amounts of
  different currencies are never combined.
* `POST /customer/samples/:id/payments` (multipart `file` + `amount`, `method`, `transactionReference?`,
  `receivedAt?`; throttled): the existing model has no pre-created "required payment" rows, a payment *is* a
  submission, so this is the minimum safe endpoint. It uploads the proof as a private `PAYMENT_PROOF` asset
  (magic bytes, size cap) and calls the shared `PaymentsService.createFor` — same rules as staff (accepted quotation
  required, amount cannot exceed the remaining balance, card-number-looking references refused), plus at most five
  payments awaiting review per customer. The row is an ordinary `SUBMITTED` payment in the same table and queue
  (`created_by_customer_id` set; `PAYMENT_SUBMITTED` event notifies verifiers).
* `POST /customer/payments/:id/proof` replaces the proof of the customer's **own** payment while it is still
  `SUBMITTED`; `GET /customer/payments/:id/proof/download-url` returns a signed link for the proof they uploaded.
* **Verification stays staff/finance only.** There is no customer route that verifies, reviews, rejects or cancels
  (verified by tests), and the person who recorded a payment still cannot verify it. The commercial gate is
  untouched: the verification that covers the quotation moves the sample to `READY_FOR_PRODUCTION`.
* A rejected payment shows `message` = **`Payment.customerMessage`**, a new optional field staff set when rejecting
  (`customerMessage` on the reject body). The internal `rejectionReason` is never shown.

## 4. Staff-provided files

`AssetAttachment.customerVisible` (default **false**, CHECK: sample attachments only). Staff control it:

* `POST /admin/samples/:id/assets/share {assetId}` — attach a sample-attachable asset (REFERENCE, MOCKUP,
  SIZE_CHART, ARTWORK, OTHER) and show it to the customer **in any sample status** (the existing attach route is
  DRAFT-only; mockups and final photos are shared after submission).
* `PATCH /admin/samples/:id/assets/:attachmentId/customer-visibility {customerVisible}` — show/hide (audited).
* Customer file list = their own uploads + files with `customerVisible = true`, each tagged
  `source: YOU | BENUE_PRINT`. Staff-written asset descriptions are not shown. Downloads use the same signed-URL
  layer after the sample + attachment + visibility proof; storage keys are never returned. The customer can remove
  only their own files, only while the request is a draft.
* Not done: an asset-backed quotation document (no such relation exists yet).

## 5. Production projection

`GET /customer/samples/:id/production` → `{phase: NOT_STARTED|IN_PROGRESS|COMPLETE, steps[6]}` with
`PREPARING_MATERIALS, PATTERN_AND_CUTTING, DECORATION, SEWING, QUALITY_CHECK, SAMPLE_READY`, each
`PENDING|ACTIVE|DONE`, derived from the live (else newest finished) `SAMPLE_PRODUCTION` job; superseded attempts
are ignored; a blocked or failed stage simply shows as `ACTIVE`. Only codes, labels and states leave the server — no
stage names, assignees, QC checklists, blockers, rework, notes or quantities.

## 6. Approval and revision

* `POST /customer/samples/:id/approve {note?}` — reuses the existing `SAMPLE` approval: only while
  `AWAITING_APPROVAL` (reached when the production job completes, or by the staff stand-in), and the existing freeze
  checks apply (accepted quotation, approved pattern, required artwork). It writes the frozen
  `APPROVED_REFERENCE` specification (`createdByUserId` null, snapshot records `approvedByCustomerId` and
  `mode CUSTOMER_AUTHENTICATED`), links the physical-sample job and moves the sample to `APPROVED`. Exactly once;
  a second call, or a call before the sample exists, is a 409.
* `POST /customer/samples/:id/request-changes {reason, categories?}` — `reason` required (3–2000), optional
  categories `FIT, FABRIC, COLOUR, ARTWORK, DECORATION, CONSTRUCTION, OTHER` (stored as a `[FIT, …]` prefix of the
  response note). It is the existing **rejected SAMPLE approval**: the sample returns to `IN_PRODUCTION` with the
  reason as the rework reason. The previous production job (stages, QC, rework, files), pre-production spec,
  approvals, status history and artwork versions are untouched; staff create a new job as before. Same state rule
  as approve.

## 7. Customer status, next step and allowed actions

New customer statuses (derived, no new DB enum): `PAYMENT_UNDER_REVIEW` (AWAITING_PAYMENT with a payment waiting
for staff) and `REVISION_REQUESTED` (IN_PRODUCTION after the customer sent the sample back, until staff start a
new job). Next steps: "Review your quotation." · "Payment is required." · "Your payment proof is being reviewed." ·
"Your sample is being produced." · "Review your completed sample." · "Our team will review your requested
changes." · "Your sample is approved and can be used for bulk production."

`allowedActions` (on the sample detail and the commercial summary) is computed from real backend state:
`EDIT_REQUEST, UPLOAD_FILE, ACCEPT_TERMS, SUBMIT_REQUEST, ACCEPT_QUOTATION, REJECT_QUOTATION,
UPLOAD_PAYMENT_PROOF, APPROVE_SAMPLE, REQUEST_CHANGES` — the app does not need its own state machine.
`GET /customer/samples/:id/commercial` returns quotation state, payment summary, `nextAction`
(`REVIEW_QUOTATION | PAY | REVIEW_SAMPLE | NONE`) and the same actions. The list filter accepts the new statuses.

`GET …/activity` now also carries the commercial and production steps (Quotation ready / accepted / declined,
Payment proof submitted / verified / could not be verified, Payment complete, Sample production started, Sample
ready, Sample approved, Changes requested) with `kind: STATUS | PAYMENT` (payment steps have a null status).
Internal reasons never appear: only the customer's own note and the staff message addressed to them.
`GET …/messages` is unchanged (staff notes marked customer-visible, read-only).

## 8. Notifications

Built on the Phase 6B outbox/rules/templates (no parallel engine; providers stay the existing `log`/`disabled`
ports). Already present and now triggered by customer actions: quotation sent, quotation accepted (staff), payment
submitted (verifiers), payment verified (customer), sample ready for approval (customer). New events and seeded
rules/templates (English + Arabic): `PAYMENT_REJECTED` → customer (`PAYMENT_REJECTED`, text = the customer message
only), `SAMPLE_APPROVED` → customer (`SAMPLE_APPROVED_CUSTOMER`), `SAMPLE_CHANGES_REQUESTED` → customer
acknowledgement + sales owner + factory managers. All are in the customer-safe event list. Delivery to customers
needs a customer email/WhatsApp contact; a customer without one gets nothing (documented limitation).

## 9. Migration `20261023120000_customer_commercial_approval`

Additive: `approvals.requested_by_user_id` nullable + `requested_by_customer_id`; FKs for
`approvals.responded_by_customer_id`; `payments.created_by_customer_id`, `payments.customer_message`;
`quotation_versions.customer_notes`; `asset_attachments.customer_visible`. Hand-written guards:
`approvals_single_requester`, `approvals_customer_mode_matches_responder`, `payments_single_creator`,
`asset_attachments_customer_visible_sample_only`, and `quotation_versions_guard` extended so `customer_notes` is
immutable after sending. Existing rows are unaffected.

## 10. Tests

* Unit: payment state, allowed actions, production projection, extended status/activity projection.
* e2e `test/customer-commercial.e2e-spec.ts` (15): quotation ownership/projection/leaks; accept (approval mode,
  audit, history actor, staff view); reject + new offer review notice; superseded/draft/expired refused; payment
  submission, proof rules, staff queue, verification boundary, balance and gate; customer-message-only rejection +
  notification; proof replace/ownership; staff-recorded payments not modifiable; staff-shared files (visibility,
  signed download, hide, permissions, IDOR); real production job projection → approval with frozen spec, exactly
  once; request-changes → revision preserved → re-approved; wrong-state/IDOR on approve; customer-notes round trip
  and immutability.

## 11. Known limitations

* Customer delivery depends on a customer email/WhatsApp contact and the configured providers (log/disabled by
  default); invitation/reset tokens still use the Phase 7A delivery port.
* No staff notification when a customer rejects a quotation (the sample simply returns to the review queue).
* Quotation PDFs/documents are not asset-backed, so none can be shared yet.
* Multiple payments are capped at five awaiting review per customer per sample.
* `customerNotes` must be written by staff; quotations created before this phase show no customer note.
* Customer replies/messages remain out of scope.

## 12. Frontend 7B readiness

Ready: quotation list/detail with decision buttons driven by `allowedActions`; payment screen (summary + list +
multipart submit + proof replace); commercial summary banner; production step tracker; sample approval screens
(approve / request changes with categories); shared files with `source`; extended status labels and timeline.

## 13. Backend 7C prerequisites

Customer bulk orders need: an order-quantity request model (matrix by size/colour from the approved
reference), customer-visible order quotation/commercial views (the same patterns on `Order`), order payments with
proof (reuse `PaymentsService.createForOrder` with a customer actor), order tracking/milestones (the
`ORDER_MILESTONE` events exist), shipment tracking projection, and reorder from an approved sample.
