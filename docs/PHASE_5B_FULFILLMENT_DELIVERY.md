# Phase 5B — Packaging, Delivery and Customer Tracking

Completes the order fulfilment layer on top of Phase 5A: packaging specification and execution, shipments (including partial shipments), delivery staff workflow and proof, delivery-driven order states, order completion rules, customer-safe tracking, and the commercial (quotation / payment) integration for bulk orders. **Not included:** inventory ledger, purchasing, suppliers, notifications engine, advanced ETA, capacity planning, analytics, QR job cards, tech packs, smart pricing, 3D.

## 1. Order statuses

`READY_FOR_PACKAGING · PACKAGING · READY_FOR_DELIVERY · PARTIALLY_SHIPPED · OUT_FOR_DELIVERY · DELIVERED · COMPLETED` join the Phase 5A set. Nobody writes them directly:

* **Derived (system-driven)** by `OrderSyncService` through the state-machine action `fulfillment-sync`, from production, packaging and shipment facts (`orders/pure/order-fulfillment.ts`, unit-tested):

  | Facts | Status |
  |---|---|
  | production still running, a PACKAGING stage ready / in progress | `READY_FOR_PACKAGING` / `PACKAGING` |
  | all units produced, no packaging spec or not everything packed | `PRODUCTION_COMPLETED` |
  | all produced, packaging spec defined, packed ≥ produced | `READY_FOR_DELIVERY` |
  | some units dispatched or delivered, not all covered | `PARTIALLY_SHIPPED` |
  | every produced unit dispatched or delivered, some still on the road | `OUT_FOR_DELIVERY` |
  | every produced unit delivered | `DELIVERED` |

  Targets are checked against `DERIVED_TARGETS`; `COMPLETED` is never derived. The sync runs under the order lock after every job change, packaging-spec change and shipment transition, so a returned shipment moves the order back (e.g. `PARTIALLY_SHIPPED → READY_FOR_DELIVERY`).
* **Explicit**: `complete` (`DELIVERED → COMPLETED`) and `force-complete` (reason, from production-complete onwards). Hold is possible up to `PARTIALLY_SHIPPED`; cancel only before anything left the building (`READY_FOR_PACKAGING … READY_FOR_DELIVERY`), and it cancels unsent shipments.

`Order.completedAt` still means *production finished*; `deliveredAt` is when every deliverable unit was delivered and `closedAt` when the order was closed.

## 2. Packaging

* `OrderPackagingSpec` (one per order) — folding instructions, polybag / labels / hang tags / stickers flags and notes, `unitsPerCarton`, carton notes, special instructions — with `OrderPackagingComponent` rows: a master-data `ComponentOption` **or** a free-text `customName` (CHECK exactly one), `quantityPerUnit`, notes. `PUT /admin/orders/:id/packaging` (`packaging.manage`), `GET` (`orders.read`).
* The spec cannot change while packers are working from it (stage IN_PROGRESS) nor after packaging when one existed; one that was never defined can still be added after the fact so the order can ship.
* **Execution**: `POST /staff/job-stages/:id/packaging-reports` (`production_quantity.report`, assigned staff, packaging stage of a bulk job, spec must exist): `packedQuantity`, `damagedQuantity`, `cartonCount`, optional variant, notes. A packaging report is a stage production report (packed = produced, damaged = rejected) **plus** a `PackagingReport` row (append-only, trigger), so over-report protection, row locks, rejections feeding later stages and the stage-completion rule are the Phase 5A ones. Packers see the packaging instructions in their stage view (no prices).
* **Packaging gate / reconciliation** (`GET …/packaging`): `completedQuantity`, `packedQuantity`, `damagedQuantity`, `cartonCount`, `packagingComplete` (packed ≥ produced and > 0) and `shippableQuantity`, all computed by the server.

## 3. Shipments

`Shipment` (`SHP-000001`) with `ShipmentLine` (`orderVariantId`, quantity). Partial shipments: any number of shipments per order.

* **Create** (`POST /admin/orders/:id/shipments`, `shipments.manage`): the order must be partially or fully produced and not on hold/finished; the packaging spec must exist; requested units must be produced **and** packed and not committed to another shipment — in total (`min(completed, packed) − committed`) and per variant (attributed completions when production reports name variants, ordered − scrapped otherwise). Recipient name/phone validated; delivery person (if assigned) must be an active staff member who can dispatch.
* **Destination snapshot**: copied from one of the order customer's addresses (or a one-off address / pickup) into `addressSnapshot`; the column, the order and the number are immutable (trigger), so later edits of `CustomerAddress` never change a shipment. The API has no way to change the destination.
* **Over-shipping is impossible, including under concurrency**: the service validates under the order lock and a trigger on `shipment_lines` locks the variant row, re-sums active lines and refuses the loser. Units on `CANCELLED` and `RETURNED` shipments are available again. Lines are editable only while the shipment is `DRAFT` (trigger).
* **State machine** (`orders/pure/shipment-state-machine.ts`, repeated by a trigger):

  ```
  DRAFT ─ready→ READY ─dispatch→ DISPATCHED ─in-transit→ IN_TRANSIT ─deliver→ DELIVERED
                                   └────────── fail → FAILED ─dispatch (retry)→ DISPATCHED
                  return (DISPATCHED | IN_TRANSIT | FAILED) → RETURNED        cancel (DRAFT | READY) → CANCELLED
  ```
  `ready` re-validates quantities; `dispatch` needs a delivery person (own delivery) or a courier name; `fail` / `return` / `cancel` need reasons; timestamps are set once (the first dispatch time survives a retry); DELIVERED / RETURNED / CANCELLED are final. Held or cancelled orders cannot dispatch or deliver.
* `PATCH /admin/shipments/:id`: recipient (before dispatch), courier/tracking/notes/assignee, lines (DRAFT only). Admin routes: ready, dispatch, in-transit, deliver, fail, return, cancel, proof upload and `proof-url`.

## 4. Delivery staff

`DELIVERY` is now active (`deliveries.read_assigned`, `shipments.dispatch`, `shipments.complete`). `/staff/deliveries` lists and shows only deliveries **assigned to the caller and not DRAFT**: shipment number, status, recipient, phone, address, package quantities (variant labels), delivery notes, courier/tracking, dates. Never quotation, payments, production data, customer identity beyond the recipient, internal notes or audit data; other people's deliveries answer 404. Actions: dispatch, in-transit, delivered, failed (reason), returned (reason), proof upload.

**Delivery proof** is a private `Asset` of type `DELIVERY_PROOF`: uploaded by the assignee while the shipment is on its way (or attached by id at delivery), exposed only as a short-lived signed URL (admins with `shipments.read`, the assignee), never public, never archivable, never reusable on another shipment, frozen once the shipment is final.

## 5. Completion

`DELIVERED` means every deliverable (produced, not scrapped) unit was delivered. `POST /admin/orders/:id/complete` (`orders.manage`) closes it: `DELIVERED` only, no open shipment, and — when a quotation was accepted — `paymentState = PAID`. `POST …/force-complete` (`orders.override`, reason mandatory, audited as `order.force_completed`) skips the normal path from production-complete onwards. Production finishing or a partial shipment never completes an order (tests: 500 ordered, 300 delivered, 200 pending → not delivered).

## 6. Public tracking

* **Token**: `randomBytes(32)` base64url (43 chars). Only its SHA-256 is stored (`OrderTrackingToken.tokenHash`, unique); the raw token is returned once at creation. One active token per order (partial unique index) so concurrent issue/regenerate cannot leave two live links; revoked tokens stay revoked; hash, order and expiry are immutable (trigger). `POST /admin/orders/:id/tracking-token` (409 if one exists), `…/regenerate` (revokes the old one in the same transaction), `DELETE` (revoke), `GET …/tracking` (status only). Permission `public_tracking.manage`. Optional `expiresInDays`.
* **Public view** `GET /api/v1/track/orders/:token` (`@Public`, rate-limited per IP by `TRACKING_RATE_LIMIT_PER_MINUTE`, default 30): `orderNumber`, coarse `status` (ORDER_RECEIVED … COMPLETED, ON_HOLD, CANCELLED), `currentStage` (department label, only while producing; QC shows as "Quality check"), `progressPercent`, quantities, `targetDeliveryDate`, shipments (number, customer status PREPARING / ON_THE_WAY / DELIVERED / DELIVERY_ATTEMPT_FAILED / RETURNED, quantity, courier, tracking URL, dispatched/delivered timestamps; drafts and cancelled shipments hidden) and `updatedAt`. Tests assert the exact key set and the absence of prices, payments, notes, staff, QC, blockers, jobs, phone / email / address and audit data.
* **Privacy**: unknown, malformed, revoked and expired tokens all return the same generic `404 {message: "Tracking link not found"}`; an order number or id is never a credential; the error body masks the token in `path`; request logs mask `/track/orders/<token>`; the token and its hash never reach `AuditLog` or `OrderActivity`.

## 7. Commercial integration

Quotations and payments are **generalised, not duplicated**: `quotations` and `payments` target a sample **or** an order (`sample_id` / `order_id`, CHECK exactly one; one live quotation per order by partial unique index). Sample behaviour, endpoints and tests are unchanged.

* **Order quotations** reuse the quotation tables, versions, Decimal arithmetic (`computeTotals`), explicit currency and immutability rules: `GET/POST /admin/orders/:id/quotations`, version create / edit / send via the existing `/admin/quotations/:id/versions` and `/admin/quotation-versions/:id[/send]` endpoints. They are negotiable until production is released. The customer's decision is recorded by staff on their behalf, with evidence: `POST /admin/order-quotation-versions/:id/{accept,reject}` (`orders.commercial.manage`, `sourceNote` required → `decisionNote` / `decidedByUserId`). Accepted versions are final; superseded ones are preserved. Approvals stay sample-only; the sample accept endpoint refuses order versions with 409.
* **Order payments**: `GET/POST /admin/orders/:id/payments` (`payments.read|manage` + `orders.commercial.read`); verify / reject / cancel / review reuse `/admin/payments/:id/*` (`payments.verify`, a different person than the recorder). **Overpayment policy:** a payment can never exceed the remaining balance of the accepted quotation, and verifying cannot push the verified total over it (checked under the order lock).
* **Payment state** `UNPAID / PARTIALLY_PAID / PAID` is derived from the accepted quotation total versus VERIFIED payments and cached in `Order.paymentState` (same rule as `Sample.paymentState`). `GET /admin/orders/:id/commercial` (`orders.commercial.read`) returns quoted / accepted totals, verified, pending, remaining, counts and the release gate. The order detail includes this block only for callers holding `orders.commercial.read`; factory and delivery roles cannot call any order endpoint that carries money.
* **Production release gate** (`mark-ready`, i.e. `READY_FOR_PRODUCTION`): configured, never hard-coded — `ORDER_REQUIRE_ACCEPTED_QUOTATION` (default `true`) and `ORDER_REQUIRED_PAID_PERCENT` (default `100`, i.e. full payment is the default business rule; set 30 for a 30% deposit, 0 for none). An accepted quotation that exists is always enforced. The order must also be confirmed with a valid approved reference.

### 7.1 Quotation validity vs order revisions *(Phase 5B.1)*

**Rule: an accepted quotation priced for revision N never authorises revision N+1 if commercial data changed.**

*Classification* (one place: `orders/pure/order-revision-impact.ts`, stored on `OrderRevision.commercialImpact/commercialChanges`):

| Commercial (re-approval required) | Not commercial (quotation stays valid) |
|---|---|
| approved reference, item added/removed/renamed, item quantity, total quantity | internal notes, item/variant notes, target delivery date, priority |
| size/colour breakdown: size or colour added/removed, any variant quantity | hex / pantone / internal code of a colour that stays the same colour, row order |

Packaging is a separate unpriced spec and is not part of a revision, so it never invalidates a quotation.

*Mechanism.* Every order quotation version is stamped with `orderRevision` (immutable). A commercial revision (`POST /admin/orders/:id/revise`, or a DRAFT `PUT …/items` once quoted) runs under the order lock and ends **every live version** (DRAFT / SENT / ACCEPTED): status `SUPERSEDED`, plus write-once `invalidatedAt`, `invalidatedByRevision`, `invalidationReason`. `Order.commercialRevision` records the revision that last changed commercial terms. Terms, `acceptedAt`, `decisionNote` and the amount are never touched (DB trigger: an ACCEPTED version can only end through a recorded invalidation). The superseded quotation can no longer be decided; sales add a new version (`POST /admin/quotations/:id/versions`) or a new quotation and record the customer's decision again.

*Gate.* `acceptedVersion` only returns a version that is still ACCEPTED, so the gate and payment checks always use the quotation for the current terms. If an accepted quotation was ended and no new one is accepted, the gate stays closed **even when `ORDER_REQUIRE_ACCEPTED_QUOTATION=false`** (`reapprovalRequired` in the commercial summary). An order already `READY_FOR_PRODUCTION` is pulled back to `CONFIRMED` (system action `commercial-reapproval`) when its gate no longer holds.

*Payments.* Verified payments are never invalidated or duplicated. For orders the verified total is summed across all versions, so money paid against the old quotation counts toward the new one (old 50 000 paid, new 70 000 ⇒ remaining 20 000). A SUBMITTED payment recorded against a replaced version can still be verified (capped by the quotation in force, or by its own when none). If the new quotation is smaller than what is verified, `remaining` is 0, `overpaid` shows the excess, state is PAID, and no further payment is accepted; nothing is refunded automatically.

*Concurrency.* Revision, quotation decision, payment verification and mark-ready all take the order row lock first, so they serialise: a decision racing a revision either lands before (and is invalidated) or after (and is refused 409); mark-ready racing a revision either releases and is then pulled back, or is refused.

*Audit/activity.* `order.commercial_reapproval_required`, `quotation_version.invalidated`, `ORDER_REVISED` (with `commercialImpact`), order activity `COMMERCIAL_REAPPROVAL_REQUIRED`; the new acceptance is audited as before.

## 8. Permissions (63 total; 10 new)

`packaging.manage`, `shipments.read`, `shipments.manage`, `shipments.dispatch`, `shipments.complete`, `deliveries.read_assigned`, `public_tracking.manage`, `orders.commercial.read`, `orders.commercial.manage`, `orders.override`. Grant batch `phase5b-fulfillment`: ADMIN all; SALES packaging, `shipments.read`, tracking, commercial read/manage; FINANCE `orders.commercial.read`; DELIVERY `deliveries.read_assigned`, `shipments.dispatch`, `shipments.complete`; other factory roles nothing new.

## 9. API summary

| Area | Endpoints |
|---|---|
| Packaging | `GET/PUT /admin/orders/:id/packaging`, `POST /staff/job-stages/:id/packaging-reports` |
| Shipments | `GET/POST /admin/orders/:id/shipments`, `GET /admin/shipments`, `GET/PATCH /admin/shipments/:id`, `POST …/{ready,dispatch,in-transit,deliver,fail,return,cancel,proof}`, `GET …/proof-url` |
| Delivery staff | `GET /staff/deliveries[/:id]`, `POST …/{dispatch,in-transit,delivered,failed,returned,proof}`, `GET …/proof-url` |
| Completion | `POST /admin/orders/:id/{complete,force-complete}` |
| Tracking | `GET/POST/DELETE /admin/orders/:id/tracking[-token]`, `POST …/tracking-token/regenerate`, public `GET /track/orders/:token` |
| Commercial | `GET /admin/orders/:id/commercial`, `GET/POST /admin/orders/:id/{quotations,payments}`, `POST /admin/order-quotation-versions/:id/{accept,reject}` |
| Orders list | new filters `readyForDelivery`, `delivered`, `shipmentStatus`, `paymentState`, `packagingComplete` |

Swagger tags: Order Packaging, Shipments, Staff Deliveries, Order Tracking, Public Tracking, Order Commercial.

## 10. Audit and timelines

Audited: packaging spec changes, shipment created / updated (incl. assignee and line changes) / ready / dispatched / in-transit / delivered / failed / returned / cancelled, proof attachment, tracking token generated / regenerated / revoked (token ids only), order completed / force-completed, order quotation create / version / accept / reject, payment create / verify / reject / cancel. `OrderActivity` gained `PACKAGING_STARTED`, `PACKAGING_COMPLETED`, `SHIPMENT_CREATED/READY/DISPATCHED/FAILED/RETURNED/DELIVERED`, `ORDER_DELIVERED`, `ORDER_COMPLETED`, `QUOTATION_SENT/ACCEPTED`, `PAYMENT_VERIFIED`, `TRACKING_UPDATED`; `PRODUCTION_COMPLETED` is logged once, when every unit is produced, even when packaging facts carry the order straight to `READY_FOR_DELIVERY`.

## 11. Concurrency

Order lock (`SELECT … FOR UPDATE`, the root lock) around shipment creation / transitions, payments, quotations, tracking tokens and completion; row lock on the variant inside the `shipment_lines` trigger; one-active-token and one-live-quotation partial unique indexes; the shipment transition whitelist in a trigger. Covered by concurrent-request tests: over-shipping, double dispatch, double delivery, double completion, tracking issue / regenerate, payment verification.

## 12. Legacy sample endpoints

`start-production` / `finish-production` are marked **deprecated** in Swagger and are refused with 409 as soon as the sample has *any* factory job (created, running, completed or cancelled): the factory job is the official production system. They remain only for job-less sample making in old flows/tests. Planned removal: after Phase 6, once no deployment relies on job-less sample production.

## 13. Known limitations

* A smaller re-quote than what was already verified leaves an overpayment (reported as `overpaid`); refunds are out of scope.
* No customer-authenticated actions: quotation decisions are staff-recorded with evidence.
* Tracking is a bearer link; there is no notification delivery yet (the link is handed over by staff).
* `COMPLETED` is explicit; the order stays `DELIVERED` until someone closes it.
* Packaging is reconciled by quantity only (no carton-level inventory); cartons are counted, not tracked.
* A failed shipment keeps its units committed until it is dispatched again or returned.
* Shipments are per order; there is no consolidation across orders.

## 14. Phase 6 compatibility

All events keep accurate timestamps: stage ready / start / complete and delay, rework, packaging reports, `readyAt` / `dispatchedAt` / `inTransitAt` / `deliveredAt` / `failedAt` / `returnedAt` on shipments, order `confirmedAt` / `productionStartDate` / `completedAt` / `deliveredAt` / `closedAt`, `OrderActivity`, `JobActivity` and `AuditLog`. They are enough for dashboards, KPIs, SLA / delay measurement, workload and (later) ETA and capacity, notifications on shipment / order events, tech packs and QR job cards (jobs, stages and orders have stable references).
