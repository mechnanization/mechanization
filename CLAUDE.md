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

## graphify

This project has a knowledge graph in `graphify-out/` (code via AST plus the planning docs in `docs/`). It is committed to git. Use it whenever it gets you to the answer faster than grepping and reading files. That is usually the case when you don't yet know where something lives.

**Use the graph first** when:
- you need to find where a concept lives and don't know the file yet
- the question crosses layers (frontend ↔ backend ↔ DB ↔ `docs/` spec), e.g. "how does occupancy reach billing"
- you need the blast radius of a change ("what touches `UnitOccupancy`?")
- you want an architecture overview, or you are orienting in an unfamiliar module

Commands (about 1–2 seconds; keep `--budget` modest so the output stays small):
- `graphify query "<question>" --budget 1500` gives a scoped subgraph for a question
- `graphify path "<A>" "<B>"` shows how two concepts connect
- `graphify explain "<symbol or concept>"` gives one node and its neighbours
- `graphify-out/GRAPH_REPORT.md` covers the whole architecture (community hubs, god nodes). Read it only for a broad review.

**Skip the graph** when:
- the file or symbol is already known (the user named it, it is the IDE selection, or you just found it)
- a single exact-string search answers it (an error message, a translation key, a specific identifier)
- you are editing lines you have already located

**Treat results as leads, not facts.** The graph is a snapshot and can lag behind the working tree. Open the source at the `src=… loc=…` it gives before you edit or cite anything. If a result points at a file or symbol that no longer exists, run `graphify update .`. It is AST-only and free, but it rewrites the tracked `graphify-out/graph.json`. Mention that in your reply, and keep it out of unrelated commits.

When spawning a subagent to explore code, tell it the graph exists and pass along these rules.
