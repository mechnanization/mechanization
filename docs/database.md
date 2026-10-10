# Database

Last verified against the code: `fix/expense-retry-key-race` (merged with `develop@4ad0b27`), 2026-10-09.

The rules for anything that reads or writes a database: the schemas, how to
query them, how to change them, and how data may move between environments.
The operational runbook (env files, the local database, the pipeline, backups,
secrets) is [database-environments.md](database-environments.md). Why these
rules exist: [incidents.md](incidents.md). Traps: [gotchas.md](gotchas.md).

## Schemas and who owns them

One Postgres cluster per environment. Two Prisma schemas, two generated
clients.

| | Registry | Tenant |
|---|---|---|
| Postgres schema | `public` | one per municipality, `tenant_<slug>` (`TenantSlug.schemaName`: `tenant_` + slug, `-` becomes `_`) |
| Prisma schema | `apps/backend/src/infrastructure/prisma/registry/schema.prisma` | `apps/backend/src/infrastructure/prisma/tenant/schema.prisma` |
| Generated client | `apps/backend/src/generated/registry-client` | `apps/backend/src/generated/tenant-client` |
| Runtime holder | `RegistryPrismaService` | `TenantPrismaFactory.forSchema`, one cached client per schema |
| Migrations | Prisma-managed, `registry/migrations` (only `0001_init`), tracked by checksum in `public._prisma_migrations` | hand-written SQL in `tenant/migrations/NNNN_name/migration.sql`, applied by `tenant-migrator.ts`, tracked by folder name in `"tenant_<slug>"._tenant_migrations` |

### Registry (`public`)

One model, `Tenant` (`tenants`): slug, names, `schemaName`,
`adminPathSegment`, `referencePrefix`, `config`, `isActive`, `provisionedAt`.
It holds no citizen data. It maps a URL slug to the schema that holds the
municipality's data. A tenant row without `provisionedAt` is not servable.

### Tenant schemas (`tenant_<slug>`)

Every citizen, staff, census, billing and audit table lives here, once per
municipality. Isolation comes from the connection: `TenantPrismaFactory` sets
`?schema=` on `DATABASE_URL`, and `TenantMiddleware` puts that client in the
request scope. There is no `tenantId` column and no row-level security. One
database role serves every tenant schema, so a SQL bug in one request can reach
every municipality ([security.md](security.md)).

| Group | Tables | Written by |
|---|---|---|
| People | `users` (staff and citizens), `otp_challenges`, `staff_refresh_tokens` (0059: keyed hashes only, cascade with the user) | `IdentityService`, `OtpService`, `StaffService`, `CitizensService`, `StaffRefreshTokenService` |
| Citizen register | `registrations`, `property_entries`, `building_units`, `documents`, `citizen_merges` | `RegistrationService`, `CitizensService`, `LandlordLinkService`, `OwnershipService`, `TenancyService`, `CitizenMergeService`, `DocumentService` |
| Map | `parcels`, `zones` | `CadastreImportService`, `ZonesService` |
| Building census | `buildings`, `building_code_aliases`, `units`, `unit_occupancies`, `unit_visits`, `unit_vacancy_confirmations`, `damage_assessments` | `BuildingsService`, `CensusSyncService`, `DamageService`, `ParcelCorrectionService`, `UnitCorrectionService` |
| Cases | `cases` | `CasesService` |
| Fees and money | `fee_notices`, `citizen_payments`, `payment_transactions`, `billing_run_entries`, `whish_checkouts`, `system_settings`, `inspector_payouts` | `FeesService`, `PaymentLedgerService`, `CorrectionBillsService`, `StaffService` (payouts) |
| Review and quality | `record_reviews`, `quality_checks`, `data_quality_dismissals` | `RecordReviewService`, `DataQualityService` |
| Audit | `audit_log_entries` | `AuditService`, `PrismaAuditRepository` |
| Transfers (0078) | `treasury_transfers` | `TransfersService` (the collector handover; a Whish cash-out, a bank deposit and an exchange share the table and come later) |
| Expenses (0074) | `expense_categories`, `expense_vouchers` (`payeeStaffId`, 0081: the staff account a salary voucher paid, NULL otherwise; a FK to `users` that cannot say STAFF, so `recordSalary` filters `kind`) | `ExpensesService` |
| Income (0080) | `income_categories`, `income_vouchers` (`payerName` is free text that may name a citizen) | `IncomeService` |
| Document numbers (0079) | `document_counters`, one row per (book, month) | `allocateDocumentNumbers` |
| Treasury (0073) | `treasury_accounts`, `treasury_entries`, and `system_settings.treasuryGoLiveAt` | `TreasuryService` (activation, reads), `TreasuryLedgerService` (entries; called from `PaymentLedgerService` inside its transaction) |
| Ledger | `_tenant_migrations` (no Prisma model) | `migrateTenantSchema` |

Each schema also carries plpgsql functions created by migrations:
`reject_audit_mutation`, `reject_ledger_mutation`, `reject_treasury_mutation`, `search_normalize`,
`search_compact`, `sync_building_unit_counts`.

### `users` holds staff AND citizens

`users.kind` is the `UserKind` enum, `STAFF` or `CITIZEN`. Staff-only columns:
`email`, `passwordHash`, `role`, `totpSecret`, `totpConfirmedAt`. Citizen
columns include `referenceNumber` (a login credential), `identityDocNumber`,
`civilRecordNumber`, `residentStatus` and `motherName`.
`users.tenantSlug` exists; staff login and refresh compare it with the
request's tenant (`IdentityService`).

**A phone is not an identity, and three columns now say so** (`0069`):

| Column | What it means |
|---|---|
| `phone`, `whatsapp` | The person's own numbers. Not unique — see below. |
| `hasNoPhone` | «لا يملك رقم هاتف». The person owns no number; `phone IS NULL` is an answer here, not a gap. |
| `contactPhone` | «رقم للتواصل» — a son's, a daughter's, a neighbour's number. Never unique, never an identity. |

- `contactPhone` MUST NOT be matched by anything that resolves a number to a
  *person*. It is excluded from `findCitizensByPhone` (citizen sign-in) and
  from duplicate scoring (`possible-duplicates.ts`) on purpose: a relative's
  number is expected to equal that relative's own `phone`, so matching it
  there would offer a father's file to the son signing in. Its readers are
  the ones a person reads the answer of: `LandlordLinkService` (a match on
  it is labelled `CONTACT` and never preselected; a human confirms every
  link), the register search (an exact match, reported as
  `matchedOnContactPhone`), the citizen's file and parcel roster, and the
  register export (`contact_phone_relative`).
- `hasNoPhone` distinguishes "has no phone" from "nobody asked yet". Never
  infer it from `phone IS NULL`: the second is an unfinished record with its
  own «غير مؤكَّد» flag and belongs in «يتطلب مراجعة».
- Two CHECKs hold the meaning (`0072`): `users_no_phone_means_no_number`
  (`hasNoPhone` ⇒ `phone` and `whatsapp` are NULL) and
  `users_contact_phone_not_own` (`contactPhone` is never the row's own `phone`).
  Every writer goes through them, the merge included.

**`users.residence` names owners that are not a living person** (`0076`).
Besides `RESIDENT` and `NON_RESIDENT_OWNER`, `CitizenResidence` holds `ESTATE`
«تركة (ورثة المرحوم …)», the file of an owner who died, converted in place so
his cards, flats and bills stay on it, and `INSTITUTION` «جهة / وقف», a waqf,
council or public body. Neither is a household: no mother's name, gender or
residency is asked of either, and every population count that filters
`residence = 'RESIDENT'` already leaves both out. An institution's name is one
line on the form and is stored across `firstName`/`lastName` (first word, the
rest; `splitInstitutionName`), so any screen that joins the parts reads it
whole. An estate keeps the deceased's own name: «ورثة المرحوم …» is added when
it is shown (`citizenDisplayName`), never written into the row — nor into
another row: a name copied onto a tenancy card is `citizenStoredName`. Every
write of `property_entries.landlordName` from a submitted card goes through
`storedLandlordName` (the entity's `normalise`; `landlordNamesToStore` in the
registration create and the citizen update; the census tenant card), which
takes the prefix off whatever a client sent — a form copies the name it was
*shown* — and, for a card linked to an owner, stores that owner's own name.
The non-person kinds are `NON_PERSON_RESIDENCE` for a Prisma filter.

**A card's `propertyNumber` is stored as typed**, «٤٢٠» as well as «420», and
so are the fee lines copied from it. A lookup by رقم العقار compares
digit-normalised values on both sides (`normalizeDigits`; in SQL,
`translate(…, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')`, as
`parcel-dues.service.ts` does).

**A flat's billing facts live on `units`** (`0075`, `0077`), beside its status:

| Column | What it means |
|---|---|
| `ownerBillingMode` | «توزيع الرسم على المالكين» when the flat has several current owners: `EQUAL`, `BY_SHARES` (each owner's `unit_occupancies.shares` over the sum of all of them) or `RESPONSIBLE_OWNER`. NULL means nobody chose, and is billed as `EQUAL` (decision of 2026-10-07). |
| `responsibleOwnerId` | The owner who pays the whole under `RESPONSIBLE_OWNER`, and only then. `units_responsible_owner_needs_mode` uses `IS NOT DISTINCT FROM`: with `=`, a CHECK passes on the NULL that `NULL = 'RESPONSIBLE_OWNER'` yields. |
| `feeExemption`, `feeExemptionNote`, `feeExemptedById`, `feeExemptedAt` | «معفاة من الرسوم»: `PLACE_OF_WORSHIP`, `PUBLIC_FACILITY` or `OTHER` (which needs the note). Set and lifted together (`units_fee_exemption_fields`). An exempt unit is charged nothing by a rate-based notice; a rented waqf shop is not exempt, its tenant pays. |

**A damage reading has two answers** (`0071`). `damage_assessments.level` is the
UN-Habitat scale, untouched; `habitable` is «صالحة للسكن؟», asked beside it and
prefilled from the level where the level decides it (decision of 2026-10-05).
NULL is a reading from before the question, or an unclassified one, which asks nothing. The retired level
`UNINHABITABLE` stays in the Prisma and SQL enum (removing it is destructive);
`0071` rewrote its rows to `RESTRICTED_USE` with `habitable = false`, and three
CHECKs keep the rest:

| CHECK | Rule |
|---|---|
| `damage_assessments_level_not_retired` | `level <> 'UNINHABITABLE'` |
| `damage_assessments_habitable_matches_level` | a collapse or an evacuation is never `habitable` |
| `damage_assessments_reinspect_needs_uninhabitable` | `reinspectAt` only on a reading with `habitable = false` |

«غير صالحة للسكن» is `habitable = false`, or no answer on a collapse or an
evacuation (`isUninhabitableReading`, and its SQL twin `uninhabitableSql`). The
fee assessment charges no fee at all — occupant-borne or owner-borne (decision
of 2026-10-07) — on a unit whose current reading says so — the latest of the unit's and its building's readings *that answers*:
`UNCLASSIFIED` with `habitable` NULL judged nothing and is passed over
(`answersHabitability`, its SQL twin `answersHabitabilitySql`, and
`currentReadingForUnit(…, { answering: true })` in
`application/features/buildings/habitability.ts`), so it never ends the exemption.

**`lastSeenAt` is staff presence, and the one write on the authenticated hot
path** (`0070`). `StaffPresenceService` stamps it from `JwtAuthGuard` behind a
Redis gate — one UPDATE a minute per account, never one per request — and only
for `kind = 'STAFF'`, so a citizen row stays NULL for ever and the portal
keeps no write on its hot path. Do not read `lastLoginAt` as presence: it is
stamped once at sign-in, and a staff token lives behind a week-long refresh
chain, so it reports an officer who worked all morning as last seen at eight.

- Every query on `users` MUST filter on `kind`, in the `where` of the statement
  itself. A prior read that checked `kind` is not enough for a write.
- Most other tenant tables hold or point at citizen rows, including
  `audit_log_entries`, whose snapshots carry citizen fields. Treat a tenant
  table as citizen data until its foreign-key graph says otherwise.

### Append-only tables

- `audit_log_entries`: triggers `audit_log_entries_no_update` and
  `audit_log_entries_no_delete` call `reject_audit_mutation()` (`0001_init`).
- `payment_transactions`: `payment_transactions_no_update` and
  `payment_transactions_no_delete` call `reject_ledger_mutation()`
  (`0017_payment_ledger`). Deleting a `citizen_payments` row cascades into it
  and raises.
- `treasury_entries`: `treasury_entries_no_update` and `treasury_entries_no_delete` call
  `reject_treasury_mutation()` (`0073`). A wallet balance is the SUM of its entries; there is no
  balance column. Its foreign keys to `users` and `treasury_accounts` are RESTRICT, so erasing a staff
  member or a wallet that has moved money fails instead of cascading into the trigger. An entry's
  currency equals its account's because the foreign key is the pair `(accountId, currency)`.
- No trigger covers `TRUNCATE`. Using `TRUNCATE`, or
  `session_replication_role`, to get past them is circumventing a control. If a
  trigger stops you, stop and report it
  ([CLAUDE.md](../CLAUDE.md#how-to-work-here)).

## Read before you infer

Never conclude what a table holds from its name, its Prisma model or a previous
session. Query the database. Incident: [incidents.md](incidents.md), entry 1.

Columns:

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'tenant_<slug>' and table_name = '<table>'
order by ordinal_position;
```

Foreign-key graph, before you touch rows:

```sql
select conrelid::regclass as from_table,
       confrelid::regclass as to_table,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where contype = 'f' and connamespace = 'tenant_<slug>'::regnamespace
order by 1, 2;
```

- MUST get the foreign-key graph, not only the columns. A table with no
  personal columns still exposes citizens if its rows point at them:
  `building_units` hangs off `property_entries`, then `registrations`, then
  `users`.
- MUST treat `tenant/schema.prisma` as a claim, not a fact. Tenant migrations
  are hand-written SQL, and nothing compares them with `schema.prisma`: not
  Prisma, not CI.
- MUST re-read a count before acting on it if you read it earlier in the
  session. Facts go stale.
- Where to query: the local database through
  `docker compose exec postgres psql -U appuser_local -d municipality_db_local`
  (not a package script). For a read on production, a hand-installed read-only
  role exists (`scripts/db/setup-claude-ro.sql`); a human opens the tunnel. 21
  of its 26 views are `SELECT *`, so they expose more than its header says
  ([Moving data](#moving-data-between-environments)).

## Name the target

Every environment is pinned by database name and role in
`scripts/db/targets.mjs` (`TARGETS`). `resolveTarget` refuses an env file whose
`DATABASE_URL` or `DIRECT_URL` names another database or role, carries
`?schema=` other than `public` or any `?options=`, or mentions a higher
environment anywhere, comments included. Staging and production sit on one
Lightsail box behind an SSH tunnel, so both look like `localhost`. The host
tells you nothing; read the database name.

| Target | Database | Role | Env file |
|---|---|---|---|
| `local` | `municipality_db_local` | `appuser_local` | `apps/backend/.env` (must be `127.0.0.1:5434`) |
| `staging` | `municipality_db_staging` | `appuser_staging` | `.env.staging` in `apps/backend`, only while working on staging |
| `production` | `municipality_db` | `appuser` | none on a laptop; CI writes it per run |

- MUST name the target: `pnpm db:status:<target>`, `pnpm db:deploy:<target>`.
- MUST NOT run `prisma migrate deploy`, `prisma migrate dev`,
  `prisma migrate resolve` or `tenant:migrate-all` directly. They read whatever
  dotenv file is on disk and do not say where they point. Against the tenant
  schema, `prisma migrate deploy` writes tenant DDL into `public` and then
  blocks every later deploy with P3009.
- `apps/backend/.env` MUST stay pinned to the local Docker database,
  `municipality_db_local` on `127.0.0.1:5434`. `pnpm dev`, `pnpm start` and the
  backend `dev` script run the guard first and refuse a file that names staging
  or production, or a shell `DATABASE_URL`/`DIRECT_URL` that overrides it. MUST
  NOT point it "temporarily" at staging or production. Incident:
  [incidents.md](incidents.md), entry 8.
- The local database MUST hold seeded, synthetic data only: `pnpm db:seed`,
  `pnpm db:seed:census` and the cadastre map. MUST NOT restore, dump or copy
  staging or production rows into it, with any tool (`pg_dump`, a GUI client,
  the backup files, `verify-restore.mjs`, an MCP server). A request to "clone
  the real data" to a laptop is a request to break
  [Moving data](#moving-data-between-environments). Say so, and offer the seed.
- Staging is reached from a laptop only by creating `.env.staging` in
  `apps/backend` (tunnel on a free port; not 5433 if something holds it) and
  naming the `staging` target. MUST delete the file afterwards: while it
  exists, the machine can migrate staging.
- There is deliberately no `.env.production` on developer machines. Production
  migrations run in GitHub Actions (`migrate-database.yml`, through
  `scripts/db/deploy.mjs`): on every push to `main`, staging first, before the
  code ships, and by hand from **Deploy production** for dry runs and contract
  steps. If you think you need to migrate production from a
  laptop, ask; do not improvise.
- **A push to `main` migrates production.** A migration merged to `main` MUST
  be additive.
- Prisma loads `apps/backend/.env` on top of the environment a script hands it.
  `deploy.mjs` `verifyApplied` reconnects and re-reads the target for that
  reason. After any write to a target, reconnect and count. Incident:
  [incidents.md](incidents.md), entry 3.

Runbook, env file contents and the pipeline:
[database-environments.md](database-environments.md).

## Query style

Which layer may touch Prisma (decision D-data: application services use it
through `TenantContextService`, existing repository ports stay, presentation
only in `TenantMiddleware` and `HealthController`) is set in
[apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#layers-and-the-dependency-rule).
The query-level rules:

- An application service MUST take the client from the `prisma` getter of
  `TenantContextService`. House pattern:
  `private get db() { return this.tenantContext.prisma; }` and
  `private get S() { return tenantSchemaRef(this.tenantContext.schemaName); }`.
  Copy `UnitCorrectionService`.
- MUST NOT construct a `PrismaClient` outside `TenantPrismaFactory`,
  `RegistryPrismaService`, `src/scripts` and tests.
- MUST NOT take a tenant, slug or schema name from a request body or query
  string. The schema comes from the scope ([security.md](security.md#tenancy)).
- SHOULD `select` only the columns you need, especially on `users`. Never
  return `referenceNumber`, `passwordHash` or `totpSecret` by accident.

### Raw SQL

Prisma model queries are schema-qualified by the client. Raw SQL is not: an
unqualified `FROM buildings` resolves through the connection's `search_path`
and fails intermittently with `42P01`.

- MUST qualify every table: `` this.db.$queryRaw`SELECT … FROM ${this.S}buildings WHERE id = ${id}::uuid` ``.
  `raw-sql-is-schema-qualified.spec.ts` enforces this in CI. It reads the
  table names from the tenant `@@map` list plus `_tenant_migrations`, and fails
  any `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, `DELETE FROM` or `COPY` that
  names one without a `${…}` prefix.
- SHOULD use the tagged `$queryRaw` / `$executeRaw`. Build dynamic filters with
  the `Prisma` helpers `sql`, `join` and `empty`; the exemplar is
  `PrismaAuditRepository`. The only `Prisma.raw` call belongs in
  `tenantSchemaRef`.
- `$queryRawUnsafe` / `$executeRawUnsafe` MAY be used only with positional
  parameters (`$1`) and `tenantSchemaPrefix`. MUST NOT interpolate request
  input, ever. Every current call site is parameterised.
- Advisory-lock keys MUST include the schema:
  `pg_advisory_xact_lock(hashtext('<schema>:building-suffix:<parcel>'))`. Two
  writers that must exclude each other MUST build the key identically
  (`BuildingsService` and `ParcelCorrectionService` each build it today).

## Transactions and constraints

### Transactions

- How a service opens a transaction (`runInTenantTransaction`, never a bare
  `this.db.$transaction`) and when side effects run (after commit) is set in
  [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#transactions). The traps
  behind it: [gotchas.md](gotchas.md#a-transaction-client-has-no-transaction).
- Use row locks (`SELECT … FOR UPDATE`) or an advisory lock for
  read-then-write races, inside the transaction.

### Constraints live in the database

- Uniqueness, foreign keys and CHECKs MUST be enforced by the database, not by
  a prior read. Examples: `@@unique([identityDocType, identityDocNumber])` on
  `User`, the partial unique index `cases_status_conflict_open_unit_key`
  (`0063`), the CHECK `payment_transactions_change_not_negative` (`0066`).
- **`users.phone` is deliberately NOT unique, and must not be made unique.**
  A household sharing one phone is the designed case: `User` is keyed on the
  identity document *because* of it, `verifyOtp` answers a phone matching
  several people with `CHOOSE_PROFILE` rather than a guess, and
  `docs/open-decisions.md` §4 records that v1's `@@unique([phone, lastName])`
  was removed on purpose. A partial unique index over citizens with a number
  was requested on 2026-10-05 and declined for those reasons and one more: it
  fails to create on data that already exists. Attempted against the seeded
  local database it raised «could not create unique index … Key
  (phone)=(+96177500144) is duplicated», and a municipality where a mother and
  a father share the family line is the normal case, not corruption. The
  honest fix for a relative's number sitting in `phone` is `hasNoPhone` and
  `contactPhone` (`0069`), which take it out of the identity column
  altogether.
- A unique violation (Prisma `P2002`) MUST become a `ConflictError` at the
  write that can raise it, naming the column from `error.meta.target`. An
  unmapped `P2002` reaches `DomainExceptionFilter` as a 500. Match the code
  structurally (`error.code === 'P2002'`): the two generated clients have
  separate error classes, so `instanceof` against the wrong one is false. Per
  D-errors the error MUST carry a stable code the frontend can localise
  ([apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#error-codes)).
- Where `P2002` is mapped today: `PrismaUserRepository.translate`,
  `PrismaRegistrationRepository.translate`, and inline in
  `ParcelCorrectionService`. There is no shared helper.

### Deviations

The code breaks these rules in known places: bare `$transaction` calls and
`BuildingsService.atomic`, staff writes on `users` without `kind` in the
`where`, the `PrismaUserRepository.translate` fallback text, advisory locks
through `$executeRawUnsafe`, and the interpolated `SET` in
`migrate-all-tenants.ts`. Each is a row, with its fix, in
[code-quality.md](code-quality.md#backend) and
[Data and scripts](code-quality.md#data-and-scripts).

## Migrations

Applies to `registry/migrations` and `tenant/migrations`. The pipeline that
runs them: [database-environments.md](database-environments.md#3-the-normal-path).

### Applied migrations are immutable

- Once a migration has run in **any** environment, MUST NOT edit its SQL or
  rename its folder. Fix forward with a new migration.
- Why it is worse than it looks: the registry is tracked by Prisma checksum,
  so an edit fails the next deploy. The tenant migrator tracks **folder names**
  only, so an edited tenant migration never re-runs and staging and production
  silently diverge. A renamed folder becomes pending again and its SQL re-runs.
- MUST write idempotent SQL (`IF NOT EXISTS`, guarded `DO` blocks), because a
  replayed folder re-runs.

### Destructive changes go in a later release

The scanner (`scripts/db/destructive-sql.mjs`, `DESTRUCTIVE`) blocks a deploy
on:

- `DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA`, `TRUNCATE`;
- `ALTER COLUMN … TYPE`, including `SET DATA TYPE` and the multi-line form;
- `DROP TYPE`, `DROP DOMAIN`, `DROP SEQUENCE`, and any `DROP … CASCADE` (an FK
  `ON DELETE CASCADE` is not flagged);
- `RENAME COLUMN` and `RENAME TO`;
- `DELETE FROM` (rows are as unrecoverable as columns; it also matches inside a
  trigger body).

It warns, and continues, on `UPDATE … SET`, `SET NOT NULL`, `CREATE [UNIQUE] INDEX`
without `CONCURRENTLY`, and `DROP CONSTRAINT`. Comments are stripped first
(`stripSqlComments`).

Destructive DDL MUST NOT ship in the same migration, or the same release, as
the code that needs it. Use expand, backfill, contract across releases:

1. **Expand.** Add the new column or table, nullable. Nothing reads it. The
   previous build keeps working, so a rollback is a redeploy.
2. **Backfill.** Fill it, in batches if the table is large. Deploy code that
   writes both and reads the new one with a fallback.
3. **Contract.** A release later, after it has been watched in production, drop
   the old one. Only the manual **Deploy production** workflow
   (`deploy-production.yml`, input `allow_destructive`) passes
   `--allow-destructive`, after a dry run and a confirmed backup.

`--allow-destructive` is a statement that you verified the data is preserved
or expendable. It is never a way past an error. If you are adding it to make a
command work, stop. Incident: [incidents.md](incidents.md), entry 2.

### How tenant migrations run

- `migrateAllTenants` (`src/scripts/migrate-all-tenants.ts`) loops every
  provisioned municipality, one at a time, on a session with `lock_timeout`
  (`MIGRATION_LOCK_TIMEOUT`, default `5s`) and `statement_timeout`
  (`MIGRATION_STATEMENT_TIMEOUT`, default `300s`).
- `migrateTenantSchema` (`tenant-migrator.ts`) applies each pending folder in
  lexicographic order, each in its own transaction: `BEGIN`,
  `SET LOCAL search_path TO "<schema>"`, the SQL, the ledger insert, `COMMIT`.
  A failure rolls that migration back.
- A tenant that fails is reported and the loop moves on to the next tenant,
  then exits non-zero. The file header says a failure "should stop".
  **Undecided:** which behaviour is intended.

Consequences you MUST design for:

- Write DDL unqualified. The migrator's `search_path` builds every schema from
  one file.
- System catalogs are database-wide. A guard such as
  `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)` MUST join
  `pg_namespace` and filter `nspname = CURRENT_SCHEMA()`, or it is true for the
  first municipality and silently skips every other one.
  `migration-guards-are-schema-scoped.spec.ts` enforces this; `0050` repaired
  22 constraints lost this way.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and the migrator
  wraps every migration in one. A concurrent build would need its own migration
  plus a non-transactional migrator mode, which does not exist. Today, use a
  plain index and justify the lock in the header by the table's size (see
  `0066`). **Undecided:** whether to add that mode.
- A new enum value cannot be used in the transaction that adds it. Put
  `ALTER TYPE … ADD VALUE IF NOT EXISTS` alone in one migration and use the
  value in a later one (`0062_status_conflict_case`, then
  `0063_status_conflict_one_open`). The enum value MUST ship before the code
  that writes it.
- A plpgsql function body resolves names when it runs, against the caller's
  `search_path`. Pin it (`ALTER FUNCTION … SET search_path = <schema>, pg_catalog`,
  as in `0030_building_census`) or qualify calls (`0048_search_compact_schema_qualified`).
- Postgres 17 is required: `0044_mother_name` uses `ALTER COLUMN … SET EXPRESSION`.

### Promotion

Production only receives migrations staging has already applied. `deploy.mjs`
reads staging's history from `.env.staging` and nothing else, and
`promotionProblems` (`migration-state.mjs`) compares the two. MUST NOT pass `--skip-promotion-check` without writing down why.

### Numbering

- `main` ends at `0072_users_no_phone_rules`: `0067`–`0072` went to `main` in their own
  migrations-only PR, ahead of the release that carries the code reading them (root rule 5; the
  PR #61 and #86 pattern). `develop` ends at `0077_unit_fee_exemption`: `0075`–`0077`
  (`chore/migration-0075-0077`: co-owner billing, the estate and institution record types, the
  unit fee exemption) follow the same path, their own PR into `develop`, then to `main` alone,
  before any release that writes the new columns or values.
- `feat/finance-treasury-expenses` holds `0073_treasury_ledger`, `0074_expense_vouchers`,
  `0078_treasury_transfers`, `0079_document_numbering`, `0080_income_vouchers` and
  `0081_expense_voucher_payee_staff`, none of them on `develop` yet. The PRs for `0073`/`0074`
  (#94, #93) were closed unmerged on 2026-10-08, but the branches are still on `origin`, so those
  numbers stay reserved and are never reused. `0078` is not `0075` because
  `chore/migration-0075-0077` had taken it: the second time a number was taken mid-flight on that
  branch. As `0075`–`0077` merged first, `0073` and `0074` will land out of order on any database
  that already has them, which `deploy.mjs` warns about and applies; the two sets touch different
  tables. Checked on 2026-10-09 against `origin/main`, `origin/develop` and every local and remote
  branch after a fetch: the next free number is `0082`.
- Parallel branches reuse numbers and nothing errors: `0016_*` and `0017_*`
  each exist twice. `0059_staff_refresh_tokens` was merged to `develop` after
  `0066`, so it applies out of order: `deploy.mjs` warns and applies it.
- The treasury migration was first written as `0071` and renumbered to `0073`:
  `0071_damage_habitable` and `0072_users_no_phone_rules` landed on `develop`
  while it was in progress. A branch cut before a release is a branch whose
  numbers can be taken while you work — re-check before you open the PR, not
  only when you pick.
- Before you pick a number, MUST list the migrations on every unmerged branch
  and open PR:

  ```bash
  git branch -r --no-merged origin/develop
  git ls-tree --name-only origin/<branch> apps/backend/src/infrastructure/prisma/tenant/migrations/
  ```

  Remote refs are only as fresh as your last fetch.
- A lower number merged after higher ones is applied out of order;
  `deploy.mjs` only prints "Pending migrations that sort before one already
  applied". Renumber before merging, never after applying.

### Release

- The migration SQL and its `schema.prisma` change go in their own
  `chore/migration-NNNN` PR, merged before the feature PR
  ([CLAUDE.md](../CLAUDE.md#git)). Precedents: #61, #68, #70, #74.
- The release that carries the migration to `main` MUST reach production no
  later than the code that needs it. Production is migrated before the code
  ships, and the previous release keeps serving against the new schema for a
  few minutes. Prefer shipping the migration to `main` on its own, ahead of the
  code.

## Moving data between environments

These rules were broken once, at a cost: [incidents.md](incidents.md), entry 4.

- **Citizen data never leaves staging or production.** Not to another
  environment, not to a laptop, not to a file "for backup", not to a log. If
  you cannot say which rows are citizens, you are not ready to copy.
- **Allowlist, never discover.** Enumerate the tables you copy and say why for
  each. Dynamic discovery means the next migration silently adds a table to the
  copy set. Read the TABLE_POLICY list in the retired sync script before writing
  the next one (`git show ccd7ee1^:scripts/db/sync-production-tenant.mjs`).
- **Filter at the source.** Put `WHERE kind = 'STAFF'` on the `SELECT`. Copying
  everything and deleting afterwards means the data existed in the target.
  Apply the same to every table whose foreign-key graph reaches `users`.
- **Assert zero citizens afterwards.** Reconnect to the target and count.
- **Never `SET session_replication_role = 'replica'`.** It disables every
  trigger and foreign-key check on the connection, including the append-only
  guards. A data move that only works with integrity switched off is telling
  you something.
- **Never `TRUNCATE … CASCADE` in a loop.** Cascade order is not loop order,
  and it deletes rows an earlier iteration just inserted.
- **One direction only:** local, then staging, then production. Never the
  reverse.
- **Changing rows by hand** (a data correction): count first, state the
  expected number, run it in a transaction, count again, and roll back if the
  numbers disagree. Record what you changed in `audit_log_entries`. Do it on a
  local replica of the shape first, never on a copy of the data.
- The one inversion is the pre-migration backup, which discovers schemas on
  purpose, because a backup's failure mode is a forgotten table. It is
  encrypted, written once and never leaves the pipeline
  ([database-environments.md](database-environments.md#5-backups)).

Deviations. Each is a row, with evidence and fix, in
[security.md: Known gaps](security.md#known-gaps):

- `apps/backend/backups/dump-tenant.js` (tracked) writes citizens, documents
  and payments to a JSON file from `apps/backend/.env`, with no target guard.
- `reissue-references` prints new login credentials with names and phone
  numbers to stdout, and its comment expects the run to be redirected to a
  file. Whether it should print them at all is **Undecided**.
- `scripts/db/setup-claude-ro.sql` defines 21 `SELECT *` views, hard-coded to
  `tenant_albazourieh`; `readonly_claude.property_entries` exposes
  `landlordPhone`.

## Recipes

### Add a column to a tenant table

Model: `0065_staff_deleted_at` with `User.deletedAt`, its repository methods,
and `staff-hide.integration.spec.ts`.

1. Pick the number ([Numbering](#numbering)).
2. Create `apps/backend/src/infrastructure/prisma/tenant/migrations/<NNNN>_<snake_name>/migration.sql`.
   Only that file goes in the folder. Start with the house header:
   `-- <NNNN>_<name>`, then `== What it is for ==` and `== Safety ==`.
3. Expand: `ALTER TABLE "<table>" ADD COLUMN IF NOT EXISTS "<camelCase>" <type>;`,
   nullable, unqualified, no default that rewrites the table.
4. Add the field to the model in `tenant/schema.prisma` with a `///` comment.
   Where Prisma's default index or constraint name differs from the SQL, set
   `map:` (see `BillingRunEntry`).
5. `pnpm db:generate`, then `pnpm typecheck`.
6. `pnpm db:status:local` (read the scanner's verdict), then
   `pnpm db:deploy:local`. It applies to every seeded municipality.
7. Test on a throwaway Postgres 17 ([below](#test-a-migration-on-a-throwaway-postgres-17)).
8. Ship the migration PR first ([Release](#release)).
9. Backfill in a later step, and contract a release after that, through the
   manual workflow.

### Add a tenant table

Model: `0061_citizen_merges` (`CitizenMerge`).

- `CREATE TABLE IF NOT EXISTS "<snake_plural>" ("id" UUID NOT NULL DEFAULT gen_random_uuid(), …, CONSTRAINT "<snake_plural>_pkey" PRIMARY KEY ("id"))`,
  unqualified. Columns are quoted camelCase, as Prisma names them. The model
  gets `@@map("<snake_plural>")`.
- Add foreign keys and CHECKs inside a `DO $$ … $$` block guarded by
  `pg_constraint` joined to `pg_namespace` with `nspname = CURRENT_SCHEMA()`
  (the loop in `0061`, the single guard in `0066`).
- Index every foreign-key column. A plain `CREATE INDEX IF NOT EXISTS` on a new,
  empty table is fine; the scanner only warns.
- Any plpgsql function pins its `search_path`.
- If the table holds or points at citizen data: decide whether `BackupService`
  `TABLE_ORDER` must list it, and make sure `setup-claude-ro.sql` does not
  expose it.

### Add an enum value

1. Migration A: `ALTER TYPE "<Enum>" ADD VALUE IF NOT EXISTS '<VALUE>';` and
   nothing that uses it.
2. Migration B (later folder, may ship together): anything that uses the value.
3. Change the Prisma `enum`, the shared enum in `packages/shared-schemas`, both
   locales in `labels.ts`, and the domain union where one exists
   ([packages/shared-schemas/CLAUDE.md](../packages/shared-schemas/CLAUDE.md)).
4. Ship the migrations before the code that writes the value.

Removing or renaming an enum value is destructive (`DROP TYPE`, a type change)
and goes through contract.

### A hand-written tenant migration

- Folder: `NNNN_snake_case`, zero-padded, holding only `migration.sql`.
- Draft the SQL from the datamodel, not from a database. The `0001_init`
  header gives the `prisma migrate diff` form:

  ```bash
  git show HEAD:apps/backend/src/infrastructure/prisma/tenant/schema.prisma > <scratch>/before.prisma
  pnpm --filter @mechanization/backend exec prisma migrate diff \
    --from-schema-datamodel <scratch>/before.prisma \
    --to-schema-datamodel src/infrastructure/prisma/tenant/schema.prisma --script
  ```

  Then edit the output by hand: add `IF NOT EXISTS`, remove any schema
  qualification, wrap constraints in schema-scoped guards.
- MUST NOT use `pnpm db:migrate:tenant` to draft. It runs
  `prisma migrate dev --create-only` against `public`, whose
  `_prisma_migrations` holds the registry's history. **Unverified:** expected
  to report drift and offer to reset `public`; reasoned from the code, not run.
- `pnpm db:generate` after changing `schema.prisma`.

### Document numbering (migration 0079)

Five books — invoices, receipts, expense vouchers, transfers and, since 0080,
income vouchers («RV-», kind `REVENUE_VOUCHER`) — share one scheme:
«INV-2610-0001» is the book, the year and month it was issued in, and a
counter that **restarts at 0001 on the first of each month**. `kind` is text,
so a new book needs no migration; its key is stored and never renamed.

The counter is a row in `document_counters` keyed by `(kind, period)`, not a
Postgres sequence, and the reason is the reset: `nextval` only ever climbs, and
anything that resets it on the first races whatever is drawing from it. One
atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` both starts a month and
advances it, and hands back the block it reserved.

- **Draw through `allocateDocumentNumbers`** (`application/common/document-number.ts`),
  never by hand, and always with the caller's `tx`: the number and the document
  it goes on must commit or roll back together.
- **It serialises issuance within a month.** The counter row stays locked until
  the caller commits. At a municipality's volume that is nothing; the
  alternative is two residents holding the same receipt number.
- **It gaps less than a sequence did** — a sequence keeps its advance through a
  rollback and this does not — but it is still not a gapless book, and nothing
  may be built on the assumption that it is.
- **The old sequences stay.** `payment_receipt_seq`, `expense_voucher_seq` and
  `treasury_transfer_seq` are simply no longer drawn from. Dropping them is
  destructive DDL for its own later release.
- **Two shapes coexist.** Documents issued before 0079 keep «RCP-000014», and
  bills raised before it stay unnumbered (`invoiceNumber` is nullable). Nothing
  in the code parses or orders by either shape; `isDocumentNumber` accepts both.

### Test a migration on a throwaway Postgres 17

The integration suites (`*.integration.spec.ts`, gated by `TEST_DATABASE_URL`)
run `DROP SCHEMA … CASCADE` and `migrateTenantSchema` on fixed scratch schemas
(`tenant_<x>_spec`) in whatever database `TEST_DATABASE_URL` names. Nothing
checks that name. MUST point it at a throwaway container, never at
`municipality_db_local`, staging or production.

```bash
# throwaway container (not a package script)
docker run -d --rm --name pgtest -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test -p 127.0.0.1:5440:5432 postgres:17-alpine
TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:5440/test \
  pnpm --filter @mechanization/backend test -- integration
docker stop pgtest
```

Run at least `tenant-migrator.integration.spec.ts` and the suites of the
feature you touched. Copy the setup of `staff-hide.integration.spec.ts` for a
new suite: a spec-unique `SCHEMA`, `describeIfDb`, `migrateTenantSchema`,
`tenantTestClient`.

### A registry migration

Rare: only `0001_init` exists.

1. `pnpm db:check`, then edit `registry/schema.prisma`.
2. `pnpm db:migrate` (`prisma migrate dev --create-only` on the local database;
   `appuser_local` has `CREATEDB` for the shadow database).
3. Read the generated SQL, then `pnpm db:deploy:local`.
4. Checksums apply: once applied anywhere, the file is frozen.

## Migration PR checklist

- [ ] The number is unused on every branch and open PR. The folder is
      `NNNN_snake_case` with only `migration.sql`.
- [ ] No applied migration is edited or renamed: the diff under
      `tenant/migrations` adds files and modifies none.
- [ ] Additive: `pnpm db:status:local` reports nothing blocking. A blocking
      item is the contract step of a finished cycle and goes through the
      manual workflow.
- [ ] Every statement is idempotent.
- [ ] Every catalog guard filters on `CURRENT_SCHEMA()`.
      `migration-guards-are-schema-scoped.spec.ts` passes.
- [ ] No `search_path`-dependent function body; no `SET search_path` outside
      `SET LOCAL`.
- [ ] Enum values are added in their own migration.
- [ ] Each index lock is justified by the table's size in the header.
- [ ] `schema.prisma` matches: types, nullability, `@@map`, `map:` names.
      `pnpm db:generate` and `pnpm typecheck` pass.
- [ ] The previous release still works against the new schema.
- [ ] The integration suites pass on a throwaway Postgres 17.
- [ ] No `DELETE FROM` or unattended row rewrite that touches citizen rows.
- [ ] The migration PR merges before the feature PR, and reaches `main` no
      later than the code.

## Commands

| Purpose | Command |
|---|---|
| Validate env files and targets, no network | `pnpm db:check` |
| Unit-test the guard, scanner and ledger reader | `pnpm db:test` |
| What is pending, scanner verdicts, applies nothing | `pnpm db:status:local`, `pnpm db:status:staging`, `pnpm db:status:production` |
| Apply, then re-read the target | `pnpm db:deploy:local` (`staging` and `production` run in CI) |
| Generate both Prisma clients | `pnpm db:generate` |
| Draft a registry migration | `pnpm db:migrate` |
| Seed the local database | `pnpm db:seed`, `pnpm db:seed:census` |
| Backup dry run | `pnpm db:backup:status:staging`, `pnpm db:backup:status:production` |
| Backend tests (integration suites need `TEST_DATABASE_URL`) | `pnpm --filter @mechanization/backend test` |

## Undecided

- **Transaction timeouts** (`maxWait` / `timeout`): Prisma's default 2 s / 5 s
  (bare `$transaction`), 15 s / 30 s (`BuildingsService.atomic`), 15 s / 60 s
  (`runInTenantTransaction`), 15 s / 120 s (`BackupService`). No standard is
  set.
- **Non-transactional migrations** for `CREATE INDEX CONCURRENTLY`.
- **Failure mode of `migrateAllTenants`**: continue past a failed tenant (code)
  or stop (header).
- **A schema drift check in CI** comparing `tenant/schema.prisma` with the SQL
  migrations. Proposal only.
- **A guard on `TEST_DATABASE_URL`** that refuses pinned databases, as
  `verify-restore.mjs` `assertThrowaway` does.
- **Onboarding staging or production.** `scripts/db/provision.mjs` is a guarded
  wrapper around `tenant:provision`, but no package script or workflow runs it,
  and production credentials never sit on a laptop. It also builds the schema
  name from `--slug` before validating it, and its `inspect` turns read errors
  into "absent" (`.catch(() => ({ rows: [] }))`).
- **`BackupService` restore** aborts for any tenant with `payment_transactions`
  rows (the append-only trigger fires through the cascade). Documented in its
  own comment as a design decision.
- **`BackupService` does not export the treasury tables** (`treasury_accounts`,
  `treasury_entries`, 0073). They hold no citizen data, but their rows are append-only and
  RESTRICT-linked to `users`, so a restore (which deletes users) aborts for any tenant that has
  moved money, exactly as for `payment_transactions`. A backup of such a tenant therefore does not
  contain its wallets. Nor the documents beside them: `expense_categories`, `expense_vouchers`
  (0074), `treasury_transfers` (0078), `document_counters` (0079), `income_categories` and
  `income_vouchers` (0080) are not in `TABLE_ORDER` either (checked 2026-10-09), and the free-text
  payee and payer columns may name a citizen. **Undecided:** how the backup should carry an
  append-only ledger and the vouchers that explain it.
- **`dump-tenant.js`, the `reissue-references` CSV, the `claude_ro` views**:
  see [Moving data](#moving-data-between-environments).
- **Database roles.** One role per environment runs both DDL and DML for every
  tenant schema ([security.md](security.md)).
