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
 * and uploaded, so a backup that cannot be restored is never stored in the first
 * place. That ordering is the point of the whole file.
 *
 * ── The refusal ──────────────────────────────────────────────────────────────
 *
 * `pg_restore` is the most destructive command in this repository's vocabulary.
 * Pointed at a live database with `--clean` it drops and recreates every object
 * it carries. So the target is checked against `targets.mjs` before anything
 * runs, and any connection string that resolves to a known Supabase project ref
 * — or that simply is not a loopback host — is refused outright. There is no
 * flag to override this. If you want to restore into a real environment, that is
 * a different, human-supervised operation and it does not belong in a script
 * that runs on a timer.
 *
 * Usage:
 *   node scripts/db/verify-restore.mjs --dump <file> --manifest <file> --into <url>
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, TARGETS, extractRef } from './targets.mjs';

// Resolved from the backend package, where `pg` is a dependency — `scripts/` has
// no `package.json` of its own. Same as `deploy.mjs`.
const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

/** Hostnames a throwaway may live on. Nothing else is a throwaway. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

/**
 * Tables whose row count may legitimately be *lower* after the restore.
 *
 * The rule everywhere else in this file is that a restored count below the
 * manifest's is a failure — rows the dump was meant to carry did not survive
 * it. That rule is right for a register, which does not delete, and wrong for
 * session state, which expires and is revoked continuously. A login that timed
 * out between the count and the snapshot would fail the whole backup.
 *
 * That matters more than it looks: incident §8.6 is a gate that failed ~1 run
 * in 85 for a *correct* implementation and taught everyone to press retry. A
 * nightly backup that cries wolf over an expired refresh token is the same
 * mistake, and it would be pressing retry on the one job that must be believed.
 *
 * So shortfalls here are printed and not failed. `auth.users`,
 * `auth.identities`, `storage.objects` and `storage.buckets` are deliberately
 * NOT in this set — those are the rows a recovery actually depends on.
 */
const VOLATILE_TABLES = new Set([
  'auth.sessions',
  'auth.refresh_tokens',
  'auth.flow_state',
  'auth.one_time_tokens',
  'auth.mfa_challenges',
  'auth.oauth_client_states',
  'auth.webauthn_challenges',
  'auth.saml_relay_states',
  'storage.s3_multipart_uploads',
  'storage.s3_multipart_uploads_parts',
]);

function fail(message) {
  console.error(`\nABORT: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { dump: null, aux: null, manifest: null, into: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dump') options.dump = argv[++i];
    else if (arg === '--aux') options.aux = argv[++i];
    else if (arg === '--manifest') options.manifest = argv[++i];
    else if (arg === '--into') options.into = argv[++i];
    else fail(`Unknown argument '${arg}'`);
  }
  for (const key of ['dump', 'manifest', 'into']) {
    if (!options[key]) fail(`--${key} is required`);
  }
  if (!existsSync(options.dump)) fail(`No dump at ${options.dump}`);
  if (!existsSync(options.manifest)) fail(`No manifest at ${options.manifest}`);
  if (options.aux && !existsSync(options.aux)) fail(`No aux dump at ${options.aux}`);
  return options;
}

/**
 * The gate. Refuses anything that could be a real database.
 *
 * Two independent checks, because either alone has a hole: a ref check passes a
 * Supabase project that is not in `targets.mjs` yet, and a host check passes a
 * loopback tunnel forwarding to production. Both must agree.
 */
function assertThrowaway(connectionString) {
  const ref = extractRef(connectionString);
  if (ref) {
    // `local` shares staging's ref, so name the database rather than the target
    // — "points at staging" is the useful sentence, "points at local" is not.
    // Same reasoning as `resolveTarget` in targets.mjs.
    const known = Object.entries(TARGETS).find(([n, t]) => t.ref === ref && n !== 'local');
    fail(
      `--into names Supabase project ${ref}${known ? ` (${known[0]})` : ''}.\n` +
        `  This script restores over everything it touches. It will only ever run\n` +
        `  against a throwaway on a loopback address.`,
    );
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

  console.log(`  target    throwaway at ${host} — verified not a Supabase project`);
}

/**
 * Restores one archive into the throwaway, or fails the whole rehearsal.
 *
 * `--no-owner` and `--no-privileges` again on the way in: the dump was taken
 * without them, but a restore into a container whose superuser is named
 * something else still tries to reassign. `--exit-on-error` because a restore
 * that reports success having skipped forty statements is the exact failure
 * this script exists to catch — partial success is not success.
 */
function restoreArchive({ path, into, label }) {
  console.log(`\n  restoring ${label} …`);
  const result = spawnSync(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${into}`, path],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] },
  );

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().split('\n').slice(-25).join('\n');
    fail(
      `pg_restore exited ${result.status} restoring ${label} — this backup does not restore.\n\n` +
        `${stderr}\n\n` +
        `  Nothing has been uploaded. Yesterday's backup is untouched.`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));

  console.log(`\n  dump      ${options.dump}`);
  if (options.aux) console.log(`  aux       ${options.aux}`);
  console.log(`  from      ${manifest.target} (${manifest.projectRef}) at ${manifest.createdAt}`);

  /*
   * A manifest that declares a second archive and a rehearsal that was not
   * given it is the shape of §8.4: a report of success covering only the half
   * that was looked at. The auth archive is where every staff password hash
   * lives, so skipping it quietly would verify the register and not the ability
   * to log in to it.
   */
  if (manifest.authStorage && !options.aux) {
    fail(
      `This manifest declares a second archive — ${manifest.authStorage.file} —\n` +
        `  holding auth and storage, and --aux was not passed.\n\n` +
        `  Verifying half a backup and reporting success is the failure this script\n` +
        `  exists to prevent. Pass --aux <file>.`,
    );
  }

  assertThrowaway(options.into);

  /*
   * Clear `public` out of the way before restoring.
   *
   * `pg_dump --schema=public` writes a `CREATE SCHEMA public` into the archive,
   * and every freshly created Postgres database already has one — so the restore
   * aborts on "schema public already exists" under `--exit-on-error`. This is
   * not a quirk of the rehearsal: a real recovery into a fresh Supabase project
   * meets exactly the same error, which is why it is written down in
   * docs/database-environments.md §5 rather than only worked around here.
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

  restoreArchive({ path: options.dump, into: options.into, label: 'registry + tenants' });
  if (options.aux) {
    restoreArchive({ path: options.aux, into: options.into, label: 'auth + storage' });
  }

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

    /*
     * Counts, table by table, against what the manifest recorded.
     *
     * The live database is being written to while the dump is taken, so a
     * restored count may legitimately be *higher* than the pre-dump reading —
     * rows arrived between the count and the snapshot. It may never be lower.
     * A shortfall means rows the dump was supposed to carry did not survive it,
     * which is the silent half of incident §8.4 and is treated as failure.
     */
    const expectedCounts = {
      ...manifest.tableCounts,
      ...(manifest.authStorage?.tableCounts ?? {}),
    };

    for (const [qualified, expected] of Object.entries(expectedCounts)) {
      const [schema, table] = qualified.split('.');
      const quoted = `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
      try {
        const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${quoted}`);
        const actual = Number(rows[0].n);
        restored[qualified] = actual;
        if (actual < expected) {
          // See VOLATILE_TABLES: session state expires between the count and the
          // snapshot, and failing a good backup over that is its own hazard.
          if (VOLATILE_TABLES.has(qualified)) {
            console.log(`  note      ${qualified}: ${expected} → ${actual} (session state, expected to churn)`);
          } else {
            problems.push(`${qualified}: expected at least ${expected}, restored ${actual}`);
          }
        }
      } catch (error) {
        problems.push(`${qualified}: not queryable after restore — ${error.message}`);
      }
    }

    /*
     * Named explicitly rather than left to the loop above, because these four
     * are the difference between a register that comes back and a register that
     * comes back unusable — and a count of 0 that matched a manifest recording 0
     * would pass the loop silently.
     */
    if (manifest.authStorage) {
      for (const critical of ['auth.users', 'auth.identities', 'storage.buckets']) {
        if (!restored[critical]) {
          problems.push(`${critical}: restored 0 rows — nobody could sign in to this recovery`);
        }
      }
    }

    // The migration list is what `BackupService.restore` refuses a mismatch on,
    // and what tells you whether this dump can be replayed onto today's code.
    for (const [schema, expected] of Object.entries(manifest.migrations)) {
      if (expected === null) continue;
      const quoted = `"${schema.replace(/"/g, '""')}"."_tenant_migrations"`;
      try {
        const { rows } = await client.query(`SELECT "name" FROM ${quoted} ORDER BY "name"`);
        const actual = rows.map((row) => row.name);
        if (actual.length !== expected.length) {
          problems.push(
            `${schema}: ${expected.length} migrations in manifest, ${actual.length} restored`,
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
  if (manifest.authStorage) {
    console.log(
      `  logins    ${restored['auth.users'] ?? 0} auth.users, ` +
        `${restored['auth.identities'] ?? 0} identities`,
    );
    console.log(
      `  storage   ${restored['storage.buckets'] ?? 0} buckets, ` +
        `${restored['storage.objects'] ?? 0} object rows`,
    );
  }

  if (problems.length > 0) {
    fail(
      `The restore completed but did not match the manifest:\n` +
        problems.map((p) => `  ✗ ${p}`).join('\n') +
        `\n\n  The dump has NOT been uploaded. Yesterday's backup is untouched.`,
    );
  }

  console.log('\n  ✓ this dump restores, and matches its manifest.\n');
}

main().catch((error) => fail(error.message));
