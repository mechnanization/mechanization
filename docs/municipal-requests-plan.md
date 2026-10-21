# Municipal requests and certificates — implementation plan
## منظومة المعاملات والإفادات البلدية

> **Status: Phases 1–4 built, on `fix/fees-page-ux` (PR #122), rebased on the stack and reviewed, 2026-10-13; the review's blocker and majors fixed on `fix/pr122-review`, 2026-10-15** — the
> migration (`0092_citizen_requests`), the backend, the staff screens and the portal, with
> every Phase 0 decision taken as recorded in
> [open-decisions.md §20](open-decisions.md#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13).
> Phase 5 (notifications) is not built and not planned for now: no SMS or WhatsApp provider, by
> the product owner's decision of 2026-10-13 (D9). Paying a request's fee online is paused with
> all online payment until Whish gives the municipality its API: the fee is paid at the
> municipality ([open-decisions.md §21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)). What was built, under which names, and what is
> left: [§7](#7-what-was-built-2026-10-13). §1–§6 are the plan as reviewed against
> `develop@5e8f5c3` on 2026-10-12; where a **Proposal** name differs from §7, §7 and the
> code win.

A citizen asks the municipality for a paper — a براءة ذمة, a إفادة سكن, a lease
registered — pays its fee, and collects the stamped paper at the counter. Staff
review each request, check what the paper must certify, print it on the
municipality's letterhead, and hand it over.

**Two ways in, from the first release (D8, decided 2026-10-12):** a citizen
submits online through the portal, or staff file the request at the counter for
a citizen who is present. Both are one request, one bill and one queue; only who
filed it differs. Either way, while online payment is paused (2026-10-13,
[open-decisions.md §21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)), the fee is paid at the municipality.

---

## 0. How to use this document

- **Phases run in order, one PR each.** The migration is its own
  `chore/migration-NNNN` PR, merged to `develop` before the code that needs it
  ([CLAUDE.md](../CLAUDE.md#git), non-negotiable 5).
- **Phase 0 comes first.** §2 lists decisions that are the municipality's or
  the product owner's, not the code's. They are tracked in
  [open-decisions.md §20](open-decisions.md#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13).
  All ten are recorded as decided there (D8 on 2026-10-12, the rest on 2026-10-13); a later
  answer from the municipality overrides one and is recorded there the same way.
- **Never invent a name.** Grep for every model, column, enum value, route,
  role set, component and message key before using it ([CLAUDE.md](../CLAUDE.md#how-to-work-here)).
- **Read first:** [CLAUDE.md](../CLAUDE.md), [database.md](database.md),
  [security.md](security.md), [ui-ux-standards.md](ui-ux-standards.md) (binding),
  [finance.md](finance.md) for bills and payments, and
  [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md).

---

## 1. What exists today (verified 2026-10-12)

### Tenancy and people

- **Tenancy is the Postgres schema.** There is no `tenantId` column anywhere.
  Data access goes through `TenantContextService`; multi-step writes through
  `runInTenantTransaction`, which carries an `afterCommit` queue for side effects
  (`apps/backend/src/infrastructure/context/tenant-transaction.ts`). Raw SQL is
  schema-qualified ([database.md](database.md)).
- **`users` holds staff and citizens**, split by `UserKind`. Nothing in the
  database stops a foreign key to `users` from pointing at the wrong kind: the
  services check it, e.g. `FeesService.chargeIndividual` reads
  `findFirst({ where: { id, kind: 'CITIZEN' } })` and calls `assertNotMergedAway`.
- **Staff roles** are `STAFF_ROLE` in `packages/shared-schemas/src/enums.ts`;
  routes take their roles from the sets in
  `packages/shared-schemas/src/role-sets.ts` (`FEE_ISSUE_ROLES`,
  `FEE_SETTLE_ROLES`, …), pinned per handler in `route-inventory.spec.ts`.
- **A citizen route** has no `@Roles`: it checks `user.kind === 'CITIZEN'` itself
  and scopes every query by `user.sub`, as `fees.controller.ts` does
  ([security.md](security.md): a route without `@Roles` is reachable by citizen
  tokens).
- **Citizen sign-in in production** is the reference-only route,
  `t/:tenantSlug/auth/citizen/reference/open`: OTP fails closed because
  `SmsProviderService` has no provider ([gotchas](gotchas.md#citizen-otp-sign-in-cannot-work-in-production)).
  It stays so by the product owner's decision of 2026-10-13: no OTP or second factor, so elderly
  citizens can sign in ([open-decisions.md §21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)).

### Bills and payments

- **`FeeNotice` (`fee_notices`) is a fee definition, not a bill**: a title, an
  amount, a currency, a `FeeFrequency` (`ONCE`, `MONTHLY`, …) and a
  `FeeTargetType` (`ALL_CITIZENS`, `BUILDING_CATEGORY`, `INDIVIDUAL_CITIZEN`). It
  has no `kind` and no `status`. There is no `CERTIFICATE_FEE`.
- **The citizen's bill is `CitizenPayment` (`citizen_payments`)**: `citizenId`,
  an optional `feeNoticeId`, `invoiceNumber` («INV-…»), `title`, `amount`,
  `paidAmount`, `currency`, `dueDate`, `paymentStatus` (`UNPAID`,
  `PENDING_REVIEW`, `PAID`, `OVERDUE`), `paymentMethod` (`CASH`, `WHISH_MONEY`,
  `COLLECTOR`).
- **A one-off bill** for one citizen is `FeesService.chargeIndividual(
  { citizenId, title, amount, dueDate, actor })`: it draws the «INV-» number and
  writes the bill in its own `$transaction`.
- **Settling** is `FeesService.settleInPerson` (the counter),
  `startWhishCheckout` / `settleFromWhishCallback` (Whish), `review` (a payment
  the citizen declared), and `reverseTransaction`. A confirmed settlement emits
  `payment.reviewed`; a reversal emits `payment.reversed`. Events are synchronous
  strings ([gotchas](gotchas.md#events-are-synchronous-strings)), and a side
  effect inside a transaction is lost or premature
  ([gotchas](gotchas.md#side-effects-inside-a-transaction-are-lost-or-premature)).
- **Paying into the treasury** credits a wallet and is subject to the closed-day
  lock ([finance.md](finance.md)).

### Document numbers

- `document_counters` (migration `0079_document_numbering`): `kind TEXT`,
  `period` («YYMM», Asia/Beirut), `nextValue`; primary key `(kind, period)`; the
  only CHECK is `nextValue >= 1`. The schema comment: "Text, not an enum: a fifth
  book should not need a migration".
- The prefixes are `DOCUMENT_PREFIX` in
  `packages/shared-schemas/src/document-numbering.ts` (`INV`, `RCP`, `PV`, `TR`,
  `RV`, `BRC`, …); the draw is `allocateDocumentNumber(tx, schema, kind)` in
  `apps/backend/src/application/common/document-number.ts`.
- **A new «REQ-YYMM-NNNN» book needs no migration**: add the kind and its prefix
  to `DOCUMENT_PREFIX` and to its tests.

### Files

- **S3 is already wired**: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`
  in `apps/backend/package.json`; `apps/backend/src/infrastructure/aws/s3-storage.service.ts`
  writes with `PutObjectCommand` and serves signed `GetObjectCommand` URLs.
- **A `documents` table exists** (`Document`: `registrationId`,
  `propertyEntryId`, `DocumentType` `IDENTITY` / `OWNERSHIP_PROOF` /
  `RENTAL_CONTRACT` / `RESIDENCY_PROOF` / `EXTRA_PHOTO`, `storagePath`,
  `mimeType`, `sizeBytes`). Its upload path, `DocumentService`, is dormant, and
  [security.md](security.md) lists it as a gap: it trusts the client-declared
  MIME type.
- **The upload rule** ([security.md](security.md)): cap the size in the
  interceptor (`FileInterceptor` limits from `APP_CONFIG`), check the content
  rather than the declared MIME type, and write under a tenant-specific key.

### Properties

- `PropertyEntry` (`property_entries`): a citizen's property card, one per card,
  `propertyNumber` unique. `BuildingUnit`: a unit on that card.
- The census's canonical register: `Parcel`, `Building` and `Unit` ("one
  canonical unit inside a building").
- What is owed on a property («المستحق على عقار») is computed in
  `buildings.service.ts`.

### Printing and the portal

- `apps/frontend/components/admin/finance/official-document.tsx` exports
  `useMunicipalLetterhead`, `LetterheadLines`, `LetterheadCrest`, `DocumentRow`,
  `SignatureBlock`, `documentPrintCss` and `useAutoPrint`. A printed document is
  **its own page** (PRIM-28: `data-print-root`, `?print=1`), as
  `finance/income/[voucherId]/print` is.
- The citizen portal is `app/[tenant]/[locale]/(citizen)/`: `my-file`,
  `my-account`, `payments`, `login`. `components/citizen/pay-dialog.tsx` is the
  portal's payment.
- The admin sidebar (`components/admin/nav.ts`) holds at most five rows a group;
  «المواطنون» has four. `FileCheck` is not used by any row. No admin route is
  named `requests`.

### Messages and migrations

- **No SMS or WhatsApp provider exists.**
- **Tenant migrations:** `develop` ends at `0089`. The local branch
  `chore/migration-0090-0091` already holds `0090_finance_audit_enum_values` and
  `0091_finance_audit_controls`. The next free number is `0092` **at the time of
  writing**; claim it when the PR opens
  ([gotchas](gotchas.md#migration-numbers-collide-across-branches)).

---

## 2. Decisions needed before building (Phase 0)

Tracked in [open-decisions.md §20](open-decisions.md#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13).
All ten are recorded as decided there: D8 on 2026-10-12, the rest on 2026-10-13, and D9
confirmed by the product owner the same day ([§21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)). The table keeps each question
as it was asked.

| # | Question | Why it matters | Blocks |
|---|---|---|---|
| D1 | **The fee for each request type, and its currency.** The first draft guessed «Clearance 200,000 LBP, Residency 100,000 LBP». | Fees are set by law and the municipal council, not by the code. Also: may a type be free? | Phase 2 (bills) |
| D2 | **Who may request each paper, and on what proof.** E.g. may a tenant ask for a براءة ذمة; an heir with which document; an agent with which وكالة; is a إفادة شغور owner-only. | The draft hard-coded rules (CLEARANCE: OWNER / ESTATE_HEIR / LEGAL_AGENT; VACANCY: OWNER). These are legal rules. | Phase 2 (validation), Phase 4 |
| D3 | **What each paper certifies, in what words, and for how long it is valid.** For a براءة ذمة: dues on which property, as of which moment. For a إفادة سكن: what it may say about residency, given the residency and refugee data the register holds ([CLAUDE.md](../CLAUDE.md)). | The printed text is a legal statement. A براءة ذمة must be judged at issuance and say "as of" that day; a live figure on a staff screen is not the certificate. | Phase 3 (print) |
| D4 | **Which property record a request names**: the citizen's card (`PropertyEntry`, `BuildingUnit`) or the census's canonical `Parcel` / `Unit`. | The two registers can disagree; dues are computed per property. | Phase 1 (columns) |
| D5 | **A request rejected after it was paid**: refund, credit, or keep the fee. | There is no refund flow today; a refund is a treasury outflow with its own voucher ([finance.md](finance.md)). | Phase 2 (transitions) |
| D6 | **Identity copies**: how long they are kept, and which staff roles may open them. | Ties to open decisions §1 (legal basis and retention) and §17.2 (whether the head's account sees scanned identity documents). | Phase 2 (uploads), Phase 3 |
| D7 | **Verifying a printed paper**: what its QR code holds, and whether anyone can check it. | A public verification page would be a new unauthenticated surface ([security.md](security.md)). | Phase 3 (print) |
| D8 | **Who submits in the first release.** **Decided 2026-10-12: both** — citizens online through the portal, and staff at the counter for a citizen who is present. | Online submission means a citizen action raises a bill, which none does today, and uploads come from the public internet; citizens sign in by reference in production (§1). | — (decided) |
| D9 | **Notifications**: provider, channels, consent, and what a message may contain. **Decided 2026-10-13: none for now** — no SMS or WhatsApp provider; the portal shows each request's status. | No provider exists; a message is personal data leaving the system (non-negotiable 7). | Phase 5 (skipped for now) |
| D10 | **Lifecycle edges**: may a citizen cancel; do unpaid requests expire and after how long; may a citizen hold two open requests of one type for one property. | Each needs a state, a job or a constraint. | Phase 1, Phase 2 |

**What D8 means for the order:** the portal (Phase 4) is part of the first
release, so D2 (eligibility) and D6 (identity copies) must be answered before
Phase 2 opens the citizen routes, not after. The counter and the portal call the
same service and the same eligibility rules, so the two never disagree about who
may ask for what.

---

## 3. Data model (Proposal)

### 3.1 Shared enums and labels (`packages/shared-schemas`)

Add to `src/enums.ts`, with Arabic and English labels in `src/labels.ts`.
Follow [database.md](database.md) for how an enum column is stored, and
remember that a new Postgres enum value cannot be used in the migration that
adds it ([gotchas](gotchas.md#a-new-enum-value-cannot-be-used-in-its-own-migration)).

- `REQUEST_TYPE`: `CLEARANCE` (براءة ذمة بلدية), `RESIDENCY` (إفادة سكن / إقامة),
  `OCCUPANCY` (إفادة إشغال), `VACANCY` (إفادة شغور), `LEASE_REGISTRATION`
  (تسجيل وتصديق عقد إيجار), `RENOVATION` (رخصة ترميم), `SIGNAGE` (رخصة لافتة),
  `OTHER` (طلب عام). The list itself is for the municipality to confirm (D1, D3).
- `APPLICANT_CAPACITY`: `OWNER`, `TENANT`, `ESTATE_HEIR`, `LEGAL_AGENT`,
  `FREE_OCCUPANT` (D2).
- `REQUEST_STATUS`: `AWAITING_PAYMENT`, `IN_REVIEW`, `READY_FOR_PICKUP`,
  `COMPLETED`, `REJECTED`, and, per D10, `CANCELLED` and `EXPIRED`.
- `REQUEST_CHANNEL`: `ONLINE` (the citizen, through the portal) and `COUNTER`
  (staff, for a citizen who is present) (D8).
- `REQUEST_ATTACHMENT_TYPE`: the papers a request may carry (identity, title
  deed, lease, power of attorney, mukhtar statement, other). Separate from
  `DocumentType`, which belongs to registrations.
- `DOCUMENT_PREFIX`: add `REQUEST: 'REQ'` (no migration; §1).

### 3.2 `citizen_requests` (Proposal)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `requestNumber` | text, unique | «REQ-YYMM-NNNN», drawn with `allocateDocumentNumber(tx, schema, 'REQUEST')` in the same transaction as the row. |
| `citizenId` | uuid → `users.id` | Must be a CITIZEN, checked in the service as `chargeIndividual` does; taken from the token on citizen routes, never from the body. |
| `requestType` | `REQUEST_TYPE` | |
| `channel` | `REQUEST_CHANNEL` | `ONLINE` or `COUNTER` (D8). `CHECK (channel <> 'COUNTER' OR "createdById" IS NOT NULL)`: a counter request names the clerk who filed it. |
| `applicantCapacity` | `APPLICANT_CAPACITY` | |
| `status` | `REQUEST_STATUS` | Default `AWAITING_PAYMENT`, or `IN_REVIEW` for a free type (D1). |
| `propertyEntryId` / `unitId` (or `parcelId`) | uuid, nullable | Per D4. Not every type names a property (`OTHER`, possibly `RESIDENCY`). |
| `citizenPaymentId` | uuid, nullable, unique → `citizen_payments.id` | **The bill.** Not `feeNoticeId`: a notice is a definition, and the amount lives on the bill. No `feeAmount` column. |
| `purpose` | text, nullable | What the citizen needs the paper for. |
| `rejectionReason` | text, nullable | `CHECK (status <> 'REJECTED' OR "rejectionReason" IS NOT NULL)`, written so a NULL does not slip through ([gotchas](gotchas.md#a-check-passes-on-null-so--against-a-nullable-column-lets-the-row-in)). |
| `requestKey` | text, unique | The retry key: a double press makes one request and one bill, and the replay answers from the first. |
| `submittedAt`, `paidAt`, `reviewedAt`, `readyAt`, `completedAt`, `cancelledAt` | timestamptz, nullable | One stamp per transition. |
| `reviewedById`, `completedById`, `createdById` | uuid → `users.id`, nullable | Staff, checked in the service. `createdById` is the clerk who filed a counter request; null online. |
| `createdAt`, `updatedAt` | timestamptz | |

Indexes: `(status, submittedAt)` for the staff queue, `(citizenId, submittedAt)`
for «طلباتي», and, if D10 forbids duplicates, a partial unique index on
`(citizenId, requestType, <property column>)` over the open statuses.

### 3.3 `citizen_request_attachments` (Proposal)

A table, not a JSONB array: each file needs its own row to be audited, reviewed,
retained (D6) and deleted.

`id`, `requestId` → `citizen_requests.id`, `type` (`REQUEST_ATTACHMENT_TYPE`),
`storagePath` (under a tenant-specific key), `mimeType` (as **sniffed** by the
server), `sizeBytes`, `uploadedById` → `users.id`, `createdAt`. The original file
name is not kept: it can hold a name or an ID number.

### 3.4 Transitions

| From | To | Who | How |
|---|---|---|---|
| (new) | `AWAITING_PAYMENT`, or `IN_REVIEW` for a free type | the citizen online, or staff at the counter (D8) | `submit`: one transaction draws «REQ-» and writes the request. The fee's bill is raised later, when the citizen goes to pay (`raiseBill`, D10). |
| `AWAITING_PAYMENT` | `IN_REVIEW` | the system | Its bill reaches `PAID` (Phase 2, the payment hook; `PENDING_REVIEW` and a part payment do not count), or its type is made free before it is billed (`REQUEST_FEE_WAIVED`). |
| `AWAITING_PAYMENT` | `CANCELLED` | the citizen or staff; the manager | While it has no bill (`cancel`). With one, only when that bill is cancelled: by the manager («إلغاء الفاتورة», `cancelRequestOfCancelledBill`, decision of 2026-10-13), or by the system on the next read (`reconcile`) for a request that press did not reach. Nothing expires. |
| `AWAITING_PAYMENT` | `REJECTED` | staff | With a reason, while it has no bill (`REQUEST_BILL_OPEN` otherwise). |
| `IN_REVIEW` | `READY_FOR_PICKUP` | staff (`REQUEST_HANDLE_ROLES`) | The paper is written; for a براءة ذمة the dues are judged now (D3). |
| `IN_REVIEW` | `REJECTED` | staff | With a reason; what happens to the fee is D5. |
| `IN_REVIEW` | `AWAITING_PAYMENT` | the system | The payment was reversed (`payment.reversed`); only a billed request. If the reversal's event was lost and the bill is then cancelled, this step is taken late, with its own row, and the request is cancelled straight after: there is no `IN_REVIEW` → `CANCELLED` step. |
| `READY_FOR_PICKUP` | `COMPLETED` | staff | At the counter, against the original identity card. |

These are the only transitions the database accepts: `0094_citizen_request_guard` refuses any
other, any change once `COMPLETED`, `REJECTED` or `CANCELLED` (but the file a merge moves it to),
each step's stamps written by another step, and any DELETE.

Every transition writes a Tier 1 audit row in the same transaction
([security.md](security.md): an audit row that cannot be written undoes the
change).

---

## 4. Phases

### Phase 0 — Decisions (no code)

Ask D1–D10, record the answers in [open-decisions.md](open-decisions.md), and
update this plan where they change it.

### Phase 1 — Migration (its own PR)

- Branch `chore/migration-0092` (or the next free number when it opens), from
  `develop`. It holds the SQL and `schema.prisma`, nothing else.
- `tenant/migrations/0092_citizen_requests/migration.sql`: the two tables of
  §3.2–3.3, their enums or CHECKs, foreign keys, indexes; schema-qualified and
  additive. `schema.prisma`: the two models and their back-relations on `User`,
  `CitizenPayment` and the property model of D4.
- Apply with `pnpm db:deploy:local` (never a bare `prisma migrate`), run its
  integration suite on a throwaway Postgres 17, and update
  [database.md](database.md).
- Merged to `develop` before Phase 2.

### Phase 2 — Backend

1. **Shared schemas**: the enums and labels of §3.1; `DOCUMENT_PREFIX.REQUEST`;
   `src/citizen-request.schema.ts` (**Proposal**) with the submission, review,
   rejection and list-query schemas; the eligibility rules of D2 as a pure,
   tested function, used by both the server and the wizard. Rebuild with
   `pnpm --filter @mechanization/shared-schemas build`.
2. **Role sets** in `role-sets.ts` (**Proposal:** `REQUEST_READ_ROLES`,
   `REQUEST_HANDLE_ROLES`), and who may see identity copies (D6).
3. **Service**, `apps/backend/src/application/features/citizen-requests/`
   (**Proposal**), on `TenantContextService` and `runInTenantTransaction`:
   - `submit`: one method for both channels (D8), told which one and by whom:
     the citizen check, D2's rules, the retry key, «REQ-», and the bill. Online,
     the citizen is the token's; at the counter, the clerk picks the citizen and
     is recorded as `createdById`. `chargeIndividual` opens its own `$transaction` and a transaction
     client has none ([gotchas](gotchas.md#a-transaction-client-has-no-transaction)),
     so extract its body into a transaction-aware helper both callers use,
     rather than calling it from inside the request's transaction.
   - The staff queue (server-paged, with the `query-params.ts` helpers), one
     request, and the citizen's own list.
   - The transitions of §3.4, each with its audit row.
4. **The payment hook**: listen to `payment.reviewed` and `payment.reversed`,
   read the bill, and move the request linked to it only when the bill is `PAID`
   (or no longer is). Queue the change on `afterCommit` so it never runs on a
   payment that rolled back. Cover the counter, Whish, a declared payment
   reviewed by staff, bulk settlement, and a reversal.
5. **Uploads go through the API**, not straight from the browser to S3: the
   `FileInterceptor` size cap, a content check (sniff the bytes, accept JPEG,
   PNG, WebP and PDF), and a tenant-specific key, written with
   `s3-storage.service.ts`. Staff open a file through a short-lived signed URL.
   A presigned browser upload would skip both checks the rule requires.
6. **Controllers**: citizen routes under `t/:tenantSlug` that check
   `user.kind === 'CITIZEN'` and scope by `user.sub` (submit, upload, list
   their own); staff routes with `@Roles` (the queue, a counter submission for a
   chosen citizen, its uploads, the transitions); `ZodValidationPipe` on every body, `ParseUUIDPipe` on every id, a
   throttle on submission and upload; every handler in `route-inventory.spec.ts`.
7. **Tests**: unit tests for D2's rules and the transitions; integration suites
   on a throwaway Postgres 17 for the numbering, the bill, the hook (paid, part
   paid, pending review, reversed) and the retry key.
8. **Docs**: [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md),
   [security.md](security.md) (the new routes, the upload path),
   [packages/shared-schemas/CLAUDE.md](../packages/shared-schemas/CLAUDE.md),
   [PRODUCT.md](../PRODUCT.md).

### Phase 3 — Staff screens

1. **Nav**: a row under «المواطنون» (four rows today), «طلبات المعاملات»,
   icon `FileCheck`, roles `REQUEST_READ_ROLES`; route `/requests`. Update
   `lib/nav.test.ts`.
2. **A counter request** is its own page, `/requests/new` (**Proposal**; BAN-10:
   an address, and it survives a reload): the citizen, found with the register's
   existing citizen search; the type, its fee and its papers; the property; the
   papers, scanned or photographed by the clerk; then the request and its bill,
   with the fee taken at once through the counter settlement if the citizen pays
   now. «طلب جديد» in the queue's heading opens it, for `REQUEST_HANDLE_ROLES`.
3. **The queue**: `PageHeader` (PRIM-1), `DataTable` with server paging
   (PRIM-3: `manualPagination manualFiltering sortable={false}`), search by
   request number, name or reference, status through the kit's
   `SegmentedControl` or `FilterSelect` (there is no "chip" primitive), status as
   a `Badge` with its word, never colour alone (COL rules), and the channel
   (online or counter) on each line and as a filter.
4. **The request** in a `Sheet` (PRIM-17; on Radix with a focus trap since
   2026-10-12): the citizen, the property, the bill and its status, what is owed
   on the property, and the attachments through signed URLs to the roles of D6.
   Identity numbers are shown only to roles that need them and never logged
   (non-negotiable 7). Approve, hand over and reject act through confirmation
   dialogs; rejection requires its reason.
5. **The paper** is its own page, `/requests/[requestId]/print` (PRIM-28): the
   letterhead and signature from `official-document.tsx`, `?print=1` with
   `useAutoPrint`, the text per D3, the QR per D7.
6. **Copy** in `messages/ar.json` and `messages/en.json`, both complete (TXT-1);
   the §16 pre-merge checklist of [ui-ux-standards.md](ui-ux-standards.md);
   [apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md) and
   [PRODUCT.md](../PRODUCT.md).

### Phase 4 — The citizen portal (first release; after D2 and D6)

1. **The wizard is a page**, not a dialog (BAN-10: a multi-step task with
   uploads needs an address and survives a reload), e.g.
   `(citizen)/my-file/requests/new` (**Proposal**): the type with its fee and its
   papers; the property, from the citizen's own; the papers; the summary.
   Eligibility comes from the shared function of Phase 2, so the screen and the
   server agree.
2. **Uploads**: the browser may shrink a photo before sending it (**Proposal:**
   `lib/image-compression.ts`), to spare the citizen's data; the server checks
   it all the same. A PDF is sent as it is.
3. **Paying** goes through the bill and the portal's existing payment
   (`components/citizen/pay-dialog.tsx`, `(citizen)/payments`), not a new path.
   **Paused 2026-10-13** with all online payment until Whish gives the municipality its API
   ([open-decisions.md §21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)): the citizen pays at the municipality, where the counter
   raises the fee («تحصيل الرسم»).
4. **«طلباتي»** in `my-file`: each request with its status in words, where to pay (the
   municipality, while online payment is paused) while it is unpaid, and «جاهزة للاستلام —
   يرجى إحضار الهوية الأصلية» when it is ready.
5. Mobile first, RTL first, both locales; the same docs as Phase 3.

### Phase 5 — Notifications (skipped for now, decided 2026-10-13)

The product owner decided on 2026-10-13: no SMS or WhatsApp provider for now. What follows is
the shape to build when one is chosen.

- A provider, its secrets in the validated config (non-negotiable 7), and a
  dispatch that **never** fails the request or its transaction: queued on
  `afterCommit`, a failure logged without the message's content or the
  recipient's number.
- If the channels are tenant settings, those columns are another migration, in
  their own PR, before this phase.
- The messages carry the request number and the status, not a reason that may
  hold personal detail; their wording is part of D9.

---

## 5. Definition of done (every phase)

From [CLAUDE.md](../CLAUDE.md#definition-of-done): `pnpm typecheck` and
`pnpm lint` pass; the tests of every package touched pass against the same
baseline; a shared-schemas change is rebuilt before its consumers are tested; a
migration was applied with `pnpm db:deploy:local` and its suites ran on a
throwaway Postgres 17; a UI change meets §16 of
[ui-ux-standards.md](ui-ux-standards.md); the docs of the
[Keeping the docs true](../CLAUDE.md#keeping-the-docs-true) table are updated
with their "Last verified" lines; and the report says what ran, what failed and
what was skipped.

---

## 6. What changed from the first draft (2026-10-12)

- The request links to **the bill** (`CitizenPayment`), not to `FeeNotice`,
  which is a fee definition with no `kind` or `status`; `feeAmount` and
  `CERTIFICATE_FEE` are gone.
- The migration number is **0092 or later**: `0090` and `0091` are taken on
  `chore/migration-0090-0091`. The migration is its own PR.
- The «REQ-» book needs **no migration**: `document_counters.kind` is text with
  no CHECK; only `DOCUMENT_PREFIX` changes.
- Attachments are **a table**, uploaded **through the API** with the size cap
  and content check [security.md](security.md) requires, using the S3 service
  that already exists, instead of JSONB and browser-to-S3 presigned uploads.
- Data access is `TenantContextService` / `runInTenantTransaction`
  (`TenantPrismaFactory` is not the pattern), and the payment hook runs after
  commit, only on `PAID`.
- The paper is printed from **its own page**, the citizen wizard is **a page**,
  and statuses use the kit's controls and badges with words.
- Fees, eligibility, certificate wording, refunds, retention, verification
  and notifications are **decisions to ask** (§2), not values in the code.
- **Both channels from the first release** (D8, decided 2026-10-12): the portal
  and the counter, one service, one queue, a `channel` on each request, and a
  counter page for staff.
- Notifications are last and separate: **no SMS or WhatsApp provider exists**.

---

## 7. What was built (2026-10-13)

On `fix/fees-page-ux` (PR #122). **Ship order:** one stack since 2026-10-13, merged in order —
#119 (`0090`, `0091`, `0093`), #120 (the finance audit remediation: «إلغاء الفاتورة» among it),
#121 (`0092_citizen_requests` and its review's `0094_citizen_request_guard`, with the tenant
`schema.prisma` models, in `chore/migration-0092`), then this code (non-negotiable 5: each
migration ahead of the code that needs it).

- **Migration `0092_citizen_requests`** (tenant): the enums `RequestType`, `ApplicantCapacity`,
  `RequestStatus`, `RequestChannel`, `RequestAttachmentType`; the tables
  `request_type_settings` (the manager's list, D1), `citizen_requests` (one CHECK per
  status stamp, a counter request names its clerk) and `citizen_request_attachments`; the
  partial unique `citizen_requests_one_open_key` (one open request per citizen, type and
  card, D10). Its review added `0094_citizen_request_guard`: the request's life held in the
  database (the transitions of §3.4, stamps written once, no DELETE), and a request
  cancelled with a bill only once that bill is cancelled, in place of 0092's CHECK that a
  cancelled request has none. Both applied with `pnpm db:deploy:local`.
- **Shared** (`packages/shared-schemas`): `citizen-request.schema.ts` (inputs and views),
  the enums and labels, `REQUEST_*_ROLES`, the error codes, the «REQ-» book.
- **Backend:** `application/features/citizen-requests/citizen-requests.service.ts` and
  `presentation/controllers/citizen-requests.controller.ts` (`t/:tenantSlug/requests`; the
  citizen's own under `requests/mine`); `raiseOneOffBill` shared with «تكليف مباشر»; the
  papers through `REQUEST_FILE_STORAGE` (S3, sniffed with `sniffAttachment`); the request
  follows its bill on `payment.reviewed` and `payment.reversed`, and is reconciled again
  on every read — which also sends an unbilled request to review once its type is made free
  (D1: the fee in force when the bill is raised); a bill the manager cancels cancels its waiting
  request in the same transaction (`FeesService.cancelBill` → `cancelRequestOfCancelledBill`,
  decision of 2026-10-13, `0094`), and `reconcile` cancels any request still open on a cancelled bill — one a lost reversal left in review as well, which once went back to waiting on a bill nobody could pay; a request shows a fee only while it waits for its bill (the type's current fee), and `null` once it will never be billed; a request's fee is not raised on a file archived since it was filed (`FEE_CITIZEN_ARCHIVED`, as every fee since 2026-10-14; `raiseOneOffBill`); «دمج ملفين» moves a person's requests with them; a card or a
  flat a request names is never deleted (`PROPERTY_NAMED_BY_REQUEST`, `HAS_REQUESTS`). Rules in
  [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md) and [security.md](security.md).
- **Staff screens:** `requests` (the queue and the request's panel), `requests/new` (the
  counter), `requests/types` (the list and its fees), `requests/[requestId]/print` (the
  paper); a request with no fee to come shows «—» in the queue, the panel and the portal. **Portal:** «طلباتي» on `my-file`, `my-file/requests/new` (the wizard),
  `my-file/requests/[requestId]`. Rules in [apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md).
- **Verified:** the backend's unit and integration suites (the request lifecycle, the
  payment hook, the race on one open request, a retry key edited after a lost answer, a type
  made free before billing, the merge), the frontend's tests, a rendered pass over every screen
  against a mocked API (ui-ux-standards §16.4, synthetic people only), and an independent
  review whose eight findings were fixed the same day.

**Left, and why:**

- **Notifications** (Phase 5): skipped for now by the product owner's decision of 2026-10-13, with
  no SMS or WhatsApp provider (D9); the portal shows each request's status.
- **Paying online** is paused by the product owner's decision of 2026-10-13 until Whish gives the
  municipality its API. The portal shows no «ادفع الآن» and tells the citizen to pay at the
  municipality, quoting the request number (`ONLINE_PAYMENT_OPEN`, `lib/online-payment.ts`); the
  server refuses a citizen's own request bill and the Whish checkout (`ONLINE_PAYMENT_UNAVAILABLE`)
  while the gateway is not live, and the counter raises the fee («تحصيل الرسم»). Reopening is in
  [open-decisions.md §21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13).
- **Uploads need S3.** The local stack has no bucket, so a paper fails locally with
  `FILE_UPLOAD_FAILED` by design; staging and production use the private documents bucket.
- **The paper's wording and layout** — the templates the clerk starts from, «إلى من يهمّه
  الأمر», the stamp line — are the municipality's to confirm; nothing claims a legal form.
- **Reference-only citizen sign-in** lets whoever holds a رقم مرجعي act on that citizen's
  requests. This is an accepted risk (the product owner's decision of 2026-10-13: no OTP or second
  factor, so elderly citizens can sign in), recorded with its mitigations in
  [security.md](security.md#known-gaps).
- **Native file pickers** elsewhere (5, listed in ui-ux-standards §17.1) predate
  `FileInput` and move to it when their files are next touched.
