# Database environments

Two Supabase projects, three targets, and a set of checks whose only job is to
make "I ran it against the wrong one" impossible rather than unlikely.

| Target | Supabase project | Env file | Who runs it |
| --- | --- | --- | --- |
| `local` | `lzgbjcwtzqyrbeoolvdz` (staging) | `apps/backend/.env` | `pnpm dev` on a laptop |
| `staging` | `lzgbjcwtzqyrbeoolvdz` | `apps/backend/.env.staging` | GitHub Actions, on push to `develop` |
| `production` | `thbgwfbcqdougbjvgvyw` | `apps/backend/.env.production` | GitHub Actions, manual, with approval |

`local` and `staging` are the same database. There is no local Postgres —
`docker-compose.yml` runs Redis and nothing else — so "local" describes where
the *process* runs, not where the data lives. `pnpm dev` writes to staging.

The refs above are pinned in [`scripts/db/targets.mjs`](../scripts/db/targets.mjs).
Refs are not secrets; the passwords they pair with are, and those stay in
ignored dotenv files and GitHub Environment secrets.

---

## 1. The commands

```bash
pnpm db:check                 # validate every env file present. No network.
pnpm db:test                  # unit-test the guard itself
pnpm db:status:staging        # what is pending on staging, applies nothing
pnpm db:status:production     # same for production
pnpm db:deploy:staging        # apply
pnpm db:deploy:production     # apply, after typing the project ref
```

Every one of them names its target. There is deliberately no bare `db:deploy`
that reads ambient configuration and guesses.

Authoring a migration is unchanged:

```bash
pnpm db:migrate               # registry: prisma migrate dev --create-only
pnpm db:migrate:tenant        # tenant:  prisma migrate dev --create-only
```

---

## 2. What stops a mistake

Six checks, each one there because of a specific way this goes wrong.

**The env file must belong to the project the target is pinned to.** Both
connection strings and `SUPABASE_URL` are parsed, the project ref is extracted,
and a mismatch is a hard failure. Editing a dotenv file can no longer change
which database a command reaches — only naming a different target can.

**A non-production env file may not mention the production ref at all**, not
even in a comment. This catches the half-finished edit, where `DATABASE_URL` was
swapped but the service-role key below it was not.

**`pnpm dev` runs the check before it boots.** The moment someone pastes a
production connection string into `apps/backend/.env` — to read one row, to
reproduce one bug — the dev server stops starting instead of quietly attaching
the whole application to live data.

**Irreversible DDL blocks the deploy.** Pending migrations are scanned for
`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER COLUMN … TYPE` and `RENAME`.
Those refuse to run without `--allow-destructive`. Statements that merely take a
heavy lock — `SET NOT NULL`, a non-concurrent `CREATE INDEX` — print a warning
and continue.

**Production only accepts migrations staging has already applied.** The deploy
reads staging's migration history and refuses anything staging has not seen.
This is what turns "we have a staging environment" into "staging is
load-bearing".

**Production needs the ref typed out.** Interactively, you type it at a prompt;
in CI, `--confirm=<ref>` must match, so a command copied from the staging
runbook cannot fire at production.

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
    ↓  Actions: Deploy staging     (automatic)
  PR → main, merge                 ships code only — no SQL runs
    ↓  Actions: Deploy production  (manual, dry run first, then approved)
```

Merging to `main` deliberately does not migrate production. Shipping code and
rewriting a database of citizen records are different decisions, and a branch
protection rule is a poor place to conflate them.

### Deploying production

1. `pnpm db:status:production` locally, or run the workflow with **dry run**
   ticked. Read the list of migrations it prints.
2. Confirm a backup exists — see §5.
3. Actions → **Deploy production** → Run workflow. Type the ref, leave
   `dry_run` on for the first run, then run again with it off.
4. A reviewer approves the `production` environment.
5. Afterwards: `curl https://<api>/api/v1/health/ready` should return
   `{"status":"ready"}`.

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
| GitHub → Environments → `db-staging` | `STAGING_DATABASE_URL`, `STAGING_DIRECT_URL`, `STAGING_SUPABASE_URL`, `STAGING_SERVICE_ROLE_KEY` |
| GitHub → Environments → `db-production` | The same four, `PRODUCTION_`-prefixed, **plus** the four `STAGING_` ones (the promotion check reads staging's history), plus required reviewers |

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
