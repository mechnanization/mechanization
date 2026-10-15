import { describe, expect, it } from 'vitest';
import type { ExpenseVoucherView, IncomeVoucherView, TreasuryMovement } from '@mechanization/shared-schemas';
import {
  apiDirection,
  isAwaitingOrder,
  movementCategory,
  movementKey,
  movementParty,
  movementRange,
} from './treasury-movements';

const income = (id: string, overrides: Partial<IncomeVoucherView> = {}): IncomeVoucherView => ({
  id,
  voucherNumber: `RV-2610-${id}`,
  status: 'RECORDED',
  category: { id: 'c-in', labelAr: 'رخص بناء', labelEn: 'Building permits', chapterCode: null, itemCode: null },
  account: { id: 'a-usd', name: 'صندوق النقد — دولار', currency: 'USD' },
  amount: 500,
  currency: 'USD',
  payerName: 'مكتب جابر للهندسة',
  description: 'رسم رخصة بناء',
  externalReference: null,
  occurredAt: '2026-10-12T08:00:00.000Z',
  adjustmentReason: null,
  recordedByName: 'المحاسب',
  voidedAt: null,
  voidedByName: null,
  voidReason: null,
  ...overrides,
});

const expense = (id: string, overrides: Partial<ExpenseVoucherView> = {}): ExpenseVoucherView => ({
  id,
  voucherNumber: `PV-2610-${id}`,
  status: 'RECORDED',
  category: { id: 'c-out', name: 'محروقات ومولّدات', chapterCode: null, itemCode: null },
  account: { id: 'a-lbp', name: 'صندوق النقد — ليرة', currency: 'LBP' },
  amount: 18_500_000,
  currency: 'LBP',
  payee: 'محطة الأمانة للمحروقات',
  payeeStaffId: null,
  salaryPeriod: null,
  description: 'مازوت للمولّد',
  occurredAt: '2026-10-12T07:00:00.000Z',
  invoiceNumber: null,
  hasPhysicalReceipt: false,
  adjustmentReason: null,
  recordedByName: 'المحاسب',
  voidedAt: null,
  voidedByName: null,
  voidReason: null,
  orderStatus: 'ORDERED',
  orderedAt: '2026-10-12T07:00:00.000Z',
  orderedByName: 'رئيس البلدية',
  urgentReason: null,
  ...overrides,
});

const inLine = (id: string, day: string, overrides: Partial<IncomeVoucherView> = {}): TreasuryMovement => ({
  direction: 'IN',
  day,
  voucher: income(id, overrides),
});

const outLine = (id: string, day: string, overrides: Partial<ExpenseVoucherView> = {}): TreasuryMovement => ({
  direction: 'OUT',
  day,
  voucher: expense(id, overrides),
});

describe('apiDirection', () => {
  it('maps the URL spelling to the API one, and «all» to no filter', () => {
    expect(apiDirection('in')).toBe('IN');
    expect(apiDirection('out')).toBe('OUT');
    expect(apiDirection('all')).toBeUndefined();
  });
});

describe('movementRange', () => {
  it('reads a preset through the register periods, on the given day', () => {
    expect(movementRange('thisMonth', { from: '', to: '' }, '2026-10-12')).toEqual({
      from: '2026-10-01',
      to: '2026-10-12',
    });
  });

  it('sets no bound for every period', () => {
    expect(movementRange('all', { from: '2026-01-01', to: '2026-02-01' }, '2026-10-12')).toEqual({});
  });

  it('leaves an unpicked end of a custom range open', () => {
    expect(movementRange('custom', { from: '2026-09-01', to: '' }, '2026-10-12')).toEqual({
      from: '2026-09-01',
      to: undefined,
    });
  });
});

describe('movementKey', () => {
  it('tells apart an income and an expense voucher that share an id', () => {
    expect(movementKey(inLine('x', '2026-10-12'))).not.toBe(movementKey(outLine('x', '2026-10-12')));
  });
});

describe('movementParty and movementCategory', () => {
  it('reads the payer of an income voucher and the payee of an expense', () => {
    expect(movementParty(inLine('1', '2026-10-12'))).toBe('مكتب جابر للهندسة');
    expect(movementParty(inLine('2', '2026-10-12', { payerName: null }))).toBeNull();
    expect(movementParty(outLine('3', '2026-10-12'))).toBe('محطة الأمانة للمحروقات');
  });

  it('reads an income category in English where it has a name, and an expense band as written', () => {
    expect(movementCategory(inLine('1', '2026-10-12'), 'en')).toBe('Building permits');
    expect(movementCategory(inLine('1', '2026-10-12'), 'ar')).toBe('رخص بناء');
    expect(
      movementCategory(
        inLine('2', '2026-10-12', {
          category: { id: 'c', labelAr: 'هبات', labelEn: null, chapterCode: null, itemCode: null },
        }),
        'en',
      ),
    ).toBe('هبات');
    expect(movementCategory(outLine('3', '2026-10-12'), 'en')).toBe('محروقات ومولّدات');
  });
});

describe('isAwaitingOrder', () => {
  it('marks an urgent payment still waiting for its order', () => {
    expect(isAwaitingOrder(outLine('1', '2026-10-12', { orderStatus: 'AWAITING_ORDER' }))).toBe(true);
  });

  it('does not mark an ordered payment, a cancelled one, or an income voucher', () => {
    expect(isAwaitingOrder(outLine('1', '2026-10-12'))).toBe(false);
    expect(isAwaitingOrder(outLine('2', '2026-10-12', { orderStatus: 'AWAITING_ORDER', status: 'VOID' }))).toBe(false);
    expect(isAwaitingOrder(inLine('3', '2026-10-12'))).toBe(false);
  });
});
