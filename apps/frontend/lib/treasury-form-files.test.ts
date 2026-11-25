import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  PAGE-12 (cleanup sprint, 2026-11-25): the treasury's expense and transfer forms were one function each, of 740
  and 688 lines. Each is the form, a hook that holds the press that moves money, and what it draws. What a split
  like that loses, without a test to say so, is the size it was split for and the one place the retry keys are
  handled. What the forms do and draw are their `-dom` and `-render` tests.
*/

const FINANCE = join(__dirname, '..', 'components', 'admin', 'finance');
const read = (file: string) => readFileSync(join(FINANCE, file), 'utf8');
const lineCount = (source: string) => source.split('\n').length - 1;
/** The words may appear in a comment; a call or a ref may not. */
const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const split = (form: string, folder: string) => [
  form,
  ...readdirSync(join(FINANCE, folder)).map((file) => `${folder}/${file}`),
];
const EXPENSE = split('record-expense-form.tsx', 'expense-form');
const TRANSFER = split('record-transfer-form.tsx', 'transfer-form');

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
      expect(codeOf(read(file)), file).not.toMatch(money);
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

describe('the transfer form after its split', () => {
  it('is the form, the hook, three groups of fields, the summary and what they share', () => {
    expect([...TRANSFER].sort()).toEqual([
      'record-transfer-form.tsx',
      'transfer-form/amount-fields.tsx',
      'transfer-form/figures.ts',
      'transfer-form/form-section.tsx',
      'transfer-form/paperwork-fields.tsx',
      'transfer-form/transfer-summary.tsx',
      'transfer-form/use-record-transfer.ts',
      'transfer-form/wallet-fields.tsx',
    ]);
  });

  it.each(TRANSFER)('%s is no more than 600 lines', (file) => {
    expect(lineCount(read(file)), file).toBeLessThanOrEqual(600);
  });

  it('keeps the retry key, the in-flight ref and the money call in the hook alone', () => {
    const money = /heldKey|spendKey|markInDoubt|heldInDoubt|inFlight|createTransfer\(/;
    expect(read('transfer-form/use-record-transfer.ts')).toMatch(money);
    for (const file of TRANSFER.filter((name) => name !== 'transfer-form/use-record-transfer.ts')) {
      expect(codeOf(read(file)), file).not.toMatch(money);
    }
  });

  it('reads the hook once, in the form, so every field and the button see the same press', () => {
    const calls = TRANSFER.filter((file) => /useRecordTransfer\(props\)/.test(read(file)));
    expect(calls).toEqual(['record-transfer-form.tsx']);
    for (const file of TRANSFER.filter((name) => /-(fields|summary)\.tsx$/.test(name))) {
      expect(read(file), file).not.toMatch(/useRecordTransfer\(/);
    }
  });
});
