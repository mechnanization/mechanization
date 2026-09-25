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

Two kinds, kept apart:

- **Day-to-day backups of the Lightsail box are taken on the AWS side**, by
  DevOps, outside this repository. Nothing here schedules them or can see them.
- **A pre-migration backup of production** is taken by the migration pipeline
  itself, right before it applies a migration, so a migration that damages data
  can be undone from the moment before it ran. The rest of this section is
  about that one.

Retired in September 2026, when the database moved to Lightsail:

- the nightly `backup.yml` workflow. It was built for Supabase and Cloudflare
  R2, never produced a backup after the move, and was deleted;
- the in-app **Backup & restore** settings page, which downloaded a
  municipality's snapshot to the admin's computer and could write one back over
  the live register. Its tab is removed and its two routes are unregistered
  (`PresentationModule`) until it is rebuilt on top of the AWS backups.
  `BackupController`, `BackupService` and `BackupSection` are kept for that.

### The pre-migration backup

It runs inside [`migrate-database.yml`](../.github/workflows/migrate-database.yml),
after staging has been migrated and before production is, and **only when
production has something pending**. `node scripts/db/deploy.mjs production --check`
answers that with its exit code: 0 up to date, 3 pending, anything else
refused. Most pushes to `main` apply nothing and take no backup.

```
dump → prove it restores → encrypt → upload (write-once, checksummed) → migrate
```

Every arrow is a gate. If any step fails, production is not migrated and the
code is not deployed.

- **It cannot write to production.** `scripts/db/backup.mjs` opens every
  connection, its own and `pg_dump`'s, read-only, and aborts unless the server
  confirms it.
- **The counts are exact.** The counts in the manifest and the rows in the dump
  are read from one database snapshot (`pg_export_snapshot`, then
  `pg_dump --snapshot`), so a restore must reproduce every count exactly, not
  "at least".
- **It is restored before it is trusted.** `scripts/db/verify-restore.mjs`
  restores the real dump into a throwaway Postgres 17 container on the runner
  and checks every schema, every count and every tenant's migration list. It
  refuses any address naming a pinned database or role, and any host that is
  not loopback. There is no override flag.
- **It is encrypted to a key CI does not hold.** `age`, to
  `BACKUP_AGE_PUBLIC_KEY`. The private key is held offline by DevOps. The
  plaintext dump exists only on the runner, and is shredded as soon as it is
  encrypted, or by the cleanup step if a step before that failed.
- **The pipeline never overwrites or deletes.** Each file is uploaded with
  `--if-none-match '*'` (S3 refuses to replace an existing object) and
  `--checksum-sha256` (S3 refuses bytes that do not match, and the stored
  checksum is compared again). It calls nothing but `PutObject`. Retention is a
  bucket lifecycle rule, not something the pipeline can shorten. **The
  credential can do more than the pipeline does:** as of 2026-09-25 the IAM
  user holds `PutObject`, `GetObject`, `DeleteObject` and `ListBucket` on the
  whole bucket, `daily/` included. DevOps accepted that to ship; step 3 is the
  policy it should be narrowed to.

Where it lands:

```
s3://nestjs-db-backups-687326766003-eu-west-3-an/pre-migrate/production-municipality_db-<time>-<commit>/
    <base>.dump.age         the register, encrypted
    <base>.manifest.json    schemas, exact counts, migrations, restore order
    <base>.dump.sha256      checksum of the plaintext dump
```

| Covered | Not covered |
| --- | --- |
| The registry (`public`) and every `tenant_*` schema, discovered at run time: rows, sequences, triggers, the audit trail, staff password hashes (`users.passwordHash`) | Document and cadastre **files** (objects in the S3 documents and assets buckets; the rows naming them are covered) |
| | Postgres roles and passwords, the server `.env`, nginx, pm2, GitHub and Vercel settings |
| | Staging (a test environment; the backup protects production) |

Schemas are **discovered**, not listed. This is the one place the "allowlist,
never discover" rule in [AGENTS.md](../AGENTS.md) §4 inverts: that rule governs
data *leaving*, where a discovered table is incident §8.4. A backup's failure
mode is the opposite: a table nobody remembered to add, found missing on the day
it was needed.

### One-time setup (DevOps)

1. **The age key.** On a machine that is not CI and not a laptop that travels:
   `age-keygen -o backup-key.txt`. The public key (`age1…`) goes in the
   `BACKUP_AGE_PUBLIC_KEY` secret of `db-production`. The private key never goes
   into GitHub, the server or this repository. **Losing it loses every backup**;
   there is no recovery path.
2. **The IAM user `lightsail-db-backup`.** The pipeline signs in with its
   access keys, stored as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in
   `db-production` **only**. Not in `db-staging`: that environment admits the
   `develop` branch, so any workflow pushed to `develop` could read them, and
   staging takes no backup, so nothing there uses them. The keys do not expire;
   rotate them by creating the new key, updating the two secrets, then
   deactivating the old key once a backup has uploaded with the new one.
3. **The user's permissions policy**, write-only, one prefix. Not applied yet
   (see above), and until it is, a leaked key can read and delete every
   backup in the bucket:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "s3:PutObject",
       "Resource": "arn:aws:s3:::nestjs-db-backups-687326766003-eu-west-3-an/pre-migrate/*"
     }]
   }
   ```

   If the bucket encrypts with a customer-managed KMS key, the user also needs
   `kms:GenerateDataKey` on that key. Anything broader than this policy (read,
   list, delete, other prefixes such as `daily/`) is more than the pipeline
   needs, and would let a leaked key read or destroy backups.
4. **Retention, 90 days**, as a lifecycle rule on the `pre-migrate/` prefix.
   `put-bucket-lifecycle-configuration` **replaces the bucket's whole lifecycle
   configuration**: read the existing one first
   (`get-bucket-lifecycle-configuration`) and add this rule to it, or the rules
   that expire your other backups are silently removed.

   ```json
   { "ID": "pre-migrate-90-days", "Filter": { "Prefix": "pre-migrate/" },
     "Status": "Enabled", "Expiration": { "Days": 90 } }
   ```

   On a versioned bucket, add `"NoncurrentVersionExpiration": { "NoncurrentDays": 90 }`
   too, or expired backups are kept as hidden versions.

Until steps 1–3 are done, a push to `main` with nothing pending works as
normal, and one **with** a migration pending stops before migrating: "Production
has migrations pending and … is not set … Nothing was migrated."

**Do not schedule the AWS-side `pg_dump` over deploys.** A dump holds
`ACCESS SHARE` on every table while it runs, so a migration's `ALTER TABLE`
queues behind it, and every query arriving after that queues behind the
`ALTER`. The site stalls until the dump finishes.

### Restoring

Restoring is deliberately not automated. Decrypt with the offline private key,
and restore into a **new, empty** database first, never over the live one:

```bash
age -d -i backup-key.txt -o restore.dump <base>.dump.age
pg_restore --list restore.dump                     # read before you write
createdb -O appuser municipality_db_restore
psql -d municipality_db_restore -c 'DROP SCHEMA IF EXISTS public CASCADE'
pg_restore --no-owner --no-privileges --exit-on-error \
  -d municipality_db_restore restore.dump
```

**Then verify, do not assume (§5 of [AGENTS.md](../AGENTS.md)).** Compare every
count in `<base>.manifest.json` against the restored database. Only then decide
what to move back into production, and how. Usually one municipality, one
table, or a set of rows, because a whole-database swap discards every write
made since the dump was taken. The manifest carries these steps in its
`restoreOrder` field, because during a recovery the manifest is the file you
have to hand and this document may not be. Delete `restore.dump` afterwards: it
is the whole register in plaintext.

Archives taken before tenant migration `0048` (none from this pipeline; every
database is past it) do not restore with plain `pg_restore`: `search_compact`
called `search_normalize` unqualified. Convert to SQL, qualify the one call, and
load that instead:

```bash
pg_restore --no-owner --no-privileges -f restore.sql <archive>.dump
perl -0pi -e 's/(AS \$\$\s*\n\s*SELECT replace\()search_normalize\(/$1tenant_<slug>.search_normalize(/' restore.sql
psql "$TARGET" -c 'DROP SCHEMA IF EXISTS public CASCADE'
psql "$TARGET" -v ON_ERROR_STOP=1 -f restore.sql
rm -f restore.sql
```

---

## 6. Secrets

| Where | What |
| --- | --- |
| `apps/backend/.env` | Staging credentials. Gitignored. |
| `apps/backend/.env.staging` | Staging credentials. Gitignored. |
| GitHub → Environments → `db-staging` | `STAGING_DATABASE_URL`, `STAGING_DIRECT_URL` |
| GitHub → Environments → `db-production` | `PRODUCTION_DATABASE_URL`, `PRODUCTION_DIRECT_URL`, **plus** the two `STAGING_` ones: a production run migrates staging first and checks its history. **Plus** `BACKUP_AGE_PUBLIC_KEY`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the pre-migration backup (§5); the AWS keys belong in `db-production` only. Without them, a push with a migration pending stops before migrating. |
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
