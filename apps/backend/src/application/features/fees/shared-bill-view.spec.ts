import { responsibleDebtorId } from './shared-bill-view';

/**
 * The responsible owner a shared unit bill offers first as its payer (the
 * user's decision, 2026-10-27): D5 still bills every owner in full; «مالك
 * مسؤول» only decides who the counter's payer selector starts on.
 */
describe('responsibleDebtorId', () => {
  it('names the responsible owner under «مالك مسؤول»', () => {
    expect(responsibleDebtorId({ ownerBillingMode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'owner-a' })).toBe('owner-a');
  });

  it('names nobody under any other method, nor on a bill with no unit', () => {
    expect(responsibleDebtorId({ ownerBillingMode: 'EQUAL', responsibleOwnerId: null })).toBeNull();
    expect(responsibleDebtorId({ ownerBillingMode: 'BY_SHARES', responsibleOwnerId: null })).toBeNull();
    expect(responsibleDebtorId({ ownerBillingMode: null, responsibleOwnerId: null })).toBeNull();
    expect(responsibleDebtorId(null)).toBeNull();
  });
});
