import { describe, expect, it } from 'vitest';
import {
  expenseModeFor,
  mayDecideRequest,
  mayIssueOrders,
  mayRegularize,
  mayWithdrawRequest,
  meansOutOfDate,
  paysNow,
} from './expense-order';

const manager = { id: 'manager-1', role: 'SUPER_ADMIN' };
const author = { id: 'accountant-1', role: 'ACCOUNTANT' };
const colleague = { id: 'accountant-2', role: 'ACCOUNTANT' };
const auditor = { id: 'auditor-1', role: 'AUDITOR' };

describe('expenseModeFor', () => {
  it('is the order for the manager, whatever the form was left on', () => {
    expect(expenseModeFor('SUPER_ADMIN', 'REQUEST')).toBe('ORDER');
    expect(expenseModeFor('SUPER_ADMIN', 'URGENT')).toBe('ORDER');
  });

  it('is what the accountant chose', () => {
    expect(expenseModeFor('ACCOUNTANT', 'REQUEST')).toBe('REQUEST');
    expect(expenseModeFor('ACCOUNTANT', 'URGENT')).toBe('URGENT');
  });

  it('never gives a role that is not the manager the manager’s mode', () => {
    expect(expenseModeFor(undefined, 'REQUEST')).toBe('REQUEST');
    expect(expenseModeFor('AUDITOR', 'URGENT')).toBe('URGENT');
  });
});

describe('paysNow', () => {
  it('is true for the order and the urgent payment, false for a request', () => {
    expect(paysNow('ORDER')).toBe(true);
    expect(paysNow('URGENT')).toBe(true);
    expect(paysNow('REQUEST')).toBe(false);
  });
});

describe('mayIssueOrders', () => {
  it('is the manager’s alone', () => {
    expect(mayIssueOrders('SUPER_ADMIN')).toBe(true);
    for (const role of ['ACCOUNTANT', 'AUDITOR', 'VIEWER', 'INSPECTOR', undefined]) {
      expect(mayIssueOrders(role)).toBe(false);
    }
  });
});

describe('mayDecideRequest', () => {
  it('lets the manager order or reject a request that is still waiting', () => {
    expect(mayDecideRequest({ status: 'PENDING' }, manager)).toBe(true);
  });

  it('does not offer a decided request again, or any request to anyone else', () => {
    for (const status of ['ORDERED', 'REJECTED', 'WITHDRAWN'] as const) {
      expect(mayDecideRequest({ status }, manager)).toBe(false);
    }
    expect(mayDecideRequest({ status: 'PENDING' }, author)).toBe(false);
    expect(mayDecideRequest({ status: 'PENDING' }, auditor)).toBe(false);
    expect(mayDecideRequest({ status: 'PENDING' }, null)).toBe(false);
  });
});

describe('mayWithdrawRequest', () => {
  const waiting = { status: 'PENDING' as const, requestedById: author.id };

  it('lets the author take a request back', () => {
    expect(mayWithdrawRequest(waiting, author)).toBe(true);
  });

  it('lets the manager, who is not its author', () => {
    expect(mayWithdrawRequest(waiting, manager)).toBe(true);
  });

  it('refuses another accountant: a request is one accountant’s word', () => {
    expect(mayWithdrawRequest(waiting, colleague)).toBe(false);
  });

  it('refuses a role the route is closed to, even for a request it once filed', () => {
    expect(mayWithdrawRequest({ status: 'PENDING', requestedById: auditor.id }, auditor)).toBe(false);
  });

  it('refuses a request that has been decided, and no session', () => {
    for (const status of ['ORDERED', 'REJECTED', 'WITHDRAWN'] as const) {
      expect(mayWithdrawRequest({ status, requestedById: author.id }, author)).toBe(false);
    }
    expect(mayWithdrawRequest(waiting, null)).toBe(false);
  });
});

describe('mayRegularize', () => {
  it('lets the manager order an urgent payment that is still waiting for it', () => {
    expect(mayRegularize({ status: 'RECORDED', orderStatus: 'AWAITING_ORDER' }, manager)).toBe(true);
  });

  it('does not offer a voucher that has its order, or one that was cancelled', () => {
    expect(mayRegularize({ status: 'RECORDED', orderStatus: 'ORDERED' }, manager)).toBe(false);
    expect(mayRegularize({ status: 'VOID', orderStatus: 'AWAITING_ORDER' }, manager)).toBe(false);
  });

  it('is not the accountant’s to give', () => {
    expect(mayRegularize({ status: 'RECORDED', orderStatus: 'AWAITING_ORDER' }, author)).toBe(false);
    expect(mayRegularize({ status: 'RECORDED', orderStatus: 'AWAITING_ORDER' }, null)).toBe(false);
  });
});

describe('meansOutOfDate', () => {
  it('knows the refusals that say somebody got there first', () => {
    for (const code of [
      'EXPENSE_REQUEST_ALREADY_DECIDED',
      'EXPENSE_REQUEST_NOT_FOUND',
      'EXPENSE_ALREADY_ORDERED',
      'EXPENSE_ALREADY_VOID',
      'EXPENSE_NOT_FOUND',
    ]) {
      expect(meansOutOfDate(code)).toBe(true);
    }
  });

  it('leaves every other refusal alone, so the list is not refreshed under a form the officer is still reading', () => {
    for (const code of ['TREASURY_INSUFFICIENT_FUNDS', 'EXPENSE_REQUEST_NOT_YOURS', 'EXPENSE_CATEGORY_INACTIVE', 'NETWORK_ERROR']) {
      expect(meansOutOfDate(code)).toBe(false);
    }
  });
});
