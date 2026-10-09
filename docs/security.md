# Security

Last verified against the code: `feat/finance-treasury-expenses` (on `develop@4512abf`), 2026-10-09.

Binding for every change that touches authentication, roles, tokens, validation, uploads, logging,
headers, client storage or secrets. The rules below are correct practice. Where the code differs today,
the difference is a row in [Known gaps](#known-gaps), not a precedent. Backend structure and conventions:
[apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md). Frontend structure: [apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md).

Moving data between environments is not covered here. Citizen data never leaves staging or production;
the rules are in [docs/database.md](database.md#moving-data-between-environments).

## Threat model

**Assets.**
- Citizen rows in the tenant schemas: national and identity document numbers, civil record number,
  phone, mother's name, home location, `residentStatus` (residency and refugee status), nationality,
  marital status, household composition.
- Scanned identity documents in the private S3 bucket (`S3_DOCUMENTS_BUCKET`).
- The رقم مرجعي (`users.referenceNumber`). It is a **login credential**, stored in plaintext.
- Staff `passwordHash` (bcrypt) and `totpSecret` (plaintext); `JWT_SECRET`.
- Database dumps and the age key that decrypts them; the integrity of `audit_log_entries`.

**Actors.**
- An anonymous caller: guessing references, abusing OTP and SMS, enumerating public endpoints.
- A citizen with a valid token: reading or changing another citizen's records through the `mine` routes.
- A staff member of municipality A: reaching municipality B, or acting above their role.
- A script injected into the portal: reading tokens from Web Storage.
- Whoever next uses a shared or stolen municipal device: Web Storage, the offline queue, drafts.
- A CI or supply-chain attacker: the SSH deploy key, actions pinned by tag.
- An operator or agent mistake: the wrong target, `NODE_ENV` unset, a dump left on a laptop.

**Trust boundaries.**
- Browser → portal (Next.js on Vercel) and browser → API (nginx → Node under pm2 on Lightsail).
- nginx → Node: no `trust proxy` is configured, so the app cannot see client addresses.
- API → Postgres: one role per environment spans every tenant schema, so isolation is enforced by the
  application (connection-per-schema), not by database grants.
- CI → the box over SSH. The migration job's tunnel pins host keys (`SSH_KNOWN_HOSTS`); the
  deploy job's `appleboy` steps pass no host fingerprint.
- App → Sentry (scrubbed before sending), app → S3 (presigned reads), Whish → app (HMAC callback).

## Rules

### Authentication and authorisation

- `JwtAuthGuard` MUST stay global. A route opts out only with `@Public()`, and every public route MUST
  either carry its own credential check (an HMAC as in `WhishGatewayService.parseCallback`, a bearer
  secret compared in constant time as in `MetricsController`, a signed token) or be deliberately
  anonymous with a comment saying why. Its throttle rule is under
  [Transport, headers and rate limits](#transport-headers-and-rate-limits).
- Deny by default. Every non-public handler MUST declare who may call it with `@Roles(...)`. A route
  without `@Roles` is reachable by citizen tokens today (gap below). Until the guard denies by default, a
  self-service route without `@Roles` MUST check `user.kind` itself and scope every query by `user.sub`.
- A handler's `@Roles` replaces the class's (`getAllAndOverride`). Read the method decorators before
  assuming the class-level role applies.
- `JwtAuthGuard` MUST NOT be given work that can refuse a request for a reason unrelated to
  authentication. It stamps `users.lastSeenAt` (`StaffPresenceService`, `0070`) only after every
  check has passed, without awaiting it, and that call swallows its own errors by contract: a failed
  presence write must never become a 401 or a 500 on an officer's save, nor a delay on it. Anything
  added there follows the same rule, or it does not belong in a guard. A request carrying
  `x-background-request` (`BACKGROUND_REQUEST_HEADER`, sent by the portal's own polls) is not stamped:
  a screen left open is not a person at work. Staff presence is readable only through `/staff` and
  `GET staff/presence`, both `@Roles('SUPER_ADMIN')` — when it is surfaced anywhere else, that is a
  new decision, because who was at their desk and when is surveillance of staff and not a
  general-purpose field.
- «مشاهد فقط» (`VIEWER`) is the municipality head's account (decision of 2026-10-05): it reads the
  dashboard, the reports and the register with its citizens' data, and changes nothing. Role sets live
  in one place, `role-sets.ts` in `@mechanization/shared-schemas`, and VIEWER is in none that writes.
  It MUST NOT be given a رقم مرجعي: `ViewerCredentialMaskInterceptor` (an `APP_INTERCEPTOR`) masks, in
  every response to that role, the value of each key known to carry one (`referenceNumber`,
  `citizenReferenceNumber`, `citizenReference`, `landlordReferenceNumber`) and, by the reference's own
  pattern, any reference inside any other string (`ReferenceNumber.maskWithin`), so a key nobody listed
  cannot leak it. Nor can a search confirm one: for VIEWER the register, the review queue and the
  payments list search a citizen's text with the رقم مرجعي taken out (`citizenSearchText`,
  `application/common/citizen-search.ts`), so typing a guessed reference finds nobody, while a name or
  a phone still does. A session that cannot write the register never sends a device's offline queue and is
  offered no control that sends, changes or discards it, and a write page reached by its address sends
  it back. It does not export the
  register (`REGISTER_EXPORT_ROLES`), open identity-document scans (`WORKING_STAFF_ROLES` on the
  documents routes), or read the audit log (`AuditController`, `AUDIT_READ_ROLES`); it does read a
  record's own «سجل التعديلات» (`GET citizens/:id/history`, `GET buildings/:id/history`), which shows
  changes and never who viewed what. `route-inventory.spec.ts` pins all of this over every
  controller on disk: every non-public route has `@Roles` or is on its reviewed self-service list, no
  write and no side-effecting GET (`SIDE_EFFECT_GETS`) admits VIEWER, and no route deletes a citizen.
- A citizen file is never hard-deleted (decision of 2026-10-05). It is archived — `isActive: false`
  through `PATCH citizens/:id/active` — with a written reason and who asked (`setCitizenActiveSchema`
  requires both), recorded on the Tier 1 audit row, and restored the same way.
- What the citizen portal sends about anyone else is named, never passed through: `mySummary` sends a
  flat's owners as name and أسهم only (an allowlist, pinned by `citizen-portal.spec.ts`) and drops the
  landlord link's id and رقم مرجعي. Its property and unit fields still pass through by spread, so a
  field added to the staff profile reaches «ملفّي» unless it is named out
  ([docs/gotchas.md](gotchas.md#a-field-added-to-the-staff-profile-reaches-the-citizen-portal)).
- Scope citizen reads and writes by `user.sub` in the WHERE clause: `findFirst({ where: { id, citizenId } })`
  as in `FeesService.declare`. Where a row is fetched first and compared (`FeesService.startWhishCheckout`),
  another citizen's row MUST get exactly the not-found answer, so ids cannot be probed.
- Every query on `users` MUST filter `kind`, in the WHERE of writes as well as reads
  (`PrismaUserRepository.findCitizenByReference` does; `hideStaff` and friends do not, see
  [docs/code-quality.md](code-quality.md)).
- The token's tenant MUST equal the URL's tenant (`JwtAuthGuard`, `TenantMismatchError`). MUST NOT
  accept a tenant, slug or schema from a body or query string.
- Any change to a password, role, active flag or second factor MUST bump `tokenVersion` and call
  `SessionRevocationService.forget`, as `IdentityService.changeStaffPassword` does.
- Changing a second factor (enrol, confirm, disable) MUST require re-authentication: the current
  password and a current TOTP code. A confirmed factor MUST stay active until its replacement is confirmed.
- Non-session tokens MUST be signed with a derived purpose key (`IdentityService.resetSigningKey`),
  never with `JWT_SECRET` itself: the guard would accept them as sessions.
- Sign-out MUST end the session on the server (revoke), not only clear the browser (gap below).

### Validation

- Every `@Body()` MUST go through `new ZodValidationPipe(schema)` with a schema from
  `@mechanization/shared-schemas`, on the parameter, never in `@UsePipes`. MUST NOT take a raw
  `@Body()` or `@Body('field')`.
- Id params MUST go through `new ParseUUIDPipe()` (as in `CorrectionsController`). Query strings MUST be
  parsed and clamped by a zod schema or the helpers in `presentation/controllers/query-params.ts`.
- MUST NOT add `.passthrough()` or `z.record(z.unknown())` unless a later strict parse re-validates the
  payload, as `unexcusedIssues` does for the admin citizen submission.
- Uploads MUST cap size in the interceptor (`FileInterceptor` limits from `APP_CONFIG`), check the
  content rather than the client-declared MIME type, and write under a tenant-specific key.

### Errors and logging

- Throw domain errors and let `DomainExceptionFilter` map them. MUST NOT put Prisma or provider error
  text into a client-facing message. The filter already sends a generic 500 with a correlation id.
- MUST NOT log, to stdout or Sentry: a secret, a token, a رقم مرجعي, a phone number, a national or
  document number, an email address, a request body, or a URL with its query string. Use
  `PhoneNumber.masked`, and pass text through `redactText` / `redactUrl`
  (`apps/backend/src/presentation/config/sentry-redaction.ts`).
- Sentry stays allowlist-based. Backend: `sendDefaultPii: false` and `beforeSend` running `scrubEvent`.
  Frontend: `SHARED_SENTRY_OPTIONS` (`apps/frontend/lib/sentry-options.ts`) with `tracesSampleRate: 0`,
  no Replay, and `beforeBreadcrumb` dropping `console`, `fetch`, `xhr` and every `ui.*` crumb (a click
  crumb carries the clicked text, which on a register is a name). Identify a request by its
  correlation id, never by a citizen's name.
- Search terms never go in a URL; they live in tab sessionStorage (`useTabSearch` in
  `lib/use-url-state.ts`, over `lib/tab-search.ts`).

### Tokens, passwords and TOTP

- Passwords: bcrypt cost 12 (`BcryptPasswordHasher`); staff passwords at least 10 characters
  (`staffPassword` in `packages/shared-schemas/src/auth.schema.ts`).
- Staff login MUST spend the same work and return the same sentence for an unknown email and a wrong
  password (`ABSENT_PASSWORD_HASH`).
- TOTP: every accepted step is burned (`recordTotpStep`) so a code cannot be replayed. The verifier
  SHOULD accept one step either side, and failed codes SHOULD be counted per account.
- OTP codes and references come from a CSPRNG (`randomInt`, `ReferenceNumber.generate`). OTP codes are
  bcrypt-hashed, single-use and capped (`APP_CONFIG.otp`).
- One-time tokens travel in a URL fragment or a POST body, never in a query string, and the link format
  MUST match what the landing page parses.
- JWT sign and verify SHOULD pin `HS256` and set issuer and audience.
- **Staff sessions** (`StaffRefreshTokenService`, `IdentityService.refreshStaffSession`):
  - The access token is short (`JWT_STAFF_IDLE_TTL`, 15 minutes by default) and carries `sid`, its
    refresh family. `JwtAuthGuard` refuses a token whose family is revoked
    (`SessionRevocationService.isFamilyLive`), so signing out stops it at once.
  - The refresh token is opaque, 256 random bits, rotated on every use, and stored only as an HMAC
    keyed from `JWT_SECRET`. It travels only in an `HttpOnly; Secure; SameSite=Strict` cookie with no
    `Path` and no `Domain`, named per account (`staff-refresh-cookie.ts`). It MUST NOT appear in a
    response body, a log, storage or a URL.
  - A refresh needs both the cookie and the tab's own (usually expired) access token, which only
    names the account. Presenting a token after its chain has moved on ends the whole family; a token
    may be exchanged again at most three times while nothing it produced has been used (a lost
    response). The cap `JWT_STAFF_TTL` / `JWT_STAFF_REMEMBER_TTL` is fixed at sign-in.
  - Sign-in, refresh and sign-out run behind `TrustedOriginGuard` (the `Origin` must be in
    `CORS_ORIGINS`) and their own throttle (`APP_CONFIG.throttle.staffSession`, keyed by the hashed
    `Authorization` header).
  - Tabs MUST NOT exchange the cookie concurrently: `apiFetch` serialises exchanges on the
    `mechanization.refresh.<tenant>` Web Lock, and the tab that renews announces the new session on
    the `mechanization.session` `BroadcastChannel` so the tabs queued behind it adopt it instead of
    exchanging again ([apps/frontend/CLAUDE.md](../apps/frontend/CLAUDE.md#session)).

### Transport, headers and rate limits

- The API sets helmet in `createApiApp`. The portal sets HSTS, nosniff, `X-Frame-Options` and the rest
  in `SECURITY_HEADERS` (`apps/frontend/next.config.mjs`), and a per-request nonce CSP in
  `apps/frontend/middleware.ts` (`contentSecurityPolicy`). Keep both.
- MUST NOT add a third-party host to `connect-src`. Tunnel instead, as Sentry does through `/monitoring`.
- `trust proxy` MUST be set to the exact proxy hop before anything relies on `request.ip` (throttling,
  audit). MUST NOT set it to `true`, which lets any client forge `X-Forwarded-For`.
- Every route that checks or mints a credential, sends SMS or mail, or is public MUST carry an explicit
  `@Throttle` with values from `APP_CONFIG.throttle`, or `@SkipThrottle()` with a stated reason (health
  checks, the token-gated `/metrics`). Do not rely on the 120-per-minute default.
- The throttler MUST move to a shared store before a second API instance exists
  ([docs/open-decisions.md](open-decisions.md) §5).
- Shared secrets MUST be compared with `timingSafeEqual` over digests, as `MetricsController` does.
- `/metrics` is protected by `METRICS_TOKEN`, not by nginx path rules: Express matches it
  case-insensitively and with a trailing slash.
- CORS lists exact origins in `CORS_ORIGINS`. Bearer authentication needs no `credentials`.

### Data integrity and transactions

- Multi-step writes run in `runInTenantTransaction`.
- **Audit tiers.** Tier 1 MUST write its audit row inside the transaction of the change, so the change
  rolls back if the row cannot be written: payments (declaration, confirmation, refusal, counter and
  Whish settlement), payment reversals, activating the treasury (`TREASURY_ACTIVATED`: the opening
  balances and the go-live stamp, one transaction), recording and cancelling an expense, recording
  and cancelling an income voucher (`INCOME_RECORDED`, `INCOME_VOIDED`), receiving a
  collector's custody (`CUSTODY_RECEIVED`) and cancelling a transfer, corrections, ownership changes (ending an ownership, owner links,
  merges), ending a tenancy, review decisions (approve, return, quality check) and citizen status changes
  (archive and restore). Everything else is Tier 2: an event
  after the commit, whose failed write is logged and does not undo the change. How:
  [apps/backend/CLAUDE.md](../apps/backend/CLAUDE.md#events-and-audit).
- An audit row MUST NOT carry a credential (OWASP Logging Cheat Sheet; NIST SP 800-53 AU-3(3), which
  limits what audit records hold to what the record needs). A citizen is named by id, and the audit screen
  resolves the person at read time (`audit-view.ts`). Where a human needs a hint, the رقم مرجعي goes in
  only as `ReferenceNumber.mask`: municipality and issue month, `BZR-2607-••••••`. MUST NOT show the
  last four characters, the usual card and tax-number truncation: the six-character suffix *is* the
  credential, and four of its characters leave 1,024 candidates. The filing's own number
  (`registrations.referenceNumber`) is not a credential and may be written in full.
- MUST NOT bypass the append-only triggers on `audit_log_entries`, `payment_transactions` and
  `treasury_entries` (`0001_init`, `0017_payment_ledger`, `0073_treasury_ledger`), MUST NOT `SET session_replication_role`, and MUST NOT reach
  for `TRUNCATE` because a trigger refused a `DELETE`. A refusal is an answer
  ([CLAUDE.md](../CLAUDE.md#how-to-work-here)).
- Uniqueness is enforced by a database constraint and surfaces as a `ConflictError`, never by a
  check-then-insert alone.
- **The treasury (الخزينة).** Wallet balances are the sum of append-only entries. An outflow takes row
  locks on the wallets in id order and refuses to take one below zero (`TREASURY_INSUFFICIENT_FUNDS`);
  the wallet entries of a citizen payment commit in the payment's own transaction. Reading is
  `SUPER_ADMIN`, `ACCOUNTANT`, `AUDITOR` and `VIEWER`; activating is `SUPER_ADMIN` only
  (`TREASURY_*_ROLES` in shared-schemas). A payer or payee name on a voucher is personal data: it
  stays out of logs, Sentry and audit rows ([finance.md](finance.md)).
- **Expenses.** Recording an expense is paying it, so the write is guarded on both sides: an
  in-flight ref and an idempotency key the server honours, and the outflow goes through the same
  locked, never-negative ledger post as everything else. `payee` is free text that may name a
  citizen, so the audit row carries the voucher number and the figures, never the name.
  **Salaries** (`POST treasury/expenses/salaries/:staffId`, `TREASURY_WORK_ROLES`, id through
  `ParseUUIDPipe`, body through `recordStaffSalarySchema`) take neither the payee nor the category
  from the body: the server reads the name from the account, with `kind = 'STAFF'` and
  `deletedAt IS NULL` in the WHERE (a citizen's id answers `SALARY_PAYEE_NOT_FOUND`, pinned by a
  test), and files the voucher under the seeded `SALARIES`. The audit row names the staff member by
  id (`payeeStaffId`), never by name. The button lives on «الموظفون», which only `SUPER_ADMIN`
  opens; the route is what decides.
- **Income vouchers** (`t/:tenantSlug/treasury/income`). The expense guards, mirrored: read on
  `TREASURY_READ_ROLES`, record on `TREASURY_WORK_ROLES`, void and the category writes (`POST`,
  `PATCH` on `income/categories`, both Tier 1 audited) on `TREASURY_ADMIN_ROLES`; the body
  and the register's query values through shared zod schemas, ids through `ParseUUIDPipe`. The retry
  key is required and serialised under an advisory lock keyed by schema, so a double press credits
  once. `payerName` (a fine, a rent) may name a citizen: the audit row carries the voucher number and
  figures only. The register's search term goes to the API in the query string, as the other
  registers' do, and so falls under the URL-logging gap below.
- **«من حصّل الجابي»** (`GET /treasury/transfers/custody/:collectorId/collections`) names citizens
  and carries their phone and sector, so it stays on the finance *read* roles. That is deliberate and
  it widens nobody's sight: the register itself (`EVERY_STAFF_ROLE`) already shows every staff role
  the same name and number, and treasury-read is a strict subset of it. A relative's number is
  labelled as a relative's, never passed off as the citizen's own. What the row does **not** carry is
  a رقم مرجعي or a national id — those are sign-in credentials, not contact details. The row's exact
  key set is pinned by an integration test, so widening it again stays a decision somebody makes on
  purpose rather than a field that drifts onto a screen.
- **«جولتي»** (`GET /treasury/transfers/custody/mine`) is the only treasury route a collector may
  call, and the only one on `WORKING_STAFF_ROLES` rather than a `TREASURY_*` list. It is safe
  because it is scoped by `user.sub` **in the query** rather than checked afterwards: there is no id
  in the path to tamper with, so it can only ever answer for the person asking. A new route that
  takes a `collectorId` must go back on `TREASURY_READ_ROLES` — `custody/:collectorId/collections`
  does. Granting the collector `TREASURY_READ_ROLES` instead would have handed him the
  municipality's whole ledger to answer a question about his own pocket.
- **Collector custody.** A payment taken at a door credits that collector's own custody wallet, not
  the safe: until someone counts the notes and receives them, the municipality does not have the
  money and its books must not say otherwise. The handover is a transfer, recorded by a different
  person from the one who collected, and it cannot exceed what the collector holds. The audit row
  names him by id, never by name.
- A money write MUST be safe against double submission on the client (an in-flight guard) and on the
  server (a constraint or idempotent write).

### Tenancy

- The tenant is chosen by the connection, not by a column. Read the client from `TenantContextService`.
  `TenantPrismaFactory` validates schema names (`SAFE_SCHEMA_NAME`) and caches one client per schema.
- All raw SQL is schema-qualified with `tenantSchemaRef` / `tenantSchemaPrefix` and binds every value
  as a parameter (`raw-sql-is-schema-qualified.spec.ts`).
- Every cache key carries the tenant slug (`ReportingService` `cacheKey`, `settings:<slug>:…`).
- Background jobs build one tenant scope per tenant through `TenantContextService.run`. They never
  reuse a client across tenants.

### Secrets at rest

- Every env var is declared and validated in `envSchema`; production-only requirements go in its
  `superRefine` after the `NODE_ENV !== 'production'` return.
- MUST NOT commit `.env*` files, keys, dumps or backups. `.gitignore` covers `.env*`, the age key
  names, `*.age` and JSON dumps in `apps/backend/backups`, not every dump format. Agents MUST NOT open
  a `.env` file and MUST NOT print a secret value; work from names.
- There is no `.env.production` on developer machines. Production credentials live only in GitHub
  Environment secrets and on the API host. `JWT_SECRET` MUST differ between staging and production.
- The backup age secret key lives offline, never on a laptop or in a working tree
  ([docs/database-environments.md](database-environments.md), Backups).
- The S3 buckets stay split (private documents, public cadastre; `envSchema` refuses equal names).
  Documents are served only through `createSignedUrl` (300 s) and every view emits `document.viewed`.
- An export or file that carries رقم مرجعي values is a credential dump and is handled as one.

### Client hardening

- Access tokens: `sessionStorage` by default, `localStorage` only with "remember me" (`saveSession`,
  `apps/frontend/lib/session.ts`). Sent as `Authorization: Bearer` by `apiFetch`. MUST NOT put a token
  in a URL. The staff refresh credential is the httpOnly cookie above, which page script cannot read.
- `dangerouslySetInnerHTML` only with constants or sanitised values (`ACCENT_INIT_SCRIPT`, `safeHslTriple`).
- MUST NOT take a redirect target from a query parameter. `window.location.href` only to a URL the
  server built (the Whish checkout) or an internal route.
- The service worker (`apps/frontend/public/sw.js`) caches only same-origin GET shell and static
  assets, and MUST NOT cache API responses.
- Citizen PII is persisted on the device only by design, and whatever is persisted MUST be cleared by
  `clearSession` or explicitly exempted (gap below).
- `NEXT_PUBLIC_*` values are public: they are inlined into the bundle. MUST NOT put a secret there. The
  Mapbox token (`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`) is a public token and MUST be URL-restricted
  (**Unverified:** that it is).

## Configuration this repository cannot see

The largest hole is not in the code. `pnpm db:check` cannot see Vercel, GitHub or the API host, and
neither can any test.

- **Vercel hosts the portal only.** The API left Vercel for Lightsail. The portal's `NEXT_PUBLIC_*`
  variables (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`,
  `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`) are baked into the bundle at build time, and `SENTRY_AUTH_TOKEN`,
  `SENTRY_ORG`, `SENTRY_PROJECT` are read by the build. Every variable that names an API, a database, a
  bucket or a signing secret MUST be scoped to ONE Vercel environment, so a preview can never reach
  production. **Unverified:** [docs/database-environments.md](database-environments.md) records
  `NEXT_PUBLIC_API_URL` as shared between preview and production, so preview builds call the production
  API. **Unverified:** whether the retired Vercel API project still exists; if it does, its variables
  still name databases and secrets, and they MUST be deleted or scoped.
- **The API host.** The API reads `/var/www/municipality-app-releases/shared/backend/.env`, which
  `deploy-backend.yml` links into each release, plus pm2's ecosystem config. nginx terminates TLS and
  proxies to Node. None of these is in the repository. `NODE_ENV`, `SCHEDULER_ENABLED`, `CRON_SECRET`,
  `METRICS_TOKEN`, `REDIS_URL`, `CORS_ORIGINS` and the instance count are decided there.
- **GitHub.** Environment secrets in `db-staging` and `db-production` hold the database URLs, the backup
  public key and the backup AWS keys. Repository secrets hold `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`
  and `SSH_KNOWN_HOSTS`. Environment reviewers and branch protection decide whether a push to `main`
  migrates and deploys production unattended. As read from the GitHub API on 2026-10-03: `db-production`
  and `db-staging` carry a branch policy and no required reviewer, and branch protection on `main`
  requires one approving review and no status check. Each secret belongs to exactly one environment; a
  production credential MUST NOT be readable by a job that runs for staging or for pull requests.
- **AWS and the rest.** S3 bucket policies (Block Public Access on the documents bucket), the backup IAM
  user's policy, the Mapbox token's URL restrictions, Sentry project settings, DNS.
- **Verify by reading back.** After changing any of these, read the setting back (names, scopes, flags;
  never values) and report what you read. Values are baked in when the process starts or the bundle is
  built: a running Vercel deployment keeps the old values until it is rebuilt, and the API keeps them
  until pm2 reloads it. Check the live deployment, not only the dashboard.
- Changing any of these is a deploy. Do it only when asked. The secrets table is in
  [docs/database-environments.md](database-environments.md); the incident behind this section is
  [docs/incidents.md](incidents.md) #5.

## Checklists

**New endpoint**
1. `@Controller('t/:tenantSlug/<area>')`, so tenant resolution and the token-tenant check apply.
   Copy `CorrectionsController`.
2. `@Roles(...)` on every handler. A role-less self-service route checks `user.kind` and scopes by
   `user.sub` in the query. A `@Public()` route has a comment, its own credential check and a `@Throttle`.
3. Body through `ZodValidationPipe` with a shared schema; ids through `ParseUUIDPipe`; query values
   parsed and clamped.
4. `@Throttle` if it checks or mints a credential, sends SMS or mail, or is public.
5. Domain errors only; no PII in log lines; an audit event for every change, and for every read of
   identity documents or export of citizen data.
6. A test proving a citizen token and another tenant's token are refused (`tenant-isolation.spec.ts` style).

**New page or route handler (frontend)**
1. Data through `apiFetch` with the session token, via `useStaffQuery`. Never a token in a URL.
2. No `dangerouslySetInnerHTML`, no redirect target from a query parameter, no new `connect-src` host.
3. Nothing citizen-identifying persisted on the device unless it is cleared by `clearSession`.
4. Role gating in the page only hides controls; the server's `@Roles` is the enforcement.

**New client-to-server call**
1. Request and response types from `packages/shared-schemas`. Errors surface as `ApiRequestError`;
   `logApiError` writes to the console and forwards 5xx and non-API errors to Sentry.
2. Ids are UUIDs or encoded; search terms go in tab sessionStorage, never in `?q=`.
3. The call goes to `NEXT_PUBLIC_API_URL` only. Any other origin needs a CSP change and a review.

**Before release**
1. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:check` pass, and the `ci.yml` job `audit`
   (`pnpm audit --prod --audit-level high`) is green.
2. Every new env var is in `envSchema` and set, scoped, on the host or in Vercel
   ([Configuration this repository cannot see](#configuration-this-repository-cannot-see)).
3. Migrations are additive and their PR merged first ([docs/database.md](database.md#migrations)).
4. No new `@Public()`, and no new route without `@Roles` or a kind check. Grep the diff for
   `@Get`, `@Post`, `@Patch`, `@Put`, `@Delete` against `@Roles`.
5. `NODE_ENV=production` on the target. It decides `devCode`, `OTP_ENABLED` and the S3 requirements.

## Known gaps

Verified in the code at the commit above. Fix a gap and remove its row **in the same PR**; find one and
add a row. Severity is the harm if exploited today.

| Severity | Gap | Evidence (path + symbol) | Fix |
|---|---|---|---|
| High | Second-factor changes need no re-authentication. Enrolment immediately clears the confirmed factor, and disable checks the password only if one is sent, so a stolen session can remove 2FA and enrol its own | `presentation/controllers/auth.controller.ts` `beginTotpEnrolment`, `disableTotp` (raw `@Body()`); `IdentityService.disableTotp`; `PrismaUserRepository.saveTotpSecret` (`totpConfirmedAt: null`) | Require the current password and a current TOTP code; keep the old factor until the new one is confirmed; zod schema; bump `tokenVersion` |
| High | SUPER_ADMIN 2FA is not enforced. `User.requiresTotp` has no readers, and a spec asserts an unenrolled SUPER_ADMIN signs in | `domain/entities/user.entity.ts` `requiresTotp`; `IdentityService` `challengeTotp`; `staff-login.spec.ts` | Decide (Undecided below). If mandatory, issue an enrolment-only session until confirmed |
| High | No `trust proxy`, so `request.ip` is the proxy's address. Throttle buckets are shared by every client per route (5 per minute for staff login across all staff: a lockout), and login audit IPs are wrong. **Unverified:** the nginx side | `presentation/bootstrap.ts` `createApiApp`; `MetricsController` class comment; `AppModule` `ThrottlerModule.forRoot`; `AuthController` (`context: { ip: request.ip }`) | Set `trust proxy` to the exact hop; Redis throttler storage; per-account limits beside per-IP |
| High | Single-factor citizen login: the رقم مرجعي alone opens a 7-day session that reads phone, mother's name, nationality, resident status and marital status. Distributed guessing needs to hit any one citizen, not a chosen one | `AuthController.openByReference`; `IdentityService.loginByReferenceOnly`; `referenceOnlyLoginSchema` (`fee.schema.ts`); `CitizenController.mySummary` | Product decision (Undecided). Options: a fees-only session unless the phone is also given, a per-tenant failure budget, CAPTCHA after failures, alerting |
| High | The CSV export carries `reference_number` (a login credential) with `phone`, the relative's `contact_phone_relative` and `resident_status` for every citizen. Narrowed to `SUPER_ADMIN` and `AUDITOR` (`REGISTER_EXPORT_ROLES`; «مشاهد فقط» was admitted until 2026-10-06) | `ReportingService.exportCsv`; `DashboardController.exportCsv` | Drop the column, or gate it behind its own permission and audit |
| Medium | Audit rows written before the masking change still hold citizens' رقم مرجعي in plaintext (`CITIZEN_MERGED` / `CITIZEN_MERGED_INTO` `after.other.referenceNumber`, `CITIZEN_DELETED` `before.referenceNumber`). The table is append-only, so they cannot be edited, and anyone who can read the audit log can sign in as those citizens | `audit_log_entries`, rows with those actions; the append-only trigger from `0001_init` | **Undecided:** reissue the affected citizens' references (the leaked ones then sign nobody in), and whether a documented data correction may redact the old rows |
| High | A gitignored age secret-key file sits in a developer machine's working tree | `.gitignore` age-key entries; confirmed with `git check-ignore`, not opened | Move it offline (password manager) and delete the file. Never open it |
| Medium | Authorisation defaults to allow: a non-public route without `@Roles` admits any authenticated token, citizens included. Each such route self-checks today. `route-inventory.spec.ts` now fails on a new role-less route that is not on its reviewed self-service list, so forgetting is caught in CI, but the guard itself still fails open | `RolesGuard.canActivate`; `tenant-isolation.spec.ts` "admits requests to routes without role restrictions"; `route-inventory.spec.ts` `SELF_SERVICE` (the role-less routes in `AuthController`, `CadastreController`, `CitizenController.mySummary`, `FeesController`) | Refuse when no metadata is present unless an explicit self-service marker is declared |
| Medium | PII in stdout: every 4xx and 5xx logs `request.originalUrl` with its query string, 5xx logs the raw exception message, mail failures log the recipient, and dev SMS logs phone and body | `DomainExceptionFilter.catch`; `AppLogger` (no redaction); `SmtpEmailSender`; `SmsProviderService.send` | Log `redactUrl` / `redactText` output, or redact in `AppLogger.formatMessage`; mask recipients |
| Medium | Field-device PII at rest: the offline queue and the citizen draft hold full records in plaintext and survive sign-out | `apps/frontend/lib/offline-db.ts` `QueuedSubmission`; `apps/frontend/lib/citizen-draft.ts` `KEY_PREFIX`; `apps/frontend/lib/session.ts` `clearSession` | Decide (Undecided): encrypt per session, and/or clear on sign-out and on user switch |
| Medium | No server-side sign-out for citizens: a citizen token lives 7 days and `clearSession` only forgets it locally. (Staff sign-out revokes the refresh family: `AuthController.logoutStaff`.) | `IdentityService.loginByReference`, `loginByReferenceOnly`; `apps/frontend/lib/session.ts` `clearSession` | A citizen logout that bumps `tokenVersion` and calls `SessionRevocationService.forget` |
| Medium | Password reset cannot succeed and leaks the token: the email link carries `?token=` (access logs, Referer), while the page parses a Supabase-style `#type=recovery&access_token=` fragment | `IdentityService` `resetLink`; reset page `parseAuthHash` (`app/[tenant]/[locale]/[adminPath]/reset-password/page.tsx`) | Emit the token in the fragment, read it on the page, drop the Supabase parsing, and add a test that ties the two |
| Medium | `NODE_ENV` defaults to `development`. A deploy that omits it returns `devCode` in OTP responses, allows `OTP_ENABLED=false`, skips the S3 requirements and logs SMS bodies. **Unverified:** the value on the host | `envSchema` `NODE_ENV`; `OtpService.issue`; `SmsProviderService.send` | No default: require it explicitly |
| Medium | One database role per environment runs both the API and migrations across every tenant schema, so one SQL bug can reach every municipality | `scripts/db/targets.mjs` `TARGETS` (one `user` checked for `DATABASE_URL` and `DIRECT_URL`) | A DML-only runtime role and a separate migration role; consider per-tenant roles (Undecided) |
| Medium | CI deploy hardening: the deploy job reads repository-level SSH secrets with no `environment:` and no `permissions:`, uses actions pinned by tag, passes no host fingerprint to its SSH steps (only the migration tunnel pins `SSH_KNOWN_HOSTS`), and does not wait for CI or the audit job. Branch protection on `main` requires no status check either (GitHub API, 2026-10-03), so a release can merge, migrate production and deploy with CI red | `.github/workflows/deploy-backend.yml` job `deploy` (`uses: appleboy/scp-action@v0.1.7`, `uses: appleboy/ssh-action@v1.0.3`) | Move SSH secrets into a protected environment, pin actions to SHAs, pass the host fingerprint from `SSH_KNOWN_HOSTS`, `permissions: contents: read`, gate on CI, require the CI and audit checks on `main` |
| Medium | TOTP secrets are stored in plaintext, so every dump carries them | tenant `schema.prisma` `User.totpSecret`; `PrismaUserRepository.saveTotpSecret` | Envelope-encrypt with an app key, or accept and document (Undecided) |
| Medium | The TOTP verifier accepts two steps either side and nothing counts failed codes | `OtplibTotpService` (`window: 2`); `IdentityService` `challengeTotp` | One step either side; a per-account failure counter |
| Medium | Dangerous tracked tools. One dumps citizens, staff hashes and TOTP secrets to plaintext JSON from `apps/backend/.env` with `rejectUnauthorized: false` and no target guard. The other wipes 2FA for every staff account in every tenant with no target check, dry run, confirmation or audit | `apps/backend/backups/dump-tenant.js`; `apps/backend/src/scripts/reset-2fa.ts` `run` | Delete both, or rebuild on `resolveTarget` with a dry run, a confirmation and an audit row (Undecided) |
| Medium | 21 of the read-only agent role's 26 views are `SELECT *`, so `readonly_claude.property_entries` exposes `landlordPhone`. `readonly_claude.registrations.referenceNumber` is the filing's own number, minted separately from the citizen's login reference (`RegistrationService.submit`), so it is not a credential | `scripts/db/setup-claude-ro.sql` | Column allowlists per view |
| Medium | `reissue-references` prints `old,new,name,phone` for every citizen to stdout, and its comment expects the run to be redirected to a file: a list of live credentials with phone numbers | `apps/backend/src/scripts/reissue-references.ts` `reissueReferences` | Decide (Undecided below); meanwhile handle the output as a credential dump and delete it once citizens are notified |
| Low | Anonymous property-number lookup returns `registeredCount` and parcel coordinates, enumerable at the default rate | `RegistrationController.checkPropertyNumber` (`@Public()`); `RegistrationService.checkPropertyNumber` | Staff-only with `@Roles` (Undecided: its comment calls the cadastre a public register) |
| Low | Raw bodies and ids: `@Body('citizenId')` and `@Body('candidateIds')`, raw `@Body()` on two auth routes, and about 70 id params without `ParseUUIDPipe`. A bad id becomes a 500 and a Sentry event | `CitizenController` `confirmLandlordLink`, `dismissLandlordLink`, `restoreLandlordLink`; `AuthController` `disableTotp`, `sendResetPasswordEmail`; every controller but `CorrectionsController` | Zod body schemas; `ParseUUIDPipe` |
| Medium | A citizen save applies the owner agreements it carries (`landlordCitizenId` from «نعم، هو» on a card) through `LandlordLinkService.applyAgreements` → `confirm` with no role rule, while the answer routes admit only `LANDLORD_LINK_ANSWER_ROLES`. A collector (`REGISTER_WRITE_ROLES`) can so link an owner — and put flats and owner-borne fees on that file — by calling `POST`/`PATCH citizens` directly; the citizen editor keeps collectors out | `CitizensService` (agreements → `applyAgreements`); `CitizenController` create/update vs `confirmLandlordLink`, `dismissLandlordLink`, `restoreLandlordLink`, `unlinkLandlord`; `LandlordMatchHint` (no permission prop) | Apply agreements only for a role in `LANDLORD_LINK_ANSWER_ROLES` (refuse or ignore the rest), and give `LandlordMatchHint` a required `canAnswer` |
| Low | Raw query values on several reads: a repeated `?search=` arrives as an array and `normalizeSearchText` calls `.toLowerCase()` on it, a 500 and a Sentry event; `limit` and `offset` are coerced by hand. The collection worklists had the same bug and now go through `worklistQuerySchema` (2026-10-06) | `CitizenController.list`, `CitizenController.history`, `FeesController.listPayments` (`@Query('search')`, `@Query('limit')`, …), `AuditController` (`@Query('action')` into `parseActions`, which calls `.split`) | A zod query schema through `ZodValidationPipe`, as `worklistQuerySchema` |
| Low | `POST citizen/otp/verify` has no explicit `@Throttle` and falls under the 120-per-minute default | `AuthController.verifyOtp` | An explicit limit from `APP_CONFIG.throttle` |
| Low | Public routes with no explicit throttle decision ride the default | `HealthController`; `TenantController.getPublicConfig`; `RegistrationController.checkPropertyNumber`; `FeesController.whishCallback` | An explicit `@Throttle`, or `@SkipThrottle()` with a reason |
| Low | The cron bearer secret is compared with `!==` on `@SkipThrottle()` routes | `InternalCronController` `authorise` | Digest plus `timingSafeEqual`, as in `MetricsController` |
| Low | JWTs have no algorithm pin, issuer or audience | `ApplicationModule` `JwtModule.registerAsync`; `JwtAuthGuard` (`jwt.verify`) | Sign and verify options with `HS256`, issuer, audience |
| Low | `WHISH_API_URL`, `WHISH_API_KEY`, `WHISH_WEBHOOK_SECRET` are not validated at boot | `WhishGatewayService` constructor; absent from `envSchema` | Declare them with a pair rule |
| Low | CORS sends `credentials: true`, which bearer auth does not need, and `CORS_ORIGINS` accepts any string | `createApiApp` `enableCors`; `envSchema` `CORS_ORIGINS` | Drop `credentials`; validate each origin as an https URL in production |
| Low | The dormant document upload trusts the client-declared MIME type; no route calls it today | `DocumentService.attachToRegistration`; `Document.assertUploadable` | When revived: sniff content, cap size in the interceptor, tenant key prefix |
| Low | `.dockerignore` excludes `.env` files only at the repository root, so `apps/backend/.env` and `apps/frontend/.env.local` enter the build context and the build stage (`COPY . .`); the final stage copies build output only | `.dockerignore`; `apps/backend/Dockerfile`, `apps/frontend/Dockerfile` | Prefix the `.env` patterns with `**/`, and exclude the backup paths |

## Done well (keep these)

- Authentication is deny-by-default with an explicit `@Public()` opt-out, and the guards run throttle,
  then JWT, then roles (`PresentationModule`).
- The token's tenant is compared with the URL's on every request (`JwtAuthGuard`), proven by
  `tenant-isolation.spec.ts`.
- Sessions are revocable: `tokenVersion` is checked on every request with a 30 s cache
  (`SessionRevocationService.isCurrent`), deactivated users count as revoked, and refresh re-reads the role.
- Tenant isolation by connection (`TenantPrismaFactory`, `SAFE_SCHEMA_NAME`), with no tenant parameter
  to pass wrongly, and raw SQL that must be schema-qualified (`raw-sql-is-schema-qualified.spec.ts`).
- Staff login: constant work for unknown emails (`ABSENT_PASSWORD_HASH`), one shared error sentence,
  TOTP replay guard (`recordTotpStep`), reset tokens on a derived key and single-use through `tokenVersion`.
- OTP: CSPRNG codes, bcrypt-hashed, capped attempts and hourly volume (`APP_CONFIG.otp`), and OTP-off
  refused in production by `envSchema`.
- CSPRNG references (`ReferenceNumber.generate`), with `reissue-references` for the older corpus.
- The error filter never sends stack traces or Prisma text, and every response carries a correlation id.
- Sentry is allowlist-scrubbed (`scrubEvent`, `SAFE_HEADERS`, `redactUrl`), with no Replay and no
  tracing, and the portal reaches it through a tunnel instead of a CSP hole.
- `/metrics` is closed unless `METRICS_TOKEN` is set and compares in constant time; the Whish callback
  is an HMAC over the raw bytes, compared in constant time, and fails closed without a secret.
- S3: split buckets enforced by `envSchema`, 300 s presigned reads after a `HeadObject`, `IfNoneMatch`
  on writes, and a `document.viewed` audit event.
- CSV formula-injection guard (`csvCell`) in both apps, and the export is audited (`report.exported`).
- Who may reach every route is a test, not a convention: `route-inventory.spec.ts` discovers the
  controllers on disk and checks `@Roles`, the self-service list and the «مشاهد فقط» boundary.
- Portal: nonce CSP with `strict-dynamic`, an enumerated `connect-src`, `frame-ancestors 'none'`, HSTS,
  sessions in `sessionStorage` by default, and a service worker that never caches the API.
- Environment safety: `scripts/db/targets.mjs` pins database and role per target, the seed refuses
  non-local databases, and `migrate-database.yml` uses environment-scoped secrets, pinned host keys, a
  backup before migrating, and shredded credentials.
- Append-only triggers on `audit_log_entries` and the payment ledger; non-root `USER` in both
  Dockerfiles; `pnpm.overrides` for transitive CVEs and a CI `audit` job.

## Undecided

These need a human. Long-running product decisions live in [docs/open-decisions.md](open-decisions.md).

- **Reference-only citizen login.** Keep `POST citizen/reference/open` as a single factor that exposes
  resident status, or reduce what such a session can read, add a failure budget, or add CAPTCHA?
- **SUPER_ADMIN TOTP.** Mandatory with an enrolment-only session, or officially optional (and fix the
  comments that say otherwise, such as the `User.requiresTotp` docblock)?
- **Rate-limit topology.** The `trust proxy` hop, a Redis throttler store, and per-account limits.
- **Offline PII on field devices.** Encrypt the queue and drafts, clear them on sign-out or user switch,
  or accept the risk because field work must not be lost?
- **Credentials in exports.** Should `exportCsv` carry `reference_number`? Should `reissue-references`
  print credentials to stdout?
- **«مشاهد فقط» and identity documents.** The head's account reads citizens and their data (decision of
  2026-10-05) but is not given the scanned identity documents, which `PR #88` already withheld. Whether
  "their data" includes the scans is for the product owner
  ([docs/open-decisions.md](open-decisions.md)).
- **Credentials at rest.** Hash-index `users.referenceNumber` (receipts need the plaintext)? Encrypt `totpSecret`?
- **Database privileges.** Split the runtime role from the migration role; per-tenant roles?
- **Production data in CI.** The pre-migration restore rehearsal loads a plaintext production dump into
  a GitHub-hosted runner. Acceptable, or rehearse on the box?
- **New SUPER_ADMIN secrets.** A SUPER_ADMIN who creates another receives that admin's TOTP secret.
  Should the new admin self-enrol instead?
- **The retired Supabase production project** still holds a full copy of the register
  (`LEGACY_SUPABASE_REFS` comment in `scripts/db/targets.mjs`). When is it deleted?
- **Deploy gating.** Require CI and the audit job before a production deploy, and an approval on the
  deploy job and not only the migration?
- **Dangerous tools.** Delete `dump-tenant.js` and `reset-2fa.ts`, or rebuild them behind the target guard?

## Unverified

- The nginx config and its `X-Forwarded-For` handling; pm2's instance count and cluster mode.
- `NODE_ENV`, `REDIS_URL`, SMTP and `CORS_ORIGINS` values on the production and staging hosts, and
  whether a staging API process exists.
- Whether `reissue-references` was run on production (the pre-CSPRNG corpus is predictable).
- Whether the retired Supabase projects are deleted, and whether the backup IAM user's write-only
  policy is applied.
- S3 Block Public Access on the documents bucket; the Mapbox token's URL restrictions; TLS and HSTS
  settings at nginx.
