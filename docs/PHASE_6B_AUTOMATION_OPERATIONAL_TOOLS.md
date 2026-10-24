# Phase 6B — Automation and operational tools

Working calendar, transactional outbox, notifications (in-app, email, WhatsApp), scheduled alerts with escalation,
QR job cards and tech packs. Phase 6A's read-models are unchanged in meaning: they now optionally count working time.

## 1. Time zone

`BUSINESS_TIMEZONE` is configuration, never code. Example / development value: **`Africa/Cairo`** (`.env.example`, compose
default); the code default is `UTC`; tests use `Asia/Kolkata` to make zone bugs visible. Stored timestamps are UTC. Quiet hours,
"today", daily buckets and the seeded calendar zone follow this setting; a calendar row carries its own IANA zone.

## 2. Working calendar

`WorkingCalendar { code, name, timezone, isDefault, active }` + `WorkingCalendarDay { weekday 0=Sunday … 6, isWorkingDay,
startMinute, endMinute }` (exposed as `HH:MM`, `24:00` = until midnight) + `WorkingCalendarException { date, isWorkingDay,
startMinute?, endMinute?, reason? }` (holiday, exceptional working day, shortened day; wins over the weekly schedule).
Exactly one default (partial unique index); the default must be active; calendars are never deleted. No employee shifts.

Seed: `FACTORY_DEFAULT`, open 24/7 in `BUSINESS_TIMEZONE` — identical to calendar time, so nothing changes until the factory
enters its real hours (`PUT /admin/working-calendars/:id/weekly`, exceptions, `make-default`).

### Business-time functions (`management/pure/working-time.ts`, pure, DST-safe, zone-explicit)
`isWorkingTime`, `nextWorkingTime`, `addWorkingMinutes`, `workingMinutesBetween` (half-open windows `[start, end)`). Adding to a
moment outside working time starts counting at the next working moment; adding 0 returns the input; a calendar with no working
day throws `NoWorkingTimeError` (800-day horizon). `BusinessClock` adapts either calendar time or a schedule.

### Where working time is used
| Consumer | Behaviour |
|---|---|
| SLA | rule thresholds (`readyAt` + threshold, `createdAt` + threshold …) are added in working minutes; remaining, elapsed and breach minutes are working minutes; explicit dates (`dueAt`, targets, `scheduledAt`) are unchanged |
| ETA | stage start = next working moment; durations, queues and elapsed time are working minutes; basis says "Working time" |
| Escalation | `afterMinutes` = working minutes since the alert was first detected |
| Delay engine | unchanged: an overdue stage is overdue by the clock (a stored due date is a fact, not a duration) |
Historical timestamps are never rewritten. The default schedule is cached 30 s and dropped on every write (single node).

API (`working_calendar.read|manage`): `GET/POST /admin/working-calendars`, `GET/PUT :id`, `PUT :id/weekly`,
`PUT :id/exceptions`, `DELETE :id/exceptions/:date`, `POST :id/make-default`, `GET :id/preview` (≤ 62 days). All changes audited.

## 3. Architecture: events → outbox → notifications → delivery

```
business transaction ── writes change + OutboxEvent (same commit) ──►  outbox_events
scheduler / run-now ── OutboxProcessor (SKIP LOCKED, lease) ─► planner ─► notifications (dedup keys)
scheduler / run-now ── Dispatcher (SKIP LOCKED, retries)   ─► EmailProvider / WhatsAppProvider ports
```
Nothing is sent inside a business transaction, so an email/WhatsApp failure can never roll back an order update, a stage
completion, a payment verification or a dispatch (tested: both channels down, the API call still succeeds).

### Outbox
`OutboxEvent { eventType, aggregateType, aggregateId, payload, status PENDING|PROCESSING|PROCESSED|FAILED, attempts,
nextAttemptAt, lockedAt, processedAt, lastError, deduplicationKey (unique) }`. `OutboxService.emit(tx, …)` is called inside the
transaction by `JobEngineService.activity` (stage assigned/blocked, QC failed, rework, job completed, milestones), `OrderActivityService.log`
(order confirmed/ready/production complete/ready for delivery/dispatched/failed/delivered, commercial re-approval, milestones),
`SampleTransitionsService` (submitted / ready for approval / approved), `QuotationsService`, `PaymentsService`, and the engine (job started).
Payloads carry ids and safe facts only; `assertNoSecrets` rejects keys/values that look like passwords, tokens, bearer credentials or signed URLs.
The planner reads names and dates fresh when it runs; facts that change meanwhile (a failed delivery's reason) travel in the payload.

Supported events (`notifications/events.ts`): SAMPLE_SUBMITTED, SAMPLE_READY_FOR_APPROVAL, SAMPLE_APPROVED, QUOTATION_SENT, QUOTATION_ACCEPTED,
PAYMENT_SUBMITTED, PAYMENT_VERIFIED, ORDER_CONFIRMED, COMMERCIAL_REAPPROVAL_REQUIRED, ORDER_READY_FOR_PRODUCTION, ORDER_PRODUCTION_COMPLETED,
ORDER_READY_FOR_DELIVERY, ORDER_DELIVERED, ORDER_MILESTONE, JOB_STARTED, STAGE_ASSIGNED, STAGE_BLOCKED, QC_FAILED, REWORK_CREATED, JOB_COMPLETED,
SHIPMENT_DISPATCHED, SHIPMENT_FAILED, and the alert events ALERT_OPENED / ALERT_SEVERITY_INCREASED / ALERT_ESCALATED. `STAGE_DELAYED` is the notification type of a
delayed-stage alert.

### Idempotency
* An event is claimed with `FOR UPDATE SKIP LOCKED` and stamped PROCESSING; an expired lease (`OUTBOX_LEASE_SECONDS`, 300) lets another worker reclaim it.
* A notification's `deduplicationKey` is `event:rule:recipient:channel` (unique): processing an event twice creates nothing new.
* The notification id is the provider **idempotency key**: a retry after "provider accepted, row not updated" does not send twice.
* Alert events use deterministic keys (`ALERT_OPENED:<alert>`, `ALERT_SEV:<alert>:<level>`, `ALERT_ESC:<alert>:<level>`); milestones `MILESTONE:<order>:<milestone>`; `JOB_STARTED:<job>`.

### Retry policy
Bounded exponential backoff `base × 2^(attempt−1)` capped (`NOTIFICATION_RETRY_BASE_SECONDS` 60, `…_MAX_SECONDS` 3600,
`NOTIFICATION_MAX_ATTEMPTS` 6, `OUTBOX_MAX_ATTEMPTS` 8). A `PermanentProviderError` (invalid recipient, disabled channel) fails at once; anything else is
transient. Final state FAILED with the reason; FAILED events/notifications are never retried automatically (admins may retry or cancel a notification, audited).

## 4. Notifications

`Notification { type, severity, recipientKind STAFF|CUSTOMER, recipientUserId | customerId (+ customerContactId), channel IN_APP|EMAIL|WHATSAPP,
recipientAddress (snapshot, external only), locale, templateCode/Version, title, body, variables, entityType/Id, status PENDING|PROCESSING|SENT|FAILED|CANCELLED,
critical, scheduledAt, nextAttemptAt, attempts, sentAt, readAt, failedAt, failureReason, providerMessageId, deduplicationKey }`.
* **Staff** recipients come from automation rules (role, permission, stage assignees, job assignees, sales owner, alert-responsible people).
* **Customers** (no portal, no login): the primary customer contact's email / WhatsApp (or phone), falling back to the customer record; the destination is **snapshotted**
  on the notification, masked in admin lists and never exposed by public tracking. Customers only get **customer-safe events with customer templates**
  (QUOTATION_SENT, SAMPLE_READY_FOR_APPROVAL, PAYMENT_VERIFIED, ORDER_CONFIRMED, ORDER_MILESTONE, ORDER_READY_FOR_DELIVERY, SHIPMENT_DISPATCHED, ORDER_DELIVERED) — enforced when rules are created.
* **In-app** (staff only): immediate `SENT`; `GET /staff/notifications` (unread, severity, type), `GET …/unread-count`, `POST …/:id/read`, `POST …/read-all`; strictly own (somebody else's id is a 404).
* **Admin** (`notifications.read_all|manage`): `GET /admin/notifications` (status, channel, type, recipient kind, dates; addresses masked, no bodies), `GET :id` (with text),
  `POST :id/retry`, `POST :id/cancel`, `GET /admin/notifications/summary` (pending/failed outbox, oldest unprocessed event, failed external notifications, open alerts, scheduler heartbeat, providers).
* **Security:** no passwords, auth tokens, payment details or signed URLs in payloads or messages. `trackingLink` is a supported variable but is **never filled**: tracking tokens are shown once and
  only their hash is stored, so a link cannot be rebuilt later and the seeded templates do not use it.

### Templates and variables
`NotificationTemplate { code, channel, locale, version, subject, bodyTemplate, active }`: English and Arabic seeded for every code and channel (`template-catalog.ts`); a new locale is just more rows.
Versions are immutable (trigger) — publish a new one (`POST /admin/notification-templates`), roll back with `activate`, `deactivate` to switch a message off (skipped, never failing).
Only `{{variableName}}` from the whitelist is evaluated (`customerName, brandName, sampleNumber, orderNumber, jobNumber, shipmentNumber, quotationNumber, currentStage, stageName, targetDate,
trackingLink, milestone, reason, recipientName, alertTitle, alertReason, severity, escalationLevel, productName`). Unknown names, expressions, `{% %}`, `${}`, backticks, triple braces, script-like text and over-long templates are rejected;
values are plain text (control characters stripped, 300-char cap, never re-evaluated) and HTML for email is escaped.
Staff pick their language (`PUT /staff/notification-preferences`), customers have `preferredLocale`; unknown locales are refused, a missing translation falls back to `NOTIFICATION_DEFAULT_LOCALE`.

### Preferences
Staff: `UserNotificationPreference` per category (SAMPLES, COMMERCIAL, PRODUCTION, QUALITY, DELIVERY, ALERTS, PRODUCTION_MILESTONE) × in-app / email / WhatsApp (defaults on / on / off).
**Critical rules ignore preferences and quiet hours**; by default: failed deliveries, commercial re-approval, escalations to ADMIN. Customers: `CustomerNotificationPreference`, recorded by staff
(`PUT /admin/customers/:id/notification-preferences`); only the optional PRODUCTION_MILESTONE category can be switched off — document, payment and delivery messages are transactional (there is no marketing).

### Quiet hours
`NOTIFICATION_QUIET_HOURS_START/END` (HH:MM, may cross midnight) in `BUSINESS_TIMEZONE`, applied to email/WhatsApp of customers (`…_APPLIES_TO=customer`, default) or everybody (`all`). Held notifications get `scheduledAt` = window end;
in-app and critical notifications are never held.

### Providers (ports)
`EmailProvider` / `WhatsAppProvider` (abstract classes). Email message: recipient, subject, text, escaped html, idempotency key, metadata, returns provider message id. WhatsApp message: recipient, **approved template reference**
(`<templateCode>_<locale>`), ordered variables and a rendered fallback text — compatible with WhatsApp Business template rules; free-form text is never assumed to be allowed. Selection is environment-driven
(`EMAIL_PROVIDER`, `WHATSAPP_PROVIDER` = `log` | `disabled`; production defaults to `disabled`): `log` records deliveries in memory, logs metadata only (masked address, no body) and is idempotent; `disabled` skips the channel
(no notifications planned for it). A vendor (Resend, SES, Twilio, Meta) is one more class behind the port and one more case in `notifications.module.ts`; no credentials live in code.

## 5. Automation rules and alerts

`AutomationRule { eventType, alertType?, minSeverity?, audience, audienceValue?, channels, templateCode, severity, critical, active }` — a narrow mapping, not a rules engine. Audiences: ROLE, PERMISSION, STAGE_ASSIGNEES,
JOB_ASSIGNEES, ALERT_RESPONSIBLE, SALES_OWNER, CUSTOMER. Seeded defaults cover every event (`default-rules.ts`); `GET/POST/PUT /admin/automation/rules` (`automation.read|manage`, audited). Roles and permissions must exist, templates match the audience.

### Operational alerts (scheduled evaluator)
`OperationalAlert { type, entityType, entityId, fingerprint, status OPEN|RESOLVED, severity, lastNotifiedSeverity, firstDetectedAt, lastDetectedAt, resolvedAt, lastNotifiedAt, escalationLevel }`; one OPEN alert per fingerprint
(`type:entityType:entityId`, partial unique index). Each run takes the Phase 6A Needs Attention snapshot (unfiltered by caller):
* new condition → alert + `ALERT_OPENED`; unchanged condition → nothing (only `lastDetectedAt`);
* a higher severity than any already announced → `ALERT_SEVERITY_INCREASED` once per new level (a dip and a return to a level already announced is silent);
* open longer than an escalation rule's working minutes → `ALERT_ESCALATED` once per level;
* condition gone → `RESOLVED` (history kept); if it returns, a **new** alert opens. Categories that hit the 200-row read cap are not resolved that run.

### Escalation rules
`EscalationRule { alertType, minSeverity?, level 1–5, afterMinutes (working), recipientKind ROLE | RESPONSIBLE_DEPARTMENT, recipientRoleCode?, channels, critical }`, unique per active alert type + level, so escalation is bounded
(five levels, each fires once, escalation messages are never alerts themselves). RESPONSIBLE_DEPARTMENT maps the alert's department to the role that works it (there is no "department lead" concept yet).
Defaults: delayed / packaging-delayed stage 120 min → department, 480 min → ADMIN (critical); blocked stage 60 → department, 240 → ADMIN; overdue order 60 → SALES, 240 → ADMIN; overdue job 120 → ADMIN; failed shipment 120 → ADMIN.

### Scheduler
In the API process (single node): timers for `outbox` (10 s), `dispatch` (15 s) and `alerts` (300 s), single-flight per task, `unref`'d, off with `SCHEDULER_ENABLED=false` (always off in tests, which run the tasks explicitly).
Every task is idempotent and concurrency-safe (claims, dedup keys, unique open fingerprint), so running several API nodes does not duplicate work; the migration path is to keep the three methods and trigger them from a queue.
Heartbeat row per task + history rows for runs that did work or failed in `scheduler_runs` (14-day retention). `GET /admin/automation/scheduler`, `POST /admin/automation/run` (`automation.manage`) run tasks now.

## 6. QR job cards

`FactoryJobQrToken` (one active per job). The QR encodes `<PUBLIC_APP_URL>/q/<token>`: a 256-bit token derived by HMAC-SHA256 from the token row id and a server secret — no database id, not guessable, not derivable from the job number.
Only the SHA-256 is stored (immutable by trigger); the server can recompute the **active** token to reprint a card. `POST /admin/factory-jobs/:id/qr` (generate, returns token/url/SVG once), `…/qr/rotate`, `…/qr/revoke`,
`GET …/qr` (status and history, never the token) — `qr_job_cards.manage|read`, audited.

**A QR code identifies, it never authenticates.** `GET /factory/qr/:token` needs a signed-in staff member (`jobs.read_assigned`); people assigned to a stage of the job (or holding `jobs.read_all`) get the job card and, for
their own open stages, the existing staff task view (`allowedActions` unchanged); everyone else — and any unknown, malformed, revoked or rotated code — gets the same 404.
The job card (`GET /admin/factory-jobs/:id/job-card`, `…/print` deterministic HTML with the inline QR): job, order/sample, batch, brand, product, quantity, priority, status, target date, current stages, approved specification
reference, material, factory instructions. **No prices, payments, quotations, customer name or contact details.**

## 7. Tech packs

Operational documents, **not** customer approvals. `TechPack` (TPK-000001) per sample or order, many `TechPackVersion`s (`DRAFT → ISSUED → SUPERSEDED`).
* **Source of truth:** SAMPLE → latest PRE_PRODUCTION `SampleProductionSpec`; ORDER → APPROVED_REFERENCE spec + the `OrderProductionSpec` in force. Master data is never read for the document, so later edits cannot change an issued pack.
  Two things that are not frozen elsewhere are snapshotted into the content at generation: the order's packaging specification and the active QC checklists.
* **Content:** reference/version/timestamp, source references and spec hashes, customer + brand (admin copy), product, fabric (+composition), colour/Pantone/hex, GSM, fabric provider, sample size, pattern version and fit method, size charts, decorations
  (print method, placement, dimensions, colours, artwork references and file checksums), accessories, labels/packaging components, factory instructions, order quantities and size/colour breakdown, packaging, QC requirements, jobs, job-card URL.
* **Versioning:** generating always creates the next version; an unissued draft is replaced by a newer draft; issuing supersedes the previously issued version; an order revision or newer pre-production spec makes an issued version **stale** (flag) and a draft generated
  before the change can no longer be issued. Content, hash, source specs, version, generator are immutable (trigger); the only legal status moves are DRAFT→ISSUED|SUPERSEDED and ISSUED→SUPERSEDED; the issued document cannot change.
* **PDF:** PDFKit (pure Node, no browser, no network; chosen over headless Chrome for safety and determinism). Fixed creation date = generation time, uncompressed, built-in Helvetica → the same content gives the same bytes. The PDF is the **floor view**
  (brand only, no customer identity), stored privately as an `Asset` of type `TECH_PACK` (random key, checksum, cannot be archived) and served through short-lived signed URLs. When the pack points at one job with an active QR code, that QR is drawn on the PDF
  (vector squares via `qrcode`); rotating the token later means re-generating to refresh the printed QR. Text outside Latin-1 (Arabic names) is replaced by `?` on the PDF only; the JSON content keeps the original text.
* **Access:** `tech_packs.read` (any pack; admin, sales), `tech_packs.generate`, `tech_packs.issue` (issue, supersede). Floor staff read the **issued** pack of jobs they are **assigned to** via `GET /staff/jobs/:jobId/tech-pack` (+ `/document`), read-only, without the customer.

APIs: `GET|POST /admin/samples/:id/tech-pack`, `GET|POST /admin/orders/:id/tech-pack`, `GET /admin/tech-pack-versions/:id` (+ `/document`), `POST …/issue`, `POST …/supersede` (reason).

## 8. Permissions (86 in total, 13 new, batch `phase6b-automation`)
| Permission | Default roles |
|---|---|
| `notifications.read_all`, `notifications.manage`, `notification_templates.read|manage`, `automation.read|manage`, `qr_job_cards.read|manage`, `tech_packs.generate|issue`, `working_calendar.manage` | ADMIN |
| `tech_packs.read`, `working_calendar.read` | ADMIN, SALES |
Staff notification endpoints need authentication only (own data). Floor roles get nothing new: they use the staff API (assignment-checked).

## 9. Audit
Template publish / activate / deactivate; working calendar create / update / default / exceptions; automation and escalation rule create / update; QR generate / rotate / revoke; tech pack generate / issue / supersede; manual notification retry / cancel;
customer preference changes. Metadata holds ids and settings, never message text or tokens.

## 10. Observability
`GET /admin/notifications/summary` (outbox pending / processing / failed, oldest unprocessed event and age, external notification counts, open alerts by severity, scheduler heartbeat per task, providers) and `GET /admin/automation/alerts`.

## 11. Limitations
* The scheduler is in-process (documented migration path above); a crashed API stops processing until restart, events wait safely in the outbox.
* No real email / WhatsApp vendor yet (ports, `log` and `disabled` providers only); WhatsApp variables are passed positionally from the rendered values.
* `trackingLink` is never filled (tokens cannot be reconstructed); customer messages do not contain a tracking URL.
* "Department lead" is approximated by the department's role; the working calendar is one default calendar (no per-department or per-person calendars, no shifts).
* PDF text is Latin-1 only; the QR on a PDF goes stale when the token is rotated until the pack is regenerated.
* Alert evaluation reads at most 200 rows per category; the `PAYMENT_BLOCK` check evaluates the commercial gate per order and is the slowest.
* Outbox rows are kept (notifications reference them); archival of old processed events is future work.

## 12. Phase 7 compatibility
Inventory, purchasing, suppliers, smart quotation, advanced planning, CRM, customer portal and 3D can emit their own events through `OutboxService` and add rules/templates without touching delivery code; a customer portal would add a customer
identity to `Notification` recipients and use the existing preference model; a real provider plugs into the ports; the calendar can grow per-department calendars behind `CalendarService.clock()`.
