#!/usr/bin/env node
/**
 * Provisions a municipality against a named target.
 *
 *   node scripts/db/provision.mjs <local|staging|production> \
 *     --slug albazourieh --name "Al-Bazourieh" --name-ar "البازورية" --prefix BZR
 *
 * `pnpm tenant:provision` reads whatever `apps/backend/.env` says, which the
 * guard pins to staging — so until now there was no supported way to onboard a
 * municipality onto production at all. The gap mattered: provisioning is the one
 * operation that CREATES a citizen data store, and "run it from a laptop with the
 * right dotenv file" is exactly the shape of mistake `targets.mjs` exists to stop.
 *
 * This is the same wrapper as deploy.mjs — same ref pinning, same typed
 * confirmation for production — around `tenant:provision`, plus a verification
 * pass afterwards that reads the target back rather than trusting the exit code.
 *
 * Options:
 *   --dry-run          Resolve, check and report. Creates nothing.
 *   --confirm=<ref>    Non-interactive confirmation for CI.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, TARGETS, resolveTarget, TargetError } from './targets.mjs';

const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

const TENANT_MIGRATIONS = join(
  ROOT,
  'apps/backend/src/infrastructure/prisma/tenant/migrations',
);

const C = {
  red: (s) => `\x1b[91m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[93m${s}\x1b[0m`,
  blue: (s) => `\x1b[94m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

async function withClient(connectionString, fn) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Reads the target back. An exit code says a command ran, not that it worked. */
async function inspect(connectionString, slug, schemaName) {
  return withClient(connectionString, async (client) => {
    const reg = await client
      .query('select id, slug, "schemaName", "provisionedAt", "adminPathSegment" from public.tenants where slug = $1', [slug])
      .catch(() => ({ rows: [] }));
    const schema = await client
      .query('select 1 from pg_namespace where nspname = $1', [schemaName])
      .catch(() => ({ rows: [] }));
    const applied = await client
      .query(`select count(*)::int as n from "${schemaName}"."_tenant_migrations"`)
      .catch(() => ({ rows: [{ n: 0 }] }));
    return {
      registryRow: reg.rows[0] ?? null,
      schemaExists: schema.rows.length > 0,
      migrationsApplied: applied.rows[0]?.n ?? 0,
    };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const targetName = positional[0];
  const dryRun = argv.includes('--dry-run');

  if (!targetName) {
    throw new TargetError(
      `No target given.\n  Usage: node scripts/db/provision.mjs <${Object.keys(TARGETS).join('|')}> --slug <slug> --name <name> --name-ar <arabic>`,
    );
  }

  const slug = arg(argv, 'slug');
  const name = arg(argv, 'name');
  const nameAr = arg(argv, 'name-ar');
  const prefix = arg(argv, 'prefix');
  if (!slug || !name || !nameAr) {
    throw new TargetError('--slug, --name and --name-ar are all required — a municipality cannot be half-named.');
  }

  const target = resolveTarget(targetName);
  const isProduction = target.name === 'production';
  const schemaName = `tenant_${slug.replace(/-/g, '_')}`;
  const onDisk = existsSync(TENANT_MIGRATIONS)
    ? readdirSync(TENANT_MIGRATIONS, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    : 0;

  console.log('');
  console.log(C.bold('  Target      ') + (isProduction ? C.red(target.label) : C.blue(target.label)));
  console.log(C.bold('  Database    ') + `${target.database} (as ${target.user} via ${target.host})`);
  console.log(C.bold('  Municipality') + `  ${name} (${slug}) → ${schemaName}`);
  console.log(C.bold('  Migrations  ') + `${onDisk} tenant migration(s) on disk`);
  console.log(C.bold('  Mode        ') + (dryRun ? C.yellow('dry run — nothing will be created') : 'apply'));

  const before = await inspect(target.env.DIRECT_URL, slug, schemaName);
  console.log('');
  console.log(C.bold('  Before:'));
  console.log(`    registry row     : ${before.registryRow ? `present (provisionedAt=${before.registryRow.provisionedAt ?? 'null'})` : 'absent'}`);
  console.log(`    schema           : ${before.schemaExists ? 'exists' : 'absent'}`);
  console.log(`    migrations applied: ${before.migrationsApplied}`);

  if (before.registryRow && before.registryRow.schemaName !== schemaName) {
    throw new Error(
      `'${slug}' is already registered against schema '${before.registryRow.schemaName}'.\n` +
        '  Renaming it would orphan every row already written under the old name.',
    );
  }

  if (dryRun) {
    console.log(C.yellow('\n  Dry run complete — nothing was created.\n'));
    return;
  }

  if (isProduction) {
    const supplied = arg(argv, 'confirm');
    if (supplied !== undefined) {
      if (supplied !== target.database) {
        throw new Error(`--confirm=${supplied} does not match the production database ${target.database}. Refusing.`);
      }
    } else if (!stdin.isTTY) {
      throw new Error(`Production provisioning needs confirmation and there is no terminal to ask.\n  Pass --confirm=${target.database}.`);
    } else {
      console.log(C.red('\n  This creates a CITIZEN DATA STORE on PRODUCTION.'));
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(`  Type the database name (${target.database}) to continue: `);
      rl.close();
      if (answer.trim() !== target.database) throw new Error('Confirmation did not match. Nothing was created.');
    }
  }

  const env = {
    ...process.env,
    ...target.env,
    NODE_ENV: target.nodeEnv,
    DATABASE_URL: target.env.DATABASE_URL,
    DIRECT_URL: target.env.DIRECT_URL,
  };

  const args = ['--filter', '@mechanization/backend', 'tenant:provision', '--slug', slug, '--name', name, '--name-ar', nameAr];
  if (prefix) args.push('--prefix', prefix);

  process.stdout.write(C.dim(`\n$ pnpm ${args.join(' ')}\n`));
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) throw new Error(`Provisioning could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Provisioning failed with exit code ${result.status}`);

  // Read the target back. Prisma loads apps/backend/.env of its own accord on top
  // of the environment handed to it, so "the command exited 0" is not evidence
  // about *which* database it exited 0 against.
  const after = await inspect(target.env.DIRECT_URL, slug, schemaName);
  console.log('');
  console.log(C.bold('  After:'));
  console.log(`    registry row     : ${after.registryRow ? `present (provisionedAt=${after.registryRow.provisionedAt ?? 'null'})` : C.red('ABSENT')}`);
  console.log(`    schema           : ${after.schemaExists ? 'exists' : C.red('ABSENT')}`);
  console.log(`    migrations applied: ${after.migrationsApplied} of ${onDisk} on disk`);

  const problems = [];
  if (!after.registryRow) problems.push('registry row was not created on the target');
  if (!after.registryRow?.provisionedAt) problems.push('provisionedAt is still null — the tenant is not servable');
  if (!after.schemaExists) problems.push(`schema ${schemaName} does not exist on the target`);
  if (after.migrationsApplied !== onDisk) {
    problems.push(`${after.migrationsApplied} migrations applied but ${onDisk} exist on disk`);
  }
  if (problems.length > 0) {
    throw new Error('Provisioning reported success but the target disagrees:\n' + problems.map((p) => `    ✗ ${p}`).join('\n'));
  }

  console.log(C.green(`\n  ✓ '${slug}' provisioned and verified on ${target.label}.`));
  console.log(C.dim(`    admin path: /${slug}/ar/${after.registryRow.adminPathSegment}\n`));
}

main().catch((error) => {
  console.error(`\n${C.red('✗')} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
