# Request form builder — implementation plan
## نماذج الإفادات

> **Status: built, not merged.** Stories 3–10 (the migration, the shared
> contract, the backend admin API, submitting a request on a form, the
> manager's builder screens, filling a form in the portal and at the counter,
> F13's dues check, and retiring the built-in types) are all on stacked
> commits ending at `feat/request-forms-no-builtins@58f1c199`, based on
> `develop@90cebdc`. **Stories 1 and 2 — this document and
> [open-decisions.md §24](open-decisions.md#24-request-form-builder) — were
> supposed to come first and did not**: the code was written, then this plan
> was reverse-engineered from it, 2026-11-23. §24's decisions are recorded
> from what shipped, not from a meeting, and still need Hashem's ratification.
>
> **The branch cannot be opened as a PR yet.** `develop` has moved on
> considerably since `90cebdc` — old debts (the whole arrears feature),
> unit types, building types, the News integration, and the 2026-11-23
> cleanup-sprint audit docs all landed on `develop` after this branch forked
> from it. Rebasing onto current `develop` is its own piece of work (likely
> its own ticket), not attempted here. §9 lists what that rebase will need to
> re-check.
>
> §1–§8 describe the code as it stands on that branch. Where this plan and
> the code disagree, read the code again: it is newer than this document by
> construction.

A citizen fills in a form the manager designed — its name, its questions, its
fee — rather than the system offering eight fixed request types nobody could
change. The manager builds a form in `requests/forms`, publishes it, and from
then on it is what a citizen fills in online or a clerk fills in at the
counter, the same way a براءة ذمة or a إفادة سكن used to be filled in, except
now every municipality can define its own instead of waiting on this
codebase to add one.

**Every request is on a form.** [Open decisions §24](open-decisions.md#24-request-form-builder)
F1, decided during implementation and going further than first proposed: the
eight built-in request types (`RequestType`) were not kept beside custom
forms, they were removed. A form that stands for a former built-in type
carries `systemType`; everything else about it is an ordinary form.

---

## 0. How to use this document

- **This is as-built, not a proposal.** Every name below exists in the code
  today on the branch named above; none is marked *(proposal)*. Grep before
  citing it anyway — a stale doc is still a doc that can be wrong
  ([CLAUDE.md](../CLAUDE.md#how-to-work-here)).
- **Decisions are tracked in [open-decisions.md §24](open-decisions.md#24-request-form-builder),**
  not here. Where this plan says a question was decided a certain way, that
  section is the record of it, and it is where a later, different answer from
  the municipality or Hashem gets written down.
- **Read first:** [CLAUDE.md](../CLAUDE.md), [database.md](database.md),
  [security.md](security.md), [ui-ux-standards.md](ui-ux-standards.md)
  (binding), [municipal-requests-plan.md](municipal-requests-plan.md) (the
  feature this one extends — read its §1 and §3 first; this plan does not
  repeat what did not change), and [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md)'s
  own "Request forms (0112, 0113)" section, which is the fuller, line-by-line
  reference this plan summarises.

---

## 1. What exists today that this feature builds on

Verified against `develop@90cebdc`, the branch's own base (itself verified
2026-10-13 by [municipal-requests-plan.md](municipal-requests-plan.md) §1,
with changes since tracked in that plan's §7 and in
[apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md)'s own history line).

- **The request tables** (`0092_citizen_requests`, `0094_citizen_request_guard`):
  `citizen_requests` (the «REQ-» number, channel, status, the one-open
  index), `citizen_request_attachments`, `request_type_settings` (the
  built-ins' fees and on/off switches — emptied of meaning once F1 removed
  the built-ins, the table itself not dropped).
- **`CitizenRequestsService`** and **`CitizenRequestsController`**
  (`t/:tenantSlug/requests`): submit (online and counter), approve, reject,
  hand over, cancel, raise the fee's bill, attach and read papers. This
  feature changes `submit` to also accept a form, and leaves every other verb
  untouched.
- **`REQUEST_FILE_STORAGE`** (the papers' S3 port) and `sniffAttachment`
  (bytes typed, never the declared kind) — reused as-is for a form's file
  questions.
- **`raiseOneOffBill`** — reused as-is: a form's fee is raised the same way a
  built-in type's was.
- **`REQUEST_*_ROLES`** (`role-sets.ts`) — reused as-is; this feature adds no
  new role set except at the edges (see §4).
- **The portal wizard** (`my-file/requests/new`) and **the counter form**
  (`components/admin/requests/counter-request-form.tsx`) — both rewritten in
  this feature to choose a form first (§6), not to pick from a fixed list.

---

## 2. Decisions

[open-decisions.md §24](open-decisions.md#24-request-form-builder), F1–F13.
Short version: built-in types are gone (F1); a published form's *questions*
are versioned, its *settings* are not (F2); a fixed field-type catalogue, no
free-form patterns (F3); linked fields are read-only copies from the file,
and a required linked field with nothing on file refuses the request rather
than letting the citizen re-type it (F4); the manager alone builds and
enables forms (F5); a form's property card and applicant-capacity questions
are per-form settings, plus a free-text purpose question not originally
asked for (F6); disable hides a form from new requests, delete is refused
while any request names it (F7); answers are for request readers only, with
a citizen's own read masking document numbers (F8); an optional statement
template the clerk starts from (F9); Arabic required, English optional,
falling back to Arabic (F10); one open request per citizen and form (F11); a
form's own identity-copy question can stand in for the portal's generic one
(F12, new); any form may gate approval on the property's dues, not only the
built-in براءة ذمة (F13, new).

---

## 3. Data model (as built)

### 3.1 Shared enums and labels (`packages/shared-schemas/src/enums.ts`)

- `REQUEST_FIELD_TYPE` (11 values): `SHORT_TEXT`, `LONG_TEXT`, `INTEGER`,
  `DECIMAL`, `DATE`, `PHONE`, `DOCUMENT_NUMBER`, `SINGLE_CHOICE`,
  `MULTI_CHOICE`, `YES_NO`, `FILE`.
- `REQUEST_PROPERTY_MODE`: `NONE` / `OPTIONAL` / `REQUIRED`.
- `REQUEST_FORM_VERSION_STATUS`: `DRAFT` / `PUBLISHED`.
- `REQUEST_LINKED_SOURCE` (7 values): `FIRST_NAME`, `FATHER_NAME`,
  `LAST_NAME`, `MOTHER_NAME`, `PHONE`, `IDENTITY_NUMBER`,
  `CIVIL_RECORD_NUMBER` — never رقم مرجعي (non-negotiable 7).
  `REQUEST_LINKED_SOURCE_TYPE` pins each to the one field type it may be
  linked to (`request-form.schema.ts`), checked by a tenant CHECK
  (`request_form_fields_linked_source_type`) as well as by zod.

### 3.2 `request_forms` (migration `0112_request_form_enums`, `0113_request_forms`; `0115_request_form_dues_check`)

A form the manager defines. `nameAr` (required), `nameEn`, `feeAmount` (whole
LBP, the same CHECKs as `request_type_settings`), `enabled`, `propertyMode`,
`askCapacity`, `askPurpose`, `requiresNoDues` (F13; CHECK
`request_forms_dues_needs_property` — only with `propertyMode = REQUIRED`),
`statementTemplate`, `sortOrder`, `systemType` (nullable, unique — F1),
`currentVersionId`, `archivedAt` / `archivedById`, `createdById` /
`updatedById`. Never deleted while any request names it or while it is a
system form (`guard_request_form`, the database's half of F7).

### 3.3 `request_form_versions`

One row per published version plus at most one `DRAFT` (partial unique index
`request_form_versions_one_draft_key`). `versionNumber`, `status`,
`revision` (compared on save to catch two managers editing at once, F2),
`publishedAt` / `publishedById`, `createdById`. Published versions are
frozen (`guard_request_form_version`); only a `DRAFT` row's fields can
change.

### 3.4 `request_form_fields`

One question: `versionId`, stable `key` (`request_form_fields_key_shape`
CHECK: lower snake case, starts with a letter, ≤ 40 characters), `position`
(0–39, `request_form_fields_position_range`), `type`, `labelAr` / `labelEn`,
`helpAr` / `helpEn`, `config` (JSONB, shaped per type by the zod union in
`request-form.schema.ts`, never trusted from the database alone — `fieldRow`
/ `fieldView` in `request-form.plan.ts` re-validate on read), `linkedSource`.
No `required` column: every field is required, by F4's decision — there is
nothing to store.

### 3.5 `citizen_request_answers`

One row per answered question on a request: `requestId`, `fieldId`, `value`
(JSONB — a string, a number, a boolean, or a string array for multi-choice),
`origin` (`RequestAnswerOrigin`: typed by the applicant, or copied from a
linked field). Unique on `(requestId, fieldId)`.

### 3.6 Columns added to existing tables

- `citizen_requests.formId` / `.formVersionId` — both set together or both
  null (a request on a form vs. the retired built-in shape; since F1,
  `formId` is in practice never null for a new request, but the column pair
  stays nullable because old rows and the guard trigger still read it that
  way).
- `citizen_request_attachments.fieldId` — which file question a paper
  answers; null for a paper that is not tied to a question (an older request
  not on a form).

### 3.7 Indexes that encode a rule, not just a lookup

- `citizen_requests_one_open_form_key` — the one-open rule (F11) keyed on
  `(citizenId, formId, propertyEntryId)` where `formId IS NOT NULL`, beside
  `citizen_requests_one_open_key`'s original `(citizenId, requestType,
  propertyEntryId)` where `formId IS NULL`.
- `request_forms_systemType_key` — F1's one form per retired built-in type.
- `request_form_versions_one_draft_key` — F2's one draft per form.
- `request_form_fields_versionId_key_key` / `..._position_key` — a key and a
  position are each unique within a version.

### 3.8 Guards (0113)

Five plpgsql functions, each reading only its own table or joining to the
one above it, so each is pinned to its own schema except where it reads
nothing tenant-specific: `guard_request_form`, `guard_request_form_version`,
`guard_request_form_field`, `guard_citizen_request_answer`,
`guard_citizen_request_attachment_field`. `guard_citizen_request` (from
0094) was **replaced forward** in the same migration, because it now also
reads `formId` — `CREATE OR REPLACE` resets `search_path`, so the migration
sets it again with `ALTER FUNCTION`.

---

## 4. Validation design

`packages/shared-schemas/src/request-form.schema.ts` holds the field
catalogue (§3.1, the discriminated union `requestFormFieldSchema`), the
manager's bodies (`createRequestFormSchema`, `updateRequestFormSchema`,
`saveRequestFormDraftSchema`), the submit bodies
(`submitOnlineFormRequestSchema`, `submitCounterFormRequestSchema`), and
every view type. `packages/shared-schemas/src/request-form-answers.ts` is the
*answers* validator: given a published version's fields and a body's raw
`answers` record, it builds and runs a schema from the field list — every
field required (F4), a choice checked against its own `choices`, a file
question checked for presence by key rather than by value (files arrive as
multipart parts, not JSON) — and returns either the typed answers or a list
of per-field issues (`REQUEST_ANSWERS_INVALID`, `details.issues`). This runs
in the **backend only**, inside `RequestAnswersService`, because a static
`ZodValidationPipe` is fixed at startup and cannot know which form a request
names; the originally proposed `buildAnswersSchema(fields)` name was not
used — the function is `parseAnswers` in `request-form-answers.ts`. The
**frontend** does not re-derive the same schema; `lib/request-form-fill.ts`
and `components/request-forms/form-renderer.tsx` do their own lighter,
UX-only checks (required, pattern, min/max) from the same field list, so a
typo is caught before the request is sent, but the server's `parseAnswers`
is still the one place a submission is actually accepted or refused.

---

## 5. API contract (as built)

### 5.1 `RequestFormsController` (`t/:tenantSlug/request-forms`)

| Method | Path | Roles | Service method |
|---|---|---|---|
| GET | `/` | `REQUEST_READ_ROLES` | `list` |
| GET | `/:id` | `REQUEST_READ_ROLES` | `get` |
| POST | `/` | `REQUEST_SETTINGS_ROLES` | `create` |
| PUT | `/:id` | `REQUEST_SETTINGS_ROLES` | `update` |
| POST | `/:id/draft` | `REQUEST_SETTINGS_ROLES` | `startDraft` |
| PUT | `/:id/draft` | `REQUEST_SETTINGS_ROLES` | `saveDraft` |
| POST | `/:id/publish` | `REQUEST_SETTINGS_ROLES` | `publish` |
| POST | `/:id/enable` | `REQUEST_SETTINGS_ROLES` | `setEnabled(true)` |
| POST | `/:id/disable` | `REQUEST_SETTINGS_ROLES` | `setEnabled(false)` |
| POST | `/:id/archive` | `REQUEST_SETTINGS_ROLES` | `archive` |
| DELETE | `/:id` | `REQUEST_SETTINGS_ROLES` | `remove` |

Every handler pinned by method, path and roles in `route-inventory.spec.ts`.
A citizen never reaches this controller.

### 5.2 Additions to `CitizenRequestsController` (`t/:tenantSlug/requests`)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `mine/forms` | citizen (self-service) | the forms a citizen may file online |
| GET | `forms` | `REQUEST_HANDLE_ROLES` | the forms a clerk may file at the counter |
| GET | `forms/:formId/prefill?citizenId=` | `REQUEST_HANDLE_ROLES` | a chosen citizen's linked-field values, before the clerk fills the rest |

`POST mine` and `POST ` (counter) are unchanged in path and roles; their
bodies now accept `formId` + `answers` (§2 of `request-form.schema.ts`), and
`.strict()` refuses a body that names a `requestType` beside a `formId`
(there are no built-in types to also name, F1).

### 5.3 Removed

`GET requests/types`, `PUT requests/types/:type`, `GET requests/mine/types` —
gone with F1. `requests/types/page.tsx` (the manager's old types screen) is
removed from the frontend; `requests/forms` is its replacement.

---

## 6. Frontend (as built)

- **`components/request-forms/form-renderer.tsx`** — the one type → primitive
  map, shared by the portal, the counter and (read-only) the manager's
  preview. Arabic always shown, English falling back to it (F10). Holds no
  state of its own.
- **`lib/request-form-draft.ts`** / **`request-form-fill.ts`** — the portal
  wizard's draft state and its UX-only validation (§4), plus
  `formAsksForIdentityCopy` (F12).
- **`lib/request-forms-api.ts`** — the client functions for §5.1 and §5.2
  (`getRequestForms`, `getRequestForm`, `createRequestForm`,
  `updateRequestForm`, `startRequestFormDraft`, `saveRequestFormDraft`,
  `publishRequestForm`, `setRequestFormEnabled`, `archiveRequestForm`,
  `deleteRequestForm`, `getCounterForms`, `getRequestFormPrefill`,
  `getMyOfferedForms`).
- **`lib/request-title.ts`** — a request's displayed title now reads the
  form's name; the old `RequestType` label is a fallback for a request filed
  before F1, never for a new one.
- **Manager screens**: `requests/forms` (the list) and
  `requests/forms/[formId]` (one form: settings, `field-editor.tsx`,
  `form-builder.tsx`, `form-settings.tsx`, `new-form-dialog.tsx`).
- **Portal and counter**: `(citizen)/my-file/requests/new` (rewritten: choose
  a form, then its questions) and `components/admin/requests/counter-request-form.tsx`
  (same choice at the counter, `getRequestFormPrefill` filling linked fields
  once a citizen is chosen).

---

## 7. Layering (as built)

Matches [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md)'s recipe exactly:

- `application/features/request-forms/request-form.plan.ts` — pure:
  `fieldRow` / `fieldView`, `deleteRefusal`, `enableRefusal`,
  `firstDuplicateKey`.
- `application/features/request-forms/request-forms.service.ts` —
  `RequestFormsService`: the manager's CRUD and lifecycle, one
  `runInTenantTransaction` a write, the form row locked `FOR UPDATE` first, a
  Tier 1 audit row inside every transaction (`REQUEST_FORM_CREATED` through
  `_DELETED`, settings and counts only, never a question's words).
- `application/features/request-forms/request-answers.plan.ts` /
  `.service.ts` — `RequestAnswersService`: `resolveSubmission` (the form's
  state, the version, linked fields, `parseAnswers`) and `writeAnswers`;
  `CitizenRequestsService` only delegates to it, kept under its own ~1,200
  lines rather than growing further (CLAUDE.md's own stated limit).
- `presentation/controllers/request-forms.controller.ts` — thin, `@Roles` on
  every handler, bodies through `ZodValidationPipe`, ids through `UuidPipe`.
- No new domain port: file storage reuses `REQUEST_FILE_STORAGE`.

---

## 8. Test plan (as built)

- **Unit**: `request-form.schema.spec.ts`, `request-form-answers.spec.ts`,
  `request-form-enums.spec.ts` (drift between the shared enum and the tenant
  Prisma enum), `request-form.plan.spec.ts`, `request-answers.plan.spec.ts`.
- **Integration** (`TEST_DATABASE_URL`, throwaway Postgres 17):
  `request-forms.integration.spec.ts` (the manager's lifecycle against a real
  schema — create, draft, publish, enable/disable, archive, delete refusals),
  `citizen-request-forms.integration.spec.ts` (filing online and at the
  counter, linked-field refusal, stale-version refusal, the retry key,
  papers, backup roundtrip), the Prisma-level
  `infrastructure/prisma/request-forms.integration.spec.ts` (the guards
  themselves), and the append-only/TRUNCATE convention spec extended for the
  new tables.
- **Route inventory**: `route-inventory.spec.ts` extended for
  `RequestFormsController` and the three new `CitizenRequestsController`
  routes.
- **Not yet done**: a rendered UI pass against a mocked API
  ([ui-ux-standards.md](ui-ux-standards.md) §16.4), light/dark, mobile,
  synthetic people only — §9 lists it as blocked on the rebase.

---

## 9. What the rebase onto current `develop` will need to re-check

Recorded here so it is not lost between now and whenever that work starts.
`develop` has gained, since `90cebdc`, at least: the whole old-debts
(arrears) feature, unit types (`feat/unit-types`), building types, the
Day3ati News integration, and the 2026-11-23 cleanup-sprint audit docs
(`docs/cleanup-sprint-2026-11-23/`) plus the five PRs fixing items from it
(D3-236–243). None of those touch `request_forms` or `citizen_requests`
directly, so the **data model** should rebase cleanly; the likely conflict
points are:

- `packages/shared-schemas/src/enums.ts`, `index.ts`, `error-codes.ts`,
  `labels.ts`, `role-sets.ts` — both sides added exports near the same place.
- `apps/frontend/messages/{ar,en}.json` — both sides added many keys; a
  textual conflict, not a logical one, but large.
- `apps/frontend/lib/staff-roles.ts` and `components/admin/nav.ts` — PR #207
  (D3-243, this sprint) touched both files for an unrelated reason
  (replacing copied role lists); re-check `nav.ts`'s request-forms rows
  against the new `CITIZEN_EDITOR_ROLES` / `FEE_READ_ROLES` pattern it
  introduced rather than reverting it.
- `apps/backend/src/presentation/controllers/route-inventory.spec.ts` and
  `apps/backend/src/infrastructure/prisma/tenant/schema.prisma` — both sides
  add tables/routes; Prisma migrations are additive and ordered by number, so
  check the next free migration number again at rebase time
  ([database.md](database.md#migrations)) rather than trusting `0115` still
  being free.
- The release checklist items already tracked as this epic's own sub-tasks
  (`docs/old-debts-plan.md`-style sub-tasks were not created for this epic;
  D3-139's remaining stories, if any exist in Jira beyond 1–10, should be
  checked against this section before closing them).
