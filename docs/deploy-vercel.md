# Deploying to Vercel

Two projects, one repository. The frontend is a stock Next.js deployment; the
backend is the NestJS app running as a single serverless function.

| Project | Root Directory | Serves |
| --- | --- | --- |
| `mechanization-web` | `apps/frontend` | The portal and the admin UI |
| `mechanization-api` | `apps/backend` | `/api/v1/**` |

Both read a `vercel.json` in their own root directory, so install and build
commands are already set — do not override them in the dashboard.

---

## 1. Create the API project

1. **Add New → Project**, import `abed0srour/mechanization`.
2. **Root Directory**: `apps/backend`. Tick **Include source files outside of
   the Root Directory** — the backend depends on `@mechanization/shared-schemas`
   through the workspace, and without this the install has nothing to link.
3. Leave Framework Preset as **Other**. `vercel.json` supplies the rest.
4. Add the environment variables below, then deploy.

### API environment variables

Set all of these for **Production** and **Preview**.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase **pooled** URL, port `6543`, with `?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | Supabase **direct** URL, port `5432` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. Never in the web project. |
| `SUPABASE_STORAGE_BUCKET` | `documents` |
| `JWT_SECRET` | ≥32 chars. `openssl rand -base64 48` |
| `JWT_STAFF_TTL` | `12h` — now the **session** cap, not the token's. See §8 |
| `JWT_STAFF_REMEMBER_TTL` | `30d` — same, for "تذكّرني" |
| `JWT_STAFF_IDLE_TTL` | Optional, `30m`. How long one token lasts before it is exchanged |
| `JWT_CITIZEN_TTL` | `7d` — unchanged, citizens have no exchange |
| `OTP_ENABLED` | `true` — production refuses to boot without it |
| `SMS_PROVIDER_API_KEY` | Optional and currently inert — no provider is implemented |
| `SMS_PROVIDER_FALLBACK_API_KEY` | Same (see `open-decisions.md` #2) |
| `CORS_ORIGINS` | The web project's origin, e.g. `https://mechanization-web.vercel.app` |
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
| `NEXT_PUBLIC_API_URL` | The API project's origin + `/api/v1` |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | Your own token — the checked-in fallback is a personal one |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional. The **web** project's DSN — a different one from the API's. See §7 |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | Optional override; `VERCEL_ENV` is used when unset |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Build-time only, for source-map upload |
| `SENTRY_AUTH_TOKEN` | Build-time only. Without it the build still succeeds, just without source maps |

The `NEXT_PUBLIC_*` ones are inlined into the browser bundle at build time.
Changing any of them needs a redeploy, not a restart. None may ever hold a
secret — which includes `SENTRY_AUTH_TOKEN`, so note that it is deliberately
*not* prefixed and stays server-side.

**Order matters**: deploy the API first, take its URL, then set
`NEXT_PUBLIC_API_URL` and `CORS_ORIGINS` from the two real origins and redeploy
both.

---

## 3. How the backend runs as a function

`apps/backend/api/index.js` is the entry point Vercel invokes. It requires
`dist/presentation/serverless.js`, which boots the Nest app once per warm
instance and hands back the Express instance the platform then calls.

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
Both jobs also name `timeZone: 'UTC'` on their `@Cron` decorators, so the
schedule is right whatever the host clock says — that pin is what keeps *logged*
timestamps comparable between deployments, and `main.ts` warns at boot if `TZ`
is set to anything else. The reason the decorators name a zone at all:
`periodKeyFor` builds every billing period key from `getUTCFullYear` /
`getUTCMonth`, so a job firing at 02:00 Beirut on the 1st runs at 23:00 UTC on
the last day of the previous month and computes the **previous** period's key.
Daily repetition hid that as "a day late", never as an error.

The two jobs are reachable over HTTP instead, through
`InternalCronController`, and `vercel.json` schedules them:

| Job | Route | Schedule |
| --- | --- | --- |
| OTP challenge prune | `GET /api/v1/internal/cron/otp-cleanup` | hourly |
| Recurring billing | `GET /api/v1/internal/cron/recurring-billing` | daily, 02:00 UTC |

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

## 5. Known limitations of this deployment

These are real behaviour changes, not warnings to skim.

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

This happened on 2026-09-05, after the repository was transferred from
`abed0srour/mechanization` to the `mechnanization` organization. Three pushes
and a merge to `main` produced zero deployments over four hours.

What it is **not**: a broken project link. Check it before assuming —

```bash
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  https://api.vercel.com/v9/projects/mechanization-api | jq .link
```

The `org` and `repo` strings there go stale after a transfer and are cosmetic.
The field that matters is `repoId`, and GitHub keeps the numeric id across a
transfer or rename — so `repoId` still matching `gh api repos/:owner/:repo --jq .id`
means Vercel is watching the right repository and the link is fine.

What it actually is: the **Vercel GitHub App installation does not follow the
repository**. It was installed on the personal account; the new organization has
no installation, so no webhook fires and Vercel is never told a push happened.
`repoOwnerId` on the link still pointing at the old owner is the tell.

The fix has two halves, and **the first one alone does nothing** — this was
measured, not assumed:

1. Install the Vercel app on the new organization and grant it the repository
   (`github.com/organizations/<org>/settings/installations`).
2. In Vercel, **Settings → Git → Disconnect, then Connect** to the new path.

With (1) done and (2) skipped, a push to a fresh branch produced two GitHub
check-runs and zero Vercel deployments — no failed build, no GitHub deployment
record, nothing. Vercel matches an incoming event against the owner recorded on
the project, and until step (2) rewrites `repoOwnerId` the event belongs to an
owner it does not recognise.

Step (2) is easy to believe you have done, because Vercel's UI shows the project
as connected throughout. The only reliable confirmation is `link.updatedAt`
moving and `link.repoOwnerId` changing to the organisation's id — re-run the
`curl` above and compare.

Two things worth knowing while it is broken: `git push` keeps working through
GitHub's redirect, so nothing warns you, and `git remote set-url origin` to the
new path is worth doing regardless to stop the redirect notice on every push.

---

## 6. After the first deploy

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

Two Sentry projects, one per Vercel project, because the two deployments fail
for different reasons and a merged stream makes neither legible:

| Vercel project | DSN variable | Covers |
| --- | --- | --- |
| `mechanization-api` | `SENTRY_DSN` | 5xx from `DomainExceptionFilter`, and cold-start boot failures |
| `mechanization-web` | `NEXT_PUBLIC_SENTRY_DSN` | Browser errors, SSR and middleware failures |

### It is optional, on purpose

An unset DSN disables the SDK and changes nothing else. There is deliberately
**no** production guard demanding one: §8.7 of `AGENTS.md` is an incident about
an env check whose only possible effect was a boot failure, and a municipality's
API refusing to start because an observability vendor's DSN is absent would make
the register less available in exchange for nothing.

What replaces the guard is a boot log line — the API prints either
`Sentry error reporting enabled` or `Sentry disabled (no SENTRY_DSN)` on every
start. Read it after deploying rather than assuming.

### Scope each DSN to one environment

Set `SENTRY_ENVIRONMENT` (API) and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (web)
per Vercel environment, not once for both. Preview and production both run with
`NODE_ENV=production`, so without this every pull-request preview reports into
the production issue stream — §8.5 in a different system. The web project falls
back to `VERCEL_ENV`, which is already per-environment; the API has no such
fallback and needs the variable set explicitly.

### What is deliberately not sent

Sentry is a third party, and the tenant schemas hold national ID numbers, home
addresses and residency status. `AGENTS.md` §4 forbids citizen data leaving
staging; sending it to a SaaS index would be the same failure with extra steps.
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

## 8. Staff sessions and the token exchange

A staff sign-in used to produce one token with one lifetime — 8h, or 30d with
"تذكّرني" — and when it ran out the next request came back 401. A clerk halfway
through a citizen form at hour eight lost the form. There was no refresh token,
so expiry was a hard stop wherever it landed.

It is now **two bounds instead of one**:

| Bound | Variable | Default | What it is |
| --- | --- | --- | --- |
| Token life | `JWT_STAFF_IDLE_TTL` | `30m` | How long one token is accepted before it must be exchanged |
| Session cap | `JWT_STAFF_TTL` / `JWT_STAFF_REMEMBER_TTL` | `8h` / `30d` | When the clerk signs in again. Stamped at login, never moves |

`JWT_STAFF_TTL` keeps the value and the meaning an operator already had for it —
how long a sign-in lasts. What changed is which expiry it names: it used to be
the token's, and is now the session's. Nobody has to change a variable.

The portal exchanges the token for a fresh one whenever a request meets an
expired one (`POST /t/:slug/auth/staff/refresh`), replays the request, and the
screen never sees the 401. Past `sessionExpiresAt` there is no exchange at any
price, so a session still ends at exactly the wall-clock moment it did before.

### What this does and does not buy

**It does not shrink the window a stolen token is useful for**, and it is worth
being plain about that rather than letting the short TTL imply otherwise. The
exchange has to accept an *expired* token — otherwise a clerk returning from
lunch meets the same hard 401 at half an hour instead of eight, which is worse
than what it replaced — so anyone holding the token can exchange it too. The
credential's effective life is the session cap, exactly as it was.

What it buys is that the cap is now the *only* thing that ends a session, rather
than the token's own expiry ending it at an arbitrary moment mid-task.

Reducing the theft window needs a second credential that only the exchange
endpoint accepts, stored server-side, rotated on every use with reuse detection
— i.e. real refresh tokens. That is a new tenant table and a migration applied
per municipality, and it is deliberately not what this is. This change is a
prerequisite for it, not a substitute.

### What is still enforced on every exchange

The exchange route is `@Public()` because the guard rejects expired tokens and
an expired token is the normal input here. The checks move inside the service
rather than disappearing — signature, tenant, session cap, plus:

- **Revocation.** `tokenVersion` and `isActive` are re-read, so a dismissal
  still takes effect within `SessionRevocationService`'s cache window and a
  revoked session cannot refresh its way back.
- **Role.** Re-read from the row rather than copied from the token, so a
  promotion or demotion reaches the session at the next exchange instead of the
  next sign-in. `RolesGuard` authorises from this claim, so a stale one is an
  authorisation decision made on old information.

### Deploying it

No migration, and no coordination between the two projects. Sessions already in
flight carry no `sessionExpiresAt`; the exchange falls back to the token's own
`exp`, which means those sessions keep exactly the lifetime they were issued
with and simply cannot be extended. Each clerk signs in once, at the moment they
would have anyway, and gets the new shape.
