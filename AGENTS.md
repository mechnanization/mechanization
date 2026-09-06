# Working on this repository as an AI agent

This file binds every AI coding agent — Claude Code, Cursor, Copilot, anything
else — working in this repository. `CLAUDE.md` imports it.

Most of it is about the database, because that is where this codebase can do
harm that cannot be undone by editing a file.

## What is at stake

This is a municipal registration system for Lebanese municipalities. The tenant
schemas hold national ID numbers, civil record numbers, home addresses, phone
numbers, marital status, **residency and refugee status**, household
composition, and scanned identity documents.

A leak here is not a bug report. Refugee status attached to a home address is
information people have been harmed with. Treat every citizen row as though the
person it describes is standing behind you.

Two structural facts you must hold in your head:

- **Tenancy is by Postgres schema, not by column.** There is no `tenantId`
  anywhere. `tenant_albazourieh`, `tenant_zahle`, one schema each. A query
  cannot read another municipality's rows because the connection is not pointed
  at that schema — not because a `WHERE` clause remembered to filter.
- **`users` holds both staff and citizens**, discriminated by the `kind` enum
  (`STAFF` | `CITIZEN`). The table name tells you nothing. This has already
  caused one incident (§7.1).

---

## 1. Read before you infer

**Never conclude what a table contains from its name, from a Prisma model, or
from a previous session.** Query the database.

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'tenant_<slug>' and table_name = '<table>';
```

- A Prisma model can have drifted from the database. Tenant migrations here are
  hand-written SQL applied by a custom migrator — Prisma never validates them
  against `schema.prisma`.
- Before touching rows, get the **foreign-key graph**, not just the columns. A
  table with no personal data of its own still exposes citizens if its rows
  point at them. `building_units` sounds structural; it hangs off
  `property_entries → registrations → users`.
- Facts go stale inside a single session. If you read a count twenty minutes and
  several actions ago, read it again before acting on it.

## 2. Name the target, every time

Every environment is pinned by Supabase project ref in
[`scripts/db/targets.mjs`](scripts/db/targets.mjs), and the guard refuses any
dotenv file whose connection strings name a different project.

```bash
pnpm db:check                 # validate env files, no network
pnpm db:status:staging        # what is pending, applies nothing
pnpm db:deploy:staging        # apply
pnpm db:status:production
```

- **Never** run `prisma migrate deploy`, `prisma migrate dev`, or
  `tenant:migrate-all` directly. They read whatever dotenv file happens to be on
  disk and tell you nothing about where they are pointed. The wrappers exist
  because that is one careless `git stash` away from rewriting live records.
- `apps/backend/.env` is pinned to **staging**. There is no local Postgres —
  `pnpm dev` reads and writes staging. Do not "temporarily" point it at
  production to check one row.
- There is deliberately no `.env.production` on developer machines. Production
  migrations run from the manual GitHub Actions workflow behind a required
  reviewer. If you think you need to run one locally, you need to ask, not
  improvise.

## 3. Migrations

**Applied migrations are immutable.** Once a migration has run in *any*
environment, editing its SQL is forbidden. The registry uses Prisma checksums;
the tenant migrator tracks by folder name, so an edited tenant migration will
never re-run and staging and production will silently diverge. Fix forward with
a new migration, always.

**Destructive DDL is never in the same migration as the code that needs it.**
`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER COLUMN … TYPE` and `RENAME` are
one-way doors. Use expand → migrate → contract across separate releases:

1. **Expand** — add the new column, nullable. Nothing reads it. Nothing breaks.
2. **Migrate** — backfill it; deploy code that writes both and reads the new one
   with a fallback. A rollback at this point is just a redeploy.
3. **Contract** — a release later, after it has been watched in production, drop
   the old column.

`pnpm db:deploy:*` blocks destructive DDL. `--allow-destructive` is a statement
that you have verified the data is preserved or expendable — **never a way past
an error message.** If you find yourself adding it to make a command work, stop.

**Tenant migrations run once per municipality**, sequentially, against live
schemas. `CREATE INDEX` there wants `CONCURRENTLY` — but note the migrator wraps
each migration in a transaction and `CONCURRENTLY` cannot run inside one, so
such an index needs its own migration and an adjusted wrapper. That is a real
constraint, not a formality.

**Production only ever receives migrations staging has already applied.** The
deploy enforces it by reading staging's history. Do not pass
`--skip-promotion-check` without writing down why.

## 4. Moving data between environments

The rules that have already been broken once (§7.4):

- **Citizen data never leaves staging.** Not to production, not to a local
  machine, not into a log, not into a file "for backup". If you are copying
  data and cannot state which rows are citizens, you are not ready to copy.
- **Allowlist, never discover.** Enumerate the tables you intend to copy and
  say why for each. Dynamic table discovery means the next migration silently
  adds a table to the copy set. See `TABLE_POLICY` in
  [`scripts/db/sync-production-tenant.mjs`](scripts/db/sync-production-tenant.mjs).
- **Filter at the source, not afterwards.** `WHERE kind = 'STAFF'` on the SELECT.
  Copying everything and deleting later means the data existed in production.
- **Never `SET session_replication_role = 'replica'`.** It disables every
  trigger and foreign-key check on the connection, including the append-only
  guard on `audit_log_entries`. A data move that only works with the database's
  integrity rules switched off is telling you something.
- **Never `TRUNCATE … CASCADE` in a loop.** Cascade order is not your loop order,
  and it will delete rows a previous iteration just inserted.
- **Direction is one-way:** local → staging → production. Never the reverse.

## 5. Verify, then report

**A command exiting 0 is not evidence.** It says a command ran, not that it did
what you meant, nor which database it did it to.

- After a write, **reconnect and count**. `pnpm db:deploy:*` does this — it
  re-reads the target's migration table after applying, because Prisma
  autoloads `apps/backend/.env` on top of the environment handed to it and
  "dotenv happens not to overwrite" is a library default, not a guarantee.
- Before a delete or update: count first, **state the expected number**, run it
  in a transaction, count again, and roll back if the numbers disagree.
- Verify the thing that matters, not the thing that is easy. The sync in §7.4
  printed "ready and fully populated" and never once asked how many citizens it
  had copied.
- **Report what happened, including the parts that did not work.** If a step was
  skipped, blocked, or partially completed, say so in the same breath as the
  successes. Never describe a plan as though it were an outcome.

## 6. When you are blocked or uncertain

- **A refused action is a signal, not an obstacle.** If a permission layer, a
  database trigger, or a branch protection rule stops you, do not look for
  another route to the same effect. Report it and let a human decide. Reaching
  for `TRUNCATE` because `DELETE` hit an append-only trigger is circumventing a
  control someone installed on purpose.
- **Ask when the answer changes what you would do**, and only then. "Is this
  table citizen data?" is answerable by querying — go and answer it. "Do you
  want the old project's data migrated?" is not — ask.
- **Stop at the edge of what was asked.** Fixing an unrelated bug you noticed is
  a sentence in your report, not a commit, unless it blocks the task.
- Do not invent data. If a value must be real — a project ref, a password, a
  connection host — read it from the system of record or ask. A plausible
  hostname that does not exist wastes an hour.

## 7. Configuration this repository cannot see

The largest hole is not in the code. `pnpm db:check` cannot see Vercel or GitHub.

- **Vercel environment variables** decide which database real traffic reaches.
  Every variable naming a database, bucket or signing secret must be scoped to
  **one** environment. See §6 of
  [`docs/database-environments.md`](docs/database-environments.md).
- **GitHub Environment secrets** hold the credentials CI deploys with.
- After changing either, verify by reading it back — and remember env vars are
  baked in at build time, so a running deployment holds the *old* values until
  it is rebuilt.

---

## 8. Incidents this file is made of

Each of these happened. They are here so the rules read as consequences rather
than opinions.

**8.1 — `users` is not what it sounds like.** An agent asked to copy "all users
but no citizens" that assumed `users` meant staff would have copied five
citizens' national ID numbers. The only defence was querying
`information_schema` and finding the `kind` discriminator. → §1

**8.2 — Migration `0026` did expand, backfill and `DROP COLUMN` in one file.**
The data survived (copied to new columns first) but rollback did not: the
previous build queries a column that no longer exists. → §3

**8.3 — Prisma quietly reloads `.env`.** It prints "Environment variables loaded
from .env" and layers that file over the environment you injected. It happened
to be harmless. The deploy now re-reads the target to prove it. → §5

**8.4 — The production tenant sync copied everything.** On 2026-09-05 a sync
script that discovered tables dynamically and applied no filter copied 5
citizens (national ID, civil record number, phone, and رقم مرجعي — which is a
login credential) into production, against an explicit instruction. It also set
`session_replication_role = 'replica'`, writing through the append-only audit
guard; and `TRUNCATE … CASCADE` in alphabetical order wiped the registrations it
had just inserted, so it reported copying rows that ended up at zero. It
finished with "✓ Production database is ready and fully populated!". → §4, §5

**8.5 — Preview deployments wrote to production.** Every Vercel variable was
scoped `[production, preview]`, so every pull-request preview read and wrote the
production database. Nothing in the repository could see it. → §7

**8.6 — A flaky test taught people to re-run CI.** A test asserted zero
collisions among 5,000 random values drawn from a 32⁶ space — false ~1.2% of the
time for a *correct* generator. A gate that fails 1 run in 85 trains everyone to
press retry, including on the day it catches something real. → §5

**8.7 — A guard that enforced nothing.** The env schema demanded two SMS
provider keys in production. No provider was ever implemented; the send function
throws unconditionally. The check enforced a boot failure, not a working login
path. A control that cannot fail for the right reason is worse than none — it
looks like coverage. → §6
