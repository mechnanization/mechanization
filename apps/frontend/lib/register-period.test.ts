import { describe, expect, it } from 'vitest';
import { registerPeriodRange } from './register-period';

describe('registerPeriodRange', () => {
  it('reads this month from the first to today', () => {
    expect(registerPeriodRange('thisMonth', '2026-10-09')).toEqual({ from: '2026-10-01', to: '2026-10-09' });
  });

  it('reads last month whole, to its own last day', () => {
    expect(registerPeriodRange('lastMonth', '2026-10-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('steps back over the new year in January', () => {
    expect(registerPeriodRange('lastMonth', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('knows a leap February', () => {
    expect(registerPeriodRange('lastMonth', '2028-03-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('reads this year to today, and last year whole', () => {
    expect(registerPeriodRange('thisYear', '2026-10-09')).toEqual({ from: '2026-01-01', to: '2026-10-09' });
    expect(registerPeriodRange('lastYear', '2026-10-09')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
});
