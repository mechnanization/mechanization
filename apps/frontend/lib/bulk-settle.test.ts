import { describe, expect, it } from 'vitest';
import { BULK_SETTLE_MAX_BILLS } from '@mechanization/shared-schemas';
import { heldKey, markInDoubt, spendKey } from './request-id';
import {
  beginPress,
  bulkKeyScope,
  dueByCurrency,
  endPress,
  isBulkSettleable,
  pageSelection,
  propertyLines,
  reconcileSelection,
  rowBlock,
  selectedCitizen,
  selectionHeld,
  toggleBill,
  togglePage,
  type SelectedBill,
} from './bulk-settle';

function bill(id: string, overrides: Partial<SelectedBill> = {}): SelectedBill {
  return {
    id,
    citizenId: 'citizen-a',
    citizenName: 'أحمد علي',
    invoiceNumber: `INV-2610-${id}`,
    title: 'رسم النفايات',
    currency: 'LBP',
    remaining: 500_000,
    dueDate: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** `count` bills of one citizen, ids `b0`…. */
function many(count: number, citizenId = 'citizen-a'): SelectedBill[] {
  return Array.from({ length: count }, (_, index) => bill(`b${index}`, { citizenId }));
}

describe('isBulkSettleable', () => {
  it('takes an unpaid or overdue bill with something still owed', () => {
    expect(isBulkSettleable({ paymentStatus: 'UNPAID', remaining: 1 })).toBe(true);
    expect(isBulkSettleable({ paymentStatus: 'OVERDUE', remaining: 250_000 })).toBe(true);
  });

  it('refuses a paid bill, a claim under review, and a bill with nothing left', () => {
    expect(isBulkSettleable({ paymentStatus: 'PAID', remaining: 0 })).toBe(false);
    // A Whish claim is settled by confirming it, not by taking the money again.
    expect(isBulkSettleable({ paymentStatus: 'PENDING_REVIEW', remaining: 500_000 })).toBe(false);
    expect(isBulkSettleable({ paymentStatus: 'UNPAID', remaining: 0 })).toBe(false);
  });
});

describe('toggleBill and rowBlock', () => {
  it('ticks and unticks, and names whose bills the set holds', () => {
    const one = toggleBill([], bill('b1'));
    expect(one.map((entry) => entry.id)).toEqual(['b1']);
    expect(selectedCitizen(one)).toEqual({ id: 'citizen-a', name: 'أحمد علي' });
    expect(toggleBill(one, bill('b1'))).toEqual([]);
    expect(selectedCitizen([])).toBeNull();
  });

  it('keeps one citizen per set: another citizen’s bill is blocked and not added', () => {
    const set = toggleBill([], bill('b1'));
    const other = bill('b9', { citizenId: 'citizen-b' });
    expect(rowBlock(set, other)).toBe('otherCitizen');
    expect(toggleBill(set, other)).toBe(set);
    // Once the set is empty again, the other citizen's bill may start a new one.
    expect(rowBlock([], other)).toBeNull();
  });

  it('stops at the limit, and still lets a ticked bill be unticked there', () => {
    const full = many(BULK_SETTLE_MAX_BILLS);
    const extra = bill('extra');
    expect(rowBlock(full, extra)).toBe('limit');
    expect(toggleBill(full, extra)).toBe(full);
    expect(rowBlock(full, full[0]!)).toBeNull();
    expect(toggleBill(full, full[0]!)).toHaveLength(BULK_SETTLE_MAX_BILLS - 1);
  });
});

describe('pageSelection and togglePage', () => {
  it('ticks every settleable row of a page that is one citizen’s, and unticks them again', () => {
    const rows = many(3);
    expect(pageSelection([], rows)).toEqual({ eligible: 3, allSelected: false, blocked: null });
    const ticked = togglePage([], rows);
    expect(ticked.map((entry) => entry.id)).toEqual(['b0', 'b1', 'b2']);
    expect(pageSelection(ticked, rows).allSelected).toBe(true);
    expect(togglePage(ticked, rows)).toEqual([]);
  });

  it('adds only the rows not yet ticked, keeping bills ticked on other pages', () => {
    const elsewhere = bill('other-page');
    const rows = many(2);
    const set = togglePage([elsewhere, rows[0]!], rows);
    expect(set.map((entry) => entry.id)).toEqual(['other-page', 'b0', 'b1']);
    // Unticking the page leaves the bill from the other page.
    expect(togglePage(set, rows).map((entry) => entry.id)).toEqual(['other-page']);
  });

  it('is blocked over a page of several citizens, or another citizen than the set’s', () => {
    const mixed = [bill('b1'), bill('b2', { citizenId: 'citizen-b' })];
    expect(pageSelection([], mixed).blocked).toBe('mixedCitizens');
    expect(togglePage([], mixed)).toEqual([]);

    const set = [bill('b1')];
    const theirs = many(2, 'citizen-b');
    expect(pageSelection(set, theirs).blocked).toBe('otherCitizen');
    expect(togglePage(set, theirs)).toBe(set);
  });

  it('is blocked when the page would take the set past the limit', () => {
    const set = many(BULK_SETTLE_MAX_BILLS - 1);
    const rows = [bill('p1'), bill('p2')];
    expect(pageSelection(set, rows).blocked).toBe('limit');
    expect(togglePage(set, rows)).toBe(set);
    // One row fits exactly.
    expect(pageSelection(set, [bill('p1')]).blocked).toBeNull();
  });

  it('offers nothing over a page with no settleable rows', () => {
    expect(pageSelection([], [])).toEqual({ eligible: 0, allSelected: false, blocked: null });
    expect(togglePage([], [])).toEqual([]);
  });
});

describe('reconcileSelection', () => {
  it('returns the same set when the fresh read changes nothing', () => {
    const set = [bill('b1'), bill('b2')];
    expect(reconcileSelection(set, [{ bill: bill('b1'), settleable: true }])).toBe(set);
    expect(reconcileSelection(set, [])).toBe(set);
  });

  it('drops a ticked bill the read shows paid since, and takes new figures for one still open', () => {
    const set = [bill('b1'), bill('b2'), bill('elsewhere')];
    const next = reconcileSelection(set, [
      { bill: bill('b1', { remaining: 0 }), settleable: false },
      { bill: bill('b2', { remaining: 200_000 }), settleable: true },
    ]);
    expect(next.map((entry) => [entry.id, entry.remaining])).toEqual([
      ['b2', 200_000],
      // Not on this page of the read: kept as it was, for the server to judge again.
      ['elsewhere', 500_000],
    ]);
  });
});

/*
  Review of PR #112. A press with no answer may have paid the bills; the next
  window-focus re-read shows them paid, and dropping them emptied the set, took
  the bar and its dialog with it, and orphaned the retry key — the one retry the
  server answers with the consolidated receipt and «سُجّلت سابقاً».
*/
describe('a held set (selectionHeld)', () => {
  const paid = (id: string) => ({ bill: bill(id, { remaining: 0 }), settleable: false });

  it('drops nothing while held, and still takes new figures for a bill still open', () => {
    const set = [bill('h1'), bill('h2')];
    const next = reconcileSelection(set, [paid('h1'), { bill: bill('h2', { remaining: 100 }), settleable: true }], true);
    expect(next.map((entry) => [entry.id, entry.remaining])).toEqual([
      ['h1', 500_000],
      ['h2', 100],
    ]);
    expect(reconcileSelection(set, [paid('h1'), paid('h2')], true)).toBe(set);
  });

  it('is held while a press of the set is on the wire, and not after', () => {
    const set = [bill('p2'), bill('p1')];
    const scope = bulkKeyScope(['p1', 'p2']);
    expect(selectionHeld('t-held', set)).toBe(false);
    beginPress('t-held', scope);
    expect(selectionHeld('t-held', set)).toBe(true);
    // Another set, or another municipality, is not held by this press.
    expect(selectionHeld('t-held', [bill('p1')])).toBe(false);
    expect(selectionHeld('t-other', set)).toBe(false);
    endPress('t-held', scope);
    expect(selectionHeld('t-held', set)).toBe(false);
  });

  it('is held while the set’s key is in doubt, until the server confirms the act', () => {
    const set = [bill('d1'), bill('d2')];
    const scope = bulkKeyScope(['d1', 'd2']);
    heldKey('t-held', scope);
    markInDoubt('t-held', scope);
    expect(selectionHeld('t-held', set)).toBe(true);
    spendKey('t-held', scope);
    expect(selectionHeld('t-held', set)).toBe(false);
    expect(selectionHeld('t-held', [])).toBe(false);
  });
});

describe('dueByCurrency', () => {
  it('sums per currency, the municipality’s own first, to the ledger’s precision', () => {
    const due = dueByCurrency([
      { currency: 'USD', remaining: 20.25 },
      { currency: 'LBP', remaining: 900_000 },
      { currency: 'USD', remaining: 19.9 },
      { currency: 'LBP', remaining: 900_000.6 },
      { currency: 'EUR', remaining: 5 },
    ]);
    // 20.25 + 19.9 is 40.150000000000006 in floating point; the ledger keeps cents.
    expect(due).toEqual([
      { currency: 'LBP', amount: 1_800_001 },
      { currency: 'EUR', amount: 5 },
      { currency: 'USD', amount: 40.15 },
    ]);
  });

  it('puts another base currency first when the municipality keeps its books in it', () => {
    expect(dueByCurrency([{ currency: 'LBP', remaining: 1 }, { currency: 'USD', remaining: 2 }], 'USD')[0]?.currency).toBe(
      'USD',
    );
  });
});

describe('bulkKeyScope', () => {
  it('is the same for the same set in any order, and differs for another set', () => {
    expect(bulkKeyScope(['b2', 'b1', 'b3'])).toBe(bulkKeyScope(['b3', 'b1', 'b2']));
    expect(bulkKeyScope(['b1', 'b2'])).not.toBe(bulkKeyScope(['b1', 'b2', 'b3']));
    expect(bulkKeyScope(['b1'])).toBe('bulk-settle:b1');
  });

  it('does not reorder the caller’s array', () => {
    const ids = ['b2', 'b1'];
    bulkKeyScope(ids);
    expect(ids).toEqual(['b2', 'b1']);
  });
});

describe('propertyLines', () => {
  it('picks the wording by what is known', () => {
    expect(
      propertyLines([
        { propertyNumber: '123', unitType: 'APARTMENT', unitCode: 'A-1' },
        { propertyNumber: '124', unitType: 'SHOP', unitCode: null },
        { propertyNumber: '125', unitType: null, unitCode: 'B-2' },
        { propertyNumber: '126', unitType: null, unitCode: null },
        { propertyNumber: null, unitType: 'OFFICE', unitCode: 'C-3' },
        { propertyNumber: null, unitType: 'GARAGE', unitCode: null },
        { propertyNumber: null, unitType: null, unitCode: 'D-4' },
      ]).map((line) => line.key),
    ).toEqual(['parcelTypeCode', 'parcelType', 'parcelCode', 'parcel', 'typeCode', 'type', 'code']);
  });

  it('drops blanks, empty entries and repeats', () => {
    expect(
      propertyLines([
        { propertyNumber: ' 123 ', unitType: 'APARTMENT', unitCode: ' ' },
        { propertyNumber: '123', unitType: 'APARTMENT', unitCode: null },
        { propertyNumber: '', unitType: null, unitCode: '  ' },
      ]),
    ).toEqual([{ key: 'parcelType', parcel: '123', unitType: 'APARTMENT', unitCode: null }]);
    expect(propertyLines([])).toEqual([]);
  });
});
