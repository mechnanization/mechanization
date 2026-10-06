import {
  DAMAGE_LEVEL,
  DAMAGE_SEVERITY,
  answersHabitability,
  createDamageAssessmentSchema,
  damageSeverity,
  habitabilityFor,
  isImpairedDamage,
  isReinspectDayAhead,
  isReinspectOverdue,
  isUninhabitableReading,
} from '@mechanization/shared-schemas';

/*
  «صالحة للسكن؟» — habitability as its own answer beside the UN-Habitat level
  (decision, 2026-10-05), and the «موعد إعادة الكشف» that belongs to a reading
  saying the target cannot be lived in.
*/

const A_DAY = 24 * 60 * 60 * 1000;
const UNIT = '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f';

function parse(input: Record<string, unknown>) {
  return createDamageAssessmentSchema.safeParse({ unitId: UNIT, ...input });
}

function issuePaths(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('the damage scale stays UN-Habitat verbatim (D4)', () => {
  it('has the five levels and «غير مصنّف», and no habitability level', () => {
    expect([...DAMAGE_LEVEL]).toEqual([
      'NOT_AFFECTED',
      'SAFE_MINOR_DAMAGE',
      'RESTRICTED_USE',
      'UNSAFE_EVACUATE',
      'TOTAL_COLLAPSE',
      'UNCLASSIFIED',
    ]);
  });

  it('refuses the retired «غير قابلة للسكن» level', () => {
    expect(issuePaths(parse({ level: 'UNINHABITABLE' }))).toContain('level');
  });

  it('ranks every level on the one shared ladder, each exactly once', () => {
    /*
      The map and the server both read this ladder; a level missing from it
      drew an assessed building with no ring, which on the map means nobody
      has looked.
    */
    expect([...DAMAGE_SEVERITY].sort()).toEqual([...DAMAGE_LEVEL].sort());
    expect(damageSeverity('TOTAL_COLLAPSE')).toBeLessThan(damageSeverity('UNSAFE_EVACUATE'));
    expect(damageSeverity('NOT_AFFECTED')).toBeLessThan(damageSeverity('UNCLASSIFIED'));
  });
});

describe('habitability prefill — what the level decides', () => {
  it('locks a collapse and an evacuation to «غير صالحة»', () => {
    expect(habitabilityFor('TOTAL_COLLAPSE')).toEqual({ value: false, locked: true, required: true });
    expect(habitabilityFor('UNSAFE_EVACUATE')).toEqual({ value: false, locked: true, required: true });
  });

  it('starts no and minor damage at «صالحة», and lets it change', () => {
    expect(habitabilityFor('NOT_AFFECTED')).toEqual({ value: true, locked: false, required: true });
    expect(habitabilityFor('SAFE_MINOR_DAMAGE')).toEqual({ value: true, locked: false, required: true });
  });

  it('assumes nothing on restricted use, and makes the inspector answer', () => {
    expect(habitabilityFor('RESTRICTED_USE')).toEqual({ value: null, locked: false, required: true });
  });

  it('asks nothing of an unclassified structure', () => {
    expect(habitabilityFor('UNCLASSIFIED')).toEqual({ value: null, locked: false, required: false });
  });
});

describe('createDamageAssessmentSchema — habitability', () => {
  it('fills an absent answer from a level that decides it', () => {
    const collapse = parse({ level: 'TOTAL_COLLAPSE' });
    const minor = parse({ level: 'SAFE_MINOR_DAMAGE' });
    expect(collapse.success && collapse.data.habitable).toBe(false);
    expect(minor.success && minor.data.habitable).toBe(true);
  });

  it('refuses «صالحة» on a collapse or an evacuation', () => {
    expect(issuePaths(parse({ level: 'UNSAFE_EVACUATE', habitable: true }))).toContain('habitable');
  });

  it('records a sound but stripped unit as not habitable', () => {
    const parsed = parse({ level: 'SAFE_MINOR_DAMAGE', habitable: false });
    expect(parsed.success && parsed.data.habitable).toBe(false);
  });

  it('refuses restricted use with no answer, and takes either answer', () => {
    expect(issuePaths(parse({ level: 'RESTRICTED_USE' }))).toContain('habitable');
    expect(parse({ level: 'RESTRICTED_USE', habitable: true }).success).toBe(true);
    expect(parse({ level: 'RESTRICTED_USE', habitable: false }).success).toBe(true);
  });

  it('leaves an unclassified reading unanswered', () => {
    const parsed = parse({ level: 'UNCLASSIFIED' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.habitable).toBeUndefined();
  });
});

describe('createDamageAssessmentSchema — «موعد إعادة الكشف»', () => {
  it('accepts a re-inspection day on a reading that says nobody can live there', () => {
    expect(
      parse({ level: 'RESTRICTED_USE', habitable: false, reinspectAt: new Date(Date.now() + 14 * A_DAY) }).success,
    ).toBe(true);
    // A collapse is not habitable by its level alone, so it may carry one too.
    expect(parse({ level: 'TOTAL_COLLAPSE', reinspectAt: new Date(Date.now() + 30 * A_DAY) }).success).toBe(true);
  });

  it('accepts such a reading with no day set yet', () => {
    expect(parse({ level: 'RESTRICTED_USE', habitable: false }).success).toBe(true);
  });

  it('refuses a re-inspection day on a habitable reading', () => {
    expect(
      issuePaths(parse({ level: 'SAFE_MINOR_DAMAGE', reinspectAt: new Date(Date.now() + 14 * A_DAY) })),
    ).toContain('reinspectAt');
  });

  it('refuses a re-inspection day already gone', () => {
    expect(
      issuePaths(parse({ level: 'RESTRICTED_USE', habitable: false, reinspectAt: new Date(Date.now() - 2 * A_DAY) })),
    ).toContain('reinspectAt');
  });
});

describe("the re-inspection day is read on the municipality's calendar", () => {
  /*
    01:30 in Beirut on 6 October is still 5 October in UTC. A UTC "today"
    would accept the 5th — a day already gone for everyone in the town.
  */
  const beirutEarlyMorning = new Date('2026-10-05T22:30:00.000Z');

  it('treats the Beirut day as today, not the UTC one', () => {
    expect(isReinspectDayAhead('2026-10-06', beirutEarlyMorning)).toBe(true);
    expect(isReinspectDayAhead('2026-10-05', beirutEarlyMorning)).toBe(false);
  });

  it('marks a day overdue only once it has passed in Beirut', () => {
    expect(isReinspectOverdue('2026-10-05', beirutEarlyMorning)).toBe(true);
    expect(isReinspectOverdue('2026-10-06', beirutEarlyMorning)).toBe(false);
  });
});

describe('answersHabitability — which readings decide', () => {
  it('passes over «غير مصنّف» with no answer, which judged nothing', () => {
    expect(answersHabitability({ level: 'UNCLASSIFIED', habitable: null })).toBe(false);
    expect(answersHabitability({ level: 'UNCLASSIFIED' })).toBe(false);
  });

  it('counts every other reading, answered or decided by its level', () => {
    expect(answersHabitability({ level: 'UNCLASSIFIED', habitable: false })).toBe(true);
    for (const level of DAMAGE_LEVEL.filter((value) => value !== 'UNCLASSIFIED')) {
      expect([level, answersHabitability({ level, habitable: null })]).toEqual([level, true]);
    }
  });
});

describe('isUninhabitableReading — the one predicate the hold and the worklist read', () => {
  it('reads an explicit «غير صالحة» as uninhabitable, at any level', () => {
    expect(isUninhabitableReading({ level: 'NOT_AFFECTED', habitable: false })).toBe(true);
    expect(isUninhabitableReading({ level: 'RESTRICTED_USE', habitable: false })).toBe(true);
  });

  it('reads a collapse or an evacuation from before the question as uninhabitable', () => {
    expect(isUninhabitableReading({ level: 'TOTAL_COLLAPSE', habitable: null })).toBe(true);
    expect(isUninhabitableReading({ level: 'UNSAFE_EVACUATE', habitable: null })).toBe(true);
  });

  it('assumes nothing about an older restricted-use reading', () => {
    expect(isUninhabitableReading({ level: 'RESTRICTED_USE', habitable: null })).toBe(false);
  });

  it('reads «صالحة» as habitable', () => {
    expect(isUninhabitableReading({ level: 'RESTRICTED_USE', habitable: true })).toBe(false);
  });

  it('keeps the «متضرر» count on the structural scale alone', () => {
    expect(isImpairedDamage('RESTRICTED_USE')).toBe(true);
    expect(isImpairedDamage('NOT_AFFECTED')).toBe(false);
  });
});
