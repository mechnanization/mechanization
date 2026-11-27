#!/usr/bin/env node
/**
 * Provisions a municipality against a named target.
 *
 *   node scripts/db/provision.mjs <local|staging|production> \
 *     --slug albazourieh --name "Al-Bazourieh" --name-ar "البازورية" --prefix BZR
 *
 * `pnpm tenant:provision` reads whatever `apps/backend/.env` says, which the
 * guard pins to the local database — so until now there was no supported way to onboard a
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
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, TARGETS, resolveTarget, TargetError } from './targets.mjs';
import { isTenantSlug, tenantSchemaNameFor } from './tenant-schema-name.mjs';
import { C, absentIfMissing, backendRequire, withClient } from './lib.mjs';

const TENANT_MIGRATIONS = join(
  ROOT,
  'apps/backend/src/infrastructure/prisma/tenant/migrations',
);

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

/** Reads the target back. An exit code says a command ran, not that it worked. */
async function inspect(connectionString, slug, schemaName) {
  return withClient(connectionString, async (client) => {
    const reg = await absentIfMissing(
      client.query('select id, slug, "schemaName", "provisionedAt", "adminPathSegment" from public.tenants where slug = $1', [slug]),
      { rows: [] },
    );
    const schema = await client.query('select 1 from pg_namespace where nspname = $1', [schemaName]);
    const applied = await absentIfMissing(
      client.query(`select count(*)::int as n from "${schemaName}"."_tenant_migrations"`),
      { rows: [{ n: 0 }] },
    );
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

  // The schema is built from the slug and interpolated into SQL below, so the slug is held to
  // `TenantSlug`'s rule before anything is resolved (DRY-10). `tenant:provision` checks it again.
  if (!isTenantSlug(slug)) {
    throw new TargetError(
      `--slug '${slug}' is not a municipality slug: 2–50 lower-case letters and digits, joined by single hyphens.`,
    );
  }

  const target = resolveTarget(targetName);
  const isProduction = target.name === 'production';
  const schemaName = tenantSchemaNameFor(slug);
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

  /*
    Node, not pnpm — and no shell.

    `pnpm.cmd` used to run here. Since Node 20.12 hardened `.cmd` execution
    (CVE-2024-27980), spawning it with an args array throws `EINVAL`, so every
    Windows call ended in "Provisioning could not start". `deploy.mjs` gets
    around that with `shell: true`, but every argument below is user-supplied
    (`--name` is Arabic text, `--slug` and `--prefix` are also caller-controlled),
    and interpolating any of them into a shell string is the classic path to
    command injection. So this bypasses the shell entirely: `node` on the
    ts-node bin, with the arguments passed as an array Node hands to CreateProcess
    directly. No quoting, no metacharacters, no `.cmd`.

    The bin paths are resolved through the backend's own `package.json`
    (`backendRequire`, `lib.mjs`), so pnpm's strict linking still finds them.
  */
  const tsNodeBin = backendRequire.resolve('ts-node/dist/bin.js');
  const tsconfigPathsRegister = backendRequire.resolve('tsconfig-paths/register');
  const script = join(ROOT, 'apps/backend/src/scripts/provision-tenant.ts');

  const scriptArgs = ['--slug', slug, '--name', name, '--name-ar', nameAr];
  if (prefix) scriptArgs.push('--prefix', prefix);

  const nodeArgs = [tsNodeBin, '-r', tsconfigPathsRegister, script, ...scriptArgs];

  process.stdout.write(C.dim(`\n$ node ${nodeArgs.map((a) => JSON.stringify(a)).join(' ')}\n`));
  // cwd is the backend so ts-node finds `apps/backend/tsconfig.json` on its own.
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: join(ROOT, 'apps', 'backend'),
    env,
    stdio: 'inherit',
  });
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
