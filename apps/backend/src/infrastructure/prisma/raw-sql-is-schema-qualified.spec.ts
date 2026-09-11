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

/**
 * The source with its comments blanked out, newlines preserved.
 *
 * The check below used to skip a match whose *line* started with `//`, `*` or
 * `/*`. That works for JSDoc and fails for the block-comment style used
 * throughout this codebase, where the prose lines inside a comment carry no
 * leading marker at all:
 *
 *     /* <- opens here
 *       A bare nextval('payment_receipt_seq') resolves through search_path.
 *     *\/
 *
 * — and that middle line is indistinguishable from code by its prefix. It came
 * up the moment this spec grew an offender whose name is worth *explaining* in
 * a comment: the explanation tripped the check it was describing.
 *
 * Replacing comment bodies with spaces rather than deleting them keeps every
 * offset and line number intact, so a real hit still reports its own line.
 */
function withoutComments(source: string): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Newlines survive so line numbers do.
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }

    out += source[i];
    i += 1;
  }

  return out;
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
      pattern: new RegExp(
        String.raw`\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM|COPY)\s+(?!\$\{)"?${table}"?\b`,
        'gi',
      ),
    }),
  );

  /*
    Two things that are not tables, and both shipped because this spec only
    looked for tables.

    `nextval('payment_receipt_seq')` — a sequence lives in the tenant schema
    exactly as a table does, and this one is created per schema by migration
    0017. Unqualified it resolves through `search_path`, so it can draw from
    another municipality's sequence, and the numbers it returns are printed on
    receipts handed to residents.

    `current_schema()` — reads the same session state, and was still keying
    `addUnit`'s advisory lock long after the rest of the codebase stopped
    trusting it. A lock whose key depends on a drifted connection is not a
    lock: two writers take different keys and the race it exists to prevent is
    back.

    Neither is a `FROM`, so neither was visible to the check above. Named
    individually rather than pattern-matched, because there are few enough to
    name and a named offender can say what to do instead.
  */
  const nonTableOffenders = [
    { what: "nextval('…') without its schema", pattern: /nextval\(\s*'(?!\$\{)/g },
    {
      what: 'current_schema() — interpolate tenantContext.schemaName instead',
      pattern: /current_schema\(\)/gi,
    },
  ];

  const files = sourceFiles(BACKEND_SRC);

  it('scans a plausible number of backend sources', () => {
    // A guard on the guard: a broken walk that found nothing would pass every
    // assertion below while checking nothing at all.
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((file) => [file.slice(BACKEND_SRC.length + 1), file]))(
    '%s',
    (_label, file) => {
      const original = readFileSync(file, 'utf8');

      // Cheap bail-out: only files that actually issue raw SQL can offend.
      if (!/\$(?:query|execute)Raw/.test(original)) return;

      const source = withoutComments(original);

      const found: string[] = [];

      /*
        The match has to sit inside raw SQL, not in prose.

        These files are heavily commented and several comments quote the very
        SQL they are warning about, so a scan of the raw text reports its own
        documentation. `withoutComments` removes that class of false positive
        outright — offsets are preserved, so the line quoted back below is read
        from the original and still reads as it does on disk.
      */
      const report = (what: string, index: number): void => {
        const lineStart = original.lastIndexOf('\n', index) + 1;
        const lineEnd = original.indexOf('\n', index);
        const line = original.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        found.push(`${what} — ${line.trim()}`);
      };

      for (const { what, pattern } of nonTableOffenders) {
        for (const match of source.matchAll(pattern)) report(what, match.index);
      }

      for (const { table, pattern } of offenders) {
        for (const match of source.matchAll(pattern)) report(table, match.index);
      }

      expect(found).toEqual([]);
    },
  );
});
