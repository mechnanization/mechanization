/**
 * The TRUNCATE guards of `0103` (`<table>_no_truncate`, one per append-only or
 * written-once table), switched off for a local reset and on again.
 *
 * `reset-local-money.mjs` and `delete-local-citizens-and-buildings.mjs` empty
 * the money tables of the LOCAL database on purpose, with TRUNCATE … CASCADE,
 * and a guard fires for every table the cascade reaches. Both scripts refuse
 * any database but `municipality_db_local` on loopback before they get here.
 *
 * Call it inside the caller's transaction. `ALTER TABLE … DISABLE TRIGGER` is
 * transactional: a rollback restores the guards by itself, and the guards are
 * switched on again before the work's result is returned, so no path commits a
 * schema with its guards off. Never call it against staging or production:
 * there, getting past these triggers is circumventing a control
 * (docs/database.md).
 *
 * When the work fails on a statement, the transaction is aborted and Postgres
 * refuses every query until ROLLBACK, the ENABLEs included. Their failure must
 * not replace the work's own error, which is the one the operator needs; the
 * rollback restores the guards. A failure in the work's own code leaves the
 * transaction usable, and the ENABLEs then run as usual.
 */
export async function withTruncateGuardsOff(client, schema, work) {
  const guards = await truncateGuards(client, schema);
  for (const guard of guards) await client.query(guardStatement(schema, guard, 'DISABLE'));
  let result;
  try {
    result = await work();
  } catch (error) {
    for (const guard of guards) {
      await client.query(guardStatement(schema, guard, 'ENABLE')).catch(() => undefined);
    }
    throw error;
  }
  for (const guard of guards) await client.query(guardStatement(schema, guard, 'ENABLE'));
  return result;
}

/** Every `_no_truncate` trigger in `schema`, as `{ table, trigger }`. */
export async function truncateGuards(client, schema) {
  const { rows } = await client.query(
    `SELECT c.relname AS "table", tg.tgname AS "trigger"
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND tg.tgname LIKE '%\\_no\\_truncate' AND NOT tg.tgisinternal
      ORDER BY c.relname`,
    [schema],
  );
  return rows;
}

/** The ALTER TABLE that switches one guard, every name quoted. */
export function guardStatement(schema, { table, trigger }, action) {
  if (action !== 'DISABLE' && action !== 'ENABLE') throw new Error(`unknown action ${action}`);
  return `ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(table)} ${action} TRIGGER ${quoteIdent(trigger)}`;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
