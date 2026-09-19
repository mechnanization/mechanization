/**
 * Takes a verified, restorable dump of a named target.
 *
 * This is the disaster-recovery backup. It is not the same thing as
 * `BackupService`'s snapshot (`apps/backend/src/application/features/backup/`),
 * and the difference matters enough to state plainly: that one is a
 * *per-municipality export* built from a hand-maintained table list, and that
 * list has already drifted twice — it is currently missing `payment_transactions`
 * and `inspector_payouts`, and it can carry neither storage objects nor the
 * `payment_receipt_seq` sequence. This one is `pg_dump`, which enumerates what
 * exists at run time and therefore cannot fall behind a migration.
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
 * unfalsifiable rather than asserting in a comment.
 *
 * The read-back is not ceremony. The first version of this file set the flag via
 * the `options` startup parameter only, which is silently dropped by Supavisor —
 * and `DIRECT_URL` on this project is Supavisor in session mode, not
 * `db.<ref>.supabase.co`. The check caught a session that was still writable.
 * See the comment at the `SET SESSION CHARACTERISTICS` call.
 *
 * `pg_dump` is handed the same startup option, which helps on a genuinely direct
 * connection and is dropped on the pooler. It is not the guarantee: `pg_dump`
 * issues only SELECT and `LOCK TABLE … IN ACCESS SHARE MODE`, which is read-only
 * by construction and is the reason it is safe to point at a live database.
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

/**
 * The platform-managed schemas, taken as a **second** archive.
 *
 * `auth` is not an optional extra here. Staff rows in `tenant_*.users` carry
 * `kind = 'STAFF'` and an email, and that email is the *only* link to
 * `auth.users` — the ids do not match. Every password hash, every confirmed
 * email, every identity row lives in `auth`, and none of it was in the dump
 * this script produced before. A recovery from that dump returned the register
 * intact and nobody able to sign in to it.
 *
 * `storage` is the other half of the same omission. The workflow copies the
 * *bytes* of every scanned document to R2, but `storage.objects` — the rows
 * naming them, their bucket, owner, mime type and checksum — and
 * `storage.buckets` — which bucket is public, which has a size limit — are
 * database rows, and they were not being dumped either.
 *
 * ── Why a separate archive, and not more `--schema` flags ────────────────────
 *
 * Because it restores differently. A fresh Supabase project creates `auth` and
 * `storage` itself, owned by `supabase_auth_admin` and `supabase_storage_admin`,
 * before you restore anything. Folding these into the main archive would make
 * every real recovery collide on objects the platform had already created, and
 * the usual way out of that at 3am is `--clean`, which is how a recovery becomes
 * a second incident.
 *
 * Kept apart, the main archive restores untouched, and this one is applied
 * deliberately — `pg_restore --data-only`, table by table if need be. It is
 * dumped complete (schema and data) so the rehearsal in `verify-restore.mjs`
 * can restore it standalone into a bare Postgres, which is what proves it.
 *
 * Nothing is filtered out of it. `auth.sessions` and `auth.refresh_tokens` are
 * live session state that you would almost certainly *not* replay into a
 * recovered project — but that is a decision for the person doing the recovery,
 * made with `--table` flags at restore time. A backup that has already made it
 * for them is a backup with rows missing.
 */
const AUX_SCHEMAS = ['auth', 'storage'];

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
        `  The nightly backup runs in CI (.github/workflows/backup.yml), where the\n` +
        `  file is encrypted to an offline key and shredded in the same job.\n\n` +
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
 * `pg_dump` refuses a server newer than itself. Supabase runs Postgres 17; an
 * `ubuntu-latest` runner ships an older client by default, and the resulting
 * error ("server version mismatch") arrives *after* the credentials have been
 * materialised, which reads like an auth problem and sends people the wrong way.
 * Checked up front instead.
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
 * planning and useless as evidence. This runs against a database that is being
 * written to, so these are a reference point for a human reading the manifest,
 * not a checksum — the dump itself is taken in its own snapshot.
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
    try {
      const { rows } = await client.query(`SELECT "name" FROM ${quoted} ORDER BY "name"`);
      out[schema] = rows.map((row) => row.name);
    } catch {
      // A schema mid-provision may not have the table yet. Recorded as such
      // rather than skipped — "absent" and "empty" are different on restore.
      out[schema] = null;
    }
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
 * Dumps `schemas` into `path`, then reads the archive back to prove it parses.
 *
 * Custom format (`-Fc`), not plain SQL: it is compressed, it can be inspected
 * without being restored (`pg_restore --list`, which is what the read-back
 * below does), and `pg_restore` can replay it selectively — which is what you
 * want at 3am when one schema is wrong and the rest of the cluster is fine.
 *
 * `--no-owner` and `--no-privileges`: role grants on a Supabase project are
 * managed by the platform and do not transfer to a restore target. Carrying
 * them makes every restore fail on a role that does not exist there.
 *
 * The read-back is not ceremony. A truncated or corrupt archive is a file with
 * the right name and roughly the right size, and `pg_dump` exiting 0 rules out
 * neither (§5). `pg_restore --list` is the cheapest thing that fails on both.
 */
async function takeDump({ connectionString, path, schemas, label }) {
  if (existsSync(path)) fail(`${path} already exists — refusing to overwrite`);

  const args = [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    '--verbose',
    ...schemas.map((schema) => `--schema=${schema}`),
    `--file=${path}`,
    connectionString,
  ];

  console.log(`\n  dumping   ${label} → ${path}`);
  const result = spawnSync('pg_dump', args, {
    encoding: 'utf8',
    // The read-only guarantee follows `pg_dump` into its own connection.
    env: { ...process.env, PGOPTIONS: READ_ONLY_PGOPTIONS },
    // `--verbose` goes to stderr and names every table as it goes. Inherited so
    // a stuck dump is visible, and it carries no row data — only identifiers.
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (result.status !== 0) {
    fail(`pg_dump exited ${result.status} dumping ${label}. No usable backup was produced.`);
  }

  const listing = spawnSync('pg_restore', ['--list', path], { encoding: 'utf8' });
  if (listing.status !== 0) {
    fail(
      `The ${label} dump was written but pg_restore could not read it back.\n` +
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

  /*
   * The direct connection, never the pooled one.
   *
   * `pg_dump` needs a session it can hold open with a repeatable-read snapshot.
   * Supabase's transaction pooler on 6543 hands a different backend to every
   * statement, so a dump through it produces either an error or — worse — an
   * archive stitched from several moments. `DIRECT_URL` is port 5432.
   */
  const connectionString = env.DIRECT_URL;
  if (!connectionString) fail(`DIRECT_URL is missing from ${target.envFile}`);

  console.log(`\n  target    ${options.target} — ${target.label}`);
  console.log(`  project   ${target.ref}`);

  const dump = resolveDumpBinary();
  console.log(`  pg_dump   ${dump.version}`);

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    options: READ_ONLY_PGOPTIONS,
  });
  await client.connect();

  let schemas;
  let counts;
  let auxCounts;
  let migrations;
  let serverVersion;
  try {
    /*
     * Read-only, stated as a statement rather than only as a startup option.
     *
     * `DIRECT_URL` on this project is Supavisor in session mode — the pooler
     * host on 5432, not `db.<ref>.supabase.co` — and Supavisor does not forward
     * the `options` startup parameter to Postgres. So the `options` passed to
     * `new Client` above silently does nothing, and the first version of this
     * check caught exactly that: it aborted, correctly, on a session that was
     * still writable.
     *
     * `SET SESSION CHARACTERISTICS` is a plain statement, so it survives the
     * pooler. It is issued and then read back, because a setting that was
     * applied and a setting that took effect are different claims and only the
     * second one is worth anything (§5).
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

    schemas = await discoverSchemas(client);
    console.log(`\n  schemas   ${schemas.length} found`);
    for (const schema of schemas) console.log(`              ${schema}`);

    counts = await tableCounts(client, schemas);
    migrations = await migrationsBySchema(client, schemas);

    /*
     * Counted through the same read-only session, so the numbers in the
     * manifest and the numbers the rehearsal checks come from one reading.
     * `postgres` can SELECT every table in both schemas on this project — the
     * tables are owned by `supabase_auth_admin` and `supabase_storage_admin`,
     * which is why this is worth stating rather than assuming.
     */
    auxCounts = await tableCounts(client, AUX_SCHEMAS);
  } finally {
    await client.end();
  }

  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const auxTotalRows = Object.values(auxCounts).reduce((a, b) => a + b, 0);
  console.log(`\n  tables    ${Object.keys(counts).length}`);
  console.log(`  rows      ${totalRows.toLocaleString('en-US')}`);
  console.log(
    `  auth+storage  ${Object.keys(auxCounts).length} tables, ` +
      `${auxTotalRows.toLocaleString('en-US')} rows (second archive)`,
  );
  console.log(
    `                incl. ${(auxCounts['auth.users'] ?? 0).toLocaleString('en-US')} auth.users, ` +
      `${(auxCounts['storage.objects'] ?? 0).toLocaleString('en-US')} storage.objects`,
  );

  if (options.dryRun) {
    console.log('\n  --dry-run — nothing written.\n');
    return;
  }

  mkdirSync(options.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${options.target}-${target.ref}-${stamp}`;
  const dumpPath = join(options.out, `${base}.dump`);
  const auxPath = join(options.out, `${base}.auth-storage.dump`);

  const primary = await takeDump({
    connectionString,
    path: dumpPath,
    schemas,
    label: 'registry + tenants',
  });

  /*
   * Named `.auth-storage.dump` rather than `.aux.dump` so that the file says
   * what it holds to whoever finds it in a bucket during a recovery, and ending
   * in `.dump` so the workflow's encrypt step picks it up with the same glob.
   */
  const aux = await takeDump({
    connectionString,
    path: auxPath,
    schemas: AUX_SCHEMAS,
    label: 'auth + storage',
  });

  const manifest = {
    target: options.target,
    projectRef: target.ref,
    createdAt: new Date().toISOString(),
    serverVersion,
    pgDumpVersion: dump.version,
    schemas,
    tableCounts: counts,
    totalRows,
    migrations,
    dump: { file: `${base}.dump`, ...primary },
    authStorage: {
      file: `${base}.auth-storage.dump`,
      ...aux,
      schemas: AUX_SCHEMAS,
      tableCounts: auxCounts,
      totalRows: auxTotalRows,
    },
    /*
     * Named here because a manifest that lists only what it *does* contain
     * invites the reader to assume it contains everything. Restoring these
     * files alone does not bring a municipality back.
     */
    notIncluded: [
      'Supabase Storage object *bytes* (documents, cadastre buckets) — copied to ' +
        'R2 by the workflow, separately from these archives. storage.objects and ' +
        'storage.buckets — the rows describing them — ARE in the auth-storage dump.',
      'Postgres roles and their passwords — platform-managed, recreated by Supabase',
      'Project settings outside Postgres: auth providers and redirect URLs, ' +
        'edge function source, Vercel and GitHub environment variables (§7 of AGENTS.md)',
    ],
    /*
     * Written into the manifest rather than only into a runbook, because the
     * manifest is the file that travels with the dump into the bucket. During a
     * recovery this is what is to hand; docs/database-environments.md may not be.
     */
    restoreOrder: [
      '1. Create the target project. Supabase creates auth/ and storage/ itself.',
      `2. psql -c 'DROP SCHEMA IF EXISTS public CASCADE' — the archive carries its own.`,
      `3. pg_restore --no-owner --no-privileges --exit-on-error -d <url> ${base}.dump`,
      `4. pg_restore --data-only --no-owner --disable-triggers -d <url> \\`,
      `     --table=users --table=identities --table=buckets --table=objects \\`,
      `     ${base}.auth-storage.dump`,
      '   (--data-only: the platform already created these tables. Add --table=sessions',
      '    and --table=refresh_tokens only if you intend to replay live sessions.)',
      '5. rclone copy r2:<bucket>/storage/ back into the project buckets.',
      '6. Verify: counts in this manifest, then sign in as a staff user.',
    ],
  };

  const manifestPath = join(options.out, `${base}.manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(options.out, `${base}.dump.sha256`),
    `${primary.sha256}  ${base}.dump\n${aux.sha256}  ${base}.auth-storage.dump\n`,
  );

  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`\n  verified  pg_restore read back both archives`);
  console.log(`  registry + tenants  ${mb(primary.bytes)}, ${primary.tocEntries} entries`);
  console.log(`            sha256    ${primary.sha256}`);
  console.log(`  auth + storage      ${mb(aux.bytes)}, ${aux.tocEntries} entries`);
  console.log(`            sha256    ${aux.sha256}`);
  console.log(`  manifest  ${manifestPath}\n`);

  // Read by the workflow, so the later steps name the same files this one wrote
  // rather than globbing a directory and hoping.
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `dump_file=${base}.dump`,
        `aux_file=${base}.auth-storage.dump`,
        `manifest_file=${base}.manifest.json`,
        `basename=${base}`,
        `sha256=${primary.sha256}`,
        `aux_sha256=${aux.sha256}`,
        `bytes=${primary.bytes}`,
        `aux_bytes=${aux.bytes}`,
        `total_rows=${totalRows}`,
        `aux_total_rows=${auxTotalRows}`,
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
