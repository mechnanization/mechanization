#!/usr/bin/env node
/**
 * Quick status check for money, wallets, and treasury entries in the local database.
 *
 *   pnpm db:status:money
 *   or: node scripts/db/status-local-money.mjs
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
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

async function main() {
  const resolved = resolveTarget('local');
  const dbUrl = resolved.env.DIRECT_URL ?? resolved.env.DATABASE_URL;
  const parsed = parseConnection(dbUrl);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    console.log(C.bold('\n=== Local Financial & Treasury Status ==='));
    console.log(C.dim(`Connected to: ${parsed.user}@${parsed.host}/${parsed.database}\n`));

    const tenantRes = await client.query(
      'SELECT slug, "schemaName" FROM public.tenants WHERE "schemaName" IS NOT NULL ORDER BY slug'
    );

    for (const tenant of tenantRes.rows) {
      const s = tenant.schemaName;
      console.log(C.cyan(`┌── Tenant: ${C.bold(tenant.slug)} (${s})`));

      // 1. Settings & Go-Live
      const setRes = await client.query(
        `SELECT "treasuryGoLiveAt", "baseCurrency", "secondaryCurrency", "exchangeRate" FROM "${s}".system_settings LIMIT 1`
      );
      const settings = setRes.rows[0] ?? {};
      const isLive = Boolean(settings.treasuryGoLiveAt);

      console.log(`│   • Treasury Status:  ${isLive ? C.green(`LIVE (Active since ${new Date(settings.treasuryGoLiveAt).toLocaleString()})`) : C.yellow('PRE-GO-LIVE (Unactivated / Setup state)')}`);
      console.log(`│   • Official FX Rate: 1 ${settings.secondaryCurrency ?? 'USD'} = ${settings.exchangeRate ?? 'Not set'} ${settings.baseCurrency ?? 'LBP'}`);

      // 2. Wallets & Balances
      const walletsRes = await client.query(`
        SELECT 
          a.id, a.name, a.type, a.currency, a."isPrimary", a.active,
          COALESCE(SUM(e.amount), 0) AS balance,
          COUNT(e.id) AS entries_count
        FROM "${s}".treasury_accounts a
        LEFT JOIN "${s}".treasury_entries e ON e."accountId" = a.id AND e.currency = a.currency
        GROUP BY a.id, a.name, a.type, a.currency, a."isPrimary", a.active
        ORDER BY a."isPrimary" DESC, a.type, a.currency
      `);

      console.log(`│\n│   • Wallets & Computed Balances (SUM of entries):`);
      if (walletsRes.rows.length === 0) {
        console.log(`│     ${C.red('No treasury accounts found.')}`);
      } else {
        for (const w of walletsRes.rows) {
          const formattedBal = Number(w.balance).toLocaleString('en-US', {
            minimumFractionDigits: w.currency === 'USD' ? 2 : 0,
            maximumFractionDigits: 2,
          });
          console.log(`│     - [${w.type}] ${w.name} (${w.currency}): ${C.bold(formattedBal)} ${w.currency} ${C.dim(`(${w.entries_count} entries)`)}`);
        }
      }

      // 3. Document / Entry Summary
      const summaryRes = await client.query(`
        SELECT
          (SELECT count(*) FROM "${s}".payment_transactions) as transactions,
          (SELECT count(*) FROM "${s}".citizen_payments) as invoices,
          (SELECT count(*) FROM "${s}".treasury_entries) as total_entries,
          (SELECT count(*) FROM "${s}".expense_vouchers) as expense_vouchers,
          (SELECT count(*) FROM "${s}".income_vouchers) as income_vouchers,
          (SELECT count(*) FROM "${s}".treasury_transfers) as transfers,
          (SELECT count(*) FROM "${s}".treasury_day_closures) as day_closures
      `);
      const sm = summaryRes.rows[0];

      console.log(`│\n│   • Documents & Movements:`);
      console.log(`│     - Invoices (citizen_payments):   ${sm.invoices}`);
      console.log(`│     - Receipts (payment_trans):      ${sm.transactions}`);
      console.log(`│     - Treasury Entries:              ${sm.total_entries}`);
      console.log(`│     - Expense Vouchers (PV):         ${sm.expense_vouchers}`);
      console.log(`│     - Income Vouchers (RV):          ${sm.income_vouchers}`);
      console.log(`│     - Transfers & Exchanges (TR):    ${sm.transfers}`);
      console.log(`│     - Closed Days:                   ${sm.day_closures}`);

      // 4. Latest 5 entries if any
      if (Number(sm.total_entries) > 0) {
        const recentEntries = await client.query(`
          SELECT e.amount, e.currency, e.source, e."occurredAt", a.name as wallet_name
          FROM "${s}".treasury_entries e
          JOIN "${s}".treasury_accounts a ON a.id = e."accountId"
          ORDER BY e."createdAt" DESC
          LIMIT 5
        `);
        console.log(`│\n│   • Latest Treasury Entries:`);
        for (const re of recentEntries.rows) {
          const sign = Number(re.amount) >= 0 ? '+' : '';
          console.log(`│     * ${re.source}: ${sign}${re.amount} ${re.currency} on ${re.wallet_name} (${new Date(re.occurredAt).toLocaleTimeString()})`);
        }
      }

      console.log(`└──\n`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(C.red(`Error: ${err.message}`));
  process.exit(1);
});
