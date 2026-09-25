#!/usr/bin/env node
/**
 * The only supported way to apply schema changes to a hosted database.
 *
 *   node scripts/db/deploy.mjs <local|staging|production> [options]
 *
 * `docs/deploy-vercel.md` §5 used to say migrations were "manual, from a machine
 * with DIRECT_URL". That sentence is the whole risk: two commands, no statement
 * of intent, and the target decided by whichever dotenv file was on disk. This
 * script replaces those two commands with one that has to be told where it is
 * going, checks that it got there, and refuses several categories of mistake on
 * the way.
 *
 * What it enforces, in the order the checks run:
 *
 *   1. The env file's connection strings name the database and role the target
 *      is pinned to (`targets.mjs`).
 *   2. The target's history is readable and believable (`migration-state.mjs`).
 *      A live schema whose history is missing, a registry migration Prisma
 *      left half-done, or production reporting no municipalities stops here,
 *      before anything is listed as pending.
 *   3. Nothing is pending that this script has not read — it lists the exact
 *      migrations it is about to apply, per tenant schema included.
 *   4. Pending SQL is scanned for anything that loses data (`destructive-sql.mjs`).
 *      `DROP COLUMN` or `DELETE FROM` on a table of citizen records is not
 *      something to discover from a stack trace, so it blocks unless the
 *      caller says `--allow-destructive` out loud.
 *   5. Production only: every migration about to be applied is already applied
 *      on staging, and staging has a municipality to have applied it to.
 *      Promotion, not a parallel path.
 *   6. Production only: a typed confirmation of the database name.
 *   7. After applying: the target is read again, registry and every tenant
 *      schema, and must have nothing left pending.
 *
 * Options:
 *   --dry-run              Report everything above, apply nothing. Safe anywhere.
 *   --check                A dry run whose exit code says whether anything is
 *                          pending: 0 up to date, 3 pending and every check
 *                          passed, 1 refused. How the pipeline decides whether
 *                          to take a pre-migration backup.
 *   --allow-destructive    Permit migrations containing data-losing DDL.
 *   --confirm=<db>         Non-interactive confirmation, for CI. Must equal the
 *                          target's own database name, so a copied staging
 *                          command cannot fire at production.
 *   --skip-promotion-check Bypass (5). For a genuine hotfix; it is logged loudly.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, TARGETS, parseConnection, resolveTarget, TargetError } from './targets.mjs';
import { scanSql } from './destructive-sql.mjs';
import {
  isUpToDate,
  productionProblems,
  promotionProblems,
  readMigrationState,
} from './migration-state.mjs';

const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

/** `--check`'s answer for "migrations are pending, and nothing refused them". */
const PENDING_EXIT_CODE = 3;

const BACKEND = join(ROOT, 'apps', 'backend');
const REGISTRY_MIGRATIONS = join(BACKEND, 'src/infrastructure/prisma/registry/migrations');
const TENANT_MIGRATIONS = join(BACKEND, 'src/infrastructure/prisma/tenant/migrations');

const C = {
  red: (s) => `\x1b[91m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[93m${s}\x1b[0m`,
  blue: (s) => `\x1b[94m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function migrationFolders(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function readMigrationSql(dir, name) {
  const path = join(dir, name, 'migration.sql');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

// ── Reading what a database has already applied ────────────────────────────

async function withClient(connectionString, fn) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * What this target still needs, registry and per tenant schema. Every read
 * either succeeds or stops the deploy: see `migration-state.mjs` for why none
 * of them may fall back to "nothing there".
 */
async function pendingFor(connectionString) {
  const folders = {
    registry: migrationFolders(REGISTRY_MIGRATIONS),
    tenant: migrationFolders(TENANT_MIGRATIONS),
  };
  return withClient(connectionString, (client) => readMigrationState(client, folders));
}

// ── Running the actual migration commands ──────────────────────────────────

function run(script, env, label) {
  const command = `pnpm --filter @mechanization/backend ${script}`;
  process.stdout.write(C.dim(`\n$ ${command}\n`));
  /*
    One command string through a shell, and no `args` array beside it.

    Both halves are load-bearing on Windows. Spawning `pnpm.cmd` directly — what
    this used to do — has thrown `EINVAL` since Node 20.12 hardened `.cmd`
    execution (CVE-2024-27980), so the deploy failed before it reached a
    database with "Registry migration could not start". And passing `args`
    *alongside* `shell: true` is what DEP0190 warns about, because the shell
    concatenates them rather than escaping them.

    Interpolating `script` into the string is safe here and only here: every
    call site below passes a literal from this file, never anything read from
    a dotenv, an argv or a database.
  */
  const result = spawnSync(command, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

/**
 * Proves the migrations landed on the database we aimed at, all of them.
 *
 * Prisma loads `apps/backend/.env` of its own accord — it says so in its output
 * — on top of the environment this script hands it. dotenv does not overwrite
 * variables that are already set, so the injected URL wins, but "does not
 * overwrite" is a library's default behaviour and this is the one decision in
 * the repository that must not rest on one. So we go and look: reconnect to the
 * target's own DIRECT_URL and read the whole state again.
 *
 * The whole state, not just the registry. This used to re-read only
 * `_prisma_migrations`, so a tenant run that exited 0 without recording
 * anything, or recorded it somewhere else, reported "up to date" unchecked.
 */
async function verifyApplied(connectionString) {
  const after = await pendingFor(connectionString);
  if (!isUpToDate(after)) {
    const left = [
      ...after.registryPending.map((m) => `registry/${m}`),
      ...after.tenantPending.flatMap((t) => t.pending.map((m) => `${t.slug}/${m}`)),
    ];
    throw new Error(
      'Migrations reported success but are not recorded on the target database:\n' +
        left.map((m) => `    ✗ ${m}`).join('\n') +
        '\n  Something redirected the connection. Do not re-run — check which database was written.',
    );
  }
  // Named from its parts, never by masking the URL. The password may contain
  // `@` or `:` (`parseConnection` allows both), and a regex mask then printed
  // part of it into CI logs.
  const where = parseConnection(connectionString);
  console.log(C.green(`  ✓ Verified on ${where.user}@${where.host}/${where.database}`));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const targetName = positional[0] ?? value('target');
  if (!targetName) {
    throw new TargetError(
      `No target given.\n  Usage: node scripts/db/deploy.mjs <${Object.keys(TARGETS).join('|')}> [--dry-run]`,
    );
  }

  const check = flag('check');
  const dryRun = flag('dry-run') || check;
  const target = resolveTarget(targetName);
  const isProduction = target.name === 'production';

  console.log('');
  console.log(C.bold('  Target      ') + (isProduction ? C.red(target.label) : C.blue(target.label)));
  console.log(C.bold('  Database    ') + `${target.database} (as ${target.user} via ${target.host})`);
  console.log(C.bold('  Env file    ') + target.envFile);
  console.log(C.bold('  Mode        ') + (dryRun ? C.yellow('dry run — nothing will be applied') : 'apply'));

  // ── What is pending ─────────────────────────────────────────────────────
  const pending = await pendingFor(target.env.DIRECT_URL);
  const nothingPending = isUpToDate(pending);

  // Before "nothing to apply" can be believed: zero municipalities on the live
  // register means the read went somewhere else, not that there is no work.
  if (isProduction) {
    const problems = productionProblems(pending);
    if (problems.length > 0) throw new Error(problems.join('\n'));
  }

  console.log('');
  console.log(C.bold('  Registry migrations pending: ') + (pending.registryPending.length || 'none'));
  for (const m of pending.registryPending) console.log(`    · ${m}`);

  console.log(
    C.bold('  Tenant schemas: ') +
      `${pending.tenantCount} provisioned, ` +
      `${pending.tenantPendingUnion.length || 'no'} distinct migration(s) pending`,
  );
  for (const t of pending.tenantPending.filter((t) => t.pending.length > 0)) {
    console.log(`    · ${t.slug} (${t.schema}): ${t.pending.join(', ')}`);
  }

  // A pending migration that sorts before one already applied is either a
  // number merged late from a parallel branch, which happens here and is fine,
  // or a history row someone deleted, in which case applying re-runs SQL that
  // already ran. Nothing here can tell which, so it is said out loud.
  const outOfOrder = [
    ...pending.registryOutOfOrder.map((m) => `registry/${m}`),
    ...pending.tenantPending.flatMap((t) => t.outOfOrder.map((m) => `${t.slug}/${m}`)),
  ];
  if (outOfOrder.length > 0) {
    console.log(C.yellow('\n  Pending migrations that sort before one already applied:'));
    for (const m of outOfOrder) console.log(C.yellow(`    ! ${m}`));
    console.log(
      C.yellow('    A late merge from a parallel branch is fine. A deleted history row is not:\n') +
        C.yellow('    applying would re-run SQL that has already run.'),
    );
  }

  if (nothingPending) {
    console.log(C.green('\n  ✓ Already up to date — nothing to apply.\n'));
    return;
  }

  // ── Destructive DDL ─────────────────────────────────────────────────────
  const findings = [
    ...pending.registryPending.flatMap((m) =>
      scanSql(`registry/${m}`, readMigrationSql(REGISTRY_MIGRATIONS, m)),
    ),
    ...pending.tenantPendingUnion.flatMap((m) =>
      scanSql(`tenant/${m}`, readMigrationSql(TENANT_MIGRATIONS, m)),
    ),
  ];
  const blocking = findings.filter((f) => f.level === 'blocking');
  const warnings = findings.filter((f) => f.level === 'warning');

  if (warnings.length > 0) {
    console.log(C.yellow('\n  Lock-risk statements in pending migrations:'));
    for (const w of warnings) console.log(C.yellow(`    ! ${w.migration}: ${w.what}`));
  }

  if (blocking.length > 0) {
    console.log(C.red('\n  Irreversible DDL in pending migrations:'));
    for (const b of blocking) console.log(C.red(`    ✗ ${b.migration}: ${b.what}`));
    if (!flag('allow-destructive')) {
      throw new Error(
        'Refusing to apply migrations that can lose data.\n' +
          '  If this drop is the contract half of a completed expand/contract cycle,\n' +
          '  re-run with --allow-destructive. If it is not, split it into one.\n' +
          '  See docs/database-environments.md.',
      );
    }
    console.log(C.yellow('\n  --allow-destructive given; proceeding.'));
  }

  // ── Promotion gate ──────────────────────────────────────────────────────
  //
  // Production may only receive migrations staging has already survived. This
  // is the check that turns "we have a staging environment" into "staging is
  // load-bearing" — without it, nothing stops a migration reaching production
  // having never run anywhere else.
  if (isProduction && !flag('skip-promotion-check')) {
    // Either file will do: `local` and `staging` are pinned to the same
    // database and role, so whichever exists names the staging database. CI
    // writes `.env.staging`; a developer machine has only `.env`. Demanding
    // the one a laptop does not have would make `--skip-promotion-check` the
    // normal way to deploy, and a check that is always skipped is not a check.
    const stagingName = ['staging', 'local'].find((n) => existsSync(join(ROOT, TARGETS[n].envFile)));
    if (!stagingName) {
      throw new Error(
        `Cannot verify promotion: neither ${TARGETS.staging.envFile} nor ${TARGETS.local.envFile} exists.\n` +
          '  Production deploys check that staging already has these migrations.\n' +
          '  Create one of them, or pass --skip-promotion-check for a hotfix.',
      );
    }
    const stagingTarget = resolveTarget(stagingName);
    // Staging's own refusals (a missing history, an unreadable registry) would
    // otherwise surface under the PRODUCTION header, reading as if production
    // were the database at fault.
    let stagingPending;
    try {
      stagingPending = await pendingFor(stagingTarget.env.DIRECT_URL);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Promotion check could not read staging (${stagingTarget.database}), so it cannot vouch for anything:\n${reason}`,
      );
    }

    const problems = promotionProblems(pending, stagingPending);
    if (problems.length > 0) {
      throw new Error(
        problems.join('\n') + `\n  Deploy to staging first: pnpm db:deploy:${stagingName}`,
      );
    }
    console.log(C.green('\n  ✓ Promotion check: every pending migration is already live on staging.'));
  } else if (isProduction) {
    console.log(C.yellow('\n  ! Promotion check skipped (--skip-promotion-check).'));
  }

  if (dryRun) {
    console.log(C.yellow('\n  Dry run complete — nothing was applied.\n'));
    // Only reached with something pending and every check above passed; up to
    // date returned early, and a refusal threw. A distinct code, so a pipeline
    // can branch on "there is work" without reading the output.
    if (check) process.exitCode = PENDING_EXIT_CODE;
    return;
  }

  // ── Confirmation ────────────────────────────────────────────────────────
  if (isProduction) {
    const supplied = value('confirm');
    if (supplied !== undefined) {
      if (supplied !== target.database) {
        throw new Error(
          `--confirm=${supplied} does not match the production database ${target.database}. Refusing.`,
        );
      }
    } else if (!stdin.isTTY) {
      throw new Error(
        'Production deploy needs confirmation and there is no terminal to ask.\n' +
          `  In CI, pass --confirm=${target.database} explicitly.`,
      );
    } else {
      console.log(
        C.red('\n  This writes to PRODUCTION — live municipal records, real citizens.'),
      );
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(`  Type the database name (${target.database}) to continue: `);
      rl.close();
      if (answer.trim() !== target.database) {
        throw new Error('Confirmation did not match. Nothing was applied.');
      }
    }
  }

  // ── Apply ───────────────────────────────────────────────────────────────
  const env = {
    ...process.env,
    ...target.env,
    NODE_ENV: target.nodeEnv,
    // Belt for the tenant loop: migrate-all-tenants.ts prefers DIRECT_URL, but
    // being explicit here means a stale shell export cannot redirect it.
    DATABASE_URL: target.env.DATABASE_URL,
    DIRECT_URL: target.env.DIRECT_URL,
  };

  if (pending.registryPending.length > 0) {
    run('prisma:deploy:registry', env, 'Registry migration');
  }
  if (pending.tenantPendingUnion.length > 0) {
    run('tenant:migrate-all', env, 'Tenant migration');
  }

  console.log('');
  await verifyApplied(target.env.DIRECT_URL);

  console.log(C.green(`\n  ✓ ${target.label} is up to date.\n`));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${C.red('✗')} ${message}\n`);
  process.exit(1);
});
