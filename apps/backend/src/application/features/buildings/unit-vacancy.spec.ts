import { contradictsVacancy } from '@mechanization/shared-schemas';
import { vacancyReversal } from './unit-vacancy';

/**
 * What lifting a «تأكيد الشغور» puts back.
 *
 * The undo is the half the action never had, and its whole risk is here: an
 * undo that restores too much walks a unit backwards over findings recorded
 * *after* the vacancy, and one that restores too little leaves a flat reading
 * «غير محدد» — billed to its owner — when the register knew perfectly well it
 * was let.
 *
 * Pure on purpose. Every case below is a shape the field produces, and none of
 * them needs a database to be stated.
 */
describe('vacancyReversal', () => {
  const vacant = { unitStatus: 'VACANT', surveyStatus: 'VACANT_CONFIRMED' };

  it('restores the حالة the confirmation replaced when it was recorded in error', () => {
    expect(
      vacancyReversal({
        reason: 'RECORDED_IN_ERROR',
        unit: vacant,
        confirmation: { previousUnitStatus: 'RENTED', previousSurveyStatus: 'COMPLETE' },
        lastVisitOutcome: null,
      }),
    ).toEqual({ unitStatus: 'RENTED', surveyStatus: 'COMPLETE' });
  });

  /*
    «لم تعد شاغرة» is not a correction. The flat was empty and somebody has
    moved in, so what it said *before* the vacancy is not what it is now —
    whoever is in it has to be recorded, and until they are, the honest answer
    is «الإشغال غير محدد», which bills the owner as the law presumes.
  */
  it('does not restore the old حالة when the flat is simply no longer empty', () => {
    expect(
      vacancyReversal({
        reason: 'NO_LONGER_VACANT',
        unit: vacant,
        confirmation: { previousUnitStatus: 'RENTED', previousSurveyStatus: 'COMPLETE' },
        lastVisitOutcome: null,
      }),
    ).toEqual({ unitStatus: null, surveyStatus: 'PARTIAL' });
  });

  /*
    The undo is available at any time, and this is what makes that safe: a unit
    whose حالة has moved on since the confirmation is left where it is. Only the
    two values the confirmation itself wrote are ever rewritten.
  */
  it('leaves a status somebody has changed since the confirmation alone', () => {
    expect(
      vacancyReversal({
        reason: 'RECORDED_IN_ERROR',
        unit: { unitStatus: 'OWNER_OCCUPIED', surveyStatus: 'DEMOLISHED' },
        confirmation: { previousUnitStatus: 'RENTED', previousSurveyStatus: 'COMPLETE' },
        lastVisitOutcome: null,
      }),
    ).toEqual({});
  });

  it('restores only the half that still holds what the confirmation wrote', () => {
    expect(
      vacancyReversal({
        reason: 'RECORDED_IN_ERROR',
        unit: { unitStatus: 'VACANT', surveyStatus: 'COMPLETE' },
        confirmation: { previousUnitStatus: 'RENTED', previousSurveyStatus: 'NOT_SURVEYED' },
        lastVisitOutcome: null,
      }),
    ).toEqual({ unitStatus: 'RENTED' });
  });

  /*
    A row migration 0041 backfilled has no snapshot — nobody recorded one — and
    `NOT_SURVEYED` would be a lie on a flat officers have stood at: it means
    nobody went. The last real visit is the honest answer.
  */
  it('falls back to the last visit when the confirmation carries no snapshot', () => {
    expect(
      vacancyReversal({
        reason: 'RECORDED_IN_ERROR',
        unit: vacant,
        confirmation: { previousUnitStatus: null, previousSurveyStatus: null },
        lastVisitOutcome: 'VISITED_NO_ANSWER',
      }),
    ).toEqual({ unitStatus: null, surveyStatus: 'VISITED_NO_ANSWER' });
  });

  it('falls back to «غير ممسوحة» only when nobody has ever visited', () => {
    expect(
      vacancyReversal({
        reason: 'RECORDED_IN_ERROR',
        unit: vacant,
        confirmation: { previousUnitStatus: null, previousSurveyStatus: null },
        lastVisitOutcome: null,
      }),
    ).toEqual({ unitStatus: null, surveyStatus: 'NOT_SURVEYED' });
  });

  /*
    A unit whose snapshot says «مؤكَّدة الشغور» was confirmed twice — the first
    one from a legacy row. Restoring it would undo one vacancy into another,
    leaving the flat exempt with nothing standing behind it.
  */
  it('does not restore a survey status that is itself a vacancy', () => {
    expect(
      vacancyReversal({
        reason: 'RECORDED_IN_ERROR',
        unit: vacant,
        confirmation: { previousUnitStatus: null, previousSurveyStatus: 'VACANT_CONFIRMED' },
        lastVisitOutcome: 'PARTIAL',
      }),
    ).toEqual({ unitStatus: null, surveyStatus: 'PARTIAL' });
  });
});

/**
 * Who contradicts an empty flat.
 *
 * The asymmetry is D2's: a tenant living there does, an owner does not — the
 * deed is not a statement of residence, and an owner recorded on a شاغرة unit
 * is the ordinary case. What an owner *says* about the flat is a different
 * matter.
 */
describe('contradictsVacancy', () => {
  it('is true for anybody who lives there', () => {
    expect(contradictsVacancy('TENANT')).toBe(true);
    expect(contradictsVacancy('FREE_OCCUPANT')).toBe(true);
  });

  it('is false for an owner who says nothing about who is inside', () => {
    expect(contradictsVacancy('OWNER')).toBe(false);
    expect(contradictsVacancy('OWNER', null)).toBe(false);
  });

  it('is false for an owner agreeing the flat is empty', () => {
    expect(contradictsVacancy('OWNER', 'VACANT')).toBe(false);
  });

  it('is true for an owner stating anything else about it', () => {
    expect(contradictsVacancy('OWNER', 'OWNER_OCCUPIED')).toBe(true);
    expect(contradictsVacancy('OWNER', 'RENTED')).toBe(true);
    expect(contradictsVacancy('OWNER', 'SEASONAL')).toBe(true);
  });
});
