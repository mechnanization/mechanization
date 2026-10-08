# packages/shared-schemas

Last verified against the code: `feat/estate-institution-owners` (on `develop@f10a1b7`), 2026-10-08.

`@mechanization/shared-schemas`: the zod schemas, enums, display labels and
pure rules that the backend and the frontend share. One copy of each contract,
used on both sides of the wire. Repo-wide rules: [CLAUDE.md](../../CLAUDE.md).

## What it exports

`src/index.ts` re-exports 31 modules. Everything is imported from the package
root (`from '@mechanization/shared-schemas'`); there are no deep imports.

| Kind | Modules |
|---|---|
| Vocabulary | `enums` (the `as const` value lists, their zod schemas and types), `error-codes` (`ERROR_KINDS`, `ERROR_CODES`, `ErrorCode`, `ErrorParams`, `ApiErrorBody`, `isSpecificErrorCode`), `labels` (`ar`, `en`, `getLabels`), `primitives` (`lebanesePhone`, `internationalPhone`, `optionalInternationalPhone`, `arabicOrLatinName`, `documentNumber`, `civilRecordNumber`, `tenantSlug`, `uuid`, `normalizeDigits`), `role-sets` (who may call what: `EVERY_STAFF_ROLE`, `WORKING_STAFF_ROLES`, `REGISTER_WRITE_ROLES`, `CENSUS_WORKLIST_ROLES`, `FEE_ISSUE_ROLES`, `REGISTER_EXPORT_ROLES` and the rest, `hasStaffRole`) |
| Contracts (`*.schema.ts`) | `citizen`, `field-flag`, `property`, `registration`, `admin-citizen`, `citizen-import`, `fee`, `auth`, `tenant`, `zone`, `building`, `unit-correction`, `staff`, `case`, `quality`, `citizen-merge` |
| Pure rules | `numbering`, `unit-layout`, `cash-policy`, `payout-policy`, `inspector-earnings`, `unit-status-rule`, `owner-share` (how a co-owned flat is divided: `ownerShareOf`, `effectiveOwnerBilling`, `ownerSharesPreview`), `citizen-name` (`citizenDisplayName` — «ورثة المرحوم …» for an estate; every screen and bill names a citizen through it — `citizenStoredName` for a name copied into another row, `withoutEstatePrefix`/`ESTATE_PREFIX_PATTERN` for matching typed names, `splitInstitutionName`), `damage-rule` (the severity ladder, `habitabilityFor`, `isUninhabitableReading`, the re-inspection day on the municipality's calendar), `staff-presence` (the stamp interval, the online threshold, `isStaffOnline`, `BACKGROUND_REQUEST_HEADER`) |

The code is plain TypeScript with no I/O and no Node or browser APIs
(`tsconfig.base.json` sets `lib` to ES2022). Keep it that way: both apps run
it.

## Consumers read `dist/`, so rebuild after every change

`package.json` sets `main: dist/index.js` and `types: dist/index.d.ts`. Both
apps depend on it as `workspace:*`. The frontend also lists it in
`transpilePackages` (`apps/frontend/next.config.mjs`), but still resolves
`dist/`. So:

- After editing anything under `src/`, MUST run
  `pnpm --filter @mechanization/shared-schemas build` before you typecheck,
  test, build or run either app. Until then they see the old contract.
- While iterating, keep `pnpm --filter @mechanization/shared-schemas dev`
  (`tsc --watch`) running in another terminal.
- `pnpm dev` does not build it. `pnpm start` builds it once at launch,
  silently, and carries on if the build fails.
- On a fresh clone, `dist/` does not exist and nothing typechecks until the
  first build.

Every pipeline builds the shared schemas before the app that consumes them:
`.github/workflows/ci.yml` ("Build shared schemas", then "Generate Prisma
clients"), `apps/backend/Dockerfile` (stage `build`), `apps/frontend/vercel.json`
(`buildCommand`), `.github/workflows/deploy-backend.yml` (after its "Generate
Prisma clients" step), and the root `pnpm build` (packages, then apps; it does
not generate the Prisma clients).

## Add a schema

Model: `unit-correction.schema.ts` (`unitCorrectionDeleteSchema`,
`UnitCorrectionDeleteInput`, `UnitCorrectionPreview`), used by
`CorrectionsController`.

1. Create `src/<feature>.schema.ts`: a `z.object`, then
   `export type <X>Input = z.infer<typeof <x>Schema>` and the response
   interfaces the frontend reads.
2. Reuse `primitives` and the enum schemas. Do not restate a phone, name or
   document-number rule.
3. Export it from `src/index.ts`.
4. Build the package.
5. Backend: validate with `@Body(new ZodValidationPipe(<x>Schema))` on the
   parameter, never `@UsePipes`
   ([apps/backend/CLAUDE.md](../../apps/backend/CLAUDE.md)).
6. Frontend: take the request and response types from the package in
   `lib/api-client.ts`; the forms may `safeParse` the same schema
   ([apps/frontend/CLAUDE.md](../../apps/frontend/CLAUDE.md)).

Validation messages are Arabic today (`arabicEnum` and the `message` options),
and the forms show them as they are. A message is display text, not a
contract: never branch on it. **Undecided:** how validation messages get
English text. Domain errors carry stable codes that the frontend localises
(D-errors), but zod issue messages have no such mechanism, so `/en/` pages show
Arabic validation text.

## Add an enum or an enum value

An enum lives in up to five places, and they MUST change together:

1. `src/enums.ts`: the `as const` list, its schema (`arabicEnum`) and type.
2. `src/labels.ts`: the value in **both** `ar` and `en`.
3. `apps/backend/src/infrastructure/prisma/tenant/schema.prisma`: the Prisma
   `enum`.
4. A tenant migration: `ALTER TYPE "<Enum>" ADD VALUE IF NOT EXISTS '<VALUE>';`
   alone in its own migration, shipped before any code writes the value
   ([docs/database.md](../../docs/database.md#migrations)).
5. The domain union, where one exists (for example `UnitType` in
   `apps/backend/src/domain/entities/property-entry.entity.ts`, `StaffRole` in
   `user.entity.ts`).

What checks the copies:

- `domain-enum-drift.spec.ts` compares the shared lists with the domain unions
  for unit type, unit status, occupancy, property, land type and staff role.
- Nothing compares the shared lists with the Prisma or SQL enums. Writes cross
  into Prisma through `as never`, so a mismatch compiles and fails at runtime.
- `StaffRole` exists in the shared `STAFF_ROLE`, the domain `StaffRole` and the
  Prisma `enum StaffRole`. `src/scripts/create-staff.ts` reads `STAFF_ROLE`.
- A value retired from use stays in the Prisma and SQL enum (removing it is
  destructive DDL) and leaves the shared list; a CHECK refuses it from then on.
  `DamageLevel.UNINHABITABLE` is the model (`0071`).

Never rename or remove a stored value: that is destructive DDL. Change the
label instead (see the `NON_RESIDENT_OWNER` comment in `enums.ts`).

`CITIZEN_RESIDENCE` has four values since `0076`. Ask `isOwnerRecord` ("not a
household": non-resident, estate, institution) or `isNonPersonRecord` (estate,
institution) rather than comparing to one value; the admin schema picks each
kind's sections in `sectionSchemas`, and `nonResidentCardIssues` takes the kind
(an estate owns only: `ESTATE_OWNS_ONLY`).

## Add an error code

`src/error-codes.ts` is the one list of codes the API refuses with
([apps/backend/CLAUDE.md](../../apps/backend/CLAUDE.md#error-codes)).

1. Add the code to `ERROR_CODES`, in its group, upper snake case, naming the
   case (`PAYMENT_EXCEEDS_BALANCE`), not the screen.
2. Add `errors.<CODE>` to `apps/frontend/messages/ar.json` and `en.json`, as ICU
   with the same placeholders in both. `apps/frontend/lib/api-errors.test.ts`
   fails if either is missing or they differ.
3. Rebuild this package, then throw it from the backend.

A code is API: never rename it or give a retired one a new meaning.

## Add a label

Decided (D-i18n): enum display labels come from `getLabels(locale)` in this
package. Other new UI copy goes in next-intl messages
(`apps/frontend/messages/ar.json` and `en.json`), not here.

- Add the key to both `ar` and `en` in `labels.ts`.
- Type an enum's labels with `satisfies Record<<Enum>, string>`, so a missing
  value fails `tsc`. A key present in only one locale fails at its first use,
  because `getLabels` returns the union of the two objects.
- Keep labels out of the schemas. Values on the wire stay language-neutral.

## Rules

- Write once. A rule both apps need (unit status, numbering, cash policy,
  earnings) lives here, once, and both apps import it. Do not re-implement it
  in either app, and do not copy it back out
  ([docs/code-quality.md](../../docs/code-quality.md)).
- zod 3, not zod 4. The range is `^3.23.8`. The installed 3.25 also ships a
  v4 subpath (`import { z } from 'zod/v4'`): MUST NOT import it, and MUST
  import from `'zod'` only. Use the zod 3 API (`errorMap`,
  one-argument `z.record`, `.passthrough()`), and check the types in
  `node_modules/zod` before you rely on an API you remember.
- The output is CommonJS (`module: commonjs` in `tsconfig.base.json`), with
  `strict` and `noUncheckedIndexedAccess`.
- **An optional phone is `optionalInternationalPhone`, never
  `internationalPhone.optional().or(z.literal(''))` and never a bare
  `internationalPhone.optional()`.** The union looks right and leaks English:
  when the number is malformed every branch fails and zod reports the union's
  own «Invalid input» instead of «رقم الهاتف غير صالح», on an Arabic-first form,
  for the commonest typo there is (TXT-2, TXT-4). The bare `.optional()` takes
  `undefined` and nothing else, so the `''` a cleared box holds is refused as a
  malformed number, on a field the form may have hidden: `whatsapp` under
  «لا يملك رقم هاتف» turned the step red with no message. The primitive
  preprocesses an empty string to `undefined` so there is only ever one
  branch. A test of a form's payload sends the empty strings the form sends,
  not an absent key.
- **A rule on a citizen field is written in the strict schema and in its
  `partial*` twin.** `shapeSubmission` re-parses what the strict pass accepted
  with `partialContactDetailsSchema` and `partialPropertyEntrySchema`, and those
  throw rather than report. Relax a field in one only and a value that should
  save, or be refused with a message, makes `safeParse` throw, which the API
  answers with a 500 (`landlordPhone` of a شاغل بتسامح is in both). Test through
  `adminCreateCitizenSubmissionSchema` or `adminUpdateCitizenSubmissionSchema`,
  never the card or section alone.
- A field whose requirement depends on another answer — «لا يملك رقم هاتف»
  waiving `phone` — is optional on the *object* and required again in
  `superRefine`. A field cannot waive a requirement its own type has already
  failed. Keep the refinement's path and message identical to what the strict
  primitive would have raised, or the standard record's errors move. A
  refinement behind a transform runs only once the rest of the object parsed,
  so a submission that is a whole record checks the requirement on what was
  sent as well: `householdPhoneIssues` (`admin-citizen.schema.ts`) raises the
  phone, WhatsApp and «رقم للتواصل هو رقم المواطن نفسه» issues on the raw
  contact section, so a blank phone is refused even when another field of the
  section is flagged or missing. The refinement stays for direct users of
  `contactDetailsSchema`.
- An answer shown for a human to compare keeps its type: the merge preview's
  `CitizenMergeFieldConflict` and `CitizenMergeFieldFill` carry a yes-or-no as
  a boolean and an enum as its code (`string | boolean | null`), and the dialog
  says them in the page's language. A server that wrote «نعم» put Arabic on
  the English page.
- A value one field decides for another — the habitability a damage level
  implies — is filled in a `.transform()` placed before the `.superRefine()`
  that checks it (`createDamageAssessmentSchema`). Annotate the transform's
  return as `(value): typeof value`, or the output type gains a required key
  every caller must now send. A refinement behind a transform runs only once
  the object itself parsed, so a missing field is reported first, as itself.
- Who may call a route is a named set in `role-sets.ts`, imported by both apps
  (`@Roles(...SET)` on the server, `lib/staff-roles.ts` in the portal). A new
  audience is a new set there, never a re-typed list.
- `.partial()` drops a `.default()`. `shapeSubmission` parses the citizen
  sections through the partial schemas, so a boolean flag with
  `.default(false)` arrives **absent**, not `false`, when the client omits it.
  Read such a flag as `=== true` and never `!== false` — that is what keeps an
  older build, the offline queue and an import writing what they wrote before
  (`no-phone.spec.ts` pins it).

## Tests

There is no test script and no test runner in this package. Its rules are
tested from the consumers: the backend Jest suite (for example
`apps/backend/src/application/features/buildings/numbering.spec.ts`,
`unit-layout.spec.ts`, `domain-enum-drift.spec.ts`) and the frontend Vitest
suite under `apps/frontend/lib`. Put a test for a new shared rule next to its
main consumer, and run that package's `test` script after rebuilding.
**Undecided:** whether the package gets its own test runner.

## Commands

| Purpose | Command |
|---|---|
| Build `dist/` | `pnpm --filter @mechanization/shared-schemas build` |
| Rebuild on save | `pnpm --filter @mechanization/shared-schemas dev` |
| Typecheck the consumers | `pnpm typecheck` |
| Test the consumers | `pnpm --filter @mechanization/backend test`, `pnpm --filter @mechanization/frontend test` |
