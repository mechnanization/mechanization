# Cleanup sprint: full codebase audit — task list

Audited 2026-11-23 on `feat/arrears-lump-sum@4224db6f` (= `origin/develop@ff70e839` + the one lump-sum commit).
Every `origin/feat/arrears-*` branch is 0 commits ahead of `develop`, so the working tree holds all the old-debts code.
Read-only: no file in the repository was changed, no branch or commit made.

Rules cited by ID: code-quality.md rules 1–12 and its Debt tables ("CQ Backend", "CQ Frontend", "CQ Data", "CQ CI");
ui-ux-standards.md (`BAN-*`, `PRIM-*`, `CTL-*`, `STA-*`, `TXT-*`, `LAY-*`, §17.x); security.md Known gaps ("SEC gap");
CLAUDE.md non-negotiables 1–9. **Tracked** = the row already exists; **NEW** = not in any debt table today.

Method: grep / `wc -l` / small node scans over the tree; the prose-throw count uses the ratchet spec's own regex.
Two scans are heuristics and say so where used (double-submit guards, queries in loops).
Not audited: database indexes against real query plans (needs EXPLAIN on a database with data; see PERF-03);
bundle sizes (no build was run); nothing was run against staging or production.

**The goal of the sprint:** one architecture and one set of patterns across the codebase, and pages that each have one
clear job and one clear way in. Every task below serves that; section 12 covers the navigation and the pages themselves.

---

## 0. How to execute any task (binding for every person and every AI agent)

Paste this block into the agent's prompt with the task. It applies to all 176 tasks below.

1. **Read first.** CLAUDE.md, the guide for the layer you touch (apps/backend/CLAUDE.md, apps/frontend/CLAUDE.md,
   packages/shared-schemas/CLAUDE.md), docs/code-quality.md, and for UI docs/ui-ux-standards.md. Re-run `git status` and
   `git log` before you trust a number in this file: re-count, the code wins.
2. **Do the task as scoped.** One task = one PR. Do not fix an unrelated problem silently (CLAUDE.md: "Stay in scope").
3. **Sweep while you are there.** Before you open the PR, check *every file you touched* for:
   - the patterns this audit counts: `as never` / `as unknown as`, prose throws, bare `$transaction`, `?? N` beside an
     `envSchema` default, policy literals, `process.env`, copied role lists, `loadSession`, inline `en ?` copy,
     `payload.message`, `toISOString().slice(0, 10)`, palette classes and hex, native controls, writes without an
     in-flight ref, unbounded `findMany`, `Number(limit)`;
   - **redundancy**: a helper, type, constant, label, query, component or whole screen that already exists elsewhere
     (grep for it, or `graphify query "<name>" --budget 1500`); two buttons or links that lead to the same place; a
     page section that repeats another page; dead code (no importers, no callers, no readers);
   - comments that contradict the code (CODE-7, BAN-15).
4. **Log everything the sweep finds — never drop it.** For each finding:
   - If it is in a file this task already changes **and** the fix is small and of the same kind as the task, fix it in
     the same PR and say so in the PR description.
   - Otherwise do **not** fix it. Add it to this file: append it to the matching existing task's **Files/Problem**
     (say "found during [ID]"), or, if no task covers it, add a row to the **Found during the sprint** table at the end
     of this file with the next free ID in its category. Also add the row to the debt table it belongs in
     (docs/code-quality.md, ui-ux-standards §17, or security.md Known gaps), as those docs require.
   - A security finding or anything touching citizen data is reported to Hashem the same day, not just logged.
5. **Report.** The PR description lists: what was done, what the sweep found (with the IDs it was logged under), what
   ran, what failed, what was skipped. Exit code 0 is not proof; verify the thing that matters (CLAUDE.md).
6. **Docs are part of the change.** Update the docs the CLAUDE.md docs table names, and the counts this file gives.

---

## 1. DRY

## [DRY-01] Declare one actor type and build it with a parameter decorator
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** DRY
- **Files:** new `application/common/actor.ts` (`StaffActor`); new `presentation/decorators/current-actor.decorator.ts`; `type Actor` removed from `arrears/arrears-batch.service.ts:39`, `arrears/arrears.service.ts:35`, `buildings/owner-billing.service.ts:21`, `citizens/ownership.service.ts:1006`, `citizens/tenancy.service.ts:1016`, `corrections/unit-correction.service.ts:34`, `quality/record-review.service.ts:79`, `scripts/seed-census.ts:76`; the 84 inline `{ id: user.sub, role: user.role ?? '' }` in 21 controllers (citizen 14, fees 13, expenses 10, arrears 9, staff 6, transfers 4, income 4, zones 3, treasury-closing 3, cases 3, and 11 more with 1–2)
- **Problem:** Tracked (CQ Backend, the `type Actor` row) — and grown: 8 declarations, not 6 (the two arrears services added two); 84 inline builds, not 58; 137 `actor: { id: string; role: string }` parameters. `role: string` is why 85 casts read `actorRole: actor.role as never`.
- **Acceptance criteria:**
  1. `StaffActor` has `role` typed as the generated `$Enums.UserRole` (or the shared staff-role enum).
  2. `grep -rnE "^type Actor\b" apps/backend/src` returns 0; `grep -rn "id: user.sub, role: user.role" apps/backend/src/presentation` returns 0.
  3. `route-inventory.spec.ts` and every controller spec pass unchanged.
- **Depends on:** none
- **Verification:** `pnpm typecheck`; `pnpm lint`; `pnpm --filter @mechanization/backend test`; the two greps above.

## [DRY-02] Give Prisma error matching one home in infrastructure/prisma
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** new `infrastructure/prisma/prisma-errors.ts` (`isUniqueViolationOn`, `isSerializationFailure`); `treasury/retry-key.ts` (`isUniqueViolationOn` moved out); its importers in fees, staff, citizens (`CitizensService.update`); `buildings/parcel-correction.service.ts` (inline `P2002`); `corrections/unit-correction.service.ts` (`P2034`); `infrastructure/repositories/user.repository.ts` and `registration.repository.ts` (`translate`); apps/backend/CLAUDE.md allowed-imports list.
- **Problem:** Tracked (CQ Backend, two rows: `isUniqueViolationOn` and "each place matches Prisma error codes its own way"). Also `PrismaUserRepository.translate` fallback says «هذه الوثيقة مسجّلة مسبقاً لشخص آخر» for any unique violation (tracked row) — fix it here.
- **Acceptance criteria:**
  1. `grep -rn "'P2002'\|'P2034'" apps/backend/src --include=*.ts | grep -v spec` hits only `prisma-errors.ts`.
  2. No feature imports `treasury/retry-key` for a Prisma helper.
  3. The helper has its own spec; the user-repository fallback is the generic sentence.
- **Depends on:** none (do not race open treasury PRs — the CQ row says so)
- **Verification:** the grep; `pnpm typecheck`; backend tests; apps/backend/CLAUDE.md "Layers" list updated.

## [DRY-03] Build the building-suffix advisory-lock key in one function
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** XS · **Category:** DRY
- **Files:** `buildings/buildings.service.ts:1457` (`create`), `buildings/parcel-correction.service.ts:206`; new exported `buildingSuffixLockKey(schema, parcel)`.
- **Problem:** Tracked (CQ Backend: key built twice, must match character for character; CQ Data: both use `$executeRawUnsafe` where tagged `$executeRaw` suffices).
- **Acceptance criteria:** 1. `grep -rn "building-suffix" apps/backend/src | grep -v spec` hits one definition. 2. Both call sites use tagged `$executeRaw`.
- **Depends on:** none
- **Verification:** grep; `pnpm typecheck`; buildings + parcel-correction integration suites on a throwaway PG17.

## [DRY-04] Move csvCell into shared-schemas with one spec
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** `reporting/reporting.service.ts:2247` (`csvCell`), `apps/frontend/lib/csv.ts:189` (`csvCell`), new `packages/shared-schemas/src/csv.ts` + spec.
- **Problem:** Tracked (CQ Frontend: "the same security helper written twice"); the frontend copy is untested (apps/frontend/CLAUDE.md, Tests). Formula-injection guard; the export carries citizen PII (non-negotiable 7).
- **Acceptance criteria:** 1. One definition; both apps import it. 2. The spec covers `= + - @ \t \r` prefixes and quoting.
- **Depends on:** ARCH-22 (a test runner in shared-schemas) or put the spec in backend.
- **Verification:** `grep -rn "function csvCell" apps packages` → 1; shared build; both apps' tests.

## [DRY-05] Share one Sentry redaction implementation between the apps
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** `presentation/config/sentry-redaction.ts` (+ spec), `apps/frontend/lib/sentry-redaction.ts`, `apps/frontend/lib/sentry-options.ts`; target `packages/shared-schemas/src/sentry-redaction.ts`.
- **Problem:** Tracked (CQ Frontend). The frontend copy has no test; it is the only thing between a citizen's رقم مرجعي in a URL and Sentry on the portal (non-negotiable 7).
- **Acceptance criteria:** 1. One implementation, one spec, both apps import it. 2. The backend spec passes against the shared module.
- **Depends on:** none
- **Verification:** `ls apps/frontend/lib/sentry-redaction.ts` → absent (or a re-export); both test suites.

## [DRY-06] Delete the backend copy of the Beirut day boundary and the float money checks
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** `treasury/income.plan.ts:98` (`municipalDayStart`) vs `packages/shared-schemas/src/cash-policy.ts:47`; `income.schema.ts:66` (`receivedAmount`); `treasury-closing.schema.ts:40` (`twoDecimals`, `value * 100`).
- **Problem:** Tracked (CQ Backend, two rows). `twoDecimals` is the float check `hasAtMostTwoDecimals` replaced (docs/gotchas.md). Money.
- **Acceptance criteria:** 1. `grep -rn "function municipalDayStart"` → 1 hit (shared). 2. `receivedAmount`, `twoDecimals` built on `positiveMoneyAmount` / `hasAtMostTwoDecimals`. 3. Count figures may still be zero and the expected figure signed.
- **Depends on:** none
- **Verification:** grep; shared build; treasury integration suites.

## [DRY-07] Remove call-site repeats of envSchema defaults
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** `audit/audit.service.ts:567,679` (`?? 20`), `quality/data-quality.service.ts:137` and `quality/record-review.service.ts:121` (`?? 180`), `reporting/reporting.service.ts:757` (`?? 60`), `tenant/tenant.service.ts:111` (`?? 300`), `presentation/main.ts:67` (`?? 4000`), `infrastructure/email/smtp-email.sender.ts:70` (`?? 587`).
- **Problem:** Tracked (CQ Backend: "schema defaults repeated at the call site"; code-quality rule 2).
- **Acceptance criteria:** 1. Each reads `config.getOrThrow` (or a typed config accessor); the default lives only in `envSchema`. 2. `SMTP_PORT` gets an `envSchema` default if it has none.
- **Depends on:** none
- **Verification:** `grep -rnE "config\.get<[a-z]+>\('[A-Z_]+'\) \?\? " apps/backend/src | grep -v spec` → 0.

## [DRY-08] Move policy literals into APP_CONFIG
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** `app.module.ts` `ThrottlerModule.forRoot` (`ttl: 60_000, limit: 120`); `fees/fees.service.ts:5984` (summary cache `30`); `SETTINGS_CACHE_TTL_SECONDS`; `identity/session-revocation.service.ts:26` (`TOKEN_VERSION_TTL_SECONDS = 30`); `UnitCorrectionService.applyLocked` `lock_timeout`; `bootstrap.ts` `1mb`; `AuditController` `DEFAULT_TIME_ZONE`; transaction timeouts `buildings.service.ts:3236` (15 s / 30 s), `infrastructure/context/tenant-transaction.ts:43` (15 s / 60 s), `BackupService` (15 s / 120 s).
- **Problem:** Tracked (CQ Backend: policy literals row; transaction-timeouts row).
- **Acceptance criteria:** 1. Named entries `APP_CONFIG.throttle.default`, `.cache.*`, `.transactions.*`, `.http.bodyLimit`. 2. No numeric literal left at those sites.
- **Depends on:** ARCH-07 (APP_CONFIG moves first, or this adds four more presentation imports)
- **Verification:** grep each site; `pnpm typecheck`; backend tests.

## [DRY-09] Run a function as a tenant through one helper
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** DRY
- **Files:** `presentation/middleware/tenant.middleware.ts`, `application/background-jobs/otp-cleanup.job.ts`, `recurring-billing.job.ts`, `staff-refresh-token-cleanup.job.ts` (all build `TenantPrismaFactory` scopes by hand).
- **Problem:** Tracked (CQ Backend names three; the staff-refresh cleanup job is a fourth — NEW detail).
- **Acceptance criteria:** 1. One `runAsTenant(slug, fn)` in `infrastructure/context`. 2. The three jobs use it; the middleware uses it or shares its core.
- **Depends on:** none
- **Verification:** `grep -rn "TenantPrismaFactory" apps/backend/src/application | grep -v spec` → only the helper's caller list; job specs pass.

## [DRY-10] Export one tenant schema-name validator
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** `TenantPrismaFactory` `SAFE_SCHEMA_NAME`, `tenant-migrator.ts` inline regex, `tenant-schema-ref.ts` `SAFE_SCHEMA_NAME` (looser), `apps/backend/backups/dump-tenant.js`, `scripts/db/provision.mjs`.
- **Problem:** Tracked (CQ Data: four copies, three patterns). Tenancy is by schema (CLAUDE.md), so this is the isolation boundary.
- **Acceptance criteria:** 1. One pattern, one function, used by every site (the `.mjs` one through `TenantSlug` rules copied by import or a generated constant). 2. The looser pattern is gone.
- **Depends on:** none
- **Verification:** `grep -rn "SAFE_SCHEMA_NAME\|tenant_\[" apps/backend/src scripts/db` → only the helper; `pnpm db:test`.

## [DRY-11] Share the scripts/db helpers and let provision reads throw
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** DRY
- **Files:** `scripts/db/deploy.mjs`, `provision.mjs` (`C`, `withClient`, `inspect` `.catch(() => ({ rows: [] }))`), `backup.mjs`, `verify-restore.mjs` (`fail`).
- **Problem:** Tracked (CQ Data, two rows).
- **Acceptance criteria:** 1. One `scripts/db/lib.mjs`. 2. `inspect` no longer turns "unreadable" into "absent".
- **Depends on:** none
- **Verification:** `pnpm db:test`; `pnpm db:check`.

## [DRY-12] Replace the screens' copied role lists with lib/staff-roles.ts allow-lists
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** M · **Category:** DRY
- **Files:** `citizens/page.tsx:66` `CAN_WRITE`; `citizens/[citizenId]/properties/page.tsx:1062` `EDIT_ROLES`; `citizens/landlord-links/page.tsx:72` `SUMMARY_ROLES`; `quality/findings-list.tsx:121` `CITIZEN_EDIT_ROLES`; `audit/page.tsx:92`; `settings/page.tsx:86`; `staff/page.tsx:131`; `citizen-editor.tsx:1024`; `nav.ts:270,449,741,749`; plus 56 `role === '…'` checks in 23 files (list in the appendix grep).
- **Problem:** Tracked (CQ Frontend role-lists row; PRIM-22). Bug today: `CAN_WRITE` leaves out `COLLECTOR`, whom `REGISTER_WRITE_ROLES` admits on the server.
- **Acceptance criteria:** 1. Every list is an export of `lib/staff-roles.ts` built from the shared set the controller's `@Roles` uses, with a comment naming the controller. 2. Each changed list was checked against its controller before the change (who sees a button may change — say which in the PR). 3. `lib/nav.test.ts` passes.
- **Depends on:** none
- **Verification:** `grep -rnE "\['SUPER_ADMIN'" apps/frontend/app apps/frontend/components` → only `nav.ts` rows that import a shared set; `pnpm --filter @mechanization/frontend test`.

## [DRY-13] Read NEXT_PUBLIC_* config through one validated module
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** DRY
- **Files:** `NEXT_PUBLIC_API_URL` in 7 files: `lib/api-client.ts`, `middleware.ts`, `(citizen)/layout.tsx`, `[locale]/layout.tsx`, `(protected)/layout.tsx`, `manifest.webmanifest/route.ts`, `dashboard/page.tsx`; `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` in `fullscreen-map.tsx`, `parcel-pin-picker.tsx`, `zone-editor-map.tsx`. New `lib/public-config.ts`.
- **Problem:** Tracked (CQ Frontend says 10 files; it is 7 today). Each has its own fallback.
- **Acceptance criteria:** 1. `grep -rn "process.env.NEXT_PUBLIC_API_URL" apps/frontend --include=*.ts* | grep -v node_modules` → 1 file. 2. Same for the Mapbox token.
- **Depends on:** none
- **Verification:** the greps; `pnpm build:check`.

## [DRY-14] Fetch the tenant config through one server helper
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** DRY
- **Files:** `app/[tenant]/[locale]/layout.tsx:41` `getTenant`, `(citizen)/layout.tsx:9` `getTenant`, `(protected)/layout.tsx:47` `getTenantName`; new `lib/tenant-config.server.ts`.
- **Problem:** Tracked (CQ Frontend: fetched three ways).
- **Acceptance criteria:** 1. One function, with React `cache()` so a request fetches once. 2. Unknown tenant still `notFound()`.
- **Depends on:** DRY-13
- **Verification:** `grep -rnE "function getTenant(Name)?\b" apps/frontend/app` → 0; `pnpm build:check`.

## [DRY-15] Take the default locale from i18n/routing.ts
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** DRY
- **Files:** `middleware.ts:5` (`DEFAULT_LOCALE = 'ar'`), `i18n/routing.ts:3` (`defaultLocale = 'en'`).
- **Problem:** Tracked (CQ Frontend; docs/gotchas.md). Which value wins is a product fact: Arabic is the behaviour users see today; keep it.
- **Acceptance criteria:** 1. One constant; the redirect still lands on `ar` with no cookie and no Accept-Language. 2. gotchas.md entry removed.
- **Depends on:** none
- **Verification:** grep `DEFAULT_LOCALE` → gone; manual redirect check.

## [DRY-16] Import normalizeArabic instead of copying it, and use it in ConfirmDialog
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** DRY
- **Files:** `components/admin/bill-type-select.tsx:16`; `components/ui/confirm-dialog.tsx` (`requireText` compared raw, line ~86).
- **Problem:** Tracked (CQ Frontend; §17.1 ConfirmDialog DES-3).
- **Acceptance criteria:** 1. `grep -rn "function normalizeArabic" apps/frontend` → 0. 2. `requireText` compares normalised strings.
- **Depends on:** none
- **Verification:** grep; frontend tests.

## [DRY-17] Move CommandPalette's search onto useCitizenSearch
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** DRY
- **Files:** `components/admin/command-palette.tsx`, `lib/use-citizen-search.ts` (an option for a navigation search that offers merged and archived files).
- **Problem:** Tracked (CQ Frontend CommandPalette row).
- **Acceptance criteria:** 1. No `listCitizens` call in the palette. 2. The palette still lists merged and archived files to navigate to.
- **Depends on:** none
- **Verification:** grep; frontend tests.

## [DRY-18] Derive the offline enabledPropertyTypes fallback from the shared enum
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** DRY
- **Files:** `lib/api-client.ts` (offline fallback `enabledPropertyTypes: ['BUILDING','HOUSE','LAND','TENT']`).
- **Problem:** Tracked (CQ Frontend).
- **Acceptance criteria:** the literal is gone; the value comes from the shared enum.
- **Depends on:** none
- **Verification:** `grep -n "'TENT'\]" apps/frontend/lib/api-client.ts` → 0.

---

## 2. God files

Sizes today (the docs' numbers are stale): `fees.service.ts` 6,167 (doc 3,979), `buildings.service.ts` 5,896 (5,504),
`landlord-link.service.ts` 3,633 (3,601), `citizens.service.ts` 3,569 (3,362), `reporting.service.ts` 2,291 (2,054),
`citizen-merge.service.ts` 1,782 (1,588); `api-client.ts` 7,815 (6,701); 49 `.tsx` files over 600 lines under `app/` and
`components/` (doc 44). Tracked: CQ Backend god-files row, CQ Frontend api-client and 44-files rows (CODE-6).
Each extraction below is a move with no behaviour change, its own spec where the moved code holds decisions (rule 8).

## [GOD-01] Extract the Whish checkout and callback out of FeesService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** God-files
- **Files:** `fees/fees.service.ts` `startWhishCheckout` (4763), `parseWhishCallback` (4934), `settleFromWhishCallback` (4951), `markWhishCheckoutMismatched` → new `fees/whish-checkout.service.ts`; `FeesController`, `fees.module`.
- **Problem:** ~450 lines of a dormant flow (online payment paused) inside the 6,167-line service.
- **Acceptance criteria:** 1. `FeesService` no longer holds a Whish method. 2. Callback HMAC spec and Whish integration specs pass unchanged.
- **Depends on:** ARCH-01 (convert the bare transactions first so the move carries the fix)
- **Verification:** `wc -l fees.service.ts` drops ≥ 400; backend tests.

## [GOD-02] Extract fee notices (preview, issue, stop, cancel) into FeeNoticesService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** God-files
- **Files:** `fees.service.ts` `listNotices` (1657), `previewNotice` (1821), `issue` (1897–2527), `setNoticeActive` (2880), `cancelNoticeBatch` (5779), `noticePeriods` (5904) → `fees/fee-notices.service.ts`.
- **Problem:** The notice lifecycle is ~1,000 lines of the file; `issue` alone is 630.
- **Acceptance criteria:** 1. Moved methods keep their signatures; controller delegates. 2. Tiered-fee and notice integration suites pass.
- **Depends on:** ARCH-01
- **Verification:** backend tests on throwaway PG17; `wc -l`.

## [GOD-03] Extract the recurring biller into RecurringBillingService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** God-files
- **Files:** `fees.service.ts` `runRecurringBilling` (2528–2879), `categoryHolders` (2914) → `fees/recurring-billing.service.ts`; `background-jobs/recurring-billing.job.ts`, `InternalCronController`.
- **Acceptance criteria:** 1. The job and `POST fees/recurring/run` call the new service. 2. `actorType: 'SYSTEM'` behaviour unchanged.
- **Depends on:** ARCH-01, GOD-02
- **Verification:** recurring-billing specs; `wc -l`.

## [GOD-04] Extract bill cancel, write-off and reversal into BillLifecycleService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** God-files
- **Files:** `fees.service.ts` `listTransactions` (5501), `reverseTransaction` (5512), `cancelBill` (5566), `writeOffBill` (5664) → `fees/bill-lifecycle.service.ts`.
- **Problem:** Includes the old-debts «شطب» (task 9). Tier 1 audit rows must stay inside the transaction.
- **Acceptance criteria:** 1. Methods moved intact. 2. Write-off and cancel integration specs pass.
- **Depends on:** none
- **Verification:** backend tests; `wc -l`.

## [GOD-05] Extract occupancy writes out of BuildingsService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** God-files
- **Files:** `buildings/buildings.service.ts` `recordOccupancy` (3769–4266), `ensureOnFile` (4267), `endOccupancy` (4672–4845) → `buildings/occupancy-writes.service.ts`. Citizen data (non-negotiable 4 does not change; no new reads).
- **Problem:** ~1,000 lines; the dual record (UnitOccupancy + PropertyEntry) must stay written together.
- **Acceptance criteria:** 1. Moved intact. 2. Census integration suites pass on PG17.
- **Depends on:** ARCH-03
- **Verification:** backend tests; `wc -l`.

## [GOD-06] Extract vacancy and visits out of BuildingsService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** God-files
- **Files:** `buildings.service.ts` `confirmVacancy` (3385), `endVacancy` (3514), `logVisit` (4846), `visits` (4966) → `buildings/unit-visits.service.ts`.
- **Depends on:** ARCH-03
- **Acceptance criteria:** moved intact; vacancy-confirmation specs pass.
- **Verification:** backend tests; `wc -l`.

## [GOD-07] Extract unit CRUD out of BuildingsService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** God-files
- **Files:** `buildings.service.ts` `generateUnits` (2048), `addUnit` (2277), `updateUnit` (2671), `resizeUnitSpan` (3098), `deleteUnit` (3653) → `buildings/units.service.ts`.
- **Acceptance criteria:** moved intact; `atomic` callers keep one transaction; specs pass.
- **Depends on:** ARCH-03
- **Verification:** backend tests; `wc -l buildings.service.ts` < 2,500 after GOD-05..07.

## [GOD-08] Extract unlink, revert and detach out of LandlordLinkService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** God-files
- **Files:** `citizens/landlord-link.service.ts` `unlinkPreview` (2023), `unlink` (2096), `revertLink` (2210), `detachUnits` (2524), `releaseForSale` (2654) → `citizens/landlord-unlink.service.ts`.
- **Acceptance criteria:** the footprint revert stays exact; owner-link specs pass.
- **Depends on:** none
- **Verification:** backend tests; `wc -l`.

## [GOD-09] Extract the owner-link queue reads into LandlordLinkQueueService
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** M · **Category:** God-files
- **Files:** `landlord-link.service.ts` `candidatesFor` (92), `proposals` (152), `proposal` (168), `claimsFiledBy` (177), `claimsNaming` (189), `unbilledOwnedUnits` (2982), private `matchPairs` → `citizens/landlord-link-queue.service.ts`.
- **Depends on:** PAG-01
- **Acceptance criteria:** reads moved; queue specs pass.
- **Verification:** backend tests.

## [GOD-10] Extract duplicate detection out of CitizensService
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** M · **Category:** God-files
- **Files:** `citizens/citizens.service.ts` `reviewDuplicates` (1301), `possibleDuplicates` (1360) → `citizens/citizen-duplicates.service.ts`. Citizen PII is read here (non-negotiable 7: no new logging).
- **Acceptance criteria:** moved intact; duplicate specs pass.
- **Depends on:** none
- **Verification:** backend tests.

## [GOD-11] Extract the citizen CSV import out of CitizensService
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** God-files
- **Files:** `citizens.service.ts` `importMany` (1815–1941) → `citizens/citizen-import.service.ts`.
- **Depends on:** none
- **Acceptance criteria / Verification:** moved intact; import specs; `wc -l`.

## [GOD-12] Extract the citizen profile read out of ReportingService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** God-files
- **Files:** `reporting/reporting.service.ts` `getCitizenProfile` (1134–1737, ~600 lines) → `reporting/citizen-profile.service.ts`. Also the place to fix the tracked `profileOwnerBilling` row (CQ Backend), separately.
- **Problem:** The profile is a citizen-data read used by staff and by `GET citizens/me/summary` (reference-only login).
- **Acceptance criteria:** moved intact; profile specs and `mySummary` tests pass.
- **Depends on:** none
- **Verification:** backend tests.

## [GOD-13] Move the owner-link routes out of CitizenController
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** God-files
- **Files:** `presentation/controllers/citizen.controller.ts` (800 lines) `landlordLinks`, `landlordLinkSummary`, `confirmLandlordLink`, `dismissLandlordLink`, `restoreLandlordLink`, the candidate and unlink-preview routes → `citizen-landlord-links.controller.ts`.
- **Problem:** Tracked (CQ Backend god-files row lists `citizen.controller.ts`). Route order matters (`landlord-links` declared above `:id`).
- **Acceptance criteria:** 1. Same paths, same `@Roles`. 2. `route-inventory.spec.ts` and `cross-tenant-routes.spec.ts` pass.
- **Depends on:** SEC-03 (convert the raw bodies first)
- **Verification:** backend tests; apps/backend/CLAUDE.md and security.md updated (presentation row of the docs table).

## [GOD-14] Move apiFetch, the session and token renewal out of api-client.ts
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `lib/api-client.ts` lines 1–923 (`apiFetch`, `ApiRequestError`, "The staff session", "Handing a renewal to the other tabs") → `lib/api/core.ts`; `api-client.ts` re-exports so no importer changes.
- **Problem:** Tracked (CQ Frontend api-client row). This is the shell file (docs table row "frontend shell").
- **Acceptance criteria:** 1. No importer changes. 2. Session, renewal and api-errors tests pass.
- **Depends on:** none
- **Verification:** frontend tests; `pnpm build:check`; apps/frontend/CLAUDE.md and security.md updated.

## [GOD-15] Move the fees and payments client into lib/api/fees.ts
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `api-client.ts` "Fees & payments" (5256–6338).
- **Depends on:** GOD-14
- **Acceptance criteria / Verification:** re-export kept; typecheck; frontend tests.

## [GOD-16] Move the buildings, corrections and ownership client into lib/api/buildings.ts
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `api-client.ts` sections "Buildings" (1654), «تصحيح رقم العقار» (2514), «إنهاء الملكية» (2865), «حذف تصحيحي» (6518), «أنواع المباني» (7355).
- **Depends on:** GOD-14
- **Acceptance criteria / Verification:** as GOD-15.

## [GOD-17] Move the citizens, merge and owner-link client into lib/api/citizens.ts
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `api-client.ts` "Citizens registry" (3804), «دمج ملفين» (4333), "Owner links" (4523).
- **Depends on:** GOD-14
- **Acceptance criteria / Verification:** as GOD-15.

## [GOD-18] Move the remaining feature clients out of api-client.ts
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** "Zones" (1384), "Cases" (1470), "Staff accounts" (4845), "Backup" (6339), treasury stages 1/2/5 (6605, 7123, 7256), «الأخبار» (7454, 7549, 7699) → `lib/api/{zones,cases,staff,treasury,news}.ts`.
- **Depends on:** GOD-14
- **Acceptance criteria:** `wc -l lib/api-client.ts` < 300 (re-exports only). **Verification:** as GOD-15.

## [GOD-19] Extract the vacancy panels out of building-unit-forms.tsx
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `components/admin/building-unit-forms.tsx` `ConfirmVacancyForm` (2825), `EndVacancyDialog` (2982), `VacancyPanel` (3177), `SeasonalHomePanel` (3301) → `components/admin/units/vacancy/*.tsx`.
- **Acceptance criteria:** moved intact; importers updated; the five native date inputs move with them (UX-02 fixes them).
- **Depends on:** none
- **Verification:** typecheck; frontend tests; `wc -l`.

## [GOD-20] Extract occupants and owner-link dialogs out of building-unit-forms.tsx
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `AddPersonForm` (874), `EndOccupancyDialog` (2018), `OccupantList` (2218), `OwnerLinkCell` (2605), `LinkOwnerDialog` (2641) → `components/admin/units/occupants/*.tsx`.
- **Depends on:** none
- **Acceptance criteria / Verification:** as GOD-19; `wc -l building-unit-forms.tsx` < 1,500 after both.

## [GOD-21] Split BuildingEditor into its steps
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** L · **Category:** God-files
- **Files:** `components/admin/building-editor.tsx` (3,700): `BuildingEditor` (357–3614, one function), `STEPS` (201), `StepField` (3615), `DistanceBadge` (168), the lookup/duplicate logic (`LOOKUP_DEBOUNCE_MS`, `NEAR_DUPLICATE_METRES`) → `components/admin/building-editor/*` and pure rules in `lib/building-editor-*.ts` with tests.
- **Problem:** The held creation key and the in-flight ref (STA-4 history in §17.6) must survive the split.
- **Acceptance criteria:** 1. No file in the folder over 600 lines. 2. The held key `building:<parcel>` still outlives a remount.
- **Depends on:** none
- **Verification:** frontend tests; a harness run of create + double click (§16.4).

## [GOD-22] Split CitizenForm into one file per step
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** L · **Category:** God-files
- **Files:** `components/admin/citizen-form.tsx` (2,607): `CitizenForm` (737–2400), `ResidenceChooser` (2401), `StepNotesField` (2501), `FormSection` (2558) → `components/admin/citizen-form/*`. Citizen PII form.
- **Acceptance criteria:** steps per record kind (`PersonalStep`, `OwnerPersonalStep`, `NonPersonPersonalStep`…) each in their own file; drafts unchanged.
- **Depends on:** none
- **Verification:** typecheck; frontend tests; harness render of each kind.

## [GOD-23] Extract the map's layer definitions and palette out of fullscreen-map.tsx
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `components/admin/fullscreen-map.tsx` (2,524) constants `SOURCE` (160), `LAYER` (168), `DOT` (182), `DOT_LIFT` (204), zone opacities, the 36 hex literals → `components/admin/map/map-layers.ts`, `map-palette.ts` (shared with `building-map-layer.ts`, `zone-editor-map.tsx`, `parcel-pin-picker.tsx`).
- **Depends on:** none (UX-04 does the colours)
- **Acceptance criteria / Verification:** map renders the same; `wc -l`.

## [GOD-24] Move the citizen file's bill list into a DataTable panel
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** God-files
- **Files:** `app/…/(protected)/citizens/[citizenId]/page.tsx` (2,017): the bills `<ul>` on a CSS subgrid with its own header and paging → `components/admin/citizen-file/bills-panel.tsx` on `DataTable`.
- **Problem:** Tracked (§17.1 tables not drawn by `DataTable`, PRIM-3; CODE-6). Bulk-settle selection lives here: keep `useBulkSelection`.
- **Acceptance criteria:** 1. `DataTable` with `meta.mobile`; checkbox column kept. 2. `bill-receipts-screens.test.ts` updated and passing.
- **Depends on:** none
- **Verification:** frontend tests; harness at 360px and 1440px.

---

## 3. Pagination

Today: `queryLimit`/`queryOffset`/`optionalOneOf` are used by 6 controllers; `MAX_LIST_PAGE` (shared `primitives.ts:170`) by
income, transfers, treasury movements and `ExpensesService`. Arrears controller: every id through `UuidPipe`, every body through a schema — clean.

## [PAG-01] Parse the owner-link queue's page with queryLimit and queryOffset
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Pagination
- **Files:** `citizen.controller.ts:330-331` (`Number(limit ?? 20)`, `Number(offset ?? 0)`); `landlord-link.service.ts:156-157`.
- **Problem:** **NEW** (task S11 missed it). `?offset=1e20` → `Number` → `Math.trunc(1e20) || 0` = 1e20 → Postgres error → 500 and a Sentry event; `?offset=Infinity` the same. The CQ row "pagination parsed differently per controller" names `CitizenController` with `Number(limit) || 200`, which is gone; this one is still there.
- **Acceptance criteria:** 1. `queryLimit(limit, 20, 100)`, `queryOffset(offset)`. 2. A spec: `offset=1e20` → 400 `INVALID_QUERY_VALUE`.
- **Depends on:** none
- **Verification:** `grep -rn "Number(limit\|Number(offset" apps/backend/src/presentation` → 0.

## [PAG-02] Page GET cases on the server
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Pagination
- **Files:** `cases.controller.ts` `list`; `cases/cases.service.ts:60` `list` → `case.repository.ts` `findAll` (no `take`).
- **Problem:** **NEW**. Unbounded: every case ever opened, on every visit to «الحالات».
- **Acceptance criteria:** 1. `limit`/`offset` via the helpers, a max, `{ items, total }`. 2. `standingCase` keeps its unpaged internal read.
- **Depends on:** none (ship with PAG-03 — the contract changes)
- **Verification:** cases specs; a spec for the cap.
- **Done 2026-11-25:** `limit` (`CASES_PAGE_DEFAULT` 50, `CASES_PAGE_MAX` 500, both in shared `case.schema.ts`) and
  `offset`, answered `{ items, total }` (was `{ cases }`); `CaseRepository.findPage` (`id` breaks a `createdAt` tie),
  `findAll` kept unpaged for the service's own reads. Until PAG-03, `getCases` asks for `CASES_PAGE_MAX` and the page
  says «تُعرض أحدث N حالة من أصل M» when that was not all. The eight prose throws of `cases.service.ts` were converted
  on the way (`CASE_*` codes).

## [PAG-03] Use server paging on the cases page
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** Pagination
- **Files:** `app/…/(protected)/cases/page.tsx`, `components/admin/cases/case-queue-tabs.tsx`, `lib/api-client.ts` `listCases`.
- **Acceptance criteria:** `DataTable` with `manualPagination`, `useUrlPagination`; PRIM-3.
- **Depends on:** PAG-02
- **Verification:** frontend tests; harness.
- **Found during PAG-02:** the queue tabs and the zone filter work on the loaded rows, so past `CASES_PAGE_MAX` cases
  their counts are of the newest 500. Server paging needs the tab (`caseType`) and status as query filters, which the
  route already takes; the zone filter (parcel → sector, client-side today) has no server filter.

## [PAG-04] Page GET fees/notices on the server
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Pagination
- **Files:** `fees.controller.ts` `listNotices`; `fees.service.ts:1657` `listNotices` (`findMany` with no `take`, includes `targetCitizen` names).
- **Problem:** **NEW**. Grows by one row per issued notice (slow growth; one-off charges do not create notices — only `issue` writes `feeNotice`, line 2044).
- **Acceptance criteria:** helpers, a max, `{ items, total }`.
- **Depends on:** none (ship with PAG-05)
- **Verification:** fees specs.
- **Done 2026-11-25:** `limit` (`FEE_NOTICES_PAGE_DEFAULT` 50, `FEE_NOTICES_PAGE_MAX` 200, in shared `fee.schema.ts`) and
  `offset`, answered `{ items, total }`; `id` breaks a `createdAt` tie. Until PAG-05, `getFeeNotices` asks for
  `FEE_NOTICES_PAGE_MAX` and the page says when that was not all.

## [PAG-05] Use server paging on «إشعارات الرسوم»
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** Pagination
- **Files:** `app/…/(protected)/fees/notices/page.tsx`, `lib/api-client.ts` `getFeeNotices`.
- **Depends on:** PAG-04
- **Acceptance criteria / Verification:** as PAG-03.
- **Found during PAG-04:** `components/admin/settings/backup-section.tsx` also reads `getFeeNotices` for its export, and
  since PAG-04 gets `FEE_NOTICES_PAGE_MAX` (200) notices at most where its other tables ask for `EXPORT_LIMIT` (1,000):
  page through, or keep it with the backup decision (U-11, DEAD-10).
- **Done 2026-11-25:** `fees/notices/page.tsx` is a `manualPagination` `DataTable` over `useUrlPagination` (25 a page,
  `?page=` and `?limit=`), reading `getFeeNotices(tenant, token, { limit, offset }, signal)` under the key
  `['fee-notices', tenant, pageIndex, pageSize]` with `keepPrevious`; every write still invalidates the prefix. The
  «تُعرض أحدث N» alert and `fees.notices.truncated` are gone. `getFeeNotices` without a page still asks for 200, which
  is all the backup export gets (the note above stands). `lib/err-05-pag-05.test.ts`. **Not done:** the page rendered.

## [PAG-06] Say when an old-debts list was cut, instead of truncating silently
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Pagination
- **Files:** `arrears/arrears-batch.service.ts:153` `list` (`take: 200`), `:241` `unmatched` (`take: 1000`), `:165` `review` (unbounded per batch, capped by `ARREARS_IMPORT_MAX_ROWS` at import), `arrears-report.service.ts:102-105` (batches `take: 200`); `ArrearsController` `listBatches`, `unmatched`.
- **Problem:** **NEW** (old-debts review). The 201st batch and the 1,001st unmatched line disappear with no `more` flag; a clerk working «للمطابقة» cannot know lines are missing.
- **Acceptance criteria:** 1. Each response carries `total` (or `more`), or the routes page with `queryLimit`/`queryOffset`. 2. The frontend says «عرض N من M» (Abed, same PR or a follow-up).
- **Depends on:** none
- **Verification:** arrears integration specs; a spec seeding > cap.

## [PAG-07] Put the page caps in one place
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Pagination
- **Files:** `citizens.service.ts:91` `MAX_LIST_ROWS = 500`, `:88` `MAX_DUPLICATE_LOOKUP_ROWS`; `record-review.service.ts:61` `MAX_PAGE = 100`, `:724` `Math.min(…, 500)`; `transfers.service.ts:373` (200); `landlord-link.service.ts:156` (100); `buildings.service.ts:526` (`?? 100`); the `queryLimit(…, fallback, max)` literals in controllers.
- **Problem:** Tracked in spirit (CQ Backend pagination row; rule 2). Seven caps, five values.
- **Acceptance criteria:** `APP_CONFIG.pagination.{default,max,…}` named per register.
- **Depends on:** ARCH-07
- **Verification:** grep for the literals → 0.

---

## 4. Caching

## [CACHE-01] Refill the in-memory cache with the key's remaining TTL
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** S · **Category:** Caching
- **Files:** `infrastructure/cache/redis-cache.service.ts:147` (`expiresAt: now + 30_000` on an L2 hit).
- **Problem:** Tracked (CQ Backend). The audit cache (`AUDIT_CACHE_TTL_SECONDS`, default 20) can be served 30 s from L1 after Redis expired it; any future key under 30 s inherits the bug. (Session revocation is 30 s, so equal — not shortened, not extended.)
- **Acceptance criteria:** 1. L2 read uses `PTTL` (or a `GET`+`PTTL` pipeline) and L1 expires at `min(now + 30 s, now + pttl)`. 2. Spec with a 5 s key.
- **Depends on:** none
- **Verification:** the spec; backend tests.

## [CACHE-02] Retire request-cache.ts for TanStack reads (after the decision)
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** Caching
- **Files:** `lib/request-cache.ts` (`cachedRequest`, `invalidateRequests`), its only user `lib/api-client.ts` (tenant config, zones, census, fee summary, settings).
- **Problem:** Tracked, **Undecided** (CQ Frontend; frontend CLAUDE.md Data fetching).
- **Acceptance criteria:** per the decision: either `reference: true` reads replace it and the file is deleted, or its remaining non-React callers are listed in a comment.
- **Depends on:** decision U-3 (below)
- **Verification:** `grep -rn "cachedRequest" apps/frontend` → 0 (if retired).

## [CACHE-03] Scope the owner-link invalidations to the tenant
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** Caching
- **Files:** `citizens/landlord-links/page.tsx:158`, `citizens/landlord-links/[propertyEntryId]/page.tsx:302`, `components/admin/cases/use-case-linking.ts:73` (`queryKey: ['landlord-links']`).
- **Problem:** Tracked (frontend CLAUDE.md deviation). Over-invalidates every tenant's cache in the tab.
- **Acceptance criteria:** keys `['landlord-links', tenant]`.
- **Depends on:** none
- **Verification:** grep `['landlord-links']` → 0.

---

## 5. Double submit

Scan: 145 write functions in `lib/api-client.ts`, `lib/arrears-api.ts`, `lib/requests-api.ts`; 95 `.tsx` files call one;
61 hold a ref guard (`inFlight`/`*InFlight`/`busyRef`) or route through `ConfirmDialog`; 34 do not (10 with no guard at all,
24 with `busy` state only). State-only guards fail on two clicks inside one render (STA-4). Heuristic: a file counted guarded may still
have one unguarded handler.

## [SUBMIT-01] Guard ConfirmDialog's onConfirm with a ref
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** XS · **Category:** Double-submit
- **Files:** `components/ui/confirm-dialog.tsx:91-93` (`if (busy || blocked) return; setBusy(true)`).
- **Problem:** **NEW**. Every destructive write routed through `ConfirmDialog` (write-off «شطب», arrears approve/return/discard in `batch-review.tsx`, «للمطابقة» link, staff/zones/cases deletes) is guarded by React state only.
- **Acceptance criteria:** 1. A `useRef` in-flight flag checked and set synchronously before `setBusy`. 2. Released only when `onConfirm` settles.
- **Depends on:** none
- **Verification:** frontend tests; harness double-click on «شطب».

## [SUBMIT-02] Add in-flight refs to the unit matrix drawer, unit forms and unit picker writes
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** M · **Category:** Double-submit
- **Files:** `building-unit-matrix-drawer.tsx` (`createCase`, `addUnit`, `updateUnit`, `deleteUnit`, `recordOccupancy`, `linkOccupancyOwner`, `endOccupancy`, `recordDamage`, `setUnitFeeExemption`, `setOwnerBilling`, `confirmVacancy`, `endVacancy`), `building-unit-forms.tsx` (`createCase`, `logUnitVisit`), `building-unit-picker.tsx` (`addUnit`). Field officers on slow connections; writes citizen occupancy.
- **Problem:** **NEW** (§17.6 STA-4 lists the building editor, cases editor, settle pages — not these). `addUnit`, `recordOccupancy`, `createCase`, `logUnitVisit` create rows and take no retry key on the server (SUBMIT-07).
- **Acceptance criteria:** each handler: ref checked synchronously, button disabled with spinner, ref released on settle (kept after a create that landed, per frontend CLAUDE.md Writes).
- **Depends on:** none
- **Verification:** frontend tests; harness double-click on «إضافة وحدة» shows one unit.

## [SUBMIT-03] Add in-flight refs to the ownership, merge and correction dialogs
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** Double-submit
- **Files:** `end-ownership-dialog.tsx`, `end-tenancy-dialog.tsx`, `landlord-unlink-dialog.tsx`, `merge-citizens-dialog.tsx`, `citizen-merges.tsx` (`undoCitizenMerge`), `duplex-merge-dialog.tsx`, `parcel-correction-dialog.tsx`, `unit-correction-delete-dialog.tsx`.
- **Problem:** **NEW**. `busy` state only. The server refuses most second presses by state, so the harm is a confusing refusal, not a double record.
- **Acceptance criteria / Verification:** as SUBMIT-02.
- **Depends on:** none

## [SUBMIT-04] Add in-flight refs to staff, settings, account-security and import writes
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** Double-submit
- **Files:** no guard: `settings/security-section.tsx` (password, email, TOTP enrol/confirm/disable), `staff/deleted-staff-section.tsx` (`restoreStaff`), `residence-change-dialog.tsx` (`setCitizenActive`), `settings/cadastre-section.tsx` (`importCadastre`); busy only: `settings/users-section.tsx` (`createStaff`), `settings/{backup,finance,numbering,profile}-section.tsx`, `citizens/page.tsx` (`importCitizens`), `quality/findings-list.tsx` (`settleAllUnitStatuses`), `quality/finding-compare.tsx`.
- **Problem:** **NEW**. `createStaff` twice creates two accounts unless email uniqueness refuses the second (it should — verify).
- **Acceptance criteria / Verification:** as SUBMIT-02.
- **Depends on:** none

## [SUBMIT-05] Guard the portal's payment report and checkout buttons
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** S · **Category:** Double-submit
- **Files:** `(citizen)/payments/page.tsx` (`declarePayment`, `startWhishCheckout`), `(citizen)/my-file/page.tsx` (`startWhishCheckout`); busy-only: `(citizen)/my-file/requests/[requestId]/page.tsx`, the three citizen login pages.
- **Problem:** **NEW**. No guard at all on the citizen's Whish-transfer report, which sends a bill to review. Citizens on phones and slow connections (PRODUCT.md audience). Checkout is paused (`ONLINE_PAYMENT_OPEN` false) but the declare path is live.
- **Acceptance criteria:** ref + disabled + spinner on each; the dialog stays locked after a 2xx.
- **Depends on:** none
- **Verification:** `lib/citizen-payments.test.ts` extended to read the guard; harness.

## [SUBMIT-06] Guard the request sheet's bill and paper uploads and the corrections review
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** Double-submit
- **Files:** `components/admin/requests/request-sheet.tsx:130,179` (`raiseRequestBill` behind `billing` state; `uploadRequestAttachment` behind `uploading`), `fees/corrections/page.tsx` (`reviewBillBasis`).
- **Problem:** **NEW**. `raiseRequestBill` creates a bill.
- **Acceptance criteria / Verification:** as SUBMIT-02.
- **Depends on:** none

## [SUBMIT-07] Add retry-key columns for census records that are created (migration PR)
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Double-submit
- **Files:** new tenant migration (next free number — check every unmerged branch first): nullable `clientRequestId` + unique partial index on `cases`, `unit_visits`, `damage_assessments`, `unit_occupancies`; `schema.prisma`. Own `chore/migration-NNNN` PR (non-negotiable 5).
- **Problem:** **NEW**. `createCaseSchema` (`case.schema.ts:79`), `logVisitSchema` (`building.schema.ts:1281`), `createDamageAssessmentSchema` (803), `upsertOccupancySchema` (912) take no key; a lost answer retried creates a second row. Whether a duplicate visit is paid to the officer is **unverified** — check before ranking higher.
- **Acceptance criteria:** additive only; applied with `pnpm db:deploy:local`; integration suites on PG17.
- **Depends on:** none
- **Verification:** `pnpm db:status:local`; docs/database.md updated.

## [SUBMIT-08] Accept and replay a retry key on case, visit, damage and occupancy creation
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** Double-submit
- **Files:** the four shared schemas; `CasesService.create`, `BuildingsService.logVisit`, `recordOccupancy`, `DamageService.record`; the frontend calls (Abed follow-up or same PR).
- **Acceptance criteria:** replay answers the first row with `replayed: true`; a key reused for another act → coded `CONFLICT`.
- **Depends on:** SUBMIT-07 merged and released
- **Verification:** integration specs per route.

---

## 6. Security

Checked: every controller route has `@Roles` or is `@Public()` or on `SELF_SERVICE` (held by `route-inventory.spec.ts`); every path id
through `UuidPipe` except three non-id params; 5 raw bodies; 22 `@Public()` routes; nothing new reaching logs beyond the tracked rows.
No cross-tenant path found. Every task here touches citizen data or credentials unless it says otherwise.

## [SEC-01] Drop the رقم مرجعي from the receipt's WhatsApp message
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** XS · **Category:** Security
- **Files:** `components/admin/payment-receipt.tsx:290` (`الرقم المرجعي: ${citizen.referenceNumber}`), `waHref`.
- **Problem:** Tracked (SEC gap, Medium). The reference alone opens a citizen session; it goes into a `wa.me/?text=` URL, browser history and the provider. Non-negotiable 7.
- **Acceptance criteria:** the line is removed (or masked as `ReferenceNumber.mask` prints it); a test feeds a reference and asserts it is absent, as `bulk-receipt-message` does.
- **Depends on:** none
- **Verification:** frontend test; security.md row removed.

## [SEC-02] Require re-authentication for 2FA enrolment and removal
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** M · **Category:** Security
- **Files:** `auth.controller.ts:237` `disableTotp` (raw `@Body() body: { currentPassword?: string }`), `beginTotpEnrolment`; `IdentityService.disableTotp`; `PrismaUserRepository.saveTotpSecret` (`totpConfirmedAt: null`); new shared zod schemas.
- **Problem:** Tracked (SEC gap, High). A stolen session can remove 2FA and enrol its own.
- **Acceptance criteria:** 1. Both routes require the current password and a current TOTP code (zod). 2. The old factor stays until the new one is confirmed. 3. `tokenVersion` bumped after. 4. Frontend `security-section.tsx` sends them (Abed, same PR).
- **Depends on:** none
- **Verification:** auth controller specs; security.md row removed.

## [SEC-03] Validate the owner-link and reset-email bodies with zod
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Security
- **Files:** `citizen.controller.ts:488` (`@Body('citizenId')`), `:508`, `:525` (`@Body('candidateIds') … unknown`); `auth.controller.ts:281` (`sendResetPasswordEmail`, raw `@Body()`).
- **Problem:** Tracked (SEC gap, Low; non-negotiable 6). A malformed body becomes a 500 and a Sentry event.
- **Acceptance criteria:** `ZodValidationPipe` with shared schemas; `grep -rnE "@Body\((\)|'[a-zA-Z]+'\))" apps/backend/src/presentation/controllers | grep -v spec` → 0.
- **Depends on:** none
- **Verification:** the grep; specs for a malformed body → 400.

## [SEC-04] Set trust proxy to the nginx hop and move the throttler to Redis
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** M · **Category:** Security
- **Files:** `presentation/bootstrap.ts` `createApiApp`; `app.module.ts` `ThrottlerModule.forRoot`; comments at `auth.controller.ts:35`, `citizen-requests.controller.ts:39`, `MetricsController`.
- **Problem:** Tracked (SEC gap, High): every client shares nginx's IP — 5 staff logins per minute across all staff; audit IPs wrong.
- **Acceptance criteria:** per the decision: exact hop count, Redis storage, per-account limits beside per-IP.
- **Depends on:** decision U-6 (rate-limit topology) and reading the nginx config (Unverified)
- **Verification:** throttle specs; a login from two IPs counted apart.

## [SEC-05] Redact PII from 5xx details, mail and dev SMS logs
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** S · **Category:** Security
- **Files:** `DomainExceptionFilter.catch` (5xx `detail`), `AppLogger.formatMessage`, `SmtpEmailSender` (recipient), `infrastructure/sms/sms-provider.service.ts:79` (`[dev] SMS to ${input.phone} … ${input.message}`).
- **Problem:** Tracked (SEC gap, Medium; non-negotiable 7).
- **Acceptance criteria:** `redactText` on the 5xx detail (or in `AppLogger`); recipients and phones masked as line 96 already does.
- **Depends on:** none
- **Verification:** filter spec with a phone in an exception message; grep for `${input.phone}` → 0.

## [SEC-06] Validate the audit query's free-text filters and the property-number params
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Security
- **Files:** `audit.controller.ts:111-113` (`entityType`, `entityId`, `action` as raw strings), `citizen.controller.ts:564` `parcelRoster(@Param('propertyNumber'))`, `registration.controller.ts:36` `checkPropertyNumber` (`@Public()`).
- **Problem:** **NEW**. `entityId` reaches the repository unvalidated (a non-uuid → Prisma error → 500); `entityType` should be `optionalOneOf` the audit entity list. Property numbers have a shared format but no pipe.
- **Acceptance criteria:** `UuidPipe({ optional: true })` on `entityId`; `optionalOneOf` on `entityType`; a property-number schema pipe on both params.
- **Depends on:** none
- **Verification:** audit controller spec (`entityId=abc` → 400).

## [SEC-07] Give every public route an explicit throttle decision
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Security
- **Files:** `HealthController`, `TenantController.getPublicConfig`, `RegistrationController.checkPropertyNumber`, `FeesController.whishCallback`.
- **Problem:** Tracked (SEC gap, Low).
- **Acceptance criteria:** `@Throttle` or `@SkipThrottle()` with a reason comment on each; `route-inventory.spec.ts` asserts it for every `@Public()` route.
- **Depends on:** none
- **Verification:** spec.

## [SEC-08] Exclude nested .env files and backups from the Docker build context
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Security
- **Files:** `.dockerignore`.
- **Problem:** Tracked (SEC gap, Low — cheap, and `apps/backend/.env` enters the build stage).
- **Acceptance criteria:** `**/.env*`, `**/backups/`, dumps excluded; `docker build` still succeeds.
- **Depends on:** none
- **Verification:** `docker build` with a dummy `apps/backend/.env` and `RUN test ! -f apps/backend/.env` in a throwaway stage.

## [SEC-09] Harden the deploy workflows
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** M · **Category:** Security
- **Files:** `.github/workflows/deploy-backend.yml` (`appleboy/scp-action@v0.1.7`, `ssh-action@v1.0.3`, no `environment:`/`permissions:`), `id-token: write` in `deploy-backend.yml:33`, `deploy-production.yml:41`, **and `deploy-staging.yml:31`** (NEW — CQ CI names only two).
- **Problem:** Tracked (SEC gap, Medium; CQ CI `id-token` row).
- **Acceptance criteria:** actions pinned by SHA, `permissions: contents: read`, SSH secrets in a protected environment, host fingerprint from `SSH_KNOWN_HOSTS`, deploy gated on CI and the audit job; `id-token: write` gone from all three.
- **Depends on:** decision U-12 (deploy gating) for the approval part only
- **Verification:** a run on a branch; docs/database-environments.md and CLAUDE.md updated (workflow row).

## [SEC-10] Make RolesGuard refuse routes with no role metadata
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** M · **Category:** Security
- **Files:** `RolesGuard.canActivate`; a `@SelfService()` decorator on the routes in `route-inventory.spec.ts` `SELF_SERVICE`; `tenant-isolation.spec.ts` ("admits requests to routes without role restrictions").
- **Problem:** Tracked (SEC gap, Medium: fails open; CI catches a forgotten role, the guard does not).
- **Acceptance criteria:** no `@Roles`, no `@Public`, no `@SelfService` → 403; the spec flipped.
- **Depends on:** none
- **Verification:** guard and inventory specs; security.md row removed.

## [SEC-11] Pin the staff writes in PrismaUserRepository to kind STAFF
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Security
- **Files:** `user.repository.ts` `hideStaff`, `setStaffActive`, `restoreStaff`, `updateStaff` (`where: { id }`).
- **Problem:** Tracked (CQ Backend). `users` holds staff and citizens (CLAUDE.md); the check lives only in `StaffService` before the call.
- **Acceptance criteria:** `where: { id, kind: 'STAFF' }`; a spec that a citizen id is refused.
- **Depends on:** none
- **Verification:** repository spec.

## [SEC-12] Read config through envSchema in OtpService, APP_CONFIG, main.ts and WhishGateway
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Security
- **Files:** `identity/otp.service.ts:149,156,165,212` (`process.env.NODE_ENV`), `presentation/config/app.config.ts:29-30` (`PUBLIC_API_URL`, `PORT`, `PUBLIC_PORTAL_URL` at import), `presentation/main.ts:28,47` (`TZ`, `NODE_APP_INSTANCE`), `WhishGatewayService`.
- **Problem:** Tracked (CQ Backend config row). Verification grep 4 counts 108, of which 29 non-spec; of those 13 are scripts and 3 `sentry.ts` (pre-DI, allowed) — 13 are this task.
- **Acceptance criteria:** only `isSchedulerEnabled`, `initSentry` and scripts read `process.env`.
- **Depends on:** ARCH-07
- **Verification:** `grep -rn "process\.env\." apps/backend/src --include=*.ts | grep -v "spec\|scripts/\|sentry.ts\|env.schema"` → 0.

---

## 7. Architecture and clean code

## [ARCH-01] Move FeesService's remaining bare transactions to runInTenantTransaction
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** `fees.service.ts:2020` (`issue`), `:2710` (`runRecurringBilling`), `:3683` (private `transition`, Tier 1 audit inside), `:4682` (`listAllPayments`, array form), `:4874` (`startWhishCheckout`), `:5029` (`settleFromWhishCallback` failure path).
- **Problem:** Tracked (CQ Backend bare-`$transaction` row; rule 5; apps/backend/CLAUDE.md Transactions). Money paths; a bare call inside an enclosing scope throws, and audit listeners write outside it.
- **Acceptance criteria:** `grep -n "\.\$transaction(" fees.service.ts` → 0; Tier 1 rows still inside; specs pass.
- **Depends on:** none
- **Verification:** grep; fee/payment integration suites on PG17.

## [ARCH-02] Move PaymentLedgerService's bare transactions to runInTenantTransaction
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** S · **Category:** Architecture
- **Files:** `fees/payment-ledger.service.ts:196` (`record`), `:487`.
- **Problem:** Tracked (same row). The ledger is append-only and audited; it must join the caller's transaction.
- **Acceptance criteria / Verification:** grep → 0; ledger specs.
- **Depends on:** none

## [ARCH-03] Move BuildingsService's bare transactions to runInTenantTransaction
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** `buildings.service.ts:1446` (`create`), `:3236` (`atomic`, which duck-types around the problem), `:3539` (`endVacancy`), `:4924` (`logVisit`), `:5026` (`recomputeCodesForParcels`).
- **Problem:** Tracked.
- **Acceptance criteria:** grep → 0; `atomic` removed or a thin alias; timeouts from APP_CONFIG (DRY-08).
- **Depends on:** none
- **Verification:** census suites on PG17.

## [ARCH-04] Move CitizensService's bare transactions to runInTenantTransaction
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Architecture
- **Files:** `citizens.service.ts:527` (`list`, array form), `:798` (`reviewQueue`, array form), `:2343` (`update`).
- **Problem:** Tracked.
- **Acceptance criteria / Verification:** grep → 0; citizens suites.
- **Depends on:** none

## [ARCH-05] Move the repositories' and BackupService's bare transactions
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Architecture
- **Files:** `registration.repository.ts`, `parcel.repository.ts`, `document.repository.ts`, `staff-refresh-token.repository.ts:85,112` (**NEW** — not in the CQ row), `backup/backup.service.ts`.
- **Acceptance criteria:** converted, or each kept with a one-line reason (the refresh-token rotation may need its own isolation).
- **Depends on:** DEAD-10 for `BackupService`
- **Verification:** grep; specs.

## [ARCH-06] Add a snapshot-read helper for the treasury's Repeatable Read reads
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Architecture
- **Files:** `treasury/treasury.service.ts:156`, `treasury-movements.service.ts:125`, `daily-cash-report.service.ts:63` (bare `$transaction` with `isolationLevel: RepeatableRead`).
- **Problem:** **NEW**. Legitimate reads, but they are the shape the rule forbids and are not in the debt table.
- **Acceptance criteria:** `readInTenantSnapshot(tenantContext, fn)` in `infrastructure/context`; the three use it; the rule in apps/backend/CLAUDE.md names it.
- **Depends on:** none
- **Verification:** grep `\.\$transaction(` in `application/` → only the helper; treasury suites.

## [ARCH-07] Move APP_CONFIG out of presentation
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Architecture
- **Files:** `presentation/config/app.config.ts` → `application/common/app.config.ts`; importers `otp.service.ts:17`, `document.service.ts:14`, `identity.service.ts:30`, **`arrears/arrears-batch.service.ts:31`** (NEW — old debts added a fourth application→presentation import).
- **Problem:** Tracked (CQ Backend; non-negotiable 8).
- **Acceptance criteria:** `grep -rn "presentation/" apps/backend/src/application | grep -v spec` → 0.
- **Depends on:** none
- **Verification:** the grep.

## [ARCH-08] Move the search-term helpers out of application
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Architecture
- **Files:** `registration.repository.ts:24` imports `normalizeSearchText` from `application/common/search-terms`.
- **Problem:** Tracked (CQ Backend).
- **Acceptance criteria:** `grep -rn "application/" apps/backend/src/infrastructure | grep -v spec` → 0.
- **Depends on:** none
- **Verification:** the grep.

## [ARCH-09] Remove application imports of infrastructure outside the allowed entry points
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** tracked: `zones.service.ts` → `cadastre/cadastre-assets.service`; `cadastre-import.service.ts` → `cadastre/kmz-parser`, `cadastre/parcel-geometry`. **NEW**: `citizen-merge.service.ts`, `staff/staff.service.ts` → `repositories/earnings-registrations` (`EARNINGS_CARD_SELECT`, `creditedRegistrationsWhere`); `citizens.service.ts` → `prisma/house-card-guard` (`houseCardOnMultiUnitBuilding`).
- **Acceptance criteria:** each moved into application/domain, or added to the allowed list in apps/backend/CLAUDE.md with a reason.
- **Depends on:** none
- **Verification:** the grep in the appendix lists only allowed modules.

## [ARCH-10] Type actorRole and drop its 85 casts
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** every `actorRole: actor.role as never` (85 sites; 6 in arrears).
- **Problem:** Tracked (CQ Backend casts row says 371; it is **455** today, 72 in `buildings.service.ts`; rule 7).
- **Acceptance criteria:** `grep -rn "role as never" apps/backend/src | grep -v spec` → 0.
- **Depends on:** DRY-01
- **Verification:** grep; typecheck.

## [ARCH-11] Remove the enum casts in BuildingsService
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** Architecture
- **Files:** `buildings.service.ts` (72 `as never`/`as unknown as`); then `fees.service.ts` (39) as a second PR.
- **Acceptance criteria:** values typed against `$Enums`; count in the file 0 (or each remaining one commented with why).
- **Depends on:** ARCH-10, ideally after GOD-05..07
- **Verification:** `grep -c "as never\|as unknown as" buildings.service.ts`.

## [ARCH-12] Convert BuildingsService's 59 prose throws to error codes
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** Architecture
- **Files:** `buildings.service.ts` (59 of the 199 the ratchet counts); `packages/shared-schemas/src/error-codes.ts`; `errors.<CODE>` in both message files (Abed reviews the copy).
- **Problem:** Tracked (CQ Backend; `/en/` shows Arabic).
- **Acceptance criteria:** `LEGACY_PROSE_THROWS` lowered to the new count (≤ 140); `api-errors.test.ts` passes.
- **Depends on:** none
- **Verification:** `error-codes.ratchet.spec.ts`; frontend `api-errors.test.ts`.

## [ARCH-13] Convert the identity, staff and OTP prose throws to error codes
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** `identity.service.ts` (19), `staff.service.ts` (19), `otp.service.ts` (6).
- **Acceptance criteria / Verification:** as ARCH-12; ratchet lowered by 44.
- **Depends on:** none

## [ARCH-14] Convert the remaining 96 prose throws to error codes
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** `record-review.service.ts` 12, `backup.service.ts` 8, `cases.service.ts` 8, `zones.service.ts` 8, `document.entity.ts` 5, `user.repository.ts` 5, `landlord-link.service.ts` 4, `document.service.ts` 4, `cadastre-import.service.ts` 3, `backup.controller.ts` 3, `citizen.controller.ts` 3, and 28 files with 1–2 (full list: appendix).
- **Acceptance criteria:** ratchet at 0, the spec turned into a plain "no prose throws" test.
- **Depends on:** ARCH-12, ARCH-13 (skip the backup and supabase files if DEAD-08/10 deletes them)
- **Verification:** ratchet spec.

## [ARCH-15] Declare event names and payloads in one typed module
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** 20 event names, 81 `.emit(` sites, 40 `@OnEvent(` listeners; new `application/common/events.ts`.
- **Problem:** Tracked (CQ Backend). Today every emitted name has a listener (checked), but a typo would drop silently.
- **Acceptance criteria:** `emit` and `@OnEvent` take constants; payload types shared; `grep -rnE "\.emit\(\s*'" apps/backend/src | grep -v spec` → 0.
- **Depends on:** none
- **Verification:** grep; backend tests.

## [ARCH-16] Rewrite the backend comments that contradict the code
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Architecture
- **Files:** tracked (CQ Backend CODE-7 row and CQ Data comments row): `InfrastructureModule` docblock, `AppModule` scheduler comment, `envSchema` SMTP message, `IdentityService.challengeTotp`, `createApiApp` docblock, `User.requiresTotp`; `tenant-schema-ref.ts`, `TenantPrismaFactory.connectionUrlFor`, `tenant-test-client.ts`, `envSchema` `DATABASE_URL`, both `binaryTargets` comments, `TenantSlug`; `ci.yml` comments.
- **Acceptance criteria:** each matches the code; rows removed.
- **Depends on:** none
- **Verification:** review.

## [ARCH-17] Refresh the counts in the debt docs
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Architecture
- **Files:** docs/code-quality.md (god-file sizes, `as never` 371 → 455, prose 202 → 199, `type Actor` 6 → 8, inline actor 58 → 84, `NEXT_PUBLIC_API_URL` 10 → 7 files, api-client 6,701 → 7,815, 44 → 49 files over 600; **the `APP_CONFIG.throttle.submission` "no readers" row is wrong** — `citizen-requests.controller.ts:45` reads it); ui-ux-standards §17.6 (inline `en ?` 129 → 145 files; news `type="time"` in `news/day-time-fields.tsx:48` is a new CTL-2 site); apps/frontend/CLAUDE.md.
- **Problem:** Code wins (CLAUDE.md): these are doc bugs.
- **Acceptance criteria:** every number re-counted with the command that produced it; "Last verified" lines bumped.
- **Depends on:** none (do first, so the sprint starts from true numbers)
- **Verification:** the appendix commands.

## [ARCH-18] Replace loadSession effects with useStaffSession on the protected pages
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** Architecture
- **Files:** 15 pages: `account`, `audit`, `buildings`, `cases`, `citizens`, `citizens/[citizenId]`, `dashboard`, `fees/corrections`, `fees/payments/[paymentId]/settle`, `map`, the index `page.tsx`, `payments`, `settings`, `staff`, `zones`.
- **Problem:** Tracked (§17.1 CODE-1, 23 copies; the staff login page is a legitimate caller).
- **Acceptance criteria:** `useStaffSession` + `useStaffQuery`; skeleton while the token is null.
- **Depends on:** none
- **Verification:** `grep -rln "loadSession(" apps/frontend/app` → login and citizen pages only.

## [ARCH-19] Replace loadSession in the seven components
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** Architecture
- **Files:** `activity-trail.tsx`, `building-editor.tsx`, `building-unit-matrix-drawer.tsx`, `building-unit-matrix-view.tsx`, `case-editor.tsx`, `citizen-editor.tsx`, `unit-correction-delete-dialog.tsx`.
- **Depends on:** none
- **Acceptance criteria / Verification:** `grep -rln "loadSession(" apps/frontend/components` → only `admin-shell`, `staff-route-guard`.

## [ARCH-20] Remove lib's imports of components
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** Architecture
- **Files:** `lib/citizen-field-controls.ts` (value `BUILDING_UNIT_TYPES` from `components/citizen/unit-fields`), `lib/citizen-draft.ts`, `lib/building-draft.ts`, `lib/residence-move.ts`, `lib/use-table-labels.ts` (component types).
- **Problem:** Tracked (apps/frontend/CLAUDE.md Dependency direction deviations).
- **Acceptance criteria:** `grep -rn "from '@/components\|from '../components" apps/frontend/lib` → 0.
- **Depends on:** none
- **Verification:** the grep.

## [ARCH-21] Declare the Node version once
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Architecture
- **Files:** root `package.json` `engines` (`>=20`), `apps/*/Dockerfile` (`node:20-alpine`), `ci.yml` and `migrate-database.yml` (22), `deploy-backend.yml` (24).
- **Problem:** Tracked (CQ CI).
- **Acceptance criteria:** `.nvmrc` (or `.node-version`) read by CI `setup-node`, engines and the Dockerfiles' `ARG`.
- **Depends on:** none
- **Verification:** CI green; `grep -rn "node-version: 2" .github` → 0.

## [ARCH-22] Give shared-schemas a test script and specs for its logic
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** `packages/shared-schemas/package.json`; specs for `cash-policy.ts`, `payout-policy.ts`, `planBulkSettlement`, `arrears.schema.ts` refinements, the money primitives.
- **Problem:** Tracked (CQ CI). The arrears schema (888 lines) is tested only through the backend.
- **Acceptance criteria:** `pnpm --filter @mechanization/shared-schemas test` exists and runs in CI.
- **Depends on:** none
- **Verification:** CI.

## [ARCH-23] Stamp the service worker VERSION at build time
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** Architecture
- **Files:** `apps/frontend/public/sw.js:34` (`VERSION = 'v4'`), `next.config.mjs`.
- **Problem:** Tracked (CQ Frontend).
- **Acceptance criteria:** the build writes the commit SHA into the worker.
- **Depends on:** none
- **Verification:** `pnpm build:check` and the emitted `sw.js`.

## [ARCH-24] Check overrides parity and schema-vs-migration drift in CI
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** M · **Category:** Architecture
- **Files:** `pnpm-workspace.yaml` `overrides` vs `package.json` `pnpm.overrides`; tenant `schema.prisma` vs the SQL migrations; `ci.yml`.
- **Problem:** Tracked (CQ CI, two rows; the Prisma command is **Unverified**).
- **Acceptance criteria:** a CI step fails on either drift.
- **Depends on:** none
- **Verification:** a deliberately drifted branch fails the step.

---

## 8. UI/UX (all Abed)

## [UX-01] Use municipalToday instead of the UTC date
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `building-unit-forms.tsx:1669,2001`, `end-ownership-dialog.tsx:50`, `end-tenancy-dialog.tsx:41`, `residence-change-dialog.tsx:32`, `buildings/page.tsx:479`, `map-export-dialog.tsx:33`, `quality/checks-panel.tsx:42` (`isoDaysAgo`).
- **Problem:** Tracked (CQ Frontend, "8 times in 7 files" — still 8). Between 00:00 and 03:00 Beirut it is yesterday: an ownership or tenancy ended "today" is dated the day before. Verification grep 5 says 11: the other three are `audit-daily.tsx:543` (correct) and two `backup-section.tsx` timestamps (`slice(0, 19)`, file names).
- **Acceptance criteria:** the 8 sites use `municipalToday` (or a `municipalDaysAgo` added to shared-schemas).
- **Depends on:** none
- **Verification:** `grep -rn "toISOString().slice(0, 10)" apps/frontend/app apps/frontend/components` → only `audit-daily.tsx`.

## [UX-02] Make DatePicker clearable and describable, then drop the native date inputs
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `components/ui/date-picker.tsx`; `building-unit-forms.tsx:1668,1699,1941,3373,3388`; `end-ownership-dialog.tsx:556`. Time inputs: `news/day-time-fields.tsx:48` (**NEW** CTL-2 site from the News work), `settings/backup-section.tsx:691` (dead, DEAD-06).
- **Problem:** Tracked (§17.1, CTL-1/CTL-2).
- **Acceptance criteria:** `DatePicker` gains a clear action and `aria-describedby`; the six date inputs use it. The time input waits for decision U-8 (time primitive).
- **Depends on:** GOD-19 if done in the same sprint (the five live there after the move)
- **Verification:** `grep -rn 'type="date"' apps/frontend/components apps/frontend/app` → 0.
- **Time inputs, done 2026-11-25 (U-8):** both are `TimePicker` (`components/ui/time-picker.tsx`, `lib/time-input.ts`): the News day-and-time fields
  and the unrendered backup schedule. `grep -rn 'type="time"' apps/frontend/components apps/frontend/app` finds only the primitive's own comment.
  `lib/time-picker-dom.test.ts`, `lib/time-input.test.ts`. **Not done:** tried on a phone or with a screen reader.

## [UX-03] Replace palette classes with tokens outside the map
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `unit-grid-picker.tsx` (40, incl. `dark:` twins), `inspector-profile-detail.tsx` (6, `BreakdownTile`), `settings/security-section.tsx` (1, `text-slate-700`).
- **Problem:** Tracked (§17.2, BAN-1). (The grep's one hit in `components/ui/cell-tag.tsx:31` is a comment.)
- **Acceptance criteria:** tokens per COL-8; contrast re-run (memory: "theme tokens are a measured contract").
- **Depends on:** none
- **Verification:** palette regex over `app/ components/` → only `fullscreen-map.tsx`.

## [UX-04] Derive the map colours from one map palette module
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `fullscreen-map.tsx` (18 palette classes, 36 hex), `building-map-layer.ts` (19 hex), `zone-editor-map.tsx` (8), `parcel-pin-picker.tsx` (7), `map-export-dialog.tsx` (7).
- **Problem:** Tracked (§17.2: "the map colours should move into one map-palette module derived from the tokens").
- **Depends on:** GOD-23
- **Acceptance criteria / Verification:** hex/palette count in those files → the module only.

## [UX-05] Raise the sub-12px text to the scale
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `unit-grid-picker.tsx` (`text-[8px]`, `text-[9px]` ×2), `building-unit-matrix-view.tsx` and `notifications-bell.tsx` (`text-[10px]`), `possible-duplicates.tsx` and `unit-correction-delete-dialog.tsx` (`text-[11px]`).
- **Problem:** Tracked (§17.4, BAN-11): 7 in 5 files, unchanged.
- **Acceptance criteria:** `text-xs` or a LAY-8 exception written down for the unit grid.
- **Depends on:** none
- **Verification:** `grep -rn "text-\[[0-9]*px\]" apps/frontend/components | grep -v property-illustrations` → 0.

## [UX-06] Remove the toast's side stripe
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `components/ui/toast.tsx:206` (`border-s-4`).
- **Problem:** Tracked (§17.1, BAN-3).
- **Depends on:** none
- **Acceptance criteria / Verification:** tinted surface or icon; grep `border-s-4` → 0.

## [UX-07] Default DialogContent's close label to Arabic and pass it everywhere
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `components/ui/dialog.tsx:37` (`closeLabel = 'Close'`); callers without one: `map-export-dialog`, `parcel-roster-dialog`, `settings/security-section` (2), `settings/users-section`, `unverified-fields-dialog`, `zone-info-dialog`; `focus:` → `focus-visible:` on the close button and `Badge`.
- **Problem:** Tracked (§17.1, KIT-6, A11Y-1).
- **Depends on:** none
- **Acceptance criteria / Verification:** every `DialogContent` passes a localised label; grep.

## [UX-08] Port a Tabs primitive and replace the two hand-rolled tablists
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** new `components/ui/tabs.tsx` (`@radix-ui/react-tabs`, per §3.2); `cases/case-queue-tabs.tsx`, `quality/review-queue.tsx`.
- **Problem:** Tracked (§17.1, CTL-9).
- **Depends on:** none (adds a dependency: `package.json` row of the docs table)
- **Acceptance criteria / Verification:** `grep -rn 'role="tablist"' apps/frontend/components | grep -v ui/` → 0.

## [UX-09] Draw the collector custody panel and the payouts page with DataTable
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `finance/collector-custody-panel.tsx`, `inspector/profile/[staffId]/payouts/page.tsx`.
- **Problem:** Tracked (§17.1, PRIM-3 registers). Money screens; keep the custody panel's held key (`custody:<accountId>`) mounted on a failed re-read.
- **Depends on:** none
- **Acceptance criteria / Verification:** `DataTable` with `meta.mobile`; `payout-hosts.test.ts`, `transfer-screens.test.ts` pass.

## [UX-10] Draw the users section and the daily audit with DataTable
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `settings/users-section.tsx` (own search, skeleton, red `<p>`), `audit-daily.tsx` (detail rows → `renderSubRow`).
- **Depends on:** none
- **Acceptance criteria / Verification:** as UX-09.

## [UX-11] Give Pager its labels as props and a disabled state
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `components/ui/pager.tsx` and its 5 users (`audit/page.tsx`, `fees/corrections/page.tsx`, `audit-daily.tsx`, the movements register, the review queue).
- **Problem:** Tracked (§17.1 Pager: inline `en ?`, no `disabled`, so the audit pagers no longer lock while fetching).
- **Depends on:** none
- **Acceptance criteria / Verification:** messages-driven labels; `disabled` while `fetching`.

## [UX-12] Move the native file pickers to FileInput
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `import-citizens-dialog.tsx:306`, `settings/cadastre-section.tsx:97`, `settings/profile-section.tsx:407` (`backup-section.tsx` ×2 is dead — DEAD-06).
- **Problem:** Tracked (§17.1, CTL-13).
- **Depends on:** none
- **Acceptance criteria / Verification:** `grep -rn 'type="file"' apps/frontend/components | grep -v ui/file-input` → 0.

## [UX-13] Replace the hand-rolled warning banners with Alert
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `unit-correction-delete-dialog.tsx` (`Callout`), `landlord-unlink-dialog.tsx`, `import-citizens-dialog.tsx`, `building-editor.tsx`, `building-unit-matrix-view.tsx`, `building-unit-matrix-drawer.tsx`, `citizen/property-card.tsx`, the citizen cash page, the staff page's 2FA dialog (warning-sign emoji, BAN-7).
- **Problem:** Tracked (§17.1, CTL-12).
- **Depends on:** none
- **Acceptance criteria / Verification:** `Alert variant="warning"`; no emoji.

## [UX-14] Localise the Arabic-only toasts and attributes
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** toasts: `fees/page.tsx` (4), `zones/page.tsx` (1); attributes (14 in 10 files): `admin-shell.tsx` 3, `import-citizens-dialog.tsx` 3, `citizens/[citizenId]/page.tsx`, `confirm-cash-payment-dialog.tsx` (dead), `fullscreen-map.tsx`, `payment-receipt.tsx`, `settings/profile-section.tsx`, `theme-toggle.tsx`, `ui/field.tsx`, `ui/toast.tsx`.
- **Problem:** Tracked (§17.6, TXT-2).
- **Depends on:** none
- **Acceptance criteria / Verification:** next-intl keys in both files; `messages-parity.test.ts` passes.

## [UX-15] Stop Field's «(اختياري)» falling back to Arabic on English screens
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `components/ui/field.tsx` (locale from the citizen form's flagging context, fallback `ar`).
- **Problem:** Tracked (§17.6).
- **Depends on:** none
- **Acceptance criteria / Verification:** reads `useLocale()`; English case editor shows "(optional)".

## [UX-16] Replace the remaining physical direction utilities
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `fees/corrections/page.tsx` (`rtl:ml-* ltr:mr-*` pair), `citizen-form.tsx` (`left-0 right-0` → `inset-x-0`); review `unit-figures.tsx` (41 — **NEW** file from unit types; likely drawing geometry that LAY-8 allows, say so in a comment if so).
- **Problem:** Tracked (§17.4, RTL-1) except `unit-figures.tsx`.
- **Depends on:** none
- **Acceptance criteria / Verification:** grep per file.

## [UX-17] Animate the survey progress bar with scaleX
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `buildings/page.tsx:659` (`transition-all` on `width`).
- **Problem:** Tracked (§17.5, MOT-4; the last `transition-all`).
- **Depends on:** none
- **Acceptance criteria / Verification:** `grep -rn transition-all apps/frontend` → 0.

## [UX-18] Give the six large CurrencyInput sizes their sm: twin
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** the settle page (`text-xl`), `bulk-settle-dialog.tsx` (2), `collector-custody-panel.tsx`, `inspector-payout-dialog.tsx`, `staff-salary-dialog.tsx`.
- **Problem:** Tracked (§17.4, PRIM-25): the figure is 14px from 640px.
- **Depends on:** none
- **Acceptance criteria / Verification:** `text-xl sm:text-xl` (or `lg`) at each.

## [UX-19] Put a floor, not a size, on DataTable's phone-card buttons
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `components/ui/data-table.tsx` (footer `[&_button]:size-9`); affected: `finance/income/categories/page.tsx`, `requests/types/page.tsx`, `finance/transfers/page.tsx`, `requests/page.tsx`.
- **Problem:** Tracked (§17.4, LAY-6).
- **Depends on:** none
- **Acceptance criteria / Verification:** `min-h-9 min-w-9`; harness at 360px.

## [UX-20] Wrap PageHeader's actions instead of scrolling them sideways
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `components/ui/page-header.tsx` (actions row `overflow-x-auto`, no wrap).
- **Problem:** Tracked (§17.4, LAY-5): «إصدار رسم جديد» is off-screen at 360px on the fees page.
- **Depends on:** none
- **Acceptance criteria / Verification:** harness at 360px on fees and citizens, ar and en.

## [UX-21] Show calendar days with formatDay
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `damage/damage-history.tsx` (`reinspectAt`), `end-ownership-dialog.tsx` (`endedAt`), `citizens/[citizenId]/payments/[paymentId]/page.tsx` (`paidOn`).
- **Problem:** Tracked (§17.6, PRIM-12).
- **Depends on:** none
- **Acceptance criteria / Verification:** `formatDay` at each.

## [UX-22] Remove the fake login history from «أمان الحساب»
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `settings/security-section.tsx` (`SAMPLE_ROWS`, 2 refs).
- **Problem:** Tracked (§17.1, BAN-13): a security screen showing invented sign-ins.
- **Depends on:** none (wiring real history needs an endpoint — out of scope)
- **Acceptance criteria / Verification:** table removed or fed by a real route; `grep SAMPLE_ROWS` → 0.

## [UX-23] Write step numbers and audit counts in Latin digits
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `citizen-form.tsx` («١ ٢ ٣»), `audit/page.tsx` (`toLocaleString('ar')`).
- **Problem:** Tracked (§17.6, TYP-4).
- **Depends on:** none
- **Acceptance criteria / Verification:** `ar-u-nu-latn` / `FORMAT_LOCALE`.

## [UX-24] Keep ConfirmDialog's title clear of the close button
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `components/ui/confirm-dialog.tsx` header, `components/ui/dialog.tsx` `DialogHeader`; default `confirmLabel` «تأكيد» (FRM-3).
- **Problem:** Tracked (§17.1).
- **Depends on:** SUBMIT-01 (same file)
- **Acceptance criteria / Verification:** `pe-*` on the header; harness at 360px with a long title.

---

## 9. Error handling

## [ERR-01] Show error.message, not the server's payload text
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** S · **Category:** Error-handling
- **Files:** 24 renders of `payload.message` in 13 files: `landlord-proposal-card.tsx` 3, `building-editor.tsx` 3, `unit-correction-delete-dialog.tsx` 2, `parcel-correction-dialog.tsx` 2, `end-tenancy-dialog.tsx` 2, `end-ownership-dialog.tsx` 2, `citizen-editor.tsx` 2, `zones/page.tsx` 2, `buildings/page.tsx` 2, `settings/cadastre-section.tsx`, `landlord-unlink-dialog.tsx`, `building-unit-picker.tsx`, `citizens/landlord-links/page.tsx`.
- **Problem:** Tracked (§17.6, TXT-6 — count unchanged since 2026-10-08). For a coded refusal the payload message is English log text: Arabic screens show English.
- **Acceptance criteria:** `grep -rn "payload\.message\|payload?\.message" apps/frontend/app apps/frontend/components` → 0.
- **Depends on:** none
- **Verification:** the grep; frontend tests.

## [ERR-02] Stop showing a failed read as "nothing there"
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** Error-handling
- **Files:** `building-unit-matrix-view.tsx:238`, `building-unit-matrix-drawer.tsx:230` (`getBuildingDamage(...).catch(() => null)`), `citizen-editor.tsx:1050,1062` (`getCase`, `getBuilding` `.catch(() => null)`), `building-editor.tsx:1206` (`checkPropertyNumber(...).catch(() => null)`).
- **Problem:** **NEW**. A damage read that fails renders as an undamaged building; a property-number check that fails reads as "not taken". STA-1.
- **Acceptance criteria:** a failed side read shows a `RefreshFailedAlert` (or a line saying it could not be read) with a retry; the main view still renders.
- **Depends on:** none
- **Verification:** harness with the damage route answering 500.

## [ERR-03] Return a reason code from payoutRefusal
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Error-handling
- **Files:** `packages/shared-schemas/src/payout-policy.ts` `payoutRefusal` (Arabic prose), its server throw (uncoded `ValidationError`), the payout dialog.
- **Problem:** Tracked (§17.6). English screens read Arabic.
- **Acceptance criteria:** a code from `ERROR_CODES`, `errors.<CODE>` in both files (Abed adds copy).
- **Depends on:** none
- **Verification:** `api-errors.test.ts`; `commission-payout.test.ts`.

## [ERR-04] Code the block-driven refusals and their preview reasons
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** L · **Category:** Error-handling
- **Files:** `LandlordLinkService` (`plan.block.message`), `UnitCorrectionService` (`blockerMessage`), `CitizenMergeService` (`blocks[0].message`); their preview endpoints.
- **Problem:** Tracked (apps/backend/CLAUDE.md Error codes: "need localising first").
- **Acceptance criteria:** each block carries `{ code, params }`; the preview returns codes; message files hold the words.
- **Depends on:** none
- **Verification:** specs for each block; frontend in ERR-05.
- **Done 2026-11-25:** every block carries `refusal: { code, params }` (`BlockRefusal`, shared `error-codes.ts`): a
  `LinkBlock` (`LANDLORD_LINK_*`), a `CitizenMergeBlock` (`MERGE_*`, one code per variant of a block code) and an undo's
  `CitizenUnmergeBlock` (`UNMERGE_*`); «حذف تصحيحي» and «دمج كدوبلكس» blockers through the shared
  `unitCorrectionBlockerRefusal` / `duplexMergeBlockerRefusal`, sent as each preview blocker's `refusal`. The act pressed anyway throws
  the same code (`refusedBy`, `domain-error.ts`); 37 codes in both message files (`lib/block-refusals.test.ts`).
  `DUPLEX_MERGE_BLOCKED` is retired (its `reason` param was an Arabic sentence). `message` is still sent beside
  `refusal` for the frontend that reads it today.

## [ERR-05] Render the preview blocks from their codes
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** Error-handling
- **Files:** `landlord-proposal-card.tsx`, `unit-correction-delete-dialog.tsx`, `merge-citizens-dialog.tsx`, `landlord-unlink-dialog.tsx`.
- **Depends on:** ERR-04
- **Acceptance criteria / Verification:** no server text rendered; harness in `/en/`.
- **Found during ERR-04:** render `localizeApiError(block.refusal)` (it takes `{ code, params }`); then remove `message`
  from `LinkBlock`, `CitizenMergeBlock`, `CitizenUnmergeBlock` and the API's builders in the same release, a backend
  change. Also `citizen-editor.tsx` (`changes.reconciled.blocked[].block.message`, a save's toast) and
  `citizen-merges.tsx` (the undo's blocks), neither in the file list above.
- **Done 2026-11-25:** every block is worded by `blockText(block, locale)` (`lib/api-errors.ts`: `localizeApiError` over
  the block's `refusal`, the server's sentence only for a code the build does not know) in `landlord-proposal-card.tsx`,
  `merge-citizens-dialog.tsx`, `citizen-merges.tsx`, `citizen-editor.tsx` (the owner-link toast) and
  `unit-correction-delete-dialog.tsx`, whose hand-written `blockerText` (a second copy of the words, inline in two
  languages) is gone. `landlord-unlink-dialog.tsx` renders no block: its only server text was `payload.message`, which is
  ERR-01 (PR #205). `duplex-merge-dialog.tsx` words its blockers from `unitLevels.merge.blocker`, not from server text, and
  was left as it is. `message` stays on the wire for one release (a page from before this one would show a block with no
  sentence); removing it from the three types and the builders is logged in `docs/code-quality.md`.
  `lib/err-05-pag-05.test.ts`. **Not done:** the harness in `/en/` (nothing here was rendered).
- **Found during ERR-05:** `edit-review-dialog.tsx` renders `blocker.message` of the citizen edit review's own blockers
  (`STALE`, `TENANTS_LINKED`), server Arabic on `/en/`; not a block of ERR-04's, so not coded.

## [ERR-06] Detect offline by status in ErrorState and give it a bilingual title
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** Error-handling
- **Files:** `components/ui/states.tsx` `ErrorState` (matches «تعذّر الاتصال» in its description; Arabic-only default title); the four `Alert`s standing in for it: `parcel-roster-dialog`, `case-editor`, `citizen-editor`, `settings/users-section`.
- **Problem:** Tracked (§17.1 red banners; frontend CLAUDE.md Errors).
- **Acceptance criteria:** an `offline` prop from `status === 0`; title from messages; the four move to `ErrorState` with retry.
- **Depends on:** none
- **Verification:** grep «تعذّر الاتصال» in `states.tsx` → 0.

## [ERR-07] Add an error boundary inside the staff shell
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** Error-handling
- **Files:** new `app/[tenant]/[locale]/[adminPath]/(protected)/error.tsx`. Today only `app/[tenant]/[locale]/error.tsx` and `app/global-error.tsx` exist.
- **Problem:** **NEW**. A render error on any staff page replaces the whole tenant layout, shell and navigation included, so the user cannot go elsewhere without a reload. (Offline queue and held keys live in module state/IndexedDB and survive.)
- **Acceptance criteria:** the boundary renders inside `AdminShell` with retry and a link home; localised.
- **Depends on:** none
- **Verification:** harness with a page that throws.

---

## 10. Performance

## [PERF-01] Filter transfers by kind in SQL, paged
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Performance
- **Files:** `treasury/transfers.service.ts` `list` (`kind` = `SAME_CURRENCY`/`EXCHANGE`: every matching id read unpaged, then an `IN` list).
- **Problem:** Tracked (CQ Backend). Grows with every handover.
- **Acceptance criteria:** schema-qualified paged raw query (or a generated `isExchange` column + index — that one is a migration PR first).
- **Depends on:** none
- **Verification:** transfers suites; `raw-sql-is-schema-qualified.spec.ts`.

## [PERF-02] Drop the unused totals and days from GET treasury/movements
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Performance
- **Files:** `treasury/treasury-movements.service.ts` (`totals`, `days`), its shared schema, `lib/api-client.ts` type.
- **Problem:** Tracked (CQ Backend). Summed on every read; no screen shows them.
- **Depends on:** none
- **Acceptance criteria / Verification:** removed from the contract; movements specs.

## [PERF-03] Measure the top list queries against a seeded database before adding indexes
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** M · **Category:** Performance
- **Files:** `CitizensService.list` / `reviewQueue`, `FeesService.listAllPayments`, `AuditService.query`, `census-worklists.ts` (`unsurveyedUnits`, `reinspections`), `ArrearsReportService.report`.
- **Problem:** Not audited here (no plans were read). Inputs found: `findMany` without `take` counted per service (buildings 40, citizen-merge 37, unit-correction 19, landlord-link 18, fees 15 — most bounded by a parent id); queries inside loops in `citizen-merge.service.ts` (12, bounded per merge), `landlord-link.service.ts:1660,2705`, `owner-billing.service.ts:96-98` — small N under a lock.
- **Acceptance criteria:** EXPLAIN ANALYZE on the local seed (`pnpm db:seed`, `db:seed:census`) — never staging/prod data on a laptop (non-negotiable 4); a migration PR per index that earns it.
- **Depends on:** none
- **Verification:** a short note in docs/database.md with the plans.

---

## 11. Dead code

## [DEAD-01] Remove the unused qrcode dependency from the backend
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Dead-code
- **Files:** `apps/backend/package.json:54` (`qrcode`), `:73` (`@types/qrcode`), lockfile.
- **Problem:** **NEW**. No import anywhere in `apps/backend`.
- **Acceptance criteria:** removed; `pnpm install --frozen-lockfile` and build pass.
- **Depends on:** none
- **Verification:** `grep -rn "qrcode" apps/backend --include=*.ts` → 0; CLAUDE.md/README package-script rows checked.

## [DEAD-02] Delete APP_CONFIG.tenantRoutePattern and OtpService.pruneExpired
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Dead-code
- **Files:** `presentation/config/app.config.ts:31`; `identity/otp.service.ts:207` (`pruneExpired`; the job calls its own `pruneExpiredChallenges`).
- **Problem:** Tracked (CQ Backend "no readers"), but the row also lists `APP_CONFIG.throttle.submission`, which **is** read (`citizen-requests.controller.ts:45-46`) — keep it and fix the row.
- **Depends on:** none
- **Acceptance criteria / Verification:** greps → 0 readers before deleting; row corrected.

## [DEAD-03] Delete the test:e2e script and the @shared path alias
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Dead-code
- **Files:** `apps/backend/package.json:26` (`test:e2e` → missing `test/jest-e2e.json`), `apps/backend/tsconfig.json:11` (`@shared/*`).
- **Problem:** Tracked (CQ Backend).
- **Depends on:** none
- **Acceptance criteria / Verification:** removed; `grep -rn "@shared/" apps/backend/src` → 0; docs table row for `package.json`.

## [DEAD-04] Delete dummyfile.txt and the root copy of bazoreyye.kmz
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Dead-code
- **Files:** `dummyfile.txt`, `bazoreyye.kmz` (root; `apps/backend/data/bazoreyye.kmz` is the one the seed uses).
- **Problem:** Tracked (CQ CI).
- **Depends on:** none
- **Acceptance criteria / Verification:** `git ls-files dummyfile.txt bazoreyye.kmz` → empty; `pnpm db:seed:census` still works locally.

## [DEAD-05] Turn on deleteOutDir for the backend build
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** XS · **Category:** Dead-code
- **Files:** `apps/backend/nest-cli.json:7`.
- **Problem:** Tracked (CQ CI).
- **Depends on:** none
- **Acceptance criteria / Verification:** `deleteOutDir: true`; deploy job's build unaffected (check the pm2 path).

## [DEAD-06] Delete the frontend modules nothing imports
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** Dead-code
- **Files:** `components/admin/confirm-cash-payment-dialog.tsx` (96 lines), `components/admin/workflow.tsx` (232, exports `WorkflowEmpty`, `WorkflowRail`, `WorkflowSection`), `lib/use-section-nav.ts` (76 — **NEW**: its only importer is `workflow.tsx`), `components/admin/settings/backup-section.tsx` (1,170 — no importer; check DEAD-10's decision first, since it is the restore UI).
- **Problem:** Tracked (CQ Frontend). Deleting them also clears UX-12's two file inputs, a CTL-2 time input and part of UX-14.
- **Depends on:** DEAD-10 for `backup-section.tsx` only
- **Acceptance criteria / Verification:** `grep -rln "confirm-cash-payment-dialog\|admin/workflow'" apps/frontend` → 0 before deleting.

## [DEAD-07] Confirm whether the frontend needs zod as a direct dependency
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** Dead-code
- **Files:** `apps/frontend/package.json:41` (`zod ^4.6.6`).
- **Problem:** **NEW**. No `from 'zod'` import in `apps/frontend`; it may be needed to resolve shared-schemas' peer at runtime.
- **Acceptance criteria:** remove it and run `pnpm build:check`; keep it with a comment if the build needs it.
- **Depends on:** none
- **Verification:** build.

## [DEAD-08] Delete the unbound Supabase adapters (after the decision)
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Dead-code
- **Files:** `domain/interfaces/supabase-auth.interface.ts`, `infrastructure/supabase/auth/supabase-auth.service.ts` (150; logs a raw email at :146), `infrastructure/supabase/storage/supabase-storage.service.ts`, `infrastructure/cadastre/cadastre-storage.service.ts`, `SUPABASE_*` in `envSchema`, `@supabase/supabase-js`; still imported by `infrastructure.module.ts`, `s3-storage.service.ts`, `s3-cadastre-storage.service.ts`, `scripts/import-parcels.ts`.
- **Problem:** Tracked (CQ Backend), **Undecided: when** (U-9).
- **Depends on:** decision U-9
- **Acceptance criteria / Verification:** `grep -rn supabase apps/backend/src -il` → 0; boot with no `SUPABASE_*` set.

## [DEAD-09] Retire the Vercel runtime files (after the decision)
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Dead-code
- **Files:** `presentation/serverless.ts` (107), `apps/backend/api/index.js`, `apps/backend/vercel.json`, `apps/backend/public/index.html`, the `!VERCEL` default in `isSchedulerEnabled`; `InternalCronController`.
- **Problem:** Tracked (CQ Backend), **Undecided** (U-10).
- **Depends on:** decision U-10
- **Acceptance criteria / Verification:** files gone; docs/deploy-vercel.md row; scheduler default explicit.

## [DEAD-10] Rebuild or delete BackupController and BackupService (after the decision)
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** M · **Category:** Dead-code
- **Files:** `presentation/controllers/backup.controller.ts` (120, unregistered — `presentation.module.ts:78`), `backup/backup.service.ts` (8 prose throws, a bare `$transaction`), `settings/backup-section.tsx`.
- **Problem:** Tracked (CQ Backend), **Undecided**; restore aborts once a tenant has ledger rows (memory: backup snapshot gaps).
- **Depends on:** decision U-11
- **Acceptance criteria / Verification:** per decision.

## [DEAD-11] Delete or rebuild dump-tenant.js and reset-2fa.ts (after the decision)
- **Priority:** P1 · **Assignee:** Hashem · **Estimate:** S · **Category:** Dead-code
- **Files:** `apps/backend/backups/dump-tenant.js` (81: citizens, staff hashes, TOTP secrets to plaintext JSON, `rejectUnauthorized: false`, no target guard), `apps/backend/src/scripts/reset-2fa.ts` (35: wipes every staff 2FA in every tenant).
- **Problem:** Tracked (SEC gap, Medium), **Undecided** (U-13). Citizen data leaves the environment if run (non-negotiable 4).
- **Depends on:** decision U-13
- **Acceptance criteria:** deleted, or rebuilt on `resolveTarget` with dry run, confirmation and an audit row.
- **Verification:** `git ls-files` / script tests.

## [DEAD-12] Retire or wire the numbering sequences (after the decision)
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** Dead-code
- **Files:** `system_settings.numberingSequences`, `SEQUENCE_KEYS`/`NumberingSequence` in `fee.schema.ts`, `FeesService.updateSettings`, `components/admin/settings/numbering-section.tsx` (Abed), `settingsCopy.numbering`.
- **Problem:** Tracked (CQ Backend; SEC gap Low). The screen says it sets the next number; nothing reads it since `0079`.
- **Depends on:** decision U-14
- **Acceptance criteria / Verification:** per decision; if retired, the column drop is a later contract release (non-negotiable 3).

## [DEAD-13] Remove the accent system (after the decision)
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** Dead-code
- **Files:** `lib/accents.ts` (`ACCENTS` with one entry, `ACCENT_INIT_SCRIPT`), `AccentProvider` (`setAccent` no-op), the `globals.css` "Accent palettes" comment.
- **Problem:** Tracked (CQ Frontend; §17.7), **Undecided**.
- **Depends on:** decision U-15
- **Acceptance criteria / Verification:** per decision.

### Unused code, scanned across all three packages

Scan (a node script over 1,048 `.ts`/`.tsx`/`.js`/`.mjs` files in `apps/frontend/{app,components,lib,i18n}`,
`apps/backend/src`, `packages/shared-schemas/src`, generated clients excluded; Next.js and Nest entry files — pages,
layouts, routes, modules, controllers, scripts — treated as used). It is a name search, not a type graph, so a symbol
whose name also appears in an unrelated file counts as used: the lists **under**-report, and every deletion still
needs its own grep. Full lists: `Claude outputs/unused-exports-2026-11-23.txt`, `Claude outputs/unimported-files-2026-11-23.txt`.

| Finding | Backend | Frontend | Shared | Task |
|---|---|---|---|---|
| Files nothing imports | 3 Supabase/cadastre adapters | `confirm-cash-payment-dialog`, `workflow`, `backup-section`, `use-section-nav` | — | DEAD-06, -08, -10 |
| Exports referenced **nowhere** (not even in their own file) | 7 (4 only by tests) | 20 (2 only by tests) | 37 (5 only by tests) | DEAD-14, DEAD-15 |
| Exports used only inside their own file (`export` not needed) | 189 | 174 | 130 | DEAD-16 |
| Client functions never called, whose API route then has no client | — | `getFeeTitles`, `getUnitVisits`, `updateBuilding`, `updateExpenseCategory` | — | DEAD-17 |

False positives checked and excluded: `src/types/express.d.ts` (ambient), `lib/sentry-options.ts` (loaded by
`sentry.*.config.ts` and `instrumentation-client.ts`, outside the scanned folders), and the test helpers
`tenant-test-client.ts`, `route-discovery.ts`, `icu-arguments.ts` (used by specs on purpose).

## [DEAD-14] Delete the frontend exports nothing references
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** Dead-code
- **Files:** `accent-provider.tsx` `useAccent`; `quality/finding-parts.tsx` `ROLLUP_KINDS`; `settings/settings-ui.tsx` `LocalOnlyNotice`; `unit-figures.tsx` `hasUnitFigure`; `unit-grid-picker.tsx` `MAX_GRID_SIZE`, `MIN_GRID_SIZE`; `lib/accents.ts` `isAccent`; `lib/map-geometry.ts` `geometryCenter`; `lib/settings-i18n.ts` `isRtlLocale`; `lib/sentry-options.ts` `SHARED_SENTRY_OPTIONS` (check the config files first). The `workflow.tsx` and `confirm-cash-payment-dialog.tsx` symbols go with DEAD-06; the four API functions with DEAD-17.
- **Problem:** **NEW**. Code-quality rule 10: dead code is deleted.
- **Acceptance criteria:** each symbol deleted after a repo-wide grep (including the root config files) shows no reader.
- **Depends on:** DEAD-06, DEAD-13 (accents)
- **Verification:** `pnpm typecheck`; `pnpm build:check`; frontend tests.

## [DEAD-15] Delete the backend and shared-schemas exports nothing references
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Dead-code
- **Files:** backend: `buildings/building.types.ts` `CreateBuildingRow`, `CreateUnitRow`; `domain/interfaces/base-repository.interface.ts` `BaseRepository`. Shared (37), among them `AdminCreateCitizen`, `AdminUpdateCitizen`, `IdentifiedPropertyEntry`, `ApproveArrearsBatchInput`, `arrearsDecisionOf`, `ChangeEmail`, `ChangePassword`, `ConfirmPasswordReset`, `isOpenRequestStatus`, `ContactDetails`, `PersonalDetails` (+ partials), `ApiErrorBody`, `FeeMatrix`, `FeeTargetType`, `ReferenceLogin`, `ReferenceOnlyLogin`, `ReviewPayment`, `paymentStatusSchema`, `unverifiedPaths`, `newsLanguageQuerySchema`, `BulkTender`, `SUGGESTED_PROPERTY_TYPE`, `PropertyNumberCheckResponse`, `TREASURY_DAY_STORED_STATUSES`, `unitCoversFloor` (full list in the txt).
- **Problem:** **NEW**. Some unused shared *types* should rather be **used**: a controller or client that re-declares the shape inline (CODE-3) is the bug, not the type. Decide per symbol: delete, or replace the inline copy with it.
- **Acceptance criteria:** each symbol deleted or adopted; the 9 used only by specs (`isEmptyChange`, `isStructuralBillableType`, `arrearsCellsFromHeaders`, `isDocumentNumber`, `shareWeight`, `propertyNumberCheckSchema`, `levelSpanLimits`, …) are reviewed: production code that should call them, or test-only code that goes.
- **Depends on:** none
- **Verification:** shared build; both apps' typecheck and tests.

## [DEAD-16] Drop `export` from the 493 symbols used only inside their own file
- **Priority:** P3 · **Assignee:** Hashem (backend + shared, 319) and Abed (frontend, 174) — one PR per package · **Estimate:** M · **Category:** Dead-code
- **Files:** the `local-only` lines of `unused-exports-2026-11-23.txt` (most in `arrears.schema.ts` 6, `use-citizen-search.ts` 5, `image-compression.ts` 5, `fees.service.ts` 5, `buildings.service.ts` 5).
- **Problem:** **NEW**. An export with no importer reads as public API and blocks the tools in DEAD-18 from finding real dead code.
- **Acceptance criteria:** `export` removed where nothing imports it; anything that then becomes unused inside its file is deleted too.
- **Depends on:** DEAD-18 (let the tool produce the authoritative list, then work from it)
- **Verification:** typecheck; the tool's report shows zero unused exports for the package.

## [DEAD-17] Retire the four client functions nobody calls, and decide on their routes
- **Priority:** P3 · **Assignee:** Hashem · **Estimate:** S · **Category:** Dead-code
- **Files:** `lib/api-client.ts` `getFeeTitles` (→ `GET fees/titles`, `fees.controller.ts:271`), `getUnitVisits` (→ `GET buildings/units/:unitId/visits`, `buildings.controller.ts:528`), `updateBuilding` (→ `PATCH buildings/:id`, `:205`), `updateExpenseCategory` (→ `PATCH expenses/categories/:id`, `expenses.controller.ts:74`).
- **Problem:** **NEW**. A route with no client is attack surface with no user. Some may be intended (an expense category cannot be edited from any screen today — a missing feature, or a route kept on purpose; `updateBuilding` may be superseded by `matrix-save`). Each is a check, not a blind delete.
- **Acceptance criteria:** per route: delete the route and its client function (route inventory updated), or wire the screen that should call it and say which in the PR.
- **Depends on:** none
- **Verification:** `route-inventory.spec.ts`; `grep -n "getFeeTitles\|getUnitVisits\|updateBuilding\b\|updateExpenseCategory" apps/frontend` → 0, or a caller.

## [DEAD-18] Fail CI on unused files, exports and dependencies
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** M · **Category:** Dead-code
- **Files:** root `package.json` (a `knip` devDependency and a `lint:unused` script), `knip.json` (workspaces: the two apps and shared-schemas; Next and Nest entry points; generated clients ignored), `.github/workflows/ci.yml`.
- **Problem:** **NEW**. Nothing stops unused code coming back: today's scan is a one-off name search. A type-aware tool also covers what this audit found by hand (DEAD-01 `qrcode`, DEAD-07 `zod`).
- **Acceptance criteria:** 1. `pnpm lint:unused` reports files, exports, types and dependencies per workspace. 2. CI runs it; it fails on new findings, with a baseline for today's until DEAD-14…16 clear them. 3. The new script is written into CLAUDE.md, README.md and the package guides (docs table, package-script row).
- **Depends on:** none (adding a devDependency: say so in the PR, read knip's docs for the installed version rather than recalling its config)
- **Verification:** CI run on a branch with a deliberately unused export fails.

---

## 12. Navigation and pages (Category: UI/UX)

### What the sidebar is today

`components/admin/nav.ts` `NAV_GROUPS`: **35 rows** in an unlabelled landing group and 8 labelled groups. A manager
(`SUPER_ADMIN`, on every row's role list) sees all 35, plus «الأخبار» when the village has the module. The file's own rules:
at most five rows a group, one icon per row, groups cut "by the job" (reorganised 2026-10-09). The app has 81 staff routes;
46 have no row and are reached from a page header (`buildings/types`, `requests/types`, `finance/income/categories`,
`fees/notices`, `fees/exemptions`, `fees/arrears/**`, …). That is the repo's established pattern for reference lists and
sub-screens, and several rows break it.

| Group | Rows today | Proven issue |
|---|---|---|
| (landing) | لوحة التحكم · أرباح المسح الميداني · جولتي | «أرباح المسح الميداني» is **also** in the user menu (`admin-header.tsx:300`), there with no role check, so «مشاهد فقط» sees it in the menu while the row hides it (`WORKING_STAFF_ROLES`) |
| المواطنون | سجل المواطنين · تسجيل مواطن جديد · يتطلب مراجعة · روابط المالكين · طلبات المعاملات | «تسجيل مواطن جديد» is an action, not a place: the citizens page header and the unsurveyed worklist already link `/citizens/new` |
| المباني والأرض | سجل المباني · الخريطة · القطاعات | — |
| العمل الميداني | وحدات غير ممسوحة · الحالات · بانتظار إعادة الكشف | the two worklists share roles (`WORKLIST_ROLES`) and one backend module (`census-worklists.ts`) |
| الرسوم والجباية | الرسوم والمدفوعات · سجل العمليات · فواتير تأثّرت بتصحيحات · المستحق على عقار · الجباة والتحصيل | «فواتير تأثّرت بتصحيحات» is **also** a header link on `/fees` (`fees/page.tsx:805`); `/payments` reads the same `getAllPayments` as `/fees` (`transactionsOnly: true`, by method) |
| الخزينة | الأرصدة · الإيرادات والنفقات · الحركات المالية · المناقلات والمصارفة · جرد وإقفال اليومية | the recording/register split was decided 2026-10-12 — keep |
| المراجعة والتدقيق | السجلات · ملاحظات الجودة · التحقق الميداني · الجودة حسب الموظف · سجل النشاطات | the four quality rows are one `QualityScreen` frame each (40–77-line pages); `/quality` is a client redirect to `/quality/reviews` |
| الأخبار | الأخبار · أقسام الأخبار · ناشرو الأخبار | categories and publishers are reference lists, which everywhere else are header links (`requests/types`, `buildings/types`) |
| النظام | إعدادات البلدية · الموظفون · أمان الحساب | «أمان الحساب» is **also** in the user menu (`admin-header.tsx:305`); settings has a «المستخدمون» tab (`UsersSection`: `getStaff`, `createStaff`, `setStaffActive`) that repeats `/staff` |

Page titles that differ from their row (PRIM-1: the title says what the page is): `/fees` «إدارة الرسوم والمدفوعات» vs
«الرسوم والمدفوعات»; `/finance` «أرصدة الخزينة» vs «الأرصدة»; `/inspector/profile` «لوحة أرباح المفتش الميداني» / «أرباح المسح
الميداني» vs «أرباح المسح الميداني»; in English `/audit` "Audit trail" vs "Audit log", `/staff` "Staff" vs "Staff management".
The 13 `messages.nav` keys are never read (tracked, §17.6).

Two queues with near-identical names in two groups: «يتطلب مراجعة» (`/citizens/review`: files saved with gaps, which the
officer completes) and «السجلات» / "Records to review" (`/quality/reviews`: files a reviewer approves or returns).

Portal: `/` signs a citizen in by رقم مرجعي and lands on «ملفّي». `/login` (phone code) and `/my-account` («حسابي») link
only to each other: `/login` pushes to `/my-account` (`login/page.tsx:104`), and `/my-account` sends a signed-out citizen
back to `/login` (`my-account/page.tsx:55,65`). In production `OtpService` refuses to send a code with no SMS route
(`otp.service.ts:149-152`, `assertDeliverable`), and open-decisions §2 says the phone code is not used. So a citizen whose
session ends on «حسابي» lands on a page that cannot sign them in. `/my-file` reads everything `/my-account` reads
(`getMySummary`) and the bills too.

### Proposed sidebar (needs approval: NAV-01): 35 rows → 26 (25 if NAV-08 moves «المستحق على عقار»)

| Group | Rows |
|---|---|
| (landing) | لوحة التحكم · أرباح المسح الميداني · جولتي |
| المواطنون | سجل المواطنين · يتطلب مراجعة · روابط المالكين · طلبات المعاملات |
| المباني والأرض | سجل المباني · الخريطة · القطاعات |
| العمل الميداني | قوائم العمل الميداني (tabs: غير ممسوحة / بانتظار إعادة الكشف) · الحالات |
| الرسوم والجباية | الرسوم والمدفوعات · سجل العمليات · المستحق على عقار · الجباة والتحصيل |
| الخزينة | unchanged (5) |
| المراجعة والتدقيق | الجودة (tabs: السجلات / الملاحظات / التحقق الميداني / حسب الموظف) · سجل النشاطات |
| الأخبار | الأخبار (categories and publishers from its header) |
| النظام | إعدادات البلدية · الموظفون (account security in the user menu only) |

**Gating trap for every removal:** `canAccessPath` (`nav.ts:837`) opens a path with no row to every role, and a path under
a row to that row's roles (longest match, CODE-4). So:
- a merged page keeps its old paths in the surviving row's `also` (`nav.ts:105`), as `/finance/transactions` does;
- `/citizens/new` has **no** role check of its own (0 role references in the page); without its row it falls under
  `/citizens` (`EVERY_STAFF_ROLE`), and «مشاهد فقط» could open the form. It must turn away roles outside
  `CITIZEN_RECORD_EDIT_ROLES` itself, as `case-editor` does, before its row goes.

## [NAV-01] Approve the target sidebar and the page moves
- **Priority:** P2 · **Assignee:** Hashem · **Estimate:** S · **Category:** UI/UX
- **Files:** none (a decision); then PRODUCT.md (capabilities moved), the `nav.ts` "How it is cut" comment, `lib/nav.test.ts`.
- **Problem:** Removing or merging rows changes where staff find their work. That is a product decision (CLAUDE.md
  "Undecided means undecided"). The proposal above is drawn from source only; no staff member was asked and no screen was rendered.
- **Acceptance criteria:** 1. Each of NAV-02…08, PAGE-01, PAGE-03, PAGE-05, PAGE-06 is marked approved, changed or rejected in this file.
  2. The approved map is written into the `NAV_GROUPS` comment.
- **Depends on:** none
- **Verification:** this file updated; the decision recorded in docs/open-decisions.md.
- **Done 2026-11-25** (Hashem's interactive answers): every task below carries its decision; the approved map is in the
  `NAV_GROUPS` comment ("The approved map"); PAGE-03, PAGE-05 and PAGE-06 were decided the day before (#231, §24).

## [NAV-02] Move «تسجيل مواطن جديد» out of the sidebar, with the page turning away roles that cannot write
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `components/admin/nav.ts:266-270` (the row, with its literal role list, DRY-12); `app/…/(protected)/citizens/new/page.tsx` (no role check today).
- **Problem:** A second door to an action the citizens page header (`citizens/page.tsx`) and the unsurveyed worklist already offer.
- **Acceptance criteria:** 1. The page sends a role outside `CITIZEN_RECORD_EDIT_ROLES` back to `/citizens`, saying why. 2. The row is gone; the command palette still offers the action. 3. `lib/nav.test.ts` updated.
- **Depends on:** NAV-01
- **Verification:** `lib/nav.test.ts`; harness as «مشاهد فقط» on `/citizens/new`.
- **Done 2026-11-25:** the row is gone (35 → 32). `/citizens/new` turns a role outside `CITIZEN_RECORD_EDIT_ROLES` back to
  `/citizens`, with a toast saying why, before it draws the form (`useRoleGate`, `components/admin/use-role-gate.ts`;
  `lib/use-role-gate-dom.test.ts` mounts the real page for seven roles). The palette still offers it and the header still
  names it: `OFF_SIDEBAR_PAGES` / `paletteOnlyItems` / `pageNavItem` in `nav.ts`. The row's role list was a literal that left out
  `COLLECTOR`; the page and the palette now use `CITIZEN_RECORD_EDIT_ROLES`, which has it and is what `CitizenController.create`
  accepts, so a collector may now open the form (and see it in the palette). `lib/nav-02-06-07.test.ts`.
  **Not done:** the harness as «مشاهد فقط»; nothing was rendered in a browser.
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **approved** as written.

## [NAV-03] Merge the four quality rows into one «الجودة» page with tabs
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `quality/page.tsx` (client redirect today), `quality/{reviews,findings,checks,officers}/page.tsx`, `components/admin/quality/quality-screen.tsx`, `nav.ts:652-680`.
- **Problem:** Four rows open the same frame with a different body. Precedent for one page with tabs: «أنواع المباني» / «أنواع الوحدات» (`buildings/types`, a `SegmentedControl` in `?tab=`).
- **Acceptance criteria:** 1. One row, `path: '/quality'`, `also` holding the four old paths so links and gating still work. 2. `?tab=reviews|findings|checks|officers`, `useUrlState`. 3. A `SegmentedControl` driving the panels, or `Tabs` once UX-08 lands (CTL-9).
- **Depends on:** NAV-01; UX-08 optional
- **Verification:** `lib/nav.test.ts`; old URLs open the right tab.
- **Done 2026-11-25:** one row, `/quality` («الجودة»), whose `also` holds the four old paths; the page is
  `quality/page.tsx` over `components/admin/quality/quality-tabs.tsx`, the four screens as `Tabs` (`PageTabs`,
  `components/admin/page-tabs.tsx`) in `?tab=reviews|findings|checks|officers`, «اعتماد السجلات» first, and the
  old four pages are server redirects keeping their query strings (`lib/legacy-address.ts`). The review queue's own
  state filter was `?tab=` and is `?queue=` now, because the page needs `?tab=`. A change of tab clears every
  parameter the panels keep (`QUALITY_PANEL_KEYS`, taken from their schemas): two of them page with `?page=` and
  `?limit=`. `QualityScreen` stays the one role gate. `lib/nav-03-04-11.test.ts` (the redirects are invoked, not
  read), `lib/page-tabs-dom.test.ts`. **Not done:** the harness; nothing rendered in a browser.
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **approved**; the first tab is «اعتماد السجلات» (NAV-11). NAV-12 is superseded.

## [NAV-04] Merge the two census worklists into «قوائم العمل الميداني»
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `buildings/unsurveyed/page.tsx`, `buildings/reinspections/page.tsx`, `nav.ts:387-414`.
- **Acceptance criteria:** one row with `also` for both paths; `?tab=`; each tab keeps its own paging and filters in the URL.
- **Depends on:** NAV-01
- **Verification:** `lib/nav.test.ts`; harness.
- **Done 2026-11-25:** one row, `/buildings/worklists` («قوائم العمل الميداني»), `also` both old paths, ahead of «الحالات»;
  the page is `buildings/worklists/page.tsx` over `PageTabs`, `?tab=unsurveyed|reinspections`, the two pages' bodies moved
  (with `git mv`) to `components/admin/worklists/` without their own header. Each tab keeps its own page, size and officer
  filter in the URL: the first keeps `?page=`, `?limit=`, `?owner=`, the second takes `reinspectPage`, `reinspectLimit`,
  `reinspectOwner` (`lib/worklist-tabs.ts`), so a change of tab clears nothing and going back finds them. The old pages
  are server redirects, the second renaming those three keys. `lib/nav-03-04-11.test.ts`, `lib/page-tabs-dom.test.ts`.
  **Not done:** the harness; nothing rendered in a browser.
- **Found during NAV-04:** a role outside `WORKLIST_ROLES` still opens `/buildings/worklists` (and did the old pages): `canAccessPath`
  falls through to the `/buildings` row it can see. The server refuses its reads (`CENSUS_WORKLIST_ROLES`), so it sees an
  error where it could be turned away; the page does not gate itself.
- **Fixed 2026-11-25 (with NAV-05, PAGE-01 and NAV-10):** `buildings/worklists/page.tsx` takes its token from `useRoleGate` with
  `WORKLIST_ROLES`: a role outside it is sent to `/buildings` with a toast (`access.fieldWorklists`) and neither tab is mounted.
  `lib/page-tabs-dom.test.ts` drives every role in and out of the set.
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **approved** as written.

## [NAV-05] Reach the news categories and publishers from the articles page
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `nav.ts:707-727`; `news/articles/page.tsx` header; `news/categories`, `news/publishers` (both gate themselves today).
- **Problem:** The repo's own pattern for reference lists is a header link from the list they feed. «الأخبار» would then be a group of one row; NAV-01 decides whether it stays a group.
- **Acceptance criteria:** one row with `also: ['/news/categories', '/news/publishers']`; two header links on the articles page; each page keeps `HeaderBackLink` to articles.
- **Depends on:** NAV-01
- **Verification:** `lib/nav.test.ts`.
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **changed**: the header links as written, but «الأخبار» is **not** folded into another group. It stays in the
  sidebar as one row under its own name, with no group heading above it. `NavGroup.label` is documented for the landing
  group only and `lib/nav.test.ts` pins that group unlabelled and first: widen both.
- **Done 2026-11-25:** one row, «الأخبار» (`/news/articles`, English «News»), whose `also` holds `/news/categories` and
  `/news/publishers`, so `NEWS_EDITOR_ROLES` still guards them. The group has no `key`, so no heading and no fold: the sidebar draws
  it between two rules, and gave a headingless group its own React key (it was "landing" for both). The articles page's header
  links to both lists, and each list gets a `HeaderBackLink` to the articles (it had none: "keeps" in the task was "gets").
  The two lists keep a crumb of their own through `OFF_SIDEBAR_PAGES`, and their keywords moved to the row, so the palette still
  finds them. `NavGroup.key` is documented for two headingless groups, and `lib/nav.test.ts` pins that they are exactly the
  landing group and this one. `lib/nav-05-page-01.test.ts` renders the sidebar for real. **Not done:** the harness; nothing
  rendered in a browser.

## [NAV-06] Keep «أمان الحساب» in the user menu only
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `nav.ts:755-759`; `admin-header.tsx:305` (stays).
- **Acceptance criteria:** the row is removed; `/account` still opens for every staff role (it has no row, so `canAccessPath` admits it); the header breadcrumb still names the page.
- **Depends on:** NAV-01
- **Verification:** `lib/nav.test.ts` (`activeNavItem` for `/account`).
- **Done 2026-11-25:** the row is gone; `/account` has no row, so `canAccessPath` admits every role (pinned in
  `lib/nav-02-06-07.test.ts`), the user menu still opens it, and the header's crumb names it through `pageNavItem`
  (`OFF_SIDEBAR_PAGES`, `activeNavItem` alone would name nothing). The palette does not offer it: the decision is "the user menu only".
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **approved** as written.

## [NAV-07] Reach «فواتير تأثّرت بتصحيحات» from the fees page only
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `nav.ts:458-462`; `fees/page.tsx:805` (stays, or moves into PAGE-04's menu); `fees/corrections/page.tsx`.
- **Problem:** Two doors to one page. Without the row, the path falls under `/fees` (`FEE_READ_ROLES`), which is wider than `PAYMENT_REVIEW_READ_ROLES`.
- **Acceptance criteria:** the page turns away roles outside `PAYMENT_REVIEW_READ_ROLES` itself (it has `canReview` today; check that it also covers *reading*), then the row goes.
- **Depends on:** NAV-01
- **Verification:** harness as a role in `FEE_READ_ROLES` but not in the review set.
- **Done 2026-11-25:** the page did not gate its reading (its `canReview` only hid the decision button, and the server's 403
  showed as an error), so it now takes its token from `useRoleGate` with `PAYMENT_REVIEW_READ_ROLES`: a role outside it
  reads nothing, is sent to `/fees` and told why. Then the row went. The fees page's header link (`canReadCorrections`) stays
  the one door; the palette does not list it; the header's crumb still names the page (`pageNavItem`). The PAGE-04 menu
  can take that link as it is. `lib/nav-02-06-07.test.ts`, `lib/use-role-gate-dom.test.ts`. **Not done:** the harness; nothing rendered in a browser.
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **approved** as written.

## [NAV-08] Decide where «المستحق على عقار» lives
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `fees/parcel/page.tsx` (206 lines, `getParcelDues`, no role check of its own), `nav.ts:472-476`.
- **Problem:** A one-question lookup (what is owed on a رقم عقار) with a row of its own. Options: keep the row; a header action or search mode on `/fees`; or a panel on the building's matrix. Product choice.
- **Depends on:** NAV-01
- **Acceptance criteria / Verification:** per the decision; gating kept (`FEE_READ_ROLES`).
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **keep the row.** Done 2026-11-25 with NAV-01: the row's comment records it and
  `lib/nav.test.ts` pins the row and its gate (every role in `FEE_READ_ROLES`, and no other, opens `/fees/parcel`).

## [NAV-09] Show «أرباح المسح الميداني» in the user menu only to the roles its row admits
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `components/admin/admin-header.tsx:300-303`.
- **Problem:** **NEW**, proven from source. The menu item has no role check; the sidebar row is `WORKING_STAFF_ROLES` (every role but «مشاهد فقط», `role-sets.ts:30`). The same entry is visible in one place and hidden in the other.
- **Acceptance criteria:** `hasRole(role, WORKING_STAFF_ROLES)` around the item, or remove the item if NAV-01 keeps the landing row as the one door.
- **Depends on:** none
- **Verification:** harness as «مشاهد فقط».

## [NAV-10] Read every nav label and its page title from one message key
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `nav.ts` (`label`/`labelEn` on 35 rows, TXT-1 legacy), `messages/{ar,en}.json` `nav.*` (13 keys, none read); titles: `fees/page.tsx:791`, `finance` (`finance.title` «أرصدة الخزينة»), `inspector-profile-detail.tsx:152`, `inspector-earnings-roster.tsx:151`, `audit/page.tsx`, `staff/page.tsx`.
- **Problem:** Tracked in part (§17.6 copy mechanisms; nav `labelEn`). The mismatched titles are **NEW**.
- **Acceptance criteria:** 1. `NavItem` takes a `messageKey`; the sidebar, breadcrumb, palette and the page's `PageHeader` read the same key. 2. `labelEn` removed. 3. `messages-parity.test.ts` passes.
- **Depends on:** do it after NAV-02…08 so the keys are written once
- **Verification:** `grep -c "labelEn" components/admin/nav.ts` → 0.
- **Done 2026-11-25:** `NavItem` and `NavGroup` take a `key` (`NavKey`, `NavGroupKey`, typed from the messages) instead of `label` and `labelEn`;
  `messages.nav` is `items` (31: the 26 rows and 5 pages with none) and `groups` (7), replacing the 13 keys nothing read. `localizedLabel` and
  `localizedGroupLabel` read them, `navLabel(key, locale)` is the lookup a page uses, and the palette matches either language's name.
  `grep -c labelEn nav.ts` is 0. Every page but three reads its row's key for its heading, and the two earnings screens do too. **Eight titles said
  something else and now say the row's words** (the row's, in every case; change the words once, in `messages.nav.items`): fees «إدارة
  الرسوم والمدفوعات» → «الرسوم والمدفوعات», "Fees & Billing" → "Fees & billing"; payments "Transactions Log" → "Payment operations";
  the treasury «أرصدة الخزينة» / "Treasury balances" → «الأرصدة» / "Balances" (put back to «أرصدة الخزينة» / "Treasury balances" by the owner on 2026-11-25, in PAGE-04's PR, so only the sidebar row changed in the end); buildings "Building Census" → "Building census"; audit "Audit trail" →
  "Audit log"; news "News articles" → "News"; staff "Staff" → "Staff management"; account "Account Security" → "Account security"; and
  the earnings row's English «My earnings & survey» → "Field survey earnings", because its page also serves the admins' roster. A page that
  is about one person keeps its own («أرباحي والمسح الميداني», "Inspector earnings: <name>"). **Not read from the key, and why**
  (`lib/nav-10.test.ts` lists them): `/map` (no header), `/citizens/new` (the form's own), `/inspector/profile` through its two components.
  The `title` messages those pages used (`cases.page.title`, `requests.title`, …) are now unread; left, not deleted. Folds: the sidebar remembers
  them by group key now, not by the Arabic heading, so each user's folds reset once. `lib/nav-10.test.ts` (46). **Not done:** nothing rendered in a browser.

## [NAV-11] Name the two record-review queues so they cannot be confused
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `messages.reviewQueue.title` («يتطلب مراجعة», `/citizens/review`); the «السجلات» row and title (`/quality/reviews`).
- **Problem:** Two queues of "records to review" in two groups, for two different jobs (completing a file vs approving one).
- **Acceptance criteria:** names chosen by the product owner that say the job (for example «ملفات ناقصة» / «اعتماد السجلات» — proposals only).
- **Depends on:** NAV-01
- **Verification:** both locales updated.
- **Done 2026-11-25:** `/citizens/review` is «ملفات ناقصة» / "Incomplete files" on its row, in `reviewQueue.title` and in the
  register's link to it; the quality queue is «اعتماد السجلات» / "Record approval" (`quality.tabs.reviews`, the first tab of
  «الجودة»). A record's own status badge still says «يتطلب مراجعة» (the citizen file, the register's row, the inspector's
  profile): that is the state of one record, not a queue, and was not part of the decision. `PRODUCT.md` names the queue anew.
  `lib/nav-03-04-11.test.ts`.
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** «ملفات ناقصة» / "Incomplete files" for `/citizens/review`, «اعتماد السجلات» / "Record approval" for
  `/quality/reviews`.

## [NAV-12] Redirect /quality on the server
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `quality/page.tsx` (a `'use client'` `useEffect` → `router.replace`, with a skeleton flash).
- **Problem:** The treasury's old addresses already redirect on the server (`finance/income`, `finance/expenses`, `await params`).
- **Acceptance criteria:** `redirect()` from `next/navigation` in a server page. Superseded if NAV-03 makes `/quality` the page itself.
- **Depends on:** none (skip if NAV-03 is approved)
- **Verification:** no client redirect.
- **Superseded 2026-11-25 by NAV-03:** `/quality` is the page of four tabs, not a redirect (open-decisions §25). The test that pinned
  it (`lib/ux-08-22-24-nav-12.test.ts`, "the quality index forwards") is replaced by the redirects of the four old pages, pinned in
  `lib/nav-03-04-11.test.ts`. NAV-12 (D3-384, built earlier in this stack) is replaced by it, and needs no more work.

## [PAGE-01] Remove the settings «المستخدمون» tab, which repeats /staff
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `settings/page.tsx:23,28,50,154` (`'users'` section), `components/admin/settings/users-section.tsx` (`getStaff`, `createStaff`, `setStaffActive`; own table, own search, red error `<p>`, `closeLabel` missing; UX-07, UX-10, SUBMIT-04), `lib/settings-i18n.ts` `ROLE_KEYS`/`ROLE_BACKEND_VALUE` (a role list copy, DRY-12).
- **Problem:** **NEW** as a redundancy finding. Two staff-management screens, both `SUPER_ADMIN`; `/staff` (891 lines) does create, edit, activate, delete, salary and commission. Removing the tab also clears UX-10's users half.
- **Acceptance criteria:** the tab is gone or replaced by a link to `/staff`; no import of `users-section.tsx` remains; the file is deleted.
- **Depends on:** NAV-01 (confirm nobody relies on it)
- **Verification:** `grep -rn "UsersSection" apps/frontend` → 0.
- **Done 2026-11-25:** the tab, `users-section.tsx` (574 lines) and what only it read in `lib/settings-i18n.ts` (the `users` copy in
  both languages, `nav.users`, `ROLE_KEYS`, `ROLE_BACKEND_VALUE`, `roleKeyFor`) are deleted, with `lib/settings-roles.test.ts` and the
  places four other tests read the section. `grep` finds no `UsersSection`. An old `?tab=users` opens «الملف» (the first section). The
  section's role catalogue («واجبات» of each role) is gone with it; `/staff` is the one place accounts are made. UX-10's users half
  and SUBMIT-04's `creatingRef` there are moot. `lib/nav-05-page-01.test.ts`. **Not done:** nothing rendered in a browser.
- **Decision (NAV-01, 2026-11-25, [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25)):** **approved** as written.

## [PAGE-02] Send a signed-out citizen on «حسابي» to the front door, not the phone-code page
- **Priority:** P1 · **Assignee:** Abed · **Estimate:** XS · **Category:** UI/UX
- **Files:** `(citizen)/my-account/page.tsx:55,65` (`router.replace(…/login)`).
- **Problem:** **NEW**. `/login` is the phone-code sign-in. In production `OtpService` refuses to send a code with no SMS route, and the front door offers no phone-code sign-in (frontend CLAUDE.md; open-decisions §2). Whether an SMS route is set on production is **Unverified**; if none is, the citizen is stuck.
- **Acceptance criteria:** the redirect goes to the front door (`/${tenant}/${locale}`), as `useCitizenSession`'s `endIfSignedOut` does for the request pages; a session read through `useCitizenSession` rather than `loadSession`.
- **Depends on:** none
- **Verification:** harness: an expired session on «حسابي» lands on the reference sign-in.

## [PAGE-03] Retire the portal's phone-code sign-in and «حسابي» (after the decision)
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `(citizen)/login/page.tsx` (256), `(citizen)/my-account/page.tsx` (335); backend `requestOtp`/`verifyOtp` routes stay until Hashem decides (OTP cleanup job, `OtpService`).
- **Problem:** An island of two pages reachable only by address; «ملفّي» covers what «حسابي» shows. `lib/citizen-payments.test.ts:128` reads `my-account`; update it.
- **Acceptance criteria:** both pages removed or redirected to `/my-file`; tests updated; PRODUCT.md updated.
- **Depends on:** decision U-21; PAGE-02 first
- **Verification:** frontend tests; harness.

## [PAGE-04] Give the fees page one primary action and fold the rest into a menu
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `fees/page.tsx:789-846` (`PageHeader` actions): «تحديث», «فواتير تأثّرت بتصحيحات», «إشعارات الرسوم», «قائمة الإعفاء», «المتأخرات», «تقرير المتأخرات», «تكليف مباشر», «إصدار رسم جديد».
- **Problem:** Up to 8 header actions for a manager, in a row that scrolls sideways with no hint (tracked LAY-5: «إصدار رسم جديد», the page's main action, is off-screen at 360px). ui-ux-standards §4: `primary` is "the one primary action". «تحديث» re-runs the read by hand, which the frontend guide's data rule (invalidate after a write) makes unnecessary.
- **Acceptance criteria:** 1. «إصدار رسم جديد» primary and first in reading order; «تكليف مباشر» secondary. 2. The six links in one `DropdownMenu` («المزيد», PRIM-26), each still gated by its own role check. 3. «تحديث» removed, or kept with a reason in a comment. 4. Fits at 360px in ar and en.
- **Depends on:** UX-20 (the wrap fix) can land first or together
- **Verification:** harness at 360/768/1440 for SUPER_ADMIN, ACCOUNTANT, COLLECTOR.
- **Done 2026-11-25:** the header is `FeesHeaderActions` (`components/admin/fees/fees-header-actions.tsx`): «إصدار رسم جديد» is the primary and
  first, «تكليف مباشر» the secondary (both `FEE_ISSUE_ROLES`'s), and «فواتير تأثّرت بتصحيحات», «إشعارات الرسوم», «قائمة الإعفاء»,
  «المتأخرات» and «تقرير المتأخرات» are five items of one «المزيد» `DropdownMenu`, each behind the role check it had («إشعارات الرسوم» for
  everyone who reads the ledger, so no role gets an empty menu). «تحديث» is gone: every read on the page is `useStaffQuery` and every write
  invalidates what it moved (`load`), so it re-ran by hand what the data rule retires. The page lost its eight icon imports, `tNotices`,
  `tExemptions`, `tArrears` and `refreshing`; the two actions' words are `fees.header` in messages. `lib/page-04.test.ts` renders the
  component for every role from the same role sets the page reads (order, the menu opened, no refresh). **Not done:** the harness at
  360/768/1440 in ar and en; nothing rendered in a browser.

## [PAGE-05] Decide whether «سجل العمليات» is a view of the fees page
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `payments/page.tsx` (744 lines, `getAllPayments({ transactionsOnly: true, method })`), `fees/page.tsx` (`getAllPayments({ status, feeTitle })`), `nav.ts:445-449` (literal role list).
- **Problem:** The bills and the money received for them are read from the same endpoint on two pages with two rows. Precedent for one page with two views: «الحركات المالية» `?view=queue`. The roles differ (`/payments` admits COLLECTOR, VIEWER, AUDITOR, ACCOUNTANT), so merging needs care.
- **Depends on:** NAV-01 (decision U-22)
- **Acceptance criteria / Verification:** per the decision.

## [PAGE-06] Decide whether the portal's «مدفوعاتي» stays a page beside «ملفّي»
- **Priority:** P3 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `(citizen)/payments/page.tsx` (`getMyPayments`, `getCitizenPortalSettings`), `(citizen)/my-file/page.tsx` (`getMySummary`, `getMyPayments`; links to payments for «طريقة الدفع»), `(citizen)/payments/login/page.tsx` (a second reference sign-in beside `/`).
- **Problem:** Two sign-in pages by رقم مرجعي and two pages listing the same bills. Some of this is deliberate (`/payments` is the pay-only door), so it is a product question.
- **Depends on:** decision U-23
- **Acceptance criteria / Verification:** per the decision.

### Page passes: bring each page to one page contract

Each PAGE-07…16 task takes one sidebar group, page by page, to this **page contract**. It is written from rules that already exist,
and it is the "optimised and handled well" definition for this sprint:

1. **One job**, said by a title equal to its row's label (PRIM-1, NAV-10).
2. **Header:** at most one primary action, first in reading order; beyond three actions, the rest in a `DropdownMenu`; no
   «تحديث» over a TanStack read; wraps at 360px (LAY-5).
3. **Session and reads:** `useStaffSession`, `useStaffQuery` with full keys, `readView` (a failed re-read keeps the page);
   no `loadSession`, no fetch chains in effects (CODE-1, CODE-2).
4. **Lists:** `DataTable` with server paging, `Pager`, `SearchField`, `LoadingState`/`EmptyState`/`ErrorState` (PRIM-3…5, PRIM-29).
5. **State in the URL:** filters, tab, page (`useUrlState`); the search term in tab storage.
6. **Writes:** in-flight ref, disabled with a spinner, `invalidateQueries` on the right keys, localised toast, retry key for
   money (STA-3, STA-4).
7. **Copy:** every string the page's files render in messages (TXT-1, TXT-2); errors through `error.message` (TXT-6).
8. **Size:** no file over ~600 lines (CODE-6).
9. **Rendered check:** 360/768/1024/1440, ar and en, per role that reaches it (§16 pre-merge checklist).
10. **Sweep and log** (section 0).

Each pass first lands the tasks already listed for its pages (named below); what is left over is the pass.

## [PAGE-07] Bring the landing pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** L · **Category:** UI/UX
- **Files:** `dashboard/page.tsx` (1,175; `loadSession`; `KpiCard` awaits the dashboard redesign — the user's decision, §17.1; reads `NEXT_PUBLIC_API_URL`), `inspector/profile/**` (`inspector-profile-detail.tsx` 732, `BreakdownTile` palette classes), `my-round/page.tsx` (341).
- **Problem:** see the files; related: ARCH-18, UX-03, DRY-13, NAV-09, NAV-10.
- **Acceptance criteria:** the page contract, items 1–10, on each page.
- **Depends on:** ARCH-18, NAV-01
- **Verification:** §16 checklist per page; frontend tests.

## [PAGE-08] Bring the citizens pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** L · **Category:** UI/UX
- **Files:** `citizens/page.tsx` (910; `CAN_WRITE`; header actions overflow at 360px in English, §17.4), `citizens/[citizenId]/page.tsx` (2,017; GOD-24), `citizens/[citizenId]/properties` (1,062; `EDIT_ROLES`), `citizens/[citizenId]/payments/[paymentId]` (1,213; §17.6 inline copy), `citizens/review/**`, `citizens/landlord-links/**` (`SUMMARY_ROLES`; CACHE-03), `requests/**`. Citizen PII on every page: no new reads beyond what the role may see (CODE-5).
- **Acceptance criteria:** the page contract.
- **Depends on:** DRY-12, ARCH-18, GOD-24, NAV-01
- **Verification:** as PAGE-07.

## [PAGE-09] Bring the buildings, map and zones pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** L · **Category:** UI/UX
- **Files:** `buildings/page.tsx` (1,110; `loadSession`; `transition-all` UX-17; UTC date UX-01; `payload.message` ERR-01), `buildings/[id]/**` (building editor GOD-21, matrix GOD-19/20), `buildings/types`, `map/page.tsx` + `fullscreen-map.tsx` (GOD-23, UX-04), `zones/page.tsx` (518; `loadSession`; Arabic toast UX-14).
- **Depends on:** GOD-19…23, ARCH-18
- **Acceptance criteria / Verification:** as PAGE-07.

## [PAGE-10] Bring the field-work pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `buildings/unsurveyed`, `buildings/reinspections` (NAV-04), `cases/page.tsx` (546; `loadSession`; hand-rolled tabs `case-queue-tabs.tsx` UX-08; unbounded list PAG-02/03), `cases/[caseId]/edit`, `cases/new`.
- **Depends on:** NAV-04, PAG-03, ARCH-18
- **Acceptance criteria / Verification:** as PAGE-07.
- **Done 2026-11-25 (part; stays In Progress):** `cases/page.tsx`, `case-queue-tabs.tsx`, `use-case-columns.tsx`, `case-link-dialogs.tsx` and `use-case-linking.ts`
  wrote about 60 strings inline in two languages; they are `cases.columns`, `cases.actions`, `cases.queues`, `cases.linking` and `cases.unlink` now, the list
  separator is `common.listSeparator`, and `CASE_TABS` carries ids only. «تحديث» was not there; a status change was guarded by `busyId` state alone, so
  **one status change or delete runs at a time through a ref** set before the state; a failed re-read **keeps the rows and says so**
  (`readView`, `RefreshFailedAlert`) where it replaced them with an error. `lib/page-10.test.ts` renders the table's headers and actions, the tabs, the
  unlink confirmation and the unlink write in both languages. The group's other files were already clean: `buildings/worklists` (NAV-04) and
  `case-editor.tsx` (no inline copy, 414 lines). **Open:** the list's server paging, with its tab counts, the zone filter and the conversion strip,
  waits for `GET cases` to take them (PAG-03, Hashem; D3-287). `link-case-citizen-dialog.tsx` has one inline pair of its own (`caseLinkUnit`'s fallback
  label), outside this pass. **Not done:** nothing rendered in a browser.

## [PAGE-11] Bring the fees and collection pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** L · **Category:** UI/UX
- **Files:** `fees/page.tsx` (1,002; PAGE-04; Arabic toasts UX-14), `fees/new` (wizard), `fees/notices` (PAG-05), `fees/exemptions`, `fees/corrections` (`loadSession`, `rtl:ml/ltr:mr` pair UX-16), `fees/parcel` (NAV-08), `fees/payments/[paymentId]/settle` (853; `loadSession`; `CurrencyInput` size UX-18), `fees/arrears/**` (PAG-06, SUBMIT-01; one inline `en ?` in `single-line-dialog.tsx`), `payments/page.tsx` (744; `loadSession`; PAGE-05), `finance/collectors/**` (UX-09).
- **Depends on:** PAGE-04, ARCH-18, SUBMIT-01
- **Acceptance criteria / Verification:** as PAGE-07; money screens keep every held key across the change (frontend CLAUDE.md, Writes).

## [PAGE-12] Bring the treasury pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `finance/page.tsx` (title NAV-10), `finance/movements`, `finance/transactions`, `finance/transfers/**`, `finance/daily/**` (`PRINT_CSS` print mechanism, CQ Frontend print row), `finance/accounts/[accountId]`, the print pages (`official-document.tsx`, `transfer-document.tsx`, `voucher-documents.tsx`).
- **Problem:** The most recently rebuilt group; mainly the print-mechanism unification (CQ Frontend) and the shared header rule.
- **Depends on:** none
- **Acceptance criteria / Verification:** as PAGE-07; `print-pages.test.ts`, `transfer-screens.test.ts` pass.
- **Done 2026-11-25 (part; stays In Progress):** **the print mechanism is one.** «تقرير الصندوق اليومي», «أمر الصرف», «سند القبض», «سند المناقلة»
  and the arrears sheet printed by `documentPrintCss` (hide by `visibility`, lift the root with `position: absolute`, a stylesheet each); they
  are `data-print-root`s now, as the account statement, the request paper and the bulk receipt were, and `documentPrintCss` is deleted. What only it
  did moved to `globals.css` for every document: `color-scheme: light` (the margins print from it, so a document without it, the statement among them, was exposed to dark ones
  from a dark theme), a section kept whole across a sheet, and the daily report's landscape sheet, named `register-landscape` and chosen by
  `data-print-page="landscape"`. Named pages are the mechanism the statement and the request paper already relied on; a browser that does not take
  them prints a document on the receipt's A5 sheet. `lib/print-roots.test.ts`. The other items measured clean: the two headers the audit's
  count flagged (`transactions`, `movements`) are three controls or fewer (the rest were phone-only or conditional), the group's copy is in
  messages (its 7 "inline" hits are locale logic), the reads use `readView`. **Open:** `record-expense-form.tsx` (740 lines) and
  `record-transfer-form.tsx` (688), one function each, carrying the money keys `expense:pay`, `expense:request` and `transfer:new`: a phased split
  with a render net first, in follow-up PRs. **Not done:** the print preview in a browser, in light and dark; nothing rendered.
- **Done 2026-11-25 (the expense form; the transfer form still open):** `record-expense-form.tsx` is split (740 → 140 lines). Its state,
  checks, in-flight ref and the keys `expense:pay` and `expense:request` are `useRecordExpense`, and its fields are three components, all in
  `components/admin/finance/expense-form/` (the largest, the hook, 393 lines). The logic and the JSX were moved by line range. The nets came
  first and pass on both the old file and the new: 34 jsdom cases on what a press does, and thirteen page states fingerprinted with the real
  controls, unchanged by the split (`lib/record-expense-form-dom.test.ts`, `lib/record-expense-form-render.test.ts`,
  `lib/treasury-form-files.test.ts`). **Not done:** tried in a browser, at any width.
- **Done 2026-11-25 (the transfer form; In Review):** `record-transfer-form.tsx` is split (688 → 73 lines): `useRecordTransfer` (state, figures,
  checks, in-flight ref, `transfer:new`; 351 lines), the wallets, amounts and statement fields, the summary with its actions, and the figure
  helpers, all in `components/admin/finance/transfer-form/`, moved by line range. The nets came first and pass on the old file and the new:
  41 jsdom cases and eighteen fingerprinted states, unchanged by the split (`lib/record-transfer-form-dom.test.ts`,
  `lib/record-transfer-form-render.test.ts`); `transfer-screens.test.ts` now reads the hook and the summary. No file in the group is over
  600 lines. **Not done:** the print preview and both forms tried by a person in a browser.

## [PAGE-13] Bring the review and audit pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `quality/**` (NAV-03; `review-queue.tsx` hand-rolled tabs UX-08; `findings-list.tsx` `CITIZEN_EDIT_ROLES`), `audit/page.tsx` (412; `loadSession`; `toLocaleString('ar')` UX-23; `Pager` UX-11), `audit-daily.tsx` (UX-10).
- **Depends on:** NAV-03, UX-11
- **Acceptance criteria / Verification:** as PAGE-07.
- **Plan, approved 2026-11-25:** one screen a pull request (the review queue and the checks; the findings list and its parts; the
  comparison; the audit page and «حسب الموظف»), each safety nets, then split, then words, then fixes. `complete-record-dialog.tsx`
  (1,577) is left to PAGE-08, whose citizen pages own it. Server paging for the findings list and the checks needs routes that page,
  and stays open, as PAG-03 does.
- **Done 2026-11-25 (the review queue and the checks; stays In Progress):** `review-queue.tsx` split (679 → 310, `quality/review/`);
  their words in `recordReview.*` and `qualityChecks.*`, page snapshots unchanged in both languages; approve, return, draw, assign
  and record each behind an in-flight ref; a failed re-read keeps the list; a decision or check re-reads the officers' figures as
  well; a half-written return or check form survives another record's answer; the sample's days are the municipality's (they were
  UTC); lists on the English page joined with an English comma. **Not done:** tried in a browser, at any width.

## [PAGE-14] Bring the news pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** S · **Category:** UI/UX
- **Files:** `news/**`, `components/admin/news/day-time-fields.tsx` (native `type="time"`, UX-02 / U-8).
- **Depends on:** NAV-05
- **Acceptance criteria / Verification:** as PAGE-07.
- **Done 2026-11-25** (mostly nothing to do: the pass found the news pages already met the contract). Measured against the ten items:
  title = row label ✓ (NAV-10); session and reads through `useStaffSession`/`useStaffQuery` ✓; lists keep their rows on a failed re-read ✓ but said
  nothing, so **the three lists now use `readView` and a `RefreshFailedAlert`**; state in the URL ✓ (`?status=`); every write behind an
  `inFlight` ref set before its state ✓ (now pinned, `lib/dialog-write-guards.test.ts` and `lib/page-14.test.ts`); copy in messages ✓ (the 5
  "inline" hits are locale logic, not strings); no file over 600 lines ✓ (the largest is 429). **Changed:** the articles page's header puts
  «مقال جديد», its one primary action, first in reading order (NAV-05 had put it last), then the two lists. **The native `type="time"` in
  `day-time-fields.tsx` is `TimePicker` now** (U-8, built 2026-11-25, open-decisions §26), which closes the pass.
  **Not done:** the harness; nothing rendered in a browser.

## [PAGE-15] Bring the system pages to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** M · **Category:** UI/UX
- **Files:** `settings/page.tsx` (`loadSession`; `settingsCopy` TXT-1; PAGE-01; numbering section DEAD-12; native file pickers UX-12), `staff/page.tsx` (891; `loadSession`; Arabic warning emoji in the 2FA dialog UX-13), `account/page.tsx` (`SecuritySection` 1,223 lines with `SAMPLE_ROWS` UX-22).
- **Depends on:** PAGE-01, ARCH-18
- **Acceptance criteria / Verification:** as PAGE-07.

## [PAGE-16] Bring the citizen portal to the page contract
- **Priority:** P2 · **Assignee:** Abed · **Estimate:** L · **Category:** UI/UX
- **Files:** `(citizen)/page.tsx`, `my-file/page.tsx` (1,195), `my-file/requests/**`, `payments/**`, `login`, `my-account` (PAGE-02/03/06). Rules differ from staff: no `QueryProvider`, `useToast` or `ActionTooltip` on the citizen side (frontend CLAUDE.md, provider order); sessions through `useCitizenSession`.
- **Problem:** Citizens on phones, many elderly (PRODUCT.md): 360px and slow connections first; SUBMIT-05 for the payment buttons.
- **Depends on:** PAGE-02, SUBMIT-05
- **Acceptance criteria / Verification:** as PAGE-07, staff-only items adapted; `citizen-payments.test.ts` passes.

---

## Found during the sprint

Filled in by whoever executes a task (section 0, step 4). One row per finding; the ID is the next free number in its category.

| ID | Found during | File and symbol | Problem | Fixed in that PR? | Debt doc row added |
|---|---|---|---|---|---|
| ERR-08 | ERR-04 | `apps/backend/src/application/features/citizens/landlord-link.service.ts` `reconcile` (a failed reconcile's block) | A coded `ConflictError`'s `message` is English for the log, and was put in the block's `message`, which the tenant's save shows as a toast | Yes: `reconcileFailedBlock` gives the error's own code as the refusal and the Arabic fallback as `message` | — (fixed) |
| ERR-09 | ERR-04 | `apps/backend/src/application/features/citizens/citizen-merge.plan.ts` `labelOf` | A duplicate flat's `label` in the merge preview falls back to the Arabic words «وحدة» / «منزل» when no code or رقم العقار is known, shown as is on /en/ (the blocks now carry `hasLabel` instead) | No: a preview field, not a refusal; ERR-05's dialog | [code-quality.md](../code-quality.md) Backend |
| ARCH-26 | PAG-02 | `apps/backend/src/infrastructure/repositories/case.repository.ts` `caseWhere` | `status` and `caseType` reach Prisma `as never`: `CaseListFilter` types them as `string`, though the controller narrows both with `optionalOneOf` | No: the repository's create and update cast the same way; one change for the file | [code-quality.md](../code-quality.md) Backend |

---

## Summary

| Category | Count | P0 | P1 | P2 | P3 | Hashem | Abed |
|---|---|---|---|---|---|---|---|
| DRY | 18 | 0 | 1 | 13 | 4 | 11 | 7 |
| God-files | 24 | 0 | 0 | 15 | 9 | 13 | 11 |
| Pagination | 7 | 0 | 1 | 3 | 3 | 5 | 2 |
| Caching | 3 | 0 | 1 | 0 | 2 | 1 | 2 |
| Double-submit | 8 | 0 | 3 | 5 | 0 | 2 | 6 |
| Security | 12 | 0 | 8 | 4 | 0 | 11 | 1 |
| Architecture | 24 | 0 | 2 | 11 | 11 | 20 | 4 |
| UI/UX | 24 | 0 | 1 | 13 | 10 | 0 | 24 |
| Error-handling | 7 | 0 | 1 | 5 | 1 | 2 | 5 |
| Performance | 3 | 0 | 0 | 1 | 2 | 3 | 0 |
| Dead-code | 18 | 0 | 1 | 2 | 15 | 14 | 4 |
| Navigation (UI/UX, §12) | 12 | 0 | 0 | 7 | 5 | 1 | 11 |
| Pages (UI/UX, §12) | 16 | 0 | 1 | 12 | 3 | 0 | 16 |
| **Total** | **176** | **0** | **20** | **91** | **65** | **83** | **93** |

Counted by parsing every task's Priority and Assignee lines (DEAD-16 is split between both and counted under Hashem).
Abed carries more since section 12 is frontend work: Hashem can take the backend halves PAGE-07…16 surface (PAG-02, PAG-04,
PAG-06, DEAD-17) and review every NAV/PAGE PR against the role sets.

No P0: nothing found blocks a user today. 19 tasks wait on a decision (CACHE-02, SEC-04, DEAD-08..13, NAV-02..08, NAV-11,
PAGE-01, PAGE-03, PAGE-05, PAGE-06, and parts of SEC-09 and UX-02). NAV-01 asks for most of them in one sitting.
New findings (not in any debt table): PAG-01, PAG-02, PAG-04, PAG-06, SUBMIT-01..08, SEC-06, the third `id-token` workflow (SEC-09),
ARCH-06, the arrears `APP_CONFIG` import (ARCH-07), the `earnings-registrations`/`house-card-guard` imports (ARCH-09), ARCH-17's wrong row,
ERR-02, ERR-07, DEAD-01, DEAD-07, the News `type="time"` (UX-02), `unit-figures.tsx` (UX-16), the fourth tenant-scope builder (DRY-09);
from section 12: the user-menu/role contradiction (NAV-09), the page titles that differ from their rows (NAV-10), the duplicate staff
screen (PAGE-01), the portal's «حسابي» → phone-code dead end (PAGE-02), the fees header's eight actions (PAGE-04); from the unused-code
scan: `use-section-nav.ts` (DEAD-06), 64 exports referenced nowhere (DEAD-14, -15), 493 needless exports (DEAD-16), four API routes no
screen calls (DEAD-17), and no CI guard against any of it (DEAD-18).

Old debts (arrears) specifically: clean on validation (every body zod, every id `UuidPipe`, roles on every route), zero prose
throws, coded errors and translated copy (one inline `en ?` in `single-line-dialog.tsx`). Found: two more `type Actor` (DRY-01),
6 `actorRole as never` (ARCH-10), an application→presentation `APP_CONFIG` import (ARCH-07), silent truncation at 200/1000 rows (PAG-06),
and its approve/return/discard/link writes guarded only through `ConfirmDialog`'s state (SUBMIT-01).

## Sprint plan

Week 1 is fixes users or data feel; later weeks are structure. Hashem and Abed run in parallel; arrows are dependencies.

**Week 1 — correctness and security (P1)**
- Hashem: ARCH-17 (true numbers first, XS) → PAG-01 → SEC-11 → SEC-08 → CACHE-01 → ARCH-02 → ARCH-01 → SEC-05 → SEC-02 (with Abed's screen) → SEC-10.
- Abed: SUBMIT-01 → UX-01 → SEC-01 → PAGE-02 → SUBMIT-05 → ERR-01 → SUBMIT-02 → DRY-12 → NAV-09.
- Hashem: NAV-01 — walk the proposed sidebar and the page moves with the product owner, together with the
  decisions below, in week 1 so weeks 3–5 can use the answers. Also DEAD-18 early: every later PR then runs the unused-code check.

**Week 2 — the remaining P1 and the foundations other tasks need**
- Hashem: SEC-09 → ARCH-07 → DRY-01 → ARCH-10 → DRY-08 → DRY-07 → SEC-12 → DRY-02 → ARCH-03 → ARCH-04.
- Abed: SUBMIT-03 → SUBMIT-04 → SUBMIT-06 → ERR-02 → ARCH-18 → ARCH-19 → UX-07 → UX-11.

**Week 3 — splits (one PR each, behaviour unchanged)**
- Hashem: GOD-04 → GOD-01 → GOD-02 → GOD-03 (all after ARCH-01) → GOD-05 → GOD-06 → GOD-07 (after ARCH-03) → GOD-08 → GOD-13 (after SEC-03).
- Abed: GOD-14 → GOD-15..18 → GOD-19 → GOD-20 → UX-02 → GOD-24.

**Week 4 — codes, contracts, cleanup**
- Hashem: ARCH-12 → ARCH-13 → ERR-03 → ERR-04 → ARCH-15 → PAG-02 → PAG-06 → SUBMIT-07 (migration PR, merge first) → SUBMIT-08 → DRY-03..06, DRY-09..11 → PERF-01 → DEAD-01..05.
- Abed: ERR-05 (after ERR-04) → PAG-03 (after PAG-02) → UX-03, UX-05, UX-14, UX-15, UX-18..21 → ERR-06 → DRY-13 → DRY-14 → DRY-15.

**Week 5 — navigation and the approved page moves (after NAV-01)**
- Abed: NAV-02 → NAV-03 → NAV-04 → NAV-05 → NAV-06 → NAV-07 → PAGE-01 → PAGE-04 → NAV-10 (last: the label keys are written once).
- Hashem: DEAD-14/15/17 (each deletion grep-checked), DEAD-16 for backend and shared, review of each NAV PR against `canAccessPath`.

**Week 6 and on — page passes (one group per PR, in this order: where staff spend the day first)**
- Abed: PAGE-08 (citizens) → PAGE-11 (fees) → PAGE-09 (buildings) → PAGE-10 (field work) → PAGE-16 (portal) → PAGE-12 (treasury) →
  PAGE-13 (review) → PAGE-07 (landing) → PAGE-15 (system) → PAGE-14 (news). Each pass lands the open tasks it names first.

**Backlog (P3, convert-on-touch is fine):** GOD-09..12, GOD-21..23, ARCH-05, -06, -08, -09, -11, -14, -16, -20..24, UX-04, -06, -08..10, -12, -13, -16, -17, -22..24,
PAG-04/05, PAG-07, CACHE-03, DRY-16..18, PERF-02/03, DEAD-06/07, ERR-07, NAV-08, NAV-11, NAV-12, PAGE-03, PAGE-05, PAGE-06; and every
decision-gated task once its answer is in.

Constraints on order: a migration ships alone to `main` before its code (non-negotiable 5); do not split `fees.service.ts` while
an open treasury or fees PR touches it — check `gh pr list` first; GOD splits rebase badly, so merge each before starting the next in the same file.

## Undecided — needs a product or architecture decision before scoping

| ID | Question | Blocks | Where it is tracked |
|---|---|---|---|
| U-1 | Inline `en ?` copy in 145 files: one i18n sweep, or convert-on-touch? | a TXT-1 sweep task (not written) | ui-ux §17.6 (TXT-1 on #116's files) |
| U-2 | Does PRIM-3 allow `ui/table` for non-registers (documents, editable matrices), or does `DataTable` grow what they need? | UX-09/10 scope | ui-ux §17.1 |
| U-3 | Retire `request-cache.ts`, or keep it for non-React callers? | CACHE-02 | code-quality CQ Frontend; frontend CLAUDE.md |
| U-4 | `tailwind-merge` 3 on Tailwind 3.4: pin 2.6 or extend the config? | (no task written) | code-quality CQ Frontend |
| U-5 | One `--overlay` token and its value; solid warning fills vs COL-2; the status-token contrast failures (§17.3) | UX colour work beyond UX-03 | ui-ux §17.2, §17.3 |
| U-6 | Rate-limit topology: the `trust proxy` hop, Redis throttler store, per-account limits | SEC-04 | security.md Undecided; open-decisions §5 |
| U-7 | Offline PII on field devices: encrypt, clear on sign-out, or accept | (no task written) | security.md Undecided |
| U-8 | A time primitive (CTL-2): build one or extend `DatePicker` (**decided 2026-11-25: build one**, `TimePicker`, open-decisions §26) | UX-02's time inputs | ui-ux §3.1 CTL-2 |
| U-9 | When to delete the Supabase adapters | DEAD-08 | code-quality CQ Backend |
| U-10 | Retire the Vercel runtime; does `InternalCronController` stay? | DEAD-09 | code-quality CQ Backend |
| U-11 | Rebuild or delete `BackupController`/`BackupService` | DEAD-10, DEAD-06 (`backup-section.tsx`) | code-quality CQ Backend |
| U-12 | Require CI + audit before a production deploy, and an approval on the deploy job | SEC-09 (gating part) | security.md Undecided |
| U-13 | Delete `dump-tenant.js` and `reset-2fa.ts`, or rebuild behind the target guard | DEAD-11 | security.md Undecided; memory: Abed PR review 2026-11-20 |
| U-14 | Retire `numberingSequences` and «تسلسل الترقيم», or wire them to the books | DEAD-12 | security.md gaps; code-quality |
| U-15 | Keep or remove the accent system | DEAD-13 | code-quality CQ Frontend |
| U-16 | SUPER_ADMIN TOTP mandatory or officially optional | the High SEC gap (no task written) | security.md Undecided |
| U-17 | `exportCsv` carrying `reference_number`; `reissue-references` printing credentials | the High/Medium SEC gaps | security.md Undecided |
| U-18 | A collector's Whish entry: finance confirmation or reconcile with the provider | the Medium SEC gap | open-decisions §22.1 |
| U-19 | Old debts: fee types on the template, prescription start, maker ≠ checker, entering the books' totals per year (no route takes them), bulk write-off | arrears follow-ups (none written: product first) | open-decisions §23.1–23.5 |
| U-20 | Whether a duplicate unit visit is paid to the officer (decides SUBMIT-07/08's priority) | SUBMIT-07, SUBMIT-08 | not tracked — **NEW question** |
| U-21 | Retire the portal's phone-code sign-in and «حسابي», now that «ملفّي» and the reference sign-in cover them | PAGE-03 | open-decisions §2 (OTP not used), §21 |
| U-22 | Is «سجل العمليات» a view of «الرسوم والمدفوعات» or its own row (its roles are wider) | PAGE-05 | **NEW question** |
| U-23 | Keep «مدفوعاتي» and its own sign-in beside «ملفّي» and the front door | PAGE-06 | open-decisions §21 |
| U-24 | The target sidebar: 35 → 26 rows (section 12), the two review-queue names, where «المستحق على عقار» lives | NAV-01…08, NAV-11, PAGE-01 | **Decided 2026-11-25**: [open-decisions §25](../open-decisions.md#25-the-staff-sidebar-and-the-page-moves-decided-2026-11-25); PRODUCT.md as each move lands |
| U-25 | The dashboard redesign `KpiCard` waits on | PAGE-07 (part) | ui-ux §17.1 |
| U-26 | Delete the four routes no screen calls, or build the screens (an expense category cannot be edited anywhere today) | DEAD-17 | **NEW question** |

---

## Appendix: verification output (run 2026-11-23)

```
### 1. wc -l god files
   6167 apps/backend/src/application/features/fees/fees.service.ts
   5896 apps/backend/src/application/features/buildings/buildings.service.ts
   3633 apps/backend/src/application/features/citizens/landlord-link.service.ts
   3569 apps/backend/src/application/features/citizens/citizens.service.ts
   2291 apps/backend/src/application/features/reporting/reporting.service.ts
   1782 apps/backend/src/application/features/citizens/citizen-merge.service.ts
    800 apps/backend/src/presentation/controllers/citizen.controller.ts
   7815 apps/frontend/lib/api-client.ts
   3700 apps/frontend/components/admin/building-editor.tsx
   3418 apps/frontend/components/admin/building-unit-forms.tsx
   2607 apps/frontend/components/admin/citizen-form.tsx
   2524 apps/frontend/components/admin/fullscreen-map.tsx
   2366 apps/frontend/components/admin/citizen-editor.tsx
   2017 apps/frontend/app/[tenant]/[locale]/[adminPath]/(protected)/citizens/[citizenId]/page.tsx
frontend .tsx over 600 (app + components): 49

### 2. as never / as unknown as (non-spec)        455
### 3. new Conflict/Validation/NotFoundError       656
      (this grep counts coded throws too; the ratchet's own regex — first argument not an object literal — gives 199,
       equal to LEGACY_PROSE_THROWS = 199; buildings.service.ts 59, identity 19, staff 19, record-review 12, …)
### 4. process.env reads                           108   (29 non-spec: 13 in scripts/, 3 sentry.ts pre-DI, 13 to fix — SEC-12)
### 5. toISOString…slice in apps/frontend           11   (8 UTC "today" — UX-01; audit-daily.tsx correct; 2 backup file-name stamps)
### 6. Tasks                                       176   (Hashem 83, Abed 93)
```

Other counts used above: bare `.$transaction(` in non-spec backend code: 30 sites in 17 files (fees 6, buildings 5, citizens 3,
staff-refresh-token repo 2, payment-ledger 2, 3 treasury snapshot reads, 4 scripts, 4 repositories/backup, `tenant-transaction.ts` itself).
Write callers without a ref guard: 34 of 95 files. Event names: 20 emitted, all with listeners.

Unused-code scan (added 2026-11-23, after the first pass): 1,048 files; 12 files with no importer (3 false positives,
3 test helpers); 557 exports with no reader outside their file, 64 of them with no reader anywhere
(backend 7, frontend 20, shared 37) and 493 used only inside their own file (backend 189, frontend 174, shared 130).
Lists: `unused-exports-2026-11-23.txt`, `unimported-files-2026-11-23.txt` beside this file.
Navigation: `NAV_GROUPS` 35 rows (`grep -c "path: '/" components/admin/nav.ts` minus the type line), 81 staff routes,
8 portal routes.
