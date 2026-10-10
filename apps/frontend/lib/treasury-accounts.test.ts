import { describe, expect, it } from 'vitest';
import { activeAccounts } from './treasury-accounts';

describe('activeAccounts', () => {
  const safe = { id: 'safe', active: true };
  const whish = { id: 'whish', active: true };
  const retired = { id: 'old-box', active: false };

  it('keeps the active wallets, in the order the overview gave them', () => {
    expect(activeAccounts({ accounts: [safe, retired, whish] })).toEqual([safe, whish]);
  });

  it('is empty when every wallet is retired, and when there are none', () => {
    expect(activeAccounts({ accounts: [retired] })).toEqual([]);
    expect(activeAccounts({ accounts: [] })).toEqual([]);
  });
});
