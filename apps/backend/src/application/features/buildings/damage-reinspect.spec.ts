import { createDamageAssessmentSchema, isImpairedDamage } from '@mechanization/shared-schemas';
import { damageSeverity } from './damage.service';

/*
  «غير قابلة للسكن» and its «موعد إعادة الكشف».

  The date is the second visit a repair needs, so it belongs to that level
  alone, and it is planned — today or later, never a day already gone.
*/

const A_DAY = 24 * 60 * 60 * 1000;
const UNIT = '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f';

describe('damage re-inspection', () => {
  it('accepts a re-inspection day on «غير قابلة للسكن»', () => {
    const parsed = createDamageAssessmentSchema.safeParse({
      unitId: UNIT,
      level: 'UNINHABITABLE',
      reinspectAt: new Date(Date.now() + 14 * A_DAY),
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts «غير قابلة للسكن» with no day set yet', () => {
    expect(createDamageAssessmentSchema.safeParse({ unitId: UNIT, level: 'UNINHABITABLE' }).success).toBe(true);
  });

  it('accepts today as the re-inspection day', () => {
    expect(
      createDamageAssessmentSchema.safeParse({ unitId: UNIT, level: 'UNINHABITABLE', reinspectAt: new Date() })
        .success,
    ).toBe(true);
  });

  it('refuses a re-inspection day on any other level', () => {
    const parsed = createDamageAssessmentSchema.safeParse({
      unitId: UNIT,
      level: 'RESTRICTED_USE',
      reinspectAt: new Date(Date.now() + 14 * A_DAY),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain('reinspectAt');
  });

  it('refuses a re-inspection day already gone', () => {
    const parsed = createDamageAssessmentSchema.safeParse({
      unitId: UNIT,
      level: 'UNINHABITABLE',
      reinspectAt: new Date(Date.now() - 2 * A_DAY),
    });
    expect(parsed.success).toBe(false);
  });

  it('counts «غير قابلة للسكن» as damage, between restricted use and evacuation', () => {
    expect(isImpairedDamage('UNINHABITABLE')).toBe(true);
    expect(isImpairedDamage('NOT_AFFECTED')).toBe(false);
    expect(damageSeverity('UNSAFE_EVACUATE')).toBeLessThan(damageSeverity('UNINHABITABLE'));
    expect(damageSeverity('UNINHABITABLE')).toBeLessThan(damageSeverity('RESTRICTED_USE'));
  });
});
