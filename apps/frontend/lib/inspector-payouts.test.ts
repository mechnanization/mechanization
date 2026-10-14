import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { payoutHistory } from './inspector-payouts';

const registration = (submittedAt: string, commissionEarned: number) => ({ submittedAt, commissionEarned });
/** A payout recorded before the treasury: a figure dated by day, no voucher. Written when it is dated unless said. */
const figure = (id: string, paidAt: string, amount: number, createdAt = paidAt) => ({
  id,
  paidAt,
  amount,
  createdAt,
  voucher: null,
});
/** A payout paid from a «PV-» voucher once the treasury is live: `paidAt` is the voucher's own moment. */
const fromVoucher = (id: string, paidAt: string, amount: number, voided = false) => ({
  id,
  paidAt,
  amount,
  createdAt: paidAt,
  voucher: { voided },
});

describe('payoutHistory', () => {
  const registrations = [
    registration('2026-03-01T09:00:00.000Z', 10),
    registration('2026-03-20T09:00:00.000Z', 15),
    // Filed after the first payout: it was not owed when that payout was made.
    registration('2026-05-02T09:00:00.000Z', 40),
  ];

  it('owes after each payout what had been earned by then, not today’s total', () => {
    const rows = payoutHistory([figure('a', '2026-04-01T12:00:00.000Z', 20)], registrations);
    // Earned 25 by 1 April; today's total (65) would have read as 45 still owed.
    expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 20, owedAfter: 5, overpaidAfter: 0 });
  });

  it('carries the paid sum down the column, and answers newest first', () => {
    const rows = payoutHistory(
      [figure('late', '2026-06-01T12:00:00.000Z', 30), figure('early', '2026-04-01T12:00:00.000Z', 20)],
      registrations,
    );
    expect(rows.map((row) => row.payout.id)).toEqual(['late', 'early']);
    expect(rows[0]).toMatchObject({ earnedToDate: 65, paidToDate: 50, owedAfter: 15, overpaidAfter: 0 });
  });

  it('says a payout went beyond what had been earned, rather than reading as settled', () => {
    const rows = payoutHistory([figure('a', '2026-03-10T12:00:00.000Z', 25)], registrations);
    expect(rows[0]).toMatchObject({ earnedToDate: 10, owedAfter: 0, overpaidAfter: 15 });
  });

  it('counts a registration submitted at the very moment of the payout', () => {
    const rows = payoutHistory([figure('a', '2026-03-01T09:00:00.000Z', 10)], registrations);
    expect(rows[0]).toMatchObject({ earnedToDate: 10, owedAfter: 0, overpaidAfter: 0 });
  });

  it('leaves no float dust on the balance', () => {
    const rows = payoutHistory(
      [figure('a', '2026-04-01T12:00:00.000Z', 0.1), figure('b', '2026-04-02T12:00:00.000Z', 0.2)],
      [registration('2026-03-01T09:00:00.000Z', 0.3)],
    );
    expect(rows[0]).toMatchObject({ paidToDate: 0.3, owedAfter: 0, overpaidAfter: 0 });
  });

  it('is empty with no payouts', () => {
    expect(payoutHistory([], registrations)).toEqual([]);
  });

  it('leaves a payout whose voucher was cancelled out of what was paid, and lists it owing again', () => {
    const rows = payoutHistory(
      [fromVoucher('cancelled', '2026-06-01T08:00:00.000Z', 10, true), fromVoucher('paid', '2026-06-02T08:00:00.000Z', 10)],
      [registration('2026-05-01T09:00:00.000Z', 10)],
    );
    expect(rows.map((row) => row.payout.id)).toEqual(['paid', 'cancelled']);
    // The void put the $10 back: $10 earned and $10 paid, as the server's `paidBalance` says — not $20 and a «زيادة».
    expect(rows[0]).toMatchObject({ paidToDate: 10, owedAfter: 0, overpaidAfter: 0 });
    // The cancelled payout stays listed, and after it the $10 is owed again.
    expect(rows[1]).toMatchObject({ paidToDate: 0, owedAfter: 10, overpaidAfter: 0 });
  });
});

describe('payoutHistory, a payout recorded before the treasury (dated by day)', () => {
  // 10 June 2026 in Beirut, UTC+3: a registration at 10:00 and one at 15:00.
  const thatDay = [registration('2026-06-10T07:00:00.000Z', 10), registration('2026-06-10T12:00:00.000Z', 15)];
  // The payout dialog stamps the picked day at local noon: 09:00 UTC in Beirut in June.
  const noon = '2026-06-10T09:00:00.000Z';

  it('counts what was filed that day before it was recorded, whatever the noon stamp says', () => {
    // Recorded at 16:00 for the $25 owed then. Compared with the stamp, the 15:00 registration fell after it.
    const rows = payoutHistory([figure('a', noon, 25, '2026-06-10T13:00:00.000Z')], thatDay);
    expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 25, owedAfter: 0, overpaidAfter: 0 });
  });

  it('does not count what was filed on its day after it was recorded', () => {
    // Recorded at 10:30 for the $10 owed then; the afternoon's work was not earned by it.
    const rows = payoutHistory([figure('a', noon, 10, '2026-06-10T07:30:00.000Z')], thatDay);
    expect(rows[0]).toMatchObject({ earnedToDate: 10, owedAfter: 0, overpaidAfter: 0 });
  });

  it('reads its day on the municipality’s calendar, not UTC’s', () => {
    const rows = payoutHistory(
      // Dated 10 June and written up three days later, so the whole of its day counts.
      [figure('a', noon, 15, '2026-06-13T08:00:00.000Z')],
      [
        // 23:30 on 10 June in Beirut: earned by it.
        registration('2026-06-10T20:30:00.000Z', 15),
        // 00:30 on 11 June in Beirut, though UTC still says the 10th: not earned by it.
        registration('2026-06-10T21:30:00.000Z', 40),
      ],
    );
    expect(rows[0]).toMatchObject({ earnedToDate: 15, owedAfter: 0, overpaidAfter: 0 });
  });
});

describe('payoutHistory, a payout paid from a voucher', () => {
  it('is compared instant to instant: a registration filed a minute after it is not earned by it', () => {
    const rows = payoutHistory(
      [fromVoucher('a', '2026-06-10T09:00:00.000Z', 10)],
      [registration('2026-06-10T08:59:00.000Z', 10), registration('2026-06-10T09:01:00.000Z', 15)],
    );
    expect(rows[0]).toMatchObject({ earnedToDate: 10, owedAfter: 0, overpaidAfter: 0 });
  });
});

/*
  Every figure-only payout of a day carries the same noon stamp, and the server
  sends a tie in whatever order Postgres's plan gives it — often newest written
  first. Each case is fed in both orders: the rows must not depend on it.
*/
describe('payoutHistory, in the order the money moved', () => {
  // 10 June 2026 in Beirut, UTC+3; the payout dialog's noon stamp is 09:00 UTC.
  const noon = '2026-06-10T09:00:00.000Z';
  const settled = { owedAfter: 0, overpaidAfter: 0 };

  describe('two payouts recorded before the treasury on one day', () => {
    // $10 filed at 09:00 and paid at 10:00; $15 filed at 15:00 and paid at 16:00.
    const work = [registration('2026-06-10T06:00:00.000Z', 10), registration('2026-06-10T12:00:00.000Z', 15)];
    const morning = figure('morning', noon, 10, '2026-06-10T07:00:00.000Z');
    const afternoon = figure('afternoon', noon, 15, '2026-06-10T13:00:00.000Z');

    it.each([
      ['newest written first', [afternoon, morning]],
      ['oldest written first', [morning, afternoon]],
    ])('are summed in the order they were written, given %s', (_order, payouts) => {
      const rows = payoutHistory(payouts, work);
      expect(rows.map((row) => row.payout.id)).toEqual(['afternoon', 'morning']);
      // Each paid exactly what was owed when it was written: no «زيادة» on the first, no debt on the second.
      expect(rows[1]).toMatchObject({ earnedToDate: 10, paidToDate: 10, ...settled });
      expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 25, ...settled });
    });
  });

  describe('go-live day', () => {
    // $10 filed at 07:00 and paid at 07:30, before the treasury went live; $15 filed at 09:00, paid by voucher at 10:00.
    const work = [registration('2026-06-10T04:00:00.000Z', 10), registration('2026-06-10T06:00:00.000Z', 15)];
    const before = figure('before', noon, 10, '2026-06-10T04:30:00.000Z');
    const voucher = fromVoucher('voucher', '2026-06-10T07:00:00.000Z', 15);

    it.each([
      ['the voucher first', [voucher, before]],
      ['the figure first', [before, voucher]],
    ])('puts the payout recorded before go-live before the voucher, whatever its noon stamp says (%s)', (_order, payouts) => {
      const rows = payoutHistory(payouts, work);
      expect(rows.map((row) => row.payout.id)).toEqual(['voucher', 'before']);
      expect(rows[1]).toMatchObject({ earnedToDate: 10, paidToDate: 10, ...settled });
      expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 25, ...settled });
    });
  });

  describe('a payout dated the day before the one it was written on', () => {
    // $10 filed on 9 June, paid that day and written up on the 10th at 11:00; $15 filed on the 10th at 09:00 and paid at 10:00.
    const work = [registration('2026-06-09T07:00:00.000Z', 10), registration('2026-06-10T06:00:00.000Z', 15)];
    const dayBefore = figure('day-before', '2026-06-09T09:00:00.000Z', 10, '2026-06-10T08:00:00.000Z');
    const sameDay = figure('same-day', noon, 15, '2026-06-10T07:00:00.000Z');

    it.each([
      ['the later day first', [sameDay, dayBefore]],
      ['the earlier day first', [dayBefore, sameDay]],
    ])('comes before the payouts of the later day, though written after them (%s)', (_order, payouts) => {
      const rows = payoutHistory(payouts, work);
      expect(rows.map((row) => row.payout.id)).toEqual(['same-day', 'day-before']);
      expect(rows[1]).toMatchObject({ earnedToDate: 10, paidToDate: 10, ...settled });
      expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 25, ...settled });
    });
  });

  describe('two payouts on the same moment', () => {
    // $25 filed by 09:00; two vouchers stamped 10:00 alike, the $10 one written first.
    const work = [registration('2026-06-10T05:00:00.000Z', 10), registration('2026-06-10T06:00:00.000Z', 15)];
    const firstWritten = { ...fromVoucher('first', '2026-06-10T07:00:00.000Z', 10), createdAt: '2026-06-10T07:00:00.010Z' };
    const thenWritten = { ...fromVoucher('then', '2026-06-10T07:00:00.000Z', 15), createdAt: '2026-06-10T07:00:00.020Z' };

    it.each([
      ['the later written first', [thenWritten, firstWritten]],
      ['the earlier written first', [firstWritten, thenWritten]],
    ])('go in the order their rows were written, whichever the server sends first (%s)', (_order, payouts) => {
      const rows = payoutHistory(payouts, work);
      expect(rows.map((row) => row.payout.id)).toEqual(['then', 'first']);
      expect(rows[1]).toMatchObject({ earnedToDate: 25, paidToDate: 10, owedAfter: 15, overpaidAfter: 0 });
      expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 25, ...settled });
    });
  });

  describe('a payout written up on a later day', () => {
    // $10 filed at 09:00 and paid at 16:00 that day; $15 filed at 17:00, its payout dated that day and written up three days on.
    const work = [registration('2026-06-10T06:00:00.000Z', 10), registration('2026-06-10T14:00:00.000Z', 15)];
    const onTheDay = figure('on-the-day', noon, 10, '2026-06-10T13:00:00.000Z');
    const later = figure('written-later', noon, 15, '2026-06-13T08:00:00.000Z');

    it.each([
      ['written later first', [later, onTheDay]],
      ['written on the day first', [onTheDay, later]],
    ])('comes after those written on its day, since its hour is not known (%s)', (_order, payouts) => {
      const rows = payoutHistory(payouts, work);
      expect(rows.map((row) => row.payout.id)).toEqual(['written-later', 'on-the-day']);
      expect(rows[1]).toMatchObject({ earnedToDate: 10, paidToDate: 10, ...settled });
      expect(rows[0]).toMatchObject({ earnedToDate: 25, paidToDate: 25, ...settled });
    });
  });
});

describe('payoutHistory, on a long record', () => {
  it('dates every registration without building a date formatter for each one', () => {
    const formatters = vi.spyOn(Intl, 'DateTimeFormat');
    const many = Array.from({ length: 500 }, (_, i) =>
      registration(new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(), 1),
    );
    const rows = payoutHistory([figure('a', '2026-03-01T09:00:00.000Z', 10)], many);
    expect(rows).toHaveLength(1);
    // One formatter for the municipality's zone, kept (`municipalToday`) — not 500, which cost the page ~0.3 s per 5,000.
    expect(formatters.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

/*
  The page that draws the history, read rather than rendered (this suite has no
  DOM): its figures and its copy as the review of PR #113 left them, which no
  test of `payoutHistory` can see.
*/
describe('the payout history page', () => {
  const page = readFileSync(
    join(__dirname, '..', 'app', '[tenant]', '[locale]', '[adminPath]', '(protected)', 'inspector', 'profile', '[staffId]', 'payouts', 'page.tsx'),
    'utf8',
  );

  it('draws its rows from `payoutHistory`, and says under the table that they are worked out from today’s records', () => {
    expect(page).toMatch(/payoutHistory\(data\.payouts, data\.recentRegistrations\)/);
    expect(page).toMatch(/\{t\('recomputed'\)\}/);
  });

  it('reads its copy from `staff.commission.history`, with no inline locale branch (TXT-1)', () => {
    expect(page).toMatch(/useTranslations\('staff\.commission\.history'\)/);
    expect(page).not.toMatch(/\ben \?|locale === 'en' \?|\bisAr \?/);
  });

  it('draws its summary on the kit’s strip and its sums through `Money` (PRIM-20, PRIM-11)', () => {
    expect(page).toMatch(/<StatStrip>/);
    expect(page).not.toMatch(/function Stat\b/);
    // The page-local `$${money(x)}` that wrote a dollar sign before the figure in either language.
    expect(page).not.toMatch(/\$\$\{/);
  });
});
