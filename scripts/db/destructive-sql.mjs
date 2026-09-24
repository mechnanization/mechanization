/**
 * What in a pending migration can lose data, or stall the portal.
 *
 * Split out of `deploy.mjs` so the rules have tests of their own: migrations
 * now run unattended on every push to main, and a rule weakened by accident
 * would let the next `DROP` or `DELETE` through without anyone watching.
 */
// ── Destructive DDL ────────────────────────────────────────────────────────
//
// Split by consequence, because the two deserve different answers. `blocking`
// is "this can lose data a municipality cannot re-enter"; `warning` is "this
// takes a lock that can stall the portal on a table with rows in it".
//
// The expand/contract discipline in docs/database-environments.md is what keeps
// the blocking list empty in normal work: you add, backfill, switch reads, and
// only drop a release later — by which point the drop is genuinely safe and
// `--allow-destructive` is an accurate description of an intentional act.
export const DESTRUCTIVE = [
  { level: 'blocking', re: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { level: 'blocking', re: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { level: 'blocking', re: /\bDROP\s+SCHEMA\b/i, what: 'DROP SCHEMA' },
  { level: 'blocking', re: /\bTRUNCATE\b/i, what: 'TRUNCATE' },
  { level: 'blocking', re: /\bALTER\s+COLUMN\s+.*\bTYPE\b/i, what: 'ALTER COLUMN … TYPE' },
  { level: 'blocking', re: /\bRENAME\s+(COLUMN|TO)\b/i, what: 'RENAME' },
  // Rows, not schema, but just as unrecoverable, and migrations now run
  // unattended on every push to main. `0034` deleted duplicate occupancies
  // this way. The next one goes through the manual workflow, on purpose.
  // Also matches a DELETE inside a trigger function's body, which is only
  // code; that false alarm costs one manual run and nothing else.
  { level: 'blocking', re: /\bDELETE\s+FROM\b/i, what: 'DELETE FROM (removes rows)' },
  {
    level: 'warning',
    re: /\bUPDATE\s+\S+(\s+(AS\s+)?\w+)?\s+SET\b/i,
    what: 'UPDATE … SET (rewrites existing rows — a backfill should only fill new columns)',
  },
  { level: 'warning', re: /\bSET\s+NOT\s+NULL\b/i, what: 'SET NOT NULL (full table scan + lock)' },
  {
    level: 'warning',
    re: /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i,
    what: 'CREATE INDEX without CONCURRENTLY (write lock)',
  },
  { level: 'warning', re: /\bDROP\s+CONSTRAINT\b/i, what: 'DROP CONSTRAINT' },
];

/** Strips -- and /* *\/ comments so a commented-out DROP does not trip the scanner. */
export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function scanSql(name, sql) {
  const clean = stripSqlComments(sql);
  return DESTRUCTIVE.filter((rule) => rule.re.test(clean)).map((rule) => ({
    migration: name,
    level: rule.level,
    what: rule.what,
  }));
}
