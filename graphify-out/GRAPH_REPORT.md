# Graph Report - mechanization-1  (2026-09-13)

## Corpus Check
- 478 files · ~637,546 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3857 nodes · 9370 edges · 269 communities (193 shown, 76 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 205 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1d8c77ec`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- backup-section.tsx
- api-client.ts
- loadSession
- application.module.ts
- BuildingsService
- fullscreen-map.tsx
- button.tsx
- PropertyEntry
- ValidationError
- cn
- fees/page.tsx
- [citizenId]/page.tsx
- landlord-link.spec.ts
- backup.service.ts
- FeesController
- otp-repository.interface.ts
- parcel-geometry.ts
- CitizensService
- presentation.module.ts
- PrismaZoneRepository
- fee.schema.ts
- enums.ts
- TenantPrismaFactory
- admin-citizen.schema.ts
- building-unit-matrix-view.tsx
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
- unit-grid-picker.tsx
- offline-sync.ts
- citizen-import.schema.ts
- targets.mjs
- audit.repository.ts
- SessionClaims
- [locale]/layout.tsx
- compilerOptions
- whish-settlement.spec.ts
- CitizenForm
- RedisCacheService
- ParcelRepository
- property.schema.ts
- building-unit-picker.tsx
- case.schema.ts
- citizen.schema.ts
- withConnectionRetry
- auth.schema.ts
- settings-store.ts
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
- CasesController
- numbering.ts
- backend/vercel.json
- charts.tsx
- devDependencies
- TenantContextService
- staff.schema.ts
- start.mjs
- DocumentService
- logApiError
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
- TenantService
- date-picker.tsx
- raw-sql-is-schema-qualified.spec.ts
- .query
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
- citizens/page.tsx
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
- useToast
- build-check.mjs
- tailwind.config.ts
- AuditService
- registration.repository.ts
- building-unit-forms.tsx
- zones.service.ts
- Supabase
- LandlordLinkService
- Changelog
- damage.service.ts
- cadastre-import.service.ts
- SupabaseStorageService
- Changelog
- Writing Guidelines for Postgres References
- .recordOccupancy
- RegistrationRepository
- TotpService
- property-entry.entity.ts
- user.repository.ts
- DashboardController
- backfill-parcel-boundaries.ts
- verify
- bootstrap.ts
- backfill-buildings.ts
- Section Definitions
- .list
- create-staff.ts
- DomainExceptionFilter
- building-editor.tsx
- provision.mjs
- checkPropertyNumber
- Document
- RegistrationController
- AppLogger
- occupancy-end.spec.ts
- Supabase Postgres Best Practices
- db-staging / db-production GitHub Environments
- census-release.spec.ts
- UnitWithOccupants
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
- @types/bcrypt
- clsx

## God Nodes (most connected - your core abstractions)
1. `cn()` - 222 edges
2. `logApiError()` - 95 edges
3. `Roles()` - 91 edges
4. `SessionClaims` - 76 edges
5. `Button` - 74 edges
6. `CurrentUser` - 69 edges
7. `apiFetch()` - 67 edges
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
- `Docker compose local stack (redis, backend, frontend)` --conceptually_related_to--> `Backend API landing page`  [INFERRED]
  docker-compose.yml → apps/backend/public/index.html
- `Backend serverless entry (api/index.js -> dist serverless.js)` --conceptually_related_to--> `Backend API landing page`  [INFERRED]
  docs/deploy-vercel.md → apps/backend/public/index.html

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Building census data model (D1-D4)** — docs_building_census_plan_building, docs_building_census_plan_unit, docs_building_census_plan_unitoccupancy, docs_building_census_plan_damageassessment, docs_building_census_plan_building_lifecycle [EXTRACTED 1.00]
- **Production migration safety gates** — _github_workflows_deploy_production_migrate, docs_database_environments_db_github_environments, scripts_db_targets, docs_database_environments_promotion_check, docs_database_environments_destructive_ddl_scanner [EXTRACTED 1.00]
- **Census occupancy to billing flow** — docs_building_census_plan_census_sync_service, docs_building_census_plan_unitoccupancy, docs_building_census_plan_held_through_occupancy, docs_open_decisions_landlord_link, docs_open_decisions_fee_bearer [INFERRED 0.85]

## Communities (269 total, 76 thin omitted)

### Community 0 - "backup-section.tsx"
Cohesion: 0.05
Nodes (84): SectionDef, SectionId, SECTIONS, SettingsPage(), ArchiveInspection, BackupSection(), DEFAULT_SCHEDULE, EMPTY_HISTORY (+76 more)

### Community 1 - "api-client.ts"
Cohesion: 0.03
Nodes (94): StaffLogin(), submit(), LandlordLinksPage(), SUMMARY_ROLES, PaymentsLogin(), submit(), LandlordLinkPrompt(), LandlordMatchHint() (+86 more)

### Community 2 - "loadSession"
Cohesion: 0.07
Nodes (57): FeesPanel(), count(), DEFAULT_FOLDED, DetailRow(), FoldSection(), KPI_TONES, KpiCard(), moneyAxis() (+49 more)

### Community 3 - "application.module.ts"
Cohesion: 0.06
Nodes (18): OtpCleanupJob, Inject, Injectable, PublicTenantConfig, PROPS, PropertyType, Tenant, TenantConfig (+10 more)

### Community 4 - "BuildingsService"
Cohesion: 0.20
Nodes (6): UnitRow, BuildingsService, toOccupancyRow(), toUnitRow(), Injectable, toVacancyRow()

### Community 5 - "fullscreen-map.tsx"
Cohesion: 0.06
Nodes (64): FullscreenMap, ZoneEditorMap, BUILDING_LAYER, BUILDING_SOURCE, BUILDING_ZOOM, buildingLegend(), buildingsGeoJson(), DAMAGE_COLORS (+56 more)

### Community 6 - "button.tsx"
Cohesion: 0.06
Nodes (79): Stage, LinkedBuildingFacts, ChargeCitizenDialog(), EMPTY, formatLbp(), AskableField, askableFields(), askablePaths() (+71 more)

### Community 7 - "PropertyEntry"
Cohesion: 0.11
Nodes (4): AggregateRoot, DomainEvent, PropertyEntry, Registration

### Community 8 - "ValidationError"
Cohesion: 0.11
Nodes (12): ValidationError, ReferenceNumber, TenantSlug, Args, reissueReferences(), tenantClient(), main(), sampleParcels() (+4 more)

### Community 9 - "cn"
Cohesion: 0.05
Nodes (69): AuditTrailPage(), ENTITY_TYPES, BuildingsPage(), DAMAGED_LEVELS, FilterSelect(), getTableLabels(), MetricCard(), READ_ONLY_ROLES (+61 more)

### Community 10 - "fees/page.tsx"
Cohesion: 0.09
Nodes (40): AccountSecurityPage(), FeesPage(), getStatusFilters(), getTableLabels(), initials(), MetricCard(), SettlePaymentPage(), EMPTY_TOTALS (+32 more)

### Community 11 - "[citizenId]/page.tsx"
Cohesion: 0.06
Nodes (38): CitizenProfilePage(), FactItem, FactSection(), householdFacts(), legacyDocumentHint(), ownerBilledHint(), PAYMENT_TONE, present() (+30 more)

### Community 12 - "landlord-link.spec.ts"
Cohesion: 0.40
Nodes (4): actor, harness(), HarnessOptions, tenantCard()

### Community 13 - "backup.service.ts"
Cohesion: 0.10
Nodes (14): BackupService, NEVER_RESTORED, RestoreReport, sanitizeRowForSnapshot(), Snapshot, SnapshotManifest, TABLE_ORDER, TableName (+6 more)

### Community 14 - "FeesController"
Cohesion: 0.14
Nodes (9): FeesController, Body, Controller, Get, Param, Patch, Post, Query (+1 more)

### Community 15 - "otp-repository.interface.ts"
Cohesion: 0.08
Nodes (10): OtpIssueResult, Inject, OtpChallengeRow, OtpChannel, OtpRepository, SmsSender, PrismaOtpRepository, Injectable (+2 more)

### Community 16 - "parcel-geometry.ts"
Cohesion: 0.09
Nodes (36): average(), Cadastre, CadastreLine, extractKmlFromZip(), findEndOfCentralDirectory(), inflateEntry(), mergeParcelPoints(), Parcel (+28 more)

### Community 17 - "CitizensService"
Cohesion: 0.11
Nodes (10): CitizensService, columnHeaderFor(), readFlags(), Inject, Injectable, LandlordProposal, ReconcileResult, RegistrationService (+2 more)

### Community 18 - "presentation.module.ts"
Cohesion: 0.07
Nodes (31): ZodValidationPipe, SessionResult, TotpChallengeRequired, LOGIN, SUPABASE_OK, CitizenProps, StaffProps, StaffRole (+23 more)

### Community 19 - "PrismaZoneRepository"
Cohesion: 0.13
Nodes (5): Zone, ZoneParcelOwner, ZoneRepository, PrismaZoneRepository, Injectable

### Community 20 - "fee.schema.ts"
Cohesion: 0.04
Nodes (48): BackupSchedule, ChargeCitizen, chargeCitizenSchema, CreateFeeNotice, createFeeNoticeSchema, CURRENCY_CODES, CurrencyCode, DeclarePayment (+40 more)

### Community 21 - "enums.ts"
Cohesion: 0.05
Nodes (45): BloodType, BUILDING_LIFECYCLE, BuildingLifecycle, CASE_TYPE, CaseType, CITIZEN_RESIDENCE, DAMAGE_LEVEL, DAMAGE_SOURCE (+37 more)

### Community 22 - "TenantPrismaFactory"
Cohesion: 0.09
Nodes (13): Cron, RecurringBillingJob, Cron, Injectable, TenantPrismaFactory, Injectable, InternalCronController, Controller (+5 more)

### Community 23 - "admin-citizen.schema.ts"
Cohesion: 0.07
Nodes (45): AdminCitizenSubmission, AdminCitizenUpdateSubmission, AdminCreateCitizen, adminCreateCitizenSchema, adminCreateCitizenSubmissionSchema, AdminUpdateCitizen, adminUpdateCitizenSchema, adminUpdateCitizenSubmissionSchema (+37 more)

### Community 24 - "building-unit-matrix-view.tsx"
Cohesion: 0.15
Nodes (37): activeVacancy(), CaseForm(), DamageForm(), effectiveUnitStatus(), floorLabel(), groupUnitsByFloor(), logVisitWithFollowUp(), occupancyMessage() (+29 more)

### Community 25 - "document.service.ts"
Cohesion: 0.16
Nodes (9): DocumentSlot, IncomingFile, ALLOWED_MIME_TYPES, DocumentProps, DocumentType, DocumentRepository, StoredDocument, PrismaDocumentRepository (+1 more)

### Community 26 - "infrastructure.module.ts"
Cohesion: 0.12
Nodes (20): PropertyNumberCheck, SubmitResult, ConflictError, AUDIT_REPOSITORY, BaseRepository, CASE_REPOSITORY, DOCUMENT_REPOSITORY, IMAGE_STORAGE_SERVICE (+12 more)

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
Nodes (37): devDependencies, jest, @nestjs/cli, @nestjs/schematics, @nestjs/testing, prisma, supertest, ts-node (+29 more)

### Community 31 - "CasesService"
Cohesion: 0.07
Nodes (12): CensusSyncService, Injectable, CasesService, Inject, Injectable, Case, CaseCensusLinks, CaseListFilter (+4 more)

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
Nodes (32): LockedCensusTarget, mintId(), announceCensus(), announceIdentity(), announceLandlordLinkChanges(), censusConcerns(), censusDraft(), CitizenEditor() (+24 more)

### Community 36 - "reporting.service.ts"
Cohesion: 0.06
Nodes (23): CitizenFeeTotals, CitizenProfile, CitizenProfileDocument, CitizenProfileLandlordOf, CitizenProfilePayment, CitizenProfileProperty, CitizenProfileRegistration, CitizenProfileUnit (+15 more)

### Community 37 - "StaffService"
Cohesion: 0.12
Nodes (10): StaffService, Injectable, StaffController, Body, Controller, Delete, Get, Param (+2 more)

### Community 38 - "Roles"
Cohesion: 0.19
Nodes (12): CitizenController, mask(), Body, Controller, Delete, Get, Param, Patch (+4 more)

### Community 39 - "unit-grid-picker.tsx"
Cohesion: 0.08
Nodes (27): FALLBACK_CENTER, floorLabel(), MAP_LOAD_TIMEOUT_MS, outlineCache, ParcelPinPicker(), PIN_COLOR, SATELLITE_STYLE, cellsOverlap() (+19 more)

### Community 40 - "offline-sync.ts"
Cohesion: 0.19
Nodes (25): BuildingQueueNotice(), generateUnits(), dequeue(), dequeueBuilding(), getQueued(), listQueued(), listQueuedBuildings(), offlineStorageAvailable() (+17 more)

### Community 41 - "citizen-import.schema.ts"
Cohesion: 0.08
Nodes (30): buildCitizenPayload(), CitizenImportRequest, CitizenImportResult, CitizenImportRowResult, citizenImportSchema, IMPORT_BATCH_SIZE, IMPORT_COLUMN_KEYS, IMPORT_COLUMNS (+22 more)

### Community 42 - "targets.mjs"
Cohesion: 0.16
Nodes (12): CI verify job (typecheck, test, build), Supabase projects: production thbgwfbcqdougbjvgvyw, staging lzgbjcwtzqyrbeoolvdz, extractRef(), parseEnvFile(), placeholderKeys(), PRODUCTION_REF, resolveTarget(), ROOT (+4 more)

### Community 43 - "audit.repository.ts"
Cohesion: 0.15
Nodes (8): AuditLogEntry, AuditLogEntryProps, REDACTED_KEYS, AuditQuery, AuditRepository, AuditRow, PrismaAuditRepository, Injectable

### Community 44 - "SessionClaims"
Cohesion: 0.20
Nodes (12): SessionClaims, BuildingsController, Body, Controller, Delete, Get, Param, Patch (+4 more)

### Community 45 - "[locale]/layout.tsx"
Cohesion: 0.11
Nodes (20): CitizenLayout(), getTenant(), dynamic, generateMetadata(), getTenant(), safeHslTriple(), TenantLayout(), AccentContext (+12 more)

### Community 46 - "compilerOptions"
Cohesion: 0.07
Nodes (27): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+19 more)

### Community 47 - "whish-settlement.spec.ts"
Cohesion: 0.10
Nodes (12): Row, UNTOUCHED, WHISH_GATEWAY, WhishCallback, WhishCheckout, WhishGateway, configWith(), live() (+4 more)

### Community 48 - "CitizenForm"
Cohesion: 0.14
Nodes (14): CitizenForm(), editSection(), handleSubmit(), requestSave(), isBlank(), reindexFlags(), submittedContact(), submittedPersonal() (+6 more)

### Community 49 - "RedisCacheService"
Cohesion: 0.11
Nodes (7): Inject, SessionRevocationService, Injectable, Inject, MemoryCacheEntry, RedisCacheService, Injectable

### Community 50 - "ParcelRepository"
Cohesion: 0.11
Nodes (6): Inject, ParcelLocation, ParcelRepository, PrismaParcelRepository, toLocation(), Injectable

### Community 51 - "property.schema.ts"
Cohesion: 0.06
Nodes (35): occupancyTypeSchema, PropertyType, unitStatusSchema, unitTypeSchema, arabicOrLatinName, civilRecordNumber, documentNumber, internationalPhone (+27 more)

### Community 52 - "building-unit-picker.tsx"
Cohesion: 0.12
Nodes (22): BuildingSummaryBadges(), applyStructureType(), BuildingUnitPicker(), currentOccupants(), floorText(), isBlankUnit(), NoLinkOption(), occupancyStatusOf() (+14 more)

### Community 53 - "case.schema.ts"
Cohesion: 0.08
Nodes (20): CASE_FIELD_MAP, CASE_STATUS, CaseStatus, censusLinks, CreateCaseInput, createCaseSchema, notesField, UpdateCaseInput (+12 more)

### Community 54 - "citizen.schema.ts"
Cohesion: 0.10
Nodes (20): ContactDetails, contactDetailsObject, contactDetailsSchema, nonResidentOwnerContactObject, nonResidentOwnerContactSchema, nonResidentOwnerPersonalSchema, PartialContactDetails, partialContactDetailsSchema (+12 more)

### Community 55 - "withConnectionRetry"
Cohesion: 0.08
Nodes (7): Inject, FeesService, Inject, Injectable, PaymentLedgerService, Injectable, withConnectionRetry()

### Community 56 - "auth.schema.ts"
Cohesion: 0.08
Nodes (23): ChangeEmail, changeEmailSchema, ChangePassword, changePasswordSchema, citizenChoiceSchema, ConfirmPasswordReset, confirmPasswordResetSchema, createStaffUserSchema (+15 more)

### Community 57 - "settings-store.ts"
Cohesion: 0.80
Nodes (4): readSettingsSlice(), storageKey(), useSettingsSlice(), writeSettingsSlice()

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
Nodes (21): dependencies, html2canvas, jspdf, lucide-react, @radix-ui/react-checkbox, @radix-ui/react-dropdown-menu, @radix-ui/react-select, @radix-ui/react-slot (+13 more)

### Community 62 - "devDependencies"
Cohesion: 0.10
Nodes (21): devDependencies, autoprefixer, postcss, tailwindcss, tailwindcss-animate, @types/geojson, @types/mapbox-gl, @types/node (+13 more)

### Community 63 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, baseUrl, emitDecoratorMetadata, experimentalDecorators, noUncheckedIndexedAccess, outDir, paths, rootDir (+11 more)

### Community 64 - "citizens.service.ts"
Cohesion: 0.13
Nodes (13): FOLD, foldDigits(), likePattern(), normalizeSearchText(), searchTokens(), citizenColumnsForEdit(), CitizenListAggregate, CitizenListItem (+5 more)

### Community 66 - "deploy.mjs"
Cohesion: 0.15
Nodes (20): Destructive DDL scanner (--allow-destructive), Expand / migrate / contract pattern, appliedRegistry(), appliedTenants(), BACKEND, C, { Client }, DESTRUCTIVE (+12 more)

### Community 67 - "Open decisions register"
Cohesion: 0.50
Nodes (4): Serverless limitations (read-only FS cadastre import, per-instance throttling), Open decisions register, Production hosting and data residency, Legal basis and retention policy (blocking)

### Community 68 - "offline-db.ts"
Cohesion: 0.15
Nodes (18): enqueue(), enqueueBuilding(), QueuedBuilding, QueuedBuildingStatus, QueuedStatus, QueuedSubmission, recordAttempt(), retryLater() (+10 more)

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
Nodes (22): addPeriod(), assessCitizen(), attachOccupancies(), bearsFee(), CitizenAssessment, dueDateInCurrentPeriod(), OccupancyClaimable, PaymentSummary (+14 more)

### Community 74 - "csv.ts"
Cohesion: 0.24
Nodes (11): readFile(), buildCitizenTemplate(), buildCsv(), csvCell(), detectDelimiter(), escapeCell(), parseCitizenCsv(), ParsedCsv (+3 more)

### Community 75 - "OtpService"
Cohesion: 0.15
Nodes (3): OtpService, Injectable, PhoneNumber

### Community 77 - "shared-schemas/package.json"
Cohesion: 0.13
Nodes (14): dependencies, zod, devDependencies, typescript, typescript, zod, main, name (+6 more)

### Community 78 - "sync-production-tenant.mjs"
Cohesion: 0.25
Nodes (8): { Client }, { createClient }, getRef(), main(), MIGRATIONS_DIR, require, ROOT, TABLES

### Community 79 - "CasesController"
Cohesion: 0.19
Nodes (9): CasesController, Body, Controller, Delete, Get, Param, Patch, Post (+1 more)

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

### Community 84 - "TenantContextService"
Cohesion: 0.09
Nodes (20): CensusSyncResult, OCCUPANCY_ROLE_BY_TYPE, UNRESOLVED_SURVEY_STATES, LedgerEntryInput, SettledTotals, TenantContextService, TenantScope, Injectable (+12 more)

### Community 85 - "staff.schema.ts"
Cohesion: 0.17
Nodes (11): staffRoleSchema, InspectorPayoutItem, inspectorPayoutItemSchema, InspectorProfileResponse, inspectorProfileResponseSchema, InspectorPropertyBreakdown, inspectorPropertyBreakdownSchema, InspectorRegistrationLogItem (+3 more)

### Community 86 - "start.mjs"
Cohesion: 0.29
Nodes (9): backend, colorize(), dockerAvailable(), ensureDockerRunning(), handleLine(), pipeLines(), runDevProcess(), statusLine() (+1 more)

### Community 87 - "DocumentService"
Cohesion: 0.25
Nodes (6): DocumentService, Injectable, DocumentController, Controller, Get, Param

### Community 88 - "logApiError"
Cohesion: 0.11
Nodes (36): CASE_TABS, CasesPage(), getTableLabels(), nextStatus(), LandlordOfSection(), InspectorProfilePage(), getTableLabels(), StaffPage() (+28 more)

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
Cohesion: 0.07
Nodes (33): CANDIDATE_SELECT, CARD_SELECT, CardSnapshot, decimalText(), emptyReport(), emptyUnlink(), ENTRY_SELECT, FootprintUnit (+25 more)

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
Cohesion: 0.43
Nodes (7): CitizenFormValues, PropertyDraft, clearCitizenDraft(), key(), loadCitizenDraft(), saveCitizenDraft(), StoredDraft

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

### Community 102 - "TenantService"
Cohesion: 0.20
Nodes (7): TenantService, Inject, Injectable, TenantController, Controller, Get, Param

### Community 103 - "date-picker.tsx"
Cohesion: 0.38
Nodes (6): DatePicker(), DatePickerProps, JumpDropdown(), JumpOption, parseIsoDay(), toIsoDay()

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

### Community 127 - "citizens/page.tsx"
Cohesion: 0.11
Nodes (23): WhatsAppPhoneLink(), CAN_WRITE, CitizensPage(), getTableLabels(), parseAuthHash(), ParsedLink, ResetPasswordPage(), submit() (+15 more)

### Community 149 - "useToast"
Cohesion: 0.11
Nodes (21): ZonesPage(), DraggablePanel(), PanelState, Position, ZoneFormValues, ZoneModal(), DEFAULT_DURATION, ToastApi (+13 more)

### Community 192 - "AuditService"
Cohesion: 0.25
Nodes (3): AuditService, Injectable, OnEvent

### Community 193 - "registration.repository.ts"
Cohesion: 0.21
Nodes (4): SubmitRegistrationResult, isSamePerson(), PrismaRegistrationRepository, Injectable

### Community 194 - "building-unit-forms.tsx"
Cohesion: 0.12
Nodes (24): BuildingBadgeFacts, cellBadge, CellVariant, ConfirmVacancyDialog(), endActionLabel(), EndOccupancyDialog(), EndVacancyDialog(), FOLLOW_UP_CASE (+16 more)

### Community 195 - "zones.service.ts"
Cohesion: 0.19
Nodes (6): describe(), toSummary(), Injectable, ZoneDetail, ZonesService, ZoneSummary

### Community 196 - "Supabase"
Cohesion: 0.11
Nodes (15): Fix suggestion, Source, What happened, Skill Feedback, Steps, Core Principles, Debugging, Making and Committing Schema Changes (+7 more)

### Community 197 - "LandlordLinkService"
Cohesion: 0.13
Nodes (8): block(), emptyFootprint(), fullName(), LandlordLinkService, summarise(), toCandidate(), Injectable, tenantSchemaRef()

### Community 198 - "Changelog"
Cohesion: 0.12
Nodes (16): [1.2.0](https://github.com/supabase/agent-skills/compare/v1.1.1...v1.2.0) (2026-06-02), [1.3.0](https://github.com/supabase/agent-skills/compare/v1.2.0...v1.3.0) (2026-06-05), [1.4.0](https://github.com/supabase/agent-skills/compare/v1.3.0...v1.4.0) (2026-07-10), [1.5.0](https://github.com/supabase/agent-skills/compare/supabase-postgres-best-practices-v1.4.0...supabase-postgres-best-practices-v1.5.0) (2026-07-30), [1.6.0](https://github.com/supabase/agent-skills/compare/supabase-postgres-best-practices-v1.5.0...supabase-postgres-best-practices-v1.6.0) (2026-07-30), Bug Fixes, Bug Fixes, Bug Fixes (+8 more)

### Community 199 - "damage.service.ts"
Cohesion: 0.18
Nodes (7): DamageRow, DamageService, damageSeverity(), SEVERITY, toDamageRow(), Injectable, worstDamage()

### Community 200 - "cadastre-import.service.ts"
Cohesion: 0.07
Nodes (19): CadastreImportResult, CadastreImportService, ParsedLine, ParsedParcel, Inject, Injectable, CadastreAssetsService, Injectable (+11 more)

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

### Community 206 - "TotpService"
Cohesion: 0.14
Nodes (4): Inject, TotpService, OtplibTotpService, Injectable

### Community 207 - "property-entry.entity.ts"
Cohesion: 0.20
Nodes (9): BuildingUnitProps, LandType, NON_OWNER, NOTHING_UNESTABLISHED, OccupancyType, PropertyEntryProps, UnestablishedFields, UnitStatus (+1 more)

### Community 208 - "user.repository.ts"
Cohesion: 0.27
Nodes (5): DisambiguationRequired, SubmitRegistrationInput, CitizenChoice, CitizenIdentityInput, StaffSummary

### Community 209 - "DashboardController"
Cohesion: 0.29
Nodes (5): DashboardController, Controller, Get, Header, Param

### Community 210 - "backfill-parcel-boundaries.ts"
Cohesion: 0.50
Nodes (3): Args, backfillParcelBoundaries(), boundariesFrom()

### Community 211 - "verify"
Cohesion: 0.83
Nodes (3): CitizenLogin(), send(), verify()

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

### Community 218 - "building-editor.tsx"
Cohesion: 0.13
Nodes (24): BuildingEditor(), gridFromUnits(), offlineNow(), STEPS, undeletableReason(), UnitBaseline, loadParcelOutlines(), outlineOf() (+16 more)

### Community 219 - "provision.mjs"
Cohesion: 0.31
Nodes (8): arg(), C, { Client }, inspect(), main(), require, TENANT_MIGRATIONS, withClient()

### Community 220 - "checkPropertyNumber"
Cohesion: 0.67
Nodes (4): PropertyNumberField(), checkPropertyNumber(), parcelCheckKey(), peekPropertyNumberCheck()

### Community 222 - "RegistrationController"
Cohesion: 0.29
Nodes (4): RegistrationController, Controller, Get, Param

### Community 225 - "Supabase Postgres Best Practices"
Cohesion: 0.33
Nodes (5): How to Use, References, Rule Categories by Priority, Supabase Postgres Best Practices, When to Apply

### Community 226 - "db-staging / db-production GitHub Environments"
Cohesion: 0.50
Nodes (5): Deploy production workflow (manual, reviewer-gated), Deploy staging workflow (auto on develop push), Sync tenant to production workflow, db-staging / db-production GitHub Environments, Vercel GitHub App not following repo transfer

### Community 228 - "UnitWithOccupants"
Cohesion: 0.67
Nodes (3): LaidOutUnit, UnitRow, UnitWithOccupants

### Community 229 - ".restore"
Cohesion: 0.40
Nodes (4): readBody(), Post, Query, Req

## Ambiguous Edges - Review These
- `Vercel env vars scoped to one environment` → `Deploying to Vercel runbook`  [AMBIGUOUS]
  docs/deploy-vercel.md · relation: conceptually_related_to
- `Supabase change-email confirmation template` → `Modern Civic Ledger design language`  [AMBIGUOUS]
  supabase/templates/change-email-address.html · relation: conceptually_related_to

## Knowledge Gaps
- **970 isolated node(s):** `supabase-prod`, `supabase-staging`, `handler`, `fs`, `path` (+965 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **76 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Vercel env vars scoped to one environment` and `Deploying to Vercel runbook`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Supabase change-email confirmation template` and `Modern Civic Ledger design language`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `User` connect `User` to `PropertyEntry`, `UserRepository`, `user.repository.ts`, `presentation.module.ts`, `verify`, `IdentityService`?**
  _High betweenness centrality (0.319) - this node is a cross-community bridge._
- **Why does `logApiError()` connect `logApiError` to `backup-section.tsx`, `api-client.ts`, `loadSession`, `building-unit-forms.tsx`, `citizen-editor.tsx`, `fullscreen-map.tsx`, `button.tsx`, `offline-sync.ts`, `cn`, `fees/page.tsx`, `[citizenId]/page.tsx`, `building-editor.tsx`, `verify`, `building-unit-picker.tsx`, `useToast`, `building-unit-matrix-view.tsx`, `(citizen)/page.tsx`, `citizens/page.tsx`?**
  _High betweenness centrality (0.284) - this node is a cross-community bridge._
- **Why does `flagsFromArray()` connect `citizen-editor.tsx` to `button.tsx`, `admin-citizen.schema.ts`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `logApiError()` (e.g. with `CasesPage()` and `FullscreenMap()`) actually correct?**
  _`logApiError()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `supabase-prod`, `supabase-staging`, `handler` to the rest of the system?**
  _970 weakly-connected nodes found - possible documentation gaps or missing edges._