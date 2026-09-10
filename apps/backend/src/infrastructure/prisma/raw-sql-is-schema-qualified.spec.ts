import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every raw query names its schema. Enforced here, because nothing else can.
 *
 * ## The failure this exists to prevent
 *
 * Prisma's model queries are schema-qualified by the client — `?schema=` makes
 * the generated SQL say `"tenant_x"."buildings"`. `$queryRaw` is not: Prisma
 * sends raw SQL through untouched, so `FROM damage_assessments` resolves
 * through the connection's `search_path`.
 *
 * That is session state, and this application does not own the session. It
 * reaches Supabase through the **transaction pooler** (`DATABASE_URL`, port
 * 6543, `pgbouncer=true`), where statements are handed to whichever server
 * connection is free and session settings are explicitly not guaranteed to
 * travel with them.
 *
 * On 2026-09-10 at 08:18:23Z, on staging, one request produced:
 *
 * > `Raw query failed. Code: 42P01. Message: relation "damage_assessments"
 * > does not exist`
 *
 * — on a table that exists, from a connection that had just served a dozen
 * successful queries, with no other Postgres activity in a four-minute window
 * around it. Every Prisma model query in the same request succeeded. It cannot
 * be reproduced on demand, it fails a whole page rather than a row, and it will
 * happen again under load.
 *
 * ## Why a test and not a code review rule
 *
 * Because the correct version and the broken version look almost identical, the
 * broken one works on a developer's machine and in every test that pins one
 * schema per connection, and the person adding the next raw query will not have
 * read `tenant-schema-ref.ts`. A grep that runs in CI will.
 *
 * ## What it checks
 *
 * The table list is read from `schema.prisma`'s own `@@map` names, so a table
 * added tomorrow is covered without touching this file. Anything after `FROM`
 * or `JOIN` that is one of those names, and is not preceded by a `${…}`
 * interpolation, fails.
 *
 * CTE names (`WITH owned_parcels AS …`), set-returning functions
 * (`generate_series`) and subqueries are untouched — they are not tables and
 * have no schema.
 */

const BACKEND_SRC = join(__dirname, '..', '..');
const PRISMA_SCHEMA = join(__dirname, 'tenant', 'schema.prisma');

/** Every physical table name the tenant schema declares. */
function tenantTableNames(): string[] {
  const schema = readFileSync(PRISMA_SCHEMA, 'utf8');
  const names = [...schema.matchAll(/@@map\("([a-z_][a-z0-9_]*)"\)/g)].map((m) => m[1]!);

  /*
    Plus the migrations ledger, which has no Prisma model.

    It is written by the hand-rolled migrator and read by `BackupService`, so it
    is exactly the kind of table that has no model to remind anyone it exists.
  */
  names.push('_tenant_migrations');

  expect(names.length).toBeGreaterThan(15);
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // The generated client is Prisma's own output, not ours to police.
      return entry === 'generated' || entry === 'node_modules' ? [] : sourceFiles(full);
    }
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('raw SQL is schema-qualified', () => {
  const tables = tenantTableNames();

  /*
    `FROM`/`JOIN`, then optional whitespace, then the table name — with a
    negative lookbehind for the `}` that closes a `${…}` interpolation and for
    the `.` of an already-qualified name.

    Quoting is optional on both sides because both forms appear in this
    codebase: `FROM "parcels"` and `FROM registrations` are equally broken and
    equally caught.
  */
  const offenders = tables.map(
    (table) => ({
      table,
      pattern: new RegExp(String.raw`\b(?:FROM|JOIN)\s+(?!\$\{)"?${table}"?\b`, 'g'),
    }),
  );

  const files = sourceFiles(BACKEND_SRC);

  it('scans a plausible number of backend sources', () => {
    // A guard on the guard: a broken walk that found nothing would pass every
    // assertion below while checking nothing at all.
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((file) => [file.slice(BACKEND_SRC.length + 1), file]))(
    '%s',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');

      // Cheap bail-out: only files that actually issue raw SQL can offend.
      if (!/\$(?:query|execute)Raw/.test(source)) return;

      const found: string[] = [];
      for (const { table, pattern } of offenders) {
        for (const match of source.matchAll(pattern)) {
          /*
            The match has to sit inside raw SQL, not in prose.

            These files are heavily commented and several comments quote the
            SQL they describe. Requiring a backtick-delimited template or a
            `$queryRawUnsafe` string between the nearest raw-query call and the
            match would need a parser; checking that the line is not a comment
            is enough and has no false negatives that matter — a commented-out
            query does not run.
          */
          const lineStart = source.lastIndexOf('\n', match.index) + 1;
          const line = source.slice(lineStart, source.indexOf('\n', match.index));
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;

          found.push(`${table} — ${line.trim()}`);
        }
      }

      expect(found).toEqual([]);
    },
  );
});
