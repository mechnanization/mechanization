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
 *   1. The env file's connection strings belong to the project the target is
 *      pinned to (`targets.mjs`).
 *   2. Nothing is pending that this script has not read — it lists the exact
 *      migrations it is about to apply, per tenant schema included.
 *   3. Pending SQL is scanned for irreversible DDL. `DROP COLUMN` on a table of
 *      citizen records is not something to discover from a stack trace, so it
 *      blocks unless the caller says `--allow-destructive` out loud.
 *   4. Production only: every migration about to be applied is already applied
 *      on staging. Promotion, not a parallel path.
 *   5. Production only: a typed confirmation of the project ref.
 *
 * Options:
 *   --dry-run              Report everything above, apply nothing. Safe anywhere.
 *   --allow-destructive    Permit migrations containing data-losing DDL.
 *   --confirm=<ref>        Non-interactive confirmation, for CI. Must equal the
 *                          target's own ref, so a copied staging command cannot
 *                          fire at production.
 *   --skip-promotion-check Bypass (4). For a genuine hotfix; it is logged loudly.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, TARGETS, resolveTarget, TargetError } from './targets.mjs';

const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

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
const DESTRUCTIVE = [
  { level: 'blocking', re: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { level: 'blocking', re: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { level: 'blocking', re: /\bDROP\s+SCHEMA\b/i, what: 'DROP SCHEMA' },
  { level: 'blocking', re: /\bTRUNCATE\b/i, what: 'TRUNCATE' },
  { level: 'blocking', re: /\bALTER\s+COLUMN\s+.*\bTYPE\b/i, what: 'ALTER COLUMN … TYPE' },
  { level: 'blocking', re: /\bRENAME\s+(COLUMN|TO)\b/i, what: 'RENAME' },
  { level: 'warning', re: /\bSET\s+NOT\s+NULL\b/i, what: 'SET NOT NULL (full table scan + lock)' },
  {
    level: 'warning',
    re: /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i,
    what: 'CREATE INDEX without CONCURRENTLY (write lock)',
  },
  { level: 'warning', re: /\bDROP\s+CONSTRAINT\b/i, what: 'DROP CONSTRAINT' },
];

/** Strips -- and /* *\/ comments so a commented-out DROP does not trip the scanner. */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function scanSql(name, sql) {
  const clean = stripSqlComments(sql);
  return DESTRUCTIVE.filter((rule) => rule.re.test(clean)).map((rule) => ({
    migration: name,
    level: rule.level,
    what: rule.what,
  }));
}

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

async function appliedRegistry(client) {
  const { rows } = await client.query(`
    select migration_name from _prisma_migrations
    where finished_at is not null and rolled_back_at is null
  `).catch(() => ({ rows: [] }));
  return new Set(rows.map((r) => r.migration_name));
}

/** Every provisioned tenant schema, and the migrations each has seen. */
async function appliedTenants(client) {
  const { rows: tenants } = await client
    // `@@map("tenants")` in the registry schema — the table is not "Tenant".
    .query(`select slug, "schemaName" from public.tenants where "provisionedAt" is not null order by slug`)
    .catch(() => ({ rows: [] }));

  const out = [];
  for (const tenant of tenants) {
    const { rows } = await client
      .query(`select name from "${tenant.schemaName}"."_tenant_migrations"`)
      .catch(() => ({ rows: [] }));
    out.push({
      slug: tenant.slug,
      schema: tenant.schemaName,
      applied: new Set(rows.map((r) => r.name)),
    });
  }
  return out;
}

/** What this target still needs, registry and per tenant schema. */
async function pendingFor(connectionString) {
  const registryAll = migrationFolders(REGISTRY_MIGRATIONS);
  const tenantAll = migrationFolders(TENANT_MIGRATIONS);

  return withClient(connectionString, async (client) => {
    const registryApplied = await appliedRegistry(client);
    const tenants = await appliedTenants(client);

    const registryPending = registryAll.filter((m) => !registryApplied.has(m));
    const tenantPending = tenants.map((t) => ({
      ...t,
      pending: tenantAll.filter((m) => !t.applied.has(m)),
    }));

    // Union across schemas — the set of tenant SQL this deploy will execute
    // somewhere, which is what the destructive scan and promotion gate care about.
    const tenantPendingUnion = [
      ...new Set(tenantPending.flatMap((t) => t.pending)),
    ].sort((a, b) => a.localeCompare(b));

    return { registryPending, tenantPending, tenantPendingUnion, tenantCount: tenants.length };
  });
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
 * Proves the migrations landed on the database we aimed at.
 *
 * Prisma loads `apps/backend/.env` of its own accord — it says so in its output
 * — on top of the environment this script hands it. dotenv does not overwrite
 * variables that are already set, so the injected URL wins, but "does not
 * overwrite" is a library's default behaviour and this is the one decision in
 * the repository that must not rest on one. So we go and look: reconnect to the
 * target's own DIRECT_URL and confirm the rows are there.
 */
async function verifyApplied(connectionString, expectedRegistry) {
  if (expectedRegistry.length === 0) return;
  const applied = await withClient(connectionString, appliedRegistry);
  const missing = expectedRegistry.filter((m) => !applied.has(m));
  if (missing.length > 0) {
    throw new Error(
      'Migrations reported success but are not recorded on the target database:\n' +
        missing.map((m) => `    ✗ ${m}`).join('\n') +
        '\n  Something redirected the connection. Do not re-run — check which database was written.',
    );
  }
  console.log(C.green(`  ✓ Verified on ${connectionString.replace(/:[^:@]*@/, ':***@')}`));
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

  const dryRun = flag('dry-run');
  const target = resolveTarget(targetName);
  const isProduction = target.name === 'production';

  console.log('');
  console.log(C.bold('  Target      ') + (isProduction ? C.red(target.label) : C.blue(target.label)));
  console.log(C.bold('  Project     ') + target.ref);
  console.log(C.bold('  Env file    ') + target.envFile);
  console.log(C.bold('  Mode        ') + (dryRun ? C.yellow('dry run — nothing will be applied') : 'apply'));

  // ── What is pending ─────────────────────────────────────────────────────
  const pending = await pendingFor(target.env.DIRECT_URL);
  const nothingPending =
    pending.registryPending.length === 0 && pending.tenantPendingUnion.length === 0;

  console.log('');
  console.log(C.bold('  Registry migrations pending: ') + (pending.registryPending.length || 'none'));
  for (const m of pending.registryPending) console.log(`    · ${m}`);

  console.log(
    C.bold('  Tenant schemas: ') +
      `${pending.tenantCount} provisioned, ` +
      `${pending.tenantPendingUnion.length || 'no'} distinct migration(s) pending`,
  );
  for (const t of pending.tenantPending.filter((t) => t.pending.length > 0)) {
    console.log(`    · ${t.slug} (${t.schema}): ${t.pending.length} pending`);
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
    const staging = TARGETS.staging;
    if (!existsSync(join(ROOT, staging.envFile))) {
      throw new Error(
        `Cannot verify promotion: ${staging.envFile} does not exist.\n` +
          '  Production deploys check that staging already has these migrations.\n' +
          '  Create the staging env file, or pass --skip-promotion-check for a hotfix.',
      );
    }
    const stagingTarget = resolveTarget('staging');
    const stagingPending = await pendingFor(stagingTarget.env.DIRECT_URL);

    const notOnStaging = [
      ...pending.registryPending.filter((m) => stagingPending.registryPending.includes(m)).map((m) => `registry/${m}`),
      ...pending.tenantPendingUnion.filter((m) => stagingPending.tenantPendingUnion.includes(m)).map((m) => `tenant/${m}`),
    ];

    if (notOnStaging.length > 0) {
      throw new Error(
        'These migrations have not been applied to staging yet:\n' +
          notOnStaging.map((m) => `    ✗ ${m}`).join('\n') +
          '\n  Deploy to staging first: pnpm db:deploy:staging',
      );
    }
    console.log(C.green('\n  ✓ Promotion check: every pending migration is already live on staging.'));
  } else if (isProduction) {
    console.log(C.yellow('\n  ! Promotion check skipped (--skip-promotion-check).'));
  }

  if (dryRun) {
    console.log(C.yellow('\n  Dry run complete — nothing was applied.\n'));
    return;
  }

  // ── Confirmation ────────────────────────────────────────────────────────
  if (isProduction) {
    const supplied = value('confirm');
    if (supplied !== undefined) {
      if (supplied !== target.ref) {
        throw new Error(
          `--confirm=${supplied} does not match the production ref ${target.ref}. Refusing.`,
        );
      }
    } else if (!stdin.isTTY) {
      throw new Error(
        'Production deploy needs confirmation and there is no terminal to ask.\n' +
          `  In CI, pass --confirm=${target.ref} explicitly.`,
      );
    } else {
      console.log(
        C.red('\n  This writes to PRODUCTION — live municipal records, real citizens.'),
      );
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(`  Type the project ref (${target.ref}) to continue: `);
      rl.close();
      if (answer.trim() !== target.ref) {
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
  await verifyApplied(target.env.DIRECT_URL, pending.registryPending);

  console.log(C.green(`\n  ✓ ${target.label} is up to date.\n`));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${C.red('✗')} ${message}\n`);
  process.exit(1);
});
