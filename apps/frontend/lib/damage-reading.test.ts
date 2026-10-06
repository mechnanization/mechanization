import { describe, expect, it } from 'vitest';
import type { DamageAssessmentRow } from './api-client';
import { applicableReading, damageInput, governingReading, isUninhabitableNow, reinspectOverdue, today } from './damage-reading';

const reading = (over: Partial<DamageAssessmentRow> & { id: string; assessedAt: string }): DamageAssessmentRow => ({
  buildingId: null,
  unitId: null,
  level: 'NOT_AFFECTED',
  source: 'FIELD_VISIT',
  observations: null,
  habitable: true,
  reinspectAt: null,
  assessedById: null,
  assessedByName: null,
  createdAt: over.assessedAt,
  ...over,
});

describe('applicableReading — what speaks for a flat now', () => {
  // Newest first, as `DamageService.history` returns it.
  const history = [
    reading({ id: 'b2', buildingId: 'B', assessedAt: '2026-03-01', level: 'NOT_AFFECTED', habitable: true }),
    reading({ id: 'u1', unitId: 'U1', assessedAt: '2026-02-01', level: 'RESTRICTED_USE', habitable: false }),
    reading({ id: 'b1', buildingId: 'B', assessedAt: '2026-01-01', level: 'UNSAFE_EVACUATE', habitable: null }),
  ];

  it('takes a later whole-building reading over a flat’s own older one', () => {
    expect(applicableReading(history, { unitId: 'U1' })?.id).toBe('b2');
    expect(isUninhabitableNow(history, { unitId: 'U1' })).toBe(false);
  });

  it('takes a flat’s own reading over an older whole-building one', () => {
    expect(applicableReading(history.slice(1), { unitId: 'U1' })?.id).toBe('u1');
    expect(isUninhabitableNow(history.slice(1), { unitId: 'U1' })).toBe(true);
  });

  it('lets a whole-building evacuation from before the question speak for every flat', () => {
    expect(isUninhabitableNow(history.slice(2), { unitId: 'U9' })).toBe(true);
  });

  it('looks past a later «غير مصنّف» with no answer — it judged nothing, so the hold stands', () => {
    const unjudged = [
      reading({ id: 'b3', buildingId: 'B', assessedAt: '2026-04-01', level: 'UNCLASSIFIED', habitable: null }),
      ...history.slice(1),
    ];
    expect(applicableReading(unjudged, { unitId: 'U1' })?.id).toBe('b3');
    expect(governingReading(unjudged, { unitId: 'U1' })?.id).toBe('u1');
    expect(isUninhabitableNow(unjudged, { unitId: 'U1' })).toBe(true);
  });

  it('reads the structure by its own whole-building readings only', () => {
    expect(applicableReading(history.slice(1), { buildingId: 'B' })?.id).toBe('b1');
  });

  it('reads nothing where nothing was recorded', () => {
    expect(applicableReading([], { unitId: 'U1' })).toBeNull();
  });
});

describe('the re-inspection day, on the municipality’s calendar', () => {
  // 01:30 in Beirut on 6 October is still 5 October in UTC.
  const early = new Date('2026-10-05T22:30:00.000Z');

  it('counts today in Beirut, not in UTC', () => {
    expect(today(early)).toBe('2026-10-06');
  });

  it('is overdue only once the day has passed in Beirut', () => {
    expect(reinspectOverdue('2026-10-05', early)).toBe(true);
    expect(reinspectOverdue('2026-10-06', early)).toBe(false);
    expect(reinspectOverdue(null, early)).toBe(false);
  });
});

describe('damageInput — what the form sends', () => {
  const base = {
    level: 'RESTRICTED_USE' as const,
    source: 'FIELD_VISIT' as const,
    observations: '  نوافذ مكسورة  ',
    assessedAt: '',
    habitable: false,
    reinspectAt: '2026-11-01',
  };

  it('sends the answer and the day on a reading nobody can live in', () => {
    expect(damageInput(base, { unitId: 'U1' })).toEqual({
      unitId: 'U1',
      level: 'RESTRICTED_USE',
      source: 'FIELD_VISIT',
      observations: 'نوافذ مكسورة',
      assessedAt: undefined,
      habitable: false,
      reinspectAt: '2026-11-01',
    });
  });

  it('drops a day left over once the answer is «صالحة»', () => {
    expect(damageInput({ ...base, habitable: true }, { buildingId: 'B' }).reinspectAt).toBeUndefined();
  });

  it('leaves an unasked answer unsent', () => {
    expect(damageInput({ ...base, level: 'UNCLASSIFIED', habitable: null }, { buildingId: 'B' })).not.toHaveProperty(
      'habitable',
    );
  });
});
