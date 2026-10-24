# Phase 7C — Customer Bulk Orders, Tracking and Reorder

The signed-in customer can create a bulk order from an approved sample, set quantities and the size / colour
breakdown, submit it, follow its quotation, payment, production and shipments in customer language, and reorder
a finished order. **There are no parallel customer-order tables**: everything is the staff `Order`, `OrderItem`,
`OrderVariant`, `Quotation`, `Payment`, `FactoryJob` and `Shipment` domain reached through customer-scoped entry
points (the same pattern as 7A/7B: shared services take an `ActorRef`, `{id, customer: true}` for a customer).

Swagger groups: **Customer Orders**, **Customer Order Commercial**, **Customer Order Tracking** (customer bearer
scheme). Customer token isolation (`@CustomerRoute()` / `CustomerAuthGuard`) is unchanged.

## 1. Ownership

The customer comes only from the session. Every route proves `order.customerId = session customer` (orders and
shipments through `order`, payments through `createdByCustomerId` + the order/sample, quotation versions through
`quotation.order`); a foreign or unknown id is a plain 404. Bodies cannot name an owner (`forbidNonWhitelisted`).

## 2. Creating an order

`POST /customer/samples/:sampleId/create-order` → a **DRAFT** order (`OrdersService.createFor`, shared with staff).

* The sample must belong to the customer (otherwise 404) and be `APPROVED`/`COMPLETED` with an `APPROVED_REFERENCE`;
  the order pins that reference (the database refuses a pre-production specification and the reference's hash is
  re-checked). Customer and brand must still be active and match.
* Customer-editable data only: `items` (one product line), `targetDeliveryDate` (not in the past), `customerNotes`,
  `preferredAddressId` (must be one of the customer's own active addresses, else 400). Not accepted (400):
  `customerId`, `status`, `priority`, `internalNotes`, `assignedSalesUserId`, custom sizes / colours.
* Staff fields are defaulted by the domain: priority NORMAL, sales owner = the sample's owner.
* Recorded with `created_by_customer_id` (`created_by_user_id` is null, a CHECK demands exactly one creator); the
  timeline entry and audit row carry `actor_customer_id`.

## 3. Quantities and variants

The order model is unchanged (`OrderItem` → `OrderVariant`). The portal exposes one product line:
`{quantity, variants:[{sizeOptionId?, fabricColorId?, quantity, notes?}], notes?}`.

* Positive whole numbers; variant lines must add up to the line total (400 on save and again at submit);
  at least a size or a colour per line (omit the colour to keep the approved one); no duplicate size/colour
  combination; sizes must exist and be active; colours must be catalogue colours **of the approved sample's fabric**
  (another fabric would change the material: it needs a new sample).
* Custom sizes / colours are not accepted from customers: they would silently change the manufacturing baseline.
  The frozen reference is never editable; changing the product needs a new sample.
* `PUT /customer/orders/:id/items` replaces the line (DRAFT only). `PATCH /customer/orders/:id` edits date, notes and
  preferred address (DRAFT only). No status can be patched.

## 4. Lifecycle: the customer hands over, staff confirm

`POST /customer/orders/:id/submit` runs the staff completeness check (`assertConfirmable`) and the normal `submit`
transition → `PENDING_CONFIRMATION` (event `ORDER_SUBMITTED`; the people with `orders.confirm` (sales included) are
notified). Confirmation (which freezes the order specification), release (`ready`) and the commercial gate remain
staff actions; there is no customer route for them, and the customer token is rejected by the admin routes.
After submit the customer cannot edit (409); later changes are staff revisions.

## 5. Customer status, next step and allowed actions

Derived (no new enum): `DRAFT, PENDING_CONFIRMATION, QUOTATION_PENDING, QUOTATION_READY, PAYMENT_REQUIRED,
PAYMENT_UNDER_REVIEW, READY_FOR_PRODUCTION, IN_PRODUCTION, PACKAGING, READY_TO_SHIP, PARTIALLY_SHIPPED, SHIPPED,
DELIVERED, COMPLETED, CANCELLED`. A hold is hidden (the interrupted status shows). Commercial statuses use real
facts: an open quotation, an accepted one, the cached `paymentState` and a payment waiting for review.
`PAID` on an accepted order shows `READY_FOR_PRODUCTION`; the backend gate remains the authority (`commercial.
readyForProduction`). `nextStep` is plain language. `allowedActions` (from real state):
`EDIT_ORDER, SUBMIT_ORDER, ACCEPT_QUOTATION, REJECT_QUOTATION, UPLOAD_PAYMENT_PROOF, REORDER`.

`GET /customer/orders` filters by any customer status (database conditions, so paging stays exact), search (order
number / brand / product), brand, sort (`newest, oldest, updated, orderNumber, targetDate`) and pages. The
dashboard views (active, in production, awaiting my action = `DRAFT,QUOTATION_READY,PAYMENT_REQUIRED`, shipped /
delivered) are status filters; no extra aggregate endpoint was needed.

`GET /customer/orders/:id` is a projection: reference summary, items with size / colour names, quantities
(total / shipped / delivered / remaining), commercial brief, progress %, notes, preferred address, dates. Never
exposed: internal notes, priority, sales owner, specification ids/hashes, holds, QC, blockers, rework, costs, audit.

## 6. Commercial

* `GET …/quotation` — only versions that were sent; shared projection with samples. `actionableVersionId` is the one
  open SENT, unexpired, not-invalidated version. `endedByChange` marks versions that an order change made obsolete.
* `POST /customer/order-quotation-versions/:id/accept|reject` — `QuotationsService.decideForOrderAsCustomer`, the
  staff `decideForOrder` generalised: same transaction and rules (live SENT only; a version priced before the last
  commercial change cannot be accepted), recorded in `quotation_versions.decided_by_customer_id` (decision note =
  the customer's reason), order timeline, audit (`actor_customer_id`), `QUOTATION_ACCEPTED` event.
* `GET …/commercial` — quotation state, payment summary, `readyForProduction` (the backend release gate),
  `nextAction` (`REVIEW_QUOTATION | PAY | NONE`), `allowedActions`. Amounts come from `OrderCommercialService.summary`
  (accepted quotation vs VERIFIED payments); one currency, never combined.
* `GET|POST …/payments` — `POST` is multipart with the proof file (`PAYMENT_PROOF`, magic bytes, size cap, private);
  `PaymentsService.createForOrder` generalised: accepted quotation required, amount cannot exceed the remaining
  balance, card-like references refused, at most five payments awaiting review. Same table and queue as staff payments
  (`created_by_customer_id`); only staff/finance verify (no customer route exists). Proof replacement and download use
  the 7B routes `POST /customer/payments/:id/proof` and `GET …/proof/download-url`, now valid for order payments.

### Commercial revision integrity (5B.1)

Customer edits happen only in DRAFT, where the existing classifier still applies: a commercially relevant item change
ends every live quotation version under the order lock. After confirmation, only staff revisions change an order and
the same rule applies. The customer view follows the backend: an ended accepted version is `SUPERSEDED` with
`endedByChange: true`, the order shows `QUOTATION_PENDING`, `commercial.requiresReview` is true with a notice, the
version can never be accepted (409), the acceptance is never carried forward, and verified payments keep counting
toward the next accepted quotation. When staff send the new quotation the customer sees `QUOTATION_READY` and "A new
quotation requires your review."

## 7. Production, packaging, ETA

`GET …/production` aggregates **all** non-cancelled jobs (one bulk job or several batch jobs; the customer never sees
batches) into seven steps — preparing materials, pattern & cutting, decoration, sewing, quality check, packaging,
ready for shipment — each `PENDING | ACTIVE | DONE`, plus `progressPercent` (units that passed the last stage, same
rule as public tracking), `packaging` (`NOT_STARTED | IN_PACKAGING | READY_FOR_SHIPMENT`) and `eta`. A step is done
only when every job's stages of that step are done. Blocked / failed stages simply show as active. Superseded
attempts and cancelled jobs are ignored. Not exposed: stage names, assignees, QC detail, blockers, rework, notes,
per-stage quantities.

`eta` comes from the Phase 6A `EtaService.order` (production estimate only), only while production is unfinished:
`HIGH` data quality → `ESTIMATED`, anything lower → `APPROXIMATE` with "an approximate date; it may move"; the
internal data-quality scale is never shown.

## 8. Shipments and delivery

* `GET …/shipments` — non-draft, non-cancelled shipments with customer states (`PREPARING`, `ON_THE_WAY`,
  `DELIVERED`, `DELIVERY_ATTEMPT_FAILED`, `RETURNED`), units, destination as "city, country", courier, tracking
  number/URL, dates; plus order totals `totalUnits, shippedUnits, deliveredUnits, remainingUnits, partiallyShipped`.
  Partial shipments are first class and the order is `DELIVERED` only when the backend says so.
* `GET /customer/shipments/:id` — adds the size / colour lines.
* Not exposed: failure / return / cancel reasons, delivery notes, recipient phone, street address, delivery staff and
  **delivery proof** (kept staff-only; conservative).
* The shipment destination stays an immutable snapshot taken by staff; the customer's `preferredAddressId` is a hint.
* Public tracking links are unchanged: only a token hash is stored, so the raw link cannot be shown again. The portal
  uses these authenticated endpoints instead and never pretends a link exists.

## 9. Reorder

`POST /customer/orders/:id/reorder {targetDeliveryDate?, customerNotes?, cloneItems?}` →
`OrdersService.reorder` generalised. Eligible: the customer's own, confirmed, **delivered or completed** order whose
approved reference still passes its integrity check and whose customer and brand are active; anything else 409/404.
It creates a NEW DRAFT order on the same approved reference and copies only the quantities and size / colour
breakdown (re-validated). It never copies quotations, payments, decisions, batches, jobs, shipments, tracking or
production state. The new order is editable and submittable like any draft; staff see `reorder_of_order_id`.

## 10. Activity

`GET …/activity` — a whitelist of order timeline types with customer titles (created, submitted, confirmed,
quotation ready / declined / accepted, payment proof submitted / verified / could not be verified, ready for
production, production started / complete, packaging, ready to ship, shipment dispatched / delivered, delivery attempt
failed, order delivered / completed / cancelled, a new quotation is needed). Titles are written for customers: no
staff text, reasons, holds, priorities, batches, jobs or tracking events reach them.

## 11. Notifications

Built on the 6B outbox; no parallel engine. New: `ORDER_SUBMITTED` (everyone holding `orders.confirm`, in-app/email) and customer
messages for **order ready for production** and **production complete** (English + Arabic). Already present and now
reached by customer flows: quotation sent, payment verified / rejected (customer message only), order confirmed,
ready for delivery, dispatched, delivered, milestones. Customers without an email/WhatsApp contact receive nothing.

## 12. Audit

Customer actions are audited with `actor_customer_id`: `order.created`, `order.updated`, `order.items_changed`,
`order.submitted`, `order.reordered`, quotation version accepted / rejected, `payment.created` and
`payment.proof_submitted_by_customer`.

## 13. Migration `20261023180000_customer_orders`

Additive: `orders.created_by_user_id` nullable + `created_by_customer_id`, `customer_notes`, `preferred_address_id`;
`order_activities.actor_customer_id`; `quotation_versions.decided_by_customer_id`. Guards: `orders_single_creator`,
`quotation_versions_single_decider`, `order_activities_single_actor`, and `quotation_versions_guard` extended so an
accepted version's customer decision is as write-once as the staff one. Existing rows are unaffected.

## 14. Tests

Unit: customer order status / actions / timeline projection, production aggregation (batches, cancelled jobs,
leak checks), ETA wording. e2e `test/customer-orders.e2e-spec.ts` (15): approved-reference and ownership rules;
mass-assignment and custom-option refusal; address and date validation; quantity integrity; submit and freeze;
list filters and detail leak checks; cross-customer isolation on every order route; quotation view, accept, reject,
expiry; payment proof and the verification boundary and release gate; commercial revision invalidation; draft edit
vs existing quotation; real bulk production with coarse steps; partial shipment, failed attempt, delivery; delivered
status and reorder without carried state; timeline and notifications. `domain-events` gained flows for the new
events.

## 15. Known limitations

* Customers cannot change an order after submitting it (staff revise); there is no customer cancellation.
* One product line per order in the portal (the domain allows more); no custom sizes / colours.
* Delivery proof and failure reasons are not shown to customers.
* Dashboard "awaiting my action" is the status set `DRAFT, QUOTATION_READY, PAYMENT_REQUIRED` (documented, not a
  separate endpoint).
* Customer messages depend on a customer email / WhatsApp contact and the configured providers.

## 16. Frontend 7C readiness

Ready: order list with status filters and search; order detail with status, next step and `allowedActions`; create
from approved sample, edit items / details, submit; quotation and payment screens (same components as 7B);
production step tracker with progress and ETA; shipments with partial-shipment summary; timeline; reorder.
