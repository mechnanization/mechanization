# Graph Report - mechanization-1  (2026-09-13)

## Corpus Check
- 476 files · ~632,574 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3829 nodes · 9273 edges · 267 communities (192 shown, 75 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 205 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1d8c77ec`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- backup-section.tsx
- api-client.ts
- logApiError
- Tenant
- BuildingsService
- fullscreen-map.tsx
- button.tsx
- PropertyEntry
- ValidationError
- cn
- case-editor.tsx
- [citizenId]/page.tsx
- exceptions/index.ts
- TenantContextService
- SessionClaims
- otp-repository.interface.ts
- parcel-geometry.ts
- CitizensService
- presentation.module.ts
- ZonesService
- fee.schema.ts
- enums.ts
- application.module.ts
- admin-citizen.schema.ts
- building-unit-forms.tsx
- document.service.ts
- infrastructure.module.ts
- IdentityService
- building.schema.ts
- dependencies
- devDependencies
- CasesService
- admin-shell.tsx
- "users"
- app.module.ts
- citizen-editor.tsx
- reporting.service.ts
- StaffService
- Roles
- building-editor.tsx
- offline-sync.ts
- citizen-import.schema.ts
- targets.mjs
- audit.repository.ts
- CurrentUser
- [locale]/layout.tsx
- compilerOptions
- PaymentLedgerService
- CitizenForm
- RedisCacheService
- parcel.repository.ts
- property.schema.ts
- citizen-form.tsx
- case.schema.ts
- citizen.schema.ts
- withConnectionRetry
- auth.schema.ts
- BackupSection
- scripts
- scripts
- SupabaseAuthService
- dependencies
- devDependencies
- compilerOptions
- citizens.service.ts
- User
- deploy.mjs
- Open decisions register
- offline-db.ts
- Database environments runbook
- PrismaUserRepository
- sw.js
- compilerOptions
- fees.service.ts
- csv.ts
- OtpService
- UserRepository
- shared-schemas/package.json
- sync-production-tenant.mjs
- .update
- numbering.ts
- backend/vercel.json
- charts.tsx
- devDependencies
- tenant-context.service.ts
- staff.schema.ts
- start.mjs
- DocumentService
- .import
- ZonesController
- (citizen)/page.tsx
- scripts
- overrides
- landlord-link.service.ts
- zone.schema.ts
- nest-cli.json
- sync-supabase-templates.mjs
- citizen-draft.ts
- package.json
- shared-schemas/tsconfig.json
- dump-tenant.js
- buildings.service.ts
- TenantController
- date-picker.tsx
- raw-sql-is-schema-qualified.spec.ts
- AuditController
- HealthController
- routing.ts
- middleware.ts
- next.config.mjs
- frontend/vercel.json
- backend/package.json
- census-link.spec.ts
- citizen-import.spec.ts
- citizen-review-dialog.tsx
- app/layout.tsx
- route.ts
- .mcp.json
- CI dependency audit job
- index.js
- @nestjs/core
- @nestjs/schedule
- @nestjs/throttler
- rxjs
- @nestjs/testing
- ts-jest
- @types/express
- registry/migrations/0001_init/migration.sql
- 0002_parcels/migration.sql
- 0006_zones/migration.sql
- next-env.d.ts
- class-variance-authority
- mapbox-gl
- @mechanization/shared-schemas
- next
- next-intl
- next-themes
- qrcode.react
- @radix-ui/react-dialog
- @radix-ui/react-label
- @radix-ui/react-tooltip
- react
- react-dom
- @tanstack/react-query
- zod
- build-check.mjs
- tailwind.config.ts
- AuditService
- registration.repository.ts
- zone-editor-map.tsx
- payment-receipt.tsx
- Supabase
- LandlordLinkService
- Changelog
- damage.service.ts
- CadastreStorageService
- SupabaseStorageService
- Changelog
- Writing Guidelines for Postgres References
- .recordOccupancy
- .revertUnits
- TotpService
- property-entry.entity.ts
- user.repository.ts
- DashboardController
- map-geometry.ts
- .reconcileRegistration
- bootstrap.ts
- backfill-buildings.ts
- Section Definitions
- .list
- create-staff.ts
- parcel-pin-picker.tsx
- building-draft.ts
- provision.mjs
- CensusSyncService
- Document
- RegistrationController
- AppLogger
- occupancy-end.spec.ts
- Supabase Postgres Best Practices
- db-staging / db-production GitHub Environments
- census-release.spec.ts
- staff-login.spec.ts
- .restore
- advanced-full-text-search.md
- advanced-jsonb-indexing.md
- conn-idle-timeout.md
- conn-limits.md
- conn-pooling.md
- conn-prepared-statements.md
- data-batch-inserts.md
- data-n-plus-one.md
- data-pagination.md
- data-upsert.md
- lock-advisory.md
- lock-deadlock-prevention.md
- lock-short-transactions.md
- lock-skip-locked.md
- monitor-explain-analyze.md
- monitor-pg-stat-statements.md
- monitor-vacuum-analyze.md
- query-composite-indexes.md
- query-covering-indexes.md
- query-index-types.md
- query-missing-indexes.md
- query-partial-indexes.md
- schema-constraints.md
- schema-data-types.md
- schema-foreign-key-indexes.md
- schema-lowercase-identifiers.md
- schema-partitioning.md
- schema-primary-keys.md
- security-privileges.md
- security-rls-basics.md
- security-rls-performance.md
- _template.md

## God Nodes (most connected - your core abstractions)
1. `cn()` - 219 edges
2. `logApiError()` - 92 edges
3. `Roles()` - 91 edges
4. `SessionClaims` - 76 edges
5. `Button` - 73 edges
6. `CurrentUser` - 69 edges
7. `apiFetch()` - 66 edges
8. `TenantContextService` - 65 edges
9. `loadSession()` - 61 edges
10. `BuildingsService` - 53 edges

## Surprising Connections (you probably didn't know these)
- `flagsFromArray()` --indirect_call--> `isUnestablished()`  [INFERRED]
  apps/frontend/components/ui/field.tsx → packages/shared-schemas/src/field-flag.schema.ts
- `Supabase change-email confirmation template` --conceptually_related_to--> `Modern Civic Ledger design language`  [AMBIGUOUS]
  supabase/templates/change-email-address.html → DESIGN.md
- `Offline fallback page` --conceptually_related_to--> `Offline provisional suffix allocation under advisory lock`  [INFERRED]
  apps/frontend/public/offline.html → docs/building-census-plan.md
- `SUPER_ADMIN TOTP enrolment requirement` --references--> `RBAC roles (SUPER_ADMIN, ADMIN, COLLECTOR, CITIZEN)`  [INFERRED]
  README.md → PRODUCT.md
- `reissue-references command (citizen reference rotation)` --conceptually_related_to--> `Whish Money digital payments and official receipts`  [INFERRED]
  README.md → PRODUCT.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Building census data model (D1-D4)** — docs_building_census_plan_building, docs_building_census_plan_unit, docs_building_census_plan_unitoccupancy, docs_building_census_plan_damageassessment, docs_building_census_plan_building_lifecycle [EXTRACTED 1.00]
- **Production migration safety gates** — _github_workflows_deploy_production_migrate, docs_database_environments_db_github_environments, scripts_db_targets, docs_database_environments_promotion_check, docs_database_environments_destructive_ddl_scanner [EXTRACTED 1.00]
- **Census occupancy to billing flow** — docs_building_census_plan_census_sync_service, docs_building_census_plan_unitoccupancy, docs_building_census_plan_held_through_occupancy, docs_open_decisions_landlord_link, docs_open_decisions_fee_bearer [INFERRED 0.85]

## Communities (267 total, 75 thin omitted)

### Community 0 - "backup-section.tsx"
Cohesion: 0.05
Nodes (81): SectionDef, SectionId, SECTIONS, SettingsPage(), ArchiveInspection, DEFAULT_SCHEDULE, EMPTY_HISTORY, Frequency (+73 more)

### Community 1 - "api-client.ts"
Cohesion: 0.04
Nodes (94): getTableLabels(), StaffPage(), ZonesPage(), CitizenLogin(), send(), verify(), PaymentsLogin(), submit() (+86 more)

### Community 2 - "logApiError"
Cohesion: 0.04
Nodes (124): AccountSecurityPage(), AuditTrailPage(), ENTITY_TYPES, BuildingsPage(), DAMAGED_LEVELS, FilterSelect(), getTableLabels(), MetricCard() (+116 more)

### Community 3 - "Tenant"
Cohesion: 0.07
Nodes (15): PublicTenantConfig, PROPS, TenantService, Inject, Injectable, PropertyType, Tenant, TenantConfig (+7 more)

### Community 4 - "BuildingsService"
Cohesion: 0.20
Nodes (6): UnitRow, BuildingsService, toOccupancyRow(), toUnitRow(), Injectable, toVacancyRow()

### Community 5 - "fullscreen-map.tsx"
Cohesion: 0.09
Nodes (39): FullscreenMap, BUILDING_LAYER, BUILDING_SOURCE, BUILDING_ZOOM, buildingLegend(), buildingsGeoJson(), DAMAGE_COLORS, DAMAGE_SEVERITY (+31 more)

### Community 6 - "button.tsx"
Cohesion: 0.07
Nodes (56): StaffLogin(), submit(), parseAuthHash(), ParsedLink, ResetPasswordPage(), submit(), Stage, ChargeCitizenDialog() (+48 more)

### Community 7 - "PropertyEntry"
Cohesion: 0.11
Nodes (4): AggregateRoot, DomainEvent, PropertyEntry, Registration

### Community 8 - "ValidationError"
Cohesion: 0.09
Nodes (15): ValidationError, ReferenceNumber, TenantSlug, Args, backfillParcelBoundaries(), boundariesFrom(), Args, reissueReferences() (+7 more)

### Community 9 - "cn"
Cohesion: 0.06
Nodes (45): count(), DEFAULT_FOLDED, DetailRow(), FoldSection(), KPI_TONES, KpiCard(), moneyAxis(), monthLabels() (+37 more)

### Community 10 - "case-editor.tsx"
Cohesion: 0.13
Nodes (16): LandlordLinksPage(), CaseEditor(), CaseFormValues, EMPTY, ComparisonSide(), LandlordProposalCard(), LandlordProposalResolved(), EmptyState() (+8 more)

### Community 11 - "[citizenId]/page.tsx"
Cohesion: 0.07
Nodes (38): CitizenProfilePage(), FactItem, FactSection(), householdFacts(), legacyDocumentHint(), ownerBilledHint(), PAYMENT_TONE, present() (+30 more)

### Community 12 - "exceptions/index.ts"
Cohesion: 0.12
Nodes (16): actor, harness(), HarnessOptions, tenantCard(), LedgerEntryInput, SettledTotals, ConflictError, DomainError (+8 more)

### Community 13 - "TenantContextService"
Cohesion: 0.08
Nodes (15): BackupService, NEVER_RESTORED, RestoreReport, sanitizeRowForSnapshot(), Snapshot, SnapshotManifest, TABLE_ORDER, TableName (+7 more)

### Community 14 - "SessionClaims"
Cohesion: 0.15
Nodes (11): SessionClaims, FeesController, Body, Controller, Get, Param, Patch, Post (+3 more)

### Community 15 - "otp-repository.interface.ts"
Cohesion: 0.07
Nodes (13): OtpIssueResult, Inject, OtpChallengeRow, OtpChannel, OtpRepository, PasswordHasher, SmsSender, PrismaOtpRepository (+5 more)

### Community 16 - "parcel-geometry.ts"
Cohesion: 0.09
Nodes (36): average(), Cadastre, CadastreLine, extractKmlFromZip(), findEndOfCentralDirectory(), inflateEntry(), mergeParcelPoints(), Parcel (+28 more)

### Community 17 - "CitizensService"
Cohesion: 0.19
Nodes (3): CitizensService, columnHeaderFor(), Injectable

### Community 18 - "presentation.module.ts"
Cohesion: 0.10
Nodes (19): ZodValidationPipe, SessionResult, TotpChallengeRequired, CitizenProps, StaffRole, UserKind, BackupController, Controller (+11 more)

### Community 19 - "ZonesService"
Cohesion: 0.07
Nodes (13): describe(), toSummary(), Inject, Injectable, ZonesService, Zone, ZoneParcelOwner, ZoneRepository (+5 more)

### Community 20 - "fee.schema.ts"
Cohesion: 0.04
Nodes (48): BackupSchedule, ChargeCitizen, chargeCitizenSchema, CreateFeeNotice, createFeeNoticeSchema, CURRENCY_CODES, CurrencyCode, DeclarePayment (+40 more)

### Community 21 - "enums.ts"
Cohesion: 0.05
Nodes (45): BloodType, BUILDING_LIFECYCLE, BuildingLifecycle, CASE_TYPE, CaseType, CITIZEN_RESIDENCE, DAMAGE_LEVEL, DAMAGE_SOURCE (+37 more)

### Community 22 - "application.module.ts"
Cohesion: 0.08
Nodes (18): OtpCleanupJob, Cron, Inject, Injectable, RecurringBillingJob, Cron, Inject, Injectable (+10 more)

### Community 23 - "admin-citizen.schema.ts"
Cohesion: 0.07
Nodes (45): AdminCitizenSubmission, AdminCitizenUpdateSubmission, AdminCreateCitizen, adminCreateCitizenSchema, adminCreateCitizenSubmissionSchema, AdminUpdateCitizen, adminUpdateCitizenSchema, adminUpdateCitizenSubmissionSchema (+37 more)

### Community 24 - "building-unit-forms.tsx"
Cohesion: 0.09
Nodes (64): activeVacancy(), AddPersonForm(), BuildingBadgeFacts, BuildingSummaryBadges(), CaseForm(), cellBadge, CellVariant, ConfirmVacancyDialog() (+56 more)

### Community 25 - "document.service.ts"
Cohesion: 0.16
Nodes (9): DocumentSlot, IncomingFile, ALLOWED_MIME_TYPES, DocumentProps, DocumentType, DocumentRepository, StoredDocument, PrismaDocumentRepository (+1 more)

### Community 26 - "infrastructure.module.ts"
Cohesion: 0.14
Nodes (19): CadastreImportResult, ParsedLine, ParsedParcel, ZoneDetail, ZoneSummary, AUDIT_REPOSITORY, BaseRepository, CASE_REPOSITORY (+11 more)

### Community 27 - "IdentityService"
Cohesion: 0.12
Nodes (12): IdentityService, normalisePhone(), Injectable, AuthController, Body, Controller, Get, Param (+4 more)

### Community 28 - "building.schema.ts"
Cohesion: 0.05
Nodes (44): basementsCount, BuildingFilter, buildingFilterSchema, buildingName, ConfirmVacancyInput, confirmVacancySchema, coordinatePair(), CreateBuildingInput (+36 more)

### Community 29 - "dependencies"
Cohesion: 0.05
Nodes (37): dependencies, bcrypt, compression, helmet, ioredis, @mechanization/shared-schemas, @nestjs/common, @nestjs/config (+29 more)

### Community 30 - "devDependencies"
Cohesion: 0.05
Nodes (37): devDependencies, jest, @nestjs/cli, @nestjs/schematics, prisma, supertest, ts-node, tsconfig-paths (+29 more)

### Community 31 - "CasesService"
Cohesion: 0.08
Nodes (12): CasesService, Inject, Injectable, Case, CaseCensusLinks, CaseListFilter, CaseRepository, CaseRow (+4 more)

### Community 32 - "admin-shell.tsx"
Cohesion: 0.10
Nodes (28): getTenantName(), ProtectedAdminLayout(), AdminIndexPage(), AdminHeader(), signOut(), AdminShell(), AdminSidebar(), foldListeners (+20 more)

### Community 33 - ""users""
Cohesion: 0.09
Nodes (27): "audit_log_entries", audit_log_entries_no_delete, audit_log_entries_no_update, "documents", "otp_challenges", "property_entries", "registrations", reject_audit_mutation() (+19 more)

### Community 34 - "app.module.ts"
Cohesion: 0.12
Nodes (14): AppModule, Module, ApplicationModule, Module, DomainModule, Module, InfrastructureModule, Module (+6 more)

### Community 35 - "citizen-editor.tsx"
Cohesion: 0.09
Nodes (32): mintId(), announceCensus(), announceIdentity(), censusConcerns(), censusDraft(), CitizenEditor(), floorLabel(), fromCaseDraft() (+24 more)

### Community 36 - "reporting.service.ts"
Cohesion: 0.07
Nodes (22): CitizenFeeTotals, CitizenProfile, CitizenProfileDocument, CitizenProfileLandlordOf, CitizenProfilePayment, CitizenProfileProperty, CitizenProfileRegistration, CitizenProfileUnit (+14 more)

### Community 37 - "StaffService"
Cohesion: 0.12
Nodes (10): StaffService, Injectable, StaffController, Body, Controller, Delete, Get, Param (+2 more)

### Community 38 - "Roles"
Cohesion: 0.18
Nodes (11): CitizenController, mask(), Body, Controller, Delete, Get, Param, Patch (+3 more)

### Community 39 - "building-editor.tsx"
Cohesion: 0.08
Nodes (32): BuildingEditor(), gridFromUnits(), offlineNow(), STEPS, undeletableReason(), UnitBaseline, floorLabel(), loadParcelOutlines() (+24 more)

### Community 40 - "offline-sync.ts"
Cohesion: 0.15
Nodes (30): BuildingQueueNotice(), createBuilding(), generateUnits(), getQueued(), listQueued(), listQueuedBuildings(), offlineStorageAvailable(), QueuedBuilding (+22 more)

### Community 41 - "citizen-import.schema.ts"
Cohesion: 0.08
Nodes (30): buildCitizenPayload(), CitizenImportRequest, CitizenImportResult, CitizenImportRowResult, citizenImportSchema, IMPORT_BATCH_SIZE, IMPORT_COLUMN_KEYS, IMPORT_COLUMNS (+22 more)

### Community 42 - "targets.mjs"
Cohesion: 0.16
Nodes (12): CI verify job (typecheck, test, build), Supabase projects: production thbgwfbcqdougbjvgvyw, staging lzgbjcwtzqyrbeoolvdz, extractRef(), parseEnvFile(), placeholderKeys(), PRODUCTION_REF, resolveTarget(), ROOT (+4 more)

### Community 43 - "audit.repository.ts"
Cohesion: 0.15
Nodes (8): AuditLogEntry, AuditLogEntryProps, REDACTED_KEYS, AuditQuery, AuditRepository, AuditRow, PrismaAuditRepository, Injectable

### Community 44 - "CurrentUser"
Cohesion: 0.23
Nodes (10): BuildingsController, Body, Controller, Delete, Get, Param, Patch, Post (+2 more)

### Community 45 - "[locale]/layout.tsx"
Cohesion: 0.11
Nodes (20): CitizenLayout(), getTenant(), dynamic, generateMetadata(), getTenant(), safeHslTriple(), TenantLayout(), AccentContext (+12 more)

### Community 46 - "compilerOptions"
Cohesion: 0.07
Nodes (27): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+19 more)

### Community 47 - "PaymentLedgerService"
Cohesion: 0.06
Nodes (16): Inject, PaymentLedgerService, Injectable, Row, UNTOUCHED, WHISH_GATEWAY, WhishCallback, WhishCheckout (+8 more)

### Community 48 - "CitizenForm"
Cohesion: 0.12
Nodes (17): askableFields(), askablePaths(), CitizenForm(), editSection(), handleSubmit(), requestSave(), isBlank(), propertyAskableFields() (+9 more)

### Community 49 - "RedisCacheService"
Cohesion: 0.10
Nodes (9): Inject, SessionRevocationService, Injectable, Inject, MemoryCacheEntry, RedisCacheService, Injectable, JwtAuthGuard (+1 more)

### Community 50 - "parcel.repository.ts"
Cohesion: 0.17
Nodes (5): ParcelLocation, tenantSchemaPrefix(), PrismaParcelRepository, toLocation(), Injectable

### Community 51 - "property.schema.ts"
Cohesion: 0.06
Nodes (35): occupancyTypeSchema, PropertyType, unitStatusSchema, unitTypeSchema, arabicOrLatinName, civilRecordNumber, documentNumber, internationalPhone (+27 more)

### Community 52 - "citizen-form.tsx"
Cohesion: 0.05
Nodes (63): applyStructureType(), BuildingUnitPicker(), currentOccupants(), floorText(), isBlankUnit(), LinkedBuildingFacts, LockedCensusTarget, NoLinkOption() (+55 more)

### Community 53 - "case.schema.ts"
Cohesion: 0.08
Nodes (20): CASE_FIELD_MAP, CASE_STATUS, CaseStatus, censusLinks, CreateCaseInput, createCaseSchema, notesField, UpdateCaseInput (+12 more)

### Community 54 - "citizen.schema.ts"
Cohesion: 0.10
Nodes (20): ContactDetails, contactDetailsObject, contactDetailsSchema, nonResidentOwnerContactObject, nonResidentOwnerContactSchema, nonResidentOwnerPersonalSchema, PartialContactDetails, partialContactDetailsSchema (+12 more)

### Community 55 - "withConnectionRetry"
Cohesion: 0.08
Nodes (10): readFlags(), addPeriod(), dueDateInCurrentPeriod(), FeesService, periodKeyFor(), Injectable, OnEvent, isTransientConnectionError() (+2 more)

### Community 56 - "auth.schema.ts"
Cohesion: 0.08
Nodes (23): ChangeEmail, changeEmailSchema, ChangePassword, changePasswordSchema, citizenChoiceSchema, ConfirmPasswordReset, confirmPasswordResetSchema, createStaffUserSchema (+15 more)

### Community 57 - "BackupSection"
Cohesion: 0.13
Nodes (20): BackupSection(), formatBytes(), nextRunAt(), exportSnapshot(), restoreSnapshot(), readSettingsSlice(), storageKey(), useSettingsSlice() (+12 more)

### Community 58 - "scripts"
Cohesion: 0.09
Nodes (22): scripts, auth:sync-templates, build, build:check, db:check, db:deploy:local, db:deploy:production, db:deploy:staging (+14 more)

### Community 59 - "scripts"
Cohesion: 0.10
Nodes (21): scripts, backfill:boundaries, backfill:buildings, build, cadastre:import, dev, lint, prisma:deploy:registry (+13 more)

### Community 60 - "SupabaseAuthService"
Cohesion: 0.14
Nodes (5): SupabaseAuthResult, SupabaseAuthService, SupabaseAuthUser, SupabaseAuthServiceImpl, Injectable

### Community 61 - "dependencies"
Cohesion: 0.10
Nodes (21): dependencies, clsx, html2canvas, jspdf, lucide-react, @radix-ui/react-checkbox, @radix-ui/react-dropdown-menu, @radix-ui/react-select (+13 more)

### Community 62 - "devDependencies"
Cohesion: 0.10
Nodes (21): devDependencies, autoprefixer, postcss, tailwindcss, tailwindcss-animate, @types/geojson, @types/mapbox-gl, @types/node (+13 more)

### Community 63 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, baseUrl, emitDecoratorMetadata, experimentalDecorators, noUncheckedIndexedAccess, outDir, paths, rootDir (+11 more)

### Community 64 - "citizens.service.ts"
Cohesion: 0.07
Nodes (18): citizenColumnsForEdit(), CitizenListAggregate, CitizenListItem, CitizenListRow, Inject, LandlordProposal, PendingEvent, ReconcileResult (+10 more)

### Community 66 - "deploy.mjs"
Cohesion: 0.15
Nodes (20): Destructive DDL scanner (--allow-destructive), Expand / migrate / contract pattern, appliedRegistry(), appliedTenants(), BACKEND, C, { Client }, DESTRUCTIVE (+12 more)

### Community 67 - "Open decisions register"
Cohesion: 0.50
Nodes (4): Serverless limitations (read-only FS cadastre import, per-instance throttling), Open decisions register, Production hosting and data residency, Legal basis and retention policy (blocking)

### Community 68 - "offline-db.ts"
Cohesion: 0.21
Nodes (14): dequeue(), dequeueBuilding(), enqueue(), enqueueBuilding(), QueuedBuildingStatus, QueuedStatus, recordAttempt(), retryLater() (+6 more)

### Community 69 - "Database environments runbook"
Cohesion: 0.15
Nodes (14): Backend API landing page, CLAUDE.md short rules, Docker compose local stack (redis, backend, frontend), Database environments runbook, Vercel env vars scoped to one environment, Deploying to Vercel runbook, Backend serverless entry (api/index.js -> dist serverless.js), OTP delivery fallback (SmsProviderService.deliver throws) (+6 more)

### Community 71 - "sw.js"
Cohesion: 0.06
Nodes (34): Offline fallback page, CURRENT, offlinePageFor(), Core civic palette (navy, ivory, cedar green, amber, crimson), Modern Civic Ledger design language, Typography architecture (Alexandria, Readex Pro, tabular numerals), Building Census implementation plan, Building model (first-class, anchored to parcel) (+26 more)

### Community 72 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noImplicitAny (+8 more)

### Community 73 - "fees.service.ts"
Cohesion: 0.12
Nodes (24): FOLD, foldDigits(), likePattern(), normalizeSearchText(), searchTokens(), assessCitizen(), attachOccupancies(), bearsFee() (+16 more)

### Community 74 - "csv.ts"
Cohesion: 0.19
Nodes (12): ImportCitizensDialog(), readFile(), buildCitizenTemplate(), buildCsv(), csvCell(), detectDelimiter(), escapeCell(), parseCitizenCsv() (+4 more)

### Community 75 - "OtpService"
Cohesion: 0.13
Nodes (4): Inject, OtpService, Injectable, PhoneNumber

### Community 77 - "shared-schemas/package.json"
Cohesion: 0.13
Nodes (14): dependencies, zod, devDependencies, typescript, typescript, zod, main, name (+6 more)

### Community 78 - "sync-production-tenant.mjs"
Cohesion: 0.25
Nodes (8): { Client }, { createClient }, getRef(), main(), MIGRATIONS_DIR, require, ROOT, TABLES

### Community 79 - ".update"
Cohesion: 0.17
Nodes (7): Body, Delete, Get, Param, Patch, Post, Query

### Community 80 - "numbering.ts"
Cohesion: 0.20
Nodes (11): buildingSuffixAt(), clamp(), firstMagnitude(), fold(), formatUnitCode(), nextBuildingSuffix(), ORDINALS, pad() (+3 more)

### Community 81 - "backend/vercel.json"
Cohesion: 0.15
Nodes (12): includeFiles, maxDuration, memory, buildCommand, crons, framework, functions, api/index.js (+4 more)

### Community 82 - "charts.tsx"
Cohesion: 0.26
Nodes (11): axisLabelStride(), ChartCard(), ColumnChart(), ColumnDatum, columnPath(), GroupedColumnChart(), GroupedDatum, HoverState (+3 more)

### Community 83 - "devDependencies"
Cohesion: 0.15
Nodes (13): eslint, @eslint/js, eslint-plugin-react-hooks, globals, @next/eslint-plugin-next, devDependencies, eslint, @eslint/js (+5 more)

### Community 84 - "tenant-context.service.ts"
Cohesion: 0.12
Nodes (14): CensusSyncResult, OCCUPANCY_ROLE_BY_TYPE, UNRESOLVED_SURVEY_STATES, TenantScope, assertSafeSchemaName(), loadTenantMigrations(), migrateTenantSchema(), MIGRATIONS_DIR (+6 more)

### Community 85 - "staff.schema.ts"
Cohesion: 0.17
Nodes (11): staffRoleSchema, InspectorPayoutItem, inspectorPayoutItemSchema, InspectorProfileResponse, inspectorProfileResponseSchema, InspectorPropertyBreakdown, inspectorPropertyBreakdownSchema, InspectorRegistrationLogItem (+3 more)

### Community 86 - "start.mjs"
Cohesion: 0.29
Nodes (9): backend, colorize(), dockerAvailable(), ensureDockerRunning(), handleLine(), pipeLines(), runDevProcess(), statusLine() (+1 more)

### Community 87 - "DocumentService"
Cohesion: 0.25
Nodes (6): DocumentService, Injectable, DocumentController, Controller, Get, Param

### Community 88 - ".import"
Cohesion: 0.20
Nodes (8): CadastreController, Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors

### Community 89 - "ZonesController"
Cohesion: 0.20
Nodes (9): Body, Controller, Delete, Get, Header, Param, Post, ZonesController (+1 more)

### Community 90 - "(citizen)/page.tsx"
Cohesion: 0.44
Nodes (9): TenantHome(), openByReference(), allows(), formatReference(), GROUPS, isCompleteReference(), nextReferenceValue(), REFERENCE_RAW_LENGTH (+1 more)

### Community 91 - "scripts"
Cohesion: 0.18
Nodes (10): name, private, scripts, build, build:check, dev, lint, start (+2 more)

### Community 92 - "overrides"
Cohesion: 0.18
Nodes (11): body-parser@1, brace-expansion@1, brace-expansion@2, lodash, multer, nanoid@3, postcss, qs@6 (+3 more)

### Community 93 - "landlord-link.service.ts"
Cohesion: 0.08
Nodes (27): CANDIDATE_SELECT, CARD_SELECT, CardSnapshot, decimalText(), ENTRY_SELECT, FootprintUnit, LandlordCandidate, LandlordLinkResult (+19 more)

### Community 94 - "zone.schema.ts"
Cohesion: 0.20
Nodes (9): CreateZoneInput, createZoneSchema, parcelNumberField, parcelNumbersField, UpdateZoneInput, updateZoneSchema, zoneCodeField, zoneColorField (+1 more)

### Community 95 - "nest-cli.json"
Cohesion: 0.22
Nodes (8): collection, compilerOptions, assets, deleteOutDir, watchAssets, entryFile, $schema, sourceRoot

### Community 96 - "sync-supabase-templates.mjs"
Cohesion: 0.22
Nodes (7): changeEmailContent, changeEmailPath, __dirname, __filename, resetPasswordContent, resetPasswordPath, rootDir

### Community 97 - "citizen-draft.ts"
Cohesion: 0.52
Nodes (6): CitizenFormValues, clearCitizenDraft(), key(), loadCitizenDraft(), saveCitizenDraft(), StoredDraft

### Community 98 - "package.json"
Cohesion: 0.25
Nodes (7): engines, node, name, packageManager, pnpm, private, version

### Community 99 - "shared-schemas/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src/**/*, ../../tsconfig.base.json

### Community 100 - "dump-tenant.js"
Cohesion: 0.29
Nodes (5): { Client }, env, fs, path, TABLES

### Community 101 - "buildings.service.ts"
Cohesion: 0.15
Nodes (18): BuildingLedgerRow, BuildingMapPin, BuildingRow, CreateBuildingRow, CreateUnitRow, OccupancyRow, VacancyRow, VisitRow (+10 more)

### Community 102 - "TenantController"
Cohesion: 0.38
Nodes (4): TenantController, Controller, Get, Param

### Community 103 - "date-picker.tsx"
Cohesion: 0.38
Nodes (6): DatePicker(), DatePickerProps, JumpDropdown(), JumpOption, parseIsoDay(), toIsoDay()

### Community 105 - "AuditController"
Cohesion: 0.33
Nodes (4): AuditController, Controller, Get, Query

### Community 106 - "HealthController"
Cohesion: 0.40
Nodes (3): HealthController, Controller, Get

### Community 107 - "routing.ts"
Cohesion: 0.47
Nodes (4): defaultLocale, isLocale(), Locale, locales

### Community 108 - "middleware.ts"
Cohesion: 0.47
Nodes (5): apiOrigin(), config, contentSecurityPolicy(), LOCALES, middleware()

### Community 109 - "next.config.mjs"
Cohesion: 0.40
Nodes (4): nextConfig, onVercel, SECURITY_HEADERS, withNextIntl

### Community 110 - "frontend/vercel.json"
Cohesion: 0.40
Nodes (4): buildCommand, framework, installCommand, $schema

### Community 111 - "backend/package.json"
Cohesion: 0.50
Nodes (3): name, private, version

### Community 113 - "citizen-import.spec.ts"
Cohesion: 0.67
Nodes (3): BASE, expectAccepted(), parse()

### Community 114 - "citizen-review-dialog.tsx"
Cohesion: 0.18
Nodes (20): buildReview(), ChipVariant, CitizenReviewDialog(), contactRows(), CountTile(), FieldGrid(), FieldTile(), fullNameOf() (+12 more)

### Community 192 - "AuditService"
Cohesion: 0.27
Nodes (3): AuditService, Injectable, OnEvent

### Community 193 - "registration.repository.ts"
Cohesion: 0.16
Nodes (5): RegistrationRepository, SubmitRegistrationResult, isSamePerson(), PrismaRegistrationRepository, Injectable

### Community 194 - "zone-editor-map.tsx"
Cohesion: 0.19
Nodes (16): ZoneEditorMap, MapLayerControl(), Basemap, basemapById(), BasemapId, BASEMAPS, DEFAULT_BASEMAP, ensureRtlTextPlugin() (+8 more)

### Community 195 - "payment-receipt.tsx"
Cohesion: 0.16
Nodes (11): DrawnFacsimile(), IMAGE_CHECKBOXES, IMAGE_FIELDS, ImageField, PaymentReceipt(), receiptNumber(), whatsappNumber(), downloadFile() (+3 more)

### Community 196 - "Supabase"
Cohesion: 0.11
Nodes (15): Fix suggestion, Source, What happened, Skill Feedback, Steps, Core Principles, Debugging, Making and Committing Schema Changes (+7 more)

### Community 197 - "LandlordLinkService"
Cohesion: 0.21
Nodes (5): fullName(), LandlordLinkService, toCandidate(), Injectable, tenantSchemaRef()

### Community 198 - "Changelog"
Cohesion: 0.12
Nodes (16): [1.2.0](https://github.com/supabase/agent-skills/compare/v1.1.1...v1.2.0) (2026-06-02), [1.3.0](https://github.com/supabase/agent-skills/compare/v1.2.0...v1.3.0) (2026-06-05), [1.4.0](https://github.com/supabase/agent-skills/compare/v1.3.0...v1.4.0) (2026-07-10), [1.5.0](https://github.com/supabase/agent-skills/compare/supabase-postgres-best-practices-v1.4.0...supabase-postgres-best-practices-v1.5.0) (2026-07-30), [1.6.0](https://github.com/supabase/agent-skills/compare/supabase-postgres-best-practices-v1.5.0...supabase-postgres-best-practices-v1.6.0) (2026-07-30), Bug Fixes, Bug Fixes, Bug Fixes (+8 more)

### Community 199 - "damage.service.ts"
Cohesion: 0.18
Nodes (7): DamageRow, DamageService, damageSeverity(), SEVERITY, toDamageRow(), Injectable, worstDamage()

### Community 200 - "CadastreStorageService"
Cohesion: 0.18
Nodes (5): CadastreImportService, Inject, Injectable, CadastreStorageService, Injectable

### Community 201 - "SupabaseStorageService"
Cohesion: 0.17
Nodes (5): Inject, ImageStorageService, UploadRequest, SupabaseStorageService, Injectable

### Community 202 - "Changelog"
Cohesion: 0.12
Nodes (15): [0.1.3](https://github.com/supabase/agent-skills/compare/v0.1.2...v0.1.3) (2026-06-02), [0.1.4](https://github.com/supabase/agent-skills/compare/v0.1.3...v0.1.4) (2026-06-05), [0.1.5](https://github.com/supabase/agent-skills/compare/v0.1.4...v0.1.5) (2026-07-10), [0.1.6](https://github.com/supabase/agent-skills/compare/v0.1.5...supabase-v0.1.6) (2026-07-30), [0.1.7](https://github.com/supabase/agent-skills/compare/v0.1.6...supabase-v0.1.7) (2026-08-12), Bug Fixes, Bug Fixes, Bug Fixes (+7 more)

### Community 203 - "Writing Guidelines for Postgres References"
Cohesion: 0.12
Nodes (15): 1. Concrete Transformation Patterns, 2. Error-First Structure, 3. Quantified Impact, 4. Self-Contained Examples, 5. Semantic Naming, Code Example Standards, Comments, Impact Level Guidelines (+7 more)

### Community 204 - ".recordOccupancy"
Cohesion: 0.18
Nodes (6): FileLinkResult, assertNonResidentOccupancy(), actor, HarnessOptions, record(), base

### Community 205 - ".revertUnits"
Cohesion: 0.19
Nodes (7): emptyReport(), emptyUnlink(), readFootprint(), readMint(), sameCard(), sameRow(), summarise()

### Community 206 - "TotpService"
Cohesion: 0.17
Nodes (3): TotpService, OtplibTotpService, Injectable

### Community 207 - "property-entry.entity.ts"
Cohesion: 0.20
Nodes (9): BuildingUnitProps, LandType, NON_OWNER, NOTHING_UNESTABLISHED, OccupancyType, PropertyEntryProps, UnestablishedFields, UnitStatus (+1 more)

### Community 208 - "user.repository.ts"
Cohesion: 0.27
Nodes (5): DisambiguationRequired, SubmitRegistrationInput, CitizenChoice, CitizenIdentityInput, StaffSummary

### Community 209 - "DashboardController"
Cohesion: 0.29
Nodes (5): DashboardController, Controller, Get, Header, Param

### Community 210 - "map-geometry.ts"
Cohesion: 0.29
Nodes (10): ZoneInfoDialog(), computeGeoJsonArea(), computePolygonArea(), computeTotalDistance(), formatArea(), formatDistance(), haversineDistance(), pointInGeometry() (+2 more)

### Community 212 - "bootstrap.ts"
Cohesion: 0.38
Nodes (6): createApiApp(), APP_CONFIG, bootstrap(), ExpressLike, handler(), instance()

### Community 213 - "backfill-buildings.ts"
Cohesion: 0.27
Nodes (8): Args, backfillBuildings(), Card, CARD_SELECT, groupKey(), printReport(), Report, tenantClient()

### Community 214 - "Section Definitions"
Cohesion: 0.20
Nodes (9): 1. Query Performance (query), 2. Connection Management (conn), 3. Security & RLS (security), 4. Schema Design (schema), 5. Concurrency & Locking (lock), 6. Data Access Patterns (data), 7. Monitoring & Diagnostics (monitor), 8. Advanced Features (advanced) (+1 more)

### Community 215 - ".list"
Cohesion: 0.31
Nodes (3): BuildingListFilter, CensusSummary, toBuildingRow()

### Community 216 - "create-staff.ts"
Cohesion: 0.31
Nodes (7): Args, createStaff(), report(), Role, ROLES, syncToSupabase(), tenantClient()

### Community 217 - "parcel-pin-picker.tsx"
Cohesion: 0.25
Nodes (8): FALLBACK_CENTER, MAP_LOAD_TIMEOUT_MS, outlineCache, ParcelPinPicker(), PIN_COLOR, SATELLITE_STYLE, geometryBounds(), geometryCenter()

### Community 218 - "building-draft.ts"
Cohesion: 0.44
Nodes (8): GridUnitDraft, BuildingDraft, buildingDraftWorthKeeping(), clearBuildingDraft(), key(), loadBuildingDraft(), saveBuildingDraft(), StoredDraft

### Community 219 - "provision.mjs"
Cohesion: 0.31
Nodes (8): arg(), C, { Client }, inspect(), main(), require, TENANT_MIGRATIONS, withClient()

### Community 222 - "RegistrationController"
Cohesion: 0.29
Nodes (4): RegistrationController, Controller, Get, Param

### Community 225 - "Supabase Postgres Best Practices"
Cohesion: 0.33
Nodes (5): How to Use, References, Rule Categories by Priority, Supabase Postgres Best Practices, When to Apply

### Community 226 - "db-staging / db-production GitHub Environments"
Cohesion: 0.50
Nodes (5): Deploy production workflow (manual, reviewer-gated), Deploy staging workflow (auto on develop push), Sync tenant to production workflow, db-staging / db-production GitHub Environments, Vercel GitHub App not following repo transfer

### Community 228 - "staff-login.spec.ts"
Cohesion: 0.40
Nodes (3): LOGIN, SUPABASE_OK, StaffProps

### Community 229 - ".restore"
Cohesion: 0.40
Nodes (4): readBody(), Post, Query, Req

## Ambiguous Edges - Review These
- `Vercel env vars scoped to one environment` → `Deploying to Vercel runbook`  [AMBIGUOUS]
  docs/deploy-vercel.md · relation: conceptually_related_to
- `Supabase change-email confirmation template` → `Modern Civic Ledger design language`  [AMBIGUOUS]
  supabase/templates/change-email-address.html · relation: conceptually_related_to

## Knowledge Gaps
- **967 isolated node(s):** `supabase-prod`, `supabase-staging`, `handler`, `fs`, `path` (+962 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **75 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Vercel env vars scoped to one environment` and `Deploying to Vercel runbook`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Supabase change-email confirmation template` and `Modern Civic Ledger design language`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `User` connect `User` to `api-client.ts`, `staff-login.spec.ts`, `button.tsx`, `PropertyEntry`, `UserRepository`, `user.repository.ts`, `presentation.module.ts`, `IdentityService`?**
  _High betweenness centrality (0.322) - this node is a cross-community bridge._
- **Why does `logApiError()` connect `logApiError` to `backup-section.tsx`, `api-client.ts`, `citizen-editor.tsx`, `fullscreen-map.tsx`, `button.tsx`, `building-editor.tsx`, `offline-sync.ts`, `cn`, `case-editor.tsx`, `[citizenId]/page.tsx`, `citizen-form.tsx`, `building-unit-forms.tsx`, `BackupSection`, `(citizen)/page.tsx`?**
  _High betweenness centrality (0.292) - this node is a cross-community bridge._
- **Why does `flagsFromArray()` connect `citizen-editor.tsx` to `button.tsx`, `admin-citizen.schema.ts`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `logApiError()` (e.g. with `CasesPage()` and `FullscreenMap()`) actually correct?**
  _`logApiError()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `supabase-prod`, `supabase-staging`, `handler` to the rest of the system?**
  _967 weakly-connected nodes found - possible documentation gaps or missing edges._