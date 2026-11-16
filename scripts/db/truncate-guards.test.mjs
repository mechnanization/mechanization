/**
 * The local reset tools switch 0103's TRUNCATE guards off around their
 * TRUNCATE and on again, inside their own transaction. Run with `pnpm db:test`.
 *
 * What matters: every guard comes back on, after the work and after a failed
 * one, and every name is quoted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardStatement, withTruncateGuardsOff } from './truncate-guards.mjs';

function fakeClient(guards) {
  const statements = [];
  return {
    statements,
    async query(sql, params) {
      if (/FROM pg_trigger/.test(sql)) {
        assert.deepEqual(params, ['tenant_x']);
        return { rows: guards };
      }
      statements.push(sql);
      return { rows: [] };
    },
  };
}

const guards = [
  { table: 'audit_log_entries', trigger: 'audit_log_entries_no_truncate' },
  { table: 'treasury_entries', trigger: 'treasury_entries_no_truncate' },
];

test('switches every guard off, runs the work, and switches them on again', async () => {
  const client = fakeClient(guards);
  const result = await withTruncateGuardsOff(client, 'tenant_x', async () => {
    client.statements.push('TRUNCATE');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(client.statements, [
    'ALTER TABLE "tenant_x"."audit_log_entries" DISABLE TRIGGER "audit_log_entries_no_truncate"',
    'ALTER TABLE "tenant_x"."treasury_entries" DISABLE TRIGGER "treasury_entries_no_truncate"',
    'TRUNCATE',
    'ALTER TABLE "tenant_x"."audit_log_entries" ENABLE TRIGGER "audit_log_entries_no_truncate"',
    'ALTER TABLE "tenant_x"."treasury_entries" ENABLE TRIGGER "treasury_entries_no_truncate"',
  ]);
});

test('switches them on again when the work fails, and passes the failure on', async () => {
  const client = fakeClient(guards);
  await assert.rejects(
    withTruncateGuardsOff(client, 'tenant_x', async () => {
      throw new Error('truncate failed');
    }),
    /truncate failed/,
  );
  assert.equal(client.statements.filter((sql) => sql.includes('ENABLE TRIGGER')).length, 2);
});

test('does nothing to a schema migrated before 0103, which has no guards', async () => {
  const client = fakeClient([]);
  await withTruncateGuardsOff(client, 'tenant_x', async () => client.statements.push('TRUNCATE'));
  assert.deepEqual(client.statements, ['TRUNCATE']);
});

test('quotes every name, and knows only the two actions', () => {
  assert.equal(
    guardStatement('ten"ant', { table: 'a"b', trigger: 't' }, 'DISABLE'),
    'ALTER TABLE "ten""ant"."a""b" DISABLE TRIGGER "t"',
  );
  assert.throws(() => guardStatement('s', { table: 'a', trigger: 't' }, 'DROP'), /unknown action/);
});
