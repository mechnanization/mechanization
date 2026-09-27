import {
  createDamageAssessmentSchema,
  endVacancySchema,
  logVisitSchema,
  confirmVacancySchema,
  updateUnitSchema,
} from '@mechanization/shared-schemas';

/*
  Dates are judged when they arrive, not when the server started.

  Six fields in building.schema.ts used `.max(new Date(Date.now() + 60_000), …)`.
  A `.max` argument is evaluated once, while the schema object is being built,
  so the ceiling froze at process start: an API up since yesterday refused
  today's visit, vacancy and damage dates with «… في المستقبل» on a date the
  officer could see was today, and it got worse the longer the process stayed
  up.

  Each test here moves the clock forward past the moment the module loaded —
  which is what a long-lived server is — and asserts a date that is "now" by
  the new clock is still accepted. On the old code every one of them fails.
*/

const A_DAY = 24 * 60 * 60 * 1000;
const A_UNIT = '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f';

/** Put the clock a day ahead of module load, as an API running overnight is. */
const runningSinceYesterday = () => {
  jest.useFakeTimers({ now: new Date(Date.now() + A_DAY), doNotFake: ['performance'] });
};

describe('date ceilings move with the clock', () => {
  afterEach(() => jest.useRealTimers());

  it('accepts a last-stay date later than the moment the schema was built', () => {
    const today = new Date(Date.now() + A_DAY);
    runningSinceYesterday();
    expect(updateUnitSchema.safeParse({ ownerLastStayAt: today }).success).toBe(true);
  });

  it('accepts a vacancy declaration dated today', () => {
    const today = new Date(Date.now() + A_DAY);
    runningSinceYesterday();
    expect(updateUnitSchema.safeParse({ vacancyDeclaredAt: today }).success).toBe(true);
  });

  it('accepts a visit logged today', () => {
    const today = new Date(Date.now() + A_DAY);
    runningSinceYesterday();
    expect(
      logVisitSchema.safeParse({ unitId: A_UNIT, outcome: 'COMPLETE', visitedAt: today }).success,
    ).toBe(true);
  });

  it('accepts a damage assessment dated today', () => {
    const today = new Date(Date.now() + A_DAY);
    runningSinceYesterday();
    const parsed = createDamageAssessmentSchema.safeParse({
      buildingId: '7c3f5f2e-0b3a-4a1f-9d2e-6a1b2c3d4e5f',
      level: 'SAFE_MINOR_DAMAGE',
      assessedAt: today,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a vacancy confirmed today, and an end dated today', () => {
    const today = new Date(Date.now() + A_DAY);
    runningSinceYesterday();
    expect(
      confirmVacancySchema.safeParse({ basis: 'FIELD_INSPECTION', observedAt: today }).success,
    ).toBe(true);
    expect(
      endVacancySchema.safeParse({ reason: 'NO_LONGER_VACANT', endedAt: today }).success,
    ).toBe(true);
  });

  /*
    The other half of the rule, and the reason the ceiling exists at all: a
    date genuinely ahead of the clock is a typo, never a fact.
  */
  it('still refuses a date in the future', () => {
    const nextWeek = new Date(Date.now() + 7 * A_DAY);
    expect(updateUnitSchema.safeParse({ ownerLastStayAt: nextWeek }).success).toBe(false);
    expect(
      logVisitSchema.safeParse({ unitId: A_UNIT, outcome: 'COMPLETE', visitedAt: nextWeek }).success,
    ).toBe(false);
  });

  it('still allows the minute of slack for a phone clock running fast', () => {
    const inThirtySeconds = new Date(Date.now() + 30_000);
    expect(updateUnitSchema.safeParse({ ownerLastStayAt: inThirtySeconds }).success).toBe(true);
  });
});
