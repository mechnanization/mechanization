#!/usr/bin/env node
/**
 * Deletes all citizens and all buildings (and their associated census, filing,
 * and property records) from the LOCAL development database.
 *
 * Usage:
 *   node scripts/db/delete-local-citizens-and-buildings.mjs [--yes] [--tenant=<slug>]
 *   pnpm db:delete:citizens-buildings [--yes] [--tenant=<slug>]
 *
 * SAFETY:
 * This script is strictly hard-pinned to the local development database (`municipality_db_local`
 * on 127.0.0.1/localhost). It will categorically REFUSE to run against staging or production.
 *
 * What it deletes:
 *   - Citizens (`users` WHERE `kind = 'CITIZEN'`)
 *   - Citizen registrations (`registrations`, `property_entries`, `building_units`, `documents`, `citizen_merges`)
 *   - Quality & audit checks on files (`record_reviews`, `quality_checks`, `data_quality_dismissals`)
 *   - Citizen requests & attachments (`citizen_requests`, `citizen_request_attachments`)
 *   - Buildings & census records (`buildings`, `building_code_aliases`, `units`, `unit_occupancies`, `unit_visits`, `unit_vacancy_confirmations`, `damage_assessments`, `cases`)
 *   - Associated billing & payments linked to citizens or units (`citizen_payments`, `fee_notices`, `citizen_payment_debtors`, `payment_transactions`, `payment_settlements`, `whish_checkouts`, `billing_run_entries`)
 *   - Short-lived citizen OTP challenges (`otp_challenges`)
 *
 * What it PRESERVES:
 *   - Staff accounts (`users` WHERE `kind = 'STAFF'`)
 *   - Staff refresh tokens (`staff_refresh_tokens`)
 *   - Municipal boundaries and cadastral parcels (`parcels`, `zones`)
 *   - System settings (`system_settings`)
 *   - Treasury configuration & primary wallets (`treasury_accounts`, etc.)
 *   - Registry tenants (`public.tenants`)
 *   - Applied migrations history (`_tenant_migrations`, `_prisma_migrations`)
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ROOT, resolveTarget, parseConnection } from './targets.mjs';

const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

const C = {
  red: (s) => `\x1b[91m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[93m${s}\x1b[0m`,
  cyan: (s) => `\x1b[96m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function fail(msg) {
  console.error(C.red(`\n✗ ${msg}`));
  process.exit(1);
}

async function confirmExecution(autoConfirm, targetDesc) {
  if (autoConfirm) return;
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(
    C.yellow(
      '\n⚠️  WARNING: This will permanently delete ALL citizens, registrations, property cards, buildings, units, and census records'
    )
  );
  console.log(
    C.yellow(
      `   in your LOCAL database for ${targetDesc}. (Staff accounts, cadastre parcels and zones remain intact).`
    )
  );
  const answer = await rl.question(C.bold('\nType "delete" to proceed: '));
  rl.close();
  if (answer.trim() !== 'delete') {
    fail('Aborted by user.');
  }
}

async function tableExists(client, schema, table) {
  const res = await client.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
    [schema, table]
  );
  return res.rows.length > 0;
}

export async function deleteCitizensAndBuildings({ tenantSlug = null, autoConfirm = false } = {}) {
  // 1. Strict Target Validation
  let resolved;
  try {
    resolved = resolveTarget('local');
  } catch (err) {
    fail(`Could not resolve local target: ${err.message}`);
  }

  const dbUrl = resolved.env.DIRECT_URL ?? resolved.env.DATABASE_URL;
  const parsed = parseConnection(dbUrl);
  if (!parsed) {
    fail('Could not parse database connection string from local env file.');
  }

  const isLoopback = parsed.host.startsWith('127.0.0.1') || parsed.host.startsWith('localhost');
  const isLocalDb = parsed.database === 'municipality_db_local';

  if (!isLoopback || !isLocalDb) {
    fail(
      `REFUSED: Script can only run against municipality_db_local on loopback! Connected to: ${parsed.user}@${parsed.host}/${parsed.database}`
    );
  }

  console.log(`Target verified: ${C.green(`${parsed.user}@${parsed.host}/${parsed.database}`)}`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // 2. Discover tenant schemas
    let tenantQuery = 'SELECT slug, "schemaName" FROM public.tenants WHERE "schemaName" IS NOT NULL';
    const params = [];
    if (tenantSlug) {
      tenantQuery += ' AND slug = $1';
      params.push(tenantSlug);
    }
    tenantQuery += ' ORDER BY slug';

    const tenantRes = await client.query(tenantQuery, params);
    const tenants = tenantRes.rows;

    if (tenants.length === 0) {
      if (tenantSlug) {
        fail(`Tenant slug "${tenantSlug}" was not found in public.tenants.`);
      } else {
        console.log(C.yellow('No tenant schemas found in public.tenants. Nothing to delete.'));
        return;
      }
    }

    const targetDesc = tenantSlug ? `tenant "${tenantSlug}"` : `all ${tenants.length} tenants (${tenants.map((t) => t.slug).join(', ')})`;
    await confirmExecution(autoConfirm, targetDesc);

    for (const tenant of tenants) {
      const s = tenant.schemaName;
      console.log(C.bold(`\nDeleting citizens and buildings in schema: ${s} (${tenant.slug})...`));

      // Verify schema exists
      const schemaCheck = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [s]);
      if (schemaCheck.rows.length === 0) {
        console.log(C.dim(`  Schema "${s}" does not exist in DB, skipping.`));
        continue;
      }

      await client.query('BEGIN');

      try {
        // 2a. Citizen requests and attachments
        if (await tableExists(client, s, 'citizen_requests')) {
          await client.query(`ALTER TABLE "${s}".citizen_requests DISABLE TRIGGER USER`);
          if (await tableExists(client, s, 'citizen_request_attachments')) {
            await client.query(`DELETE FROM "${s}".citizen_request_attachments`);
          }
          await client.query(`DELETE FROM "${s}".citizen_requests`);
          await client.query(`ALTER TABLE "${s}".citizen_requests ENABLE TRIGGER USER`);
        }

        // 2b. Billing & payment tables referencing citizens or units
        const moneyTables = [
          'payment_transactions',
          'payment_settlements',
          'whish_checkouts',
          'citizen_payment_debtors',
          'citizen_payments',
          'billing_run_entries',
          'fee_notices',
        ];
        const existingMoneyTables = await client.query(
          'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2)',
          [s, moneyTables]
        );
        if (existingMoneyTables.rows.length > 0) {
          const toTruncate = existingMoneyTables.rows.map((r) => `"${s}"."${r.table_name}"`).join(', ');
          await client.query(`TRUNCATE TABLE ${toTruncate} CASCADE`);
        }

        // Reset payment receipt sequence if present
        const seqCheck = await client.query(
          'SELECT 1 FROM information_schema.sequences WHERE sequence_schema = $1 AND sequence_name = $2',
          [s, 'payment_receipt_seq']
        );
        if (seqCheck.rows.length > 0) {
          await client.query(`ALTER SEQUENCE "${s}".payment_receipt_seq RESTART WITH 1`);
        }

        // Clear billing document counters
        if (await tableExists(client, s, 'document_counters')) {
          await client.query(
            `DELETE FROM "${s}".document_counters WHERE kind IN ('INVOICE', 'RECEIPT', 'BULK_RECEIPT')`
          );
        }

        // 2c. Census children & cases
        const censusChildren = [
          'cases',
          'damage_assessments',
          'unit_vacancy_confirmations',
          'unit_visits',
          'unit_occupancies',
        ];
        for (const t of censusChildren) {
          if (await tableExists(client, s, t)) {
            await client.query(`DELETE FROM "${s}"."${t}"`);
          }
        }

        // 2d. Registration children
        const regChildren = [
          'building_units',
          'documents',
          'quality_checks',
          'record_reviews',
          'data_quality_dismissals',
          'property_entries',
          'registrations',
          'citizen_merges',
          'otp_challenges',
        ];
        for (const t of regChildren) {
          if (await tableExists(client, s, t)) {
            await client.query(`DELETE FROM "${s}"."${t}"`);
          }
        }

        // 2e. Buildings & units
        if (await tableExists(client, s, 'building_code_aliases')) {
          await client.query(`DELETE FROM "${s}".building_code_aliases`);
        }
        if (await tableExists(client, s, 'units')) {
          await client.query(`DELETE FROM "${s}".units`);
        }
        if (await tableExists(client, s, 'buildings')) {
          await client.query(`DELETE FROM "${s}".buildings`);
        }

        // 2f. Citizens from users table (STAFF ACCOUNTS ARE PRESERVED)
        if (await tableExists(client, s, 'users')) {
          const citizenRes = await client.query(`DELETE FROM "${s}".users WHERE kind = 'CITIZEN'`);
          console.log(`  - Removed ${citizenRes.rowCount} citizen user record(s).`);
        }

        await client.query('COMMIT');
        console.log(C.green(`  ✓ ${s} cleaned successfully.`));
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    // 3. Post-deletion Reconnect & Verification
    console.log(C.bold('\n--- Post-Deletion Verification ---'));
    for (const tenant of tenants) {
      const s = tenant.schemaName;
      const verifyCounts = await client.query(`
        SELECT
          (SELECT count(*) FROM "${s}".users WHERE kind = 'CITIZEN') as citizens,
          (SELECT count(*) FROM "${s}".users WHERE kind = 'STAFF') as staff,
          (SELECT count(*) FROM "${s}".buildings) as buildings,
          (SELECT count(*) FROM "${s}".units) as units,
          (SELECT count(*) FROM "${s}".registrations) as registrations,
          (SELECT count(*) FROM "${s}".property_entries) as property_entries,
          (SELECT count(*) FROM "${s}".building_units) as building_units,
          (SELECT count(*) FROM "${s}".cases) as cases,
          (SELECT count(*) FROM "${s}".parcels) as parcels,
          (SELECT count(*) FROM "${s}".zones) as zones
      `);

      const r = verifyCounts.rows[0];
      console.log(`\nTenant ${C.bold(tenant.slug)} (${s}):`);
      console.log(`  - Citizens (users WHERE kind = 'CITIZEN'): ${r.citizens === '0' ? C.green('0 (Clean)') : C.red(r.citizens)}`);
      console.log(`  - Buildings (buildings):                 ${r.buildings === '0' ? C.green('0 (Clean)') : C.red(r.buildings)}`);
      console.log(`  - Units (units):                         ${r.units === '0' ? C.green('0 (Clean)') : C.red(r.units)}`);
      console.log(`  - Registrations (registrations):         ${r.registrations === '0' ? C.green('0 (Clean)') : C.red(r.registrations)}`);
      console.log(`  - Property Cards (property_entries):     ${r.property_entries === '0' ? C.green('0 (Clean)') : C.red(r.property_entries)}`);
      console.log(`  - Building Units (building_units):       ${r.building_units === '0' ? C.green('0 (Clean)') : C.red(r.building_units)}`);
      console.log(`  - Cases (cases):                         ${r.cases === '0' ? C.green('0 (Clean)') : C.red(r.cases)}`);
      console.log(`  - Staff Accounts (Preserved):            ${C.cyan(`${r.staff} accounts`)}`);
      console.log(`  - Cadastre Parcels (Preserved):          ${C.cyan(`${r.parcels} parcels`)}`);
      console.log(`  - Zones (Preserved):                     ${C.cyan(`${r.zones} zones`)}`);

      if (r.citizens !== '0' || r.buildings !== '0' || r.units !== '0' || r.registrations !== '0') {
        throw new Error(`Verification failed for tenant ${tenant.slug}: some citizen/building records still remain.`);
      }
    }

    console.log(C.green('\n✓ Cleanup complete. All citizens and buildings deleted from local DB successfully!\n'));
  } catch (err) {
    fail(`Cleanup failed: ${err.message}\n${err.stack}`);
  } finally {
    await client.end();
  }
}

// Direct execution CLI entrypoint
const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  const args = process.argv.slice(2);
  const autoConfirm = args.includes('--yes') || args.includes('-y') || args.includes('--confirm=local');
  const tenantArg = args.find((a) => a.startsWith('--tenant='));
  const tenantSlug = tenantArg ? tenantArg.split('=')[1].trim() : null;

  console.log(C.bold('--- Delete Local Citizens and Buildings ---'));
  deleteCitizensAndBuildings({ tenantSlug, autoConfirm }).catch((err) => fail(err.message));
}
