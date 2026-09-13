# Graph Report - mechanization-1  (2026-09-13)

## Corpus Check
- Large corpus: 468 files · ~557,769 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 3464 nodes · 8538 edges · 192 communities (154 shown, 38 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 199 edges (avg confidence: 0.76)
- Token cost: 177,438 input · 0 output

## Community Hubs (Navigation)
- Settings Sections UI
- Admin API Client
- Fees & Citizen Pages
- Tenant Resolution
- Buildings Service
- Staff Map Layers
- Shared UI Buttons
- Registration Write Path
- Audit Trail Events
- Admin Header & Dashboard
- Session & Error Handling
- Citizen Profile & Receipts
- Domain Errors & Staff
- Tenant Context & DB Specs
- Fees Controller
- OTP & TOTP Auth
- Cadastre Import
- Citizens Service & Census Sync
- API Controllers Module
- Reporting & Retry
- Fee Schemas
- Enums & Labels
- Billing Assessment
- Field Flags & Submission
- Unit Matrix UI
- Documents Storage
- Infrastructure Module
- Auth Controller
- Building Schemas
- Backend Dependencies
- Backend Dev Dependencies
- Cases
- Admin Shell Navigation
- Tenant SQL Migrations
- App Bootstrap
- Citizen Editor
- Dashboard Reporting
- Staff Management
- Citizen Controller
- Building Editor
- Offline Sync Queue
- Citizen CSV Import
- DB Target Guards
- Audit Repository
- Buildings Controller
- Locale & Theming
- Frontend TS Config
- Whish Payments
- Citizen Form
- Redis & Session Revocation
- Parcel Repository
- Property Schema
- Property Card UI
- Misc Shared Schemas
- Citizen Schema & Primitives
- Building Unit Picker
- Auth Schemas
- Backup & Zip
- Root Scripts
- Backend Scripts
- SupabaseAuthService cluster
- dependencies cluster
- devDependencies cluster
- compilerOptions cluster
- unit-grid-picker.tsx cluster
- User cluster
- deploy.mjs cluster
- Incident 8.4: production tenant sync copied 5 citizens cluster
- offline-db.ts cluster
- AGENTS.md agent rules cluster
- PrismaUserRepository cluster
- sw.js cluster
- compilerOptions cluster
- ZonesService cluster
- csv.ts cluster
- OtpService cluster
- UserRepository cluster
- shared-schemas/package.json cluster
- sync-production-tenant.mjs cluster
- CasesController cluster
- numbering.ts cluster
- backend/vercel.json cluster
- charts.tsx cluster
- devDependencies cluster
- Building model (first-class, anchored to parcel) cluster
- staff.schema.ts cluster
- start.mjs cluster
- DocumentService cluster
- .import() cluster
- .create() cluster
- (citizen)/page.tsx cluster
- scripts cluster
- overrides cluster
- heldThroughOccupancy billing (P2-T8 authority rule) cluster
- zone.schema.ts cluster
- nest-cli.json cluster
- sync-supabase-templates.mjs cluster
- citizen-draft.ts cluster
- package.json cluster
- shared-schemas/tsconfig.json cluster
- dump-tenant.js cluster
- whish-gateway.service.spec.ts cluster
- TenantController cluster
- date-picker.tsx cluster
- raw-sql-is-schema-qualified.spec.ts cluster
- AuditController cluster
- HealthController cluster
- routing.ts cluster
- middleware.ts cluster
- next.config.mjs cluster
- frontend/vercel.json cluster
- backend/package.json cluster
- census-link.spec.ts cluster
- citizen-import.spec.ts cluster
- DomainExceptionFilter cluster
- app/layout.tsx cluster
- route.ts cluster
- .mcp.json cluster
- CI dependency audit job cluster
- index.js cluster
- @nestjs/core cluster
- @nestjs/schedule cluster
- @nestjs/throttler cluster
- rxjs cluster
- @nestjs/testing cluster
- ts-jest cluster
- @types/express cluster
- registry/migrations/0001_init/migration.sql cluster
- 0002_parcels/migration.sql cluster
- 0006_zones/migration.sql cluster
- next-env.d.ts cluster
- class-variance-authority cluster
- mapbox-gl cluster
- @mechanization/shared-schemas cluster
- next cluster
- next-intl cluster
- next-themes cluster
- qrcode.react cluster
- @radix-ui/react-dialog cluster
- @radix-ui/react-label cluster
- @radix-ui/react-tooltip cluster
- react cluster
- react-dom cluster
- @tanstack/react-query cluster
- zod cluster
- build-check.mjs cluster
- tailwind.config.ts cluster

## God Nodes (most connected - your core abstractions)
1. `cn()` - 205 edges
2. `logApiError()` - 89 edges
3. `Roles()` - 87 edges
4. `SessionClaims` - 73 edges
5. `Button` - 71 edges
6. `CurrentUser` - 66 edges
7. `apiFetch()` - 66 edges
8. `TenantContextService` - 64 edges
9. `loadSession()` - 61 edges
10. `withConnectionRetry()` - 53 edges

## Surprising Connections (you probably didn't know these)
- `Legal basis and retention policy (blocking)` --semantically_similar_to--> `Citizen data never leaves staging`  [INFERRED] [semantically similar]
  docs/open-decisions.md → AGENTS.md
- `Schema-qualified raw SQL behind transaction pooler (D22)` --semantically_similar_to--> `Verify then report (reconnect and count)`  [INFERRED] [semantically similar]
  docs/building-census-plan.md → AGENTS.md
- `flagsFromArray()` --indirect_call--> `isUnestablished()`  [INFERRED]
  apps/frontend/components/ui/field.tsx → packages/shared-schemas/src/field-flag.schema.ts
- `reissue-references command (citizen reference rotation)` --conceptually_related_to--> `Incident 8.4: production tenant sync copied 5 citizens`  [INFERRED]
  README.md → AGENTS.md
- `Supabase change-email confirmation template` --conceptually_related_to--> `Modern Civic Ledger design language`  [AMBIGUOUS]
  supabase/templates/change-email-address.html → DESIGN.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Production migration safety gates** — _github_workflows_deploy_production_migrate, docs_database_environments_db_github_environments, scripts_db_targets, docs_database_environments_promotion_check, docs_database_environments_destructive_ddl_scanner [EXTRACTED 1.00]
- **Census occupancy to billing flow** — docs_building_census_plan_census_sync_service, docs_building_census_plan_unitoccupancy, docs_building_census_plan_held_through_occupancy, docs_open_decisions_landlord_link, docs_open_decisions_fee_bearer [INFERRED 0.85]
- **Building census data model (D1-D4)** — docs_building_census_plan_building, docs_building_census_plan_unit, docs_building_census_plan_unitoccupancy, docs_building_census_plan_damageassessment, docs_building_census_plan_building_lifecycle [EXTRACTED 1.00]

## Communities (192 total, 38 thin omitted)

### Community 0 - "Settings Sections UI"
Cohesion: 0.05
Nodes (86): AccountSecurityPage(), SectionDef, SectionId, SECTIONS, SettingsPage(), ArchiveInspection, DEFAULT_SCHEDULE, EMPTY_HISTORY (+78 more)

### Community 1 - "Admin API Client"
Cohesion: 0.04
Nodes (93): InspectorProfilePage(), FullscreenMap, FullscreenMapPage(), getTableLabels(), StaffPage(), ZoneEditorMap, ZonesPage(), CitizenLogin() (+85 more)

### Community 2 - "Fees & Citizen Pages"
Cohesion: 0.05
Nodes (81): AuditTrailPage(), ENTITY_TYPES, CAN_WRITE, CitizensPage(), getTableLabels(), FeesPage(), getStatusFilters(), getTableLabels() (+73 more)

### Community 3 - "Tenant Resolution"
Cohesion: 0.05
Nodes (24): OtpCleanupJob, Inject, Injectable, Inject, PublicTenantConfig, PROPS, TenantService, Inject (+16 more)

### Community 4 - "Buildings Service"
Cohesion: 0.06
Nodes (33): BuildingLedgerRow, BuildingListFilter, BuildingMapPin, BuildingRow, CensusSummary, CreateBuildingRow, CreateUnitRow, DamageRow (+25 more)

### Community 5 - "Staff Map Layers"
Cohesion: 0.05
Nodes (69): BUILDING_LAYER, BUILDING_SOURCE, BUILDING_ZOOM, buildingLegend(), buildingsGeoJson(), DAMAGE_COLORS, DAMAGE_SEVERITY, damageRingExpression() (+61 more)

### Community 6 - "Shared UI Buttons"
Cohesion: 0.10
Nodes (40): Stage, ChargeCitizenDialog(), EMPTY, formatLbp(), STEPS, BEARER_ICON, EMPTY, formatLbp() (+32 more)

### Community 7 - "Registration Write Path"
Cohesion: 0.04
Nodes (29): PropertyNumberCheck, RegistrationService, SubmitResult, Inject, Injectable, unestablishedOnCard(), AggregateRoot, DomainEvent (+21 more)

### Community 8 - "Audit Trail Events"
Cohesion: 0.05
Nodes (37): AuditService, Injectable, OnEvent, TenantSlug, assertSafeSchemaName(), loadTenantMigrations(), migrateTenantSchema(), MIGRATIONS_DIR (+29 more)

### Community 9 - "Admin Header & Dashboard"
Cohesion: 0.05
Nodes (56): count(), DEFAULT_FOLDED, DetailRow(), FoldSection(), KPI_TONES, KpiCard(), moneyAxis(), monthLabels() (+48 more)

### Community 10 - "Session & Error Handling"
Cohesion: 0.07
Nodes (48): StaffLogin(), submit(), BuildingsPage(), DAMAGED_LEVELS, FilterSelect(), getTableLabels(), MetricCard(), READ_ONLY_ROLES (+40 more)

### Community 11 - "Citizen Profile & Receipts"
Cohesion: 0.05
Nodes (49): CitizenProfilePage(), FactItem, FactSection(), FeesPanel(), flagFieldLabel(), PAYMENT_TONE, present(), PROPERTY_ICON (+41 more)

### Community 12 - "Domain Errors & Staff"
Cohesion: 0.07
Nodes (28): LandlordCandidate, LandlordLinkResult, actor, SessionResult, LOGIN, SUPABASE_OK, CitizenProps, StaffProps (+20 more)

### Community 13 - "Tenant Context & DB Specs"
Cohesion: 0.06
Nodes (25): BackupService, NEVER_RESTORED, RestoreReport, sanitizeRowForSnapshot(), Snapshot, SnapshotManifest, TABLE_ORDER, TableName (+17 more)

### Community 14 - "Fees Controller"
Cohesion: 0.07
Nodes (12): FeesService, Injectable, FeesController, Body, Controller, Get, Param, Patch (+4 more)

### Community 15 - "OTP & TOTP Auth"
Cohesion: 0.05
Nodes (18): Inject, OtpIssueResult, Inject, Inject, OtpChallengeRow, OtpChannel, OtpRepository, PasswordHasher (+10 more)

### Community 16 - "Cadastre Import"
Cohesion: 0.07
Nodes (38): CadastreImportService, Injectable, average(), Cadastre, CadastreLine, extractKmlFromZip(), findEndOfCentralDirectory(), inflateEntry() (+30 more)

### Community 17 - "Citizens Service & Census Sync"
Cohesion: 0.06
Nodes (19): FOLD, foldDigits(), likePattern(), normalizeSearchText(), searchTokens(), CensusSyncService, Injectable, CitizenListAggregate (+11 more)

### Community 18 - "API Controllers Module"
Cohesion: 0.09
Nodes (21): ZodValidationPipe, DisambiguationRequired, TotpChallengeRequired, CitizenChoice, APP_CONFIG, BackupController, readBody(), Controller (+13 more)

### Community 19 - "Reporting & Retry"
Cohesion: 0.06
Nodes (25): SEVERITY, CitizenFeeTotals, CitizenProfile, CitizenProfileDocument, CitizenProfilePayment, CitizenProfileProperty, CitizenProfileRegistration, CitizenProfileUnit (+17 more)

### Community 20 - "Fee Schemas"
Cohesion: 0.04
Nodes (48): BackupSchedule, ChargeCitizen, chargeCitizenSchema, CreateFeeNotice, createFeeNoticeSchema, CURRENCY_CODES, CurrencyCode, DeclarePayment (+40 more)

### Community 21 - "Enums & Labels"
Cohesion: 0.06
Nodes (36): BloodType, BUILDING_LIFECYCLE, BuildingLifecycle, CASE_TYPE, CaseType, DAMAGE_LEVEL, DAMAGE_SOURCE, DamageLevel (+28 more)

### Community 22 - "Billing Assessment"
Cohesion: 0.07
Nodes (26): Cron, RecurringBillingJob, Cron, Injectable, addPeriod(), assessCitizen(), attachOccupancies(), bearsFee() (+18 more)

### Community 23 - "Field Flags & Submission"
Cohesion: 0.07
Nodes (42): AdminCitizenSubmission, AdminCitizenUpdateSubmission, AdminCreateCitizen, adminCreateCitizenSchema, adminCreateCitizenSubmissionSchema, AdminUpdateCitizen, adminUpdateCitizenSchema, adminUpdateCitizenSubmissionSchema (+34 more)

### Community 24 - "Unit Matrix UI"
Cohesion: 0.12
Nodes (40): BuildingBadgeFacts, BuildingSummaryBadges(), CaseForm(), cellBadge(), DamageForm(), floorLabel(), groupUnitsByFloor(), occupancyMessage() (+32 more)

### Community 25 - "Documents Storage"
Cohesion: 0.08
Nodes (15): DocumentSlot, IncomingFile, Inject, ALLOWED_MIME_TYPES, Document, DocumentProps, DocumentType, DocumentRepository (+7 more)

### Community 26 - "Infrastructure Module"
Cohesion: 0.09
Nodes (24): CadastreImportResult, ParsedLine, ParsedParcel, ZoneDetail, ZoneSummary, AUDIT_REPOSITORY, BaseRepository, CASE_REPOSITORY (+16 more)

### Community 27 - "Auth Controller"
Cohesion: 0.12
Nodes (11): IdentityService, normalisePhone(), Injectable, AuthController, Body, Controller, Param, Post (+3 more)

### Community 28 - "Building Schemas"
Cohesion: 0.05
Nodes (37): basementsCount, BuildingFilter, buildingFilterSchema, buildingName, coordinatePair(), CreateBuildingInput, createBuildingSchema, CreateDamageAssessmentInput (+29 more)

### Community 29 - "Backend Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, bcrypt, compression, helmet, ioredis, @mechanization/shared-schemas, @nestjs/common, @nestjs/config (+29 more)

### Community 30 - "Backend Dev Dependencies"
Cohesion: 0.05
Nodes (37): devDependencies, jest, @nestjs/cli, @nestjs/schematics, prisma, supertest, ts-node, tsconfig-paths (+29 more)

### Community 31 - "Cases"
Cohesion: 0.09
Nodes (10): CasesService, Inject, Injectable, Case, CaseCensusLinks, CaseListFilter, CaseRepository, PrismaCaseRepository (+2 more)

### Community 32 - "Admin Shell Navigation"
Cohesion: 0.11
Nodes (25): getTenantName(), ProtectedAdminLayout(), AdminHeader(), signOut(), AdminShell(), AdminSidebar(), foldListeners, hydrateFolds() (+17 more)

### Community 33 - "Tenant SQL Migrations"
Cohesion: 0.09
Nodes (26): "audit_log_entries", audit_log_entries_no_delete, audit_log_entries_no_update, "documents", "otp_challenges", "property_entries", "registrations", reject_audit_mutation() (+18 more)

### Community 34 - "App Bootstrap"
Cohesion: 0.08
Nodes (20): AppModule, Module, ApplicationModule, Module, DomainModule, Module, InfrastructureModule, Module (+12 more)

### Community 35 - "Citizen Editor"
Cohesion: 0.11
Nodes (25): mintId(), announceCensus(), censusConcerns(), censusDraft(), CitizenEditor(), floorLabel(), fromCaseDraft(), NewBuildingUnits (+17 more)

### Community 36 - "Dashboard Reporting"
Cohesion: 0.10
Nodes (9): csvCell(), ReportingService, Injectable, OnEvent, DashboardController, Controller, Get, Header (+1 more)

### Community 37 - "Staff Management"
Cohesion: 0.11
Nodes (10): StaffService, Injectable, StaffController, Body, Controller, Delete, Get, Param (+2 more)

### Community 38 - "Citizen Controller"
Cohesion: 0.15
Nodes (12): Get, CitizenController, mask(), Body, Controller, Delete, Get, Param (+4 more)

### Community 39 - "Building Editor"
Cohesion: 0.10
Nodes (24): BuildingEditor(), gridFromUnits(), offlineNow(), STEPS, undeletableReason(), UnitBaseline, FALLBACK_CENTER, loadParcelOutlines() (+16 more)

### Community 40 - "Offline Sync Queue"
Cohesion: 0.16
Nodes (28): BuildingQueueNotice(), createBuilding(), generateUnits(), dequeue(), getQueued(), listQueued(), listQueuedBuildings(), offlineStorageAvailable() (+20 more)

### Community 41 - "Citizen CSV Import"
Cohesion: 0.08
Nodes (29): buildCitizenPayload(), CitizenImportRequest, CitizenImportResult, CitizenImportRowResult, citizenImportSchema, IMPORT_BATCH_SIZE, IMPORT_COLUMN_KEYS, IMPORT_COLUMNS (+21 more)

### Community 42 - "DB Target Guards"
Cohesion: 0.12
Nodes (20): CI verify job (typecheck, test, build), Supabase projects: production thbgwfbcqdougbjvgvyw, staging lzgbjcwtzqyrbeoolvdz, arg(), C, { Client }, inspect(), main(), require (+12 more)

### Community 43 - "Audit Repository"
Cohesion: 0.12
Nodes (9): AuditLogEntry, AuditLogEntryProps, REDACTED_KEYS, AuditQuery, AuditRepository, AuditRow, tenantSchemaRef(), PrismaAuditRepository (+1 more)

### Community 44 - "Buildings Controller"
Cohesion: 0.19
Nodes (12): SessionClaims, BuildingsController, Body, Controller, Delete, Get, Param, Patch (+4 more)

### Community 45 - "Locale & Theming"
Cohesion: 0.11
Nodes (20): CitizenLayout(), getTenant(), dynamic, generateMetadata(), getTenant(), safeHslTriple(), TenantLayout(), AccentContext (+12 more)

### Community 46 - "Frontend TS Config"
Cohesion: 0.07
Nodes (27): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+19 more)

### Community 47 - "Whish Payments"
Cohesion: 0.11
Nodes (13): CitizenAssessment, OccupancyClaimable, PaymentSummary, PROPERTY_TYPE_CATEGORIES, UnassessableCitizen, Row, UNTOUCHED, WHISH_GATEWAY (+5 more)

### Community 48 - "Citizen Form"
Cohesion: 0.11
Nodes (25): AskableField, askableFields(), askablePaths(), CitizenForm(), handleSubmit(), emptyCitizen(), FormSection(), isBlank() (+17 more)

### Community 49 - "Redis & Session Revocation"
Cohesion: 0.11
Nodes (8): Inject, SessionRevocationService, Injectable, MemoryCacheEntry, RedisCacheService, Injectable, JwtAuthGuard, Injectable

### Community 50 - "Parcel Repository"
Cohesion: 0.10
Nodes (8): Inject, Inject, ParcelLocation, ParcelRepository, tenantSchemaPrefix(), PrismaParcelRepository, toLocation(), Injectable

### Community 51 - "Property Schema"
Cohesion: 0.08
Nodes (24): occupancyTypeSchema, unitStatusSchema, unitTypeSchema, areaField, BUILDING_UNIT_FIELDS, BuildingUnit, buildingUnitSchema, buildingUnitsSchema (+16 more)

### Community 52 - "Property Card UI"
Cohesion: 0.17
Nodes (21): LandlordMatchHint(), changePropertyType(), PropertyCard(), PropertyNumberField(), summarise(), UnitDraft, vacancyNote(), flagPath() (+13 more)

### Community 53 - "Misc Shared Schemas"
Cohesion: 0.08
Nodes (20): CASE_FIELD_MAP, CASE_STATUS, CaseStatus, censusLinks, CreateCaseInput, createCaseSchema, notesField, UpdateCaseInput (+12 more)

### Community 54 - "Citizen Schema & Primitives"
Cohesion: 0.10
Nodes (23): ContactDetails, contactDetailsObject, contactDetailsSchema, PartialContactDetails, partialContactDetailsSchema, PartialPersonalDetails, partialPersonalDetailsSchema, PersonalDetails (+15 more)

### Community 55 - "Building Unit Picker"
Cohesion: 0.14
Nodes (21): applyStructureType(), BuildingUnitPicker(), currentOccupants(), floorText(), isBlankUnit(), LinkedBuildingFacts, LockedCensusTarget, occupancyStatusOf() (+13 more)

### Community 56 - "Auth Schemas"
Cohesion: 0.08
Nodes (23): ChangeEmail, changeEmailSchema, ChangePassword, changePasswordSchema, citizenChoiceSchema, ConfirmPasswordReset, confirmPasswordResetSchema, createStaffUserSchema (+15 more)

### Community 57 - "Backup & Zip"
Cohesion: 0.13
Nodes (20): BackupSection(), formatBytes(), nextRunAt(), exportSnapshot(), restoreSnapshot(), readSettingsSlice(), storageKey(), useSettingsSlice() (+12 more)

### Community 58 - "Root Scripts"
Cohesion: 0.09
Nodes (22): scripts, auth:sync-templates, build, build:check, db:check, db:deploy:local, db:deploy:production, db:deploy:staging (+14 more)

### Community 59 - "Backend Scripts"
Cohesion: 0.10
Nodes (21): scripts, backfill:boundaries, backfill:buildings, build, cadastre:import, dev, lint, prisma:deploy:registry (+13 more)

### Community 60 - "SupabaseAuthService cluster"
Cohesion: 0.14
Nodes (5): SupabaseAuthResult, SupabaseAuthService, SupabaseAuthUser, SupabaseAuthServiceImpl, Injectable

### Community 61 - "dependencies cluster"
Cohesion: 0.10
Nodes (21): dependencies, clsx, html2canvas, jspdf, lucide-react, @radix-ui/react-checkbox, @radix-ui/react-dropdown-menu, @radix-ui/react-select (+13 more)

### Community 62 - "devDependencies cluster"
Cohesion: 0.10
Nodes (21): devDependencies, autoprefixer, postcss, tailwindcss, tailwindcss-animate, @types/geojson, @types/mapbox-gl, @types/node (+13 more)

### Community 63 - "compilerOptions cluster"
Cohesion: 0.10
Nodes (19): compilerOptions, baseUrl, emitDecoratorMetadata, experimentalDecorators, noUncheckedIndexedAccess, outDir, paths, rootDir (+11 more)

### Community 64 - "unit-grid-picker.tsx cluster"
Cohesion: 0.12
Nodes (18): floorLabel(), cellsOverlap(), DEFAULT_HORIZONTAL_BLOCKS, DEFAULT_VERTICAL_BLOCKS, highestOccupied(), MAX_BASEMENT_BLOCKS, MAX_GRID_SIZE, MAX_VERTICAL_BLOCKS (+10 more)

### Community 66 - "deploy.mjs cluster"
Cohesion: 0.18
Nodes (18): appliedRegistry(), appliedTenants(), BACKEND, C, { Client }, DESTRUCTIVE, main(), migrationFolders() (+10 more)

### Community 67 - "Incident 8.4: production tenant sync copied 5 citizens cluster"
Cohesion: 0.12
Nodes (18): Citizen data never leaves staging, Incident 8.3: Prisma quietly reloads .env, Incident 8.4: production tenant sync copied 5 citizens, Incident 8.6: flaky collision test trained CI retries, Never SET session_replication_role = replica, Schema-per-tenant multi-tenancy (tenant_<slug>), Verify then report (reconnect and count), Schema-qualified raw SQL behind transaction pooler (D22) (+10 more)

### Community 68 - "offline-db.ts cluster"
Cohesion: 0.18
Nodes (16): dequeueBuilding(), enqueue(), enqueueBuilding(), QueuedBuildingStatus, QueuedStatus, recordAttempt(), retryLater(), reviseQueued() (+8 more)

### Community 69 - "AGENTS.md agent rules cluster"
Cohesion: 0.14
Nodes (17): AGENTS.md agent rules, Applied migrations are immutable (fix forward), A blocked action is an answer, Incident 8.2: migration 0026 expand+backfill+drop in one file, Incident 8.5: Vercel previews wrote to production, Incident 8.7: SMS key guard enforced nothing, Name the target (no bare prisma migrate deploy), Backend API landing page (+9 more)

### Community 71 - "sw.js cluster"
Cohesion: 0.12
Nodes (12): Offline fallback page, CURRENT, offlinePageFor(), Core civic palette (navy, ivory, cedar green, amber, crimson), Modern Civic Ledger design language, Typography architecture (Alexandria, Readex Pro, tabular numerals), Duplicate-structure guard (acknowledgedDuplicates), No parcel-centroid default pin (D19) (+4 more)

### Community 72 - "compilerOptions cluster"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noImplicitAny (+8 more)

### Community 73 - "ZonesService cluster"
Cohesion: 0.24
Nodes (4): describe(), toSummary(), Injectable, ZonesService

### Community 74 - "csv.ts cluster"
Cohesion: 0.18
Nodes (13): ImportCitizensDialog(), readFile(), buildCitizenTemplate(), buildCsv(), csvCell(), detectDelimiter(), downloadCsv(), escapeCell() (+5 more)

### Community 75 - "OtpService cluster"
Cohesion: 0.15
Nodes (3): OtpService, Injectable, PhoneNumber

### Community 77 - "shared-schemas/package.json cluster"
Cohesion: 0.13
Nodes (14): dependencies, zod, devDependencies, typescript, typescript, zod, main, name (+6 more)

### Community 78 - "sync-production-tenant.mjs cluster"
Cohesion: 0.16
Nodes (13): Deploy production workflow (manual, reviewer-gated), Deploy staging workflow (auto on develop push), Sync tenant to production workflow, db-staging / db-production GitHub Environments, Vercel GitHub App not following repo transfer, { Client }, { createClient }, getRef() (+5 more)

### Community 79 - "CasesController cluster"
Cohesion: 0.19
Nodes (9): CasesController, Body, Controller, Delete, Get, Param, Patch, Post (+1 more)

### Community 80 - "numbering.ts cluster"
Cohesion: 0.20
Nodes (11): buildingSuffixAt(), clamp(), firstMagnitude(), fold(), formatUnitCode(), nextBuildingSuffix(), ORDINALS, pad() (+3 more)

### Community 81 - "backend/vercel.json cluster"
Cohesion: 0.15
Nodes (12): includeFiles, maxDuration, memory, buildCommand, crons, framework, functions, api/index.js (+4 more)

### Community 82 - "charts.tsx cluster"
Cohesion: 0.26
Nodes (11): axisLabelStride(), ChartCard(), ColumnChart(), ColumnDatum, columnPath(), GroupedColumnChart(), GroupedDatum, HoverState (+3 more)

### Community 83 - "devDependencies cluster"
Cohesion: 0.15
Nodes (13): eslint, @eslint/js, eslint-plugin-react-hooks, globals, @next/eslint-plugin-next, devDependencies, eslint, @eslint/js (+5 more)

### Community 84 - "Building model (first-class, anchored to parcel) cluster"
Cohesion: 0.18
Nodes (12): Building Census implementation plan, Building model (first-class, anchored to parcel), Building code ZONE-PARCEL-SUFFIX, BuildingLifecycle third axis (BAG pand lifecycle), DamageAssessment append-only log (UN-Habitat scale), floorsCount as ceiling on toFloor (Phase 7), Subdivision and deed modelling deferred (D20), Unit model (canonical unit, survey status state machine) (+4 more)

### Community 85 - "staff.schema.ts cluster"
Cohesion: 0.17
Nodes (11): staffRoleSchema, InspectorPayoutItem, inspectorPayoutItemSchema, InspectorProfileResponse, inspectorProfileResponseSchema, InspectorPropertyBreakdown, inspectorPropertyBreakdownSchema, InspectorRegistrationLogItem (+3 more)

### Community 86 - "start.mjs cluster"
Cohesion: 0.29
Nodes (9): backend, colorize(), dockerAvailable(), ensureDockerRunning(), handleLine(), pipeLines(), runDevProcess(), statusLine() (+1 more)

### Community 87 - "DocumentService cluster"
Cohesion: 0.25
Nodes (6): DocumentService, Injectable, DocumentController, Controller, Get, Param

### Community 88 - ".import() cluster"
Cohesion: 0.20
Nodes (8): CadastreController, Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors

### Community 89 - ".create() cluster"
Cohesion: 0.22
Nodes (6): Body, Get, Header, Param, Post, Put

### Community 90 - "(citizen)/page.tsx cluster"
Cohesion: 0.44
Nodes (9): TenantHome(), openByReference(), allows(), formatReference(), GROUPS, isCompleteReference(), nextReferenceValue(), REFERENCE_RAW_LENGTH (+1 more)

### Community 91 - "scripts cluster"
Cohesion: 0.18
Nodes (10): name, private, scripts, build, build:check, dev, lint, start (+2 more)

### Community 92 - "overrides cluster"
Cohesion: 0.18
Nodes (11): body-parser@1, brace-expansion@1, brace-expansion@2, lodash, multer, nanoid@3, postcss, qs@6 (+3 more)

### Community 93 - "heldThroughOccupancy billing (P2-T8 authority rule) cluster"
Cohesion: 0.24
Nodes (10): users table holds STAFF and CITIZEN via kind enum, CensusSyncService (registration completes the census), heldThroughOccupancy billing (P2-T8 authority rule), UnitOccupancy join table, InternalCronController HTTP cron (CRON_SECRET), Duplicate-person tolerance (identityDocType + number key), Fee basis FLAT / PER_UNIT / PER_AREA, Fee bearer OCCUPANT vs OWNER (+2 more)

### Community 94 - "zone.schema.ts cluster"
Cohesion: 0.20
Nodes (9): CreateZoneInput, createZoneSchema, parcelNumberField, parcelNumbersField, UpdateZoneInput, updateZoneSchema, zoneCodeField, zoneColorField (+1 more)

### Community 95 - "nest-cli.json cluster"
Cohesion: 0.22
Nodes (8): collection, compilerOptions, assets, deleteOutDir, watchAssets, entryFile, $schema, sourceRoot

### Community 96 - "sync-supabase-templates.mjs cluster"
Cohesion: 0.22
Nodes (7): changeEmailContent, changeEmailPath, __dirname, __filename, resetPasswordContent, resetPasswordPath, rootDir

### Community 97 - "citizen-draft.ts cluster"
Cohesion: 0.43
Nodes (7): CitizenFormValues, clearCitizenDraft(), draftWorthKeeping(), key(), loadCitizenDraft(), saveCitizenDraft(), StoredDraft

### Community 98 - "package.json cluster"
Cohesion: 0.25
Nodes (7): engines, node, name, packageManager, pnpm, private, version

### Community 99 - "shared-schemas/tsconfig.json cluster"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src/**/*, ../../tsconfig.base.json

### Community 100 - "dump-tenant.js cluster"
Cohesion: 0.29
Nodes (5): { Client }, env, fs, path, TABLES

### Community 101 - "whish-gateway.service.spec.ts cluster"
Cohesion: 0.43
Nodes (4): configWith(), live(), liveWithoutSecret(), sandbox()

### Community 102 - "TenantController cluster"
Cohesion: 0.38
Nodes (4): TenantController, Controller, Get, Param

### Community 103 - "date-picker.tsx cluster"
Cohesion: 0.38
Nodes (6): DatePicker(), DatePickerProps, JumpDropdown(), JumpOption, parseIsoDay(), toIsoDay()

### Community 105 - "AuditController cluster"
Cohesion: 0.33
Nodes (4): AuditController, Controller, Get, Query

### Community 106 - "HealthController cluster"
Cohesion: 0.40
Nodes (3): HealthController, Controller, Get

### Community 107 - "routing.ts cluster"
Cohesion: 0.47
Nodes (4): defaultLocale, isLocale(), Locale, locales

### Community 108 - "middleware.ts cluster"
Cohesion: 0.47
Nodes (5): apiOrigin(), config, contentSecurityPolicy(), LOCALES, middleware()

### Community 109 - "next.config.mjs cluster"
Cohesion: 0.40
Nodes (4): nextConfig, onVercel, SECURITY_HEADERS, withNextIntl

### Community 110 - "frontend/vercel.json cluster"
Cohesion: 0.40
Nodes (4): buildCommand, framework, installCommand, $schema

### Community 111 - "backend/package.json cluster"
Cohesion: 0.50
Nodes (3): name, private, version

### Community 113 - "citizen-import.spec.ts cluster"
Cohesion: 0.67
Nodes (3): BASE, expectAccepted(), parse()

## Ambiguous Edges - Review These
- `Modern Civic Ledger design language` → `Supabase change-email confirmation template`  [AMBIGUOUS]
  supabase/templates/change-email-address.html · relation: conceptually_related_to
- `Vercel env vars scoped to one environment` → `Deploying to Vercel runbook`  [AMBIGUOUS]
  docs/deploy-vercel.md · relation: conceptually_related_to

## Knowledge Gaps
- **830 isolated node(s):** `supabase-prod`, `supabase-staging`, `handler`, `fs`, `path` (+825 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **38 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Modern Civic Ledger design language` and `Supabase change-email confirmation template`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Vercel env vars scoped to one environment` and `Deploying to Vercel runbook`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `User` connect `User cluster` to `Admin API Client`, `Registration Write Path`, `Session & Error Handling`, `Domain Errors & Staff`, `UserRepository cluster`, `API Controllers Module`, `Auth Controller`?**
  _High betweenness centrality (0.325) - this node is a cross-community bridge._
- **Why does `logApiError()` connect `Session & Error Handling` to `Settings Sections UI`, `Admin API Client`, `Fees & Citizen Pages`, `Citizen Editor`, `Staff Map Layers`, `Shared UI Buttons`, `Building Editor`, `Offline Sync Queue`, `Admin Header & Dashboard`, `Citizen Profile & Receipts`, `Property Card UI`, `Building Unit Picker`, `Unit Matrix UI`, `Backup & Zip`, `(citizen)/page.tsx cluster`?**
  _High betweenness centrality (0.283) - this node is a cross-community bridge._
- **Why does `flagsFromArray()` connect `Citizen Editor` to `Shared UI Buttons`, `Field Flags & Submission`?**
  _High betweenness centrality (0.121) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `logApiError()` (e.g. with `CasesPage()` and `FullscreenMap()`) actually correct?**
  _`logApiError()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `supabase-prod`, `supabase-staging`, `handler` to the rest of the system?**
  _830 weakly-connected nodes found - possible documentation gaps or missing edges._