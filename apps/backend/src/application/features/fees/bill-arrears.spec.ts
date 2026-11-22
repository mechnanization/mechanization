import { arrearsView, citizenArrears } from './bill-arrears';

const line = {
  year: 2023,
  feeType: 'CLEANING',
  feeTypeNote: null,
  component: 'PRINCIPAL' as const,
  propertyNumber: '1234',
  unitCode: 'B1-3',
  oldReference: 'دفتر 7 ص 41',
};

describe('arrearsView', () => {
  it('is null on a bill that is not an old debt', () => {
    expect(arrearsView({}, 'STAFF')).toBeNull();
    expect(arrearsView({ arrearsLine: null }, 'STAFF')).toBeNull();
    expect(arrearsView({ arrearsLine: null }, 'CITIZEN')).toBeNull();
  });

  it('gives staff the old books’ reference', () => {
    expect(arrearsView({ arrearsLine: line }, 'STAFF')).toEqual({ ...line });
  });

  it('never gives the citizen the old books’ reference, and keeps the rest', () => {
    const view = arrearsView({ arrearsLine: line }, 'CITIZEN');
    expect(view?.oldReference).toBeNull();
    expect(view).toEqual({ ...line, oldReference: null });
  });

  it('clears the old books’ reference from a staff read before the portal sees it', () => {
    const staff = arrearsView({ arrearsLine: line }, 'STAFF');
    expect(citizenArrears(staff)).toEqual({ ...line, oldReference: null });
    // The staff view itself is not touched: the profile is cached and shared.
    expect(staff?.oldReference).toBe('دفتر 7 ص 41');
    expect(citizenArrears(null)).toBeNull();
  });

  it('carries a penalty line and the description of «رسم آخر» as they are', () => {
    const view = arrearsView(
      { arrearsLine: { ...line, feeType: 'OTHER', feeTypeNote: 'رسم إشغال الرصيف', component: 'PENALTY', unitCode: null } },
      'STAFF',
    );
    expect(view).toMatchObject({ feeType: 'OTHER', feeTypeNote: 'رسم إشغال الرصيف', component: 'PENALTY', unitCode: null });
  });
});
