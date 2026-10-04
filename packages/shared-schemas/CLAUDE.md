# packages/shared-schemas

Last verified against the code: `feat/staff-refresh-tokens-rebased` (on `develop@8742c5b`), 2026-10-04.

`@mechanization/shared-schemas`: the zod schemas, enums, display labels and
pure rules that the backend and the frontend share. One copy of each contract,
used on both sides of the wire. Repo-wide rules: [CLAUDE.md](../../CLAUDE.md).

## What it exports

`src/index.ts` re-exports 26 modules. Everything is imported from the package
root (`from '@mechanization/shared-schemas'`); there are no deep imports.

| Kind | Modules |
|---|---|
| Vocabulary | `enums` (the `as const` value lists, their zod schemas and types), `error-codes` (`ERROR_KINDS`, `ERROR_CODES`, `ErrorCode`, `ErrorParams`, `ApiErrorBody`, `isSpecificErrorCode`), `labels` (`ar`, `en`, `getLabels`), `primitives` (`lebanesePhone`, `internationalPhone`, `arabicOrLatinName`, `documentNumber`, `civilRecordNumber`, `tenantSlug`, `uuid`, `normalizeDigits`) |
| Contracts (`*.schema.ts`) | `citizen`, `field-flag`, `property`, `registration`, `admin-citizen`, `citizen-import`, `fee`, `auth`, `tenant`, `zone`, `building`, `unit-correction`, `staff`, `case`, `quality`, `citizen-merge` |
| Pure rules | `numbering`, `unit-layout`, `cash-policy`, `payout-policy`, `inspector-earnings`, `unit-status-rule` |

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
  for unit type, unit status, occupancy, property and land type only.
- Nothing compares the shared lists with the Prisma or SQL enums. Writes cross
  into Prisma through `as never`, so a mismatch compiles and fails at runtime.
- `StaffRole` exists in the shared `STAFF_ROLE`, the domain `StaffRole`, the
  Prisma `enum StaffRole`, and the `Role` type in `src/scripts/create-staff.ts`,
  with no drift test.

Never rename or remove a stored value: that is destructive DDL. Change the
label instead (see the `NON_RESIDENT_OWNER` comment in `enums.ts`).

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
