/**
 * What every `scripts/db` tool shares (DRY-11): the `pg` client, terminal
 * colours, a connection that always closes, and the two ways a tool stops.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './targets.mjs';

/**
 * `require` resolving from the backend's `package.json`: `pg`, `ts-node` and the rest are the
 * backend's dependencies, and pnpm's strict linking only finds them from there.
 */
export const backendRequire = createRequire(join(ROOT, 'apps', 'backend', 'package.json'));
export const { Client } = backendRequire('pg');

export const C = {
  red: (s) => `\x1b[91m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[93m${s}\x1b[0m`,
  blue: (s) => `\x1b[94m${s}\x1b[0m`,
  cyan: (s) => `\x1b[96m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

/** Runs `fn` on a fresh connection and closes it whatever happens. */
export async function withClient(connectionString, fn) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The answer for a relation that does not exist yet, and only for that: `undefined_table`
 * (42P01) or `invalid_schema_name` (3F000), as on a target never provisioned. Any other
 * failure — a refused login, a revoked grant, a dropped connection — is thrown, because read
 * as "absent" it reported a provisioned municipality as missing and invited a second run.
 */
export async function absentIfMissing(query, absent) {
  try {
    return await query;
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '3F000') return absent;
    throw error;
  }
}

/** Stops a tool that touches a deployed database (backup, restore check): plain text, for CI logs. */
export function abort(message) {
  console.error(`\nABORT: ${message}\n`);
  process.exit(1);
}

/** Stops a local tool, in red. */
export function fail(message) {
  console.error(C.red(`\n✗ ${message}`));
  process.exit(1);
}
