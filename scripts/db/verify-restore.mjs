/**
 * Proves a dump restores, by restoring it — into a throwaway and nowhere else.
 *
 * A backup nobody has restored is a hypothesis. This repository already learned
 * the specific version of that lesson: `BackupService`'s restore hit an
 * append-only trigger and aborted for *every* municipality, while its `dryRun`
 * reported success, because the rehearsal counted rows and the real thing wrote
 * them. Counting is not restoring. This restores.
 *
 * It runs in the same job that produced the dump, before the dump is encrypted
 * and uploaded and before the migration it protects is applied, so a backup
 * that cannot be restored stops the migration instead of standing behind it.
 * That ordering is the point of the whole file.
 *
 * ── The refusal ──────────────────────────────────────────────────────────────
 *
 * `pg_restore` is the most destructive command in this repository's vocabulary.
 * Pointed at a live database with `--clean` it drops and recreates every object
 * it carries. So the target is checked against `targets.mjs` before anything
 * runs, and any connection string that names a pinned database or role — or that
 * simply is not a loopback host — is refused outright. There is no flag to
 * override this. If you want to restore into a real environment, that is a
 * different, human-supervised operation and it does not belong in a pipeline.
 *
 * Usage:
 *   node scripts/db/verify-restore.mjs --dump <file> --manifest <file> --into <url>
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, TARGETS, parseConnection } from './targets.mjs';

// Resolved from the backend package, where `pg` is a dependency — `scripts/` has
// no `package.json` of its own. Same as `deploy.mjs`.
const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

/** Hostnames a throwaway may live on. Nothing else is a throwaway. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

function fail(message) {
  console.error(`\nABORT: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { dump: null, manifest: null, into: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dump') options.dump = argv[++i];
    else if (arg === '--manifest') options.manifest = argv[++i];
    else if (arg === '--into') options.into = argv[++i];
    else fail(`Unknown argument '${arg}'`);
  }
  for (const key of ['dump', 'manifest', 'into']) {
    if (!options[key]) fail(`--${key} is required`);
  }
  if (!existsSync(options.dump)) fail(`No dump at ${options.dump}`);
  if (!existsSync(options.manifest)) fail(`No manifest at ${options.manifest}`);
  return options;
}

/**
 * The gate. Refuses anything that could be a real database.
 *
 * Two independent checks, because either alone has a hole. The host check
 * refuses anything remote, but it passes an SSH tunnel — and every real
 * database is reached through one, so staging and production both *are*
 * `localhost` from here. The identity check closes that: a URL naming any
 * pinned database or role is refused wherever it points. Both must agree.
 */
function assertThrowaway(connectionString) {
  const found = parseConnection(connectionString);
  if (found) {
    // `local` shares staging's database, so name the environment rather than
    // the target — "points at staging" is the useful sentence, "points at
    // local" is not. Same reasoning as `resolveTarget` in targets.mjs.
    const known = Object.entries(TARGETS).find(
      ([n, t]) => n !== 'local' && (t.database === found.database || t.user === found.user),
    );
    if (known) {
      fail(
        `--into names ${found.user}@…/${found.database}, which is the ${known[0]} database or role.\n` +
          `  On a loopback address that is a tunnel, not a throwaway. This script restores\n` +
          `  over everything it touches; it will only ever run against a container.`,
      );
    }
  }

  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    fail('--into is not a parseable connection string');
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    fail(
      `--into points at host '${host}', which is not a loopback address.\n` +
        `  Expected one of: ${[...LOOPBACK_HOSTS].join(', ')}.\n` +
        `  A restore drill runs against a container that is thrown away afterwards.`,
    );
  }

  console.log(`  target    throwaway at ${host} — verified not a pinned database`);
}

/**
 * Restores the archive into the throwaway, or fails the whole rehearsal.
 *
 * `--no-owner` and `--no-privileges` again on the way in: the dump was taken
 * without them, but a restore into a container whose superuser is named
 * something else still tries to reassign. `--exit-on-error` because a restore
 * that reports success having skipped forty statements is the exact failure
 * this script exists to catch — partial success is not success.
 */
function restoreArchive({ path, into }) {
  console.log('\n  restoring registry + tenants …');
  const result = spawnSync(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${into}`, path],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] },
  );

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().split('\n').slice(-25).join('\n');
    fail(
      `pg_restore exited ${result.status} — this backup does not restore.\n\n` +
        `${stderr}\n\n` +
        `  Nothing has been uploaded, and nothing has been migrated.`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));

  console.log(`\n  dump      ${options.dump}`);
  console.log(`  from      ${manifest.target} (${manifest.database}) at ${manifest.createdAt}`);

  /*
   * Counts read inside the dump's own snapshot must come back exactly. A
   * manifest without that guarantee is from another tool or another era, and
   * "at least as many rows" is a tolerance that also passes a table the dump
   * really lost.
   */
  if (manifest.consistency !== 'single-snapshot') {
    fail(
      `This manifest does not say its counts were taken in the dump's snapshot\n` +
        `  (consistency: ${JSON.stringify(manifest.consistency ?? null)}), so its counts cannot be\n` +
        `  checked exactly. Take the dump again with scripts/db/backup.mjs.`,
    );
  }

  assertThrowaway(options.into);

  /*
   * Clear `public` out of the way before restoring.
   *
   * `pg_dump --schema=public` writes a `CREATE SCHEMA public` into the archive,
   * and every freshly created Postgres database already has one — so the restore
   * aborts on "schema public already exists" under `--exit-on-error`. This is
   * not a quirk of the rehearsal: a real recovery into a fresh database meets
   * exactly the same error, which is why it is written into the manifest's
   * restore order rather than only worked around here.
   *
   * The DROP is destructive, and it is deliberately placed *after*
   * `assertThrowaway` — it can only ever run against a loopback database this
   * script has already refused to believe is real.
   */
  {
    const prep = new Client({ connectionString: options.into });
    await prep.connect();
    try {
      await prep.query('DROP SCHEMA IF EXISTS public CASCADE');
    } finally {
      await prep.end();
    }
  }

  restoreArchive({ path: options.dump, into: options.into });

  const client = new Client({ connectionString: options.into });
  await client.connect();

  const problems = [];
  const restored = {};
  let schemasPresent = 0;
  try {
    // Every schema the manifest claims must actually be here.
    const { rows: schemaRows } = await client.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)`,
      [manifest.schemas],
    );
    const present = new Set(schemaRows.map((row) => row.schema_name));
    schemasPresent = present.size;
    for (const schema of manifest.schemas) {
      if (!present.has(schema)) problems.push(`schema '${schema}' is missing after restore`);
    }

    // Counts, table by table: exactly what the snapshot held, no more, no less.
    for (const [qualified, expected] of Object.entries(manifest.tableCounts)) {
      const [schema, table] = qualified.split('.');
      const quoted = `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
      try {
        const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${quoted}`);
        const actual = Number(rows[0].n);
        restored[qualified] = actual;
        if (actual !== expected) {
          problems.push(`${qualified}: the snapshot held ${expected}, the restore has ${actual}`);
        }
      } catch (error) {
        problems.push(`${qualified}: not queryable after restore — ${error.message}`);
      }
    }

    // A table the restore produced that the manifest never counted is a dump
    // and a manifest that disagree about what was taken.
    const { rows: tableRows } = await client.query(
      `SELECT table_schema || '.' || table_name AS qualified
         FROM information_schema.tables
        WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'`,
      [manifest.schemas],
    );
    for (const { qualified } of tableRows) {
      if (!(qualified in manifest.tableCounts)) {
        problems.push(`${qualified}: restored, but not in the manifest`);
      }
    }

    // The migration list is what tells you whether this dump can be replayed
    // onto today's code, name by name.
    for (const [schema, expected] of Object.entries(manifest.migrations)) {
      if (expected === null) continue;
      const quoted = `"${schema.replace(/"/g, '""')}"."_tenant_migrations"`;
      try {
        const { rows } = await client.query(`SELECT "name" FROM ${quoted} ORDER BY "name"`);
        const actual = rows.map((row) => row.name);
        if (actual.join('\n') !== expected.join('\n')) {
          problems.push(
            `${schema}: the manifest lists ${expected.length} migrations, the restore has ${actual.length}` +
              ' (or the same number, named differently)',
          );
        }
      } catch (error) {
        problems.push(`${schema}._tenant_migrations: ${error.message}`);
      }
    }
  } finally {
    await client.end();
  }

  const totalRestored = Object.values(restored).reduce((a, b) => a + b, 0);
  // Counted from the restored database, not read back off the manifest. A report
  // that echoes what was *expected* is the kind that says "3 schemas restored"
  // while two are there, which is worse than no report during an incident.
  console.log(`\n  schemas   ${schemasPresent}/${manifest.schemas.length} restored`);
  console.log(`  tables    ${Object.keys(restored).length} queryable`);
  console.log(`  rows      ${totalRestored.toLocaleString('en-US')} restored`);

  if (problems.length > 0) {
    fail(
      `The restore completed but did not match the manifest:\n` +
        problems.map((p) => `  ✗ ${p}`).join('\n') +
        `\n\n  Nothing has been uploaded, and nothing has been migrated.`,
    );
  }

  console.log('\n  ✓ this dump restores, and matches its manifest exactly.\n');
}

main().catch((error) => fail(error.message));
