import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatLbp } from './currency';
import {
  billFigure,
  citizenPaymentTotals,
  isPartlyPaid,
  isPayable,
  isSettled,
  isUnderReview,
  partlyPaidFigures,
} from './citizen-payments';

const bill = (paymentStatus: string, amount: number, paidAmount: number) => ({
  paymentStatus,
  amount,
  paidAmount,
  remaining: Math.max(amount - paidAmount, 0),
});

describe('citizenPaymentTotals', () => {
  it('owes what is left on a part-paid bill, not its face value', () => {
    const totals = citizenPaymentTotals([bill('UNPAID', 300_000, 100_000), bill('OVERDUE', 50_000, 0)]);
    expect(totals.outstanding).toBe(250_000);
  });

  it('counts part-payments on open bills as paid, beside the settled ones', () => {
    const totals = citizenPaymentTotals([bill('UNPAID', 300_000, 100_000), bill('PAID', 80_000, 80_000)]);
    expect(totals.paid).toBe(180_000);
  });

  it('leaves a claimed bill out of what is owed — it waits on a clerk', () => {
    const totals = citizenPaymentTotals([bill('PENDING_REVIEW', 200_000, 50_000)]);
    expect(totals.outstanding).toBe(0);
    // What was taken at the counter before the claim is still paid.
    expect(totals.paid).toBe(50_000);
  });

  it('is zero for no bills', () => {
    expect(citizenPaymentTotals([])).toEqual({ outstanding: 0, paid: 0 });
  });

  it('owes nothing on the review’s bill: 300,000, 100,000 taken at the counter, a transfer reported for the rest', () => {
    // «ملفّي» said 200,000 owed here and the payments page 0, for one citizen (review of PR #113).
    const claimed = bill('PENDING_REVIEW', 300_000, 100_000);
    expect(citizenPaymentTotals([claimed, bill('UNPAID', 50_000, 0)])).toEqual({ outstanding: 50_000, paid: 100_000 });
    // Still shown, at what is left on it, with its status.
    expect(billFigure(claimed)).toBe(200_000);
  });
});

describe('billFigure', () => {
  it('shows what is left on an open bill', () => {
    expect(billFigure(bill('UNPAID', 300_000, 100_000))).toBe(200_000);
    expect(billFigure(bill('PENDING_REVIEW', 300_000, 100_000))).toBe(200_000);
  });

  it('shows the face value once settled', () => {
    expect(billFigure(bill('PAID', 300_000, 300_000))).toBe(300_000);
  });
});

describe('isPartlyPaid and isPayable', () => {
  it('marks an open bill with money on it, never a settled one', () => {
    expect(isPartlyPaid(bill('OVERDUE', 300_000, 1))).toBe(true);
    expect(isPartlyPaid(bill('UNPAID', 300_000, 0))).toBe(false);
    expect(isPartlyPaid(bill('PAID', 300_000, 300_000))).toBe(false);
  });

  it('lets the citizen pay an unpaid or overdue bill only', () => {
    expect(['UNPAID', 'OVERDUE', 'PENDING_REVIEW', 'PAID'].map((status) => isPayable({ paymentStatus: status }))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('isUnderReview', () => {
  it('is a bill whose reported transfer waits for a clerk, and nothing else', () => {
    expect(['PENDING_REVIEW', 'UNPAID', 'OVERDUE', 'PAID'].map((status) => isUnderReview({ paymentStatus: status }))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('isSettled', () => {
  it('settles a bill paid in full, and nothing else', () => {
    expect(['PAID', 'UNPAID', 'OVERDUE', 'PENDING_REVIEW'].map((status) => isSettled({ paymentStatus: status }))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('partlyPaidFigures', () => {
  const partPaid = bill('UNPAID', 300_000, 100_000);

  it('writes the paid part and the face value in the page’s language', () => {
    expect(partlyPaidFigures(partPaid, 'en')).toEqual({ paid: formatLbp(100_000, 'en'), total: formatLbp(300_000, 'en') });
    expect(partlyPaidFigures(partPaid, 'ar')).toEqual({ paid: formatLbp(100_000, 'ar'), total: formatLbp(300_000, 'ar') });
  });

  it('puts no Arabic unit into an English sentence', () => {
    expect(Object.values(partlyPaidFigures(partPaid, 'en')).join(' ')).not.toMatch(/ل\.ل/);
  });
});

/*
  The screens that read the rule, read here (they are not rendered in this
  suite): a helper test stays green while a screen goes back to its own copy —
  the pay dialog's local «ل.ل» and face value, «ملفّي»'s own `isSettled` and
  inline «سدّدت X من Y» (review of PR #113).
*/
describe('the portal screens read the per-bill rule from here', () => {
  const FRONTEND = join(__dirname, '..');
  const read = (...path: string[]): string => readFileSync(join(FRONTEND, ...path), 'utf8');
  const payDialog = read('components', 'citizen', 'pay-dialog.tsx');
  const myFile = read('app', '[tenant]', '[locale]', '(citizen)', 'my-file', 'page.tsx');
  const paymentsPage = read('app', '[tenant]', '[locale]', '(citizen)', 'payments', 'page.tsx');
  const myAccount = read('app', '[tenant]', '[locale]', '(citizen)', 'my-account', 'page.tsx');

  it('the pay dialog asks for what is left, written in the page’s language', () => {
    expect(payDialog).toMatch(/<Money amount=\{payment\.remaining\}/);
    expect(payDialog).toMatch(/partlyPaidFigures\(payment, locale\)/);
    // The local `lbp` wrote «ل.ل» into the English sentence too, and the face value.
    expect(payDialog).not.toMatch(/ل\.ل/);
    expect(payDialog).not.toMatch(/payment\.amount\b/);
  });

  it('«ملفّي» shows what is left on a bill and «سدّدت X من Y» through these helpers, not its own copy', () => {
    expect(myFile).toMatch(/from '@\/lib\/citizen-payments'/);
    expect(myFile).toMatch(/billFigure\(payment\)/);
    expect(myFile).toMatch(/partlyPaidFigures\(payment, locale\)/);
    expect(myFile).not.toMatch(/function isSettled\b/);
    expect(myFile).not.toMatch(/(سدّدت|Paid) \$\{formatLbp/);
  });

  it('the payments page sums and shows each bill through them', () => {
    expect(paymentsPage).toMatch(/citizenPaymentTotals\(items\)/);
    expect(paymentsPage).toMatch(/billFigure\(item\)/);
  });

  /*
    One figure for what the citizen owes, on every page that says it (review of
    PR #113): «ملفّي» and «حسابي» showed the summary's `outstandingTotal`, which
    counts a bill whose transfer waits for a clerk, while the payments page
    left that bill out — two totals for one citizen.
  */
  it('«ملفّي» and «حسابي» sum what is owed with `citizenPaymentTotals`, as the payments page does', () => {
    expect(myFile).toMatch(/citizenPaymentTotals\(payments\)/);
    expect(myFile).toMatch(/formatLbp\(totals\.outstanding, locale\)/);
    expect(myFile).toMatch(/formatLbp\(totals\.paid, locale\)/);
    expect(myAccount).toMatch(/citizenPaymentTotals\(summary\?\.payments \?\? \[\]\)\.outstanding/);
    expect(myAccount).toMatch(/amount=\{owed\}/);
  });

  it('no portal page reads the summary’s own owed or paid total', () => {
    const portal = join(FRONTEND, 'app', '[tenant]', '[locale]', '(citizen)');
    const pages = readdirSync(portal, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.tsx'));
    expect(pages.length).toBeGreaterThanOrEqual(4);
    const readers = pages.filter((file) => /\.(outstandingTotal|paidTotal)\b/.test(readFileSync(join(portal, file), 'utf8')));
    expect(readers).toEqual([]);
  });

  it('«حسابي» shows what is left on a bill, and marks one whose transfer waits for a clerk', () => {
    expect(myAccount).toMatch(/<Money amount=\{billFigure\(payment\)\}/);
    expect(myAccount).not.toMatch(/amount=\{payment\.amount\}/);
    expect(myAccount).toMatch(/isUnderReview\(payment\) \?/);
  });
});
