# Mechanization (منظومة المكننة البلدية)

Last verified against the code: `develop@8742c5b`, 2026-10-03.

A registration system for Lebanese municipalities: the citizen register, the
building and unit census, the cadastre map, fees and payments. Each
municipality's data lives in its own Postgres schema. A NestJS API
(`apps/backend`) serves a Next.js staff dashboard and citizen portal
(`apps/frontend`), with contracts shared through `packages/shared-schemas`.

The tenant schemas hold national ID numbers, addresses, phone numbers and
residency and refugee status. Read [CLAUDE.md](CLAUDE.md) before you change
anything that touches a database.

## Prerequisites

- Node 20 or later (CI runs 22).
- pnpm 9.12.0, as pinned in `packageManager` (Corepack picks it up).
- Docker Desktop, for the local Postgres 17 and Redis.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm --filter @mechanization/shared-schemas build
pnpm db:generate

# Create apps/backend/.env and apps/frontend/.env.local first.
# Their contents: docs/database-environments.md §0.1, "The env files".
pnpm db:check                                  # expect: local → appuser_local@127.0.0.1:5434/municipality_db_local
docker compose up -d --wait postgres redis     # the local database and cache
pnpm db:deploy:local                           # the registry migration (later: every municipality's too)
pnpm db:seed                                   # 2 municipalities, the real parcel map, every staff role, synthetic citizens
```

`pnpm db:seed` prints the staff logins. `pnpm db:seed:census` adds buildings,
units and map points on top.

`apps/backend/.env` points at a Postgres 17 container on your own machine
(`127.0.0.1:5434`) that holds seeded, synthetic data only. `pnpm dev` refuses
to start if the file names staging or production. Never load a copy of either
into it. Details, logins and the reset procedure:
[docs/database-environments.md](docs/database-environments.md#0-the-local-database).

## Run

```bash
pnpm start    # starts Postgres and Redis in Docker, builds the shared package once, runs both apps
pnpm dev      # runs both apps; the database must already be up
```

- Backend only: `pnpm --filter @mechanization/backend dev` (port 4000).
- Frontend only: `pnpm --filter @mechanization/frontend dev` (port 3000).
- `pnpm dev` does not rebuild `packages/shared-schemas`. When you edit it, keep
  `pnpm --filter @mechanization/shared-schemas dev` running alongside.
- Redis is optional: with `REDIS_URL` unset or unreachable, `RedisCacheService`
  serves from its in-memory tier.
- `docker compose up --build` runs the database, Redis, backend and frontend in
  containers. The database must already be migrated and seeded. Document
  storage (S3) is deliberately not configured locally, so document views fail
  instead of reaching the real bucket.

## Test

```bash
pnpm lint
pnpm typecheck
pnpm --filter @mechanization/backend test     # integration suites skip without TEST_DATABASE_URL
pnpm --filter @mechanization/frontend test
pnpm db:test                                  # the database target guard and migration scanner
pnpm build:check                              # a production frontend build that leaves .next alone
```

The backend integration suites drop and rebuild schemas in whatever database
`TEST_DATABASE_URL` names. Run them only against a throwaway Postgres 17
container: [docs/database.md](docs/database.md#test-a-migration-on-a-throwaway-postgres-17).

## Onboarding a municipality

On your local database, two deliberate steps. Provisioning creates the schema
and applies every tenant migration; it creates no account. The second step
makes the municipality reachable.

```bash
pnpm --filter @mechanization/backend tenant:provision \
  --slug <slug> --name <name> --name-ar <name-ar> --prefix <prefix>

pnpm --filter @mechanization/backend staff:create \
  --slug <slug> --email <email> --password '<password>' \
  --first-name <name> --last-name <name>
```

`staff:create` creates a `SUPER_ADMIN` unless you pass `--role`. For a
`SUPER_ADMIN` it issues an authenticator secret, already confirmed, and prints
it once with an `otpauth://` URI, so that account needs a code from its first
sign-in. Hand it to its owner over a channel you trust, then delete it. If it
never arrives, reissue it with `--reset-totp`; nothing reads it back out of the
database. Staff added later come from the dashboard, and a `SUPER_ADMIN`
created there gets its enrolment secret in the same response.

**The server does not require 2FA for a `SUPER_ADMIN`.** An admin whose factor
was disabled or never confirmed signs in with the password alone
(`staff-login.spec.ts`). Whether it should be mandatory is an open decision:
[docs/security.md](docs/security.md).

Both scripts read `apps/backend/.env`, which is pinned to the local database.
There is no supported way to onboard a municipality onto staging or production
from a laptop: production credentials never sit on a developer machine, and no
workflow provisions one yet. `scripts/db/provision.mjs` (not a package script)
is the guarded wrapper for a named target. Ask before you use it.

## Reissuing citizen references

`reissue-references` replaces every citizen رقم مرجعي in a municipality.
References minted before the CSPRNG fix came from `Math.random()`, and the
reference alone signs a citizen in, so that corpus is predictable. Reissuing
invalidates every printed receipt: announce it first.

```bash
pnpm --filter @mechanization/backend reissue-references --slug <slug> --dry-run
pnpm --filter @mechanization/backend reissue-references --slug <slug> --confirm <slug>
```

The dry run is the default. The real run prints an `old,new,name,phone` CSV to
stdout, which is the only record of whom to notify. That output is citizen data
and a list of live credentials: never commit it, never leave it on a laptop,
and delete it once the citizens are notified. Whether the script should print
it at all is undecided ([docs/security.md](docs/security.md#known-gaps)).
It reads `apps/backend/.env`, which is pinned to the local database, but has
no target guard of its own: never run it with a staging `DATABASE_URL` exported.

## Deploying

- **API**: AWS Lightsail, nginx in front of pm2.
  `.github/workflows/deploy-backend.yml` runs on every push to `main`. It
  migrates staging and then production (`migrate-database.yml`, which takes an
  encrypted pre-migration backup when something is pending), builds the
  backend, boots a candidate on port 4001, checks `/api/v1/health`, then
  switches the `current` release and reloads pm2. **A push to `main` migrates
  production**, unattended.
- **Staging migrations**: `.github/workflows/deploy-staging.yml`, on pushes to
  `develop` that touch the migrations or the database tooling.
- **Portal**: Vercel. The project is configured outside this repository;
  `apps/frontend/vercel.json` holds its install and build commands.

Runbooks: [docs/database-environments.md](docs/database-environments.md)
(environments, the migration pipeline, backups, secrets) and
[docs/deploy-vercel.md](docs/deploy-vercel.md) (the portal).

## Where the rules are

[CLAUDE.md](CLAUDE.md) is the hub, for people and agents alike: how to work
here, the commands, the non-negotiables, and which doc to read for which task.
[AGENTS.md](AGENTS.md) points other agents to it.
