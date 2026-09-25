## Setup

Needs Node, pnpm and Docker Desktop.

```bash
pnpm install
pnpm --filter @mechanization/shared-schemas build
pnpm db:generate

# Create apps/backend/.env and apps/frontend/.env.local first:
# contents in docs/database-environments.md §0.1, "The env files".
pnpm db:check                                  # ✓ local → appuser_local@127.0.0.1:5434/municipality_db_local
docker compose up -d --wait postgres redis     # the local database and cache
pnpm db:deploy:local                           # registry schema
pnpm db:seed                                   # 2 municipalities, staff logins, fake citizens
pnpm --filter @mechanization/backend cadastre:import --slug albazourieh --file data/bazoreyye.kmz --out-dir ../../.cadastre-out
```

`apps/backend/.env` points at a Postgres 17 container on your own machine
(`127.0.0.1:5434`) that holds seeded data only. `pnpm dev` refuses to start if
the file names staging or production. Never load a copy of either into it.
Details, logins and the reset procedure are in
[docs/database-environments.md §0](docs/database-environments.md#0-the-local-database).

## Run everything at once

```bash
pnpm start
```

Starts the local database and Redis in Docker, then runs backend + frontend together. Docker must be running.

## Run backend + frontend

```bash
pnpm dev     
```

- Backend only: `pnpm --filter @mechanization/backend dev`
- Frontend only: `pnpm --filter @mechanization/frontend dev`

## Run Redis (caching)

The backend caches dashboard/map data in Redis. It's optional — if `REDIS_URL` is unset or Redis is unreachable, reads fall through to Postgres.

```bash
docker compose up -d redis    
```

Make sure `apps/backend/.env` has:

```
REDIS_URL="redis://localhost:6379"
```

## Run everything with Docker

```bash
docker compose up --build
```

Runs the local database, Redis, backend and frontend. The database must already be migrated and seeded (Setup, above). Document storage is S3 and deliberately not configured locally, so document views fail rather than reach the real bucket.

## Onboarding a municipality

Two steps, both deliberate. Provisioning creates the schema; it does **not**
create an account, so the second step is what makes the municipality reachable.

```bash
pnpm --filter @mechanization/backend tenant:provision \
  --slug <slug> --name <name> --name-ar <name-ar> --prefix <prefix>

pnpm --filter @mechanization/backend staff:create \
  --slug <slug> --email <email> --password '<password>' \
  --first-name <name> --last-name <name>
```

`staff:create` prints an authenticator secret and an `otpauth://` URI, once.
A `SUPER_ADMIN` is refused a session until that second factor is enrolled, so
hand it to its owner over a channel you trust and then delete it. If it never
arrives, reissue with `--reset-totp`; nothing reads it back out of the database.

Staff added later come from the dashboard, and a `SUPER_ADMIN` created there
gets its enrolment secret in the same response.

> Signing in no longer creates a missing profile. It used to, taking the role
> and municipality from Supabase `user_metadata` — which is writable by the
> account holder — and defaulting them to `SUPER_ADMIN` and the slug in the
> request URL. Any account in the shared Supabase project could therefore
> administer any municipality it had not yet visited.

## Other commands

```bash
pnpm --filter @mechanization/backend test              
pnpm --filter @mechanization/backend cadastre:import --slug <slug> --file <path.kmz>
pnpm --filter @mechanization/backend staff:create --slug <slug> --email <email> --reset-totp
pnpm lint
```

Migrations go through the target-aware scripts rather than
`tenant:migrate-all` directly — the wrapper is what checks which database it is
about to rewrite:

```bash
pnpm db:status:staging     # list pending migrations, apply nothing
pnpm db:deploy:staging     # apply to staging
pnpm db:status:production  # dry run against production
```

Production is deployed from GitHub Actions behind an approval, not from a
laptop. [docs/database-environments.md](docs/database-environments.md) has the
full picture.

`reissue-references` replaces every citizen رقم مرجعي in a municipality. Those
minted before the CSPRNG fix came from `Math.random()`, and the reference alone
signs a citizen in — so the existing corpus is predictable. It invalidates every
printed receipt, so announce it first and keep the CSV it writes to stdout: it
is the only record of which citizen to notify.

```bash
pnpm --filter @mechanization/backend reissue-references --slug <slug> --dry-run
pnpm --filter @mechanization/backend reissue-references --slug <slug> --confirm <slug> > reissued.csv
```

## Deploying

Vercel, two projects from this one repository — see [docs/deploy-vercel.md](docs/deploy-vercel.md).
The container path (`docker compose up --build`) still works and is the one that
keeps in-process cron and a long-lived Redis connection.
