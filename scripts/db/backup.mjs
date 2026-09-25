/**
 * Takes a verified, restorable dump of a named target.
 *
 * This is the backup the migration pipeline takes of production right before
 * applying a migration (`.github/workflows/migrate-database.yml`), so a
 * migration that damages data can be undone from the moment before it ran. It
 * is `pg_dump`, which enumerates what exists at run time and therefore cannot
 * fall behind a migration. Day-to-day backups of the Lightsail box are taken on
 * the AWS side, outside this repository.
 *
 * ── Why discovery here, when §4 of AGENTS.md says "allowlist, never discover" ─
 *
 * That rule governs data *leaving*: a sync to production that discovers tables
 * silently gains one on the next migration, which is incident §8.4. A backup has
 * the opposite polarity. Nothing leaves your control, and the failure mode is
 * *omission* — a table nobody remembered to add, discovered on the day it was
 * needed. So this discovers, deliberately, and prints what it found.
 *
 * ── The read-only guarantee ──────────────────────────────────────────────────
 *
 * This script's own session is put into `READ ONLY` and then *read back* to
 * confirm it took. Postgres refuses any INSERT, UPDATE, DELETE or DDL on such a
 * session with a hard error. A backup script is the last place that should be
 * able to change anything, and "it only reads" is a claim worth making
 * unfalsifiable rather than asserting in a comment. The read-back is not
 * ceremony: an earlier version set the flag through a connection pooler that
 * silently dropped it, and only the read-back noticed.
 *
 * `pg_dump` is handed the same startup option. It is not the guarantee: `pg_dump`
 * issues only SELECT and `LOCK TABLE … IN ACCESS SHARE MODE`, which is read-only
 * by construction and is the reason it is safe to point at a live database.
 *
 * ── One moment, not two ──────────────────────────────────────────────────────
 *
 * The row counts in the manifest and the rows in the dump come from the same
 * database snapshot: this session exports one, and `pg_dump --snapshot` reads
 * through it. So a restore must reproduce every count exactly. An earlier
 * version counted first and dumped second, and had to allow a restored table to
 * come back *smaller* when a row was deleted in between, which is a tolerance
 * that also hides a table the dump really lost.
 *
 * Usage:
 *   node scripts/db/backup.mjs <target> --out <dir> [--dry-run]
 *
 *   --out       directory to write the dump, manifest and checksum into
 *   --dry-run   connect, discover and report; produce no files
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, TARGETS, resolveTarget, TargetError } from './targets.mjs';

// Resolved from the backend package, where `pg` is a dependency — `scripts/` has
// no `package.json` of its own. Same as `deploy.mjs`.
const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

/**
 * Forced onto every session, including `pg_dump`'s.
 *
 * `-c` here is a Postgres startup option, not a shell flag. Postgres applies it
 * before the first statement runs, so there is no window in which this process
 * holds a writable session.
 */
const READ_ONLY_PGOPTIONS = '-c default_transaction_read_only=on';

/**
 * Schemas that are always dumped, beyond the discovered `tenant_*` ones.
 *
 * `public` is the registry — it holds the `tenants` table, without which a
 * restored cluster has municipality schemas and no record that they exist.
 * Leaving it out is the kind of omission that is only discovered mid-recovery.
 */
const ALWAYS_INCLUDED_SCHEMAS = ['public'];

function fail(message) {
  console.error(`\nABORT: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [target, ...rest] = argv;
  const options = { target, out: null, dryRun: false, allowLocalCopy: false };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-local-copy') options.allowLocalCopy = true;
    else if (arg === '--out') options.out = rest[++i];
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else fail(`Unknown argument '${arg}'`);
  }

  if (!options.target || !TARGETS[options.target]) {
    fail(
      `Name the target. Expected one of: ${Object.keys(TARGETS).join(', ')}\n` +
        `  e.g. node scripts/db/backup.mjs production --dry-run`,
    );
  }
  if (!options.out && !options.dryRun) fail('--out <dir> is required unless --dry-run');

  /*
   * A dump is every citizen row in the register, in one portable file.
   *
   * §4 of AGENTS.md is unambiguous that this must not land on a developer's
   * machine — not to a file, not "for backup". So writing one outside CI is a
   * deliberate act with a flag on it, in the same idiom as `--allow-destructive`
   * on the deploy: a statement that you know what the file is and where it is
   * going, never a way past an error message.
   *
   * CI is exempt because that is where the file is encrypted to a key nobody in
   * this process holds, uploaded, and shredded within the same job.
   */
  const inCI = process.env.CI === 'true' || Boolean(process.env.GITHUB_ACTIONS);
  if (options.out && !options.dryRun && !inCI && !options.allowLocalCopy) {
    fail(
      `Refusing to write a dump of '${options.target}' to this machine.\n\n` +
        `  A dump holds every citizen row — national ID and civil record numbers,\n` +
        `  addresses, residency status — as one unencrypted portable file.\n` +
        `  AGENTS.md §4: citizen data does not land on a developer's disk.\n\n` +
        `  The pre-migration backup runs in CI (.github/workflows/migrate-database.yml),\n` +
        `  where the file is encrypted to an offline key and shredded in the same job.\n\n` +
        `  To see what would be dumped, without writing anything:\n` +
        `      node scripts/db/backup.mjs ${options.target} --dry-run\n\n` +
        `  If you genuinely need the file here — a migration rehearsal, a recovery\n` +
        `  in progress — pass --allow-local-copy, and delete it when you are done.`,
    );
  }

  return options;
}

/**
 * The `pg_dump` on PATH, and a check that it can read this server at all.
 *
 * `pg_dump` refuses a server newer than itself, and the error ("server version
 * mismatch") arrives *after* the credentials have been materialised, which
 * reads like an auth problem and sends people the wrong way. Checked up front
 * instead, against the server's own version, below.
 */
function resolveDumpBinary() {
  const probe = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    fail(
      'pg_dump is not on PATH.\n' +
        '  Ubuntu: install the PGDG client matching the server major version,\n' +
        '  e.g. postgresql-client-17. A client older than the server will refuse.',
    );
  }
  const version = probe.stdout.trim();
  const major = Number(/(\d+)/.exec(version)?.[1] ?? 0);
  return { version, major };
}

/**
 * Every `tenant_*` schema on the server, plus the registry.
 *
 * Read from `information_schema`, per §1 — not from `targets.mjs`, not from the
 * registry's `tenants` table, and not from a list in this file. A municipality
 * provisioned last week is in the database and in none of those three.
 */
async function discoverSchemas(client) {
  const { rows } = await client.query(
    `SELECT schema_name
       FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant\\_%'
      ORDER BY schema_name`,
  );
  return [...ALWAYS_INCLUDED_SCHEMAS, ...rows.map((row) => row.schema_name)];
}

/**
 * Row counts per table, recorded so a restore has something to be checked against.
 *
 * `count(*)` rather than `reltuples`: the planner's estimate is fine for query
 * planning and useless as evidence. Read inside the exported snapshot, so these
 * are the counts of exactly the rows the dump carries.
 */
async function tableCounts(client, schemas) {
  const { rows: tables } = await client.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_schema = ANY($1)
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name`,
    [schemas],
  );

  const counts = {};
  for (const { table_schema: schema, table_name: table } of tables) {
    // Identifiers cannot be bound as parameters, so they are quoted. They come
    // from `information_schema` rather than from input, but quoting them is what
    // makes that irrelevant.
    const quoted = `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
    const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${quoted}`);
    counts[`${schema}.${table}`] = Number(rows[0].n);
  }
  return counts;
}

/** The tenant migrator's applied list, per schema — what a restore must match. */
async function migrationsBySchema(client, schemas) {
  const out = {};
  for (const schema of schemas) {
    if (schema === 'public') continue;
    const quoted = `"${schema.replace(/"/g, '""')}"."_tenant_migrations"`;
    // Checked rather than caught: an error inside the snapshot's transaction
    // would abort it, and the dump that follows reads through that transaction.
    const { rows: present } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [
      quoted,
    ]);
    if (!present[0].present) {
      // A schema mid-provision may not have the table yet. Recorded as such
      // rather than skipped — "absent" and "empty" are different on restore.
      out[schema] = null;
      continue;
    }
    const { rows } = await client.query(`SELECT "name" FROM ${quoted} ORDER BY "name"`);
    out[schema] = rows.map((row) => row.name);
  }
  return out;
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Dumps `schemas` into `path` through `snapshot`, then reads the archive back
 * to prove it parses.
 *
 * Custom format (`-Fc`), not plain SQL: it is compressed, it can be inspected
 * without being restored (`pg_restore --list`, which is what the read-back
 * below does), and `pg_restore` can replay it selectively — which is what you
 * want at 3am when one schema is wrong and the rest of the cluster is fine.
 *
 * `--no-owner` and `--no-privileges`: a restore target has its own roles, and
 * carrying these makes every restore fail on a role that does not exist there.
 *
 * The read-back is not ceremony. A truncated or corrupt archive is a file with
 * the right name and roughly the right size, and `pg_dump` exiting 0 rules out
 * neither (§5). `pg_restore --list` is the cheapest thing that fails on both.
 */
async function takeDump({ connectionString, path, schemas, snapshot }) {
  if (existsSync(path)) fail(`${path} already exists — refusing to overwrite`);

  const args = [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    '--verbose',
    `--snapshot=${snapshot}`,
    ...schemas.map((schema) => `--schema=${schema}`),
    `--file=${path}`,
    connectionString,
  ];

  console.log(`\n  dumping   registry + tenants → ${path}`);
  const result = spawnSync('pg_dump', args, {
    encoding: 'utf8',
    // The read-only guarantee follows `pg_dump` into its own connection.
    env: { ...process.env, PGOPTIONS: READ_ONLY_PGOPTIONS },
    // `--verbose` goes to stderr and names every table as it goes. Inherited so
    // a stuck dump is visible, and it carries no row data — only identifiers.
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (result.status !== 0) {
    fail(`pg_dump exited ${result.status}. No usable backup was produced.`);
  }

  const listing = spawnSync('pg_restore', ['--list', path], { encoding: 'utf8' });
  if (listing.status !== 0) {
    fail(
      `The dump was written but pg_restore could not read it back.\n` +
        `  ${(listing.stderr || '').trim()}\n` +
        `  Treat this file as unusable.`,
    );
  }
  const tocEntries = listing.stdout.split('\n').filter((line) => line && !line.startsWith(';'));

  return { bytes: statSync(path).size, sha256: await sha256(path), tocEntries: tocEntries.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = TARGETS[options.target];

  let env;
  try {
    ({ env } = resolveTarget(options.target));
  } catch (error) {
    if (error instanceof TargetError) fail(error.message);
    throw error;
  }

  // The session URL, never a pooled one: `pg_dump` has to hold one session and
  // one snapshot for the whole dump.
  const connectionString = env.DIRECT_URL;
  if (!connectionString) fail(`DIRECT_URL is missing from ${target.envFile}`);

  console.log(`\n  target    ${options.target} — ${target.label}`);
  console.log(`  database  ${target.database}`);

  const dump = resolveDumpBinary();
  console.log(`  pg_dump   ${dump.version}`);

  const client = new Client({ connectionString, options: READ_ONLY_PGOPTIONS });
  await client.connect();

  let schemas;
  let counts;
  let migrations;
  let serverVersion;
  let primary = null;
  let base = null;
  try {
    /*
     * Read-only, stated as a statement rather than only as a startup option, and
     * read back: a setting that was applied and a setting that took effect are
     * different claims, and only the second one is worth anything (§5).
     */
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

    const { rows: roCheck } = await client.query('SHOW transaction_read_only');
    if (roCheck[0].transaction_read_only !== 'on') {
      fail(
        'The session is not read-only. Refusing to continue.\n' +
          '  Neither the `options` startup parameter nor SET SESSION CHARACTERISTICS\n' +
          '  took effect, which means this process could write to the database it is\n' +
          '  supposed to only read.',
      );
    }
    console.log('  session   read-only (set, and confirmed by the server)');

    const { rows: versionRows } = await client.query('SHOW server_version');
    serverVersion = versionRows[0].server_version;
    const serverMajor = Number(/(\d+)/.exec(serverVersion)?.[1] ?? 0);
    if (dump.major < serverMajor) {
      fail(
        `pg_dump is version ${dump.major} but the server is ${serverMajor}.\n` +
          `  A client older than the server refuses to dump. Install postgresql-client-${serverMajor}.`,
      );
    }
    console.log(`  server    Postgres ${serverVersion}`);

    /*
     * One snapshot for the counts and the dump. The transaction stays open until
     * `pg_dump` has finished, because an exported snapshot lives exactly as long
     * as the transaction that exported it.
     */
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: snapshotRows } = await client.query('SELECT pg_export_snapshot() AS id');
    const snapshot = snapshotRows[0].id;

    schemas = await discoverSchemas(client);
    console.log(`\n  schemas   ${schemas.length} found`);
    for (const schema of schemas) console.log(`              ${schema}`);

    counts = await tableCounts(client, schemas);
    migrations = await migrationsBySchema(client, schemas);

    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`\n  tables    ${Object.keys(counts).length}`);
    console.log(`  rows      ${totalRows.toLocaleString('en-US')}`);

    if (!options.dryRun) {
      mkdirSync(options.out, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      base = `${options.target}-${target.database}-${stamp}`;
      primary = await takeDump({
        connectionString,
        path: join(options.out, `${base}.dump`),
        schemas,
        snapshot,
      });
    }

    await client.query('COMMIT');
  } finally {
    await client.end();
  }

  if (options.dryRun) {
    console.log('\n  --dry-run — nothing written.\n');
    return;
  }

  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const manifest = {
    target: options.target,
    database: target.database,
    createdAt: new Date().toISOString(),
    serverVersion,
    pgDumpVersion: dump.version,
    // Read by verify-restore.mjs: counts taken inside the dump's own snapshot
    // must come back exactly, not merely "at least".
    consistency: 'single-snapshot',
    schemas,
    tableCounts: counts,
    totalRows,
    migrations,
    dump: { file: `${base}.dump`, ...primary },
    /*
     * Named here because a manifest that lists only what it *does* contain
     * invites the reader to assume it contains everything. Restoring this file
     * alone does not bring a municipality back.
     */
    notIncluded: [
      'Uploaded documents and cadastre files — they are objects in the S3 ' +
        'documents and assets buckets, not rows. document rows here name them.',
      'Postgres roles and their passwords — cluster-level, recreated on the server',
      'Configuration outside Postgres: the server .env, nginx, pm2, and the GitHub ' +
        'and Vercel environment variables (§7 of AGENTS.md)',
    ],
    /*
     * Written into the manifest rather than only into a runbook, because the
     * manifest is the file that travels with the dump into the bucket. During a
     * recovery this is what is to hand; docs/database-environments.md may not be.
     */
    restoreOrder: [
      '1. age --decrypt -i <private key> -o <file>.dump <file>.dump.age',
      '2. Restore into a NEW, empty database first, never over the live one:',
      '     createdb -O <role> <scratch_db>',
      `     psql -d <scratch_db> -c 'DROP SCHEMA IF EXISTS public CASCADE'`,
      `     pg_restore --no-owner --no-privileges --exit-on-error -d <scratch_db> ${base}.dump`,
      '3. Verify: every count in this manifest, and _tenant_migrations per schema.',
      '4. Only then decide what to move back, and how. A whole-database swap discards',
      '   every write made since this dump was taken.',
    ],
  };

  const manifestPath = join(options.out, `${base}.manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(options.out, `${base}.dump.sha256`), `${primary.sha256}  ${base}.dump\n`);

  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`\n  verified  pg_restore read the archive back`);
  console.log(`  archive   ${mb(primary.bytes)}, ${primary.tocEntries} entries`);
  console.log(`  sha256    ${primary.sha256}`);
  console.log(`  manifest  ${manifestPath}\n`);

  // Read by the workflow, so the later steps name the same files this one wrote
  // rather than globbing a directory and hoping.
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `dump_file=${base}.dump`,
        `manifest_file=${base}.manifest.json`,
        `basename=${base}`,
        `sha256=${primary.sha256}`,
        `bytes=${primary.bytes}`,
        `total_rows=${totalRows}`,
        '',
      ].join('\n'),
      { flag: 'a' },
    );
  }
}

main().catch((error) => {
  // Deliberately the message and not the whole error: a `pg` connection error
  // renders the connection string, password included, in its `stack`.
  fail(error.message);
});
