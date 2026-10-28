#!/usr/bin/env node
/**
 * Resets all financial, treasury, and fee-related data in the LOCAL development database to zero.
 *
 *   node scripts/db/reset-local-money.mjs [--yes]
 *
 * SAFETY:
 * This script is strictly hard-pinned to the local development database (`municipality_db_local`
 * on 127.0.0.1/localhost). It will categorically REFUSE to run against staging or production.
 *
 * What it resets:
 *   - Citizen fee notices, bills, payment transactions, settlements, Whish checkouts, billing runs
 *   - Treasury ledger entries, daily counts, day closures, transfers, expenses, income vouchers
 *   - Inspector payouts
 *   - Document counters for financial books (INV-, RCP-, BRC-, PV-, RV-, TR-)
 *   - Sequences (payment_receipt_seq, expense_voucher_seq, treasury_transfer_seq)
 *   - Resets treasuryGoLiveAt and expense ceilings in system_settings to NULL (pre-go-live)
 *   - Re-creates the 4 clean starting primary wallets (CASH_SAFE & WHISH_ACCOUNT for LBP and USD)
 *     with 0 balance, ready for fresh go-live testing.
 *
 * Citizens, staff accounts, buildings, cadastre, and system settings remain completely intact.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, resolveTarget, parseConnection } from './targets.mjs';

const require = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
const { Client } = require('pg');

const C = {
  red: (s) => `\x1b[91m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[93m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function fail(msg) {
  console.error(C.red(`\n✗ ${msg}`));
  process.exit(1);
}

async function confirmExecution(autoConfirm) {
  if (autoConfirm) return;
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(
    C.yellow(
      '\n⚠️  WARNING: This will permanently wipe all fees, payments, treasury entries, and financial vouchers'
    )
  );
  console.log(C.yellow('   in your LOCAL database (tenants will be reset to pre-go-live with 0 balance).'));
  const answer = await rl.question(C.bold('\nType "reset" to proceed: '));
  rl.close();
  if (answer.trim() !== 'reset') {
    fail('Aborted by user.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const autoConfirm = args.includes('--yes') || args.includes('-y') || args.includes('--confirm=local');

  console.log(C.bold('--- Local Database Money & Treasury Reset ---'));

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

  await confirmExecution(autoConfirm);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // 2. Discover all tenant schemas
    const tenantRes = await client.query('SELECT slug, "schemaName" FROM public.tenants WHERE "schemaName" IS NOT NULL ORDER BY slug');
    const tenants = tenantRes.rows;

    if (tenants.length === 0) {
      console.log(C.yellow('No tenant schemas found in public.tenants. Nothing to reset.'));
      return;
    }

    console.log(`\nFound ${tenants.length} tenant(s): ${tenants.map((t) => t.slug).join(', ')}`);

    for (const tenant of tenants) {
      const s = tenant.schemaName;
      console.log(C.bold(`\nResetting money data in schema: ${s} (${tenant.slug})...`));

      await client.query('BEGIN');

      // Check if schema exists
      const schemaCheck = await client.query(
        'SELECT 1 FROM pg_namespace WHERE nspname = $1',
        [s]
      );
      if (schemaCheck.rows.length === 0) {
        console.log(C.dim(`  Schema ${s} does not exist in DB, skipping.`));
        await client.query('ROLLBACK');
        continue;
      }

      // 2a. Unlink citizen_requests from citizen_payments if any exist
      const checkReqTable = await client.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
        [s, 'citizen_requests']
      );
      if (checkReqTable.rows.length > 0) {
        // Temporarily disable citizen_requests user triggers if present
        await client.query(`ALTER TABLE "${s}".citizen_requests DISABLE TRIGGER USER`);
        await client.query(`UPDATE "${s}".citizen_requests SET "citizenPaymentId" = NULL WHERE "citizenPaymentId" IS NOT NULL`);
        await client.query(`ALTER TABLE "${s}".citizen_requests ENABLE TRIGGER USER`);
      }

      // 2b. Truncate all money tables CASCADE
      const moneyTables = [
        'payment_transactions',
        'payment_settlements',
        'whish_checkouts',
        'billing_run_entries',
        'citizen_payments',
        'fee_notices',
        'treasury_entries',
        'treasury_counts',
        'treasury_day_closures',
        'treasury_transfers',
        'expense_vouchers',
        'expense_requests',
        'income_vouchers',
        'inspector_payouts',
        'treasury_accounts',
      ];

      // Filter to existing tables in this schema
      const existingTablesRes = await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2)',
        [s, moneyTables]
      );
      const tablesToTruncate = existingTablesRes.rows.map((r) => `"${s}"."${r.table_name}"`);

      if (tablesToTruncate.length > 0) {
        await client.query(`TRUNCATE TABLE ${tablesToTruncate.join(', ')} CASCADE`);
      }

      // 2c. Reset sequences
      const sequences = ['payment_receipt_seq', 'expense_voucher_seq', 'treasury_transfer_seq'];
      for (const seq of sequences) {
        const seqCheck = await client.query(
          'SELECT 1 FROM information_schema.sequences WHERE sequence_schema = $1 AND sequence_name = $2',
          [s, seq]
        );
        if (seqCheck.rows.length > 0) {
          await client.query(`ALTER SEQUENCE "${s}"."${seq}" RESTART WITH 1`);
        }
      }

      // 2d. Clean document counters for financial documents
      const counterCheck = await client.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
        [s, 'document_counters']
      );
      if (counterCheck.rows.length > 0) {
        await client.query(
          `DELETE FROM "${s}".document_counters WHERE kind IN ('INVOICE', 'RECEIPT', 'BULK_RECEIPT', 'PAYMENT_VOUCHER', 'VOUCHER', 'REVENUE_VOUCHER', 'TRANSFER')`
        );
      }

      // 2e. Re-seed clean starting 4 primary wallets (balance will be 0)
      const accountsCheck = await client.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
        [s, 'treasury_accounts']
      );
      if (accountsCheck.rows.length > 0) {
        await client.query(`
          INSERT INTO "${s}".treasury_accounts ("name", "type", "currency", "isPrimary", "active")
          VALUES
            ('صندوق النقد — ليرة',     'CASH_SAFE',     'LBP', true, true),
            ('صندوق النقد — دولار',    'CASH_SAFE',     'USD', true, true),
            ('حساب Whish — ليرة',      'WHISH_ACCOUNT', 'LBP', true, true),
            ('حساب Whish — دولار',     'WHISH_ACCOUNT', 'USD', true, true)
        `);
      }

      // 2f. Reset system_settings financial fields to pre-go-live state
      const settingsCheck = await client.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
        [s, 'system_settings']
      );
      if (settingsCheck.rows.length > 0) {
        await client.query(`
          UPDATE "${s}".system_settings
          SET
            "treasuryGoLiveAt" = NULL,
            "urgentExpenseCeilingLbp" = NULL,
            "urgentExpenseCeilingUsd" = NULL,
            "salaryUrgentCeilingLbp" = NULL,
            "salaryUrgentCeilingUsd" = NULL
        `);
      }

      await client.query('COMMIT');
      console.log(C.green(`  ✓ ${s} reset successfully.`));
    }

    // 3. Verification & Report
    console.log(C.bold('\n--- Post-Reset Verification ---'));
    for (const tenant of tenants) {
      const s = tenant.schemaName;
      const verifyCounts = await client.query(`
        SELECT
          (SELECT count(*) FROM "${s}".payment_transactions) as transactions,
          (SELECT count(*) FROM "${s}".citizen_payments) as payments,
          (SELECT count(*) FROM "${s}".fee_notices) as notices,
          (SELECT count(*) FROM "${s}".treasury_entries) as treasury_entries,
          (SELECT count(*) FROM "${s}".expense_vouchers) as expense_vouchers,
          (SELECT count(*) FROM "${s}".income_vouchers) as income_vouchers,
          (SELECT count(*) FROM "${s}".treasury_transfers) as transfers,
          (SELECT count(*) FROM "${s}".treasury_day_closures) as day_closures,
          (SELECT count(*) FROM "${s}".treasury_accounts) as primary_wallets,
          (SELECT "treasuryGoLiveAt" FROM "${s}".system_settings LIMIT 1) as go_live_at
      `);

      const r = verifyCounts.rows[0];
      console.log(`\nTenant ${C.bold(tenant.slug)} (${s}):`);
      console.log(`  - Financial Movements (payment_transactions): ${r.transactions === '0' ? C.green('0') : C.red(r.transactions)}`);
      console.log(`  - Citizen Invoices (citizen_payments):        ${r.payments === '0' ? C.green('0') : C.red(r.payments)}`);
      console.log(`  - Fee Notices (fee_notices):                  ${r.notices === '0' ? C.green('0') : C.red(r.notices)}`);
      console.log(`  - Treasury Entries (treasury_entries):        ${r.treasury_entries === '0' ? C.green('0') : C.red(r.treasury_entries)}`);
      console.log(`  - Expense Vouchers (PV):                      ${r.expense_vouchers === '0' ? C.green('0') : C.red(r.expense_vouchers)}`);
      console.log(`  - Income Vouchers (RV):                       ${r.income_vouchers === '0' ? C.green('0') : C.red(r.income_vouchers)}`);
      console.log(`  - Transfers & Exchanges (TR):                 ${r.transfers === '0' ? C.green('0') : C.red(r.transfers)}`);
      console.log(`  - Closed Days:                                ${r.day_closures === '0' ? C.green('0') : C.red(r.day_closures)}`);
      console.log(`  - Primary Starting Wallets:                   ${r.primary_wallets === '4' ? C.green('4 (CASH_SAFE & WHISH for LBP & USD)') : C.yellow(r.primary_wallets)}`);
      console.log(`  - Treasury Go-Live Status:                    ${r.go_live_at === null ? C.green('NULL (Pre-Go-Live - Ready for Activation)') : C.red(String(r.go_live_at))}`);
    }

    console.log(C.green('\n✓ Money reset complete. All financial modules are at 0 and ready for clean testing!\n'));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(`Reset failed: ${err.message}\n${err.stack}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err.message));
