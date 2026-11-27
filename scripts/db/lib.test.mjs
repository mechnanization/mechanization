import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absentIfMissing } from './lib.mjs';

const failing = (code) => Promise.reject(Object.assign(new Error(`pg error ${code}`), { code }));

test('a relation that does not exist yet reads as absent', async () => {
  assert.deepEqual(await absentIfMissing(failing('42P01'), { rows: [] }), { rows: [] });
  assert.deepEqual(await absentIfMissing(failing('3F000'), { rows: [{ n: 0 }] }), { rows: [{ n: 0 }] });
});

test('anything else that stops the read is thrown, never read as absent', async () => {
  // 42501 insufficient_privilege, 28P01 a refused password, 57P01 the server went away.
  for (const code of ['42501', '28P01', '57P01', undefined]) {
    await assert.rejects(absentIfMissing(failing(code), { rows: [] }), /pg error/);
  }
});

test('a read that succeeds is returned as it is', async () => {
  const rows = { rows: [{ id: 1 }] };
  assert.equal(await absentIfMissing(Promise.resolve(rows), { rows: [] }), rows);
});
