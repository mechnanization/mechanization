import { describe, expect, it } from 'vitest';
import { updateCaseSchema } from '@mechanization/shared-schemas';
import {
  caseCreatePayload,
  caseUpdatePayload,
  valuesForPropertyType,
  type CaseFormValues,
} from '@/lib/case-payload';

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
      landType: null,
      tentLocation: null,
    });
    expect(updateCaseSchema.safeParse(body).success).toBe(true);
  });

  it('clears what a change of نوع العقار blanked on screen', () => {
    // BUILDING → LAND: the form drops the building name and floor (changePropertyType).
    const body = caseUpdatePayload({ ...BLANK, notes: 'أرض بور', propertyType: 'LAND', landType: 'AGRICULTURAL' });

    expect(body.buildingName).toBeNull();
    expect(body.floor).toBeNull();
    expect(body.propertyType).toBe('LAND');
    expect(body.landType).toBe('AGRICULTURAL');
  });

  it('clears نوع العقار and land type when «غير معروف» is chosen, and the schema takes it', () => {
    const body = caseUpdatePayload({ ...BLANK, notes: 'لا أحد في المنزل' });

    expect(body.propertyType).toBeNull();
    expect(body.landType).toBeNull();
    expect(updateCaseSchema.safeParse(body).success).toBe(true);
  });
});

describe('valuesForPropertyType', () => {
  const census: CaseFormValues = {
    ...BLANK,
    notes: 'متابعة من المسح',
    propertyNumber: '1042',
    neighborhood: 'الحي الشرقي',
    buildingName: 'بناية الأمل',
  };

  it('keeps a field the new type also shows: a census case keeps its building name under BUILDING', () => {
    const next = valuesForPropertyType(census, 'BUILDING');

    expect(next).toMatchObject({ propertyType: 'BUILDING', buildingName: 'بناية الأمل' });
    expect(caseUpdatePayload(next).buildingName).toBe('بناية الأمل');
  });

  it('empties the fields the new type does not carry, and keeps the ones every case has', () => {
    const building = { ...census, propertyType: 'BUILDING', floor: '3' };
    const next = valuesForPropertyType(building, 'LAND');

    expect(next).toMatchObject({
      propertyType: 'LAND',
      buildingName: '',
      floor: '',
      notes: 'متابعة من المسح',
      propertyNumber: '1042',
      neighborhood: 'الحي الشرقي',
    });
  });

  it('empties every type-specific field for «غير معروف»', () => {
    const next = valuesForPropertyType({ ...census, propertyType: 'LAND', landType: 'AGRICULTURAL' }, '');

    expect(next).toMatchObject({ propertyType: '', buildingName: '', landType: '' });
  });
});

describe('caseCreatePayload', () => {
  it('leaves empty fields out, since a creation has nothing to clear', () => {
    const body = caseCreatePayload({ ...BLANK, notes: ' تعذّر الدخول ', floor: ' 3 ', side: '  ' });

    expect(body).toEqual({ notes: 'تعذّر الدخول', floor: '3' });
  });
});
