# Incidents the rules are made of

Last verified against the code: `develop@8742c5b`, 2026-10-03.

Each of these happened. They are here so the rules read as consequences rather
than opinions. They moved here from the old `AGENTS.md` §8 without changing
their substance. Each ends with a link to the rule it produced. Add an entry
when a broken rule costs something, and link it from the rule's home.

**1. `users` is not what it sounds like.** An agent was asked to copy "all users
but no citizens". Had it assumed `users` meant staff, it would have copied five
citizens' national ID numbers. The only defence was querying
`information_schema` and finding the `kind` discriminator.
→ [docs/database.md: Read before you infer](database.md#read-before-you-infer)

**2. Migration `0026` did expand, backfill and `DROP COLUMN` in one file.**
The data survived, because it was copied to new columns first, but rollback
did not: the previous build queries a column that no longer exists.
→ [docs/database.md: Migrations](database.md#migrations)

**3. Prisma quietly reloads `.env`.** It prints "Environment variables loaded
from .env" and layers that file over the environment you injected. It happened
to be harmless. The deploy now re-reads the target to prove where it wrote.
→ [CLAUDE.md: How to work here](../CLAUDE.md#how-to-work-here) (verify, then
report) and [docs/database.md: Name the target](database.md#name-the-target)

**4. The production tenant sync copied everything.** On 2026-09-05 a sync
script that discovered tables dynamically and applied no filter copied 5
citizens into production, against an explicit instruction: national ID, civil
record number, phone, and رقم مرجعي, which is a login credential. It also set
`session_replication_role = 'replica'`, writing straight through the
append-only audit guard. Its `TRUNCATE … CASCADE` ran in alphabetical order and
wiped the registrations it had just inserted, so the rows it reported copying
ended up at zero. It finished with "✓ Production database is ready and fully
populated!".
→ [docs/database.md: Moving data between environments](database.md#moving-data-between-environments)

**5. Preview deployments wrote to production.** Every Vercel variable was
scoped `[production, preview]`, so every pull-request preview read and wrote the
production database. Nothing in the repository could see it.
→ [docs/security.md: Configuration this repository cannot see](security.md#configuration-this-repository-cannot-see)

**6. A flaky test taught people to re-run CI.** A test asserted zero
collisions among 5,000 random values drawn from a 32⁶ space, which is false
about 1.2% of the time even for a *correct* generator. A gate that fails 1 run
in 85 trains everyone to press retry, including on the day it catches
something real. → [docs/code-quality.md: Rules](code-quality.md#rules) (rule 12)
and [CLAUDE.md: How to work here](../CLAUDE.md#how-to-work-here) (verify, then
report)

**7. A guard that enforced nothing.** The env schema demanded two SMS
provider keys in production, but no provider was ever implemented and the send
function throws unconditionally. The check enforced a boot failure, not a
working login path. A control that cannot fail for the right reason is worse
than none, because it looks like coverage.
→ [docs/code-quality.md: Rules](code-quality.md#rules) (rule 12)

**8. The local env file pointed at staging.** Until 2026-09-25,
`apps/backend/.env` was pinned to staging, so `pnpm dev` and every local
migration run wrote to it. That is how six migrations from unmerged branches
landed on staging. → [docs/database.md: Name the target](database.md#name-the-target)
