import { describe, expect, it } from 'vitest';
import { updateCaseSchema } from '@mechanization/shared-schemas';
import { caseCreatePayload, caseUpdatePayload, type CaseFormValues } from '@/lib/case-payload';

const BLANK: CaseFormValues = {
  notes: '',
  propertyNumber: '',
  neighborhood: '',
  propertyType: '',
  buildingName: '',
  floor: '',
  side: '',
  landType: '',
  tentLocation: '',
};

describe('caseUpdatePayload', () => {
  it('sends an emptied place field as null, so the PATCH clears it', () => {
    const body = caseUpdatePayload({
      ...BLANK,
      notes: '  الباب مقفل  ',
      propertyNumber: '1042',
      neighborhood: '   ',
      propertyType: 'BUILDING',
      buildingName: '',
      floor: '',
    });

    expect(body).toEqual({
      notes: 'الباب مقفل',
      propertyNumber: '1042',
      neighborhood: null,
      propertyType: 'BUILDING',
      buildingName: null,
      floor: null,
      side: null,
      tentLocation: null,
    });
  });

  it('clears what a change of نوع العقار blanked on screen', () => {
    // BUILDING → LAND: the form drops the building name and floor (changePropertyType).
    const body = caseUpdatePayload({ ...BLANK, notes: 'أرض بور', propertyType: 'LAND', landType: 'AGRICULTURAL' });

    expect(body.buildingName).toBeNull();
    expect(body.floor).toBeNull();
    expect(body.propertyType).toBe('LAND');
    expect(body.landType).toBe('AGRICULTURAL');
  });

  it('never sends a null the schema refuses: نوع العقار and land type are left out when unset', () => {
    const body = caseUpdatePayload({ ...BLANK, notes: 'لا أحد في المنزل' });

    expect(body).not.toHaveProperty('propertyType');
    expect(body).not.toHaveProperty('landType');
    expect(updateCaseSchema.safeParse(body).success).toBe(true);
  });
});

describe('caseCreatePayload', () => {
  it('leaves empty fields out, since a creation has nothing to clear', () => {
    const body = caseCreatePayload({ ...BLANK, notes: ' تعذّر الدخول ', floor: ' 3 ', side: '  ' });

    expect(body).toEqual({ notes: 'تعذّر الدخول', floor: '3' });
  });
});
