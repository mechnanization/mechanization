# Database

Last verified against the code: `chore/migration-0098-0099` (on `develop@b2c18dd`, uncommitted): `0098_fee_basis_tiered_area` and `0099_tiered_fee_matrix`, tiered area fees and the shared unit bill, their rows in the fees table, their numbering note and the next free number, 2026-10-23; `feat/earnings-by-actor` (on `develop@149e458a`, uncommitted): `0096_building_unit_filed_by` and `0097_building_unit_filed_by_backfill`, who is paid for a unit line, their numbering note and the next free number, 2026-10-21; `chore/migration-0095` (on `develop@a7e62087`): `0095_unit_levels`, its row in the units billing facts and its numbering note, 2026-10-17; `fix/pr115-review` (PRs #123, #124 and #115 stacked on `develop@5e8f5c3`, each with its review fixes): a رقم العقار saved in Latin digits, digit-normalised lookups for older rows, where `P2002` is mapped; a foreign-key violation on a registration card, 2026-10-15; the finance audit migrations `0090`, `0091` and `0093`, their table rows, the enum release rule and `0091`'s header corrections against `chore/migration-0090-0091` (on `develop@5e8f5c3`) and the code of PR #120 (`fix/finance-audit-remediation@6169287`), 2026-10-13, rebased onto `develop@3211140`, 2026-10-15; `0092_citizen_requests` (municipal requests), shipped alone in `chore/migration-0092` (PR #121) ahead of the code and stacked on #120 with `0093` before it, 2026-10-13; and `feat/treasury-day-closing@c88c971` (`develop` with the reviewed treasury, #107/#108; PR #106, stage 5: the daily count, the day closing and the closed-day lock; PR #109, inspector payouts and decision D9; PR #111, transfers, exchange and wallets with `0088`; PR #112, bulk settlement with `0085`; each merged with its review fixes, and the cross-feature fixes) with the fixes of the final-stack review (uncommitted): `0089` (a paid commission payout written once, and the payout's retry key on its row), a back-dated outflow judged against every day's close, the count's wallet locks in id order, the migrator's lock note, 2026-10-11; the finance audit migrations `0090`, `0091` and `0093`, their table rows, the enum release rule and `0091`'s header corrections against `chore/migration-0090-0091` (on `develop@5e8f5c3`) and the code of PR #120 (`fix/finance-audit-remediation@6169287`), 2026-10-13; `0092_citizen_requests` and, from its review, `0094_citizen_request_guard`, the municipal requests tables, their guard, backup and numbering notes and `0092`'s header corrections, against `chore/migration-0092` rebased on `fix/finance-audit-remediation@9f7b12b` and the code of PR #122 (`fix/fees-page-ux@c28f437`), 2026-10-13; and, on `fix/fees-page-ux` rebased onto `chore/migration-0092@16473f0` (2026-10-13), the review of PR #122: a request cancelled with its bill (`cancelRequestOfCancelledBill`), a card or a flat a request names never deleted (`PROPERTY_NAMED_BY_REQUEST`, `HAS_REQUESTS`), request bills stamp `issuedById`, the API's log lines without query strings, and the isolation tests.

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
| Fees and money | `fee_notices` (`clientRequestId`, 0091: the issue wizard's retry key, unique, so a retried «إصدار» is answered with its notice instead of billing everyone twice; `matrixBrackets`, 0099: the bracket table of a `TIERED_AREA` notice (0098), present exactly under that basis and a non-empty array, by CHECK, its shape `feeMatrixSchema`), `citizen_payments` (`unitId`, 0099: set only on a **shared unit bill**, a `TIERED_AREA` unit charged to two or more citizens and billed once in full; such a bill has a NULL `citizenId` (CHECK `citizen_payments_citizen_or_unit`: a citizen or a unit, never both, never neither), always a `feeNoticeId`, and its own double-billing guard, the partial unique index `citizen_payments_unitId_feeNoticeId_periodKey_key`; the unit link is RESTRICT; every bill raised before 0099 has a citizen and no unit; `issuedById`, 0091: who raised the bill — the notice's issuer, the clerk of a one-off charge, or the staff member who started a recurring run; NULL for the scheduled run and for every bill raised before 0091; «إلغاء الفاتورة», 0090/0091: `paymentStatus` `CANCELLED` with `cancelledAt`, `cancelledById` and `cancellationReason`, all four together and only on a bill with `paidAmount` 0, by CHECK, the reason never blank, 0093; both user links RESTRICT), `citizen_payment_debtors` (0099: who may pay a shared unit bill, one row per citizen the bearer rule charged for the unit when the bill was raised, with their `OccupancyRole`; written at issue; cascades with its bill, RESTRICT to `users`; citizen data: it says who holds or lives in a unit), `payment_transactions` (`paidByCitizenId`, 0099: on a shared bill, the debtor the money came from, for the receipt, NULL elsewhere, RESTRICT, not indexed; `settlementId`, 0085: the settlement a row was taken in, NULL on a bill settled alone; `externalRef`, Whish only, compared as `lower(btrim(…))` through 0091's expression index so that one reference stands on one receipt), `payment_settlements` (0085: one press that settled several of one citizen's bills — the «BRC-» number, the notes, the change, the retry key), `billing_run_entries`, `whish_checkouts` (`state` `MISMATCHED`, 0090: a success callback for an amount other than the one quoted; nothing is credited), `system_settings`, `inspector_payouts` (`expenseVoucherId`, 0086: the «PV-» voucher that paid it once the treasury is live, unique, NULL before; a payout whose voucher is voided is not counted as paid, a filter both readers apply; a payout with a voucher is written once and never deleted, and the link is made at insert or never, 0089; `clientRequestId`, 0089: the dialog’s retry key, unique, on both paths, so a retried press is answered with its payout before go-live too) | `FeesService`, `PaymentLedgerService`, `PaymentSettlementService` (settlements; each bill through `PaymentLedgerService.recordIn`), `CorrectionBillsService`, `StaffService` (payouts; once live through `ExpensesService.recordCommission`) |
| Review and quality | `record_reviews`, `quality_checks`, `data_quality_dismissals` | `RecordReviewService`, `DataQualityService` |
| Audit | `audit_log_entries` | `AuditService`, `PrismaAuditRepository` |
| Transfers (0078, 0084, 0088) | `treasury_transfers` (0084: `feeAmount` and `feeVoucherId`, the «PV-» voucher that books a fee, both set or both NULL; `moneyChangerName`, exchanges only; `backdateReason`; `requiresReview` and the review stamp `reviewedAt`/`reviewedById`/`reviewNote`, only on a flagged transfer, and in the write-once trigger's stamp list since 0088) and, on `system_settings`, `exchangeRateTolerancePercent` (default 3) and `largeExchangeThreshold` (default 1000) | `TransfersService` (the collector handover, internal transfers with their fee, exchanges, the review); `ExpensesService.recordTransferFee` writes the fee voucher |
| Expenses (0074, 0081, 0083, 0091) | `expense_categories`, `expense_vouchers` (the payment order: `orderedAt`, `orderedById`, `urgentReason`, 0083; `payeeStaffId`, 0081: the staff account a salary or commission voucher paid, NULL otherwise; a FK to `users` that cannot say STAFF, so `recordSalary` and, for a commission, `StaffService.recordInspectorPayout` filter `kind`; `salaryPeriod`, 0091: the `YYYY-MM` a salary voucher pays, written only by `recordSalary` and only with `payeeStaffId`, one per staff member per month among vouchers not cancelled — the partial unique index `expense_vouchers_salary_period_key`; NULL on every other voucher and on salaries paid before 0091), `expense_requests` (requests for the manager's order, 0083) | `ExpensesService` |
| Income (0080, 0083) | `income_categories`, `income_vouchers` (`payerName` is free text that may name a citizen; written once, 0083) | `IncomeService` |
| Document numbers (0079) | `document_counters`, one row per (book, month) | `allocateDocumentNumbers` |
| Daily count and closing (0082, 0087) | `treasury_day_closures` (one row per closed or reopened day; written once, 0087), `treasury_counts` (one count per wallet per day; linked only to its own day's closure, 0087) | `DayClosureService` (close, sweep, reopen), `DailyCountService` (counts) |
| Treasury (0073, 0083, 0091) | `treasury_accounts`, `treasury_entries`, `system_settings.treasuryGoLiveAt`, `system_settings.urgentExpenseCeilingLbp` / `urgentExpenseCeilingUsd` (0083: the manager's ceiling on an accountant's urgent payment, `DECIMAL(14,2)`, NULL = none, CHECK NULL or > 0), and `system_settings.salaryUrgentCeilingLbp` / `salaryUrgentCeilingUsd` (0091: «سقف صرف الرواتب», the most an accountant may pay one staff member as a month's salary, typed and CHECKed as the urgent ceiling; set in `FeesService.updateSettings`) | `TreasuryService` (activation, reads), `TreasuryLedgerService` (entries; called from `PaymentLedgerService` inside its transaction) |
| Municipal requests (0092, 0094) | `request_type_settings` (the manager's list: `enabled`, `feeAmount` in whole pounds, 0 for a free type, who set it), `citizen_requests` (the «REQ-» number, `channel`, the card and flat it is about, the status with its stamps by CHECK, `citizenPaymentId`: the fee's bill, unique; one open request per citizen, type and card; its life held by `citizen_requests_guard`, 0094) and `citizen_request_attachments` (the object's key in the private documents bucket, its sniffed type). Citizen data: `purpose`, `statement`, `clearanceSnapshot` and `rejectionReason` are free text about a person, and the attachments are identity copies and deeds. Every link to `users`, `property_entries`, `building_units` and `citizen_payments` is RESTRICT | `CitizenRequestsService`; `CitizenMergeService`, which moves a person's requests with them; `FeesService.cancelBill`, which cancels the request waiting on a bill it cancels (`cancelRequestOfCancelledBill`). A card or a flat a request names is never deleted: `CitizensService.update` refuses first (`PROPERTY_NAMED_BY_REQUEST`), a landlord-link undo keeps it (`HAS_REQUESTS`) |
| Ledger | `_tenant_migrations` (no Prisma model) | `migrateTenantSchema` |

Each schema also carries plpgsql functions created by migrations:
`reject_audit_mutation`, `reject_ledger_mutation`, `reject_treasury_mutation`,
`search_normalize`, `search_compact`, `sync_building_unit_counts`; since 0082
`reject_closed_day_entry`, `reject_closed_day_count` and `reject_day_closure_delete` (each pinned
to its schema); since 0083 `reject_treasury_document_mutation`; since 0085
`reject_settlement_mutation`; since 0087 `reject_day_closure_rewrite` (reads only its row,
pinned to `pg_catalog`) and `reject_count_link_elsewhere` (pinned to its schema); since 0088
`reject_transfer_review_rewrite` (keeps a transfer's review from being rewritten; reads only its row,
pinned to `pg_catalog`); since 0089 `reject_inspector_payout_rewrite` (reads only its row, pinned
to `pg_catalog`); and since 0094 `guard_citizen_request` (a citizen request's life; reads its bill,
card and flat, so pinned to its schema).

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

**A رقم العقار is saved in Latin digits since 2026-10-14**: every schema it is
written through (`propertyNumberField` for a card, a building, its shared
parcels and a parcel correction; a zone's parcels; a case; the blur check and
the building filter) normalises it, so «٤٢٠» is saved «420». Rows saved
before keep what was typed, and so do the fee lines copied from them and the
cadastre's own labels (`parcels.parcelNumber`), so a lookup by رقم العقار still
compares digit-normalised values on both sides (`normalizeDigits`; in SQL,
`translate(btrim(…), ${EASTERN_DIGITS}, ${LATIN_DIGITS})` with both constants
bound from `@mechanization/shared-schemas`, as `parcel-dues.service.ts` and
`PrismaParcelRepository` do). There is no backfill. A map keyed by the number
is keyed by `parcelNumberKey`.

**A flat's billing facts live on `units`** (`0075`, `0077`, `0095`), beside its status:

| Column | What it means |
|---|---|
| `ownerBillingMode` | «توزيع الرسم على المالكين» when the flat has several current owners: `EQUAL`, `BY_SHARES` (each owner's `unit_occupancies.shares` over the sum of all of them) or `RESPONSIBLE_OWNER`. NULL means nobody chose, and is billed as `EQUAL` (decision of 2026-10-07). |
| `responsibleOwnerId` | The owner who pays the whole under `RESPONSIBLE_OWNER`, and only then. `units_responsible_owner_needs_mode` uses `IS NOT DISTINCT FROM`: with `=`, a CHECK passes on the NULL that `NULL = 'RESPONSIBLE_OWNER'` yields. |
| `feeExemption`, `feeExemptionNote`, `feeExemptedById`, `feeExemptedAt` | «معفاة من الرسوم»: `PLACE_OF_WORSHIP`, `PUBLIC_FACILITY` or `OTHER` (which needs the note). Set and lifted together (`units_fee_exemption_fields`). An exempt unit is charged nothing by a rate-based notice; a rented waqf shop is not exempt, its tenant pays. |
| `levels` | How many levels the one unit spans, upward from `floor` (its entrance): 2 is a «دوبلكس», 3 a «تريبلكس» (decision D28, 2026-10-17). 1 on every unit before 0095. Between 1 and 6 (`units_levels_range`), and above 1 only on a شقة or a منزل مستقل (`units_levels_dwelling_only`). Under a PER_UNIT notice a multi-level flat weighs `system_settings.levelFactors[levels]` roofs (`{"2": 1.8}` by default; JSONB object by CHECK `system_settings_level_factors_object`, shape by `levelFactorsSchema`), and a house on N storeys weighs N. |

**Who is paid for a unit line is on the line** (`0096`, `0097`). `building_units.filedById` is the
staff member who created the line; an inspector earns $1 per distinct unit he filed
(`creditBillableUnits` in `packages/shared-schemas/src/inspector-earnings.ts`), and the line is his
whoever registered the citizen. NULL means the officer of the registration the card was filed on
(`COALESCE("filedRegistrationId", "registrationId")`), which is how every line was read before the
column existed and what a line filed with its registration still means. Every path that adds a line
to an existing file sets it: the matrix and owner links through `BuildingsService.claimOnFile` (which
requires it), and the edit form for the lines and cards a save adds. Read it through `filedByOf`, and
load an officer's work through `creditedRegistrationsWhere`
(`infrastructure/repositories/earnings-registrations.ts`), which also brings the files he only added
lines to. `ON DELETE RESTRICT`: staff are soft-deleted, and a hard delete must not move the credit.
`0097` filled the lines already on file from the audit trail (one staff actor on an
`OCCUPANCY_RECORDED` / `LANDLORD_LINKED` / `LANDLORD_LINK_UPDATED` row within 400 ms of the line),
then the owner link's receipt, and left a line with its file's officer when it was written with the
registration or during a `CITIZEN_UPDATED` by the named actor: `building_units.createdAt` is not when a
line was filed ([gotchas.md](gotchas.md#a-registrations-officer-is-not-who-filed-the-lines-on-it)).
Incident: [incidents.md](incidents.md), entry 9.

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
- `payment_settlements`: `payment_settlements_no_update` and `payment_settlements_no_delete`
  call `reject_settlement_mutation()` (`0085`). A ledger row joins its settlement at insert
  (`payment_transactions.settlementId`, RESTRICT), since the ledger refuses UPDATE, so
  `PaymentSettlementService` writes the settlement first. Its foreign keys to `users`
  (citizen, collector, clerk) are RESTRICT.
- `treasury_entries`: `treasury_entries_no_update` and `treasury_entries_no_delete` call
  `reject_treasury_mutation()` (`0073`). A wallet balance is the SUM of its entries; there is no
  balance column. Its foreign keys to `users` and `treasury_accounts` are RESTRICT, so erasing a staff
  member or a wallet that has moved money fails instead of cascading into the trigger. An entry's
  currency equals its account's because the foreign key is the pair `(accountId, currency)`.
- `expense_vouchers`, `income_vouchers`, `treasury_transfers` and `expense_requests` are the
  documents behind those entries, and are written once (`0083`).
  - Triggers `expense_vouchers_written_once`, `income_vouchers_written_once`,
    `treasury_transfers_written_once` and `expense_requests_written_once` call
    `reject_treasury_document_mutation(<stamps>)`. An income voucher's stamps are its
    cancellation (`voidedAt`, `voidedById`, `voidReason`); its `voidedById` index is 0080's.
  - No row is deleted, and no column changes after insert except the trigger's named stamps.
    Those are the cancellation, the payment order, a request's decision and, on a transfer since
    `0088`, the review (`reviewedAt`, `reviewedById`, `reviewNote`); each goes from empty to a
    value once. `treasury_transfers_review_once` (`0088`) also refuses any change to a review once
    `reviewedAt` is set, so a note cannot be added to a review made without one.
  - A migration that adds a column some code path UPDATEs after insert must re-create the table's
    `*_written_once` trigger with that column in its stamp list, in a new migration — or every such
    UPDATE is refused. 0084 added the review stamp without it, and no review could be written until
    0088 (docs/gotchas.md).
  - A cancelled document, and a decided request, accepts nothing further: a reason a
    withdrawal never gave cannot be added to it later.
  - The function pins `search_path` and reads no table.
  - A later migration that backfills a new column on one of these tables wraps its
    `UPDATE` in `ALTER TABLE … DISABLE TRIGGER …_written_once` / `ENABLE TRIGGER`, in the same
    file. Without that the backfill is refused like any other edit.
  - `0083`'s own backfill stamps the order on vouchers written before it, and skips cancelled
    ones: they are closed and wait for nothing, and the trigger would refuse the stamp when the
    file runs a second time.
- **A closed treasury day takes nothing** (0082). `treasury_entries_respect_closed_days` refuses an
  entry inserted, updated or deleted whose day — `occurredAt AT TIME ZONE 'Asia/Beirut'`, the database's
  copy of `MUNICIPAL_TIME_ZONE` — is on or before a CLOSED `treasury_day_closures` row.
  `treasury_counts_respect_closed_days` refuses any write to a closed day's count except the one
  closing makes (linking it to its own day's closure, compared as the row minus `closureId`), and
  `treasury_day_closures_no_delete` refuses deleting a closure: a day is reopened, never erased. The
  application refuses first (`TreasuryLedgerService.post`, `CLOSED_DAY_MUTATION_BLOCKED`); a trigger
  refusal is read back by `closedTreasuryDay` (`check-violation.ts`). Closing takes `SHARE` on
  `treasury_entries` for the length of the close, so writers already in the day finish first. It
  reads the settings row (`FOR SHARE`) before that lock: settings row, then entries, the order
  every writer takes them in, or a close deadlocks with activation.
  - Since `0087`, `treasury_day_closures_written_once` (`reject_day_closure_rewrite()`) keeps a
    closure's `id`, `businessDate` and `createdAt` fixed and allows only CLOSED → REOPENED (who
    closed it unchanged) and REOPENED → CLOSED; any other change to a row is refused. Before it,
    an `UPDATE` of `businessDate` silently reopened a closed day.
  - `treasury_counts_link_own_day` (`reject_count_link_elsewhere()`) accepts a `closureId` only
    of the count's own day's closure, and never moves or clears one once set. It sorts before
    `treasury_counts_respect_closed_days`, so a wrong-day link is refused for what it is.
  - Neither message starts «treasury day … is closed», so `closedTreasuryDay` never reads them as
    the closed-day lock. A later migration that backfills a new column on `treasury_day_closures`
    disables the trigger around its `UPDATE`, as for the 0083 tables.
- **A commission payout paid by a voucher is written once** (`0089_inspector_payout_key_and_written_once`). What an inspector is still
  owed is read from the `inspector_payouts` rows alone, so `inspector_payouts_written_once`
  (`reject_inspector_payout_rewrite()`) refuses any change to a payout whose `expenseVoucherId` is
  set, and its `DELETE`: the money is corrected by voiding the voucher. A link is made in the insert
  or never (setting `expenseVoucherId` on a payout without one is refused). A payout recorded before
  go-live (no voucher) is left alone, so deleting a staff account still cascades to his figure-only
  payouts (`inspectorId`) and clears `recordedById` (SET NULL), and the in-app restore can still
  replace them; a linked payout never meets either cascade, because its voucher names the same two
  accounts (RESTRICT). A later migration that backfills a new column on `inspector_payouts` disables
  the trigger around its `UPDATE`. The same file adds `inspector_payouts.clientRequestId` (unique), the
  press's retry key on the payout row: a figure-only payout had nowhere to keep one, and a lost answer
  pressed again was recorded twice (`StaffService.recordInspectorPayout` answers a retry from it).
- **A citizen request's life is held in the database** (`0094_citizen_request_guard`), as the
  treasury's papers are. `citizen_requests_guard` (`guard_citizen_request()`) allows a request to start
  AWAITING_PAYMENT or IN_REVIEW with no bill and no stamp, on one of the citizen's own cards and a flat on
  that card; then only AWAITING_PAYMENT → IN_REVIEW, REJECTED or CANCELLED; IN_REVIEW → READY_FOR_PICKUP,
  REJECTED, or back to AWAITING_PAYMENT when its payment is reversed; READY_FOR_PICKUP → COMPLETED. The
  bill is linked once, while the request waits for payment; each step's stamps are written by that step
  alone; what was asked, for what and by whom never changes; a COMPLETED, REJECTED or CANCELLED request
  changes no more. Only `citizenId` moves, in any status: a merge «دمج ملفين» carries a person's
  requests, and its undo brings them back. No request is deleted. A CANCELLED request has no bill, or a
  bill that is itself CANCELLED: the manager's «إلغاء الفاتورة» cancels the request waiting on it
  (decision of 2026-10-13), which `0092`'s `citizen_requests_cancelled_without_bill` refused. The card
  check runs on insert only, since a merge moves registrations and requests in separate statements.
  Every refusal starts «citizen request» and raises `check_violation`: each is a code path that broke
  a rule, not a user's mistake to localise.
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
  `PrismaRegistrationRepository.translate`, inline in
  `ParcelCorrectionService`, and through `isUniqueViolationOn`
  (`application/features/treasury/retry-key.ts`) in the treasury's retry keys
  and `CitizensService.update` (a passport number another file holds:
  `CITIZEN_IDENTITY_DOC_TAKEN`, naming nobody, as the create path's
  `translate` now does). No helper is shared by all of them.
- A foreign-key violation (Prisma `P2003`) is a 500 unless mapped the same way.
  `PrismaRegistrationRepository.translate` maps the two a registration card can
  break — a building or a flat the register does not hold, which a queued
  registration can name — to `BUILDING_NOT_FOUND` and `UNIT_NOT_FOUND`
  (`NotFoundError`). Prisma 5 on Postgres names the constraint in
  `error.meta.field_name`, as `property_entries_buildingId_fkey (index)` and
  `building_units_unitId_fkey (index)` (`registration-references.spec.ts`).

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
- **Every lock a file takes is held until that file commits.** A statement's lock
  does not end with the statement: the migrator commits once per file. So once a
  file has run `ALTER TABLE … ADD COLUMN` on a table, it holds `ACCESS EXCLUSIVE` on
  that table to its last line, and every read and write of the table waits for the
  whole file. Adding a foreign key `NOT VALID` and `VALIDATE`-ing it later in the
  same file then gains nothing; only a `VALIDATE` in a later file of its own runs
  under `SHARE UPDATE EXCLUSIVE` without blocking readers and writers. `0085`'s
  header says the opposite («the check of existing rows … does not block the
  counter»): probed on Postgres 17, the file held `AccessExclusiveLock` on
  `payment_transactions` to its commit, and a second session's `SELECT` and
  `INSERT` timed out behind it (review of 2026-10-11). It is harmless at today's
  few thousand rows (sub-second), and the file is not edited (it may be applied);
  a table large enough to matter needs the column in one file and the `VALIDATE` in
  the next, or the size in the header to justify the lock, as for an index.
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
  PR #61 and #86 pattern). `develop` ended at `0083_treasury_controls`, with no `0082`, until the
  treasury set below reached it (#117, #118, 2026-10-11); it now ends at
  `0089_inspector_payout_key_and_written_once` (checked 2026-10-13). `0075`–`0077` (`chore/migration-0075-0077`: co-owner billing, the estate
  and institution record types, the unit fee exemption) followed the same path, their own PR into
  `develop`, then to `main` alone, before any release that writes the new columns or values.
- The treasury's are `0073_treasury_ledger`, `0074_expense_vouchers`,
  `0078_treasury_transfers`, `0079_document_numbering`, `0080_income_vouchers`,
  `0081_expense_voucher_payee_staff` (PR #104 and its review), `0082_treasury_day_closing`
  (PR #106, stage 5: the daily count and the day closing), `0083_treasury_controls` (PR #104's
  review), `0087_treasury_day_closure_written_once` (PR #106's review),
  `0086_inspector_payout_voucher` (PR #109: an inspector's commission paid as a voucher),
  `0084_treasury_exchange_and_review` (PR #111: transfers' fees, exchange and review, the exchange
  rule on `system_settings`), `0088_treasury_transfer_review_stamp` (PR #111's review: the
  review stamp in the write-once trigger) and `0089_inspector_payout_key_and_written_once` (the
  final-stack review: the payout’s retry key on its row, and a paid commission payout written once).
  `0073`–`0081` and `0083` reached `develop` in their own migrations-only PR (#107,
  `chore/migration-0073-0083`), merged before the code that reads them (#108). Seven are not on
  `develop` yet and follow the same path, in one migrations-only PR ahead of this branch's code:
  `0082_treasury_day_closing`, `0084_treasury_exchange_and_review`, `0085_payment_settlements`,
  `0086_inspector_payout_voucher`, `0087_treasury_day_closure_written_once`,
  `0088_treasury_transfer_review_stamp` and `0089_inspector_payout_key_and_written_once`. Their needs:
  `0082` needs `0073`; `0084` needs `0074` and `0078`; `0085` needs nothing newer than `0079` (the
  `BULK_RECEIPT` book); `0086` needs `0074`; `0087` needs `0082`; `0088` needs `0083` (the trigger
  function) and `0084` (the columns); `0089` needs `0086` (the link). None ships ahead of the
  finance set.
  - The PRs for `0073`/`0074` (#94, #93) were closed unmerged on 2026-10-08, but the branches are
    still on `origin`, so those numbers stay reserved and are never reused.
  - `0078` is not `0075` because `chore/migration-0075-0077` took that number mid-flight: the
    second time a number was taken mid-flight on that branch (the out-of-order landing is below).
  - `0082_treasury_day_closing` was numbered on 2026-10-10 on `feat/treasury-daily-count-and-closure`
    (cut from `fix/expense-retry-key-race`, which carries `0073`–`0081`), after a fetch showed no
    branch holding an `0082` or later.
  - `0083_treasury_controls` was first written as `0080`, renumbered to `0082` when
    `0080_income_vouchers` and `0081_expense_voucher_payee_staff` landed on the same PR, and to
    `0083` when PR #106 brought `0082_treasury_day_closing` (2026-10-10). It had been applied
    nowhere but throwaway databases. The two touch different tables, so either merge order works:
    a database that already has `0083` takes `0082` out of order, with `deploy.mjs`'s warning.
    That is now the case on `develop`, which has `0083` and no `0082`.
  - On 2026-10-10, in the merge of PR #109 into `feat/treasury-day-closing`, every number from
    `0083` to `0087` was given out so that none is used twice across `develop` and the open PRs:
    `0083_treasury_controls` is `develop`'s (PR #107); `0084` is PR #111's
    (`0084_treasury_exchange_and_review`) and `0085` PR #112's (`0085_payment_settlements`), both
    left free on this branch on purpose and since merged into it, PR #111 then PR #112 (2026-10-10,
    `0085` unchanged); `0086` and `0087` are this branch's, below. `0084`,
    `0085`, `0086` and `0087` do not depend on one another, so they apply alike in any order.
    `0086` and `0087` have not been applied to staging or production.
  - `0087_treasury_day_closure_written_once` was written as `0084` in the review fix for PR #106,
    and renumbered `0087` in that merge, since `0084` and `0085` belong to PR #111 and PR #112 and
    `0086` to PR #109. It needs `0082` (its tables) and never edits it: `0082` may already be on
    staging.
  - `0086_inspector_payout_voucher` was written as `0083_inspector_payout_voucher` on
    `feat/treasury-inspector-payouts-and-vouchers` (PR #109, cut from
    `feat/treasury-daily-count-and-closure`), and renumbered `0086` in that merge, because
    `develop`'s `0083_treasury_controls` already held `0083`. PR #109's branch on `origin` still
    carries the old name until the merge is pushed, and so does PR #111's, which was cut from it:
    PR #111 must take `0086` in place of its `0083_inspector_payout_voucher` when it lands, or the
    column is created twice under two names (harmless, being `IF NOT EXISTS`, but a second
    history row). It is one nullable column on `inspector_payouts`, which is in production
    (0025), with a unique index built without CONCURRENTLY on a table of tens of rows. It needs
    `0074`, and ships in its own migrations-only PR after the finance migrations.
  - `0084_treasury_exchange_and_review` keeps PR #111's number. It may be on staging, so it is not
    edited; what its review found in the database is fixed forward by `0088`, which needs `0083`
    (the trigger function) and `0084` (the columns) and ships after both. `0088` has not been applied to staging or production;
    whether staging holds `0084` was not checked. `0088` was the next free number on 2026-10-10,
    with `0085` reserved for PR #112, which has since been merged.
  - `0089_inspector_payout_key_and_written_once` (the final-stack review, 2026-10-11) took the next free
    number after a check of every branch, local and remote (`git ls-remote` matched every ref as last
    fetched), and of every open PR (#106, #109–#116): none held an `0089` or later. It needs `0086` and
    has not been applied to staging or production.
  - The treasury migration was itself first written as `0071` and renumbered when
    `0071_damage_habitable` and `0072_users_no_phone_rules` landed on `develop`.
  - A branch cut before a release is a branch whose numbers can be taken while you work:
    re-check before you open the PR, not only when you pick.
- Parallel branches reuse numbers and nothing errors: `0016_*` and `0017_*`
  each exist twice. `0059_staff_refresh_tokens` was merged to `develop` after
  `0066`, so it applies out of order: `deploy.mjs` warns and applies it. `0073` and
  `0074` reach a database that already has `0075`–`0077` the same way, with the same
  warning; the two sets touch different tables (checked on a scratch schema on the
  PR #104 review, 2026-10-09). On 2026-10-10 `feat/treasury-day-closing` holds the whole
  treasury run after `develop`'s `0083_treasury_controls`, in this order: `0082_treasury_day_closing`
  (PR #106), `0084_treasury_exchange_and_review` (PR #111), `0085_payment_settlements` (PR #112),
  `0086_inspector_payout_voucher` (PR #109, renumbered from its old `0083_inspector_payout_voucher`,
  which collided with `develop`'s), `0087_treasury_day_closure_written_once` (PR #106 review),
  `0088_treasury_transfer_review_stamp` (PR #111 review) and `0089_inspector_payout_key_and_written_once`
  (the final-stack review, 2026-10-11). `0085` needs nothing newer than `0079` (the `BULK_RECEIPT`
  book) and touches only `payment_transactions` and its own table. The finance audit remediation
  (2026-10-12, the audit of `refactor/ui-kit-adoption@68e3e55`) took `0090_finance_audit_enum_values`
  (`PaymentStatus.CANCELLED`, `WhishCheckoutState.MISMATCHED`, alone because a new value cannot be
  used in the transaction that adds it) and `0091_finance_audit_controls` (`fee_notices.clientRequestId`;
  `citizen_payments.issuedById` and the cancellation stamp with their CHECKs; `expense_vouchers.salaryPeriod`
  with a partial unique index over vouchers not cancelled; the salary ceilings on `system_settings`; an
  expression index on `lower(btrim(payment_transactions."externalRef"))`), after a check of every local
  and remote branch: none held `0090` or later. `0091` needs `0090` (its CHECK names `CANCELLED`), `0081`
  (`payeeStaffId`) and `0083` (the urgent ceilings it mirrors). Its review (2026-10-13) added
  `0093_citizen_payment_cancellation_reason_present`: `0091` let a blank `cancellationReason` in, where
  every reason column since `0060` refuses one, and `0091` was already applied to the local database, so
  it is not edited. `0093` needs `0091`. `0090`, `0091` and `0093` ship in their own
  `chore/migration-0090-0091` PR (#119), and reach `main` in a release of their own, ahead of the code
  (PR #120), so that the build a rollback lands on already knows `CANCELLED` and `MISMATCHED` (decision of
  2026-10-13; [Release](#release)).
  `0092_citizen_requests` (municipal requests: `request_type_settings`, `citizen_requests`,
  `citizen_request_attachments` and their five enums) took its number on 2026-10-13, after a check of
  every local and remote branch, before `0093` was taken. It needs nothing newer than `0079` and
  alters no existing table; its foreign keys hold `SHARE ROW EXCLUSIVE` on `users`, `property_entries`,
  `building_units` and `citizen_payments` until the file commits (writes to them wait, for
  milliseconds: the new tables are empty). Its review (2026-10-13) added `0094_citizen_request_guard`,
  which needs `0092` and `0090` (`CANCELLED`): `0092` was already applied to the local database, so it
  is not edited. `0092` and `0094` ship alone in `chore/migration-0092` (PR #121), ahead of the code
  that reads them (PR #122).
  On 2026-10-13 the four PRs became one stack, merged to `develop` in order: #119, #120, #121, #122.
- `0095_unit_levels` (`units.levels`, `system_settings.levelFactors`: duplexes and the per-roof
  factor, decision D28) took its number on 2026-10-17 after a check of every remote branch (none
  carried `0095` or later). It needs nothing newer than `0083` and is additive: two columns with
  constant defaults (no rewrite) and three CHECKs every existing row passes. It ships alone in
  `chore/migration-0095`, ahead of `feat/unit-levels`, which reads it.
  Staging migrates itself on every push to `develop` that touches a migration (`deploy-staging.yml`),
  and production from `main`, so `0090`, `0091` and `0093` reach both first and `0092` follows them out
  of order, with `deploy.mjs`'s warning (it flags a pending migration that sorts before one already
  applied). A database that took `0092` before `0090` and `0091`, as a developer's may have, flags those
  two only, not `0093`. None of the five is on `develop` yet, so CI has applied none to staging or
  production; a hand-run `db:deploy:staging` was not checked. The next free number is `0098` (checked
  2026-10-21, below); list every unmerged branch again before you take it.
  - `0091`'s header is wrong in three places, and the file is not edited (it is applied). It says «one
    Whish or bank reference», but only a Whish settlement writes `externalRef`. It lists the
    `ACCESS EXCLUSIVE` locks on the tables it alters, but its two foreign keys also hold
    `SHARE ROW EXCLUSIVE` on `users` until it commits, so every write to `users` (a staff presence stamp
    included) waits for the file, for well under a second. And it says a recurring run's bills name
    nobody, but a run a staff member starts (`POST fees/recurring/run`, `FeesService.runRecurringBilling`)
    names that staff member; only the scheduled run leaves `issuedById` NULL.
  - `0092`'s header is wrong on the stack in two places, and the file is not edited (it is applied). It
    says the fee's bill is raised only when the citizen goes to pay because «nothing on this branch can
    cancel a bill». Since #120, below it, the manager's «إلغاء الفاتورة» (`FeesService.cancelBill`) can, and
    a request waiting on such a bill could then be neither paid, nor rejected or cancelled
    (`citizen_requests_cancelled_without_bill`), and held `citizen_requests_one_open_key` for ever.
    `0094` replaces that CHECK with its guard, and the code cancels the request with its bill (decision of
    2026-10-13, PR #122). It also cites `docs/municipal-requests-plan.md` and `docs/open-decisions.md`
    §20, which arrive with PR #122; §20 is kept for them (the PR #120 review's decisions are §22).
- `0096_building_unit_filed_by` (`building_units.filedById`: who filed a line, and so who is paid for
  it) and `0097_building_unit_filed_by_backfill` (filling it for the lines already on file) took their
  numbers on 2026-10-21 after a check of every local and remote branch and of the open PRs (#128 and
  #129 carry `0095` only). They were written as `0095` and `0096` on 2026-10-16 and renumbered when
  `0095_unit_levels` reached `develop` (#127) while they were in progress; they had been applied
  nowhere under the old numbers. `0096` is additive: a nullable column, its index and a
  `RESTRICT` key to `users` (which holds `SHARE ROW EXCLUSIVE` on `users` until the file commits, as
  `0091`'s keys do). `0097` needs `0096`, `0045` (`landlordLinkFootprint`) and `0061`
  (`filedRegistrationId`), writes only the new column, and is a no-op on replay. The previous build
  ignores the column and the new build reads NULL as before, so neither order of release breaks a
  running API. They ship together in `chore/migration-0096-0097`, ahead of `feat/earnings-by-actor`.
  Dry-run on production through the read-only views (2026-10-21): 191 lines assigned (186 from the
  trail, 5 from link receipts), 18 kept with their file's officer.
- `0098_fee_basis_tiered_area` (the `FeeBasis` value `TIERED_AREA`, alone, as the enum rule requires)
  and `0099_tiered_fee_matrix` (the bracket table on `fee_notices`, the shared unit bill, its debtors,
  the payer on a transaction) took their numbers on 2026-10-23 after a fetch and a check of every
  local and remote branch showed none holding `0098` or later (open PRs were not listed: `gh` was not
  installed; every PR head is a remote branch). `0099` needs `0098` (its CHECK uses the value),
  `0017` (the ledger), `0030` (`units`, `OccupancyRole`) and `0010` (the per-citizen unique index it
  leaves alone). It is additive: nullable columns, a new table, four CHECKs every existing row
  passes, and `citizen_payments."citizenId"` relaxed from NOT NULL. `schema.prisma` keeps
  `citizenId` required on purpose (the product owner's choice, 2026-10-23): making it `String?`
  breaks 28 reads of a bill's citizen, which the feature PR fixes for shared bills as it flips the
  type, and nothing writes a NULL before then. It is the one known gap between the datamodel and the
  database after this PR. The previous build ignores all of
  it and keeps working. Once the code that issues a shared bill ships, a build from before it cannot
  read that bill (no citizen), so a rollback past that release needs no shared bill issued. They ship
  together in `chore/migration-0098-0099`, ahead of `feat/tiered-fees-matrix-engine`. The next free
  number is `0100`.
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
- A new enum value MUST reach `main`, migration and Prisma enum, in a release
  before the one whose code writes it. A rollback (`rollback-production.yml`, on
  `main`) points production at an earlier build, whose Prisma client throws on
  any row holding a value it does not know
  ([gotchas.md](gotchas.md#the-previous-build-cannot-read-a-value-it-does-not-know)).

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
4. Ship the migrations before the code that writes the value, and to `main` in
   an earlier release than that code ([Release](#release)).

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

Seven books — invoices, receipts, expense vouchers, transfers, income vouchers
(«RV-», kind `REVENUE_VOUCHER`, since 0080), bulk receipts («BRC-», `BULK_RECEIPT`,
since 0085) and municipal requests («REQ-», `REQUEST`, since 0092) — share one scheme:
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
  own comment as a design decision. `payment_settlements` (0085) is not in
  `TABLE_ORDER` either, for the same reason, and it names the citizen who paid.
- **`BackupService` does not export the treasury tables:** `treasury_accounts`,
  `treasury_entries` (0073), `expense_categories`, `expense_vouchers` (0074), `treasury_transfers`
  (0078), `document_counters` (0079), `income_categories`, `income_vouchers` (0080),
  `treasury_day_closures`, `treasury_counts` (0082) and `expense_requests` (0083) are not in
  `TABLE_ORDER` (checked 2026-10-10).
  - Their rows are append-only or written once, and RESTRICT-linked to `users`. So a restore,
    which deletes users, aborts for any tenant that has activated its treasury, exactly as for
    `payment_transactions`; even the opening balances carry the activating manager's id. A
    restore would also meet the no-delete trigger on `treasury_day_closures`.
  - A backup of such a tenant therefore does not contain its wallets, nor the documents that
    explain them, nor its counts and closed days. The free-text payee and payer columns may
    name a citizen.
  - `inspector_payouts` *is* exported, and since `0086` carries `expenseVoucherId`. A non-NULL
    link exists only once a voucher does, and such a tenant already cannot be restored, so the
    column adds no new failure (the snapshot version is unchanged). Nor does `0089`: its
    `clientRequestId` is one more nullable column (an older snapshot reads as NULL), and its
    trigger refuses deleting a linked payout only — the restore empties the table, and a tenant
    with a linked payout already fails on its voucher's RESTRICT; figure-only payouts are deleted
    as before.
  - The in-app restore is not reachable: `BackupController` is not registered
    (`presentation.module.ts`), and disaster recovery is the `pg_dump` path, which discovers
    schemas at run time and carries every table.
  - **Undecided:** how the in-app backup should carry an append-only ledger and the vouchers
    that explain it.
- **`BackupService` does not export the municipal requests tables either** (0092):
  `request_type_settings`, `citizen_requests` and `citizen_request_attachments` are not in
  `TABLE_ORDER` (checked 2026-10-13).
  - Every link from them to `users` is RESTRICT, and the restore deletes `users`: so it aborts for a
    tenant with a single request, and for one whose manager has set a single request type
    (`request_type_settings.updatedById`), money or not, as it does once the treasury is live. The
    guard of 0094 refuses deleting a request too.
  - A backup of such a tenant carries no requests, no request types and no keys to the identity
    copies; disaster recovery is the `pg_dump` path, which carries them.
  - **Undecided:** whether the in-app snapshot should carry them (a downloadable file would then hold
    the citizens' free text and the keys to their identity copies), with the ledger question above.
- **`dump-tenant.js`, the `reissue-references` CSV, the `claude_ro` views**:
  see [Moving data](#moving-data-between-environments).
- **Database roles.** One role per environment runs both DDL and DML for every
  tenant schema ([security.md](security.md)).
