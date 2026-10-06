# CLAUDE.md — Mechanization (منظومة المكننة البلدية)

Last verified against the code: `develop@8742c5b`, 2026-10-03. Code wins: where a
doc and the code disagree, the code is the fact and the doc is the bug.

A multi-tenant registration system for Lebanese municipalities: the citizen
register, the building and unit census, the cadastre map, fees and payments.
The tenant schemas hold national ID numbers, home addresses, phone numbers, and
residency and refugee status. A leak here harms people, so treat every citizen
row as if the person it describes is standing behind you.

Two structural facts you must hold in your head:

- **Tenancy is by Postgres schema, not by column.** Each municipality has its own
  `tenant_<slug>` schema, and there is no `tenantId` anywhere. Isolation comes
  from which schema the connection points at.
- **`users` holds staff AND citizens**, split by the `kind` enum
  (`STAFF` | `CITIZEN`). Table names tell you nothing; query them.

This file is the hub. Every rule has one home, and this file links to it.
[AGENTS.md](AGENTS.md) points other agents here.

## How to work here

- **Never invent names or values.** Before you use a component, token, class,
  env var, route, script, table, column, enum value or translation key, grep
  for it. If it does not exist, say so and add it properly, in its canonical
  home. A value that must be real (a host, a port, a project ref, a password)
  comes from the system of record or the user, never from a plausible guess.
- **Cite, don't recall.** Your memory of a library API is a guess. These are the
  majors in use: Next 15, React 18, NestJS 10, Prisma 5, Tailwind 3,
  tailwind-merge 3, zod 3, next-intl 4, TanStack Query 5. Training data is full
  of Prisma 7, Tailwind 4, React 19 and zod 4. Read the types or source in
  `node_modules` before you rely on an API.
- **Read before you infer.** A Prisma model can drift from the database, and a
  name can mislead. Rules: [docs/database.md](docs/database.md#read-before-you-infer).
- **Facts go stale inside a session.** Teammates push. Re-run `git status` and
  `git log` before you trust something you read earlier, and re-count before
  you act on a number.
- **Undecided means undecided.** Items marked **Undecided** are product or
  architecture decisions for a human. Ask; do not settle them in code.
  Long-running ones live in [docs/open-decisions.md](docs/open-decisions.md).
  Ask only when the answer changes what you would do; what a query can answer
  ("is this table citizen data?"), answer by querying.
- **Stay in scope.** An unrelated problem is a sentence in your report, not a
  silent fix.
- **A blocked action is an answer.** If a permission layer, a trigger or a
  branch protection stops you, report it; never route around it.
- **Verify, then report.** Exit code 0 proves only that a command ran.
  Reconnect and count, and verify the thing that matters, not the thing that
  is easy: incident 4 printed "ready" and never counted citizens. Say what
  failed or was skipped alongside what worked, and never describe a plan as
  an outcome.
- **Docs are part of the change.** See [Keeping the docs true](#keeping-the-docs-true).
- **Orient with the graph, act on the source.** When you don't know where
  something lives or a question crosses layers, use `graphify query "<q>" --budget 1500`,
  `graphify path "<A>" "<B>"` or `graphify explain "<symbol>"`, then open the file
  before you cite or edit. A stale result means `graphify update .`, which
  rewrites the tracked `graphify-out/graph.json`: keep it out of unrelated
  commits. Pass these rules to any subagent you spawn.

## Repo map

| Path | What it is | Guide |
|---|---|---|
| `apps/backend` | NestJS 10 API: domain, application, infrastructure, presentation. Runs on AWS Lightsail (nginx → pm2), deployed by `deploy-backend.yml` on every push to `main` | [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md) |
| `apps/frontend` | Next.js 15 app router, staff dashboard and citizen portal, RTL-first. Runs on Vercel, configured outside this repo | [apps/frontend/CLAUDE.md](apps/frontend/CLAUDE.md) |
| `packages/shared-schemas` | zod schemas, enums and labels shared by both apps (consumed from `dist/`) | [packages/shared-schemas/CLAUDE.md](packages/shared-schemas/CLAUDE.md) |
| `apps/backend/src/infrastructure/prisma` | Registry schema (`public`) and tenant schema, plus hand-written tenant SQL migrations | [docs/database.md](docs/database.md) |
| `scripts/db` | Target-pinned migrate, check, backup and restore tooling | [docs/database-environments.md](docs/database-environments.md) |
| `.github/workflows` | CI, staging and production migrations, backend deploy to Lightsail | [docs/database-environments.md](docs/database-environments.md) |
| `docs/`, `graphify-out/` | Rulebooks, runbooks and feature plans; the generated knowledge graph | [Read before you start](#read-before-you-start) |

## Commands

Every command below is a `package.json` script. Run them from the repo root.

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Build shared schemas (consumers read `dist/`) | `pnpm --filter @mechanization/shared-schemas build` |
| Generate both Prisma clients | `pnpm db:generate` |
| Local DB + Redis + both apps | `pnpm start` (Docker required) |
| Both apps against the local DB | `pnpm dev` |
| Lint, typecheck | `pnpm lint`, `pnpm typecheck` |
| Tests: backend (DB suites skip without `TEST_DATABASE_URL`), frontend, DB tooling | `pnpm --filter @mechanization/backend test`, `pnpm --filter @mechanization/frontend test`, `pnpm db:test` |
| Production build check without touching `.next` | `pnpm build:check` |
| Env files and targets, no network | `pnpm db:check` |
| Pending migrations (`local`, `staging`, `production`) | `pnpm db:status:<target>` |
| Apply migrations | `pnpm db:deploy:local`; `pnpm db:deploy:staging` only with a temporary `.env.staging` and a tunnel; production runs only in CI |
| Seed the local DB (synthetic data only) | `pnpm db:seed`, `pnpm db:seed:census` |

## Read before you start

| Task | Read first |
|---|---|
| Any backend change; a new endpoint | [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md), then the endpoint checklist in [docs/security.md](docs/security.md#checklists) |
| Any frontend change, or reviewing one | [apps/frontend/CLAUDE.md](apps/frontend/CLAUDE.md) and [docs/ui-ux-standards.md](docs/ui-ux-standards.md) (binding) |
| Colours, type, spacing, motion, tokens | [DESIGN.md](DESIGN.md), then [docs/ui-ux-standards.md](docs/ui-ux-standards.md) §4 |
| Schema, migration, raw SQL, anything that reads or writes a database | [docs/database.md](docs/database.md) |
| Environments, env files, backups, the migration pipeline | [docs/database-environments.md](docs/database-environments.md) |
| Shared enums, schemas or labels | [packages/shared-schemas/CLAUDE.md](packages/shared-schemas/CLAUDE.md) |
| Auth, roles, tokens, uploads, logging, headers, secrets | [docs/security.md](docs/security.md) |
| Touching a file that carries known debt | [docs/code-quality.md](docs/code-quality.md) |
| Something behaves strangely | [docs/gotchas.md](docs/gotchas.md) |
| Why a rule exists | [docs/incidents.md](docs/incidents.md) |
| Frontend deployment (Vercel) | [docs/deploy-vercel.md](docs/deploy-vercel.md) |
| Money: wallets, income, expenses, transfers, the daily count (الخزينة) | [docs/finance.md](docs/finance.md) |
| Buildings, units, numbering, war damage; duplicate citizens and «دمج ملفين» | [docs/building-census-plan.md](docs/building-census-plan.md); [docs/citizen-duplicates.md](docs/citizen-duplicates.md) |
| Open product and legal decisions | [docs/open-decisions.md](docs/open-decisions.md) |
| Who the users are, the staff roles, what the product does | [PRODUCT.md](PRODUCT.md) |
| First-time setup, running the apps, onboarding a municipality | [README.md](README.md) |
| An old "AGENTS.md §N" citation in a comment or migration | the section map in [AGENTS.md](AGENTS.md) |

## Non-negotiables

**Data and databases**: details in [docs/database.md](docs/database.md).
1. Name the target: `pnpm db:deploy:staging`, never `prisma migrate deploy`,
   `prisma migrate dev` or `tenant:migrate-all` ([why](docs/database.md#name-the-target)).
   `apps/backend/.env` stays pinned to the local Docker database
   (`municipality_db_local`, `127.0.0.1:5434`), and the local database holds
   seeded data only.
2. Never edit an applied migration. Fix forward with a new one.
3. Destructive DDL goes in its own later release: expand, backfill, contract.
   `--allow-destructive` asserts the data is safe. It is never a way past an error.
4. Citizen data never leaves staging or production: not to another
   environment, a laptop, a file or a log. Allowlist tables, filter at the
   SELECT, and assert zero citizens afterwards.
5. A push to `main` migrates production. A migration merged to `main` must be
   additive, and it ships in its own PR before the code that needs it.

**Security**: details in [docs/security.md](docs/security.md).
6. Every route is authenticated unless it is marked `@Public()`, and declares
   who may call it. Validate every body with a shared zod schema
   (`ZodValidationPipe`), every id with `ParseUUIDPipe`, and every query value
   with a schema or the `query-params.ts` helpers.
7. Never log or send to Sentry a secret, a token, a رقم مرجعي or citizen PII.
   Secrets come from validated config, never from code.

**Backend**: details in [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md).
8. Dependencies point inward: presentation → application → domain. Data access
   goes through `TenantContextService`, and multi-step writes through
   `runInTenantTransaction`. Domain errors carry a stable code and are mapped
   to HTTP in one filter.

**Frontend**: details in [docs/ui-ux-standards.md](docs/ui-ux-standards.md).
9. Tokens only, shared primitives only, and no native control where the kit
   has one. Both locales are complete, new copy goes in next-intl messages,
   and the copy matches what the code does.

## Definition of done

- `pnpm typecheck` passes, and so does `pnpm lint` (warnings are allowed, errors are not).
- The tests of every package you touched pass, against the same baseline as
  before. If you changed `scripts/db`, `pnpm db:test` passes too. If you changed
  `packages/shared-schemas`, rebuild it before testing its consumers.
- A UI change meets the pre-merge checklist in
  [docs/ui-ux-standards.md](docs/ui-ux-standards.md) §16.
- A migration was applied with `pnpm db:deploy:local`, and its integration
  suites ran on a throwaway Postgres 17.
- A new test or guard can fail only for the right reason
  ([docs/code-quality.md](docs/code-quality.md#rules), rule 12).
- Docs are updated per the table below, and the "Last verified" lines are bumped.
- Your report says what ran, what failed, and what was skipped.

## Keeping the docs true

When a change matches a row, update the listed docs and their "Last verified"
line in the same change. Rows with no code path are binding too. The Stop hook
`.claude/hooks/require-doc-updates.mjs` (registered in `.claude/settings.json`)
parses **this table**, so keep the globs in backticks and the docs as links. If
`git status` shows code matching a row and none of its docs changed, the hook
blocks the stop once: update the docs, or say in one line why none is affected.
Docs, tests, lockfiles and generated files never trigger it.

| When you change | Code paths | Update |
|---|---|---|
| A route, controller, guard, decorator, filter, middleware, config or bootstrap | `apps/backend/src/presentation/**` | [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md), [docs/security.md](docs/security.md) |
| Module wiring: a service, job or adapter added or removed | `apps/backend/src/app.module.ts`, `apps/backend/src/*/*.module.ts` | [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md) |
| Tenant context, transactions, password/TOTP/token adapters | `apps/backend/src/infrastructure/context/**`, `apps/backend/src/infrastructure/security/**` | [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md), [docs/security.md](docs/security.md) |
| A domain error class or error code | `apps/backend/src/domain/errors/**`, `apps/backend/src/application/common/exceptions/**` | [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md) |
| Prisma schema, a migration, the migrator | `apps/backend/src/infrastructure/prisma/**` | [docs/database.md](docs/database.md) |
| DB tooling, targets, backups | `scripts/db/**` | [docs/database.md](docs/database.md), [docs/database-environments.md](docs/database-environments.md) |
| A shared schema, enum or label | `packages/shared-schemas/src/**` | [packages/shared-schemas/CLAUDE.md](packages/shared-schemas/CLAUDE.md) |
| A UI primitive | `apps/frontend/components/ui/**` | [docs/ui-ux-standards.md](docs/ui-ux-standards.md), [apps/frontend/CLAUDE.md](apps/frontend/CLAUDE.md) |
| A design token or the theme | `apps/frontend/app/globals.css`, `apps/frontend/tailwind.config.ts` | [DESIGN.md](DESIGN.md), [docs/ui-ux-standards.md](docs/ui-ux-standards.md) |
| Frontend shell: middleware, Next config, i18n, session, API client, offline store, service worker, Sentry | `apps/frontend/middleware.ts`, `apps/frontend/next.config.mjs`, `apps/frontend/i18n/**`, `apps/frontend/lib/{api-client,session,use-staff-session,use-staff-query,sentry-redaction,sentry-options,offline-db,offline-sync}.ts`, `apps/frontend/public/sw.js`, `apps/frontend/instrumentation*.ts`, `apps/frontend/sentry.*.config.ts` | [apps/frontend/CLAUDE.md](apps/frontend/CLAUDE.md), [docs/security.md](docs/security.md) |
| A backend script: seed, provision, staff, reissue, the tenant migrator loop | `apps/backend/src/scripts/**` | [docs/database.md](docs/database.md), [docs/database-environments.md](docs/database-environments.md), [README.md](README.md) |
| Vercel project config | `apps/*/vercel.json` | [docs/deploy-vercel.md](docs/deploy-vercel.md) |
| A package script, workspace or toolchain config | `package.json`, `apps/*/package.json`, `packages/*/package.json`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `tsconfig.base.json`, `docker-compose.yml`, `**/Dockerfile`, `.dockerignore` | [CLAUDE.md](CLAUDE.md), [README.md](README.md), [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md), [apps/frontend/CLAUDE.md](apps/frontend/CLAUDE.md), [packages/shared-schemas/CLAUDE.md](packages/shared-schemas/CLAUDE.md) |
| A CI or deploy workflow | `.github/workflows/**` | [docs/database-environments.md](docs/database-environments.md), [CLAUDE.md](CLAUDE.md) |
| The Stop hook or project settings | `.claude/hooks/**`, `.claude/settings.json` | [CLAUDE.md](CLAUDE.md) |
| A security gap fixed or found | — | [docs/security.md](docs/security.md): remove or add its row in the gaps table |
| A debt item fixed or found | — | [docs/code-quality.md](docs/code-quality.md), or [docs/ui-ux-standards.md](docs/ui-ux-standards.md) §17 for UI |
| A new trap found | — | [docs/gotchas.md](docs/gotchas.md) |
| The treasury: wallets, ledger, vouchers, payment hooks | `apps/backend/src/application/features/treasury/**` | [docs/finance.md](docs/finance.md), [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md) |
| A staff role, a user kind, or a user-facing capability added or removed | — | [PRODUCT.md](PRODUCT.md) |
| A canonical doc or heading renamed or moved | — | the section map in [AGENTS.md](AGENTS.md), and every link to it |
| A rule broken in a way that cost something | — | [docs/incidents.md](docs/incidents.md) |
| A new doc | — | the routing table above and this table |

## Git

- Branch from `develop`: `feat/<topic>`, `fix/<topic>`, `refactor/<topic>`,
  `docs/<topic>`, `chore/<topic>`. A migration gets its own
  `chore/migration-NNNN` PR, holding the SQL and `schema.prisma`, merged
  before the feature PR. Details: [docs/database.md](docs/database.md#migrations).
- PRs target `develop`. A release is a PR from `develop` to `main`, and it needs
  one human approval. Pushing to `main` migrates production and then deploys
  the API.
- Commit messages follow Conventional Commits with a scope:
  `fix(landlord-links): …`, `feat(cases): …`, `chore(db): …`. Cite rule IDs
  (`COL-4`, `PRIM-3`) when a commit applies one.
- Commit or push only when asked. Never skip hooks, never force-push a shared
  branch, and never commit `.env*`, keys, dumps or backups.
- `git status` shows only the files you meant to change.
