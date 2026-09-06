# CLAUDE.md

@AGENTS.md

The full rules are in [AGENTS.md](AGENTS.md), imported above so they are always
in context. What follows is the short version — if the import ever fails, these
are the ones that matter most.

## Non-negotiable

1. **`users` holds staff AND citizens**, split by the `kind` enum
   (`STAFF` | `CITIZEN`). Never infer what a table contains from its name —
   query `information_schema` and get the foreign-key graph before touching rows.

2. **Name the target.** `pnpm db:deploy:staging`, never bare
   `prisma migrate deploy` / `tenant:migrate-all`. `apps/backend/.env` is pinned
   to staging and must stay that way; `pnpm dev` writes to staging.

3. **Never edit an applied migration.** Fix forward. The tenant migrator tracks
   by folder name, so an edit silently diverges staging from production.

4. **Destructive DDL goes in its own later release.** Expand → backfill →
   contract. `--allow-destructive` asserts you verified the data is safe; it is
   never a way past an error.

5. **Citizen data never leaves staging** — not to production, not to a file, not
   to a log. When copying data: allowlist tables, filter at the SELECT, and
   assert zero citizens afterwards.

6. **A blocked action is an answer.** If a trigger, permission layer or
   protection rule stops you, report it — do not find another route to the same
   effect.

7. **Verify, then report.** Exit code 0 proves nothing. Reconnect and count.
   Say what failed or was skipped alongside what worked.

## Repo shape

- pnpm monorepo: `apps/backend` (NestJS), `apps/frontend` (Next.js),
  `packages/shared-schemas`.
- Multi-tenant by Postgres **schema**, not by column. No `tenantId` anywhere.
- Two Prisma schemas: registry (`public`) and tenant (replicated per
  municipality, hand-written SQL migrations applied by a custom migrator).
- Runbooks: [docs/database-environments.md](docs/database-environments.md) for
  environments and migrations, [docs/deploy-vercel.md](docs/deploy-vercel.md)
  for deployment.
