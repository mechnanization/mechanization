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
  // Across line breaks, with or without the optional COLUMN keyword, and in
  // the SET DATA TYPE spelling. `.*` stopped at the first newline, so the form
  // `prisma migrate diff` writes over two lines went through unflagged.
  {
    level: 'blocking',
    re: /\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i,
    what: 'ALTER COLUMN … TYPE',
  },
  { level: 'blocking', re: /\bDROP\s+(?:TYPE|DOMAIN|SEQUENCE)\b/i, what: 'DROP TYPE / DOMAIN / SEQUENCE' },
  // CASCADE takes with it whatever depends on the dropped object: columns of
  // a dropped type, tables behind a dropped view. A foreign key's
  // `ON DELETE CASCADE` is a rule about future deletes and drops nothing.
  {
    level: 'blocking',
    re: /\bDROP\b[^;]*?(?<!\bON\s+(?:DELETE|UPDATE)\s+)\bCASCADE\b/i,
    what: 'DROP … CASCADE (drops everything that depends on it)',
  },
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

/**
 * Strips -- and /* *\/ comments, so a commented-out DROP does not trip the
 * scanner, without stripping anything that only looks like one.
 *
 * Walked character by character rather than with two regexes. A regex cannot
 * tell `SELECT '--';` from a comment, so everything after that `--`, the rest of
 * the line and any DROP on it, disappeared before the scan. String literals
 * ('it''s'), quoted identifiers and dollar-quoted bodies ($$ … $$, $fn$ … $fn$)
 * are kept, and the body of a dollar-quoted function is stripped of its own
 * comments in turn, since it is SQL too.
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const bodyEnd = close === -1 ? sql.length : close;
        out += tag + stripSqlComments(sql.slice(i + tag.length, bodyEnd)) + (close === -1 ? '' : tag);
        i = close === -1 ? sql.length : close + tag.length;
        continue;
      }
    }

    if (c === '-' && next === '-') {
      const newline = sql.indexOf('\n', i);
      i = newline === -1 ? sql.length : newline;
      out += ' ';
      continue;
    }

    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      out += ' ';
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

export function scanSql(name, sql) {
  const clean = stripSqlComments(sql);
  return DESTRUCTIVE.filter((rule) => rule.re.test(clean)).map((rule) => ({
    migration: name,
    level: rule.level,
    what: rule.what,
  }));
}
