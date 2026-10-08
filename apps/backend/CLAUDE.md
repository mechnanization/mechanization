# apps/backend — the NestJS API

Last verified against the code: `feat/unit-fee-exemptions`, 2026-10-08.

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
  `violatedCheckConstraint` (`infrastructure/prisma/check-violation.ts`, which turns the `0072` CHECKs'
  refusal into a coded `ValidationError`), and types or the `Prisma` namespace from
  `src/generated/tenant-client`. `TenantPrismaFactory` only in a background job that builds a tenant scope.
- Application code MUST NOT import a `Prisma*Repository`, an adapter (`S3StorageService`,
  `SmtpEmailSender`, `SmsProviderService`, `WhishGatewayService`, `BcryptPasswordHasher`,
  `OtplibTotpService`) or `RegistryPrismaService`. Inject the port symbol (`IMAGE_STORAGE_SERVICE`,
  `EMAIL_SENDER`, `PASSWORD_HASHER`, …) instead.
- Presentation MUST NOT touch Prisma, except at the two composition points: `TenantMiddleware`
  (`TenantContextService`, `TenantPrismaFactory`) and `HealthController` (`RegistryPrismaService`).
- Deviations today (`ZonesService` → `CadastreAssetsService`, `CadastreImportService` →
  `buildCadastreGeometryAssets`, `OtpService` / `DocumentService` → `APP_CONFIG`, `registration.repository.ts`
  → `normalizeSearchText`) are tracked in [docs/code-quality.md](../../docs/code-quality.md).

## Module wiring

- `AppModule` (`src/app.module.ts`): `ConfigModule` (global, `validateEnv`), `EventEmitterModule`
  (global, synchronous), `ScheduleModule` only when `isSchedulerEnabled()`, `ThrottlerModule`
  (in-memory, 120 requests per 60 s), then `DomainModule`, `InfrastructureModule`, `ApplicationModule`,
  `PresentationModule`. A fifth import means something escaped its layer.
- `InfrastructureModule` is `@Global()` and binds each port symbol in use to its adapter
  (`SUPABASE_AUTH_SERVICE` is declared but unbound). `ApplicationModule`
  registers `JwtModule` (`JWT_SECRET`) and every service and job. In both, a new entry goes in `providers` AND `exports`.
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
- **Role lists.** `@Roles(...)` takes a set from `role-sets.ts` in `@mechanization/shared-schemas`
  (`EVERY_STAFF_ROLE`, `WORKING_STAFF_ROLES`, `REGISTER_WRITE_ROLES`, `CENSUS_WORKLIST_ROLES`,
  `FEE_ISSUE_ROLES`, `REGISTER_EXPORT_ROLES` and the rest), never a literal list: the frontend's
  `lib/staff-roles.ts` reads the same sets, so a route and its button move together. A new audience is a
  new named set there. `route-inventory.spec.ts` checks every controller on disk: `@Roles` on every
  non-public route (or a reviewed entry in its `SELF_SERVICE` list), «مشاهد فقط» on no write and no
  side-effecting GET, and no route that deletes a citizen.
- **Staff sessions.** Rotating refresh tokens in an httpOnly cookie (`StaffRefreshTokenService`,
  `presentation/http/staff-refresh-cookie.ts`), checked by family in `JwtAuthGuard`; expired rows are
  pruned by `StaffRefreshTokenCleanupJob`. Rules: [docs/security.md](../../docs/security.md#tokens-passwords-and-totp).
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
  `FEE_NO_MATCHING_CITIZENS`. The portal gets this owner's part and never the responsible owner's id;
  under «مالك مسؤول» the part (1/1 or 0/1) says who pays, read the same way on both sides.
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
- **Searching citizens as «مشاهد فقط».** The register, the review queue and the payments list match a
  citizen through `citizenSearchText(S, role)` (`application/common/citizen-search.ts`) rather than
  `u."searchText"` directly: for VIEWER it removes the رقم مرجعي (folded and compact) from the searched
  text, so a role that is never shown the reference cannot confirm one by searching. A new citizen search
  uses it too.
- **The citizen portal names what it sends.** `CitizenController.mySummary` builds «ملفّي» from the staff
  profile: a flat's owners go as an allowlist (name and أسهم), the landlord link's id and reference are
  dropped, and everything else on a property or unit passes through, so decide for each field you add to
  `CitizenProfile` ([docs/gotchas.md](../../docs/gotchas.md)).
- **Who is calling.** `@CurrentUser()` yields `SessionClaims` (`application/features/identity/identity.service.ts`);
  `@CurrentTenant()` yields `req.tenant`. Pass the actor to services as `{ id: user.sub, role: user.role ?? '' }`.
- **Validation.** `@Body(new ZodValidationPipe(schema))`, schema from `@mechanization/shared-schemas`. Put
  the pipe on the parameter, never in `@UsePipes` (it would validate `tenantSlug` too). Ids:
  `new ParseUUIDPipe()`. Dates: `parseDate` / `requireDate` (`presentation/controllers/query-params.ts`).
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
are converted; what is left is counted by `LEGACY_PROSE_THROWS` (206 on 2026-10-06). The block-driven refusals (`plan.block.message` in `LandlordLinkService`,
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

1. **Tier 1, inside the transaction.** Payments (declarations, confirmations, refusals, counter and Whish
   settlements), payment reversals, corrections, ownership changes (ending an ownership, making, updating
   or ending an owner link, a merge or its undo), ending a tenancy, review decisions (approving or returning
   a record, completing a quality check) and citizen status changes (archive and restore; a citizen file
   is never deleted). The row is written in the same transaction as the change; if it fails, the change
   rolls back.
   - In `runInTenantTransaction`: `AuditService.recordInTransaction(entry)`, or
     `recordChangeInTransaction({ channel, payload })` for a change that is also a `citizen.changed` /
     `building.changed` event. Emit that event after the commit with `alreadyAudited: true`.
   - A write that owns its transaction passes its client: `recordInTransaction(entry, tx)`. The payment
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

Event names are string literals. Emission is synchronous with no wildcards, because listeners rely on the
request's tenant scope. A misspelt or unheard name is dropped silently. Add each new action's label to
`auditActions` in both message files (`apps/frontend/messages/{ar,en}.json`), which
`apps/frontend/lib/audit-labels.ts` reads. An audit row names a citizen by id and MUST NOT carry a login
credential: a رقم مرجعي goes in only as `ReferenceNumber.mask(...)`
([docs/security.md](../../docs/security.md#data-integrity-and-transactions)).

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
them), and `VERCEL`, `VERCEL_GIT_COMMIT_SHA`, `NODE_APP_INSTANCE`, `MIGRATION_LOCK_TIMEOUT`,
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

- Jest with ts-jest (`jest.config.js`: `rootDir` `src`, `*.spec.ts` beside the source): 119 specs, 27 of them `*.integration.spec.ts`.
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

## Current state and known issues

- Security gaps, with severity and fix: [docs/security.md](../../docs/security.md#known-gaps).
- Backend debt (god files, bare `$transaction`, repeated role lists, dead Vercel and Supabase code): [docs/code-quality.md](../../docs/code-quality.md#debt).
- Traps (middleware wildcard, nested transactions, two Prisma clients, scheduler ownership): [docs/gotchas.md](../../docs/gotchas.md).
