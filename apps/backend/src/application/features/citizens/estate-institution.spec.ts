import {
  adminCreateCitizenSubmissionSchema,
  citizenDisplayName,
  isNonPersonRecord,
  isOwnerRecord,
  splitInstitutionName,
} from '@mechanization/shared-schemas';
import { assertNonResidentOccupancy } from '../buildings/buildings.service';
import { citizenColumnsForEdit } from './citizens.service';

/**
 * «تركة (ورثة المرحوم)» and «جهة أو وقف» (0076) — owners that are not a
 * living person (the user's guidance of 2026-10-07). An estate is the deceased
 * owner's file, in his heirs' name, and owns and nothing else; an institution
 * — a waqf, the municipality — is one name, and may also rent what nobody
 * lives in. Neither is asked anything a household is.
 */

const failures = (input: unknown): string[] => {
  const result = adminCreateCitizenSubmissionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};
const parsed = (input: unknown) => {
  const result = adminCreateCitizenSubmissionSchema.safeParse(input);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data as never;
};

const land = {
  occupancyType: 'OWNER',
  propertyType: 'LAND',
  propertyNumber: '267',
  landType: 'AGRICULTURAL',
  unitArea: '500',
  shares: '2400',
};
const estate = (over: Record<string, unknown> = {}) => ({
  residence: 'ESTATE',
  personal: { firstName: 'حسن', middleName: 'واكد', lastName: 'تجربة' },
  contact: { localContactName: 'زينب تجربة', localContactPhone: '03 123456' },
  properties: [land],
  flags: [],
  ...over,
});
const institution = (over: Record<string, unknown> = {}) => ({
  residence: 'INSTITUTION',
  personal: { firstName: 'وقف مسجد الساحة' },
  contact: {},
  properties: [land],
  flags: [],
  ...over,
});
const rents = (unitType: string) => ({
  occupancyType: 'TENANT',
  landlordName: 'حسن جفال',
  landlordPhone: '03 123456',
  propertyType: 'BUILDING',
  propertyNumber: '6',
  buildingName: 'بناية جفال',
  units: [{ unitType, floor: '0', unitArea: '40' }],
});

describe('the record kinds', () => {
  it('reads an estate and an institution as owner records, and only those two as not a person', () => {
    const kinds = ['RESIDENT', 'NON_RESIDENT_OWNER', 'ESTATE', 'INSTITUTION'];
    expect(kinds.map(isOwnerRecord)).toEqual([false, true, true, true]);
    expect(kinds.map(isNonPersonRecord)).toEqual([false, false, true, true]);
  });
});

describe('«تركة (ورثة المرحوم)»', () => {
  it('is complete with the deceased’s name alone — no phone, no household, no مكان الإقامة', () => {
    expect(failures(estate({ contact: {} }))).toEqual([]);
  });

  it('owns and nothing else: a tenancy on it is refused, whatever was rented', () => {
    expect(failures(estate({ properties: [rents('SHOP')] }))).toContain('properties.0.occupancyType');
  });

  it('does not live in the home it owns — the family in it is «مشغولة بتسامح», filed in their own name', () => {
    const house = {
      occupancyType: 'OWNER',
      propertyType: 'HOUSE',
      propertyNumber: '267',
      unitArea: '120',
      unitStatus: 'OWNER_OCCUPIED',
    };
    expect(failures(estate({ properties: [house] }))).toContain('properties.0.unitStatus');
    expect(failures(estate({ properties: [{ ...house, unitStatus: 'FREE_OCCUPIED' }] }))).toEqual([]);
  });

  it('is named «ورثة المرحوم …» everywhere a name is shown, in both languages', () => {
    const person = { firstName: 'حسن', middleName: 'واكد', lastName: 'تجربة', residence: 'ESTATE' };
    expect(citizenDisplayName(person)).toBe('ورثة المرحوم حسن واكد تجربة');
    expect(citizenDisplayName(person, { middleName: false })).toBe('ورثة المرحوم حسن تجربة');
    expect(citizenDisplayName(person, { locale: 'en' })).toBe('Heirs of the late حسن واكد تجربة');
    expect(citizenDisplayName({ ...person, residence: 'RESIDENT' })).toBe('حسن واكد تجربة');
    // A form not yet filled in has no name — not «ورثة المرحوم» alone.
    expect(citizenDisplayName({ firstName: null, lastName: '', residence: 'ESTATE' })).toBe('');
  });

  it('keeps the household columns a converted file holds, and frees a relative’s number it now uses', () => {
    const columns = citizenColumnsForEdit(parsed(estate({ contact: { phone: '+9613123456' } })), {
      identityDocType: null,
      contactPhone: '+9613123456',
    });
    expect(columns).toMatchObject({ residence: 'ESTATE', hasNoPhone: false, contactPhone: null });
    for (const kept of ['gender', 'motherName', 'maritalStatus', 'actualHouseholdMembers', 'civilRecordNumber', 'residencePlace']) {
      expect(columns).not.toHaveProperty(kept);
    }
  });
});

describe('«جهة أو وقف»', () => {
  it('is complete with its name alone', () => {
    expect(failures(institution())).toEqual([]);
    expect(failures(institution({ personal: { firstName: '' } }))).toContain('personal.firstName');
  });

  it('stores its one-line name across the name parts and shows it whole', () => {
    expect(splitInstitutionName('وقف مسجد الساحة')).toEqual({ firstName: 'وقف', middleName: null, lastName: 'مسجد الساحة' });
    const columns = citizenColumnsForEdit(parsed(institution()));
    expect(columns).toMatchObject({ firstName: 'وقف', middleName: null, lastName: 'مسجد الساحة', residence: 'INSTITUTION' });
    expect(
      citizenDisplayName({ firstName: 'وقف', middleName: null, lastName: 'مسجد الساحة', residence: 'INSTITUTION' }),
    ).toBe('وقف مسجد الساحة');
  });

  it('may rent an office, as a non-resident may, but not a home', () => {
    expect(failures(institution({ properties: [rents('OFFICE')] }))).toEqual([]);
    expect(failures(institution({ properties: [rents('APARTMENT')] })).length).toBeGreaterThan(0);
  });
});

describe('the matrix refuses the same', () => {
  const base = { unitCode: '0102', unitType: 'APARTMENT' };

  it('an estate as anything but owner', () => {
    const refusal = (role: string, unitType: string) => {
      try {
        assertNonResidentOccupancy({ ...base, residence: 'ESTATE', role, unitType });
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(refusal('TENANT', 'APARTMENT')).toMatchObject({ code: 'ESTATE_OWNS_ONLY', params: { unitCode: '0102' } });
    expect(refusal('FREE_OCCUPANT', 'SHOP')).toMatchObject({ code: 'ESTATE_OWNS_ONLY' });
  });

  it('an estate or a body living in a home, in its own words', () => {
    expect(() =>
      assertNonResidentOccupancy({ ...base, residence: 'ESTATE', role: 'OWNER', unitStatus: 'OWNER_OCCUPIED' }),
    ).toThrow('المرحوم لا يسكن');
    expect(() =>
      assertNonResidentOccupancy({ ...base, residence: 'INSTITUTION', role: 'OWNER', unitStatus: 'OWNER_OCCUPIED' }),
    ).toThrow('الجهة لا تسكن');
  });

  it('and allows the estate’s family-occupied home and the body’s rented office', () => {
    expect(() =>
      assertNonResidentOccupancy({ ...base, residence: 'ESTATE', role: 'OWNER', unitStatus: 'FREE_OCCUPIED' }),
    ).not.toThrow();
    expect(() =>
      assertNonResidentOccupancy({ ...base, residence: 'INSTITUTION', role: 'TENANT', unitType: 'OFFICE' }),
    ).not.toThrow();
  });
});
