import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  PAGE-12 (cleanup sprint, 2026-11-25): the expense form was one function of 740 lines. It is the form, a hook
  that holds the press that moves money, and its fields. What a split like that loses, without a test to say so,
  is the size it was split for and the one place the retry keys are handled. What the form does and what it draws
  are `record-expense-form-dom.test.ts` and `record-expense-form-render.test.ts`.
*/

const FINANCE = join(__dirname, '..', 'components', 'admin', 'finance');
const read = (file: string) => readFileSync(join(FINANCE, file), 'utf8');
const lineCount = (source: string) => source.split('\n').length - 1;

const EXPENSE = [
  'record-expense-form.tsx',
  ...readdirSync(join(FINANCE, 'expense-form')).map((file) => `expense-form/${file}`),
];

describe('the expense form after its split', () => {
  it('is the form, the hook and three groups of fields', () => {
    expect([...EXPENSE].sort()).toEqual([
      'expense-form/how-paid-fields.tsx',
      'expense-form/money-fields.tsx',
      'expense-form/use-record-expense.ts',
      'expense-form/voucher-fields.tsx',
      'record-expense-form.tsx',
    ]);
  });

  it.each(EXPENSE)('%s is no more than 600 lines', (file) => {
    expect(lineCount(read(file)), file).toBeLessThanOrEqual(600);
  });

  it('keeps the retry keys, the in-flight ref and the two money calls in the hook alone', () => {
    const money = /heldKey|spendKey|markInDoubt|heldInDoubt|inFlight|recordExpense\(|requestExpense\(/;
    expect(read('expense-form/use-record-expense.ts')).toMatch(money);
    for (const file of EXPENSE.filter((name) => name !== 'expense-form/use-record-expense.ts')) {
      // The words may appear in a comment; a call or a ref may not.
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(money);
    }
  });

  it('reads the hook once, in the form, so every field sees the same press', () => {
    const calls = EXPENSE.filter((file) => /useRecordExpense\(props\)/.test(read(file)));
    expect(calls).toEqual(['record-expense-form.tsx']);
    for (const file of EXPENSE.filter((name) => name.endsWith('-fields.tsx'))) {
      expect(read(file), file).not.toMatch(/useRecordExpense\(/);
    }
  });
});
