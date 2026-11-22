# Request form builder — implementation plan
## نماذج الإفادات: نماذج طلبات يعرّفها المدير

> **Status: built on stacked branches, 2026-11-22; none merged, no PR opened** — what was built, where it differs from this plan and
> how to release it: [§11](#11-what-was-built-2026-11-22) and [§12](#12-release-runbook-for-the-people-who-merge). §1–§10 are the plan as written
> on 2026-11-21 and a name marked _(proposal)_ below may be built under another. The product questions are
> [open-decisions.md §24](open-decisions.md#24-request-form-builder-what-the-owner-must-decide-2026-11-21) (F1–F12), each
> all **decided** by Abed on 2026-11-21 (Hashem's sign-off pending; F8's retention waits on §1 and F9's wording on the municipality). §1 was verified against `develop@90cebdc` on 2026-11-21; every name in it was grepped and opened.
> A name marked _(proposal)_ is invented here and does not exist; where this plan and the code disagree once the code
> exists, the code wins and this file is the bug.

Today a municipality offers eight fixed request types (`RequestType`), each with a fee the manager sets
([municipal-requests-plan.md](municipal-requests-plan.md)). A new kind of paper needs a code change in two apps and a
migration. This plan lets the manager **define a form** — its questions and its fee — which a citizen fills in online and
a clerk fills in at the counter, producing the same request, the same bill and the same queue as today.

---

## 0. How to use this document

- **Stories run in order, one PR each**, and the migration is its own `chore/migration-NNNN` PR merged before the code
  that needs it ([CLAUDE.md](../CLAUDE.md#git), non-negotiable 5). The order is §7.
- **No code before §24 is answered and this plan is merged** (Stories 1 and 2 of the epic).
- **Never invent a name.** §1 is what exists; §3–§6 name what will, each marked _(proposal)_ until it is built.
- **Read first:** [CLAUDE.md](../CLAUDE.md), [municipal-requests-plan.md](municipal-requests-plan.md) (this builds on its
  decisions D1–D10, in [open-decisions.md §20](open-decisions.md#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13)),
  [database.md](database.md), [security.md](security.md), [ui-ux-standards.md](ui-ux-standards.md) (binding),
  [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md), [apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md) and
  [packages/shared-schemas/CLAUDE.md](../packages/shared-schemas/CLAUDE.md).

### Where this plan corrects the Jira stories

The stories were written before the code was read. Four statements in them do not match `develop@90cebdc`, and this plan
follows the code:

| Story text | What the code says | Consequence |
|---|---|---|
| `reporting.service.ts` "groups by `requestType`" | It does not group. It reads the request linked to a bill (`citizenRequest: { select: { id, requestNumber, requestType, status } }`, `reporting.service.ts:1407`) for the citizen's file and the portal. | A form's name must reach that view; nothing is regrouped. |
| Answers are "included in `BackupService`'s `TABLE_ORDER` deliberately" | **No request table is in `TABLE_ORDER`** (`citizen_requests`, `citizen_request_attachments`, `request_type_settings` are absent), and `0094` forbids `DELETE` on a request. | Putting the new tables in it would make every restore fail, exactly as docs/gotchas.md "The in-app backup cannot restore old debts" says. The plan keeps them **out** (§3.6, §9). |
| "as of 2026-11-21 `0109` is taken" | `0109`, `0110` and `0111` are taken (`feat/unit-types` and `chore/migration-0109`…`0111`). | The next free number is **`0112`**, claimed when the PR opens. |
| An applicant's capacity is a per-form setting (F6) | `citizen_requests.applicantCapacity` is `NOT NULL`. | The migration drops that `NOT NULL` (§3.4). |

---

## 1. What exists today (verified against `develop@90cebdc`, 2026-11-21)

### The tables (`0092_citizen_requests`, `0094_citizen_request_guard`; models in `tenant/schema.prisma`)

- **`request_type_settings`** (`RequestTypeSetting`): primary key `requestType`, `enabled`, `feeAmount`
  `DECIMAL(14,2)` with two CHECKs (`request_type_settings_fee_not_negative`, `_fee_whole_pounds`), `updatedAt`,
  `updatedById`. The manager's list (D1). No names: a type's words come from the labels in `shared-schemas`.
- **`citizen_requests`** (`CitizenRequest`): `requestNumber` («REQ-YYMM-NNNN»), `citizenId` (RESTRICT), `channel`,
  `requestType` **NOT NULL**, `applicantCapacity` **NOT NULL**, `status`, `propertyEntryId`, `buildingUnitId`,
  `citizenPaymentId` (unique), `purpose`, `statement`, `clearanceSnapshot`, `rejectionReason`, `clientRequestId`
  (unique, the retry key), `createdById`, and the stamps `paidAt`, `readyAt`/`readyById`, `completedAt`/`completedById`,
  `rejectedAt`/`rejectedById`, `cancelledAt`/`cancelledById`.
- **`citizen_request_attachments`** (`CitizenRequestAttachment`): `requestId`, `type` (`RequestAttachmentType`),
  `storagePath` (unique), `mimeType`, `sizeBytes`, `uploadedById`. Nothing links a paper to a *question*.
- **Enums:** `RequestType` (8: `CLEARANCE`, `RESIDENCY`, `OCCUPANCY`, `VACANCY`, `LEASE_REGISTRATION`, `RENOVATION`,
  `SIGNAGE`, `OTHER`), `ApplicantCapacity` (5), `RequestStatus` (6), `RequestChannel` (`ONLINE`, `COUNTER`),
  `RequestAttachmentType` (7: `IDENTITY`, `OWNERSHIP_PROOF`, `LEASE_CONTRACT`, `POWER_OF_ATTORNEY`, `INHERITANCE_PROOF`,
  `MUKHTAR_STATEMENT`, `OTHER`).
- **One open request** is the partial unique index `citizen_requests_one_open_key` over
  (`citizenId`, `requestType`, `COALESCE(propertyEntryId, nil uuid)`) where the status is `AWAITING_PAYMENT`,
  `IN_REVIEW` or `READY_FOR_PICKUP` (`0092`; `OPEN_REQUEST_STATUSES` in shared-schemas).
- **`guard_citizen_request()`** and its trigger `citizen_requests_guard` (`0094`) hold the request's life in the database:
  the allowed transitions, each step's stamps written by that step alone, the bill linked once, a flat only on the
  request's card, **"the number, channel, type, capacity, card, flat, purpose, retry key and filer never change"**, a
  closed request changes no more except `citizenId` (a «دمج ملفين»), and **`DELETE` is refused**. `0094` also dropped
  `citizen_requests_cancelled_without_bill` in favour of the guard.
- **No `CHECK` or trigger mentions a form**, and `scripts/db/destructive-sql.mjs` blocks `DROP TABLE`, `DROP COLUMN`,
  `ALTER … TYPE`, `RENAME`, `TRUNCATE` and `DELETE FROM`, and warns on `DROP CONSTRAINT` and on `UPDATE … SET`.

### The backend

- **`CitizenRequestsService`** (`application/features/citizen-requests/citizen-requests.service.ts`, **1,214 lines**; the
  neighbours are `cancelled-bill.ts` and `written-off-bill.ts`): `listTypes`, `offeredTypes`, `updateType` (the manager's
  fee list; audit `REQUEST_TYPE_UPDATED`), `submit` → `submitInTransaction` (advisory lock on the retry key; `replay`;
  citizen exists, not merged away; the type is enabled; `requestNeedsProperty` and `assertOwnCard`; the one-open check
  and its `P2002` twin; the status is `AWAITING_PAYMENT` when the fee is above 0, else `IN_REVIEW`; the «REQ-» number;
  the audit row `REQUEST_SUBMITTED` with ids, numbers and enums only — `purpose` is kept out), `queue`, `get`, `mine`,
  `mineOne`, `raiseBill`, `onPaymentReviewed` / `onPaymentReversed` → `reconcile`, `approve`, `reject`, `complete`,
  `cancel`, `addAttachment`, `attachmentUrl`.
- **The fee** is read from `request_type_settings` by `currentFee(type)` (and `feesByType` for lists), both keyed on
  `requestType`. A request shows a fee only while it waits for its bill.
- **`raiseBill`** refuses with `REQUEST_IDENTITY_COPY_REQUIRED` for an `ONLINE` request with no attachment of type
  `IDENTITY`, and with `ONLINE_PAYMENT_UNAVAILABLE` while online payment is paused (open-decisions §21); the bill is made
  by `raiseOneOffBill` (`fees/one-off-bill.ts`).
- **`approve`** runs the براءة ذمة dues check for `CLEARANCE` through `ParcelDuesService` and keeps it in
  `clearanceSnapshot` (D3).
- **`addAttachment`**: the bytes are typed by `sniffAttachment` (`application/common/file-sniff.ts`: JPEG, PNG, WebP, PDF),
  written through the port **`REQUEST_FILE_STORAGE`** (`domain/interfaces/request-file-storage.interface.ts`: `put`,
  `createSignedUrl`, `remove`) *before* the row, and removed if the row cannot be recorded; at most
  `REQUEST_ATTACHMENTS_MAX` (10) a request; a closed request takes none. `attachmentUrl` returns a five-minute signed URL
  and writes `REQUEST_ATTACHMENT_VIEWED`.
- **`CitizenRequestsController`** (`presentation/controllers/citizen-requests.controller.ts`, `t/:tenantSlug/requests`):
  the citizen's own routes have no `@Roles` and check `user.kind` (`asCitizen`) — `GET mine`, `GET mine/types`,
  `POST mine`, `GET mine/:id`, `POST mine/:id/attachments`, `POST mine/:id/bill`, `POST mine/:id/cancel`. Staff:
  `GET` and `GET :id` and `GET types` and `GET :id/attachments/:attachmentId/url` for `REQUEST_READ_ROLES`;
  `PUT types/:type` for `REQUEST_SETTINGS_ROLES`; `POST` (the counter), `:id/approve`, `:id/reject`, `:id/complete`,
  `:id/cancel`, `:id/attachments` for `REQUEST_HANDLE_ROLES`; `POST :id/bill` for `REQUEST_BILL_ROLES`. The upload
  interceptor is `FileInterceptor('file', { limits: { fileSize: REQUEST_ATTACHMENT_MAX_BYTES, files: 1, fields: 2,
  parts: 3 } })`. Every handler is pinned in `route-inventory.spec.ts`.
- **Role sets** (`packages/shared-schemas/src/role-sets.ts`): `REQUEST_READ_ROLES` = `SUPER_ADMIN`,
  `ADMINISTRATIVE_OFFICER`, `ACCOUNTANT`, `AUDITOR`; `REQUEST_HANDLE_ROLES` = `SUPER_ADMIN`, `ADMINISTRATIVE_OFFICER`;
  `REQUEST_BILL_ROLES`; `REQUEST_SETTINGS_ROLES` = `SUPER_ADMIN`.
- **Readers of a request or its type outside the service:** `citizen-merge.service.ts` (moves a person's requests;
  its open-collision key is `` `${requestType}:${propertyEntryId ?? ''}` `` at line 984 and 985), `citizens.service.ts`
  and `landlord-link.service.ts` (refuse deleting a card or a flat a request names: `PROPERTY_NAMED_BY_REQUEST`,
  `HAS_REQUESTS`), `fees.service.ts` (`cancelBill` and the write-off settle the waiting request), and
  `reporting.service.ts` (the request on a bill, see §0).

### The contract (`packages/shared-schemas/src/citizen-request.schema.ts`)

`REQUEST_TYPES_ON_PROPERTY` (six of the eight types) and `requestNeedsProperty`; `OPEN_REQUEST_STATUSES`;
`REQUEST_ATTACHMENT_MAX_BYTES` (5 MiB), `REQUEST_ATTACHMENTS_MAX` (10), `REQUEST_ATTACHMENT_MIME_TYPES`;
`submitOnlineRequestSchema` and `submitCounterRequestSchema` (both built on `requestFields` and `requestShape`),
`approveRequestSchema`, `rejectRequestSchema`, `updateRequestTypeSettingSchema`, `uploadRequestAttachmentSchema`
(`{ type }`), `listRequestsQuerySchema`; the views `RequestTypeSettingView`, `CitizenRequestView`, `MyCitizenRequestView`,
`CitizenRequestListItem`, `SubmitRequestResult` and the rest; the `REQUEST` book in `DOCUMENT_PREFIX`; and 17 `REQUEST_*`
error codes in `error-codes.ts`.

### The frontend

- **The portal wizard** `app/[tenant]/[locale]/(citizen)/my-file/requests/new/page.tsx` (668 lines): four steps
  (`STEPS = ['type', 'property', 'papers', 'review']`, the step in `?step=`), what was chosen kept in memory, photos shrunk
  by `compressPaper`, papers picked with `FileInput` and checked by `attachmentProblem`; the request's own page is
  `my-file/requests/[requestId]/page.tsx`; «طلباتي» is `components/citizen/my-requests.tsx`.
- **The counter** `components/admin/requests/counter-request-form.tsx` (768 lines; page `requests/new`), its retry key
  held under `request:new` (`lib/request-id.ts`), the same `FileInput` and `attachmentProblem`.
- **The staff queue** `requests/page.tsx`, the panel `components/admin/requests/request-sheet.tsx`, its dialogs
  `request-dialogs.tsx`, **the types screen** `requests/types/page.tsx` (the manager's fee list), **the paper**
  `requests/[requestId]/print` with `request-document.tsx` (letterhead and signature blocks from
  `components/admin/finance/official-document.tsx`), and the calls in `lib/requests-api.ts`.
- **One nav row**, `/requests`, in `components/admin/nav.ts`. Every one of these reads `requestType`, which is why §6
  treats the readers as a list to update, not a detail.

### What touches requests outside the app

- **`BackupService`'s `TABLE_ORDER`** (`application/features/backup/backup.service.ts`) holds no request table; its
  comments and docs/gotchas.md explain why an append-only or RESTRICT-keyed table cannot be restored by its
  empty-and-rewrite. `BackupController` is unregistered.
- **`scripts/db/setup-claude-ro.sql`** revokes everything, then grants explicit `readonly_claude.*` views; no request
  table has one, so a new table is unreadable to that role until someone adds a view.
- **Local reset tooling** names the request tables: `scripts/db/delete-local-citizens-and-buildings.mjs` deletes
  `citizen_request_attachments` then `citizen_requests` (with the user triggers disabled), and
  `scripts/db/reset-local-money.mjs` unlinks `citizenPaymentId`. A new table holding citizen answers must join the first,
  or a local reset leaves PII behind or fails on a foreign key.

---

## 2. Decisions needed before building (Story 1)

Tracked in [open-decisions.md §24](open-decisions.md#24-request-form-builder-what-the-owner-must-decide-2026-11-21),
where each carries its options, its recommendation, and who decided and when. **F1–F12 are all decided** (Abed, 2026-11-21; Hashem's sign-off pending): the built-in types become system forms; published forms are versioned; every field is required and a linked field the file cannot fill blocks the request; a fixed field catalogue; the manager alone builds; property mode and capacity per form; a form with requests is archived, never deleted; staff read as `REQUEST_READ_ROLES` and the portal shows a citizen their own answers with identity numbers masked; an optional statement template; Arabic required and English optional; one open request per citizen, form and card; every online request carries an identity copy. Two parts wait on others: F8's retention on §1, F9's wording on the municipality. The table keeps each
question and what it blocks; the recommendation each design below assumes is the one in §24.

| # | Question | Why it matters | Blocks |
|---|---|---|---|
| F1 | The 8 built-in types: forms too, or beside custom forms | One model or two for ever; a backfill that rewrites live rows | Story 3 (a system kind?), Story 9 |
| F2 | Editing a form that already has requests | Versions or not: whether an answer can be orphaned | Stories 3, 5, 6 |
| F3 | Field types and their validation | The catalogue is the shared validator; no pattern typed by the admin | Stories 4, 7 |
| F4 | Fields already on the citizen's file | Linked and copied, or typed again; what an empty `motherName` does | Stories 4, 6, 8 |
| F5 | Who builds, per municipality or shared | A role set is API; a library needs a schema outside the tenants | Story 5 |
| F6 | Property card and applicant capacity | `applicantCapacity` is `NOT NULL` today; the dues check needs a card | Stories 3, 6 |
| F7 | Disabling and deleting | The forms' guard; the reason a request keeps a readable form | Stories 3, 5 |
| F8 | Who sees the answers, how long they are kept | Answers are PII; sign-in is the رقم مرجعي alone; retention waits on §1 | Stories 6, 8 |
| F9 | The printed paper | A legal statement; wording is the municipality's | Story 8 |
| F10 | Languages | Columns on a form and a field; non-negotiable 9 | Stories 3, 7, 8 |
| F11 | One open request per citizen and form | The existing index keys on `requestType` (§3.4) | Stories 3, 6 |
| F12 | The identity copy on an online request | The server's check (`REQUEST_IDENTITY_COPY_REQUIRED`) must not depend on the form | Stories 6, 8 |

---

## 3. Data model (Proposal)

One table per concept, not one JSON blob of everything. Every name below is _(proposal)_. All of it is tenant-schema,
hand-written SQL, idempotent, with `CURRENT_SCHEMA` guards ([database.md](database.md#migrations)).

### 3.1 Enums _(proposal)_

- `RequestFieldType`: `SHORT_TEXT`, `LONG_TEXT`, `INTEGER`, `DECIMAL`, `DATE`, `PHONE`, `DOCUMENT_NUMBER`,
  `SINGLE_CHOICE`, `MULTI_CHOICE`, `YES_NO`, `FILE` (F3).
- `RequestPropertyMode`: `NONE`, `OPTIONAL`, `REQUIRED` (F6).
- `RequestFormVersionStatus`: `DRAFT`, `PUBLISHED` (F2).
- `RequestLinkedSource`: `FIRST_NAME`, `FATHER_NAME`, `LAST_NAME`, `MOTHER_NAME`, `PHONE`, `IDENTITY_NUMBER`,
  `CIVIL_RECORD_NUMBER` (F4). **Never** a رقم مرجعي.
- `RequestAnswerOrigin`: `ANSWERED`, `FROM_FILE` (F4: a linked field is copied from the citizen's file; staff see which answers came from it).

Enum values ship in their own migration, alone, before anything uses them
([database.md](database.md#how-tenant-migrations-run)), as `0107` did for old debts. That makes **two** migrations for
the expand step: values (`0112`), then tables and columns (`0113`) — **decided and built that way** — and a third, `0114`, for the
backfill of system forms (§3.8 step 2).

### 3.2 `request_forms` _(proposal)_

| Column | Notes |
|---|---|
| `id` | uuid |
| `nameAr` required, `nameEn` nullable | F10: Arabic required, English optional with the screen falling back to Arabic; CHECK not blank |
| `feeAmount` | whole LBP, the **same two CHECKs** as `request_type_settings` (not negative, whole pounds). Not versioned (F2): the fee in force when the bill is raised (D1) |
| `enabled` | default false: a new form is offered only once the manager switches it on |
| `propertyMode` | `RequestPropertyMode`, default `NONE` (F6) |
| `askCapacity`, `askPurpose` | booleans, default false (F6). A system form sets `askPurpose` so `purpose` is asked as today |
| `statementTemplate` | text, nullable (F9). A draft for the clerk, never the certificate |
| `systemType` | `RequestType`, nullable, **unique** — set only on a system form (F1), keyed by the legacy type, never by name. Special rules (§4.4) key on it |
| `sortOrder` | int |
| `archivedAt`, `archivedById` | set together (CHECK); archived is never offered (F7) |
| `currentVersionId` | the published version new requests fill; nullable until the first publish |
| `createdById`, `createdAt`, `updatedById`, `updatedAt` | RESTRICT keys to `users` |

### 3.3 `request_form_versions` and `request_form_fields` _(proposal)_

- **`request_form_versions`**: `id`, `formId` (RESTRICT), `versionNumber` (unique with `formId`), `status`, `revision`
  (an integer the draft's saves compare, for concurrent edits), `publishedAt`/`publishedById` (set together, only when
  `PUBLISHED`). **At most one `DRAFT` per form** (partial unique index). A unique `(formId, id)` lets a request point at
  a version of *its* form with one composite foreign key.
- **`request_form_fields`**: `id`, `versionId` (RESTRICT), `key` (a stable, lower-snake identifier, **the same across
  versions** so an answer can be followed; CHECK against a fixed pattern; unique with `versionId`), `position`, `type`,
  `labelAr`/`labelEn`, `helpAr`/`helpEn`, `config` (JSONB, **always validated by a shared zod schema per
  type**, §4.1), `linkedSource` (nullable; CHECK that only a text-like type may carry one). **There is no `required` column: every field is required (F4, decided).**
- Bounds, enforced by the shared schema and again by CHECK where cheap: at most 40 fields a version, 50 choices a field,
  labels and choices at most 200 characters, help text at most 500. Proposed numbers; the builder shows them.

### 3.4 What changes on `citizen_requests` _(proposal, expand only)_

| Change | Why |
|---|---|
| `formId` uuid NULL, `formVersionId` uuid NULL, **both set together** (CHECK), composite foreign key `(formId, formVersionId)` → `request_form_versions (formId, id)`, RESTRICT | A request is tied to the version it was filled against (F2). Null on every legacy request until Story 9 |
| `applicantCapacity` **drops `NOT NULL`** | F6: a form may not ask. Old code always writes it, so the relaxation is safe in the order migration-then-code |
| the open-request index replaced (below) | F11: custom forms need their own key |

**What a custom form's `requestType` is.** It stays `NOT NULL`. A request on a custom form stores `OTHER` beside its
`formId`, and every reader shows the form's name when `formId` is set. That keeps every reader of `requestType`
(§1) compiling and working before any is changed, at the price that `OTHER` means two things (the legacy «طلب عام» and
"a custom form") until the contract step. The alternative — making `requestType` nullable — touches every reader at
once and is rejected for the first release.

**The one-open index.** `citizen_requests_one_open_key` keys on `requestType`, so two different custom forms (both
`OTHER`) would block each other and collide with «طلب عام». The new migration drops it and recreates it with
`AND "formId" IS NULL` (identical for every existing row, since all have a null `formId`), and adds a second partial
unique index over (`citizenId`, `formId`, `COALESCE(propertyEntryId, nil uuid)`) `WHERE "formId" IS NOT NULL` and the
same open statuses. `DROP INDEX` is not on the destructive scanner's list; the swap runs in one transaction, and the
migration PR confirms with `pnpm db:status:local`.

**The guard.** `0094` is not edited. The new migration `CREATE OR REPLACE`s `guard_citizen_request()` with 0094's body
plus: `formId` and `formVersionId` **never change once set**, except **NULL → a value once, in any status** (Story 9's
backfill must be able to link a completed request, which the guard otherwise refuses to touch); on `INSERT` the version
must be `PUBLISHED` and belong to the form. Whether the form is *enabled* is the service's check, not the database's:
it changes without a request being written.

### 3.5 Answers _(proposal)_: rows, not a JSONB column

The two designs, compared as the story asks:

| | **Rows** — `citizen_request_answers` | **JSONB** — `citizen_requests.answers` |
|---|---|---|
| Orphaned answer | Impossible: a foreign key to the field, which belongs to the request's version | Possible: keys are matched to fields by convention only |
| Audit and PII handling | An answer is a row: a per-type mask on read, a future per-row redaction or erasure (retention is open, §1) without rewriting a blob | One blob mixing a name with an identity number; redaction means rewriting a frozen request |
| The guard | A new "written once" trigger on the answers table; `citizen_requests_guard` barely changes | The request guard must freeze one more column, and a frozen request cannot be redacted |
| Reading a request | A second query, ordered by the version's field order | One column, no join |
| Querying ("every request that answered X") | Indexed on `(fieldId, …)` if ever needed | Needs expression or GIN indexes |
| Writing | `createMany` in the submit transaction | One column of the same insert |
| Backup / read-only role | Not in `TABLE_ORDER` for the §3.6 reason; not exposed to `claude_ro` by default | The same, but riding on a table whose rules are already subtle |

**Chosen: rows.** The decisive reasons are the foreign key (no orphan, by construction), per-field masking by type, and
that retention is an open legal question whose answer is easier to apply to rows. Its cost, a second query, is small.

**`citizen_request_answers` _(proposal)_:** `id`, `requestId` (RESTRICT), `fieldId` (RESTRICT; unique with `requestId`),
`value` JSONB **NOT NULL** (a typed scalar or array, shaped by the field's type and validated by the shared builder —
text, a number as a JSON number, a date as `YYYY-MM-DD`, a choice's stored **key** never its label, `true`/`false`, an
array of keys), `origin` `RequestAnswerOrigin`, `createdAt`. **Written once**: no `UPDATE`, no `DELETE`, and the
`0103` `TRUNCATE` guard, as `payment_transactions` and the old-debts tables have. That matches the request itself, whose
content never changes after filing; a correction is "cancel and file again" (D10).

**File answers** are not rows here. `citizen_request_attachments` gets `fieldId uuid NULL` (RESTRICT) _(proposal)_: a paper
filed for a question points at it. `type` stays `RequestAttachmentType` (a file field carries the type its papers are,
which is how F12's `IDENTITY` check stays true).

### 3.6 What the new tables do **not** do

- **Not in `BackupService`'s `TABLE_ORDER`.** See §0. The request tables are not there today; adding forms, versions,
  fields or answers would make a restore fail the same way the old-debts tables would, because `0094` refuses to delete a
  request and the answers key onto `users` with RESTRICT. Whether a restore means anything for an append-only record is a
  decision for a person (docs/gotchas.md). Story 3's PR adds the gotcha row for forms, as old debts did.
- **Not exposed to the read-only role.** No `readonly_claude` view is created for them (§9).
- **Not edited in place when published.** §3.7.

### 3.7 The forms' own guards _(proposal)_

- `request_form_versions`: `UPDATE` only `DRAFT → PUBLISHED`, once, writing the publish stamps; a `PUBLISHED` row never
  changes again; no `DELETE` of a published version; at most one draft.
- `request_form_fields`: no `INSERT`, `UPDATE` or `DELETE` when the field's version is `PUBLISHED`.
- `request_forms`: no `DELETE` of a form any request points at (the `RESTRICT` key already refuses; the trigger gives it a
  coded message); `systemType` never changes; a form with `archivedAt` is never offered (a service check).
- All guards are exercised against a real Postgres: both **allow** and **refuse** (§8).

### 3.8 Expand, backfill, contract

1. **Expand** (Story 3, `0112`/`0113`): everything above, additive. The code that needs it merges after.
2. **Backfill** (Story 9, a later migration PR): one system form per `RequestType` per tenant, its fee and `enabled`
   copied from `request_type_settings`, each existing request linked (`formId`, `formVersionId`: the guard's one-time
   NULL → value), counts asserted, rehearsed on a local replica with synthetic data and then staging. `UPDATE … SET` raises
   the scanner's warning, which is the point: it only fills new columns.
3. **Contract** (each its own later release, through the manual workflow, never `--allow-destructive` to get past an
   error): stop reading `request_type_settings` once every fee comes from a form, then drop it; `formId` `NOT NULL` once
   every request has one. Neither happens in this epic.

Until the backfill, **a fee has two sources**: a request with a `formId` reads its form, any other reads its type's row.
One function, `feeFor(request)`, decides, so no caller chooses.

---

## 4. Validation design

### 4.1 One validator, both apps

A pure function in `packages/shared-schemas` _(proposal names)_: `buildAnswersSchema(fields)` returns a zod schema for an
object keyed by field `key`; `fieldAnswerSchema(field)` is its per-field building block (one builder per
`RequestFieldType`, each reading its own validated `config`); `fileFieldKeys(fields)` lists the file fields (every one required) the
body does not carry. Rules of the catalogue:

- **Every field is required** (F4, decided): present and non-blank; a yes/no is answered, a multiple choice has at least one choice, a file field has at least one paper. Text: bounded length. Numbers: a finite number within the configured range,
  decimals to the configured places. Date: a real calendar day (`isCalendarDay`) within an optional range. Phone and
  document number reuse the existing primitives (`internationalPhone`, `documentNumber`) rather than restating them
  ([packages/shared-schemas/CLAUDE.md](../packages/shared-schemas/CLAUDE.md#rules)). Choices: every value must be one of
  the field's keys; multiple choice is a de-duplicated array within `min`/`max`. Yes/no: a boolean.
- **No admin-typed pattern**, ever (F3): nothing in `config` is compiled as a regular expression, so no form can hang the
  server or lock out a citizen. Every bound is a number the schema caps.
- A **linked field** (F4) is not validated as typed text: the server resolves it from the citizen's file (§4.3).

The frontend's renderer builds the same schema for the screen's errors; the backend builds it again from the stored
version, because a static `ZodValidationPipe` cannot know the form. The two must never disagree, so there is one function
and one test file for it (§8).

### 4.2 How the server refuses

Inside the submit transaction, after loading the version: `parseAnswers(fields, body)` returns the answers or a **per-field
issue list**. A failure throws a `ValidationError` with a new code (_(proposal)_ `REQUEST_ANSWERS_INVALID`) and
`details: { issues: [{ fieldKey, code, params }] }`, the way `ARREARS_LINE_REFUSED` carries `details.issues`. The screen
puts each issue under its field; the words are the frontend's, by code (`errors.*`, TXT-6). No issue carries the value that
failed: an answer is PII and an error is logged.

### 4.3 Linked fields (F4)

At submission the service reads the citizen's file once and fills each linked field from its source column
(`firstName`, `middleName`, `lastName`, `motherName`, `phone`, `identityDocNumber`, `civilRecordNumber`), writing the answer
with `origin = FROM_FILE`. **The client's value for a linked field is ignored**, never trusted: a citizen cannot make a
form say a different name than the file. When the file has no value (`motherName` is NULL before `0044` and on non-resident owners; `phone` can be NULL with `hasNoPhone`; the numbers are
nullable) **the request is refused** (F4, decided): the service throws `REQUEST_FORM_LINKED_FIELD_EMPTY` with `details.fieldKeys` (never a value), and the
request is filed only after a clerk completes the file through the file's own review. Nothing is typed on the request in its place and nothing
is written back. The portal says so *before* the citizen starts, from the prefill read (§5). A merge of two files moves a request with its answers as they are: they are a snapshot.

### 4.4 What a system form keeps

A system form (F1, Story 9) keeps today's rules, keyed on `systemType`, never on its name: `CLEARANCE`'s dues check at
approval, `REQUEST_TYPES_ON_PROPERTY` as its `propertyMode`, and `purpose`. One function, `systemRulesOf(form)`
_(proposal)_, is the only place that reads `systemType`.

### 4.5 The identity copy (F12)

`raiseBill`'s check stays as it is, for every `ONLINE` request whatever its form. The builder tells the manager when a
form has no `IDENTITY` file field, and the portal adds the standard identity step to any form that lacks the field.

---

## 5. API contract (Proposal)

Routes and role sets, every one pinned in `route-inventory.spec.ts`; ids go through `UuidPipe`, bodies through a shared
schema, no `@Param('tenantSlug')` ([apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#conventions)).

### Staff: the forms (a new controller, `t/:tenantSlug/request-forms`)

| Route | Roles | Body / answer |
|---|---|---|
| `GET request-forms` | `REQUEST_READ_ROLES` | the list: name, fee, enabled, fields, requests, archived |
| `GET request-forms/:id` | `REQUEST_READ_ROLES` | the form, its draft and its published version |
| `POST request-forms` | `REQUEST_SETTINGS_ROLES` | `createRequestFormSchema` (settings only) |
| `PUT request-forms/:id` | `REQUEST_SETTINGS_ROLES` | `updateRequestFormSchema`: name, fee, `propertyMode`, `askCapacity`, `askPurpose`, template |
| `PUT request-forms/:id/draft` | `REQUEST_SETTINGS_ROLES` | `saveRequestFormDraftSchema`: the fields, and `expectedRevision` (a stale one is `REQUEST_FORM_EDIT_CONFLICT`) |
| `POST request-forms/:id/publish` | `REQUEST_SETTINGS_ROLES` | no body; refuses a draft that fails `formPublishIssues` |
| `POST request-forms/:id/enable` and `/disable` and `/archive` | `REQUEST_SETTINGS_ROLES` | no body |
| `DELETE request-forms/:id` | `REQUEST_SETTINGS_ROLES` | refused when any request exists (F7) |

### The citizen: `requests/mine/…` (no `@Roles`, `asCitizen`)

| Route | Change |
|---|---|
| `GET requests/mine/forms` _(new)_ | the enabled forms with their published fields, the file's values for the linked ones (the citizen's own, never another's) and which linked fields the file cannot fill |
| `POST requests/mine` | the body gains `formId` and `answers`; exactly one of `requestType` and `formId` |
| `POST requests/mine/:id/attachments` | gains an optional `fieldKey`; the interceptor's limits rise from `fields: 2, parts: 3` to `fields: 3, parts: 4` |
| `GET requests/mine/:id` | the view gains the form's name and the citizen's own answers, **text only, identity and civil numbers masked** (F8), never a file |

### The counter and the reads (`requests/…`)

| Route | Roles | Change |
|---|---|---|
| `GET requests/forms` _(new)_ | `REQUEST_HANDLE_ROLES` | the enabled forms |
| `GET requests/forms/:formId/prefill` _(new)_ | `REQUEST_HANDLE_ROLES` | the chosen citizen's linked values (`?citizenId=`, validated) |
| `POST requests` | `REQUEST_HANDLE_ROLES` | as the citizen's: `formId` + `answers` |
| `POST requests/:id/attachments` | `REQUEST_HANDLE_ROLES` | gains `fieldKey` |
| `GET requests/:id` | `REQUEST_READ_ROLES` | gains the form, its version and every answer with its `origin` |
| `GET requests/:id/attachments/:attachmentId/url` | `REQUEST_READ_ROLES` | unchanged: the five-minute signed URL, audited |

### Error codes _(proposal)_

`REQUEST_FORM_NOT_FOUND`, `REQUEST_FORM_NOT_OFFERED` (disabled or archived), `REQUEST_FORM_VERSION_STALE` (the client
filled an older version), `REQUEST_ANSWERS_INVALID` (§4.2), `REQUEST_FORM_FILE_REQUIRED` (a required file field has no
paper when the fee is raised), `REQUEST_FORM_LINKED_FIELD_EMPTY` (a linked field the citizen's file cannot fill, §4.3), `REQUEST_FORM_EDIT_CONFLICT`, `REQUEST_FORM_NOT_PUBLISHABLE` (`details.issues`),
`REQUEST_FORM_HAS_REQUESTS`, `REQUEST_FORM_FIELD_KEY_TAKEN`. Each needs `errors.<CODE>` in both message files
([packages/shared-schemas/CLAUDE.md](../packages/shared-schemas/CLAUDE.md#add-an-error-code)).

### Audit

Tier 1, inside the transaction, ids and counts only: a form created, edited, its draft saved, published, enabled,
disabled, archived, deleted; a request submitted with answers (the existing `REQUEST_SUBMITTED` row gains `formId` and
`formVersionId`, **never an answer**, as `purpose` is kept out today). Each action's label goes in `auditActions` in both
message files.

---

## 6. Layering and file plan

Dependencies point inward, data access goes through `TenantContextService`, multi-step writes through
`runInTenantTransaction` ([apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#layers-and-the-dependency-rule)).
**`CitizenRequestsService` is 1,214 lines and must not grow:** it only *delegates*, a few lines per call site, and a call
site that needs more moves its logic out first.

### New

| Layer | File _(proposal)_ | Holds |
|---|---|---|
| shared | `packages/shared-schemas/src/request-form.schema.ts` | the form, version and field schemas and their views; the per-type `config` schemas; the create, update, save-draft and publish inputs |
| shared | `packages/shared-schemas/src/request-form-answers.ts` | `buildAnswersSchema`, `fieldAnswerSchema`, `fileFieldKeys`, `formPublishIssues` — **pure, no I/O**, run by both apps |
| shared | `enums.ts`, `labels.ts` (both locales), `error-codes.ts`, `index.ts` | §3.1's enums and labels, §5's codes |
| backend | `application/features/request-forms/request-form.plan.ts` (+ spec) | pure: what publishing needs, the version diff, archive and delete rules |
| backend | `application/features/request-forms/request-forms.service.ts` | the manager's CRUD, one transaction a write, the audit row inside it, the draft's `revision` check |
| backend | `application/features/request-forms/request-answers.plan.ts` (+ spec) | pure: linked-field resolution and `origin` (§4.3) |
| backend | `application/features/request-forms/request-answers.service.ts` | validates in the caller's transaction, snapshots linked fields, writes the answer rows; what `CitizenRequestsService` calls |
| backend | `presentation/controllers/request-forms.controller.ts` | §5's staff routes |
| backend | `infrastructure/prisma/tenant/migrations/0112…`, `schema.prisma` models | §3 |
| frontend | `components/request-forms/form-renderer.tsx` | **the one renderer**: a type → primitive map (`Input`, `Textarea`, `DatePicker`, `Select`, `Checkbox`, `SegmentedControl`, `FileInput`, `Field`), used by the portal, the counter and the builder's preview |
| frontend | `components/admin/request-forms/*`, pages `requests/forms` and `requests/forms/[formId]` | the builder |
| frontend | `lib/request-forms-api.ts`, `lib/request-form-draft.ts` | the calls; the builder's pure state (add, reorder, remove, validate) |

### Changed

| File | Change |
|---|---|
| `citizen-requests.service.ts` | delegates `submit` (answers, the form's enabled and version check), the fee (`feeFor`), the identity and required-file checks in `raiseBill`; `replay` compares the answers too |
| `citizen-requests.controller.ts` | the extended bodies, `fieldKey` on uploads, the interceptor limits, the new `mine/forms` and counter routes |
| `citizen-requests.schema.ts` | `submitOnlineRequestSchema` and `submitCounterRequestSchema` accept `formId` + `answers`; the views gain the form and answers |
| `citizen-merge.service.ts` | the open-collision key at line 984–985 becomes `` `${formId ?? requestType}:${propertyEntryId ?? ''}` `` |
| `reporting.service.ts` | the request on a bill carries its form's name |
| `request-sheet.tsx`, `request-document.tsx`, `my-requests.tsx`, the portal wizard, `counter-request-form.tsx` | show and take the answers; `request-document.tsx` may start the statement from the template (F9) |
| `route-inventory.spec.ts`, `cross-tenant-routes.spec.ts` | the new routes |
| `scripts/db/delete-local-citizens-and-buildings.mjs` | deletes the answers, versions and forms before the requests and the people |
| `CLAUDE.md`, `apps/backend/CLAUDE.md`, `apps/frontend/CLAUDE.md`, `packages/shared-schemas/CLAUDE.md`, `docs/database.md`, `docs/security.md`, `docs/gotchas.md`, `docs/municipal-requests-plan.md` | per [Keeping the docs true](../CLAUDE.md#keeping-the-docs-true), each with its "Last verified" line |

**No new domain port.** Files reuse `REQUEST_FILE_STORAGE` and `sniffAttachment`; no outside system appears.

---

## 7. PR order

One PR per phase, each from `develop`, each merged before the next opens
([CLAUDE.md](../CLAUDE.md#git)).

| # | Branch _(proposal)_ | Story | Ships |
|---|---|---|---|
| 0 | `docs/request-forms-decisions` | 1 | open-decisions §24 |
| 0 | `docs/request-forms-plan` | 2 | this document, and its rows in CLAUDE.md |
| 1 | `chore/migration-0112` | 3 | the migration(s) and `schema.prisma`. **Claim the number when the PR opens**: as of 2026-11-21 `0109`–`0111` are taken on the unit-types branches, so check every branch ([gotchas](gotchas.md#migration-numbers-collide-across-branches)) |
| 2 | `feat/request-forms-contract` | 4 | shared schemas, the answers validator, enums, labels, error codes; `dist/` rebuilt |
| 3 | `feat/request-forms-admin-api` | 5 | the manager's routes and service |
| 4 | `feat/request-forms-submit` | 6 | citizens and clerks submit against a form |
| 5 | `feat/request-forms-builder` | 7 | the admin screen |
| 6 | `feat/request-forms-fill` | 8 | the portal, the counter, the staff panel and the print page |
| 7 | `chore/migration-NNNN` then `feat/request-forms-system` | 9 | the backfill (only if F1 says so), then the code |
| 8 | `docs/request-forms-release` | 10 | docs, staging end-to-end, release: the migration PR to `main` first and verified on production, then the code |

Pushing to `main` migrates production, so every migration merged to `main` is additive and ships in its own PR ahead of
the code that needs it (non-negotiable 5). A release is a PR from `develop` to `main` with one human approval.

---

## 8. Test plan

Every phase adds tests that **fail only for the right reason** ([code-quality.md](code-quality.md#rules), rule 12), and
runs the repository's definition of done ([CLAUDE.md](../CLAUDE.md#definition-of-done)).

- **Unit (pure rules):** `request-form.plan.spec.ts`, `request-answers.plan.spec.ts`, and the answers validator with a
  test for **every field type** — a blank, bounds, a choice not in the list, a date that does not exist, an array with
  a duplicate, a blank, a value of the wrong JSON type — and for the renderer's type → primitive map.
- **Integration, on a throwaway Postgres 17** (`TEST_DATABASE_URL`, never `municipality_db_local`; the commands are in
  [database.md](database.md#test-a-migration-on-a-throwaway-postgres-17)):
  the forms' lifecycle (create, draft, publish, enable, disable, archive, delete refused with requests);
  **the guards both ways** (`citizen_requests_guard` still allows every transition `0094` allows and now refuses a changed
  `formId`, allows the one-time NULL → value; the versions' and fields' immutability; the answers' written-once);
  the **race on "one open request"** per citizen and form, and across two different forms; the **replay of
  `clientRequestId`**, same answers answered again and different answers refused (`REQUEST_KEY_REUSED`); invalid answers
  (`details.issues`); a disabled and an archived form; a stale version; a linked field and its empty-file case; a free
  form; the payment hook and `reconcile`; **a citizen merge** carrying a request with answers and its undo; the
  identity-copy and required-file checks in `raiseBill`; a re-run of the migration is a no-op; `0112` on a database that
  already has requests.
- **`route-inventory.spec.ts`** pins every new handler to its role set; **`cross-tenant-routes.spec.ts`** shows another
  municipality's token refused on every new route; the existing request suites stay green.
- **Rendered UI** ([ui-ux-standards.md](ui-ux-standards.md) §16.4): the builder, the portal wizard, the counter and the
  staff panel against a **mocked API with synthetic people only**, at 360 and 1440 px, light and dark, `ar` and `en`,
  with long labels, an empty form, a refusal under a field, and the keyboard alone. Not committed; cleaned up after.
- **Frontend:** `lib` tests for the draft state, the CSV-free pieces, and a message-parity run
  (`messages-parity.test.ts` fails when a key is in one locale only).

---

## 9. Security and privacy

- **Answers are citizen PII.** A name, a phone, an identity number, a mother's name. They are never logged, never sent
  to Sentry (`sentry-redaction` keeps working only if no answer reaches an error's `params`: an issue carries the field's
  key and a code, never the value), and never in an audit row (ids and counts only, as `purpose` is kept out of
  `REQUEST_SUBMITTED` today).
- **Who reads them:** `REQUEST_READ_ROLES` for the staff view, never «مشاهد فقط» (D6). The citizen sees their own text
  answers with identity and civil numbers masked, because sign-in is the رقم مرجعي alone
  ([open-decisions.md §21](open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)) and
  the reference is a credential (non-negotiable 7). Files go only through the five-minute signed URL, each use audited,
  and never back to the portal.
- **The read-only role:** `scripts/db/setup-claude-ro.sql` revokes everything and grants explicit views, so a new table
  is unreadable until someone adds a view. **None is added**, and `scripts/db/verify-claude-ro.sql` gains a check that
  the new tables stay unreadable.
- **The backup:** out of `TABLE_ORDER`, deliberately (§3.6), with the gotcha written down.
- **Uploads** keep the rule ([security.md](security.md)): the size capped in the interceptor, the type read from the
  bytes (`sniffAttachment`), the key under the tenant; a file field never widens the accepted kinds or the 10-file cap.
- **Admin-entered text is text.** Labels, help, choices and the statement template are rendered as text and printed as
  plain text, never as HTML or Markdown; the template's placeholders are plain substitution of an answer, with no logic
  and no way to print a رقم مرجعي.
- **Local data:** the local reset script that deletes citizens must delete the answers first (§6); citizen data never
  leaves staging or production (non-negotiable 4), so every test uses synthetic people.
- **Retention** follows [open-decisions.md §1](open-decisions.md), still unanswered: nothing is deleted, as for the
  papers (D6).

---

## 10. Definition of done (every phase)

- `pnpm typecheck` and `pnpm lint` pass; the tests of every package touched pass against the same baseline, and
  `packages/shared-schemas` is rebuilt before its consumers.
- A migration was applied with `pnpm db:deploy:local` and its integration suites ran on a throwaway Postgres 17.
- A UI change meets the pre-merge checklist ([ui-ux-standards.md](ui-ux-standards.md) §16).
- Docs are updated per [Keeping the docs true](../CLAUDE.md#keeping-the-docs-true) and their "Last verified" lines bumped.
- The report says what ran, what failed and what was skipped.

---

## 11. What was built (2026-11-22)

Stories 3 to 10 were built in one sitting as **stacked branches, each pushed, none merged and no PR opened** (the owner asked
for a commit and a push per story). Where this section and §1–§10 differ, this section and the code win.

| Story | Branch | Head | What it holds |
|---|---|---|---|
| 1 | `docs/request-forms-decisions` | `f02c07f` | open-decisions §24, F1–F12, decided by Abed on 2026-11-21 |
| 2 | `docs/request-forms-plan` | `d3f73bb` | this plan, and its rows in `CLAUDE.md` |
| 3 | `chore/migration-0112` | `3be0182` | `0112_request_form_enums` and `0113_request_forms`, `schema.prisma`, 43 migration tests |
| 4 | `feat/request-forms-contract` | `d4aac72` | shared enums, labels, field catalogue, `parseAnswers`, error codes |
| 5 | `feat/request-forms-admin-api` | `6675add` | the manager's routes, `RequestFormsService`, 77 integration tests |
| 6 | `feat/request-forms-submit` | `067c7ff` | a request on a form: answers, papers, fee, views; 37 integration tests |
| 7 | `feat/request-forms-builder` | `a75a284` | the builder screens, `lib/request-form-draft.ts` |
| 8 | `feat/request-forms-fill` | `5bec264` | the one renderer, the portal wizard, the counter form, the staff panel, the citizen's own page |
| 9 | `chore/migration-0114`, then `feat/request-forms-system` | `5358171`, `14fc503` | the backfill, then the code that reads the system forms |
| 10 | `docs/request-forms-release` | this branch | this section and §12 |

Each branch is based on the one above it in the table; `chore/migration-0112` and the docs branches start from `develop`.

> **Superseded on 2026-11-22 by Hashem's change to F1 ([§24](open-decisions.md)): there are no built-in types.** Story 9 — `0114`, `chore/migration-0114`
> and `feat/request-forms-system` below — is **dropped and must not be merged**. A later story removes the typed path and adds the dues check as a
> form setting (F13, migration `0115`), once every production municipality is confirmed to hold zero requests (confirmed by the owner on 2026-11-22).
> Rows and notes below that describe system forms record what was built, not what ships.

### Where the build differs from the plan

- **Migrations.** Three, not one or two: `0112` the enum types alone, `0113` the tables, columns, CHECKs, indexes and guards
  (the one-open index split in two, `guard_citizen_request()` replaced forward, five new guards), and `0114` the backfill of
  system forms (§3.8 step 2), in its own PR ahead of the code that reads it. The next free number is `0115`.
- **Contract.** There is no `buildAnswersSchema`: the validator is `parseAnswers(fields, raw, citizenFile)`, which returns every
  issue at once with a stable code and never a value. A body that names a `formId` is a request on a form, any other is the
  request of 0092 untouched (`onlineRequestBodySchema`, `counterRequestBodySchema`); a form body also carries `formVersionId`,
  so a form republished while it was filled is `REQUEST_FORM_VERSION_STALE`. Uploads carry `type` or `fieldKey`
  (`uploadRequestPaperSchema`): a question decides its paper's kind, its file kinds and its count.
- **Routes added.** `POST request-forms/:id/draft` (start a draft from a copy of the published questions) is not in §5.
  `requests/mine/forms`, `requests/forms` and `requests/forms/:formId/prefill` are as §5 says.
- **Error codes.** The ten of §5 and one more, `REQUEST_FORM_SYSTEM` (a built-in form is switched off, never edited, archived or deleted).
- **Request tables stay out of the in-app backup**, as §0 already corrected ([gotchas](gotchas.md)).
- **`CitizenRequestsService` only delegates.** The answers, the offered forms, the papers and the linked questions are
  `RequestAnswersService` and `request-answers.plan.ts`; the service still holds the retry key's lock, the replay, the one-open
  check, the «REQ-» number and the audit row.
- **System forms (F1).** Their questions are none and fixed; what a built-in type asked until now is the form's own settings
  (a card for the types tied to a property, always the capacity and the purpose). `request_type_settings` stays, written beside
  the form by «أنواع الطلبات والرسوم», until a later release drops it.

### Known limits, said plainly

- **The screens have not been rendered** against a mocked API at 360 and 1440 px, light and dark, `ar` and `en`
  ([ui-ux-standards.md](ui-ux-standards.md) §16.4). They typecheck, lint, build and their pure logic is tested; nobody has looked at them.
- **The printed paper does not carry the answers.** What is printed is the statement the clerk writes, started from the form's
  draft (F9); the answers are read on the panel.
- **A free form has no bill to hold its papers back**, so «جاهزة للاستلام» asks for them (`REQUEST_FORM_FILE_REQUIRED`). A paid one asks when the fee is raised.
- **A form request's `requestType` is `OTHER`** (or its built-in type), so the queue's type filter shows custom-form requests with «طلب عام».
- **No unarchive.** Archiving is final (F7); nothing offers to undo it.
- **F8's retention** waits on open-decisions §1, **F9's wording** on the municipality, and **Hashem's sign-off** on every F is pending.
- **Not done by me, and not doable from here:** the staging end-to-end, the production release, any Jira transition.

---

## 12. Release runbook (for the people who merge)

CLAUDE.md non-negotiable 5: a push to `main` migrates production, so a migration reaches `main` in its own release, and is
verified there before the code that needs it ships. Nothing below was run against staging or production.

1. **Docs.** Merge `docs/request-forms-decisions`, `docs/request-forms-plan` and this branch. Hashem reviews §24 and this plan (D3-151, D3-157).
2. **Migration PR 1 — `0112` and `0113`** (`chore/migration-0112`), to `develop`, then in a release to `main`. Additive but for two
   changes justified in `0113`'s header: `applicantCapacity` loses `NOT NULL`, and the one-open index is dropped and recreated. After the
   release, in CI's output for production: `0112` and `0113` applied to every municipality, none failed. Production code is unchanged and works.
3. **Code PRs, in order:** `feat/request-forms-contract`, `-admin-api`, `-submit`, `-builder`, `-fill`. Until step 4, built-in types read as before.
4. **Migration PR 2 — `0114`** (`chore/migration-0114`), alone. It writes rows and one column, so the scanner warns of an `UPDATE`.
   **Rehearse it first on staging**, on a copy that holds requests, and compare:

   ```sql
   -- per municipality schema; expect 8 system forms, each with a published current version
   SELECT "systemType", "enabled", "feeAmount", "currentVersionId" IS NOT NULL AS "hasVersion"
     FROM request_forms WHERE "systemType" IS NOT NULL ORDER BY "sortOrder";
   -- each should equal request_type_settings for its type (a type never set: off and 0)
   SELECT "requestType", "enabled", "feeAmount" FROM request_type_settings ORDER BY "requestType";
   -- expect 0 once linked
   SELECT count(*) FROM citizen_requests WHERE "formId" IS NULL;
   ```

   Then release it to `main` and run the same three reads on production through the read-only path your team uses; never write to production by hand.
5. **Code PR — `feat/request-forms-system`**, after step 4 is verified on production.
6. **Staging end-to-end** (the staff and citizen paths, with synthetic people only): create a form, add one question of each type, publish,
   switch on; file it online and at the counter, with a linked question the file can fill and one it cannot (the request must be refused,
   then accepted after a clerk completes the file); refuse bad answers; retry a lost answer; file twice (one open request); raise the bill
   with and without the identity copy and the file question's paper; approve from the form's statement draft; republish the form and
   confirm the filed request keeps its questions; archive; switch a built-in type off and on and change its fee, and file a typed request.
7. **Rollback.** Code can go back one step at a time: `0112`–`0114` are additive or fill-only and the build before them ignores every
   column they add; the system forms' switch and fee are written to `request_type_settings` too, so the build before `feat/request-forms-system`
   finds its settings. A migration is never edited: a fix is a new one.
