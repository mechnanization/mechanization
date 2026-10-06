# Code quality

Last verified against the code: `fix/pr88-review` (on `develop@be4f053`), 2026-10-06.

Two parts: the code-pattern rules every change follows, and the debt the code carries today. The debt
is not a precedent. **Fix an item when you touch its file, and remove its row in the same change.** Add a
row when you find new debt. What "done" means is in [CLAUDE.md](../CLAUDE.md#definition-of-done); it is
not repeated here. Security gaps live in [docs/security.md](security.md#known-gaps), UI-rule deviations
in [docs/ui-ux-standards.md](ui-ux-standards.md) §17.

## Rules

1. **Write once.** Enums, zod schemas, limits and labels shared by both apps live in
   `packages/shared-schemas`, and every consumer imports them from `@mechanization/shared-schemas`.
   Enum labels come from `getLabels()`. A backend copy of a shared enum (in `src/domain/entities`) MUST
   be covered by `domain-enum-drift.spec.ts`.
2. **No hard-coded values.** URLs and secrets come from validated config (`envSchema` in the backend).
   Limits, TTLs, timeouts and other policy numbers are named constants in one place (`APP_CONFIG` in the
   backend). Colours and sizes are tokens ([docs/ui-ux-standards.md](ui-ux-standards.md) §4). User-facing
   strings are next-intl messages in `apps/frontend/messages/ar.json` and `apps/frontend/messages/en.json`;
   inline `en ? … : …`, `settingsCopy` and the nav `labelEn` fields are legacy, converted when you touch
   the file. Do not repeat a schema default as `?? N` at the call site.
3. **No duplication.** Search before you write a helper (grep, or `graphify query`). One helper has one
   home: cross-app pure logic in `packages/shared-schemas`, backend helpers in `application/common`,
   frontend helpers in `apps/frontend/lib`. A second copy means moving the first one, not pasting.
4. **Errors are typed and domain-level, and mapped to transport in one place.** The backend throws
   `DomainError` subclasses with a stable case code and maps them only in `DomainExceptionFilter`
   ([apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#error-codes)). A Prisma error code becomes a domain
   error at the write that raises it, in the repository or, under D-data, the service, matched on
   `error.code` ([docs/database.md](database.md#constraints-live-in-the-database)). The frontend maps
   codes to ar/en text; the server message is a fallback.
5. **Multi-step writes run in one transaction** (`runInTenantTransaction`), with side effects after
   commit ([apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#transactions)).
6. **Uniqueness is enforced by the database** (a unique constraint or index) and surfaces as a
   `ConflictError` with a case code. A check-then-insert alone is a race.
7. **No type escapes.** MUST NOT silence the compiler with `as never` or `as unknown as`. Type enum
   values against the generated `$Enums` or the shared enums.
8. **Small units.** Pure decision logic goes in a plan or helper module with its own spec
   (`unit-correction.plan.ts`, `unit-status.ts`); a frontend page over about 600 lines is split (CODE-6).
9. **Comments match the code.** A comment that contradicts the code, or one left above the wrong
   symbol, is a bug (CODE-7). Fix it in the change that makes it wrong.
10. **Dead code is deleted**, unless a tracked decision keeps it. Git history keeps the rest.
11. **A missing UI primitive** is hand-ported from shadcn/ui on the matching Radix package into
    `apps/frontend/components/ui`, with no shadcn components.json file and no shadcn CLI. Details are in
    [docs/ui-ux-standards.md](ui-ux-standards.md).
12. **A check fails only for the right reason.** A test MUST NOT fail for a correct implementation: no
    assertion that random values never collide, no dependence on the clock or on run order. A guard
    (an env rule, a boot check) MUST be able to fail only when the thing it protects is broken; one that
    can only stop a working system is removed, not kept as coverage. Incidents 6 and 7 in
    [docs/incidents.md](incidents.md).

## Debt

### Backend

| Location (path + symbol) | Problem | Correct replacement |
|---|---|---|
| `buildings.service.ts` (5,415 lines), `landlord-link.service.ts` (3,590), `fees.service.ts` (3,432), `citizens.service.ts` (3,321), `reporting.service.ts` (1,855), `citizen-merge.service.ts` (1,550), `citizen.controller.ts` (786) | God files | Split into plan and helper modules with their own specs, as `unit-correction.plan.ts` did |
| `FeesService`, `CitizensService`, `PaymentLedgerService`, `RecordReviewService`, `BuildingsService` (incl. `atomic`), `BackupService`, `PrismaRegistrationRepository`, `PrismaDocumentRepository`, `PrismaParcelRepository` | Bare `$transaction`: no scope swap, no after-commit queue, and it throws inside an enclosing `runInTenantTransaction` (`atomic` duck-types around this) | `runInTenantTransaction` |
| `BuildingsService` `atomic` (15 s / 30 s), `BackupService` (15 s / 120 s), `runInTenantTransaction` defaults (15 s / 60 s) | Transaction timeouts hard-coded three ways | Named constants in `APP_CONFIG` |
| Every `this.events.emit('…')` | Event names are free strings with payloads re-declared per listener; a typo is dropped silently | Typed event-name constants and payload types in one module |
| `type Actor` in `ownership.service.ts`, `tenancy.service.ts`, `unit-correction.service.ts`, `record-review.service.ts`, `scripts/seed-census.ts`; `{ id: user.sub, role: user.role ?? '' }` 34 times in controllers | One shape declared five times and built inline everywhere | One exported actor type in `application/common` and a parameter decorator that builds it |
| 342 `as never` / `as unknown as` in non-spec backend code (comments excluded), 70 in `buildings.service.ts` | A mistyped enum value still compiles | Type values against `$Enums` |
| `AppModule` `ThrottlerModule.forRoot` (`ttl: 60_000, limit: 120`); `FeesService` summary cache TTL literal `30`; `SETTINGS_CACHE_TTL_SECONDS`; `TOKEN_VERSION_TTL_SECONDS`; `UnitCorrectionService.applyLocked` `lock_timeout`; the `1mb` body limit in `createApiApp`; `AuditController` `DEFAULT_TIME_ZONE`; `SmtpEmailSender` port `?? 587` | Policy numbers scattered as literals | `APP_CONFIG` (`throttle`, cache TTLs, timeouts) or `envSchema` defaults |
| `RedisCacheService.get` (L1 refill `now + 30_000`) | An L2 hit is cached locally for 30 s even when the key's own TTL is shorter (audit is 20 s) | Use the remaining TTL |
| `AuditService` `?? 20`, `DataQualityService` / `RecordReviewService` `?? 180`, `ReportingService` `?? 60`, `TenantService` `?? 300`, `main.ts` `?? 4000` | Schema defaults repeated at the call site; the two can drift | Read the validated value; the default lives only in `envSchema` |
| `BuildingsService.create` and `ParcelCorrectionService` | The advisory-lock key `<schema>:building-suffix:<parcel>` is built twice and must match character for character | One exported key builder used by both |
| `CitizenController` (`Number(limit) \|\| 200`, `Number(limit ?? 20)`), `AuditController`, `BuildingsController`, `FeesController` | Pagination parsed and clamped differently per controller, unclamped in some | One page-parsing helper in `presentation/controllers/query-params.ts` with a default and a max |
| `OtpService`, `DocumentService` import `APP_CONFIG` from `presentation/config/app.config.ts` | Application imports presentation | Move `APP_CONFIG` out of presentation (for example into `application/common`) |
| `registration.repository.ts` imports `normalizeSearchText` from `application/common/search-terms` | Infrastructure imports application | Move the search-term helpers to domain or `packages/shared-schemas` |
| `ZonesService` → `CadastreAssetsService`; `CadastreImportService` → `buildCadastreGeometryAssets` | Application imports infrastructure outside the allowed entry points | Move `CadastreAssetsService` (it only wraps a port) into application, and the pure geometry into domain or application |
| `ParcelCorrectionService` (inline `P2002`), `UnitCorrectionService` (`P2034` predicate), `PrismaUserRepository.translate`, `PrismaRegistrationRepository.translate` | Each place matches Prisma error codes its own way; there is no shared helper | One unique-violation and serialisation helper in `infrastructure/prisma`, beside `isTransientConnectionError`, added to the application's allowed infrastructure imports ([apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#layers-and-the-dependency-rule)) |
| `PrismaUserRepository` `translate` fallback | Any other unique violation reads «هذه الوثيقة مسجّلة مسبقاً لشخص آخر» | A generic «هذه البيانات مسجّلة مسبقاً», as `PrismaRegistrationRepository` does |
| `PrismaUserRepository` `hideStaff`, `setStaffActive`, `restoreStaff`, `updateStaff` | `where: { id }` only; the STAFF check lives in `StaffService` before the call (check-then-act) | `where: { id, kind: 'STAFF' }` |
| `OtpService` reads `process.env.NODE_ENV`; `APP_CONFIG.publicApiUrl` / `publicPortalUrl` read `process.env` at import; `WhishGatewayService` reads undeclared `WHISH_*` | Config bypasses `envSchema` | `ConfigService` and declared variables; only pre-DI code (`isSchedulerEnabled`, `initSentry`) reads `process.env` |
| 206 prose throws (`new ConflictError('نص')`), counted by `error-codes.ratchet.spec.ts` | The server writes the words, so `/en/` shows Arabic, and the block-driven ones (`plan.block.message`, `blockerMessage`, `blocks[0].message`) also render in previews | A code from `ERROR_CODES` with `errors.<CODE>` in both message files; lower the ratchet constant ([apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#error-codes)) |
| `TenantMiddleware`, `OtpCleanupJob`, `RecurringBillingJob` | The tenant scope is built by hand in three places | One helper that runs a function as a tenant |
| `APP_CONFIG.tenantRoutePattern`, `APP_CONFIG.throttle.submission`, `OtpService.pruneExpired` | No readers or callers | Delete |
| `SUPABASE_AUTH_SERVICE`, `domain/interfaces/supabase-auth.interface.ts`, `infrastructure/supabase/auth/supabase-auth.service.ts`, `infrastructure/supabase/storage/supabase-storage.service.ts`, `CadastreStorageService` (`infrastructure/cadastre/cadastre-storage.service.ts`), `@supabase/supabase-js`, `SUPABASE_*` | Unbound Supabase adapters kept after the cutover | Delete (**Undecided:** when; the `envSchema` comment waits for the cutover to be watched) |
| `presentation/serverless.ts`, `apps/backend/api/index.js`, `apps/backend/vercel.json`, `apps/backend/public/index.html`, the `!VERCEL` default in `isSchedulerEnabled` | Vercel runtime the API no longer uses | **Undecided:** retire, and decide whether `InternalCronController` stays |
| `BackupController` (unregistered), `BackupService` | Kept for a rebuild; restore aborts once a tenant has ledger rows | **Undecided:** rebuild or delete |
| `test:e2e` script; `apps/backend/tsconfig.json` `paths` `@shared/*` | Points at a missing directory; an alias nothing imports | Delete, or build an HTTP suite (supertest is installed) |
| `InfrastructureModule` docblock ("the only module that knows Prisma"), `AppModule` scheduler comment (Vercel Cron), `envSchema` SMTP message ("through Supabase"), `IdentityService` `challengeTotp` comment ("one-step window"), `createApiApp` docblock ("two ways this API runs"), `User.requiresTotp` docblock | Comments that contradict the code | Rewrite to match the code |

### Frontend (code-level)

| Location (path + symbol) | Problem | Correct replacement |
|---|---|---|
| `apps/frontend/lib/api-client.ts` (5,782 lines) | One file for every feature's client | Split per feature under `apps/frontend/lib`, keeping `apiFetch` shared |
| 40 `.tsx` files over 600 lines, led by `building-unit-forms.tsx` (3,376), `building-editor.tsx` (3,288), `citizen-form.tsx` (2,582), `fullscreen-map.tsx` (2,489), `citizen-editor.tsx` (2,310) | God components (CODE-6) | Split into `components/admin/<feature>/*` pieces with one job each, as `components/admin/cases/` did |
| `process.env.NEXT_PUBLIC_API_URL` read in 10 files; `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` in `fullscreen-map.tsx`, `parcel-pin-picker.tsx`, `zone-editor-map.tsx` | Config and fallback repeated | One validated config module in `apps/frontend/lib` |
| `TenantLayout` `getTenant`, `ProtectedAdminLayout` `getTenantName`, the citizen layout's `getTenant` | The tenant config fetch exists three times | One server-side helper |
| `bill-type-select.tsx` `normalizeArabic` | Local copy of a shared helper | Import `normalizeArabic` from `@mechanization/shared-schemas` |
| `new Date().toISOString().slice(0, 10)`, 8 times in 7 files (`building-unit-forms.tsx` 2, `end-ownership-dialog.tsx`, `end-tenancy-dialog.tsx`, `residence-change-dialog.tsx`, buildings `page.tsx`, `map-export-dialog.tsx`, `quality/checks-panel.tsx` `isoDaysAgo`); `audit-daily.tsx` subtracts the offset first and is correct | A UTC date: between 00:00 and 03:00 Beirut time it is yesterday | `municipalToday` from `@mechanization/shared-schemas`, as the damage form (`lib/damage-reading.ts` `today`) does |
| `apps/frontend/lib/request-cache.ts` beside TanStack Query | Two client caches | **Undecided:** retire `request-cache.ts` or keep it for non-React callers |
| Role lists typed in screens: `citizens/page.tsx` `CAN_WRITE`, `citizens/[citizenId]/page.tsx` `canEdit` / `canManage`, `citizen-editor.tsx` (the bounce for roles that cannot edit, which also keeps collectors from the form's owner-link controls), `citizens/[citizenId]/properties/page.tsx` `EDIT_ROLES`, `fees/corrections/page.tsx` `canReview`, `citizens/landlord-links/page.tsx` `SUMMARY_ROLES`, `quality/findings-list.tsx` `CITIZEN_EDIT_ROLES`, `fees/page.tsx` (the «فواتير تأثّرت بتصحيحات» link, a copy of `PAYMENT_REVIEW_READ_ROLES`), `activity-trail.tsx` `fullTrail` (a copy of `AUDIT_READ_ROLES`), and the «تسجيل مواطن جديد» and «سجل العمليات» rows of `nav.ts` | Copies of the server's sets that drift: the register screens' write list leaves out `COLLECTOR`, which the routes (`REGISTER_WRITE_ROLES`) admit | An allow-list in `apps/frontend/lib/staff-roles.ts` built from the shared set the route uses; check each against its controller before changing who sees a button |
| `enabledPropertyTypes: ['BUILDING', 'HOUSE', 'LAND', 'TENT']` in the `api-client.ts` offline fallback | Hard-coded copy of a shared enum | Derive it from the shared enum |
| `middleware.ts` `DEFAULT_LOCALE = 'ar'` against `i18n/routing.ts` `defaultLocale = 'en'` | Two default locales | One constant, from `i18n/routing.ts` |
| `tailwind-merge` 3 in `apps/frontend/package.json` with Tailwind 3.4 | tailwind-merge 3 targets Tailwind 4, so `cn` resolves some conflicts wrongly | **Undecided:** pin tailwind-merge 2.6, or extend its config |
| `public/sw.js` `VERSION` | Bumped by hand | Stamp it at build time |
| `confirm-cash-payment-dialog.tsx`, `components/admin/workflow.tsx`, `components/admin/settings/backup-section.tsx`; `ACCENTS` (one entry), `AccentProvider` `setAccent` (a no-op) | No importers, or a feature with nothing behind it | Delete (**Undecided** for the accent system) |
| `csvCell` in `reporting.service.ts` and `apps/frontend/lib/csv.ts`; `sentry-redaction.ts` in both apps, the frontend copy untested | The same security helper written twice | One shared implementation with one spec |
| The doc block above `exchangeStaffToken` (`api-client.ts`), the `DB_VERSION` comment (`offline-db.ts`), the `theme-toggle.tsx` claim that no `DropdownMenu` exists, the `tailwind.config.ts` header, the "tokens live in localStorage" comments in `middleware.ts` and `next.config.mjs` | Comments that contradict the code | Rewrite to match the code |

UI-rule deviations (local stat tiles, hand-rolled pagers, red banners, copied `loadSession` effects,
palette classes, native date inputs, and the legacy copy mechanisms: inline `en ? … : …`, `settingsCopy`,
nav `labelEn`, under TXT-1) are tracked in [docs/ui-ux-standards.md](ui-ux-standards.md) §17.

### Data and scripts

| Location (path + symbol) | Problem | Correct replacement |
|---|---|---|
| `TenantPrismaFactory` `SAFE_SCHEMA_NAME`, `tenant-migrator.ts` inline regex, `tenant-schema-ref.ts` `SAFE_SCHEMA_NAME` (looser), `dump-tenant.js`; `provision.mjs` builds `tenant_<slug>` without `TenantSlug` | Schema-name validation in four copies with three patterns | One exported validator, used everywhere |
| `C` and `withClient` in `deploy.mjs` and `provision.mjs`; `fail` in `backup.mjs` and `verify-restore.mjs` | Script helpers copied | One shared module in `scripts/db` |
| `provision.mjs` `inspect` (`.catch(() => ({ rows: [] }))`) | Turns "unreadable" into "absent", the pattern `migration-state.mjs` says was removed from `deploy.mjs` | Let the reads throw |
| `migrate-all-tenants.ts` | Interpolates `MIGRATION_LOCK_TIMEOUT` and `MIGRATION_STATEMENT_TIMEOUT` into `SET` statements | `set_config` with bound parameters |
| `BuildingsService`, `ParcelCorrectionService` advisory locks | `$executeRawUnsafe` for a call that needs no dynamic SQL | Tagged `$executeRaw` |
| `create-staff.ts`, `reissue-references.ts`, `import-parcels.ts`, `backfill-buildings.ts`, `backfill-parcel-boundaries.ts`, `provision-tenant.ts` | Read `DIRECT_URL ?? DATABASE_URL` with no target check | Pin the target as `seed.ts` `localDatabaseUrl` does, or route through `resolveTarget` |
| `scripts/db/provision.mjs` | The guarded provisioner has no package script, so the docs point at the unguarded `tenant:provision` | Wire `db:provision:<target>` scripts |
| `scripts/db/setup-claude-ro.sql` | Double-encoded UTF-8 (mojibake), hard-codes `tenant_albazourieh`, `SELECT *` views | Re-encode, generate per tenant, column allowlists ([docs/security.md](security.md#known-gaps)) |
| `tenant-schema-ref.ts`, `TenantPrismaFactory` `connectionUrlFor`, `tenant-test-client.ts`, `envSchema` `DATABASE_URL`; both `schema.prisma` `binaryTargets` comments; the `TenantSlug` comment naming `schemaNameFor()` | Comments cite the Supabase pooler, the Vercel runtime and a renamed method | Rewrite (the rules they state are still right) |

### CI and tooling

| Location (path + symbol) | Problem | Correct replacement |
|---|---|---|
| Root `package.json` `engines` (`>=20`), both Dockerfiles (`node:20-alpine`), `ci.yml` and `migrate-database.yml` (22), `deploy-backend.yml` (24) | Node declared four ways across three majors | One version file read by engines, CI, deploy and the images |
| `pnpm-workspace.yaml` `overrides` and `package.json` `pnpm.overrides` | Identical today; nothing enforces it | A test or CI step that compares them |
| `deploy-backend.yml` and `deploy-production.yml` `id-token: write` with an "OIDC" comment | The backup uses access keys now; the grant is unneeded | Drop the grant and fix the comment |
| `ci.yml` comments ("Nothing in CI connects to a database", "which Supabase project") | Contradicted by the Postgres service in the same file | Rewrite |
| `apps/backend/nest-cli.json` `deleteOutDir: false` | A deleted source file's output stays in a local `dist` | `deleteOutDir: true`, unless something depends on the old output |
| `dummyfile.txt` (tracked); `bazoreyye.kmz` tracked at the root and in `apps/backend/data` | Stray and duplicate files | Delete the root copies (the seed uses `apps/backend/data`) |
| `packages/shared-schemas` | No tests of its own | A test script and specs for the schemas with logic |
| tenant `schema.prisma` against the SQL migrations | Nothing checks that they match | A CI diff of the migrations against the schema (**Unverified:** the exact Prisma command) |
| `deploy-backend.yml`, `.dockerignore` | Deploy not gated on CI; `.env` excluded only at the root | See [docs/security.md](security.md#known-gaps) |
