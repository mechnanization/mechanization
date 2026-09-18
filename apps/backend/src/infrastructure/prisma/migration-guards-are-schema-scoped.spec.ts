import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every catalog lookup inside a migration names its schema. Enforced here,
 * because `IF NOT EXISTS` looks like idempotence and is not.
 *
 * ## The failure this exists to prevent
 *
 * The migrator runs each file once per municipality under
 * `SET LOCAL search_path TO "<schema>"`, so unqualified *DDL* is correct — one
 * file builds every tenant. The system catalogs do not follow search_path.
 * `pg_constraint` is database-wide, and a constraint name is per-schema, so:
 *
 *     IF NOT EXISTS (SELECT 1 FROM pg_constraint
 *                    WHERE conname = 'units_buildingId_fkey') THEN
 *
 * is true for the first municipality and false for every one after it — the
 * row it finds belongs to somebody else's schema. The `ALTER TABLE` is skipped
 * with no error, no warning, and a migration ledger that says "applied".
 *
 * Seven migrations were written this way before anyone noticed, and the second
 * municipality would have come up missing 22 constraints, including the
 * cascades under `unit_occupancies` — which is what billing reads. They are
 * immutable now (§3), so they are listed below and repaired by
 * `0050_constraints_missed_by_global_guards`.
 *
 * ## Why a test and not a review rule
 *
 * Because it cannot be seen. It produces no error on the machine where it is
 * written, no error in CI, and no error in staging — which has one tenant
 * schema. The first symptom is a wrong number in a municipality that onboarded
 * months later. A grep that runs in CI is the only thing that arrives in time.
 */

const MIGRATIONS_DIR = join(__dirname, 'tenant', 'migrations');

/**
 * Catalogs that are database-wide. Reading one of these to decide whether to
 * create something means asking a question about the whole database when the
 * answer needed is about one schema.
 */
const CATALOGS = [
  'pg_constraint',
  'pg_class',
  'pg_type',
  'pg_trigger',
  'pg_proc',
  'pg_indexes',
  'pg_matviews',
  'pg_views',
  'pg_tables',
  'information_schema.',
];

/** Any of these binds the lookup to the schema being migrated. */
const SCHEMA_FILTERS = [
  'current_schema',
  'nspname',
  'relnamespace',
  'connamespace',
  'typnamespace',
  'pronamespace',
  'schemaname',
  'table_schema',
];

/**
 * Written before the rule existed, and applied, so they cannot be edited.
 * `0050` adds what each of them skipped. Nothing may be added to this list —
 * a new entry means a new tenant onboards with a hole in it.
 */
const IMMUTABLE_EXCEPTIONS = new Set([
  '0014_collector_identity',
  '0025_inspector_commission_and_payouts',
  '0026_household_member_split',
  '0027_cases',
  '0029_case_resolution_link',
  '0030_building_census',
  '0037_landlord_link',
]);

/**
 * The parenthesised subqueries in one file, innermost first.
 *
 * A guard is `(SELECT 1 FROM pg_constraint … )`, so the unit to judge is the
 * balanced group — not the line, which puts the catalog and its filter on
 * different rows, and not the statement, which would let a `CURRENT_SCHEMA()`
 * anywhere in a 300-line DO block excuse a guard that never mentions it.
 */
function parenGroups(sql: string): string[] {
  const groups: string[] = [];
  const open: number[] = [];
  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === '(') open.push(i);
    else if (sql[i] === ')' && open.length > 0) groups.push(sql.slice(open.pop()!, i + 1));
  }
  return groups;
}

/** Comments explain the rule; they are not code and must not satisfy it. */
function withoutComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('Migration catalog guards are scoped to the schema being migrated', () => {
  const folders = migrationFolders();

  it('finds the migrations to check', () => {
    expect(folders.length).toBeGreaterThan(40);
  });

  it.each(folders)('%s', (folder) => {
    const sql = withoutComments(
      readFileSync(join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8'),
    ).toLowerCase();

    const unscoped = parenGroups(sql)
      .filter((group) => group.includes('select') && CATALOGS.some((c) => group.includes(c)))
      // Innermost first, so a nested group that *is* scoped does not drag its
      // parent in as a second, duplicate finding.
      .filter((group) => !SCHEMA_FILTERS.some((f) => group.includes(f)))
      .map((group) => group.replace(/\s+/g, ' ').slice(0, 120));

    if (IMMUTABLE_EXCEPTIONS.has(folder)) {
      // Pinned, not ignored: if one of these is ever repaired in place —
      // which §3 forbids — this says so instead of quietly passing.
      expect(unscoped.length).toBeGreaterThan(0);
      return;
    }

    expect(unscoped).toEqual([]);
  });
});
