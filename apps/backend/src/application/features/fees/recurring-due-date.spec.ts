import { dueDateInCurrentPeriod, periodKeyFor } from './fees.service';

/**
 * Where a recurring fee falls due, period after period.
 *
 * The rule the register depends on: **an invoice is never dated outside the
 * period it belongs to**, because `periodKey` is the uniqueness key for the
 * invoice and the due date is what the citizen is told. When they disagree,
 * February's bill arrives stamped March and nobody can say which month was
 * actually billed.
 *
 * The old implementation walked forward from the original one period at a time
 * using `setUTCMonth`, which overflows rather than clamping — 31 January plus a
 * month is 3 March, not 28 February. Because each step moved the *accumulated*
 * value, a single overflow was permanent: the notice moved to the 3rd and
 * stayed there. Mid-month dates never showed it, which is why it survived.
 *
 * Every case below is a date arithmetic fact, not a timing one. None can flake.
 */

const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('dueDateInCurrentPeriod — monthly', () => {
  it('keeps a mid-month fee on its own day', () => {
    const original = at(2026, 1, 15);
    expect(iso(dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 2, 5)))).toBe('2026-02-15');
    expect(iso(dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 7, 5)))).toBe('2026-07-15');
  });

  it('clamps the 31st to the last day of a shorter month', () => {
    const original = at(2026, 1, 31);
    expect(iso(dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 2, 5)))).toBe('2026-02-28');
    expect(iso(dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 4, 5)))).toBe('2026-04-30');
  });

  it('returns to the 31st the next month that has one', () => {
    // The point of clamping rather than moving the notice: April borrows the
    // 30th, May does not inherit it.
    const original = at(2026, 1, 31);
    expect(iso(dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 5, 5)))).toBe('2026-05-31');
  });

  it('clamps to 29 February in a leap year', () => {
    expect(iso(dueDateInCurrentPeriod(at(2028, 1, 31), 'MONTHLY', at(2028, 2, 5)))).toBe(
      '2028-02-29',
    );
  });

  it.each([29, 30, 31])('never dates a fee due on the %sth outside its own period', (day) => {
    /*
      The defect, stated directly. Before the fix, the February run for a
      notice due on the 29th, 30th or 31st of January returned a date in
      March — an invoice for period 2026-02 carrying a March due date.
    */
    const original = at(2026, 1, day);

    for (let month = 2; month <= 14; month++) {
      const now = at(2026 + Math.floor((month - 1) / 12), ((month - 1) % 12) + 1, 5);
      const due = dueDateInCurrentPeriod(original, 'MONTHLY', now);

      expect(periodKeyFor('MONTHLY', due)).toBe(periodKeyFor('MONTHLY', now));
    }
  });

  it('gives consecutive periods distinct due dates', () => {
    // February and March both returned 2026-03-03 before the fix.
    const original = at(2026, 1, 31);
    const feb = dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 2, 5));
    const mar = dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 3, 5));

    expect(iso(feb)).not.toBe(iso(mar));
  });

  it('does not drift: the 40th period is still the original day', () => {
    const original = at(2026, 1, 31);
    const due = dueDateInCurrentPeriod(original, 'MONTHLY', at(2029, 5, 5));
    expect(iso(due)).toBe('2029-05-31');
  });

  it('carries the original time of day through', () => {
    const original = new Date(Date.UTC(2026, 0, 15, 9, 30, 0, 0));
    const due = dueDateInCurrentPeriod(original, 'MONTHLY', at(2026, 3, 5));
    expect(due.toISOString()).toBe('2026-03-15T09:30:00.000Z');
  });
});

describe('dueDateInCurrentPeriod — annually', () => {
  it('keeps the original month and day', () => {
    const original = at(2026, 3, 10);
    expect(iso(dueDateInCurrentPeriod(original, 'ANNUALLY', at(2029, 6, 1)))).toBe('2029-03-10');
  });

  it('clamps a 29 February fee, and restores it in the next leap year', () => {
    /*
      Not in the original audit. Stepping with `setUTCFullYear` turned
      29 February into 1 March and — because the next step moved from 1 March —
      it stayed in March for ever, including in leap years when February had a
      29th to return to.
    */
    const original = at(2028, 2, 29);
    expect(iso(dueDateInCurrentPeriod(original, 'ANNUALLY', at(2029, 6, 1)))).toBe('2029-02-28');
    expect(iso(dueDateInCurrentPeriod(original, 'ANNUALLY', at(2032, 6, 1)))).toBe('2032-02-29');
  });
});

describe('dueDateInCurrentPeriod — half-yearly', () => {
  it('holds its position within the half', () => {
    // February is month 1 of H1, so the H2 fee falls due in August.
    const original = at(2026, 2, 10);
    expect(iso(dueDateInCurrentPeriod(original, 'HALF_YEARLY', at(2026, 10, 1)))).toBe(
      '2026-08-10',
    );
    expect(iso(dueDateInCurrentPeriod(original, 'HALF_YEARLY', at(2027, 4, 1)))).toBe(
      '2027-02-10',
    );
  });

  it('clamps when the matching month is shorter', () => {
    // March 31 is month 2 of H1; the H2 counterpart is September, which has 30.
    const original = at(2026, 3, 31);
    expect(iso(dueDateInCurrentPeriod(original, 'HALF_YEARLY', at(2026, 10, 1)))).toBe(
      '2026-09-30',
    );
  });

  it('stays inside its own period across four halves', () => {
    const original = at(2026, 1, 31);
    for (const now of [at(2026, 4, 1), at(2026, 10, 1), at(2027, 4, 1), at(2027, 10, 1)]) {
      const due = dueDateInCurrentPeriod(original, 'HALF_YEARLY', now);
      expect(periodKeyFor('HALF_YEARLY', due)).toBe(periodKeyFor('HALF_YEARLY', now));
    }
  });
});

describe('dueDateInCurrentPeriod — one-off', () => {
  it('hands back the original date unchanged', () => {
    const original = at(2026, 1, 31);
    expect(iso(dueDateInCurrentPeriod(original, 'ONCE', at(2029, 5, 5)))).toBe('2026-01-31');
  });
});
