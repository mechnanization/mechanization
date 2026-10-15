import { describe, expect, it } from 'vitest';
import {
  buildingFilterSchema,
  correctBuildingParcelSchema,
  createBuildingSchema,
  createCaseSchema,
  createZoneSchema,
  propertyNumberCheckSchema,
  propertyNumberField,
  updateCaseSchema,
} from '@mechanization/shared-schemas';

/**
 * A رقم العقار is saved in Latin digits whatever keyboard typed it.
 *
 * Saved as typed, «١٥٥٣» and «1553» were two parcels to every lookup that
 * compares as stored: a second building on the parcel went unseen, its zone
 * was not found. Every schema a رقم العقار is written through normalises it;
 * the lookups still compare digit-normalised for the rows saved before.
 */
describe('a رقم العقار is saved in Latin digits', () => {
  it('on a card, and on the blur check', () => {
    expect(propertyNumberField.parse(' ١٥٥٣ ')).toBe('1553');
    expect(propertyNumberField.parse('۱۵۵۳/٢')).toBe('1553/2');
    expect(propertyNumberCheckSchema.parse({ propertyNumber: '١٥٥٣' }).propertyNumber).toBe('1553');
  });

  it('on a building, its shared parcels, a parcel correction and the parcel filter', () => {
    const building = createBuildingSchema.parse({
      parcelNumber: '١٥٥٣',
      structureType: 'RESIDENTIAL_BUILDING',
      sharedParcelNumbers: ['١٥٥٤', '1554'],
    });

    expect(building.parcelNumber).toBe('1553');
    // The same parcel typed two ways is listed once.
    expect(building.sharedParcelNumbers).toEqual(['1554']);
    expect(correctBuildingParcelSchema.parse({ parcelNumber: '٧٧', reason: 'خطأ في الإدخال' }).parcelNumber).toBe('77');
    expect(buildingFilterSchema.parse({ parcelNumber: '١٥٥٣' }).parcelNumber).toBe('1553');
  });

  it('in a zone, once however it was typed', () => {
    const zone = createZoneSchema.parse({ name: 'الحي الشرقي', code: 'EAST', parcelNumbers: ['١٥٥٣', '1553', '٩'] });

    expect(zone.parcelNumbers).toEqual(['1553', '9']);
  });

  it('on a case, and a correction can still clear it', () => {
    expect(createCaseSchema.parse({ notes: 'الباب مقفل', propertyNumber: '٤٢٠' }).propertyNumber).toBe('420');
    expect(updateCaseSchema.parse({ propertyNumber: '٤٢٠' }).propertyNumber).toBe('420');
    expect(updateCaseSchema.parse({ propertyNumber: null }).propertyNumber).toBeNull();
  });
});
