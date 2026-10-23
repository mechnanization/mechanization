# apps/backend — the NestJS API

Last verified against the code: `feat/tiered-fees-debtor-views` (on `feat/tiered-fees-shared-bills@a90a70a`, uncommitted): a debtor's shared bills in every read of what a person owes (`billsOwedBy`), bulk settlement naming the payer, `SHARED_BILL_PAY_AT_OFFICE`, correction bills without `TIERED_AREA`, 2026-10-23; `feat/tiered-fees-shared-bills` (on `feat/tiered-fees-matrix-engine@60b00e2`, uncommitted): shared unit bills issued and recurring (`writeBills`), the payer on a shared bill's receipt, the readers of a bill's citizen, the merge's debtor rows, backup version 5, 2026-10-23; `feat/tiered-fees-matrix-engine` (on `chore/migration-0098-0099@a5539a5`, uncommitted): `TIERED_AREA` pricing, the shared unit bill, `planNotice` and the notice preview, 2026-10-23; `feat/duplex-merge` (stacked on `feat/unit-levels`): «دمج كدوبلكس» and `UNIT_LEVELS_TO_CONFIRM`, D28, 2026-10-17; `feat/unit-levels` (stacked on `chore/migration-0095`, on `develop@a7e62087`): duplexes and the per-roof factor, a house that grows, D28, 2026-10-17; `fix/pr115-review` (PRs #123, #124 and #115 stacked on `develop@5e8f5c3`, each with its review fixes): the cadastre import deviation, the cadastre asset's private cache, `GET auth/staff/me`, the own-account throttle, the save-path unlink rows, `assertFileOpen`; the audit reads' `?actorId=` and its «النظام» value, the review queue's total, a registration card's missing building, 2026-10-15; and `bugs-fix` (on `develop@5e8f5c3`; the finance audit remediation: `settleInPerson` in one transaction with the rate read FOR SHARE, `lockExternalRef` and a ledger retry key bound to its act, the Whish callback closed with its money, `cancelBill`, the notice retry key, the one-off charge and the settings save in Tier 1, the salary month and ceiling), 2026-10-12; the review of PR #120 (a Whish reference cleaned when stored and folded in SQL, a cancelled bill named in every owed filter, the recurring-run route has no screen) against `fix/finance-audit-remediation` rebased on `chore/migration-0090-0091@8d386b5`, 2026-10-13; `FEE_ISSUE_ROLES` without the collector and `FEE_SETTLE_ROLES` for the settle, the bill-raising routes pinned on `fix/fees-page-ux` from `develop@5e8f5c3` (uncommitted), 2026-10-12; `GET treasury/movements` («الإيرادات والنفقات»: `TreasuryMovementsService`, `IncomeService.viewsByIds` / `ExpensesService.viewsByIds`, `TreasuryController.movements` pinned; after review, one REPEATABLE READ snapshot and `page` capped) on `fix/fees-page-ux` (uncommitted), 2026-10-12; its screen renamed «الحركات المالية» the same day; municipal requests (`CitizenRequestsService`, `CitizenRequestsController`, the `REQUEST_FILE_STORAGE` port, `raiseOneOffBill`, `sniffAttachment`, `REQUEST_*_ROLES` pinned, a merge moving requests) on `fix/fees-page-ux` (uncommitted), 2026-10-13; online payment paused by the product owner the same day (`ONLINE_PAYMENT_UNAVAILABLE` on the Whish checkout and a citizen's own request bill while the gateway is not live; what an undeclared `WHISH_*` in `.env` really does) (uncommitted); and, on `fix/fees-page-ux` rebased onto `chore/migration-0092@16473f0` (2026-10-13), the review of PR #122: a request cancelled with its bill (`cancelRequestOfCancelledBill`), a card or a flat a request names never deleted (`PROPERTY_NAMED_BY_REQUEST`, `HAS_REQUESTS`), request bills stamp `issuedById`, the API's log lines without query strings, and the isolation tests; and, on `fix/pr122-review` (2026-10-15), the review's blocker and majors: `cancelBill`'s answer carries `cancelledRequest`, the profile's bills carry `request` (kept in `mySummary`, the citizen's own), and `FeesService.declare` refuses anything but a Whish Money report with its reference (`PAYMENT_DECLARATION_WHISH_ONLY`).

NestJS 10, Prisma 5, zod 3. Read the root [CLAUDE.md](../../CLAUDE.md) first. Database rules: [docs/database.md](../../docs/database.md).
Security rules and the endpoint checklist: [docs/security.md](../../docs/security.md). This file covers how the backend is built.

## Layers and the dependency rule

Dependencies point inward: presentation → application → domain. Infrastructure implements domain ports
and is bound in `InfrastructureModule`.

| Layer | Path | Holds | May import |
|---|---|---|---|
| Domain | `src/domain` | entities, value objects, ports and their DI symbols (`domain/interfaces/base-repository.interface.ts`), `DomainError` | nothing outside domain (holds today) |
| Application | `src/application` | services in `application/features/<area>/`, jobs in `application/background-jobs`, `application/common` (exceptions, `ZodValidationPipe`, search terms) | domain, plus the infrastructure entry points below |
| Infrastructure | `src/infrastructure` | Prisma clients, tenant context, repositories, S3, SMTP, SMS, Whish, bcrypt, otplib, Redis | domain |
| Presentation | `src/presentation` | controllers, guards, decorators, middleware, the filter, config, `main.ts` | application, domain |

Data access for new code (decided):
- Application services use Prisma through the `prisma` getter of `TenantContextService` and run
  multi-step writes through `runInTenantTransaction`. Query-level rules (house getters, raw SQL,
  `select`): [docs/database.md](../../docs/database.md#query-style).
- Existing repository ports (`USER_REPOSITORY`, `REGISTRATION_REPOSITORY`, `CASE_REPOSITORY` and the
  rest in `base-repository.interface.ts`) stay, and the services that use them keep using them
  (`CasesService` uses `CASE_REPOSITORY`). A new feature does not add a port. **Undecided:** whether a
  new query on an aggregate that already has a port (users, registrations) goes on the port or in the
  service.
- Application code MAY import from infrastructure only: `TenantContextService` and `TenantScope`,
  `runInTenantTransaction`, `tenantSchemaRef` / `tenantSchemaPrefix`, `withConnectionRetry` /
  `isTransientConnectionError`, `RedisCacheService`, `citizenPhoneRuleError` /
  `violatedCheckConstraint` / `closedTreasuryDay` (`infrastructure/prisma/check-violation.ts`, which turn
  the `0072` CHECKs' refusal into a coded `ValidationError` and read the day a `0082` trigger refused), and types or the `Prisma` namespace from
  `src/generated/tenant-client`. `TenantPrismaFactory` only in a background job that builds a tenant scope.
- Application code MUST NOT import a `Prisma*Repository`, an adapter (`S3StorageService`,
  `SmtpEmailSender`, `SmsProviderService`, `WhishGatewayService`, `BcryptPasswordHasher`,
  `OtplibTotpService`) or `RegistryPrismaService`. Inject the port symbol (`IMAGE_STORAGE_SERVICE`,
  `EMAIL_SENDER`, `PASSWORD_HASHER`, …) instead.
- Presentation MUST NOT touch Prisma, except at the two composition points: `TenantMiddleware`
  (`TenantContextService`, `TenantPrismaFactory`) and `HealthController` (`RegistryPrismaService`).
- Deviations today (`ZonesService` → `CadastreAssetsService`, `CadastreImportService` →
  `buildCadastreGeometryAssets` and `mergeParcelPoints`, `OtpService` / `DocumentService` → `APP_CONFIG`, `registration.repository.ts`
  → `normalizeSearchText`) are tracked in [docs/code-quality.md](../../docs/code-quality.md).

## Module wiring

- `AppModule` (`src/app.module.ts`): `ConfigModule` (global, `validateEnv`), `EventEmitterModule`
  (global, synchronous), `ScheduleModule` only when `isSchedulerEnabled()`, `ThrottlerModule`
  (in-memory, 120 requests per 60 s), then `DomainModule`, `InfrastructureModule`, `ApplicationModule`,
  `PresentationModule`. A fifth import means something escaped its layer.
- `InfrastructureModule` is `@Global()` and binds each port symbol in use to its adapter
  (`SUPABASE_AUTH_SERVICE` is declared but unbound). `REQUEST_FILE_STORAGE` →
  `S3RequestFileStorageService`: the papers on a municipal request, in the private documents bucket
  under `{tenantSlug}/requests/{requestId}/{uuid}{ext}` — a port of its own because
  `IMAGE_STORAGE_SERVICE`'s key shape is frozen. `ApplicationModule`
  registers `JwtModule` (`JWT_SECRET`) and every service and job (`ParcelDuesService` among the fee
  services). In both, a new entry goes in `providers` AND `exports`.
- `PresentationModule` registers the controllers, `APP_FILTER` = `DomainExceptionFilter`,
  `APP_INTERCEPTOR` = `ViewerCredentialMaskInterceptor` (masks a رقم مرجعي in every response to
  «مشاهد فقط»; [docs/security.md](../../docs/security.md#authentication-and-authorisation)), and
  `APP_GUARD` in this order: `ThrottlerGuard`, `JwtAuthGuard`, `RolesGuard`. `configure()` applies
  `CorrelationIdMiddleware` to every route and `TenantMiddleware` to `t/:tenantSlug/*` (keep the bare
  `*`; see [docs/gotchas.md](../../docs/gotchas.md)). `BackupController` is deliberately unregistered.
- `createApiApp` (`presentation/bootstrap.ts`) sets the `api/v1` prefix (not on `/metrics`), helmet,
  compression, a 1 MB JSON limit, CORS from `CORS_ORIGINS`, and `rawBody` for the Whish HMAC.
  `presentation/main.ts` listens. `presentation/serverless.ts` is the retired Vercel entry.
- Request flow: `TenantMiddleware` resolves the tenant (`TenantService.resolve`, `TenantPrismaFactory.forSchema`) and
  runs the request in `TenantContextService.run`; `JwtAuthGuard` then requires token tenant = URL tenant and a current `tokenVersion`,
  and finally, unless the request is a background one, starts the `users.lastSeenAt` stamp without
  awaiting it (see **Staff presence** below).

## Conventions

- **Routes.** Tenant data lives under `@Controller('t/:tenantSlug/<area>')`. MUST NOT take a tenant, slug
  or schema from a body or query string.
- **Auth.** Every route is authenticated unless it carries `@Public()`, and every non-public handler
  MUST carry `@Roles(...)`. Today `RolesGuard` admits any authenticated token, citizens included, when
  `@Roles` is absent (gap in [docs/security.md](../../docs/security.md#known-gaps)). Until that is fixed, a
  self-service route without `@Roles` MUST check `user.kind` and scope every query by `user.sub`. A
  handler's `@Roles` replaces the class's.
- **Role lists.** `@Roles(...)` takes a named set from `@mechanization/shared-schemas` — `role-sets.ts`
  (`EVERY_STAFF_ROLE`, `WORKING_STAFF_ROLES`, `REGISTER_WRITE_ROLES`, `CENSUS_WORKLIST_ROLES`,
  `FEE_ISSUE_ROLES`, `REGISTER_EXPORT_ROLES` and the rest), except the treasury's `TREASURY_*_ROLES`
  (`treasury.schema.ts`) and `FINANCE_OVERRIDE_ROLES` (`cash-policy.ts`), which `role-sets.ts` points
  to — never a literal list: the frontend's
  `lib/staff-roles.ts` reads the same sets, so a route and its button move together. A new audience is a
  new named set there, and so is a single role a screen gates on (`PAYMENT_REVERSE_ROLES` for
  `POST fees/transactions/:transactionId/reverse`, «عكس الوصل»).
  `route-inventory.spec.ts` checks every controller on disk: `@Roles` on every
  non-public route (or a reviewed entry in its `SELF_SERVICE` list), «مشاهد فقط» on no write and no
  side-effecting GET, and no route that deletes a citizen. It also pins, route by route, every treasury
  handler and every handler elsewhere that moves treasury money (`MONEY_HANDLERS_ELSEWHERE`: the
  commission payout, and the fee routes that post wallet entries — `settle`, `review`,
  `reverseTransaction`, `whishCallback`; the bulk settlement's two in their own block), and the two
  routes that raise a bill, `issue` and `charge`, at the manager and the accountant (a municipal
  request's fee, `CitizenRequestsController.bill`, is pinned with the request routes at
  `REQUEST_BILL_ROLES`: its amount is the manager's list's, never typed): a collector settles
  (`FEE_SETTLE_ROLES`) and bills nothing (2026-10-12). And it checks
  that every id a `FeesController` route takes from its path (`id`, or a name ending in `Id`) goes
  through `ParseUUIDPipe`, as an instance or as the class. The eight that took theirs raw on `develop`
  carry PR #120's own line for each (its B9), word for word, so the two branches agree.
- **Staff sessions.** Rotating refresh tokens in an httpOnly cookie (`StaffRefreshTokenService`,
  `presentation/http/staff-refresh-cookie.ts`), checked by family in `JwtAuthGuard`; expired rows are
  pruned by `StaffRefreshTokenCleanupJob`. Rules: [docs/security.md](../../docs/security.md#tokens-passwords-and-totp).
- **A staff member's own account.** `GET auth/staff/me` (`IdentityService.staffSelf`,
  `@Roles(...EVERY_STAFF_ROLE)`) answers `StaffSelf` — id, email, role, `hasConfirmedTotp` and
  nothing else — read by `user.sub`. «أمان الحساب» reads it; `GET staff` is the administrator's
  roster and refuses every other role. The own-account writes beside it (`staff/change-password`,
  `staff/change-email`, `staff/totp/disable`) refuse a wrong current password with
  `STAFF_CURRENT_PASSWORD_INCORRECT`.
- **Staff presence.** `StaffPresenceService.touch` stamps `users.lastSeenAt` from `JwtAuthGuard`, after
  every check has passed, without the guard awaiting it. It is the only write on the authenticated hot
  path, and it stays affordable through a Redis gate: one UPDATE a minute per account, not one per
  request. Four rules hold it in place. Win the gate *before* the write, atomically
  (`RedisCacheService.setIfAbsent`, `SET NX EX`), because a read-then-set lets a burst stampede. Stamp
  `STAFF` only and say so in the UPDATE's WHERE (`users` holds citizens too and the portal is the busier
  half). Write the database's `now()`, not the process clock. Never throw: presence is a label on one
  admin screen, and a pooler blip must not 500 an officer's save. A request carrying
  `x-background-request` (`BACKGROUND_REQUEST_HEADER`, the portal's polls) is not stamped. The interval,
  the threshold and the rule (`STAFF_PRESENCE_STAMP_EVERY_SECONDS`, `STAFF_ONLINE_WITHIN_SECONDS`,
  `isStaffOnline`) live once, in `staff-presence.ts` in `@mechanization/shared-schemas`.
  `GET staff/presence` (`StaffPresenceService.presence`) returns `{ now, items }` with the database's
  clock, so the portal judges «متصل الآن» on the server's time, not the browser's. Pinned by
  `staff-presence.spec.ts` and `jwt-auth.guard.spec.ts`. Do not read `lastLoginAt` as presence: it is
  stamped once at sign-in and a staff token lives behind a week-long refresh chain.
- **Worklists.** «يتطلب مراجعة», «وحدات غير ممسوحة» and «بانتظار إعادة الكشف» share one query contract
  (`worklistQuerySchema`: search, `owner`, limit, offset) and one scoping rule.
  `worklistOwnerFilter` (`application/common/worklist-viewer.ts`) narrows an officer to their own work
  whatever they send, and lets a role in `SEES_ALL_STAFF_WORK` filter by an officer or by `UNASSIGNED`
  (the filer was never recorded, or their account is archived or deleted). The census two are raw SQL in
  `buildings/census-worklists.ts`; they are plain reads, not transactions.
- **Habitability.** A damage reading carries the UN-Habitat level and, beside it, `habitable`
  (decision of 2026-10-05). «غير صالحة للسكن» is `isUninhabitableReading` in
  `@mechanization/shared-schemas` (`damage-rule.ts`) and `uninhabitableSql` in
  `buildings/habitability.ts`: the same predicate, once in TypeScript and once in SQL, so change them
  together. A unit's reading is the latest of its own and its building's (`currentReadingForUnit`). The
  fee assessment charges no fee at all on such a unit, owner-borne included (decision of 2026-10-07:
  not habitable → exempt) (`uninhabitableUnitIds`), counted apart from
  the review hold. Only a reading that answers decides: «غير مصنّف» with no answer judged nothing, so
  the hold, both census worklists and the panels skip it (`answersHabitability` and its SQL twin
  `answersHabitabilitySql`, `currentReadingForUnit(…, { answering: true })`) and it never ends a hold.
- **Co-owner billing.** A flat with several current OWNER spells is divided between them, never billed
  to each in full (`0075`; decision of 2026-10-07). The rule is `ownerShareOf` in
  `@mechanization/shared-schemas` (`owner-share.ts`): equal by default (`units.ownerBillingMode` NULL),
  by أسهم over their sum, or one responsible owner. `holdingsOf` loads every owner of each flat in the
  batch (`buildings/owner-billing.ts`) and attaches this owner's part; `assessCitizen` multiplies area or
  units by it, only for what an owner bears, and refuses («unassessable») «حسب الأسهم» with أسهم
  missing. The choice is saved by `OwnerBillingService` (`PUT buildings/units/:unitId/owner-billing`,
  `REGISTER_WRITE_ROLES`), Tier 1, refusing a responsible owner whose own file billing would not charge
  (asked through `holdingsOf`). Owners are the flat's current OWNER spells held by an **open** file
  (`activeOwnerSpells`): an archived file is never billed, so its part falls to the others, and a
  responsible owner who is archived or stops owning falls back to the equal split at read time. A
  merge re-points `units.responsibleOwnerId` (only rows still naming the absorbed person) and its
  undo puts it back. Each owner's amount is rounded on its own, so a flat's parts can differ from
  the whole by under a pound per owner. «ملاحظات الجودة» warns of a saved method billing cannot carry
  out (`OWNER_BILLING_BLOCKED`, `DataQualityService.ownerBillingBlocked`, verdict `ownerBillingBlock` in
  `owner-billing.ts`): «حسب الأسهم» with an owner's أسهم missing (HIGH, every co-owner's bill refused) or a
  responsible owner no longer among the open owners (MEDIUM, split equally). A notice that bills nobody
  because «مالك مسؤول» pays refuses with `FEE_NOTHING_TO_CHARGE` (`coOwnerPaid`), not
  `FEE_NO_MATCHING_CITIZENS`. A fee raised on one person — «تكليف مباشر» (`chargeIndividual`) or a
  notice for `INDIVIDUAL_CITIZEN` — goes through `FeesService.chargeableCitizen`: `CITIZEN_NOT_FOUND`,
  `CITIZEN_MERGED_AWAY`, or `FEE_CITIZEN_ARCHIVED` for an archived file, which takes no new fees. The portal gets this owner's part and never the responsible owner's id;
  under «مالك مسؤول» the part (1/1 or 0/1) says who pays, read the same way on both sides.
- **Units on several levels, and a house that grows (D28, `0095`).** `units.levels` is how many levels one
  unit spans from its floor. `assessCitizen` weighs it under `PER_UNIT` only, through `roofWeight` in
  `@mechanization/shared-schemas` (`unit-levels.ts`): a flat by `system_settings.levelFactors`
  (`FeesService.levelFactors()`, read once per run and passed in; a count with no factor is
  «unassessable»), a house one roof per storey; the line carries `levels`/`levelFactor`. `holdingsOf`
  reads `levels` wherever it reads `feeExemption`. `updateUnit` takes `levels` (dwellings only,
  `UNIT_LEVELS_NOT_DWELLING`; never onto drawn columns above, `UNIT_LEVELS_BLOCKED`), and every overlap
  check reads `layoutBuildingFloors`. `addUnit`/`generateUnits`/`saveMatrix` ask
  `HOUSE_GROWTH_UNANSWERED` before a structure whose one unit is on a «منزل» card (or a bare «منزل مستقل»)
  grows: `EXTRA_LEVEL` raises the unit (`growHouseByLevel` → `updateUnit`), `SEPARATE_UNIT` creates it and
  converts the cards in the same transaction (`buildings/house-growth.ts`, `promoteHouseCards`; audit
  `HOUSE_CARDS_PROMOTED` on the building and `CITIZEN_UPDATED` via `HOUSE_GREW` per holder). The
  registration repository and `CitizensService.update` refuse a «منزل» card on a structure of several
  units (`infrastructure/prisma/house-card-guard.ts`); `CensusSyncService` holds such a card's spells as
  unresolved; `DataQualityService.houseCardsOnMultiUnitBuildings` lists them. «دمج كدوبلكس» lives in
  `UnitCorrectionService` (`previewMerge`/`applyMerge`, rules in `corrections/duplex-merge.plan.ts`): the
  upper flat's «حذف تصحيحي» plan, unchanged, run after its visits and cases move to the lower flat, which
  takes `levels` and the area; `CorrectionsController` `GET/POST corrections/units/:unitId/merge-upper`,
  SUPER_ADMIN (pinned by `route-inventory.spec.ts`). `DataQualityService.unitLevelsToConfirm` names the
  candidates (`UNIT_LEVELS_TO_CONFIRM`).
- **Units exempt from fees.** `units.feeExemption` (`0077`) takes a unit off every rate-based bill, whoever
  bears the fee: `holdingsOf` reads it, `assessCitizen` removes the unit before the review hold and the
  bearer rule and counts it (`exemptUnitCount`). Granted and lifted by `FeeExemptionService`
  (`PUT buildings/units/:unitId/fee-exemption`, `@Roles('SUPER_ADMIN')`), Tier 1, naming everyone on the
  unit. A building's lifecycle exempts nothing: `UNINHABITABLE_LIFECYCLE` buildings still billed are a
  «مراجعة الجودة» finding (`UNINHABITED_WITHOUT_READING`, archived files ignored, cleared on
  `damage.recorded`) until a «غير صالحة للسكن» reading is recorded. A FLAT notice to a category reads the
  register too: `flatCategoryCharge` lets off a holder every one of whose units of that category is exempt,
  uninhabitable, or paid by another co-owner under «مالك مسؤول» (their part 0, counted as
  `coOwnerPaidUnitCount`; decision 2026-10-08) — never the review hold or the bearer rule — and
  `CorrectionBillsService` uses the same function for today's figure. Under EQUAL and BY_SHARES every
  co-owner still pays a FLAT amount once; FLAT to ALL_CITIZENS stays a per-person charge. In «فواتير
  تأثّرت بتصحيحات» (`bill-corrections.ts`) granting an exemption (`UNIT_FEE_EXEMPTION_SET`) is a
  CORRECTION, so it reaches bills raised before it; lifting (`UNIT_FEE_EXEMPTION_LIFTED`) is a
  DATED_CHANGE, forward only. Neither changes a bill. The profile carries `heldUnits` for cards with no
  current unit lines (a منزل's flat, a مبنى card's census flats), the cards chosen by `billedBareCards`
  (latest registration, current cards and lines, `attachOccupancies`), so the exemption and the owners'
  split show on exactly the cards a bill is raised from.
- **Owners that are not a person** (`0076`). `CitizenResidence` adds `ESTATE` «تركة (ورثة المرحوم)» and
  `INSTITUTION` «جهة أو وقف». "Not a household" is `isOwnerRecord(residence)` (non-resident, estate,
  institution) and "not a living person" is `isNonPersonRecord`; never compare to `'NON_RESIDENT_OWNER'`
  for either. A name goes through `citizenDisplayName` wherever it is shown (an estate is «ورثة المرحوم …»),
  and an institution's one-line name is split on write (`splitInstitutionName`, in
  `RegistrationService` and `citizenColumnsForEdit`) and joined back in `getEditable`. A name copied into
  another row goes through `citizenStoredName` (never the display form), and a typed owner name is matched
  through `withoutEstatePrefix` / `ESTATE_PREFIX_PATTERN`. An estate owns and nothing else:
  `nonResidentCardIssues` (`ESTATE_OWNS_ONLY`) and `assertNonResidentOccupancy` (coded `ESTATE_OWNS_ONLY`)
  refuse a tenancy on it, and refuse «مسكن موسمي» on its homes as well as «مشغولة من المالك». A filing whose
  document number an estate or a body holds is a CONFLICT, never attached to it. `planMerge` blocks a person with a body, or an estate with
  an institution (`RESIDENCE_CONFLICT`); duplicate detection and the quality scan skip both kinds; a FLAT
  notice to ALL_CITIZENS skips both (`resolveTargets` with `basis`).
- **«الرسم حسب فئة المساحة» (`TIERED_AREA`, 0098/0099).** `assessCitizen` prices each unit by the notice's
  bracket table (`priceTieredUnits`, `fees/tiered-area.ts`) after exemptions, habitability, the review hold
  and the bearer rule have run; `splitSharedUnitBills` takes the units two or more citizens are charged
  for off their own bills and bills each once, in full, to all of them (decision D5). `FeesService.planNotice`
  is the read-and-assess half `issue` and `previewNotice` share, so a preview and the issue after it cannot
  disagree; `POST fees/notices/preview` (`FEE_ISSUE_ROLES`, `feeNoticePreviewSchema`) writes nothing.
  `issue` and `runRecurringBilling` write a period through `writeBills`: own bills, then shared unit bills
  (`citizenId` NULL, `unitId` set) with ids given up front so their `citizen_payment_debtors` rows are
  written only for the bills inserted, then one numbering pass. A bill's citizen is nullable since then:
  staff lists read `billHolder` (`sharedUnit` from `fees/shared-bill-view.ts` in place of the citizen),
  the collector's views name the debtor who paid (`payment_transactions.paidByCitizenId`), and
  «المستحق على عقار» left-joins the citizen so a shared bill blocks a براءة ذمة on its parcel. The ledger
  (`PaymentLedgerService.recordIn`) requires a payer who is one of a shared bill's debtors and refuses one
  on a citizen's own bill (`SHARED_BILL_PAYER_*`). What a person owes is read by `billsOwedBy`
  (`fees/shared-bill-view.ts`): their own bills and the shared ones they are a debtor on — the portal
  (`listForCitizen`), the citizen file and the portal summary (`ReportingService.getCitizenProfile`), the
  register's per-person figures (the SQL twin `owes` in `CitizensService.list`, whose money totals sum
  distinct bills so a shared bill counts once), the payments list filtered by citizen, the edit review's
  open bills, and bulk settlement (the citizen settling is named the payer of a shared bill). A debtor's
  claim or Whish payment on a shared bill is refused (`SHARED_BILL_PAY_AT_OFFICE`): a claim is confirmed
  later and the bill keeps no claimant. Correction bills leave `TIERED_AREA` out until they recompute a
  run as `splitSharedUnitBills` does. Plan and decisions:
  [docs/fees-system-rearchitecture-specification.md](../../docs/fees-system-rearchitecture-specification.md).
- **«المستحق على عقار».** `ParcelDuesService` (`GET fees/parcel-dues?propertyNumber=`, `FEE_READ_ROLES`,
  `parcelDuesQuerySchema`) finds open bills by a JSONB containment on `assessment.lines` and gives each the
  parcel's part by its own lines (`parcelShareOf`), then lists apart the open bills with no lines of the
  people on the parcel today. Read-only; no certificate.
- **Searching citizens as «مشاهد فقط».** The register, the review queue and the payments list match a
  citizen through `citizenSearchText(S, role)` (`application/common/citizen-search.ts`) rather than
  `u."searchText"` directly: for VIEWER it removes the رقم مرجعي (folded and compact) from the searched
  text, so a role that is never shown the reference cannot confirm one by searching. A new citizen search
  uses it too.
- **The citizen portal names what it sends.** `CitizenController.mySummary` builds «ملفّي» from the staff
  profile: a flat's owners go as an allowlist (name and أسهم), the landlord link's id and reference are
  dropped, and everything else on a property or unit passes through, so decide for each field you add to
  `CitizenProfile` ([docs/gotchas.md](../../docs/gotchas.md)).
- **Treasury.** `TreasuryService` (overview, statements, `activate`) and `TreasuryLedgerService`
  (`post`, `creditPayment`, `reversePayment`, `reverseEntriesOf`), under
  `application/features/treasury/`; routes in `TreasuryController` (`t/:tenantSlug/treasury`). The
  pure routing rules are `treasury.plan.ts`. `PaymentLedgerService.append` calls the ledger **inside
  its own transaction** after it writes the payment row, so the payment and its wallet entries commit
  together; `TreasuryLedgerService` never opens a transaction and takes the client explicitly. Nothing
  credits a wallet until `system_settings.treasuryGoLiveAt` is set and the payment's `occurredAt` is
  at or after it.
  - The go-live stamp is read `FOR SHARE`, so a payment waits for an activation that is still
    committing. `activate` commits the settings row before its transaction opens, so there is
    always a row to wait on.
  - After go-live only a finance role may date a payment before it (`FeesService.settleInPerson`,
    `PAYMENT_DATE_BEFORE_GO_LIVE`).
  - A dated receipt or voucher takes its moment from `documentOccurredAt` (`treasury.plan.ts`):
    today keeps the clock, an earlier day sits at midday UTC, and nothing dated the go-live day
    sits before the opening entry. So the go-live day is live whatever the hour of activation
    (decision D5).
  - An outflow locks the wallet rows (id order) and is refused below zero — now, and, when it is
    dated on an earlier day, at the close of that day and of every day since
    (`TreasuryLedgerService.assertCanPay`: `TREASURY_INSUFFICIENT_FUNDS` with the balance now,
    `TREASURY_INSUFFICIENT_FUNDS_ON_DAY` with the first short day and its close). `post` asks it of
    every outflow; a caller that judges one before posting (a transfer's amount + fee) asks it too.
    A day's close, not an instant: a back-dated document sits at a nominal midday, so money that
    reached the wallet later that day still covers it. Today's balance alone let a back-dated
    expense from a bank opened today, or a back-dated transfer, close a past day below zero on the
    signed register (review of 2026-10-11).
  - **Lock before you reference.** A caller that inserts a row with a foreign key to
    `treasury_accounts` (a voucher, a transfer) first calls `lockAccounts` with every wallet it will
    touch. Otherwise the foreign-key check's `FOR KEY SHARE` and `post`'s `FOR UPDATE` deadlock
    against another caller. The order, for every writer: a retry key's advisory lock, then
    `ledger.config(tx)` (the settings row, `FOR SHARE`), then `lockAccounts`, then the document
    number and the insert. A payment is the exception that keeps the same pairs in order: it takes
    the RECEIPT counter before its wallets, so nothing may take a wallet and then that counter. An
    act that records several payments in one transaction locks all their wallets at once, after the
    counter (`lockPaymentWallets`), never bill by bill.
  - `ledger.config(tx)` returns the go-live stamp, the rate and the urgent-payment ceilings
    (`urgentExpenseCeiling.LBP` / `.USD`, 0083).
  - A refund after a collector's handover leaves the safe (`refundDrafts`, decision D1).
  - Opposing entries carry their original's rate.
  - The manager opens a bank account or a petty-cash fund with `TreasuryService.createAccount`
    (`POST accounts`, `TREASURY_ADMIN_ROLES`): empty, never primary, in the base or secondary
    currency, and one per name, kind and currency — serialised under
    `<schema>:treasury-account-create` and refused as `TREASURY_ACCOUNT_NAME_TAKEN`, since its
    answer can be lost like any other and a wallet is never deleted.
  - The exchange rule (`system_settings.exchangeRateTolerancePercent`, `largeExchangeThreshold`,
    0084) is saved through `FeesService.updateSettings`: only the manager moves it
    (`exchangeRuleChangeAllowed`, `EXCHANGE_RULE_MANAGER_ONLY`), and, like the ceilings, it is
    written only when the manager saves, so an accountant's save of the section never writes it
    back or is recorded as changing it. `FeesController.getSettings` strips it for a citizen.
  - «الحركات المالية» (the screen `finance/transactions`) is `GET movements` on `TreasuryController` (`TREASURY_READ_ROLES`, the readers
    of both registers; query through `listTreasuryMovementsQuerySchema`, contract
    `treasury-movements.schema.ts`), read by `TreasuryMovementsService.list`: the income and the
    expense vouchers in one register, vouchers only (no citizen payment, no expense request). The
    page is chosen in raw SQL over a `UNION ALL` of `income_vouchers` and `expense_vouchers` under the
    same filters, ordered `occurredAt`, `createdAt`, `id`, all descending — the id is the tie-break
    across the two tables, since back-dated vouchers share a nominal midday — each table limited to
    its newest `offset + pageSize`. Each line is then read through `IncomeService.viewsByIds` /
    `ExpensesService.viewsByIds`, so the voucher is exactly what its own register returns (the select
    and the view stay in those services). `from`/`to` are `incomePeriod`'s Beirut midnights; a line's
    `day` is `to_char("occurredAt" AT TIME ZONE 'Asia/Beirut', …)`, the 0082 trigger's day. The
    search escapes `%`, `_` and `\` with `likePattern` and matches each table's own columns (payer and
    external reference, or payee and invoice number). `total` counts every match, cancelled ones when
    `includeVoid`; `totals` (per currency, in and out) and `days` (each day on the page, summed over
    the whole filtered set, so a day split across pages reads whole on both) never count a cancelled
    voucher. All of it is one REPEATABLE READ snapshot (`viewsByIds(tx, ids)` reads through the
    caller's transaction), as `TreasuryService.statement` reads its page: read apart, a voucher
    cancelled between the page and its line was listed as cancelled without `includeVoid`, which
    neither register can do (each filters and builds its lines in one `findMany`), and the figures
    could disagree with the lines. `page` is capped at 1,000,000 in the schema, so the bound
    offset stays a number Postgres reads (unbounded, `page=1e20` was a 500).

  Design and rules: [docs/finance.md](../../docs/finance.md).
- **Expenses.** `ExpensesService` and `ExpensesController` (`t/:tenantSlug/treasury/expenses`), with
  the date rules in `expenses.plan.ts`.
  - **Money leaves on the manager's payment order** (decree 5595/1982 art. 28 and 33; decided
    2026-10-09).
    - `record` by the manager is the order.
    - `record` by an accountant needs `urgentReason` (art. 35) and leaves the voucher
      `AWAITING_ORDER` until `regularize`. Otherwise it is refused (`EXPENSE_ORDER_REQUIRED`).
    - The urgent path has the manager's ceiling per currency (decision D6,
      `urgentCeilingBreached` in `expenses.plan.ts`): above it, an accountant's urgent voucher
      is refused in `recordInTransaction` before anything is written
      (`EXPENSE_URGENT_OVER_CEILING`, `params: { ceiling, currency }`). Not for the manager's
      voucher, nor for a salary (`payeeStaffId` set). The ceiling is written through
      `FeesService.updateSettings`, which refuses a change from outside `TREASURY_ADMIN_ROLES`
      (`URGENT_EXPENSE_CEILING_FORBIDDEN`); `FeesController.getSettings` strips it for a citizen.
    - The ordinary path is `requestPayment` → `orderRequest` (which writes and pays the voucher)
      / `rejectRequest` / `withdrawRequest`, on `expense_requests`.
  - Wherever a voucher is written, one transaction locks the wallet (`lockAccounts`), writes the
    voucher, posts the negative ledger entry through `TreasuryLedgerService.post` (which refuses to
    take a wallet below zero), and writes the Tier 1 audit row.
  - A voucher is never edited (the database refuses it, `0083`). It takes a void stamp and the
    ledger gets an opposing entry through `reverseEntriesOf`.
  - The voucher's currency is taken from its wallet, never from the request, and a custody wallet
    never pays (`payingAccount`).
  - A retry key is bound to its act (`replayVoucher`, `replayRequest`): wallet, amount, clerk,
    band, payee and description, and for a salary the staff account (`payeeStaffId`). A unique violation on it is answered as a replay
    (`retry-key.ts`), and a key whose voucher was cancelled since gets `EXPENSE_ALREADY_VOID`.
    When a key is sent, `record` first takes a schema-scoped `pg_advisory_xact_lock` on it
    (`<schema>:expense-request:<key>`), so two identical requests arriving together meet there
    and the second finds the first's voucher.
  - Three role lists: read; `TREASURY_WORK_ROLES` to record or request; `TREASURY_ADMIN_ROLES` to
    order, reject, regularise or void. `route-inventory.spec.ts` pins each handler's list.
  - An order is its request's own retry: the manager who gave it is answered with the voucher it
    paid (`answerOrder`, read under the request's row lock), another manager with
    `EXPENSE_REQUEST_ALREADY_DECIDED`.
  - The municipality names its own bands of spending: `POST`/`PATCH` on `expenses/categories`,
    manager only. A PATCH changes only the fields it sends; the two budget codes travel together,
    and both empty clears them. A category is deactivated, never
    deleted: every voucher ever filed under it still points there, and the foreign key is RESTRICT.
  - «صرف راتب / أجر» is `POST expenses/salaries/:staffId` (`recordSalary`,
    `TREASURY_WORK_ROLES`): the same write through the private `recordInTransaction`, so the payment
    order applies to it as to `record`. Art. 35 names salaries (decision D7): the manager's payout
    is ordered, and an accountant's goes on the urgent path with `SALARY_URGENT_REASON`, written by
    the server, and waits for `regularize`. The urgent ceiling does not apply to it; an accountant's own salary is refused (`SALARY_SELF_PAYOUT`, D8). The payee is read from the staff account
    (`kind = 'STAFF'`, not deleted; a disabled account may still be paid) and the category is
    looked up by key (`SALARIES`). It stamps `payeeStaffId` (`0081`) on the voucher and in the
    audit row's `after`, so a person's salaries are found by id, not by name.
  - «صرف عمولة» is `recordCommission`, the third caller of `recordInTransaction`: category
    `FIELD_COMMISSIONS`, `payeeStaffId` the inspector, and the description the category's own name
    when none is given. Its only caller is `StaffService.recordInspectorPayout`
    (`POST staff/inspectors/:id/payouts`, `TREASURY_WORK_ROLES`, pinned by name in
    `route-inventory.spec.ts`), which is why `StaffService` takes `ExpensesService`,
    `TreasuryLedgerService` and `AuditService`.
    - Paid like a salary (decision D9): the manager's payout is ordered, and an accountant's goes
      on the urgent path with `COMMISSION_URGENT_REASON`, written by `recordCommission`, and waits
      for `regularize`. Each caller of `recordInTransaction` says what it is (`VoucherPath`):
      `exemptFromUrgentCeiling` is true for `recordSalary` and `recordCommission` alone, never
      inferred from `payeeStaffId`; `mayUseReservedCategory` is `recordCommission`'s alone, so
      `record`, `requestPayment` and `orderRequest` refuse `FIELD_COMMISSIONS`
      (`EXPENSE_CATEGORY_RESERVED`; `RESERVED_EXPENSE_CATEGORY_KEYS` in shared-schemas).
    - The inspector's id (and the actor's) is read in one spelling, lower case, before anything
      compares or locks with it: `ParseUUIDPipe` passes an upper-cased UUID on as typed, Postgres
      reads it as the same row, but the self-check and the lock key are strings, and «3F2A…» was
      another inspector to both (two payouts spent one balance; an accountant paid himself; review
      of 2026-10-11).
    - Before the transaction, an accountant's own commission is refused (`COMMISSION_SELF_PAYOUT`,
      the D8 rule). Then one transaction under `pg_advisory_xact_lock` on
      `<schema>:inspector-payout:<inspectorId>` (the balance owed is read and then paid, so two
      payouts must queue). A retried key, on either path, is found by `payoutByKey` — on the payout
      row (`inspector_payouts.clientRequestId`, `0089`), or on its voucher for a live payout written
      before it — and replayed by `replayPayout`, which binds it to the act (inspector, amount,
      recorder, statement, and the wallet when a voucher paid it: `TREASURY_REQUEST_KEY_REUSED`
      otherwise), refuses one whose voucher was voided (`EXPENSE_ALREADY_VOID`), and answers
      `INSPECTOR_PAYOUT_REQUEST_REUSED` for a key that paid another inspector or wrote another
      voucher. One key sent for two inspectors at once takes two locks and meets on the unique
      index; the loser is answered from the winner's row (`isUniqueViolationOn`), never with a 500.
      Before `0089` a figure-only payout kept no key, and a lost answer pressed again was recorded
      twice (review of 2026-10-11).
    - It then reads `ledger.config` (FOR SHARE, before any wallet is named) and forks on
      `goLiveAt`. Before go-live: the manager's alone (`INSPECTOR_PAYOUT_BEFORE_LIVE_MANAGER_ONLY`),
      a wallet-less row with the press's key, dated no later than today (`INSPECTOR_PAYOUT_DATE_IN_FUTURE`), and a Tier 1
      `INSPECTOR_PAYOUT_RECORDED` row with the amount. Once live: a voucher from a dollar wallet,
      the payout linked to it (`inspector_payouts.expenseVoucherId`, `0086`) and the same Tier 1
      row, saying whether the order came with it.
    - The allowance (`payoutAllowance`) is judged last once live, after the voucher is written and
      inside the transaction that rolls it back: an accountant may not read what an inspector is
      owed, so no other refusal may answer differently for an amount within it, and
      `payoutRefusal` names the figure only to a caller `getInspectorProfile` would admit
      (`showOwed`).
    - A payout whose voucher is voided stops counting as paid, in `getInspectorProfile` and in
      `UserRepository.listStaff` alike. A payout with a voucher is written once at the database
      (`0089`): no update, no delete, and the link is made in the insert or never.
- **Income.** `IncomeService` and `IncomeController` (`t/:tenantSlug/treasury/income`), with the
  date rules and the register's period bounds in `income.plan.ts`.
  - The expense module run the other way: one transaction writes the «سند قبض», posts the
    positive `INCOME_VOUCHER` entry and the Tier 1 audit row (number and amount, never the payer).
    There is no payment order: money arriving is not a disbursement.
  - The wallet must be one that `canReceiveIncome` allows (cash safe, Whish, bank), never a
    collector's custody.
  - Three role lists: read; `TREASURY_WORK_ROLES` to record; `TREASURY_ADMIN_ROLES` to void.
    `route-inventory.spec.ts` pins each handler's list.
  - The retry key is required (optional on an expense) and is serialised with a schema-scoped
    `pg_advisory_xact_lock` before it is read (`<schema>:income-request:<key>`), so identical
    requests produce one voucher and replays rather than a unique violation. It is bound to its act
    (`IncomeService.replayVoucher`: wallet, amount, clerk, category, description, payer); a key whose
    voucher was cancelled since gets `INCOME_ALREADY_VOID` (`params.voucherNumber`), and a unique
    violation on it outside the transaction is answered as a replay (`retry-key.ts`).
  - `record` takes `config`, then `lockAccounts([wallet])`, then the RV number and the insert, and
    dates the voucher with `documentOccurredAt` and the go-live stamp (D5).
  - A void *removes* money, so it locks the voucher, then the wallet (`lockAccounts`), and refuses
    with `TREASURY_INSUFFICIENT_FUNDS_FOR_VOID` when the wallet has spent it since. The voucher is
    written once (`0083`'s trigger).
  - The register's `from`/`to` are municipal days, turned into Beirut midnights
    (`municipalDayStart`) rather than read as UTC dates.
  - Categories: `POST`/`PATCH` on `income/categories`, manager only, never a delete. An edit keeps
    `active` unless it is sent, and a taken budget article is the partial unique index's `P2002`,
    mapped to `INCOME_CATEGORY_CODE_TAKEN` in `writeCategory`.
- **Transfers.** `TransfersService` and `TransfersController`
  (`t/:tenantSlug/treasury/transfers`), with the pure rules in `transfers.plan.ts` and the exchange
  arithmetic in shared `exchange-policy.ts`. Three kinds, derived from the two ends and never stored
  (`transferKindOf`). «تحويل داخلي» and «مصارفة» are `create` (`POST`, `TREASURY_WORK_ROLES`):
  the retry key under a schema-scoped advisory lock (`<schema>:transfer-request:<key>`) and
  answered before anything is judged (`replayTransfer`), then `ledger.config`, the date by
  `planTransferDate` (the expense rules, renamed) and `documentOccurredAt` (D5), both wallets locked
  through `TreasuryLedgerService.lockAccounts` in ascending id order *before* anything references
  them — the fee and the move are two inserts and two posts, and amount + fee is judged under that
  lock, by `assertCanPay` (every close since a back-dated day included) — then the fee voucher
  (`ExpensesService.recordTransferFee`, `TRANSFER_FEES`), the
  document, its two legs and a Tier 1 `TRANSFER_RECORDED` or `EXCHANGE_RECORDED`.
  - The retry key is bound to its act (`replayTransfer`: both wallets, amount, received amount,
    fee, statement, clerk). Anything else under it is `TREASURY_REQUEST_KEY_REUSED` — a handover's
    key included, which lives in the same column — a key whose transfer was cancelled since gets
    `TRANSFER_ALREADY_VOID` (`params.transferNumber`), and a unique violation on it is answered as
    a replay (`retry-key.ts`).
  - The fee voucher goes through `recordInTransaction` like every voucher, so the payment order
    holds (D3): the manager's transfer is its order; an accountant's fee is paid on the urgent path
    with `TRANSFER_FEE_URGENT_REASON`, held to the urgent ceiling, and waits for `regularize`.
  - An exchange's rate is derived from its two amounts (`exchangeRateOf`) and judged by
    `judgeExchange` against `system_settings.exchangeRate`, which is the rate of the *secondary*
    currency: an exchange whose other side is any other currency is `EXCHANGE_PAIR_UNSUPPORTED`.
    Beyond the tolerance without a reason it is refused (`EXCHANGE_RATE_TOLERANCE_EXCEEDED`), and
    beyond it, above the threshold, or with no official rate it is booked with `requiresReview`.
  - `review` (`POST :id/review`, `TREASURY_REVIEW_ROLES`) stamps it once; the stamp is in the
    write-once trigger's list since 0088, which also refuses changing a review afterwards. A
    cancelled transfer is refused with `TRANSFER_ALREADY_VOID`, never reaching the trigger.
  - `void` takes the transfer row, then `config`, then both wallets, reverses the legs and cancels
    the fee voucher with them (`voidTransferFee`); it is refused while the destination no longer
    holds what arrived. `ExpensesService.void` refuses a fee voucher alone
    (`EXPENSE_IS_TRANSFER_FEE`).
  - Every transfer draws its «TR-» number from `document_counters`, whose
  row lock queues concurrent transfers before any wallet is touched — so a test of the wallet lock
  order cannot rely on a deadlock appearing (docs/gotchas.md). The first kind is «تسليم صندوق الجابي», the collector
  handing in what he took at the doors. A citizen's payment settles his invoice at the door and
  credits the *collector's* custody wallet, never the safe — the money is in his pocket — and this is
  the step where it reaches the municipality: both ledger legs, the transfer document and the Tier 1
  audit row in one transaction. Partial handovers are normal and the remainder stays on his name;
  more than he holds is refused twice over, by `CUSTODY_EXCEEDS_HELD` naming the figure and by the
  ledger's own never-negative post, both read behind `lockAccounts`. Cancelling puts both legs back,
  so the cash is his responsibility again. A collector holds none of the treasury roles. The person
  who receives from him is someone else, which is the control, and the service enforces it: an
  accountant named as collector cannot receive his own custody (`CUSTODY_SELF_RECEIPT`). A retry
  key is bound to its handover (`replayHandover`), and one whose handover was cancelled since gets
  `TRANSFER_ALREADY_VOID`. A replay answers only the retry of the moment: once the custody wallet
  has an entry after the earlier transfer, the key is refused as spent (`TREASURY_REQUEST_KEY_REUSED`).
  A counter retry whose receipt was reversed since gets `TRANSACTION_ALREADY_REVERSED`
  (`PaymentLedgerService.replay`). `GET custody/:collectorId/collections` answers the other half of the
  question — not «كم بعهدته» but «من حصّل منهم»: the receipts behind the figure, each with the citizen
  who paid — his full three-part name, his phone and the sector he lives in. It is a list of receipts
  and not of handovers, and the two totals part company the moment he hands anything in, because a
  handover moves an amount and not a set of receipts. It starts at go-live (`since`), as «جولتي» does:
  a receipt from before it never reached his custody, and counting it made «collected − held» more
  than he ever handed in. Its «collected» totals are his custody's `CITIZEN_PAYMENT` ledger entries,
  not the receipts, so a refund paid from the safe after a handover does not move them. The
  statement reads its page and sums in one `RepeatableRead` transaction. The sector is resolved the way it is everywhere
  else: occupancy → unit → `building.parcelNumber` → the `Zone` listing it (D13), with the sector
  table read once per page rather than once per row. It carries no رقم مرجعي: that is a sign-in
  credential, and an integration test pins the row's exact key set so a field added later fails there
  rather than in a browser.
- **Daily count and closing** (docs/finance.md §7, migrations 0082 and 0087). The rules are `day-closing.plan.ts`
  (`planCountDate`, `planCountLine`, `planClosure`, `countsChangedSinceShown`, `planReopen`, `nextDayToClose`,
  `summariseDay`);
  `DayClosureService` (book state, a day's facts, `close`, `reopen`, `history`), `DailyCountService`
  (`sheet`, `record`) and `DailyCashReportService` (`daily`) do the I/O; routes in
  `TreasuryClosingController` (`t/:tenantSlug/treasury`: `counts`, `closures`, `closures/reopen`,
  `reports/daily`). Read `TREASURY_READ_ROLES`, count and close `TREASURY_WORK_ROLES`, reopen
  `TREASURY_ADMIN_ROLES`. Only a day that has ended closes; days with movement on a counted wallet close
  in order, and the quiet days between are swept closed with the next close. A count locks the wallets
  it records (`lockAccounts`, id order) after the settings row and before it reads their books or
  writes a line: its insert's foreign key takes `FOR KEY SHARE` on each wallet, and taken line by line
  in the sheet's order (type, currency, name) it deadlocked against a transfer, an exchange or a cash
  payment with a dollar note over two of them (review of 2026-10-11;
  `daily-count-lock-order.integration.spec.ts`). Counting, closing and
  reopening serialise on `TreasuryLedgerService.lockDayBook` (`<schema>:treasury-day-book`), and a close
  also takes `SHARE` on `treasury_entries` so nothing lands in the day while it is judged. It reads
  `ledger.config` (the settings row, `FOR SHARE`) before that `LOCK TABLE` and refuses a book not live
  first: settings row, then entries, as every writer; the reverse deadlocked with activation. The close
  carries the counts its dialog showed (`counts`, each with `countedAt`) and refuses a recount made
  since with `COUNT_CHANGED_SINCE_LOADED`. `DailyCashReportService.daily` reads in one `RepeatableRead`
  transaction and adds the go-live day's `OPENING_BALANCE` entries to the opening, not the receipts. The lock on
  money is in `TreasuryLedgerService.post` (`assertDayOpen`), which every entry passes through, and in
  `PaymentLedgerService.recordIn` (`assertPaymentDayOpen`, only for a payment that reaches a wallet;
  `record` and every bill of a settlement run it), and in `PaymentSettlementService` before the «BRC-»
  number, with the 0082 triggers underneath. A count stores the server's books figure and is refused, or goes stale
  for the close, when the books move (`COUNT_EXPECTED_CHANGED`). Counts, closes, sweeps and reopens are
  Tier 1 audit rows filed as `entityType 'TreasuryDay'`, `entityId` the date: the report's timeline
  reads them.
- **Document numbers.** `allocateDocumentNumbers` / `allocateDocumentNumber`
  (`application/common/document-number.ts`) is the only way a number is drawn, for all six books:
  «INV-2610-0001», «RCP-…», «PV-…», «TR-…», «RV-…», «BRC-…» (the consolidated receipt, 0085). Pass the caller's `tx` and `this.S` — the draw and the
  document must share a transaction, and an unqualified name would resolve through the pooled
  connection's `search_path` into another municipality's counter. Bulk callers take a block sized to
  what was actually inserted: `FeesService.numberInvoices` numbers after `createMany` because
  `skipDuplicates` means a block reserved beforehand would burn numbers on rows that were never
  written. A settlement of several bills reserves its receipts' block first
  (`PaymentLedgerService.reserveReceiptNumbers`): every bill is written or the whole act rolls back
  with the counter, so nothing burns. Details and trade-offs: migration 0079 and docs/database.md.
- **Settling several bills at once.** `PaymentSettlementService` (`fees/payment-settlement.service.ts`,
  its own service because `FeesService` is a god file to split), routes on `FeesController`:
  `POST fees/payments/bulk-settle` (`BULK_SETTLE_ROLES`, `bulkSettlePaymentsSchema`) and
  `GET fees/settlements/:id` (`FEE_READ_ROLES`, the reprint). Design: [docs/finance.md](../../docs/finance.md) §3.7.
  - One `runInTenantTransaction`, in this lock order: the retry key's advisory lock
    (`<schema>:bulk-settle:<key>`), every bill `FOR UPDATE` in id order
    (`PaymentLedgerService.lockInvoices`), the settings row `FOR SHARE`, the closed-day check
    (`TreasuryLedgerService.assertPaymentDayOpen`, refused before anything is written), the «BRC-»
    number, the `payment_settlements` row, every bill's «RCP-» number as one block
    (`PaymentLedgerService.reserveReceiptNumbers`), every wallet the set will post to in id order
    (`TreasuryLedgerService.lockPaymentWallets`), then each bill oldest first through
    `PaymentLedgerService.recordIn` with its reserved number — `record`'s body in the caller's
    transaction (`record` itself still opens its own, tracked debt). A single payment takes the bill,
    the settings row, the RECEIPT counter and then its wallets; a transfer or a voucher takes the
    settings row and then its wallets in id order. Locking the wallets bill by bill deadlocked
    against an exchange between the same two safes, and locking them before the RECEIPT counter
    deadlocked against a counter payment; both races are pinned in
    `payment-settlement.integration.spec.ts`.
  - How the notes are spread is `planBulkSettlement` in `@mechanization/shared-schemas`, run by the
    dialog for its preview and by the service under the locks; its refusals become `ValidationError`s.
  - Refused under the locks, before anything is written: a bill paid since (`BULK_SETTLE_SOME_ALREADY_PAID`)
    or waiting for review (`BULK_SETTLE_BILL_PENDING_REVIEW`), and sums per currency that are not the
    request's `expectedDue` (`BULK_SETTLE_DUE_CHANGED`) — without it a Whish or collector settlement
    recorded whatever the bills owed by then. A COLLECTOR settlement checks the collector with
    `assertLiveCollector` (`fees/live-collector.ts`, shared with `FeesService.settleInPerson`), after
    the replay and before the bill locks.
  - The retry key is required and lives on the settlement (`payment_transactions.clientRequestId` is
    unique per row). A replay is bound to citizen, method and the set of bills
    (`BULK_SETTLE_REQUEST_REUSED`, with the settlement's «BRC-» number in `params.number`: from the
    dialog it means the same bills pressed again another way after a lost answer, so the clerk is told
    which receipt exists); one of whose bills was reversed since is `TRANSACTION_ALREADY_REVERSED`;
    a unique violation on the key is answered as a replay (`retry-key.ts`).
  - Reversing a bill of a settlement (`PaymentLedgerService.reverse`) opposes its entries, as for any
    receipt, except the one row of a cash settlement that carried the set's notes and change (the
    pivot, the only row with a tender): its notes paid every bill and its change, recycled, paid the
    older ones, so it is refunded its own credit, in its currency, from the safe
    (`TreasuryLedgerService.reversePayment`, `planCreditRefund`). Opposed, it took the $20 back and put
    1,690,000 ل.ل of change the citizen never had into the safe for a 100,000 ل.ل bill (review of
    2026-10-11).
  - Audit: each bill's own `PAYMENT_CONFIRMED` row (with `settlementNumber`), plus one
    `PAYMENT_BULK_SETTLED` row for the set, filed under `PaymentSettlement`. Ids and figures, no names.
  - The receipt names the citizen with father's name and phone and never carries a رقم مرجعي;
    `payment-settlement.integration.spec.ts` pins the citizen block's key set.
- **The collector's own round.** `GET custody/mine` (`TransfersService.myRound`) is the one treasury
  route outside `TREASURY_*`: `WORKING_STAFF_ROLES`, scoped by `user.sub` with no id in the path, the
  same shape as `inspector/me/profile`.
  - It answers what he holds, and the receipts that still stand since whichever came later: his last
    handover or go-live. A receipt from before go-live never reached his custody.
  - `listed` is summed from the custody ledger per wallet, not from the receipts' invoice currency,
    so a tender in dollars against a ليرة bill lands in the right pocket.
  - After a *partial* handover those receipts cannot add up to what he holds, so the difference is
    returned as `carriedOver` and named on the screen rather than hidden.
  - Staff holding no custody get an empty round, not a 403.

  `custody()` additionally reports each collector's receipts and takings for today via a raw query.
  The day boundary is Beirut's (`municipalToday`), and `payment_transactions.occurredAt` is
  `TIMESTAMPTZ` (0017), so one `AT TIME ZONE` gives the wall clock. The two-step form the audit
  day-buckets use is for their bare timestamp; on this column it moved the boundary six hours.
- **Who is calling.** `@CurrentUser()` yields `SessionClaims` (`application/features/identity/identity.service.ts`);
  `@CurrentTenant()` yields `req.tenant`. Pass the actor to services as `{ id: user.sub, role: user.role ?? '' }`.
- **Validation.** `@Body(new ZodValidationPipe(schema))`, schema from `@mechanization/shared-schemas`. Put
  the pipe on the parameter, never in `@UsePipes` (it would validate `tenantSlug` too). Ids:
  `new ParseUUIDPipe()`, and `new ParseUUIDPipe({ optional: true })` for an id in a query string.
  Helpers in `presentation/controllers/query-params.ts`:
  - dates: `parseDate` / `requireDate`;
  - a range that adds up: `requireRangeStart` / `requireRangeEnd`, which read a bare `YYYY-MM-DD`
    as that whole day in Beirut;
  - whole numbers: `optionalInt`, digits only, refused with `INVALID_QUERY_VALUE`.

  Declare static paths before `:id`.
- **Errors.** Throw `DomainError` subclasses from `application/common/exceptions`. No try/catch and no
  `HttpException` in controllers; `DomainExceptionFilter` is the one place errors become HTTP.
- **Raw SQL.** Tagged `$queryRaw` with `${this.S}table`, where `S` is `tenantSchemaRef(this.tenantContext.schemaName)`,
  and values as bound parameters. `raw-sql-is-schema-qualified.spec.ts` fails the build otherwise.
- **Config.** Read env through `ConfigService`; every variable MUST be declared in `envSchema`. Policy
  constants go in `APP_CONFIG` (`presentation/config/app.config.ts`). No literals for limits or TTLs.
- **Logging.** `new Logger(ClassName.name)`. Never log PII, tokens, a رقم مرجعي or a URL with its query string.
- **Cache.** `RedisCacheService` (`get`, `set`, `setIfAbsent`, `invalidatePrefix`), keys `<area>:<tenantSlug>:…`.
  While Redis is offline, `get` and `set` use the in-process layer alone rather than waiting on a retry.

## Error codes

Rule: a refusal is thrown with a specific code from `ERROR_CODES` in
`packages/shared-schemas/src/error-codes.ts`, and the frontend owns the words.

- Throw the coded form: `new ConflictError({ code: 'PAYMENT_EXCEEDS_BALANCE', message, params, details })`.
  `code` is from `ERROR_CODES`; `message` is English, for logs only, and MUST NOT carry a name, a phone
  number or a رقم مرجعي (those go in `params` if the screen needs them); `params` are the values the
  message fills in, raw (numbers stay numbers, the frontend formats them); `details` is data the client
  acts on.
- A new code needs `errors.<CODE>` in `apps/frontend/messages/ar.json` and `en.json`, with the same
  placeholders: `apps/frontend/lib/api-errors.test.ts` fails otherwise. A code is API: never rename or reuse
  one ([packages/shared-schemas/CLAUDE.md](../../packages/shared-schemas/CLAUDE.md)).
- The filter sends `{ code, kind, message, params?, details?, correlationId }`. `kind` is the class
  (`NOT_FOUND`, `CONFLICT`, `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `TENANT_MISMATCH`,
  `TENANT_NOT_PROVISIONED`) and decides the status; a Nest `HttpException` is `HTTP_ERROR`, anything else a
  generic 500 `INTERNAL_ERROR` reported to Sentry.
- MUST NOT add a prose throw (`new ConflictError('نص')`). The older form still compiles for the sites not
  converted yet: it sends the kind as `code` and its message is shown as is.
  `domain/errors/error-codes.ratchet.spec.ts` counts them and fails if the number grows; lower its
  constant in the same change that converts one. Fix a prose throw when you touch its file.
- Existing `details.code` / `details.reason` values (`STALE`, `TENANTS_LINKED`, `PREVIEW_STALE`, …) are
  kept beside the top-level code because screens still read them; do not add new ones.

Today: the fee, payment, ownership, tenancy, landlord-link, correction, citizen-file and damage services
are converted; what is left is counted by `LEGACY_PROSE_THROWS` (202 on 2026-10-11). The block-driven refusals (`plan.block.message` in `LandlordLinkService`,
`blockerMessage` in `UnitCorrectionService`, `blocks[0].message` in `CitizenMergeService`) are not: their
text is also rendered in the preview endpoints, which need localising first.

## Transactions

- Multi-step writes MUST use `runInTenantTransaction(this.tenantContext, () => …)`. It re-enters the
  tenant scope with the transaction client, so every service called inside writes through the same
  transaction, and it joins an enclosing one. Defaults: `maxWait` 15 s, `timeout` 60 s.
- MUST NOT call `this.db.$transaction(...)`. Inside a `runInTenantTransaction` scope `this.db` is a
  transaction client with no `$transaction`, and a bare call never swaps the scope, so services and audit
  listeners called inside it write outside the transaction. Existing calls are tracked debt
  ([docs/code-quality.md](../../docs/code-quality.md#backend)).
- Side effects (cache invalidation, Tier 2 audit rows) MUST run after commit: emit after the transaction
  returns, or push onto `scope.transaction.afterCommit`. A write through the closed client fails with
  "Transaction already closed" and the row is lost. A Tier 1 audit row is the exception: it is written,
  awaited, inside the transaction ([Events and audit](#events-and-audit)).
- Row locks use `FOR UPDATE` with `SET LOCAL lock_timeout`; parallel creators serialise on
  `pg_advisory_xact_lock(hashtext(key))`. Database-level rules (lock keys, constraints, `P2002`):
  [docs/database.md](../../docs/database.md#transactions-and-constraints).

## Events and audit

Every state change MUST leave an `audit_log_entries` row, in one of two tiers
([docs/security.md](../../docs/security.md#data-integrity-and-transactions)):

1. **Tier 1, inside the transaction.** A one-off charge (`FEE_INDIVIDUAL_LEVIED`), cancelling a bill
   (`FEE_BILL_CANCELLED`), a Whish success set aside (`WHISH_CHECKOUT_MISMATCHED`), a settings save
   (`SETTINGS_UPDATED`, the treasury fields with their values before and after). Payments (declarations, confirmations, refusals, counter and Whish
   settlements, and a settlement of several bills: one row per bill and one for the set), payment reversals, activating the treasury, opening a wallet, recording and cancelling an expense
   and every step of its payment order, paying an inspector's commission, recording and cancelling an
   income voucher, adding or editing an expense or income category, receiving a collector's custody,
   recording a transfer or an exchange, clearing an exchange's review and cancelling a transfer,
   counting the treasury, closing (and sweeping) and reopening a day, every step of a municipal
   request (filing it, raising its fee, its paid and reversed sync, approving, rejecting, handing over,
   cancelling, adding a paper, each staff view of a paper, a change to the request types), corrections, ownership changes (ending an ownership, making, updating
   or ending an owner link, a merge or its undo), ending a tenancy, review decisions (approving or returning
   a record, completing a quality check) and citizen status changes (archive and restore; a citizen file
   is never deleted). The row is written in the same transaction as the change; if it fails, the change
   rolls back.
   - In `runInTenantTransaction`: `AuditService.recordInTransaction(entry)`, or
     `recordChangeInTransaction({ channel, payload })` for a change that is also a `citizen.changed` /
     `building.changed` event. Emit that event after the commit with `alreadyAudited: true`.
   - A write that owns its transaction passes its client: `recordInTransaction(entry, tx)`, or
     `recordChangeInTransaction(change, tx)`. `CitizensService.update` does the second for an owner
     link its save undoes (a linked card removed, or its landlord number changed): `LANDLORD_UNLINKED`
     on the owner's file and on the tenant's, as `LandlordLinkService.unlink` writes them. The payment
     ledger does this, and `PaymentLedgerService.record` / `reverse` take a **required** `audit` callback,
     so no code path can move money without a row.
   - `recordInTransaction` throws when called outside a transaction.
   - Models: `PaymentLedgerService.record`, `OwnershipService.end`, `LandlordLinkService.recordAnnouncement`.
2. **Tier 2, after the commit.** Everything else (a phone number, a preference, a building edit): emit
   `<entity>.changed` with `{ tenantSlug, action, <entity>Id, actorId, actorRole, before?, after? }` and give
   `AuditService` an `@OnEvent` for it. `record` queues on `afterCommit` inside a transaction; a failed
   write is logged (`AUDIT WRITE FAILED`) and the change stands. A damage reading is one:
   `damage.recorded` goes to `AuditService.onDamageRecorded` (`DAMAGE_RECORDED`, filed under the
   building with the unit's id and code in `after`), because a reading can hold or resume a flat's
   fees; «فواتير تأثّرت بتصحيحات» finds the holders by that code (`bill-corrections.ts`).

A row no person caused (the recurring biller's scheduled run, a Whish settlement) MUST carry
`actorId: null` and `actorType: 'SYSTEM'`, never a placeholder: `actorId` is a uuid, and a string
there is refused, in Tier 2 silently. `POST fees/recurring/run` passes the staff member who called
it to `FeesService.runRecurringBilling(now, actor)`; the cron passes none. No screen calls that route
(the fees page's «إصدار الفواتير» was removed in `d346729`).

Event names are string literals. Emission is synchronous with no wildcards, because listeners rely on the
request's tenant scope. A misspelt or unheard name is dropped silently. Add each new action's label to
`auditActions` in both message files (`apps/frontend/messages/{ar,en}.json`), which
`apps/frontend/lib/audit-labels.ts` reads. An audit row names a citizen by id and MUST NOT carry a login
credential: a رقم مرجعي goes in only as `ReferenceNumber.mask(...)`
([docs/security.md](../../docs/security.md#data-integrity-and-transactions)).

Reading the log (`AuditController`, `AUDIT_READ_ROLES`): `GET audit` and `GET audit/daily` take
`?actorId=` through `auditActorFilterSchema` (shared-schemas): a person's id, or `AUDIT_SYSTEM_ACTOR`
(`SYSTEM`) for the entries no person made, whose `actorId` is NULL (a Whish callback, the scheduler's
billing). The controller maps `SYSTEM` to `AuditQuery.systemActor`, which
`PrismaAuditRepository.where()` reads as `"actorId" IS NULL`; it is how the daily report's «النظام» row
drills down to its own entries (`audit-daily.integration.spec.ts`). The actor facets list staff only.

## Recipe: add an endpoint

Model: commit `f9fd805` — `CorrectionsController`, `UnitCorrectionService`, `unit-correction.plan.ts`.
1. Schema change? Ship the migration first, in its own PR ([docs/database.md](../../docs/database.md#migrations)).
2. Contract: `packages/shared-schemas/src/<feature>.schema.ts` with the zod schema, its `z.infer` type
   and the response interfaces (copy `unitCorrectionDeleteSchema`). Export it from `src/index.ts`, then
   `pnpm --filter @mechanization/shared-schemas build`; the backend reads `dist/`
   ([packages/shared-schemas/CLAUDE.md](../../packages/shared-schemas/CLAUDE.md#add-a-schema)).
3. Pure rules with no I/O in `application/features/<area>/<feature>.plan.ts` (copy `planUnitCorrection`),
   unit-tested in `<feature>.plan.spec.ts`.
4. Service in `application/features/<area>/<feature>.service.ts`: inject `TenantContextService` and
   `EventEmitter2` (plus a port where one exists); add `private get db()` and `private get S()`; writes in
   `runInTenantTransaction`; domain errors with a case code; emit after the transaction.
5. Audit: an `@OnEvent` handler in `AuditService` plus the label under `auditActions` in both message files.
6. Controller in `presentation/controllers/<feature>.controller.ts`: `@Roles` on every handler,
   `ParseUUIDPipe` ids, `ZodValidationPipe` body, `@CurrentUser()`, no try/catch.
7. Register the service in `ApplicationModule` `providers` and `exports`, the controller in `PresentationModule`.
8. Tests: the plan spec, plus `<feature>.integration.spec.ts` copied from `unit-correction.integration.spec.ts`.
9. Client function in `apps/frontend/lib/api-client.ts` ([apps/frontend/CLAUDE.md](../frontend/CLAUDE.md)).
10. Walk the new-endpoint checklist in [docs/security.md](../../docs/security.md), then update docs per
    [Keeping the docs true](../../CLAUDE.md#keeping-the-docs-true).

## Environment variables

Declared in `envSchema` (`presentation/config/env.schema.ts`). Names only; never open a `.env` file.

| Variable | Rule |
|---|---|
| `NODE_ENV` | Defaults to `development`. MUST be `production` on every deployed process: every production check keys on it |
| `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` | Required everywhere. `JWT_SECRET` is at least 32 characters and differs per environment |
| `AWS_REGION`, `S3_DOCUMENTS_BUCKET`, `S3_CADASTRE_BUCKET`; `OTP_ENABLED` | Required in production, the two buckets different; `OTP_ENABLED=false` is refused in production |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`; `SMTP_HOST` + `MAIL_FROM` | Optional, each pair set together. Also `AWS_SESSION_TOKEN`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` |
| `PORT`, `PASSWORD_RESET_TTL`, `JWT_STAFF_TTL`, `JWT_STAFF_IDLE_TTL`, `JWT_STAFF_REMEMBER_TTL`, `JWT_CITIZEN_TTL`, `REDIS_URL`, `DASHBOARD_CACHE_TTL_SECONDS`, `TENANT_CACHE_TTL_SECONDS`, `AUDIT_CACHE_TTL_SECONDS`, `QUALITY_CACHE_TTL_SECONDS` | Optional or defaulted in the schema; a quality TTL of 0 disables that cache |
| `CRON_SECRET`, `METRICS_TOKEN` | Optional; unset closes `api/v1/internal/cron` and `/metrics` |
| `SCHEDULER_ENABLED` | Unset means every non-Vercel process schedules; set false on all processes but one |
| `TZ`, `PUBLIC_API_URL`, `PUBLIC_PORTAL_URL`, `CORS_ORIGINS`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT` | Optional |
| `SMS_PROVIDER_API_KEY`, `SMS_PROVIDER_FALLBACK_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Inert: no SMS provider is implemented, and the Supabase adapters are unbound |

Read but not declared: `WHISH_API_URL`, `WHISH_API_KEY`, `WHISH_WEBHOOK_SECRET` (a deviation: declare
them, in the change that writes `postCheckout`; until then, in a deployed build, a value set only in
the `.env` file never reaches the gateway, because `validate` copies into `process.env` only the keys
`envSchema` returns — locally the generated Prisma client loads `apps/backend/.env` itself, so there it
does), and `VERCEL`, `VERCEL_GIT_COMMIT_SHA`, `NODE_APP_INSTANCE`, `MIGRATION_LOCK_TIMEOUT`,
`MIGRATION_STATEMENT_TIMEOUT`, `SEED_CITIZENS`, `TEST_DATABASE_URL`.

## Commands

| Purpose | Command |
|---|---|
| Run against the local DB (target guard first) | `pnpm --filter @mechanization/backend dev`, or root `pnpm dev` for both apps |
| Build; lint | `pnpm --filter @mechanization/backend build`; `pnpm --filter @mechanization/backend lint` |
| Unit tests; one pattern | `pnpm --filter @mechanization/backend test`, `… test -- <pattern>` |
| Typecheck (no backend script); Prisma clients; local seed | root `pnpm typecheck`; `pnpm db:generate`; `pnpm db:seed`, `pnpm db:seed:census` |

MUST NOT run `prisma:deploy:registry` or `tenant:migrate-all` directly; use `pnpm db:deploy:<target>`
([docs/database.md](../../docs/database.md#name-the-target)). `test:e2e` is broken: the `test` directory it
points at does not exist. `src/scripts/reset-2fa.ts` has no script entry and MUST NOT be run
([docs/security.md](../../docs/security.md#known-gaps)).

## Tests

- Jest with ts-jest (`jest.config.js`: `rootDir` `src`, `*.spec.ts` beside the source): 160 spec files, 49 of them `*.integration.spec.ts` (counted on disk 2026-10-15, PR #122 rebased onto `develop@3211140`).
- Integration specs run only when `TEST_DATABASE_URL` is set (`describeIfDb`) and skip silently otherwise.
  They `DROP SCHEMA … CASCADE` and rebuild fixed `tenant_*_spec` schemas on whatever database it names,
  and nothing checks the target. Point it ONLY at a throwaway Postgres 17 container (migration `0044`
  needs 17), NEVER at `municipality_db_local`, staging or production. CI uses `postgres:17-alpine` (`ci.yml` job `verify`).
- Locally: the throwaway-container commands and which suites to run are in
  [docs/database.md](../../docs/database.md#test-a-migration-on-a-throwaway-postgres-17).
- Convention specs: `raw-sql-is-schema-qualified.spec.ts`, `migration-guards-are-schema-scoped.spec.ts`,
  `domain-enum-drift.spec.ts` (the domain's enums, `StaffRole` among them, against the shared ones),
  `tenant-isolation.spec.ts`, `env.schema.spec.ts`, `route-inventory.spec.ts` (`@Public` / `@Roles` over
  every controller, and the «مشاهد فقط» boundary). Missing: HTTP-level tests (only `metrics.spec.ts` boots
  an app), an every-event-has-a-listener test.

## Municipal requests (0092)

`application/features/citizen-requests/citizen-requests.service.ts`; design: [docs/municipal-requests-plan.md](../../docs/municipal-requests-plan.md), decisions: [docs/open-decisions.md §20](../../docs/open-decisions.md#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13).

- **One `submit` for both ways in.** The portal (`POST requests/mine`, the citizen from the token) and the
  counter (`POST requests`, `REQUEST_HANDLE_ROLES`, the clerk recorded as `createdById`) take the same
  checks, the advisory lock and `clientRequestId` replay of the treasury forms — bound to every field the
  paper reads (citizen, type, capacity, card, unit, purpose, channel), so an edit after a lost answer is
  `REQUEST_KEY_REUSED`, never answered as the first — and a «REQ-» number
  (`DOCUMENT_PREFIX.REQUEST`). A type is filed only once the manager has switched it on in
  `request_type_settings`; a card must be the citizen's and current.
- **The fee's bill is raised when the citizen goes to pay** (`raiseBill`), through
  `fees/one-off-bill.ts` (`raiseOneOffBill(tx, schema, …)`, the body of `FeesService.chargeIndividual`,
  callable inside a transaction), which stamps who raised it (`issuedById`: the clerk at the counter,
  nobody for a citizen's own press). A request abandoned before payment leaves no open debt; a request
  is cancelled by the citizen or a clerk only while it has no bill, and by the manager's «إلغاء الفاتورة»
  once it has one: `FeesService.cancelBill` cancels the request waiting on the bill in its own
  transaction (`cancelRequestOfCancelledBill`, decision of 2026-10-13), which `0094`'s guard allows only
  once the bill is CANCELLED.
- **A card or a flat a request names is never deleted.** `0092`'s keys onto `property_entries` and
  `building_units` are RESTRICT. The citizen-file save refuses before writing to delete one
  (`PROPERTY_NAMED_BY_REQUEST`, pointing to «إنهاء الملكية» / «إنهاء الإيجار»), and a landlord-link undo
  keeps it and reports it (`HAS_REQUESTS`). Any new path that deletes either table must do the same
  (docs/gotchas.md, "A new RESTRICT key turns an existing delete into a 500").
- **Online payment is paused** (the product owner, 2026-10-13, [open-decisions §21](../../docs/open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)).
  While the Whish gateway is not live (`WhishGateway.isLive`: `WHISH_API_URL` and `WHISH_API_KEY` set,
  nothing more — so they must not be set before `postCheckout` is written, or the refusal lifts into
  500s), `FeesService.startWhishCheckout` and a citizen's own `raiseBill` refuse with
  `ONLINE_PAYMENT_UNAVAILABLE` before anything is read or written; the counter raises the fee. The
  sandbox the gateway runs without credentials is unreachable from the checkout: it moved a bill to
  PENDING_REVIEW under a `WSH-` reference of our own, with no money taken.
- **Paid is the bill's word.** `@OnEvent('payment.reviewed')` and `@OnEvent('payment.reversed')`
  (resolving the bill through `payment_transactions`, whose event carries no `paymentId`) call
  `reconcile`, which moves AWAITING_PAYMENT ↔ IN_REVIEW only on a PAID bill and writes a SYSTEM audit
  row. The event emitter swallows a listener's failure, so the queue, a request and «طلباتي» reconcile
  again on every read (one indexed query when nothing moved). The same pass moves an unbilled request
  still waiting for its fee to IN_REVIEW once the manager has made its type free (`REQUEST_FEE_WAIVED`,
  no `paidAt`): the fee is the one in force when the bill is raised (D1), and otherwise it could be
  neither billed nor approved.
- **A براءة ذمة is judged on approval** with `ParcelDuesService.dues`: refused while the parcel owes
  (`REQUEST_CLEARANCE_DUES_OUTSTANDING`), and the check kept on the request (`clearanceSnapshot`).
- **Papers**: `FileInterceptor` caps the size (`REQUEST_ATTACHMENT_MAX_BYTES`, one file), the bytes are
  typed by `application/common/file-sniff.ts` (JPEG, PNG, WebP, PDF; never the declared type), the object
  is written before the row and removed if the row cannot be recorded. Staff open one through a
  five-minute signed URL with an audit row; the portal never gets one.
- **A citizen merge** moves the absorbed person's requests to the kept file (`requests` in the footprint,
  put back by the undo), except an open one that would break the one-open index.

## Current state and known issues

- Security gaps, with severity and fix: [docs/security.md](../../docs/security.md#known-gaps).
- Backend debt (god files, bare `$transaction`, repeated role lists, dead Vercel and Supabase code): [docs/code-quality.md](../../docs/code-quality.md#debt).
- Traps (middleware wildcard, nested transactions, two Prisma clients, scheduler ownership): [docs/gotchas.md](../../docs/gotchas.md).
