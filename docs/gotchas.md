# Gotchas

Last verified against the code: `fix/pr104-review` (PR #104 review fixes merged with `fix/expense-retry-key-race@ff44f27` and `develop@4ad0b27`), 2026-10-09.

Traps specific to this repository, each confirmed in the code. Every entry
gives what happens, why, what to do, and where to look. The rules themselves
live in their canonical docs; this file is for the behaviour that surprises.
Found a new one? Add it here ([CLAUDE.md](../CLAUDE.md#keeping-the-docs-true)).

Sections: [Toolchain](#toolchain) · [Database and migrations](#database-and-migrations) ·
[Backend runtime](#backend-runtime) · [Auth](#auth) · [Frontend](#frontend)

## Toolchain

### pnpm 10 and later ignore `pnpm.overrides` in `package.json`

- **What happens:** a newer pnpm prints `The "pnpm" field in package.json is no
  longer read` and silently drops the security overrides listed there.
- **Why:** pnpm 10 reads settings from `pnpm-workspace.yaml`. The repo pins
  pnpm 9.12.0 (`packageManager`), which reads `package.json`. Both lists exist
  so an upgrade cannot revert the pins.
- **Do this:** change both lists in the same commit and keep them identical.
  Nothing checks that they match; the CI `audit` job is the only backstop.
- **Where:** `package.json` `pnpm.overrides`, `pnpm-workspace.yaml`
  `overrides`, `.github/workflows/ci.yml` job `audit`.

### ESLint does not read `.gitignore`

- **What happens:** `pnpm lint` (`eslint .`) lints every untracked directory
  inside the repo. Agent worktrees checked out under `.claude/worktrees` made it
  lint other branches and fail on their code.
- **Why:** flat config ignores only what its own `ignores` list names.
- **Do this:** when a tool creates an untracked directory inside the repo, add
  it to `ignores`. The agent worktree directory is now listed there.
- **Where:** `eslint.config.mjs`, the first config object's `ignores`.

### Shared schemas are consumed from `dist/`

- **What happens:** an edit under `packages/shared-schemas/src` is invisible to
  both apps, which keep typechecking and running against the old contract.
- **Why:** the package's `main` and `types` point at `dist/`. `pnpm dev` does
  not build it; `pnpm start` builds it once and ignores a failed build.
- **Do this:** `pnpm --filter @mechanization/shared-schemas build`, or keep its
  `dev` watch running ([packages/shared-schemas/CLAUDE.md](../packages/shared-schemas/CLAUDE.md)).
- **Where:** `packages/shared-schemas/package.json`, root `package.json`
  `dev`, `scripts/start.mjs`.

### A git worktree has no env files, and its Prisma clients do not look for one

- **What happens:** in a fresh worktree, `pnpm db:check` reports every env
  file "not present", and after `apps/backend/.env` is put in place,
  `pnpm db:seed` still fails with «DATABASE_URL is not set».
- **Why:** env files are gitignored, so a worktree starts without them. The
  seed relies on the generated Prisma client to load `apps/backend/.env`, and
  `prisma generate` records that path only if the file existed when it ran.
- **Do this:** copy the main checkout's `apps/backend/.env` into the worktree
  (never open or print it; it names the local database only), then run
  `pnpm db:generate` again before seeding. Delete the copy when done.
- **Where:** `apps/backend/src/scripts/seed.ts` `runSeed`; the generated
  clients' `relativeEnvPaths` under `apps/backend/src/generated/`.

### `next build` breaks a running `next dev`

- **What happens:** after a build, the running dev server answers 500 with
  `Cannot find module './vendor-chunks/…'`.
- **Why:** both write `.next`.
- **Do this:** verify a production build with `pnpm build:check`, which builds
  into its own `NEXT_DIST_DIR`.
- **Where:** `apps/frontend/next.config.mjs` (`NEXT_DIST_DIR`),
  `apps/frontend/scripts/build-check.mjs`.

### A running API keeps the old Prisma client after `pnpm db:generate`

- **What happens:** after a schema change and `pnpm db:generate`, the API
  started by `pnpm dev` recompiles the new code and then answers its new
  queries with a 500 (`INTERNAL_ERROR`), while the integration suites, which
  load the client from `src/`, pass. Seen 2026-10-09 with `payeeStaffId` (0081).
- **Why:** `nest start --watch` runs `dist/`, and the Prisma clients reach
  `dist/generated` only as assets. `nest-cli.json` sets `"watchAssets": false`,
  so the watcher recompiles TypeScript but never re-copies the regenerated
  client: the code asks for a column the loaded client does not know.
- **Do this:** restart `pnpm dev` (the initial build copies the assets) after
  every `pnpm db:generate`. `diff -rq apps/backend/src/generated apps/backend/dist/generated`
  shows whether `dist/` is behind.
- **Where:** `apps/backend/nest-cli.json` `compilerOptions.assets` and
  `watchAssets`.

### Three Node versions, and an unknown fourth

- **What happens:** something that passes CI can behave differently where it
  runs.
- **Why:** `engines` says `>=20`, `apps/backend/Dockerfile` uses
  `node:20-alpine`, `ci.yml` and `migrate-database.yml` use Node 22, and
  `deploy-backend.yml` builds the production bundle on Node 24. The Node
  version on the Lightsail box is **Unverified**.
- **Do this:** when behaviour depends on the runtime (globals, crypto, fetch),
  check it on the version the target uses. **Undecided:** one version for all.
- **Where:** root `package.json` `engines`, the three workflows, the Dockerfiles.

### `.dockerignore` excludes env files only at the root

- **What happens:** `apps/backend/.env`, `apps/frontend/.env.local`,
  `backup-key.txt` and anything in `apps/backend/backups/` enter the build
  context, and `COPY . .` puts them in the `build` stage.
- **Why:** `.dockerignore` patterns match from the context root, so `.env`
  matches only `./.env`. The final `runner` stages copy selected paths only.
- **Do this:** do not build images on a machine holding real secrets in those
  files. The fix is to add these lines to `.dockerignore`:

  ```
  **/.env
  **/.env.*
  backup-key.txt
  apps/backend/backups/
  ```

- **Where:** `.dockerignore`, `apps/backend/Dockerfile` and
  `apps/frontend/Dockerfile` stage `build`.

## Database and migrations

### Prisma reloads `apps/backend/.env`

- **What happens:** any Prisma command, and any script that builds a Prisma
  client, layers `apps/backend/.env` over the environment it was given.
- **Why:** Prisma autoloads the file next to its schema. dotenv does not
  overwrite variables already set, but that is a library default.
- **Do this:** after a write to a target, reconnect and re-read it, as
  `deploy.mjs` `verifyApplied` does. The scripts in `apps/backend/src/scripts`
  (`staff:create`, `cadastre:import`, the backfills) have no target guard of
  their own: run `pnpm db:check` first, and never with a staging
  `DATABASE_URL` exported.
- **Where:** `scripts/db/deploy.mjs` `verifyApplied`; incident 3 in
  [incidents.md](incidents.md).

### Bare Prisma migrate commands aim at `public`

- **What happens:** `prisma migrate deploy` with the tenant schema runs tenant
  DDL in `public`, then every later deploy stops with P3009.
  `prisma migrate resolve` writes ledger rows the tenant migrator never reads.
- **Why:** both datasources use `DATABASE_URL` without `?schema=`, so Prisma
  targets `public`. Tenant history lives in `"tenant_<slug>"._tenant_migrations`.
- **Do this:** only `pnpm db:deploy:<target>`
  ([database.md](database.md#name-the-target)).
- **Where:** `scripts/db/migration-state.mjs` `missingHistory`;
  [database-environments.md](database-environments.md#when-the-migration-history-is-missing).

### Catalog guards are database-wide

- **What happens:** `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)`
  is true for the first municipality and false for every other, so the
  constraint is silently skipped and the ledger says "applied".
- **Why:** system catalogs ignore `search_path`; constraint names are per schema.
- **Do this:** join `pg_namespace` and filter `nspname = CURRENT_SCHEMA()`.
- **Where:** `migration-guards-are-schema-scoped.spec.ts`,
  `0050_constraints_missed_by_global_guards`, the `DO` block in
  `0066_payment_tender_controls`.

### Unqualified raw SQL fails intermittently

- **What happens:** `42P01 relation "…" does not exist` on a table that exists,
  once, under load. Staging hit it on 2026-09-10 behind the old Supabase pooler.
- **Why:** Prisma qualifies model queries itself, but sends raw SQL as written,
  so a bare table name resolves through the session's `search_path`.
- **Do this:** `FROM ${this.S}table` with `tenantSchemaRef`. CI fails the build
  otherwise.
- **Where:** `tenant-schema-ref.ts`, `raw-sql-is-schema-qualified.spec.ts`.

### plpgsql bodies resolve names when they run

- **What happens:** a function called without the tenant `search_path` fails or
  writes to another schema. Under `pg_restore`'s empty `search_path`, the
  generated column calling `search_compact` failed, so production could not be
  restored from its own dump.
- **Why:** a function body is resolved against the caller's `search_path`, not
  the one it was created under.
- **Do this:** `ALTER FUNCTION … SET search_path = <schema>, pg_catalog`, or
  qualify calls with the schema.
- **Where:** `0030_building_census`, `0048_search_compact_schema_qualified`.

### A new enum value cannot be used in its own migration

- **What happens:** a migration that adds a value and then uses it fails.
- **Why:** the migrator wraps every migration in one transaction, and Postgres
  refuses to use a value added in the same transaction.
- **Do this:** `ADD VALUE` alone in one migration, its use in the next.
- **Where:** `0062_status_conflict_case`, `0063_status_conflict_one_open`,
  `tenant-migrator.ts` `migrateTenantSchema`.

### A CHECK passes on NULL, so `=` against a nullable column lets the row in

- **What happens:** `CHECK ("responsibleOwnerId" IS NULL OR "ownerBillingMode" = 'RESPONSIBLE_OWNER')`
  accepted a responsible owner on a flat with no method chosen. The first draft of
  `0075` did exactly this, and only exercising the CHECK on a seeded row caught it.
- **Why:** with `ownerBillingMode` NULL, `NULL = 'RESPONSIBLE_OWNER'` is NULL, `false
  OR NULL` is NULL, and a CHECK fails only on false.
- **Do this:** compare a nullable column with `IS NOT DISTINCT FROM` (or test `IS NOT
  NULL` first), and prove every CHECK refuses the row it exists for before shipping.
- **Where:** `0075_unit_owner_billing` (`units_responsible_owner_needs_mode`), `0077`'s
  `units_fee_exemption_other_note` (`IS DISTINCT FROM`).

### No `CREATE INDEX CONCURRENTLY`

- **What happens:** it errors inside the migrator.
- **Why:** same transaction wrapper.
- **Do this:** a plain index, with the lock justified by table size in the
  header ([database.md](database.md#how-tenant-migrations-run)).
- **Where:** `tenant-migrator.ts`, the `0066` header.

### The folder name is the ledger key

- **What happens:** an edited applied migration never re-runs, so environments
  diverge silently. A renamed one becomes pending and its SQL runs again. A
  lower number merged late is applied out of order.
- **Why:** `_tenant_migrations` stores folder names only, and the migrator
  sorts folders lexicographically.
- **Do this:** never edit or rename an applied migration; renumber only before
  merge. `deploy.mjs` merely prints "Pending migrations that sort before one
  already applied".
- **Where:** `tenant-migrator.ts` `loadTenantMigrations`,
  `migration-state.mjs` `outOfOrder`.

### Migration numbers collide across branches

- **What happens:** two branches pick the same number and nothing errors.
  `0016_*` and `0017_*` each exist twice; `0059_staff_refresh_tokens` was merged
  to `develop` after `0066`, so it applies out of order (the migrator warns and
  applies it).
- **Why:** numbers are chosen by hand per branch.
- **Do this:** list every unmerged branch's migrations before picking one
  ([database.md](database.md#numbering)).
- **Where:** `apps/backend/src/infrastructure/prisma/tenant/migrations`.

### A transaction client has no `$transaction`

- **What happens:** `this.db.$transaction(...)` throws when the code runs inside
  `runInTenantTransaction`.
- **Why:** the scope swaps in the transaction client, which lacks
  `$transaction`.
- **Do this:** use `runInTenantTransaction`, which joins an open transaction.
- **Where:** `tenant-transaction.ts`; `BuildingsService.atomic` is the
  workaround.

### Side effects inside a transaction are lost or premature

- **What happens:** an audit row written from an event listener near the end of
  the work fails with "Transaction already closed" and is lost; a cache
  invalidated before commit is refilled with stale data for its whole TTL.
- **Why:** listeners run synchronously in the emitting scope, which holds the
  transaction client.
- **Do this:** queue the work on `scope.transaction.afterCommit`, or emit after
  the transaction returns.
- **Where:** `tenant-transaction.ts` `runInTenantTransaction`,
  `AuditService.record`.

### `instanceof` does not cross the two generated clients

- **What happens:** an error from the registry client is not an `instanceof`
  the tenant client's `PrismaClientKnownRequestError`, so a check silently
  misses it.
- **Why:** each generated client has its own error classes.
- **Do this:** match `error.code` structurally.
- **Where:** `with-connection-retry.ts` `isTransientConnectionError`.

### A Radix Select drops a value set while its list is closed

- **What happens:** setting a controlled `Select`'s value from code — after
  creating the option the user should land on, say — appears to work for a
  render or two and then resets to empty, so the trigger falls back to its
  placeholder even though the option is in the list. A value present when the
  Select *mounts* is kept; one assigned later, while the content is closed, is
  not: the item backing it has never mounted, so nothing is registered for it.
- **Do this:** remount the Select when the option set gains the new value
  (`key` on a counter of additions), which hands Radix the value at mount time.
  Passing `SelectValue` children fixes only the visible label, not the value.
  Refetching the options while the form is open makes it worse, not better.
- **Where:** `record-expense-form.tsx`, the «بند الصرف» select.

### Two requests creating the same singleton row

- **What happens:** `upsert` on a row that does not exist yet (`system_settings`, keyed by `singleton`)
  is a read then an insert. Two requests arriving together both read nothing and both insert; the
  loser fails with a raw unique violation (`P2002`) instead of the domain answer it should give,
  and inside a transaction the violation aborts the whole transaction.
- **Do this:** `INSERT … ON CONFLICT DO NOTHING` (raw, schema-qualified), then read and lock the
  row. `TreasuryService.activate` does; `treasury.integration.spec.ts` pins it with two
  simultaneous activations.
- **And commit it first** when other transactions wait on that row's lock. A row your
  transaction inserted is invisible to them: a `FOR SHARE` reader finds nothing to wait on,
  reads nothing, and goes ahead. A payment taken while the first activation of a
  municipality with no settings row was committing read no go-live stamp and credited no
  wallet. `activate` inserts the singleton in its own statement before its transaction opens
  (`treasury-controls.integration.spec.ts` pins it).
- **Where:** `treasury.service.ts`.

### Append-only triggers fire through cascades

- **What happens:** deleting a `citizen_payments` row cascades into
  `payment_transactions` and raises. `BackupService` restore aborts for any
  municipality that has taken a payment.
- **Why:** `payment_transactions_no_delete` rejects every row delete, including
  cascaded ones.
- **Do this:** treat the abort as the control working. Never `TRUNCATE` or set
  `session_replication_role` to get round it. `treasury_entries` (0073) behaves the same way: its
  foreign keys are RESTRICT, so deleting a staff member or a wallet that moved money is refused.
- **Where:** `0017_payment_ledger`, the `BackupService` comment above
  `TABLE_ORDER`.

### A Prisma `DateTime` with no `@db` attribute may be a `TIMESTAMPTZ` column

- **What happens:** raw SQL that buckets by day reads the wrong day. `("occurredAt"
  AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Beirut')::date` is right for a bare
  timestamp holding UTC. On a `TIMESTAMPTZ` column it moves every boundary six
  hours, so a collector's 01:00 receipt counted for the day before.
- **Why:** a Prisma field with no native-type attribute says nothing about the
  column. `payment_transactions.occurredAt` is `TIMESTAMPTZ` in 0017, and the model
  carried a bare `DateTime` until the PR #104 review.
- **Do this:** read the column's type in its migration before writing time-zone SQL.
  On `TIMESTAMPTZ` one `AT TIME ZONE 'Asia/Beirut'` gives the wall clock; the two-step
  form is for a bare `TIMESTAMP`.
- **Where:** `transfers.service.ts` `collectedToday`, `audit.repository.ts` (a bare
  timestamp, two steps), `schema.prisma` `PaymentTransaction.occurredAt`.

### A bare `timestamp` compared with a bound `Date` follows the session's zone

- **What happens:** `"createdAt" >= ${since}` in raw SQL matches on a database whose
  zone is UTC and misses by two or three hours on one set to Asia/Beirut. Invoice
  numbering matched no bill there, and every issue rolled back.
- **Why:** Prisma binds a JS `Date` as `timestamptz`. Comparing it with a bare
  `timestamp` (Prisma's default for `DateTime`: `citizen_payments.createdAt` and the
  other pre-treasury columns) converts the column through the session's `TimeZone`.
- **Do this:** bring the value to the column: `"createdAt" >= (${since}::timestamptz AT
  TIME ZONE 'UTC')`. The treasury tables are `TIMESTAMPTZ` and compare safely. To test,
  give one client `options=-c TimeZone=Asia/Beirut` in its URL; changing the database's
  default would move every suite sharing it.
- **Where:** `fees.service.ts` `numberInvoices`, `invoice-numbering.integration.spec.ts`.

### A foreign-key check locks the row it points at

- **What happens:** two transactions that each insert a row referencing the same
  wallet, then lock that wallet `FOR UPDATE`, deadlock. An expense and a collector's
  handover on one safe did, 17 times in 25 rounds.
- **Why:** the insert's foreign-key check takes `FOR KEY SHARE` on the referenced
  row. Upgrading it to `FOR UPDATE` waits for every other holder of the weak lock,
  and each waits for the other.
- **Do this:** take the strong lock first, in id order, before writing anything that
  references the row (`TreasuryLedgerService.lockAccounts`).
- **Where:** `expenses.service.ts`, `transfers.service.ts`,
  `treasury-ledger.service.ts` (`lockAccounts`, `refundDrafts`).

### A statement takes at most 32,767 bind variables

- **What happens:** a raw query built as a `VALUES` list with a parameter or two per
  row fails with `too many bind variables` once the list is long enough. Invoice
  numbering did, from 16,384 bills: a town-wide notice rolled back whole.
- **Why:** a statement is limited to 32,767 bind variables (the error says so). Prisma's
  `createMany` splits itself; a raw query does not.
- **Do this:** pass one array parameter and `unnest(${values}::text[]) WITH
  ORDINALITY`.
- **Where:** `fees.service.ts` `numberInvoices`.

### Integration suites drop schemas wherever `TEST_DATABASE_URL` points

- **What happens:** every `*.integration.spec.ts` runs
  `DROP SCHEMA … CASCADE` and rebuilds a fixed `tenant_*_spec` schema in the
  named database. A later `backup.mjs` run there would discover those schemas.
- **Why:** nothing compares `TEST_DATABASE_URL` with `targets.mjs`.
- **Do this:** a throwaway Postgres 17 container only
  ([database.md](database.md#test-a-migration-on-a-throwaway-postgres-17)).
- **Where:** `tenant-test-client.ts`, each integration spec's `beforeAll`.

### Postgres 17 only

- **What happens:** on Postgres 16 the tenant migrations fail at `0044`.
- **Why:** `0044_mother_name` uses `ALTER COLUMN … SET EXPRESSION`, new in 17.
- **Do this:** use 17 for the local database, test containers and restores.
- **Where:** `docker-compose.yml` `postgres`, the `ci.yml` service,
  `migrate-database.yml`.

### `pg_dump` on a GitHub runner is version 16

- **What happens:** with the 17 client installed, `pg_dump` still resolves to
  16 and refuses to dump a 17 server.
- **Why:** the runner image ships a Postgres 16 server, and Debian's
  `pg_wrapper` picks the client to match it.
- **Do this:** put `/usr/lib/postgresql/17/bin` first on `PATH` and assert the
  version.
- **Where:** `migrate-database.yml`, step "Install Postgres 17 client and age".

### Advisory-lock keys must match character for character

- **What happens:** two writers that build the key differently take different
  locks, and the building-suffix race returns.
- **Why:** the key is a string hashed by `hashtext`, built separately in each
  service.
- **Do this:** change both together, or extract one helper.
- **Where:** `BuildingsService.create`, `ParcelCorrectionService`
  (`<schema>:building-suffix:<parcel>`).

### A push to `main` migrates production before CI finishes

- **What happens:** production is migrated and the API redeployed while the CI
  run for the same commit may still fail.
- **Why:** `deploy-backend.yml` has no dependency on `ci.yml`, and branch
  protection on `main` requires one approving review and no status check (read
  from the GitHub API on 2026-10-03).
- **Do this:** do not merge to `main` until CI is green on the release branch.
  **Undecided:** gating the deploy on CI.
- **Where:** `.github/workflows/deploy-backend.yml` job `migrate`.

## Backend runtime

### An optional phone must read an empty box as absent

- **What happens:** two spellings of "optional phone" go wrong. With
  `.or(z.literal(''))`, a malformed number is refused with «Invalid input»
  instead of «رقم الهاتف غير صالح», on an Arabic-first form. With a bare
  `internationalPhone.optional()`, the `''` a cleared box holds is refused as a
  malformed number, on whatever field it sits, including one the form does not
  render. `whatsapp` did this: ticking «لا يملك رقم هاتف» writes `''` there and
  hides the box, so the step went red with no message and a citizen with no
  phone could not be saved or edited (fixed 2026-10-06). A شاغل بتسامح's
  `landlordPhone` did it on a visible box that could not be cleared.
- **Why:** the union fails all three branches, so zod reports the *union's*
  error rather than any branch's. `.optional()` accepts `undefined` and nothing
  else, and a controlled input holds `''`. Nothing is wrong with
  `internationalPhone`.
- **Do this:** use `optionalInternationalPhone`, which preprocesses the empty
  string to `undefined` so one branch remains. Test a form's payload with the
  empty strings the form sends, not an absent key (`no-phone.spec.ts`,
  `landlord-phone.spec.ts`). Send only the boxes the form is using
  (`withoutUnusedWhatsapp`): a value left in a hidden box would otherwise still
  reach validation.
- **Where:** `optionalInternationalPhone` is defined in `primitives.ts`.
  `phone`, `contactPhone` and `whatsapp` in `contactDetailsSchema`, `whatsapp`
  and `localContactPhone` in `nonResidentOwnerContactSchema`, and `landlordPhone`
  of a شاغل بتسامح in `property.schema.ts` use it. `landlordPhone` in
  `building.schema.ts` (the unit matrix) is still a bare
  `internationalPhone.optional()`: its one writer sends no blank
  (`building-unit-forms.tsx`).

### A field relaxed in the strict schema and not in its `partial*` twin throws on save

- **What happens:** a submission the strict schema accepts makes `safeParse`
  *throw* a `ZodError` instead of returning a failure, so the API answers 500
  for a value that should have saved, or been refused with a message.
- **Why:** `shapeSubmission` re-parses each section and card with
  `partialContactDetailsSchema` and `partialPropertyEntrySchema`, whose rules
  restate the field one by one and which throw rather than report. That is safe
  only because the strict pass has already vetted every value that reaches
  them, so the two must accept the same values.
- **Do this:** change a field in both, and test through
  `adminCreateCitizenSubmissionSchema` or `adminUpdateCitizenSubmissionSchema`,
  not the card or section alone (`landlord-phone.spec.ts`).
- **Where:** `admin-citizen.schema.ts` `shapeSubmission`; `property.schema.ts`
  `occupancyBranch` and `partialPropertyEntrySchema`.

### A `.default()` on a citizen form flag arrives absent, not defaulted

- **What happens:** `contact.hasNoPhone` is `undefined` on a parsed submission
  that did not send it, although the schema declares `.default(false)`. Code
  written as `!== false` then reads a plain household record as having no phone.
- **Why:** `shapeSubmission` parses the sections through
  `partialContactDetailsSchema` / `partialPersonalDetailsSchema`, and zod's
  `.partial()` strips the default along with the requirement. The strict
  schemas are used for *reporting* issues, not for the shape that is written.
- **Do this:** read such a flag as `=== true`. Put normalisation that must
  reach the database on the partial schema too — `contactDetailsSchema` alone
  does not run on the save path.
- **Where:** `admin-citizen.schema.ts` `shapeSubmission`; pinned by
  `no-phone.spec.ts`.

### The tenant middleware path must stay `t/:tenantSlug/*`

- **What happens:** with a named wildcard (`*path`) the middleware matches
  nothing, and every tenant route runs without a tenant scope.
- **Why:** path-to-regexp 0.1.x (Express 4) reads `*path` as `(.*)` followed by
  literal text.
- **Do this:** keep the bare `*`.
- **Where:** `PresentationModule.configure`.

### A route outside `t/:tenantSlug` has no tenant

- **What happens:** `TenantContextService.require` throws "Tenant context is
  missing", and an authenticated route answers `TenantMismatchError`.
- **Why:** only `t/:tenantSlug/*` runs `TenantMiddleware`, and `JwtAuthGuard`
  compares the token's tenant with `request.tenant`.
- **Do this:** put tenant controllers under `@Controller('t/:tenantSlug/…')`.
- **Where:** `tenant-context.service.ts` `require`, `JwtAuthGuard.canActivate`.

### `@UsePipes(ZodValidationPipe)` validates every parameter

- **What happens:** the route fails every request, because `tenantSlug` is
  validated against the body schema.
- **Why:** a method-level pipe runs on each parameter.
- **Do this:** put the pipe on `@Body(new ZodValidationPipe(schema))`.
- **Where:** the comment on `AuthController.loginStaff`.

### A static path after `:id` is read as an id

- **What happens:** `GET review-queue` declared after `@Get(':id')` reaches the
  `:id` handler.
- **Why:** Express matches routes in declaration order.
- **Do this:** declare static paths before `:id`.
- **Where:** `CitizenController`, the comment above `review-queue`.

### `ApiRequestError.message` is translated; branch on `kind`

- **What happens:** a screen compares `error.payload.code === 'CONFLICT'` and stops
  matching once the throw site is converted to a specific code such as
  `PAYMENT_ALREADY_PAID`.
- **Why:** `code` is now the specific code when there is one; the class is `kind`.
  `ApiRequestError` also builds its `message` from `messages/{ar,en}.json` through
  `localizeApiError`, so the server's text is no longer what a screen shows.
- **Do this:** branch on `error.kind` for the class and on `error.code` for one specific
  case; show `error.message`.
- **Where:** `apps/frontend/lib/api-client.ts` (`ApiRequestError`),
  `apps/frontend/lib/api-errors.ts` (`localizeApiError`).

### A Tier 1 audit row that cannot be written undoes the change

- **What happens:** a payment, an ownership change or a citizen status change fails with
  a 500, and nothing changed, because its audit insert was refused (for example a non-uuid
  `actorId`, or an `actorRole` outside the `StaffRole` enum).
- **Why:** Tier 1 rows are written inside the change's transaction on purpose. Under the
  old after-commit path the same bad row was caught and logged as `AUDIT WRITE FAILED`:
  that is how every Whish settlement went unaudited (`actorId: 'WHISH'`).
- **Do this:** a system actor is `actorType: 'SYSTEM'` with `actorId: null`; name a
  provider in `after`. Run the integration suite for the service you changed.
- **Where:** `AuditService.recordInTransaction`; `audit_log_entries.actorId` (`@db.Uuid`),
  `actorRole` (`StaffRole?`) in the tenant `schema.prisma`.

### Two reference numbers, one format, one credential

- **What happens:** a value shaped like `BZR-2607-4K9QX2` is written into a log or an
  audit row as harmless, and it signs a citizen in; or a filing number is masked for no
  reason.
- **Why:** `ReferenceNumber.generate` mints both `users.referenceNumber`, the citizen's
  رقم مرجعي that `loginByReferenceOnly` accepts on its own, and
  `registrations.referenceNumber`, the filing's own number, which signs nobody in.
  Same format, same key name, different risk.
- **Do this:** treat any `referenceNumber` read from `users` as a credential: in an audit
  row or on an audit screen it goes through `ReferenceNumber.mask`. A registration's
  may be written in full.
- **Where:** `domain/value-objects/reference-number.vo.ts`;
  `RegistrationService.submit` (`citizenReference`, `registrationReference`).

### A field added to the staff profile reaches the citizen portal

- **What happens:** a field added to `ReportingService.getCitizenProfile` for a staff
  screen shows up in «ملفّي», the citizen's own portal page, unless someone thinks to
  take it out. `hasNoPhone` and `contactPhone` added to a flat's owners (2026-10-06) would
  have sent a co-owner's relative's number to the tenant.
- **Why:** `CitizenController.mySummary` builds the portal's properties and units by
  destructuring the named fields out (`landlordCitizenId`, `landlordReferenceNumber`) and
  spreading the rest, so everything not named passes through.
- **Do this:** when you add a field to the profile, decide whether the citizen sees it
  and say so in `mySummary`. A flat's owners are an allowlist there (name and أسهم);
  `citizen-portal.spec.ts` pins it.
- **Where:** `presentation/controllers/citizen.controller.ts` `mySummary`;
  `reporting.service.ts` `CitizenProfile`.

### Re-recording an owner from the drawer used to wipe their أسهم

- **What happens:** «تعديل» on an owner in the unit drawer, with the أسهم box left
  empty, wrote `shares: null` over the أسهم on file. Harmless while nothing read
  them; since `0075` a flat billed «حسب الأسهم» then refuses to bill.
- **Why:** the drawer sends no `shares` for an empty box, and `recordOccupancy`'s
  update wrote `input.shares ?? null`.
- **Do this:** an absent value keeps what is on file (`input.shares ?? current.shares`);
  أسهم are recorded or corrected beside the billing method, in «توزيع الرسم على المالكين».
- **Where:** `BuildingsService.recordOccupancy`; pinned by
  `co-owner-billing.integration.spec.ts`.

### Granting an exemption reaches back; lifting one does not

- **What happens:** «معفاة من الرسوم» granted on a unit lists, in «فواتير تأثّرت بتصحيحات»,
  every open bill on it whose figure now differs — raised last week or last year. Lifting the
  same exemption lists none of the bills raised before the lift.
- **Why:** `traceChanges` reads `UNIT_FEE_EXEMPTION_SET` as a CORRECTION (the mosque was a
  mosque before anyone ticked the box, so a bill raised on it was raised on a wrong register)
  and `UNIT_FEE_EXEMPTION_LIFTED` as a DATED_CHANGE on its day, like a damage reading or a
  co-owner billing method (the user's decision, 2026-10-08). A change of reason on a standing
  exemption is also a SET, but leaves the figure as it was, so it lists nothing.
- **Do this:** do not "fix" the asymmetry. The listing never changes a bill; the accountant decides.
- **Where:** `fees/bill-corrections.ts` `traceChanges`; pinned in `bill-corrections.spec.ts`.

### Archiving a co-owner re-divides the flat from then on, and no raised bill is listed for it

- **What happens:** «أرشفة الملف» on one owner of a co-owned flat changes every other owner's part
  from the next bill: four brothers at 1/4 become three at 1/3, and an archived «مالك مسؤول» falls
  back to the equal split. Restoring the file divides it by four again. «فواتير تأثّرت بتصحيحات»
  lists none of the bills already raised at the old part.
- **Why:** billing divides a flat between open files only (`activeOwnerSpells`), so the archive
  moves the division; but the archive is one `CITIZEN_DEACTIVATED` / `CITIZEN_REACTIVATED` row on
  the archived person's own file, which `traceChanges` reads for that person alone and which is not
  in `FILE_ACTIONS`. Deliberately: an archive runs forward, like a sale or a damage reading, and a
  bill raised before it was right when it was raised.
- **Do this:** treat it as a forward change. If a file was archived in error and the other owners
  were billed more in the meantime, that is a manual correction of those bills, not something the
  correction screen will find. «ملاحظات الجودة» flags an archived responsible owner
  (`OWNER_BILLING_BLOCKED`).
- **Where:** `buildings/owner-billing.ts` `activeOwnerSpells`; `fees/bill-corrections.ts`
  `FILE_ACTIONS`, `traceChanges`.

### Events are synchronous strings

- **What happens:** a misspelt event name is dropped silently; a listener on
  `staff.*` never fires. Until it was made Tier 1, `payment.reversed` was emitted with
  no listener, so a reversal wrote no audit row for months without anyone noticing.
- **Why:** `EventEmitterModule` is synchronous with no wildcards, and names are
  free strings. Synchronous is deliberate: listeners run in the emitting
  request's tenant scope, and an async emitter would write audit rows to
  whichever tenant is current.
- **Do this:** grep for an `@OnEvent` handler for every name you emit. Keep
  emission synchronous.
- **Where:** `AppModule` comment on `EventEmitterModule`,
  `FeesService.reverseTransaction`, `AuditService`.

### Every client shares one throttle bucket

- **What happens:** the 5-per-minute staff-login limit applies to all staff of
  all municipalities together, so one person can lock everyone out; login
  audit rows record the proxy's address.
- **Why:** behind nginx with no `trust proxy`, `request.ip` is nginx's address,
  and the throttler stores counters in process memory.
- **Do this:** do not add limits that assume per-user buckets. Fix: `trust proxy`
  set to the exact hop (never `true`) plus a shared store
  ([security.md](security.md)).
- **Where:** `createApiApp` in `presentation/bootstrap.ts`, the
  `MetricsController` class comment, `APP_CONFIG.throttle`.

### `NODE_ENV` defaults to `development`

- **What happens:** a deployed process without `NODE_ENV=production` returns
  the OTP as `devCode`, allows `OTP_ENABLED=false`, and skips the S3
  requirements.
- **Why:** `envSchema` gives `NODE_ENV` a default, and every production check
  keys on it.
- **Do this:** set `NODE_ENV=production` on every deployed process and confirm
  it.
- **Where:** `envSchema` in `presentation/config/env.schema.ts`,
  `OtpService.issue`.

### Every process owns the schedule unless told otherwise

- **What happens:** with `SCHEDULER_ENABLED` unset, every booted process
  registers the `@Cron` jobs, including each pm2 instance and the deploy's
  port-4001 candidate, which boots with the shared `.env`. What that `.env` sets
  is **Unverified**.
- **Why:** `isSchedulerEnabled` treats unset as "not on Vercel", so true.
- **Do this:** set `SCHEDULER_ENABLED` explicitly on every process: `true` on
  exactly one, `false` everywhere else, including the local `.env`.
- **Where:** `isSchedulerEnabled`, the candidate step in `deploy-backend.yml`,
  `RecurringBillingJob`.

### Caches are per process, and some lag by minutes

- **What happens:** `invalidatePrefix` clears only this process's memory tier;
  an L2 hit is kept locally for a fixed 30 s whatever its Redis TTL; a
  revoked session lives up to 30 s; a deactivated municipality keeps serving
  for up to `TENANT_CACHE_TTL_SECONDS` (300 s).
- **Why:** `RedisCacheService` keeps an in-memory L1 per process;
  `SessionRevocationService` and `TenantService` cache on purpose.
- **Do this:** run one instance until there is a shared store, and expect the
  lag when you test revocation or deactivation.
- **Where:** `RedisCacheService.get`, `TOKEN_VERSION_TTL_SECONDS`,
  `TenantService.resolve`, `warnOnSecondInstance` in `presentation/main.ts`.

### Undeclared env vars are never validated

- **What happens:** a misspelt `WHISH_*` variable boots fine and is only logged.
- **Why:** `ConfigService.get` falls back to `process.env` for keys `envSchema`
  does not declare.
- **Do this:** declare every variable in `envSchema`.
- **Where:** the `WhishGatewayService` constructor.

### Billing periods are computed in UTC

- **What happens:** a job run at local midnight on the 1st would bill the
  previous month.
- **Why:** `periodKeyFor` uses `getUTCFullYear` / `getUTCMonth`.
- **Do this:** keep `timeZone: 'UTC'` on the `@Cron` decorators and `TZ=UTC` on
  hosts; `main.ts` only warns on another `TZ`.
- **Where:** `periodKeyFor` in `fees.service.ts`, `RecurringBillingJob`,
  `warnOnNonUtcClock`.

### `cadastre:import` can upload to the real bucket

- **What happens:** with `AWS_REGION` and `S3_CADASTRE_BUCKET` set, a local
  import overwrites the shared cartography assets.
- **Why:** the script uploads whenever both are present.
- **Do this:** keep every `AWS_*`, `S3_*` and `SUPABASE_*` variable out of the
  local `.env` and your shell. `pnpm db:seed` scrubs them for its own run.
- **Where:** `src/scripts/import-parcels.ts`, `clearRemoteCredentials` in
  `src/scripts/seed.ts`.

### A name joined by hand drops «ورثة المرحوم»

- **What happens:** an estate's bill, roster row or tenant card reads «حسن
  واكد سرور», as if the man who died were the one being billed, while every
  other screen says «ورثة المرحوم حسن واكد سرور».
- **Why:** an estate (`0076`) keeps the deceased's own name in the row; the
  prefix is added when it is shown. `[firstName, lastName].join(' ')` shows the
  row.
- **Do this:** name a citizen through `citizenDisplayName` (shared-schemas),
  with `residence` in the select. It also reads an institution's name, which
  is one line stored across `firstName`/`lastName` (`splitInstitutionName`), so
  a search or a sort on `lastName` alone does not find «وقف مسجد البلدة».
  The opposite holds when a name is **written** into another row (a tenancy
  card's owner name): use `citizenStoredName`, never the display name — the
  heirs' sale once wrote «ورثة المرحوم …» onto a tenant's card. Text someone
  typed is matched through `withoutEstatePrefix` (SQL: `ESTATE_PREFIX_PATTERN`).
  A card's `landlordName` **as submitted** goes through `storedLandlordName`
  on the server, at every write: the owner lookup and the unit matrix answer
  with display names, «نعم، هو المالك» and the sole-owner prefill copy them
  into the card, and a queued offline save carries whatever the form held.
  The form strips it too (`landlordNameToSend`), and `landlordLink` carries
  `name` (stored, the one sent) apart from `displayName` (the one shown).
- **Where:** `fees.service.ts`, `reporting.service.ts`, `citizens.service.ts`,
  `buildings.service.ts` (`toOccupancyRow`), `parcel-dues.service.ts`.

### «ليس مقيماً» is not one value any more

- **What happens:** an estate or a waqf is asked for a mother's name, offered
  «مشغولة من المالك», or billed a per-head flat amount.
- **Why:** «not a household» used to be `residence === 'NON_RESIDENT_OWNER'`,
  and `0076` added `ESTATE` and `INSTITUTION`, which are not households either.
- **Do this:** ask `isOwnerRecord` (not a household) or `isNonPersonRecord`
  (not a living person). A new check against the one value misses two kinds.
- **Where:** `packages/shared-schemas/src/enums.ts`.

### A plain `$transaction` closes after five seconds

- **What happens:** `Transaction already closed ... The timeout for this transaction
  was 5000 ms`, under load, on work that is fine on a quiet machine. A town-wide
  notice's insert and numbering hit it.
- **Why:** Prisma's interactive transactions default to `timeout: 5000`.
  `runInTenantTransaction` passes 60 s; a direct `this.db.$transaction(...)` does
  not.
- **Do this:** pass `{ maxWait: 15_000, timeout: 60_000 }` to a direct
  `$transaction` that does bulk work.
- **Where:** `fees.service.ts` (the two bill-raising transactions).

### `value * 100` is not a two-decimal check

- **What happens:** `Math.abs(v * 100 - Math.round(v * 100)) < 1e-6` refused valid
  amounts from about 134 million and let `1e-9` through. A DECIMAL(14,2) column then
  rounded that to 0.00, and its CHECK refused it with a server error.
- **Why:** float arithmetic. From 2^27 the error in `v * 100` exceeds the tolerance.
- **Do this:** judge the number's decimal form: `hasAtMostTwoDecimals` in
  `packages/shared-schemas/src/money-amount.ts`.
- **Where:** the money fields of `treasury.schema.ts`, `expense.schema.ts` and
  `transfer.schema.ts`.

## Auth

### A route without `@Roles` is open to citizens

- **What happens:** any authenticated token of the municipality, citizen
  included, reaches the handler.
- **Why:** `RolesGuard` returns true when there is no `@Roles` metadata.
- **Do this:** give every non-public route `@Roles(...)`, or an explicit
  `user.kind` check plus `user.sub` scoping ([security.md](security.md)).
- **Where:** `roles.guard.ts` `RolesGuard.canActivate`.

### A method `@Roles` replaces the class `@Roles`

- **What happens:** `StaffController` is `SUPER_ADMIN` at class level, yet
  `t/:tenantSlug/staff/inspector/me/profile` is open to six roles.
- **Why:** `getAllAndOverride` takes the handler's metadata first.
- **Do this:** read the method decorators before assuming the class guard
  applies.
- **Where:** `StaffController.getMyProfile`.

### Starting TOTP enrolment switches 2FA off

- **What happens:** calling `t/:tenantSlug/auth/staff/totp/enrol` leaves
  the account with no confirmed second factor until it is confirmed.
- **Why:** `saveTotpSecret` sets `totpConfirmedAt` to null.
- **Do this:** never call enrol to "look at" a secret.
- **Where:** `PrismaUserRepository.saveTotpSecret`.

### A token signed with `JWT_SECRET` is a session

- **What happens:** any JWT signed with the session key passes `JwtAuthGuard`.
- **Why:** the guard checks no purpose claim.
- **Do this:** sign non-session tokens with a derived key, as password reset
  does.
- **Where:** `IdentityService` `resetSigningKey`.

### `/metrics` answers loosely matched paths

- **What happens:** it also answers `/METRICS` and `/Metrics/`, so an nginx
  `location /metrics` rule does not close it.
- **Why:** Express matching is case-insensitive and ignores a trailing slash.
- **Do this:** rely on `METRICS_TOKEN`; unset, the route answers 404.
- **Where:** `MetricsController`, `APP_CONFIG.metricsPath`.

### Citizen OTP sign-in cannot work in production

- **What happens:** OTP requests fail closed in production, so the
  reference-only route, `t/:tenantSlug/auth/citizen/reference/open`, is the
  real front door. With `OTP_ENABLED=false` (refused in production), a phone
  number alone signs a citizen in.
- **Why:** `SmsProviderService` has no provider; its `deliver` throws.
- **Do this:** account for it when you judge the reference-only path.
- **Where:** `SmsProviderService`, `OtpService.issue` and `verify`,
  `envSchema`.

### Staff and citizen sessions share one storage key

- **What happens:** signing in as one kind in a browser silently replaces the
  other kind's session for that municipality.
- **Why:** both use `mechanization.session.<tenant>`.
- **Do this:** use two browser profiles to test both at once.
- **Where:** `apps/frontend/lib/session.ts` `key`.

## Frontend

### A form moved from a dialog to a page stays mounted after it succeeds

- **What happens:** the fee wizard, once a dialog that closed itself on success, became the
  page `fees/new`. After a successful issue, `router.push` started the navigation, `finally`
  re-enabled the button, and the page stayed on screen until the next route was ready.
  A second press there issued the notice again and billed every household twice.
- **Why:** a dialog's `onOpenChange(false)` removes the form at once; a page is replaced
  only when the next route has loaded, which can take seconds on a village connection.
- **Do this:** guard with a synchronous `useRef` in-flight flag and release it only on
  failure. A form that has succeeded stays locked until it leaves.
- **Where:** `app/[tenant]/[locale]/[adminPath]/(protected)/fees/new/page.tsx` `issue`.

### A retry key thrown away on failure pays twice

- **What happens:** a money form that regenerated its `clientRequestId` in every `catch` sent
  a new key when the clerk pressed again after a dropped connection. The server had already
  recorded the first press, and recorded the second as a new voucher.
- **Why:** a network error, or a 5xx, says nothing about whether the write happened.
- **Do this:** `newRequestId()` once per act. Renew it only on a refusal (a 4xx, `isRefusal`)
  or when the figures change (`apps/frontend/lib/request-id.ts`, as the settle page does).
- **Where:** `record-expense-form.tsx`, `collector-custody-panel.tsx`, and the citizen payment
  page that first did it right.

### `cn()` uses tailwind-merge 3 on Tailwind 3.4

- **What happens:** `cn('min-h-9', 'min-h-touch')` keeps both classes, and
  `cn('shadow-sm', 'shadow-xs')` keeps only `shadow-xs`, which Tailwind 3.4
  does not generate, so the shadow disappears.
- **Why:** tailwind-merge 3.x targets Tailwind 4's theme. It does not know the
  custom `touch` spacing, and it knows `shadow-xs`.
- **Do this:** do not rely on `cn` to resolve `*-touch` conflicts, and do not
  use `shadow-xs`. **Undecided:** pin tailwind-merge 2.6 or extend its config.
- **Where:** `apps/frontend/lib/utils.ts` `cn`, `tailwind.config.ts`
  `spacing.touch`.

### `toISOString().slice(0, 10)` is the UTC date

- **What happens:** a record dated "today" between 00:00 and 03:00 Beirut time
  gets yesterday's date.
- **Why:** `toISOString` is UTC. Eight call sites in seven files do this
  (`audit-daily.tsx` subtracts the timezone offset first, so its call is
  local and correct).
- **Do this:** use `municipalToday` from `@mechanization/shared-schemas`, the
  municipality's calendar day whatever the browser's zone, as the damage form
  does (`lib/damage-reading.ts` `today`).
- **Where:** for example `building-unit-forms.tsx`, `end-tenancy-dialog.tsx`,
  `quality/checks-panel.tsx` `isoDaysAgo`; the full list is in
  [code-quality.md](code-quality.md#frontend-code-level).

### The two default locales disagree

- **What happens:** a URL that reaches the tenant layout with an unrecognised
  `[locale]` renders English with `dir="ltr"`.
- **Why:** `middleware.ts` `DEFAULT_LOCALE` is `ar`, `i18n/routing.ts`
  `defaultLocale` is `en`, `i18n/request.ts` falls back to the latter, and
  `TenantLayout` does not reject an invalid locale. The middleware skips any
  path containing a dot.
- **Do this:** do not trust the fallback; validate the locale in new layouts.
- **Where:** `middleware.ts`, `i18n/routing.ts`, `i18n/request.ts`,
  `app/[tenant]/[locale]/layout.tsx`.

### Toasts, tooltips and staff queries exist only under `(protected)`

- **What happens:** `useToast`, `Tooltip` and `useStaffQuery` throw or fail on
  citizen pages.
- **Why:** `ToastProvider`, `TooltipProvider` and `QueryProvider` are mounted
  only in the protected admin layout.
- **Do this:** use them only under `(protected)`, or add the providers to the
  citizen layout first.
- **Where:** `app/[tenant]/[locale]/[adminPath]/(protected)/layout.tsx`.

### `useStaffSession` returns no token on the first paint

- **What happens:** a page flashes "not signed in", or fires reads without a
  token.
- **Why:** the session is read in an effect.
- **Do this:** render a skeleton while `token` is null; `useStaffQuery` waits
  for it (`enabled: Boolean(token)`).
- **Where:** `lib/use-staff-session.ts`, `lib/use-staff-query.ts`.

### `router.replace` refetches the page's server payload

- **What happens:** every filter click refetches, or filter state goes stale.
- **Why:** `router.replace` re-requests the RSC payload; a non-null
  `history.state` skips Next's patch.
- **Do this:** use `useUrlState`, which writes with
  `history.replaceState(null, …)`, with its schema declared at module scope.
  Never put a search term in the URL.
- **Where:** `lib/use-url-state.ts`, `lib/tab-search.ts`.

### `window.location` is the previous page while a `<Link>` target renders

- **What happens:** something read from the URL during render matches the
  page the officer came from. The unit panel's «افتح ملفاً جديداً» opened the
  registration form with an empty name and phone, because its tab-storage
  seed is bound to a link that never matched.
- **Why:** on a client-side navigation Next pushes the new URL into history in
  an insertion effect after the commit, so the new page's first render (and
  its `useState` initialisers) still see the old `window.location`. A reload
  hides the bug, because a full load has the right URL from the start.
- **Do this:** read the current path and query during render with
  `usePathname()` and `useSearchParams()`, never `window.location`.
- **Where:** `app/[tenant]/[locale]/[adminPath]/(protected)/citizens/new/page.tsx`,
  `readLinkSeed` in `lib/tab-search.ts`.

### `navigator.onLine` is undefined under Node

- **What happens:** offline tests pass a drain that sends nothing.
- **Why:** Node 21+ has a global `navigator` with no `onLine`.
- **Do this:** keep the stub in `vitest.setup.ts` and flip it in tests.
- **Where:** `apps/frontend/vitest.setup.ts`.

### The service worker is never exercised in development

- **What happens:** a broken `sw.js` silently turns offline support off. A
  duplicate `const VERSION` did exactly that (`81930f1`).
- **Why:** development unregisters the worker, and its fetch handler skips
  localhost.
- **Do this:** edit `VERSION` in place, and test on a non-localhost origin.
- **Where:** `public/sw.js` `VERSION`, `lib/use-service-worker.ts`.

### A new inline script or style is blocked in production

- **What happens:** it works in development and is refused in production; a
  new third-party origin fails to connect.
- **Why:** the CSP uses a per-request nonce with `strict-dynamic`, and
  `connect-src` lists only the app, the API and Mapbox.
- **Do this:** stamp the nonce from `headers().get('x-nonce')`. Never add a
  collector to `connect-src`; Sentry goes through `/monitoring`.
- **Where:** `middleware.ts` `contentSecurityPolicy`, `TenantLayout`.

### Tenant colours must be HSL triples

- **What happens:** a hex brand colour breaks `bg-primary/90`, and an
  unchecked value from tenant config is CSS injection.
- **Why:** tokens are composed as `hsl(var(--x) / a)`.
- **Do this:** pass the value through `safeHslTriple`.
- **Where:** `app/[tenant]/[locale]/layout.tsx`.

### `[adminPath]` is not a control

- **What happens:** any value in that segment renders the staff login and every
  staff page, and Sentry receives it unredacted.
- **Why:** the frontend never checks it against the backend's `admin-config`.
- **Do this:** treat it as obscurity only; the guards are the control.
  **Undecided:** enforce or drop it.
- **Where:** `app/[tenant]/[locale]/[adminPath]`, `TenantController.getAdminConfig`.

### A cancelled request must not look like a network error

- **What happens:** a cancelled read shows «تعذّر الاتصال».
- **Why:** an `AbortError` was once folded into `NETWORK_ERROR`.
- **Do this:** keep the rethrow in `apiFetch`, and always pass `signal` through.
- **Where:** `lib/api-client.ts` `apiFetch`.

### "Remember me" moves between stores on refresh

- **What happens:** a refreshed session lands in the wrong storage.
- **Why:** `saveSession` takes the `remember` flag and picks the store.
- **Do this:** use `updateSession` when refreshing.
- **Where:** `lib/session.ts`.

### Drafts and queued records survive sign-out

- **What happens:** the next clerk on a shared PC sees the previous clerk's
  half-typed citizen and their queued offline registrations.
- **Why:** `clearSession` clears the session and tab searches only; the draft
  is keyed per municipality, not per user; the IndexedDB queue is kept on
  purpose.
- **Do this:** **Undecided** ([security.md](security.md)). Do not widen what is
  stored meanwhile.
- **Where:** `lib/session.ts` `clearSession`, `lib/citizen-draft.ts`,
  `lib/offline-db.ts`.

### A رقم العقار typed in Arabic digits misses its Latin twin

- **What happens:** «ما المستحق على العقار» for 420 answers «لا شيء مستحق»
  although a card and its bill lines say «٤٢٠».
- **Why:** `propertyNumber` is stored as typed, and the fee lines copy it.
  The query is normalised to Latin digits (`parcelDuesQuerySchema`), the rows
  are not.
- **Do this:** compare digit-normalised values on both sides — `normalizeDigits`
  in TypeScript, `translate(btrim(x), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
  '01234567890123456789')` in SQL. Over a jsonb array, guard with
  `CASE WHEN jsonb_typeof(…) = 'array' THEN … END`, not `AND`/`OR`: Postgres
  does not promise the order it evaluates them in.
- **Where:** `parcel-dues.service.ts`, `parcel-dues.ts` (`parcelShareOf`).

### `#` in a plural branch can print Arabic-Indic digits

- **What happens:** «٣ محاولات» on one machine and «3 محاولات» on another, in
  the same message, beside figures that are Latin everywhere else.
- **Why:** inside an ICU plural, `#` is the count formatted with the page's
  locale. The provider's locale is plain `ar`, and whether `ar` formats with
  Arabic-Indic digits depends on the engine's locale data (Node 26 gives Latin
  for `ar` and Arabic-Indic for `ar-LB`). A plain `{count}` is inserted as
  written.
- **Do this:** write `{count}` inside the branches, never `#`. A plain-module
  translator uses `FORMAT_LOCALE` (`ar-u-nu-latn`) from `lib/api-errors.ts`.
- **Where:** `apps/frontend/messages/ar.json`; `lib/messages-parity.test.ts`
  refuses a `#` in any Arabic message outside `errors`.

### A poll keeps its user «متصل الآن»

- **What happens:** an officer who left the dashboard open and went home reads
  «متصل الآن» on the staff screen all evening.
- **Why:** every authenticated request stamps `users.lastSeenAt`, and a timer
  that re-reads something is a request the person did not make.
- **Do this:** pass `background: true` to `apiFetch` for anything that runs on a
  timer; it sends `x-background-request`, and `JwtAuthGuard` skips the stamp.
- **Where:** `lib/api-client.ts` `apiFetch`; `getStaffPresence` and the
  notifications bell's `getPendingPayments` are the callers today.
