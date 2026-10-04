# Deploying to Vercel

Last verified against the code: `feat/shorter-staff-sessions` (on `develop@9ec12ec`), 2026-10-04.

> **This doc now covers the frontend (the portal) only.** The API runs on AWS
> Lightsail under pm2, deployed by `.github/workflows/deploy-backend.yml` on
> every push to `main` ([database-environments.md](database-environments.md#3-the-normal-path)).
> No workflow deploys the backend to Vercel. Sections that describe the API on
> Vercel are marked **Retired** and kept for history; do not follow them. The
> backend's Vercel files (`apps/backend/vercel.json`, `apps/backend/api/index.js`,
> `presentation/serverless.ts`) are still tracked. **Undecided:** whether to
> delete them.
>
> The Vercel projects are configured outside this repository. Project names
> below are as last recorded (**Unverified**).

| Project | Root Directory | Serves |
| --- | --- | --- |
| `mechanization-web` | `apps/frontend` | The portal and the admin UI |
| `mechanization-api` (**Retired**) | `apps/backend` | was `/api/v1/**`; now served from Lightsail |

The portal reads `apps/frontend/vercel.json`, so install and build commands are
already set — do not override them in the dashboard.

**Scope every variable to one environment.** A variable that names an API, a
database, a bucket or a signing secret is set separately for Production and
for Preview, never once for both. Rule:
[security.md](security.md#configuration-this-repository-cannot-see); incident:
[incidents.md](incidents.md), entry 5.

---

## 1. Create the API project (Retired)

**Retired.** The API is not deployed to Vercel any more. This section records
how it was. Its env table scoped every variable to Production and Preview
together, which was the cause of incident 5. On Lightsail the
API reads its variables from the server's `.env`; the variable names are
validated in `apps/backend/src/presentation/config/env.schema.ts`.

1. **Add New → Project**, import the repository (now
   https://github.com/mechnanization/mechanization).
2. **Root Directory**: `apps/backend`. Tick **Include source files outside of
   the Root Directory** — the backend depends on `@mechanization/shared-schemas`
   through the workspace, and without this the install has nothing to link.
3. Leave Framework Preset as **Other**. `vercel.json` supplies the rest.
4. Add the environment variables below, then deploy.

### API environment variables

These were set for **Production** and **Preview** together. Never do that
again: see the scoping rule at the top.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase **pooled** URL, port `6543`, with `?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | Supabase **direct** URL, port `5432` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. Never in the web project. |
| `SUPABASE_STORAGE_BUCKET` | `documents` |
| `JWT_SECRET` | ≥32 chars. `openssl rand -base64 48`. Also keys the staff refresh tokens, so rotating it ends every session — see §8 |
| `JWT_STAFF_TTL` | `8h` (the default) — the **session** cap, stamped at sign-in, not any token's life. See §8 |
| `JWT_STAFF_REMEMBER_TTL` | `7d` (the default; it shipped at `30d`) — same, for "تذكّرني". A host that still sets `30d` keeps 30 days |
| `JWT_STAFF_IDLE_TTL` | Optional, `15m`. How long one access token is accepted before the portal refreshes it — and so how long a stolen one is useful. See §8 |
| `JWT_CITIZEN_TTL` | `7d` — unchanged, citizens have no refresh |
| `OTP_ENABLED` | `true` — production refuses to boot without it |
| `SMS_PROVIDER_API_KEY` | Optional and currently inert — no provider is implemented |
| `SMS_PROVIDER_FALLBACK_API_KEY` | Same (see `open-decisions.md` #2) |
| `CORS_ORIGINS` | The web project's origin, e.g. `https://mechanization-web.vercel.app`. Also the list staff sign-in, refresh and sign-out check `Origin` against — see §8 |
| `PUBLIC_API_URL` | This project's origin + `/api/v1` |
| `PUBLIC_PORTAL_URL` | The web project's origin |
| `CRON_SECRET` | `openssl rand -hex 32` — see §4 |
| `SCHEDULER_ENABLED` | Leave **unset** on Vercel. On any long-lived host, set it explicitly — see §4 |
| `METRICS_TOKEN` | Leave **unset** on Vercel: `/metrics` then answers 404. Only a long-lived host that Prometheus scrapes sets it (`openssl rand -hex 32`); the scraper sends `Authorization: Bearer <token>` |
| `TZ` | `UTC` on a long-lived host. Not needed on Vercel, which is UTC already |
| `SENTRY_DSN` | Optional. The **API** project's DSN — see §7 |
| `SENTRY_ENVIRONMENT` | `production` or `preview`, scoped per environment — see §7 |

`connection_limit=1` is not a typo. Every warm instance holds its own pool, and
the tenant factory opens a further client per municipality it has served; the
pooler's connection budget is the first thing this deployment will run out of.

Leave `REDIS_URL` **unset** unless you have a serverless-friendly Redis
(Upstash over `rediss://`). The cache falls back to an in-process map, which on
serverless means a per-instance cache with a short life — correct, just less
effective. A plain `redis://` pointing at a container will simply fail to
connect on every cold start.

---

## 2. Create the web project

1. **Add New → Project**, import the same repository.
2. **Root Directory**: `apps/frontend`, again with **Include source files
   outside of the Root Directory** ticked.
3. Framework Preset: **Next.js**.

### Web environment variables

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | The API's origin + `/api/v1`. Scoped per environment: a preview must never call the production API |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | A Mapbox public token (`pk.…`), URL-restricted. There is no checked-in fallback, so without it the maps get no token |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional. The **web** project's DSN — a different one from the API's. See §7 |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | Optional override; `NEXT_PUBLIC_VERCEL_ENV` is used when unset (`lib/sentry-options.ts`) |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Build-time only, for source-map upload |
| `SENTRY_AUTH_TOKEN` | Build-time only. Without it the build still succeeds, just without source maps |

The `NEXT_PUBLIC_*` ones are inlined into the browser bundle at build time.
Changing any of them needs a redeploy, not a restart. None may ever hold a
secret — which includes `SENTRY_AUTH_TOKEN`, so note that it is deliberately
*not* prefixed and stays server-side.

**Origins must match.** `NEXT_PUBLIC_API_URL` names the API's origin, and the
API's `CORS_ORIGINS` (in the server's `.env` on Lightsail) must contain the
portal's origin exactly. Changing `NEXT_PUBLIC_API_URL` needs a portal
redeploy; changing `CORS_ORIGINS` needs a pm2 reload of the API.

---

## 3. How the backend runs as a function (Retired)

**Retired.** Nothing deploys the backend this way now. Kept for history and
for whoever decides whether to delete these files.

`apps/backend/api/index.js` is the entry point Vercel invoked. It requires the
compiled `presentation/serverless.ts` from `dist`, which boots the Nest app
once per warm instance and hands back the Express instance the platform then
calls.

Two details that are easy to undo by accident:

- **`api/index.js` is JavaScript, and thin, on purpose.** Vercel compiles files
  under `api/` with esbuild, which strips types without emitting the decorator
  metadata Nest's injector reads at runtime. Pointing that file at TypeScript
  sources produces an app whose every constructor argument is `undefined`. The
  real build is `nest build` (tsc, `emitDecoratorMetadata`); the entry file only
  requires its output, via a static path the dependency tracer can follow.
- **`binaryTargets` includes `rhel-openssl-3.0.x`** in both Prisma schemas. The
  query engine is a platform-specific binary; without the deployment target the
  build succeeds and the first query fails.

The rewrite in `vercel.json` sends everything the filesystem does not answer to
that one function. The app keeps its own `api/v1` global prefix, so the live
routes are unchanged from local: `https://<api>/api/v1/health`.

---

## 4. Scheduled jobs

This section is about the API, wherever it runs. On Lightsail the API is a
long-lived process, so the "one long-lived process" row below applies, and the
Vercel cron schedule is **Retired**. Every process that boots with
`SCHEDULER_ENABLED` unset registers the jobs, including the deploy's port-4001
candidate ([gotchas.md](gotchas.md#every-process-owns-the-schedule-unless-told-otherwise)).

`ScheduleModule` is registered only when `isSchedulerEnabled()` says so
(`app.module.ts` → `presentation/config/env.schema.ts`). On Vercel it must not
be: the instance holding the timer is torn down moments after the response, so a
registered `@Cron` would never fire while looking perfectly healthy in the logs.

**`SCHEDULER_ENABLED` decides it.** Unset falls back to the rule this repository
used before the flag existed — run the schedule unless `VERCEL` is set — so a
Vercel deployment needs nothing, and no existing deployment changes behaviour by
upgrading. Set it explicitly anywhere `VERCEL` is *not* the thing that makes the
answer true:

| Where | Value | Why |
| --- | --- | --- |
| Vercel | unset (or `false`) | The platform sets `VERCEL`; timers cannot fire there anyway. `crons` below is the schedule. |
| One long-lived process (container, VM) | `true` | It owns the schedule. Say so rather than relying on the absence of a variable. |
| Every further replica | `false` | Two processes with in-process timers are two schedulers. See `open-decisions.md` §5. |
| `pnpm dev` | `false` is recommended | `apps/backend/.env` points at the developer's own local database, and a 02:00 billing run changes the data under whatever is being tested. The local `.env` in `database-environments.md` §0.1 sets it. |

An unrecognised value fails the boot. It is not defaulted in either direction:
guessing `true` gives you a scheduler nobody asked for, guessing `false` stops
billing, and neither is visible until someone goes looking.

**`TZ` is pinned to `UTC`** in `apps/backend/Dockerfile` and `docker-compose.yml`.
Every job also names `timeZone: 'UTC'` on its `@Cron` decorator, so the
schedule is right whatever the host clock says — that pin is what keeps *logged*
timestamps comparable between deployments, and `main.ts` warns at boot if `TZ`
is set to anything else. The reason the decorators name a zone at all:
`periodKeyFor` builds every billing period key from `getUTCFullYear` /
`getUTCMonth`, so a job firing at 02:00 Beirut on the 1st runs at 23:00 UTC on
the last day of the previous month and computes the **previous** period's key.
Daily repetition hid that as "a day late", never as an error.

The two jobs are also reachable over HTTP, through `InternalCronController`.
**Retired:** `apps/backend/vercel.json` scheduled them on Vercel, as below. The
file is still tracked, and it schedules the OTP prune daily (`0 1 * * *`), not
hourly as this table said:

| Job | Route | Schedule |
| --- | --- | --- |
| OTP challenge prune | `GET /api/v1/internal/cron/otp-cleanup` | hourly |
| Recurring billing | `GET /api/v1/internal/cron/recurring-billing` | daily, 02:00 UTC |

A third job, the staff refresh-token prune, has a route of its own —
`GET /api/v1/internal/cron/staff-refresh-cleanup`, daily at 03:00 UTC in-process
— and deliberately **no** `vercel.json` entry. The route exists for parity with
these two; see §8.

Vercel sends `Authorization: Bearer $CRON_SECRET` on every invocation. **The
routes refuse to run at all when `CRON_SECRET` is unset** — a missing variable
closes the door rather than opening it, because these walk every municipality
and issue invoices.

Two caveats:

- **Hobby plans** allow two cron jobs and run each once a day regardless of the
  expression. The OTP prune becoming daily is tolerable (challenges expire in
  five minutes and are checked on use); billing is daily by design.
- **02:00 UTC is 05:00 in Beirut** in summer. Vercel cron expressions are UTC.

Docker and `pnpm dev` keep the in-process schedule by default, and the endpoints
are simply an extra way in. Note what that default means in practice: it is the
*absence* of `VERCEL`, so it is true on every host that is not Vercel —
including a developer's laptop pointed at staging. That is what
`SCHEDULER_ENABLED` is for.

---

## 5. Known limitations of this deployment (Retired)

**Retired.** These were the limits of the API on Vercel. Two still hold on
Lightsail: rate limiting is per process (3), and migrations are a separate step
(5), though no longer a manual one: **every push to `main` migrates staging and
then production automatically**, before the code ships, and the manual
*Deploy production* workflow is only for dry runs and contract steps
([database-environments.md](database-environments.md#3-the-normal-path)). The
"reviewer's approval" in item 5 does not exist. Item 1 no longer applies
anywhere: the import now uploads its layers through `CadastreStorage`
(`S3CadastreStorageService`), not to the frontend's `public/`.

1. **Cadastre import will fail.** `POST /t/:slug/cadastre/import` writes the
   generated map layers to `apps/frontend/public/tenants/<slug>/`. Vercel's
   filesystem is read-only, so the write throws. Run it locally instead —
   `pnpm --filter @mechanization/backend cadastre:import --slug <slug> --file <path.kmz>`
   — and commit the resulting files; the frontend serves them statically anyway.
   Moving those assets to Supabase Storage is the fix that removes the caveat.
2. **Uploads are capped at ~4.5 MB** by the platform's request-body limit,
   below `APP_CONFIG.cadastre.maxFileSizeBytes` (15 MB). Document uploads are
   well under it; a cadastre KMZ may not be. See (1).
3. **Rate limiting is per instance.** `ThrottlerModule` stores counters in
   memory, so the effective limit is roughly `configured × concurrent
   instances` — the staff-login and OTP limits are the ones that matter. A
   shared store (Redis) is the fix; until then, treat the numbers in
   `APP_CONFIG.throttle` as a floor, not a ceiling.
4. **Cold starts are slow.** A cold instance boots the whole Nest graph and
   connects the registry Prisma client before it answers anything — expect a
   couple of seconds on the first request after idle.
5. **Migrations are not run by the Vercel deploy.** They are a separate,
   deliberate step — but no longer a manual pair of commands against whatever
   `.env` happens to say. Staging migrates itself on every push to `develop`;
   production is a manual GitHub Actions run behind a reviewer's approval:

   ```bash
   pnpm db:status:staging        # what is pending, applies nothing
   pnpm db:deploy:staging        # or let the develop push do it
   pnpm db:status:production     # dry run against production
   ```

   The full workflow, the checks that stop a deploy reaching the wrong project,
   and the expand/contract rules for schema changes that cannot lose data are in
   [database-environments.md](database-environments.md).

---

## 5a. If Vercel stops deploying entirely

Symptom: pushes land on GitHub, CI runs, and Vercel produces **no deployment at
all** — not a failed one, not a queued one. Nothing. The dashboard looks healthy
because the last successful deploy is still serving.

This happened on 2026-09-05, after the repository was transferred from the
personal account abed0srour to the mechnanization organization. Three pushes
and a merge to `main` produced zero deployments over four hours. It applies to
the portal project today; at the time it was observed on the API project.

What it is **not**: a broken project link. Check it before assuming —

```bash
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  https://api.vercel.com/v9/projects/<project> | jq .link
```

The org and repo strings there go stale after a transfer and are cosmetic.
The field that matters is the link's "repoId", and GitHub keeps the numeric id
across a transfer or rename — so "repoId" still matching
`gh api repos/:owner/:repo --jq .id` means Vercel is watching the right
repository and the link is fine.

What it actually is: the **Vercel GitHub App installation does not follow the
repository**. It was installed on the personal account; the new organization has
no installation, so no webhook fires and Vercel is never told a push happened.
The link's "repoOwnerId" still pointing at the old owner is the tell.

The fix has two halves, and **the first one alone does nothing** — this was
measured, not assumed:

1. Install the Vercel app on the new organization and grant it the repository
   (`github.com/organizations/<org>/settings/installations`).
2. In Vercel, **Settings → Git → Disconnect, then Connect** to the new path.

With (1) done and (2) skipped, a push to a fresh branch produced two GitHub
check-runs and zero Vercel deployments — no failed build, no GitHub deployment
record, nothing. Vercel matches an incoming event against the owner recorded on
the project, and until step (2) rewrites "repoOwnerId" the event belongs to an
owner it does not recognise.

Step (2) is easy to believe you have done, because Vercel's UI shows the project
as connected throughout. The only reliable confirmation is the link's
"updatedAt" moving and "repoOwnerId" changing to the organisation's id — re-run
the `curl` above and compare.

Two things worth knowing while it is broken: `git push` keeps working through
GitHub's redirect, so nothing warns you, and `git remote set-url origin` to the
new path is worth doing regardless to stop the redirect notice on every push.

---

## 6. After the first deploy

The API checks below run against the Lightsail API, wherever the portal is
deployed.

```bash
curl https://<api>/api/v1/health          # {"status":"ok",...}
curl https://<api>/api/v1/health/ready    # {"status":"ready"} — proves the DB is reachable
```

`degraded` on the second means `DATABASE_URL` is wrong or the pooler is
refusing connections; the build succeeding tells you nothing about either.

Then open the web project and sign in. If the browser console shows a CORS
failure, `CORS_ORIGINS` on the API does not contain the web origin exactly
(scheme included, no trailing slash).

---

## 7. Error monitoring (Sentry)

Two Sentry projects, one per deployment, because the two fail for different
reasons and a merged stream makes neither legible:

| Deployment | DSN variable | Covers |
| --- | --- | --- |
| The API (Lightsail; was `mechanization-api`) | `SENTRY_DSN`, in the server's `.env` | 5xx from `DomainExceptionFilter`, and boot failures |
| The portal (`mechanization-web`) | `NEXT_PUBLIC_SENTRY_DSN` | Browser errors, SSR and middleware failures |

The API tags events with `VERCEL_GIT_COMMIT_SHA` as the release
(`presentation/config/sentry.ts`). That variable is not set on Lightsail, so
API events carry no release.

### It is optional, on purpose

An unset DSN disables the SDK and changes nothing else. There is deliberately
**no** production guard demanding one: incident 7 in
[incidents.md](incidents.md) is about an env check whose only possible effect
was a boot failure, and a municipality's
API refusing to start because an observability vendor's DSN is absent would make
the register less available in exchange for nothing.

What replaces the guard is a boot log line — the API prints either
`Sentry error reporting enabled` or `Sentry disabled (no SENTRY_DSN)` on every
start. Read it after deploying rather than assuming.

### Scope each DSN to one environment

Set `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (web) per Vercel environment, not once
for both, and `SENTRY_ENVIRONMENT` (API) in each API host's `.env`. Preview and
production both run with `NODE_ENV=production`, so without this every
pull-request preview reports into the production issue stream — incident 5 in
[incidents.md](incidents.md), in a different system. The web project falls
back to `NEXT_PUBLIC_VERCEL_ENV`, which is already per-environment; the API has
no such fallback and needs the variable set explicitly.

### What is deliberately not sent

Sentry is a third party, and the tenant schemas hold national ID numbers, home
addresses and residency status.
[database.md](database.md#moving-data-between-environments) forbids citizen
data leaving staging; sending it to a SaaS index would be the same failure with
extra steps.
So both SDKs are configured to drop, before anything leaves:

- request bodies, cookies, query strings and all headers outside a small allowlist
- the `user` object, and the client IP (`sendDefaultPii: false`)
- `console`, `http`/`fetch` and `ui.click` breadcrumbs — the click ones record
  the text of the element clicked, which on a citizens table is a person's name
- **Session Replay**, which is not enabled and should not be without a separate
  decision: it records the DOM, and the DOM here is the register

Everything that does go out is passed through a redaction pass that strips
UUIDs, رقم مرجعي values (which are login credentials), runs of six or more
digits, JWTs, email addresses and the `Key (col)=(value)` detail Postgres
appends to a unique violation. The rules live in `sentry-redaction.ts` in each
app and are covered by `sentry-redaction.spec.ts` on the API side.

What is kept is the municipality slug, the route shape and the correlation id —
enough to triage, and enough to match a citizen quoting an error reference at a
counter to the report, without naming them anywhere.

### Source maps

`SENTRY_ORG`, `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN` are build-time only, on
the web project. Without them the build still succeeds and simply ships without
maps — a missing observability token must never fail a deploy. `hideSourceMaps`
keeps the maps out of the public build output, so they are readable to Sentry
and not to anyone opening devtools against the portal.

### The tunnel route

Browser events are POSTed to `/monitoring` on the portal's own origin and
forwarded from there, rather than straight to `*.ingest.sentry.io`. This is not
an ad-blocker workaround (though it is also that): `middleware.ts` builds a
strict `connect-src` that enumerates every origin the portal may talk to,
precisely so an injected script has nowhere to send what it reads. Adding a
third-party collector to that list would be the exfiltration channel the policy
exists to deny. The tunnel keeps `connect-src 'self'` intact.

`middleware.ts` exempts `/monitoring` from tenant/locale routing. Without that
exemption it is read as a municipality slug and redirected to `/monitoring/en`,
and every error report is silently lost — an error reporter that is installed,
configured, and reports nothing.

---

## 8. Staff sessions: access token and refresh cookie

This section describes the API's session behaviour, whatever hosts it.

A staff sign-in used to produce one token with one lifetime — 8h, or 30d with
"تذكّرني" — and when it ran out the next request came back 401. A clerk halfway
through a citizen form at hour eight lost the form. There was no refresh token,
so expiry was a hard stop wherever it landed.

It is now **two bounds instead of one**:

| Bound | Variable | Default | What it is |
| --- | --- | --- | --- |
| Access-token life | `JWT_STAFF_IDLE_TTL` | `15m` | How long one access token is accepted before the portal refreshes it |
| Session cap | `JWT_STAFF_TTL` / `JWT_STAFF_REMEMBER_TTL` | `8h` / `7d` | When the clerk signs in again. Stamped at sign-in, never moves |

`JWT_STAFF_TTL` keeps the value and the meaning an operator already had for it —
how long a sign-in lasts. What changed is which expiry it names: it used to be
the token's, and is now the session's. Nobody has to change a variable.

The portal refreshes whenever a request meets an expired access token
(`POST /t/:slug/auth/staff/refresh`), replays the request, and the screen never
sees the 401. Past the cap there is no refresh at any price, so a session still
ends at exactly the wall-clock moment it did before.

The first version of this needed no migration: it refreshed by exchanging the
expired access token itself. That kept the form and bought no security — the
exchange had to accept an *expired* token, so anyone holding one could exchange
it too, and a stolen token was good for the whole session cap. What replaced it
is the second credential that version said it was a prerequisite for: stored
server-side, accepted only by the refresh route, rotated on every use, with
reuse detection. Migration `0059_staff_refresh_tokens` is its table.

### Two credentials, and a refresh needs both

| | Access token | Refresh token |
| --- | --- | --- |
| Held in | the tab's `sessionStorage` (`localStorage` with "تذكّرني") | an `HttpOnly` cookie the page cannot read |
| What it is | a signed JWT, ≤ `JWT_STAFF_IDLE_TTL`, carrying `sid` | 256 random bits, opaque |
| Kept server-side | no | only as an HMAC in the tenant table `staff_refresh_tokens` — never the token |
| Accepted by | every authenticated route | the refresh route only |

A refresh needs **both**. The cookie is the renewal credential. The tab's own
access token, sent as `Authorization: Bearer`, is the *binding*: its signature
is checked but not its expiry — expired is its normal state here — and it must
be a STAFF token for this municipality whose `sub` owns the refresh token. It is
never enough on its own and nothing is ever minted from it. All it says is which
account this tab belongs to, so the right cookie is read and a tab can never be
handed another account's session. A missing or invalid binding is a 401 with
nothing written and no cookie cleared.

That is also what keeps the promise `sessionStorage` made: closing the tab still
ends a session that was not "تذكّرني". The access token went with the tab, and
the cookie — a browser-session cookie in that case — is useless without it.

The route is `@Public()` for the reason it always was: `JwtAuthGuard` rejects
expired tokens, and an expired token is the expected binding. The checks live
in `IdentityService.refreshStaffSession` instead.

### The cookie

- **One name per account**: `mz_sr_` and 24 hex characters of an HMAC of the
  user id. Two staff accounts in one browser never share a cookie; an outsider
  cannot compute another account's name, which defeats planting one for them
  (cookie tossing); and a late sign-out response for one account can never
  clear another's. "تذكّرني" *storage* is still one slot per municipality, so
  in a shared browser the last sign-in wins there, as before.
- **Attributes**: `HttpOnly; Secure; SameSite=Strict`, and deliberately no
  `Path` and no `Domain`. The browser's default path is then
  `/api/v1/t/<slug>/auth/staff` — one municipality's staff auth routes — and
  the cookie is host-only on the API. The other `/auth/staff/*` routes do
  receive it; none reads it, and that should stay true.
- **Lifetime**: with "تذكّرني", `Max-Age` and `Expires` run to the session cap.
  Without it, neither is set and the cookie ends with the browser.
- **Portal and API must be same-site.** The API sets the cookie on its own
  responses and the portal's `fetch` sends it back with
  `credentials: 'include'` (CORS already allows credentials for the origins in
  `CORS_ORIGINS`). `SameSite=Strict` means a browser sends it only when the two
  share a registrable domain. `https://baladyia.com` → `https://api.baladyia.com`
  does, and so does `http://localhost:3000` → `http://localhost:4000`. Two
  hosts under a shared hosting suffix do not — two `*.vercel.app` projects are
  different sites — and there the portal would sign in and then fail its first
  refresh.
- **Safari caps "تذكّرني" at 7 days.** WebKit caps a cookie set by a server
  response at seven days when that server's IP address does not match the
  site's own — likely whenever the portal and the API are served from different
  machines. Since the default became `7d` that matches the session cap, so it
  only matters if a host raises `JWT_STAFF_REMEMBER_TTL` above a week.
  Nothing on the server changes that; it is worth knowing when someone reports
  it.
- **Rotating `JWT_SECRET` ends every staff session**, refresh included. The key
  the stored hashes are made with, and the cookie names, are both derived from
  it, so after a rotation no stored hash matches and no cookie has the name the
  API looks for.

### Rotation, and the rule that detects reuse

Every refresh exchanges the presented token for a new one and marks the old one
used. The tokens one sign-in produces form a *family*, and every row of it
carries the same session cap.

A used token may be exchanged again, because a response lost on a flaky
connection must not sign a clerk out — but only under the rule written on
`StaffRefreshTokenService`:

> A token can be exchanged again only while nothing it produced has been used,
> at most three times. Presenting a token after the chain has moved past it
> ends the family.

So a retry after a lost response, or two tabs racing, gets a fresh token and
supersedes the unused one it replaces; that is logged as a warning, not audited.
A token presented after its successor has been used is treated as theft: the
whole family is revoked, the cookie cleared, and one
`STAFF_SESSION_REUSE_DETECTED` row is written to the audit log. Whoever was
using that session, thief or clerk, signs in again.

The residual gap, stated rather than implied away: someone who presents a stolen
refresh token *before* its owner does gets one access-token lifetime
(≤ `JWT_STAFF_IDLE_TTL`) plus at most three retries before the family is
revoked. They also need a signed access token for the same account as the
binding.

The portal keeps benign races away from that budget. It holds a lock per
municipality (`navigator.locks`, where the browser has it) around sign-in,
refresh and sign-out, and before refreshing it checks storage: a request whose
token has already been replaced — by a concurrent request in the same tab, or by
another tab sharing "تذكّرني" storage — adopts the newer one instead of spending
the cookie again, but only if it belongs to the same account. A
refresh that fails for a connection reason (network, timeout, 429, 5xx) keeps
the stored session and surfaces as a connection problem; only a 401 or 403 ends
it.

### `sid`: ending the access token too

Staff access tokens carry `sid`, the family id. After the `tokenVersion` check,
`JwtAuthGuard` refuses a token whose family has ended — root row missing,
revoked, or past its cap. The answer is cached in `SessionRevocationService` for
the same 30 seconds `tokenVersion` is, so a sign-out or a reuse detection ends
outstanding access tokens within half a minute rather than at their own expiry.

The root row is the authority. A rotation racing a revocation can insert a child
the revocation never saw; that child is dead anyway, because its root is.

Access tokens minted before this release carry no `sid` and skip the check.
They end at their own `exp`, at most `JWT_STAFF_IDLE_TTL` after they were
issued.

### Signing out

`POST /t/:slug/auth/staff/logout` ends the session on the server. It needs the
tab's access token as the binding, and ends the family the cookie names if that
belongs to the same account — otherwise the one in the token's `sid`, so signing
out still works when the cookie is missing. It clears the cookie when the
request carried one, writes `STAFF_LOGOUT` when it actually revoked something,
and never fails for bad input: without a valid binding it does nothing and still
answers `{ signedOut: true }`.

The portal clears its own storage whatever that call returns, failure included.
A sign-out button that can leave someone signed in on a shared municipal PC is
the worse of the two bugs.

### What is still enforced on every refresh

Signature, tenant and session cap, plus:

- **Revocation.** `tokenVersion` — bumped by a role or password change,
  deactivation and a password reset — is compared with the version the family
  was issued under, and a mismatch revokes the family. `isActive` is re-read: a
  deactivated account gets a 403 and its family is revoked too. Either way a
  dismissal still takes effect within the revocation cache window, and a
  revoked session cannot refresh its way back.
- **Role.** Re-read from the row rather than copied from the token, so a
  promotion or demotion reaches the session at the next refresh instead of the
  next sign-in. `RolesGuard` authorises from this claim, so a stale one is an
  authorisation decision made on old information.
- **Owner.** A refresh token whose owner is not the binding's `sub` is refused
  with nothing written.

### Where the origin is checked

`TrustedOriginGuard` sits on sign-in, refresh and sign-out. A request whose
`Origin` header is present and not in `CORS_ORIGINS` is refused with 403 before
anything reads, sets or clears a cookie; a request with no `Origin` at all (curl,
a script) passes. CORS alone does not cover this: a cross-site form POST goes
out without a preflight, and CORS only stops the sending page from reading the
answer. The guard is what stops another site signing a clerk into an attacker's
account (login CSRF), and a second lock on refresh and sign-out, which already
need an `Authorization` header a form cannot send. It reads the same `CORS_ORIGINS` the
bootstrap does, so there is nothing new to configure — but the list must name
the portal's origin exactly.

### Throttling

Sign-in keeps `staffLogin`, 5 a minute. Refresh and sign-out use
`APP_CONFIG.throttle.staffSession`, 30 a minute, counted per `Authorization`
header (hashed) and per client address only when there is none. Per header,
because behind nginx every request currently reaches the throttler from
nginx's own address, and one anonymous flood must not use up every clerk's
refresh budget. A refresh token is 256 bits: this limit is load control, not a
defence against guessing. Like every limit here it is per process (§5.3).

### Pruning, backups and deleted accounts

`StaffRefreshTokenCleanupJob` deletes rows past their session cap in every
municipality, daily at 03:00 UTC, wherever the in-process scheduler runs (§4 —
`SCHEDULER_ENABLED`). `GET /api/v1/internal/cron/staff-refresh-cleanup` runs the
same prune behind `CRON_SECRET`, for parity with the other two jobs. It is not in
`vercel.json`: Vercel is retired, and a Hobby plan's two cron jobs were taken
anyway. If the prune never ran, nothing would be wrong but the table's size —
an expired row is refused on sight.

`staff_refresh_tokens.userId` is `ON DELETE CASCADE` from `users`. Deleting a
staff account takes its rows with it. The table is deliberately not in a
`BackupService` snapshot: a restore deletes and rewrites every user, the rows
cascade away, and everyone signs in again — the right outcome after a register
has been rolled back, and it never brings back a session that was signed out
since.

### Deploying it

There is a migration this time, and the order matters.

1. **The portal first.** It is a frontend-only change and safe against the API
   already running: the old `/refresh` still accepts the Bearer exchange, the
   new `/logout` call 404s and is ignored, and `credentials: 'include'` is
   harmless. Which host serves `https://baladyia.com`, and what triggers its
   build, is **not recorded in this repository** — no workflow here builds the
   portal. Ask; do not guess.
2. **Wait a working day**, so tabs opened on the old portal have reloaded.
3. **The API and `0059` together, merged to `main` after hours.**
   `deploy-backend.yml` runs its usual order: migrate staging, back up
   production (0059 is pending, so the backup is taken), migrate production,
   then build and cut over. `0059` is additive — one table, one foreign key to
   `users`, indexes; no enum, trigger or function — so the release before it
   runs untroubled against the migrated schema until the cut-over.

   After hours, for two reasons. The foreign key briefly takes a
   `SHARE ROW EXCLUSIVE` lock on `users` under the migrator's 5-second
   `lock_timeout`, and a busy moment can time a municipality out; the run then
   fails before the cut-over, and re-running it is safe because the migration is
   idempotent throughout. And every staff member signs in once: a session minted
   before the release has no cookie, so it ends when its current access token
   does (≤ 15 minutes) and the next refresh asks for a sign-in. Staff sign-in is
   throttled to 5 a minute per worker, and behind nginx every clerk shares one
   address, so a working morning of sign-ins at once would queue.

**Rollback**: the previous API with the new portal is exactly the combination
step 1 already ran. The table stays behind, unread.

Citizens are unaffected throughout: their tokens have no refresh and nothing
here touches them.
