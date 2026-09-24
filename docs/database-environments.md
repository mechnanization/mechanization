# Database environments

Two databases in one Postgres cluster, three targets, and a set of checks whose
only job is to make "I ran it against the wrong one" impossible rather than
unlikely.

| Target | Database | Role | Env file | Who runs it |
| --- | --- | --- | --- | --- |
| `local` | `municipality_db_staging` | `appuser_staging` | `apps/backend/.env` | `pnpm dev` and `db:*:local` on a laptop |
| `staging` | `municipality_db_staging` | `appuser_staging` | `apps/backend/.env.staging` | CI: push to `develop`, and before every production run — §3 |
| `production` | `municipality_db` | `appuser` | `apps/backend/.env.production` | CI: every push to `main`, before the code ships — §3 |

Both databases live on the Lightsail box that also runs the backend (moved off
Supabase in September 2026). **Port 5432 there is closed to the internet and
must stay closed.** A laptop reaches the database through an SSH tunnel, on 5433
because a local Postgres install commonly holds 5432:

```bash
ssh -i <key.pem> -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -L 5433:localhost:5432 <ssh-user>@<lightsail-host>
# then, in apps/backend/.env:
# DATABASE_URL="postgresql://appuser_staging:<pw>@localhost:5433/municipality_db_staging"
```

`local` and `staging` are the same database. There is no local Postgres stack —
`docker-compose.yml` runs Redis and nothing else — so "local" describes where
the *process* runs, not where the data lives. `pnpm dev` writes to staging. A
laptop needs only `apps/backend/.env`; `.env.staging` exists for CI.

The database names and roles above are pinned in
[`scripts/db/targets.mjs`](../scripts/db/targets.mjs). They are not secrets; the
passwords they pair with are, and those stay in ignored dotenv files and GitHub
Environment secrets.

---

## 1. The commands

```bash
pnpm db:check                 # validate every env file present. No network.
pnpm db:test                  # unit-test the guard itself
pnpm db:status:local          # what is pending on staging (via .env), applies nothing
pnpm db:deploy:local          # apply to staging
pnpm db:status:production     # same for production
pnpm db:deploy:production     # apply, after typing the database name
```

The `db:*:staging` forms do the same as `db:*:local` against the same database,
but read `.env.staging`, which only CI writes.

Every one of them names its target. There is deliberately no bare `db:deploy`
that reads ambient configuration and guesses.

Authoring a migration is unchanged:

```bash
pnpm db:migrate               # registry: prisma migrate dev --create-only
pnpm db:migrate:tenant        # tenant:  prisma migrate dev --create-only
```

---

## 2. What stops a mistake

Seven checks, each one there because of a specific way this goes wrong.

**The env file must name the database and role the target is pinned to.** Both
connection strings are parsed, and a database name or role that differs from
the target's is a hard failure. Editing a dotenv file can no longer change which
database a command reaches — only naming a different target can.

The host is deliberately *not* checked. Every connection goes through a tunnel,
so from the machine running the command, staging and production are both
`localhost`; a host check would pass either. The role is checked as well as the
database because it is the half the cluster enforces — `appuser_staging` holds
no `CONNECT` on `municipality_db`.

**A non-production env file may not mention production at all** — not
`municipality_db`, not `appuser`, not the retired Supabase production project —
not even in a comment. This catches the half-finished edit, and the duplicated
key: on 2026-09-23 `apps/backend/.env` held a staging `DATABASE_URL` near the
top and a production one further down, and dotenv keeps the *last*.

**`pnpm dev` runs the check before it boots.** The moment someone pastes a
production connection string into `apps/backend/.env` — to read one row, to
reproduce one bug — the dev server stops starting instead of quietly attaching
the whole application to live data.

**Anything that loses data blocks the deploy.** Pending migrations are scanned
for `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER COLUMN … TYPE`, `RENAME` and
`DELETE FROM`. Those refuse to run without `--allow-destructive`, which only the
manual *Deploy production* workflow can pass. Statements that take a heavy lock
(`SET NOT NULL`, a non-concurrent `CREATE INDEX`) or rewrite existing rows
(`UPDATE … SET`) print a warning and continue. A backfill is expected to fill
new columns, and a scanner cannot tell that from an overwrite.

**Production only accepts migrations staging has already applied.** The deploy
reads staging's migration history and refuses anything staging has not seen.
This is what turns "we have a staging environment" into "staging is
load-bearing".

**Production needs the database name typed out.** Interactively, you type
`municipality_db` at a prompt; in CI, `--confirm=municipality_db` must match, so
a command copied from the staging runbook cannot fire at production.

**The restore drill refuses any pinned database.** `verify-restore.mjs` only
restores onto a loopback address — but a tunnel *is* a loopback address, so it
also refuses any URL naming `municipality_db`, `municipality_db_staging`,
`appuser` or `appuser_staging`, wherever it points.

None of this is a substitute for reading the SQL. It is a floor, not a ceiling.

---

## 3. The normal path

```
feature branch
    ↓  pnpm db:migrate            author the migration
    ↓  pnpm dev                   it runs against staging, locally
  PR → develop
    ↓  CI: typecheck · test · db:test
  merge to develop
    ↓  Actions: Deploy staging     migrates staging (automatic)
  PR → main, merge
    ↓  Actions: Deploy Backend     1. migrate staging, then production (automatic)
                                   2. build, boot the candidate, cut over
```

Every push to `main` migrates production **before** the code that needs the
migration ships, and ships nothing if the migration fails. The migration job is
[`migrate-database.yml`](../.github/workflows/migrate-database.yml). A GitHub
runner opens an SSH tunnel to the Lightsail box (runner port 5433 → the box's
5432), writes the env files from the `db-production` environment's secrets for
the length of the job, and runs `scripts/db/deploy.mjs`: staging first, then
production. The guard's checks all apply, unattended:

- the connection strings must name the pinned database and role;
- a live schema whose migration history is missing stops the run (see below);
- production must report at least one municipality, since zero means the read
  went to the wrong place;
- every production migration must already be on staging, and staging must have
  a municipality to have run tenant migrations on;
- data-losing DDL is refused;
- afterwards the registry and every tenant schema are read again and must have
  nothing pending.

The previous release keeps serving traffic until the cutover, so it runs
against the new schema for a few minutes. That is why the automatic path only
ever applies additive migrations (§4).

### The manual workflow

Actions → **Deploy production** is for the two things that never happen
automatically:

- **A dry run.** Type `municipality_db`, leave `dry_run` on. It lists what is
  pending on staging and production and changes nothing. Production's report
  fails for anything staging still lacks; a real run migrates staging first.
- **The contract step** of an expand/contract change (`DROP COLUMN`, `RENAME`, a
  type change), with `allow_destructive` ticked. Confirm a backup exists first
  (§5).

Afterwards `curl https://<api>/api/v1/health/ready` should return
`{"status":"ready"}`.

### When the migration history is missing

The databases on the Lightsail box are restores of the Supabase ones, so each
one's schema and its migration history arrived together in the dump. Each has
two histories: `public._prisma_migrations` for the registry (one migration,
`0001_init`), and `tenant_<slug>._tenant_migrations` inside each municipality's
own schema. The tenant migrator reads only the second.

If a history did not survive, `deploy.mjs` refuses before running anything:
"holds a live schema but not the history of how it got there". Re-running the
migrations would re-create tables that already hold citizens' records. The
repair is a production data correction, not a deploy:

1. Prove the schema matches the migrations: every migration's objects exist, in
   the right schema.
2. Record the history in a guarded, reviewed transaction: the folder names into
   `"<schema>"._tenant_migrations`, or `prisma migrate resolve --applied 0001_init`
   for the registry, and nothing else.

**Never `prisma migrate resolve` for tenant migrations**, and never `prisma
migrate deploy --schema …/tenant/schema.prisma`. Both aim at `public`: the first
writes rows the tenant migrator never reads, and the second runs tenant DDL in
the registry's schema and then blocks every later deploy with P3009.

---

## 4. Schema changes that cannot lose data

The scanner blocks destructive DDL; this is the discipline that means you rarely
need to unblock it. It is the **expand/contract** pattern (also called parallel
change), and it is the standard answer to schema changes on a live database.

A rename, done wrong, is one migration: `ALTER TABLE … RENAME COLUMN a TO b`.
Between that statement committing and the new code being live, every running
instance is querying a column that no longer exists. Done right it is three
releases:

**Expand** — add the new thing, change nothing about the old. Add column `b` as
nullable. The running application does not know it exists, and nothing breaks.

**Migrate** — backfill `b` from `a` in batches, and deploy code that writes to
both and reads from `b` with a fallback to `a`. Both shapes are now correct, so
a rollback at any point is just a redeploy.

**Contract** — a release later, once nothing reads `a` and you have watched it
in production for a bake period, drop `a`. This is the one migration that runs
with `--allow-destructive`, and by then the flag is an accurate description of a
deliberate act rather than a way past an error message.

The same three steps cover retyping a column, splitting a table, and making a
column `NOT NULL` (add the constraint `NOT VALID`, backfill, then `VALIDATE`,
which takes a far weaker lock).

Two further rules for this codebase specifically:

- **Indexes on tenant tables want `CREATE INDEX CONCURRENTLY`.** A plain
  `CREATE INDEX` holds a write lock, and `tenant:migrate-all` runs it once per
  municipality in sequence. Note that `CONCURRENTLY` cannot run inside a
  transaction, and `tenant-migrator.ts` wraps each migration in one — so an
  index built this way needs its own migration containing nothing else, and the
  transaction wrapper adjusted for it. That is a real limitation, not a
  formality.
- **Migrations are immutable once merged.** Prisma records a checksum; editing
  an applied migration makes every environment that already ran it fail. Fix
  forward with a new migration.

### Rollback

There are no down-migrations here, by design. A down-migration is code that has
never run, being asked to work on the worst day. The rollback plan is:

- **Bad code, good schema** — redeploy the previous build. This works because
  expand/contract keeps the schema compatible with the release before it.
- **Bad schema** — write a forward migration that corrects it.
- **Data loss** — restore. See below.

---

## 5. Backups

> **This section describes the Supabase-era backup and has not been adapted to
> Lightsail.** `backup.yml` cannot reach the database (see the note in §3), and
> `backup.mjs` still dumps Supabase's `auth` and `storage` schemas, which do not
> exist on the new server — a run would fail there. Document bytes now live in
> S3, not Supabase Storage. Until this is rebuilt, **production has no automated
> backup**; on AWS the floor is a scheduled snapshot of the Lightsail instance
> plus a nightly `pg_dump`.

**The production project is on the Supabase free plan, so the platform provides
nothing here.** Not daily backups, not Point-in-Time Recovery, and no
downloadable backup in the dashboard. That was checked on 2026-09-16; an earlier
version of this section told you to go and check it, and nobody had. Until the
plan changes, [`.github/workflows/backup.yml`](../.github/workflows/backup.yml)
is the only copy of the register that exists anywhere.

Upgrading to Pro ($25/mo) restores a floor under all of this — daily backups
with 7-day retention, and no pausing for inactivity. PITR is a further add-on
(~$100/mo at 7 days' retention) and is the only thing that actually delivers
"restore to the second". A nightly backup's honest promise is **at most 24 hours
of registrations lost**. Do not let anyone round that up to "we have backups, so
we're covered".

### What runs nightly

22:00 UTC, in GitHub Actions rather than Vercel Cron — the backend function is
capped at 60s and 1 GB, and the team is on the Vercel Hobby plan. The order of
the steps is the design:

```
dump → prove it restores → encrypt → upload → prove the upload arrived
```

The restore rehearsal runs against a throwaway Postgres 17 container, on the
real dump, **before** anything is uploaded. So a dump that cannot be restored
never becomes your stored backup: the job fails, nothing is uploaded, and the
previous good backup is still in the bucket. This repository has already been
bitten by the other arrangement — `BackupService`'s restore was broken for every
municipality while its rehearsal reported success, because the rehearsal counted
rows instead of writing them.

Three properties worth keeping if you change this workflow:

- **It cannot write to production.** `scripts/db/backup.mjs` opens every
  connection — its own and `pg_dump`'s — with `default_transaction_read_only=on`
  and aborts if the server does not confirm it. The server refuses writes; it is
  not a convention in a comment.
- **It cannot restore onto anything real.** `scripts/db/verify-restore.mjs`
  refuses any `--into` that resolves to a known Supabase ref or to a non-loopback
  host. There is no override flag.
- **It never deletes.** Uploads use `rclone copy`, never `sync` — `sync` makes
  the destination match the source, which means it propagates a deletion into
  your backup. Retention is a bucket lifecycle rule (below), which is what lets
  the upload token be write-only.

### What is backed up, and what is not

| | Covered by | |
| --- | --- | --- |
| Registry schema (`public`) and every `tenant_*` schema | `pg_dump` → `<base>.dump`, schemas discovered at run time | ✅ |
| Sequences, triggers, the audit trail | same | ✅ |
| `auth.users`, `auth.identities` — staff logins and password hashes | `pg_dump` of `auth` → `<base>.auth-storage.dump` | ✅ |
| `storage.objects`, `storage.buckets` — the rows naming each document | same second archive | ✅ |
| `documents` and `cadastre` object **bytes** | `rclone copy` of the Supabase S3 endpoint | ✅ |
| Postgres roles and passwords | nothing — platform-managed, recreated by Supabase | ❌ |
| Auth providers, redirect URLs, Vercel and GitHub env vars | nothing — see §6 and §7 | ❌ |

A complete backup is **three** things, not one: the register, the `auth` archive,
and the object bytes. Staff rows in `tenant_*.users` link to `auth.users` by
**email**, not by id — the ids do not match — and every password hash lives in
`auth`. A recovery from the register alone returns the municipality's data with
nobody able to sign in to it, which is why the second archive exists and why the
restore rehearsal fails if it is not handed both.

Session state (`auth.sessions`, `auth.refresh_tokens`) *is* dumped, because a
backup that decides for you is a backup with rows missing — but you almost
certainly do not replay it into a recovered project. That choice belongs to the
restore, below.

Schemas are **discovered**, not listed. This is the one place the "allowlist,
never discover" rule in [AGENTS.md](../AGENTS.md) §4 inverts: that rule governs
data *leaving*, where a discovered table is incident §8.4. A backup's failure
mode is the opposite — a table nobody remembered to add, found missing on the
day it was needed.

### One-time setup

Secrets go in the `db-production` GitHub Environment, beside the existing four:

| Secret | Where it comes from |
| --- | --- |
| `BACKUP_AGE_PUBLIC_KEY` | `age-keygen` — see below |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare → R2 → Manage API tokens |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET` | Backblaze → Application Keys |
| `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY` | Supabase → Storage → S3 Access Keys |

**The age key.** Generate it on a machine that is not CI and not a laptop that
travels:

```bash
age-keygen -o backup-key.txt      # prints the public key to stderr
```

The **public** key goes in `BACKUP_AGE_PUBLIC_KEY`. The **private** half never
goes into GitHub, Vercel, or this repository — it lives offline with the
municipality, and a copy in a sealed envelope somewhere else. CI can encrypt and
cannot decrypt, which is the entire reason it is acceptable to store a register
of national ID numbers, addresses and residency status on infrastructure outside
Lebanon: Cloudflare holds ciphertext, and the question becomes who holds one key.

**Losing the private key loses every backup.** There is no recovery path. Treat
it the way the municipality treats its seal.

**The R2 token must not be able to delete.** Scope it to object writes only, and
set the retention rule as a bucket lifecycle policy in Cloudflare rather than as
a prune step in CI. A token that can delete your backups is how a compromise
takes the backups too — which is the usual way people find out. Suggested
lifecycle: expire `db/daily/` after 35 days, keep `storage/` indefinitely.

### Before a data-rewriting migration

Run the workflow manually first — Actions → *Backup production* → Run workflow —
and wait for it to go green. `workflow_dispatch` takes a `skip_upload` input if
you only want the restore rehearsal. Do not run a production migration while the
nightly backup is running: `pg_dump` holds `ACCESS SHARE` on every table for its
duration, so an `ALTER TABLE` starting mid-dump queues behind it, and every
query arriving after that queues behind the `ALTER`.

### Restoring

Restoring is deliberately not automated. Decrypt with the offline private key,
then `pg_restore` the schemas you actually need — usually one municipality, not
the cluster:

```bash
age -d -i backup-key.txt production-<ref>-<stamp>.dump.age > restore.dump
pg_restore --list restore.dump                     # read before you write
pg_restore --no-owner --no-privileges \
  --schema=tenant_<slug> --dbname="$TARGET" restore.dump
```

`--list` first, every time.

**Archives taken before tenant migration `0048` need one patch to restore.**
`search_compact` called `search_normalize` unqualified, and `pg_restore` runs
with `search_path = ''`, so building `citizen_payments` — whose `searchText` is a
generated column calling it — stops with `function search_normalize(text) does
not exist ... during inlining`. The rows are all in the archive; the schema
cannot be built without the edit. Convert to SQL, qualify the single call, then
load it:

```bash
pg_restore --no-owner --no-privileges -f restore.sql <archive>.dump
perl -0pi -e 's/(AS \$\$\s*\n\s*SELECT replace\()search_normalize\(/$1tenant_<slug>.search_normalize(/' restore.sql
psql "$TARGET" -c 'DROP SCHEMA IF EXISTS public CASCADE'
psql "$TARGET" -v ON_ERROR_STOP=1 -f restore.sql
rm -f restore.sql      # it is the whole register in plaintext
```

Once `0048` is applied to a database, its dumps restore with plain `pg_restore`
and this step is unnecessary. It was found by the restore rehearsal — nothing
else could have found it, and every archive taken before it has the defect.

Then the logins, from the second archive. This one restores **`--data-only`**:
a fresh Supabase project has already created `auth` and `storage` itself, owned
by `supabase_auth_admin` and `supabase_storage_admin`, so replaying the archive's
DDL would collide with objects the platform put there — and the usual way out of
that collision at 3am is `--clean`, which turns a recovery into a second
incident.

```bash
age -d -i backup-key.txt production-<ref>-<stamp>.auth-storage.dump.age > auth.dump
pg_restore --list auth.dump
pg_restore --data-only --no-owner --disable-triggers --dbname="$TARGET" \
  --table=users --table=identities \
  --table=buckets --table=objects \
  auth.dump
```

Add `--table=sessions --table=refresh_tokens` only if you actually want to
replay live sessions into the recovered project; normally you do not, and staff
sign in again.

Finally the object bytes, without which every document link in the restored
register is dead:

```bash
rclone copy "r2:$R2_BUCKET/storage/documents/" "supastorage:documents/"
rclone copy "r2:$R2_BUCKET/storage/cadastre/"  "supastorage:cadastre/"
```

**Then verify, do not assume (§5 of [AGENTS.md](../AGENTS.md)).** Compare the
counts in `<base>.manifest.json` against the restored database, and then sign in
as a staff user. A restore that reports success and cannot be logged into is the
failure this whole section is built around. The manifest carries its own
`restoreOrder` field with these same steps, because during a recovery the
manifest is the file you have to hand and this document may not be.

---

## 6. Secrets

| Where | What |
| --- | --- |
| `apps/backend/.env` | Staging credentials. Gitignored. |
| `apps/backend/.env.staging` | Staging credentials. Gitignored. |
| GitHub → Environments → `db-staging` | `STAGING_DATABASE_URL`, `STAGING_DIRECT_URL` |
| GitHub → Environments → `db-production` | `PRODUCTION_DATABASE_URL`, `PRODUCTION_DIRECT_URL`, **plus** the two `STAGING_` ones: a production run migrates staging first and checks its history. |
| GitHub → repository secrets | `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` (the deploy, and the migration tunnel), `SSH_KNOWN_HOSTS` (the tunnel) |

The database URLs name the **runner's end of the tunnel**, not the box. The
`DIRECT_URL` is the same string, since there is no connection pooler:

```
PRODUCTION_DATABASE_URL  postgresql://appuser:<pw>@localhost:5433/municipality_db
STAGING_DATABASE_URL     postgresql://appuser_staging:<pw>@localhost:5433/municipality_db_staging
```

URL-encode `@ : / ? #` in a password. The `*_SUPABASE_URL` and
`*_SERVICE_ROLE_KEY` entries left from before the move are read by nothing and
can be deleted.

**`SSH_KNOWN_HOSTS`** is the box's public host keys. The tunnel checks the
server against them before it sends a database password, and refuses to open
without them: every runner is a fresh machine, so "trust the first key seen"
would trust whatever answered at that address. Take the lines from the box
itself, not from a network scan:

```bash
for f in /etc/ssh/ssh_host_*_key.pub; do echo "<SSH_HOST value> $(cut -d' ' -f1,2 "$f")"; done
```

The first word of each line must be exactly what `SSH_HOST` holds. A rebuilt
box has new keys: update both secrets together, or every deploy stops at
"Host key verification failed", which is the point.

`db-production` has **no required reviewer**: migrations run unattended on every
push to `main`. Reinstating one makes each push wait for an approval at the
migration job, even when nothing is pending.

The `db-` prefix is not decoration. The Vercel integration creates its own
environments in this repository — `Production – mechanization-api`,
`Preview – mechanization-web` and so on — which report the status of *code*
deployments. These two gate *database migrations*. **Do not add protection
rules to the Vercel-created ones**: a required reviewer there starts holding
every site deploy for approval, which is not what anyone intended and is
confusing to diagnose.

There is no `apps/backend/.env.production`, and on a working laptop there should
not be one. A copy of the production database password on a developer's disk is
a credential with no expiry, no audit trail and no revocation path. The
break-glass procedure, for when CI is down and production is broken, is written
at the top of [`.env.production.example`](../apps/backend/.env.production.example) —
including the step everyone forgets, which is deleting the file afterwards.

`JWT_SECRET` **must differ between staging and production.** Sharing it means a
token minted by staging is accepted by production.

### Vercel

The deployed API reads its configuration from Vercel's environment variables,
not from anything in this repository or in GitHub secrets. That is a third
surface, and it is the one that decides which database real traffic reaches.

Every variable on `mechanization-api` used to be scoped `[production, preview]`,
which meant every pull-request preview deployment read and wrote the production
database. These five are now split, and must stay split:

| Variable | Production scope | Preview scope |
| --- | --- | --- |
| `DATABASE_URL` | `thbgwfbcqdougbjvgvyw` | `lzgbjcwtzqyrbeoolvdz` |
| `DIRECT_URL` | `thbgwfbcqdougbjvgvyw` | `lzgbjcwtzqyrbeoolvdz` |
| `SUPABASE_URL` | `thbgwfbcqdougbjvgvyw` | `lzgbjcwtzqyrbeoolvdz` |
| `SUPABASE_SERVICE_ROLE_KEY` | production key | staging key |
| `JWT_SECRET` | production secret | staging secret |

When adding any new variable that names a database, a bucket or a signing
secret, scope it to one environment. Ticking both boxes is the same mistake as
pointing `.env` at production — and unlike that one, no script here can catch
it, because Vercel's configuration is not visible from the repository.

Still shared, and lower stakes but not zero: `CORS_ORIGINS`, `PUBLIC_API_URL`,
`PUBLIC_PORTAL_URL`, `CRON_SECRET`. On `mechanization-web`,
`NEXT_PUBLIC_API_URL` is also shared, so preview builds of the portal call the
production API.

---

## 7. Sources

The practices above are the common industry ones, not invented here:

- [Managing Environments — Supabase](https://supabase.com/docs/guides/deployment/managing-environments)
  — separate projects per environment, migrations applied by CI, one-directional
  flow local → staging → production.
- [Expand and Contract](https://www.tim-wellhausen.de/papers/ExpandAndContract/ExpandAndContract.html)
  and [Parallel Change](https://medium.com/@jasminfluri/expand-and-contract-method-for-database-changes-414d236f236f)
  — the three-release pattern in §4.
- [Deploying database changes with Prisma Migrate](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate)
  — `migrate deploy` in CI, never `migrate dev`; immutable migration history.
- [Zero-downtime schema migrations in PostgreSQL](https://medium.com/@antoniodipinto/zero-downtime-schema-migrations-in-postgresql-c138017e7f90)
  — `lock_timeout` and `statement_timeout` on migration sessions, `NOT VALID`
  then `VALIDATE`, `CREATE INDEX CONCURRENTLY`.
