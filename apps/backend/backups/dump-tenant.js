/**
 * One-off backup of a tenant's citizen-side data, taken before a bulk delete.
 *
 * Deliberately plain `pg` and no framework: this has to run when the Nest app
 * may not, and a backup script that needs the application to boot is a backup
 * script that is unavailable exactly when it is wanted.
 *
 * Usage (from apps/backend):
 *   node backups/dump-tenant.js <schema> <outfile>
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const schema = process.argv[2];
const out = process.argv[3];

if (!schema || !out) {
  console.error('usage: node backups/dump-tenant.js <schema> <outfile>');
  process.exit(1);
}

/** Minimal .env reader — enough for one KEY="value" per line. */
function readEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const TABLES = [
  ['citizens', "SELECT * FROM %s.users WHERE kind = 'CITIZEN'"],
  ['staff', "SELECT * FROM %s.users WHERE kind = 'STAFF'"],
  ['registrations', 'SELECT * FROM %s.registrations'],
  ['property_entries', 'SELECT * FROM %s.property_entries'],
  ['building_units', 'SELECT * FROM %s.building_units'],
  ['documents', 'SELECT * FROM %s.documents'],
  ['citizen_payments', 'SELECT * FROM %s.citizen_payments'],
  ['fee_notices', 'SELECT * FROM %s.fee_notices'],
  ['audit_log_entries', 'SELECT * FROM %s.audit_log_entries'],
];

(async () => {
  // Only ever a known schema name, and it is interpolated into SQL below — so it
  // is validated rather than trusted, by the rule every tenant schema is held to
  // (scripts/db/tenant-schema-name.mjs, DRY-10).
  const { isTenantSchemaName } = await import('../../../scripts/db/tenant-schema-name.mjs');
  if (!isTenantSchemaName(schema)) {
    console.error('ABORT: refusing to interpolate schema name: ' + schema);
    process.exit(1);
  }

  const env = readEnv(path.join(__dirname, '..', '.env'));
  const url = env.DIRECT_URL || env.DATABASE_URL;
  if (!url) {
    console.error('ABORT: no DIRECT_URL or DATABASE_URL in apps/backend/.env');
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const dump = { takenAt: new Date().toISOString(), schema, tables: {} };
  try {
    for (const [name, sql] of TABLES) {
      const result = await client.query(sql.replace('%s', schema));
      dump.tables[name] = result.rows;
      console.log('  ' + name + ': ' + result.rows.length + ' rows');
    }
  } finally {
    await client.end();
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(dump, null, 2));
  console.log('wrote ' + out);
})().catch((error) => {
  console.error('ABORT:', error.message);
  process.exit(1);
});
