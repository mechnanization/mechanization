# AGENTS.md

Last verified against the code: `develop@8742c5b`, 2026-10-03.

This file is for agents that read `AGENTS.md` (Codex, Cursor, Copilot and
others). It holds no rules of its own. The rules bind every agent and every
person working in this repository, and they live in one place:

1. **Read [CLAUDE.md](CLAUDE.md) first.** It covers how to work here, the repo
   map, the commands, the non-negotiables, the definition of done, and which
   doc to read for which task.
2. Then read the guide for the area you are touching:
   [apps/backend/CLAUDE.md](apps/backend/CLAUDE.md),
   [apps/frontend/CLAUDE.md](apps/frontend/CLAUDE.md) or
   [packages/shared-schemas/CLAUDE.md](packages/shared-schemas/CLAUDE.md).
3. Before you touch a database, read [docs/database.md](docs/database.md).
   Before you touch anything under `apps/frontend`, read
   [docs/ui-ux-standards.md](docs/ui-ux-standards.md).

Do not copy rules into this file. Change the canonical doc and link to it.

## Where the old sections went

Code comments and applied migrations still cite sections of the rulebook this
file used to hold (for example "AGENTS.md §4"). Applied migrations are never
edited, so those citations stay as they are. This map resolves them:

| Old section | Now |
|---|---|
| §1 Read before you infer | [docs/database.md: Read before you infer](docs/database.md#read-before-you-infer) |
| §2 Name the target | [docs/database.md: Name the target](docs/database.md#name-the-target) |
| §3 Migrations | [docs/database.md: Migrations](docs/database.md#migrations) |
| §4 Moving data between environments | [docs/database.md: Moving data between environments](docs/database.md#moving-data-between-environments) |
| §5 Verify, then report | [CLAUDE.md: How to work here](CLAUDE.md#how-to-work-here); for databases, reconnect-and-count in [docs/database.md: Name the target](docs/database.md#name-the-target) and hand data corrections in [docs/database.md: Moving data between environments](docs/database.md#moving-data-between-environments) |
| §6 When you are blocked or uncertain | [CLAUDE.md: How to work here](CLAUDE.md#how-to-work-here); a refusing trigger in [docs/database.md: Append-only tables](docs/database.md#append-only-tables) |
| §7 Configuration this repository cannot see | [docs/security.md: Configuration this repository cannot see](docs/security.md#configuration-this-repository-cannot-see) |
| §8 Incidents | [docs/incidents.md](docs/incidents.md) (8.1 to 8.7 are entries 1 to 7) |
| §9 The interface | [docs/ui-ux-standards.md](docs/ui-ux-standards.md) |
