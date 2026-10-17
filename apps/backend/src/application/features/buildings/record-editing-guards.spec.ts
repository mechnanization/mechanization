import { adminUpdateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import { changedUnitFields, nonResidentUnitConflict, unitsOutsideFloors } from './buildings.service';
import { spellEnding } from './census-sync.service';
import { citizenColumnsForEdit } from '../citizens/citizens.service';

/**
 * The guards added so that correcting a record cannot leave it contradicting
 * itself. Each one is a state the system used to accept and then trip over on
 * the next, unrelated save.
 */

describe('unitsOutsideFloors', () => {
  const units = [
    { unitCode: 'B101', floor: -1 },
    { unitCode: '0001', floor: 0 },
    { unitCode: '0201', floor: 2 },
    { unitCode: '0301', floor: 3 },
  ];

  it('finds the units above the new top floor', () => {
    // Three floors are 0, 1 and 2 — floor 3 falls off.
    expect(unitsOutsideFloors(units, 3, 1).map((unit) => unit.unitCode)).toEqual(['0301']);
  });

  it('finds the units below the new deepest basement', () => {
    expect(unitsOutsideFloors(units, 4, 0).map((unit) => unit.unitCode)).toEqual(['B101']);
  });

  it('finds nothing when every unit still has a floor', () => {
    expect(unitsOutsideFloors(units, 4, 1)).toEqual([]);
  });
});

describe('nonResidentUnitConflict', () => {
  it('refuses making a unit a dwelling under a non-resident tenant, naming them', () => {
    const message = nonResidentUnitConflict({
      unitCode: '0002',
      nonResidentOccupants: ['سامي تجربة'],
      ownerOccupiedByNonResident: false,
    });
    expect(message).toMatch(/0002/);
    expect(message).toMatch(/سامي تجربة/);
    // Both ways out, because only the officer knows which is true.
    expect(message).toMatch(/مقيم/);
    expect(message).toMatch(/أنهِ إيجاره/);
  });

  it('names a person once when their spell and their card both hold the unit', () => {
    const message = nonResidentUnitConflict({
      unitCode: '0002',
      nonResidentOccupants: ['سامي تجربة', 'سامي تجربة'],
      ownerOccupiedByNonResident: false,
    });
    expect(message!.match(/سامي تجربة/g)).toHaveLength(1);
  });

  it('refuses «مشغولة من المالك» when every owner lives elsewhere', () => {
    const message = nonResidentUnitConflict({
      unitCode: '0101',
      nonResidentOccupants: [],
      ownerOccupiedByNonResident: true,
    });
    expect(message).toMatch(/مسكن موسمي/);
  });

  it('refuses «مسكن موسمي» on a home every owner of which is an estate or an institution, in its words', () => {
    const conflict = (seasonalOwner: string) =>
      nonResidentUnitConflict({ unitCode: '0101', nonResidentOccupants: [], ownerOccupiedByNonResident: false, seasonalOwner });
    expect(conflict('ESTATE')).toMatch(/المرحوم لا يسكن الوحدة 0101/);
    expect(conflict('INSTITUTION')).toMatch(/الجهة لا تسكن المسكن 0101/);
  });

  it('lets everything else through', () => {
    expect(
      nonResidentUnitConflict({ unitCode: '0101', nonResidentOccupants: [], ownerOccupiedByNonResident: false }),
    ).toBeNull();
  });
});

describe('changedUnitFields', () => {
  const base = {
    floor: 1,
    sequence: 1,
    unitCode: '0101',
    unitType: 'SHOP',
    unitArea: '40',
    unitStatus: 'RENTED',
    surveyStatus: 'SURVEYED',
    postedNumber: null,
    side: null,
    startCol: 1,
    endCol: 1,
    presenceMonths: [],
    ownerLastStayAt: null,
    vacancyDeclaredAt: null,
    notes: null,
  };

  it('records a retype and a re-measure, which change a bill', () => {
    const changes = changedUnitFields(base, { ...base, unitType: 'APARTMENT', unitArea: '140' });
    expect(changes.before).toEqual({ unitType: 'SHOP', unitArea: '40' });
    expect(changes.after).toEqual({ unitType: 'APARTMENT', unitArea: '140' });
  });

  it('records nothing for a save that changed nothing', () => {
    expect(changedUnitFields(base, { ...base })).toEqual({ before: {}, after: {} });
  });

  it('records a move by both halves of the position and the code', () => {
    const changes = changedUnitFields(base, { ...base, floor: 2, unitCode: '0201' });
    expect(Object.keys(changes.after)).toEqual(['floor', 'unitCode']);
  });
});

describe('spellEnding', () => {
  const now = new Date('2026-09-27T10:00:00Z');
  const owner = { role: 'OWNER', fromDate: new Date('2026-09-10T08:00:00Z') };
  const tenant = { role: 'TENANT', fromDate: new Date('2026-09-10T08:00:00Z') };

  it('closes plainly, today, when the officer was not asked', () => {
    expect(spellEnding(owner, undefined, now)).toEqual({ reason: null, toDate: now });
  });

  it('closes an error as of now, whoever held it', () => {
    expect(spellEnding(tenant, { reason: 'RECORDED_IN_ERROR' }, now)).toEqual({
      reason: 'RECORDED_IN_ERROR',
      toDate: now,
    });
  });

  it('closes a sale on the day it happened', () => {
    const soldOn = new Date('2026-09-20T00:00:00Z');
    expect(spellEnding(owner, { reason: 'OWNERSHIP_TRANSFERRED', endedAt: soldOn }, now)).toEqual({
      reason: 'OWNERSHIP_TRANSFERRED',
      toDate: soldOn,
    });
  });

  it('never dates a sale before the register recorded the owner', () => {
    const tooEarly = new Date('2026-08-01T00:00:00Z');
    expect(spellEnding(owner, { reason: 'OWNERSHIP_TRANSFERRED', endedAt: tooEarly }, now).toDate).toEqual(
      owner.fromDate,
    );
  });

  it('ignores a sale on a spell that is not an owner’s', () => {
    expect(spellEnding(tenant, { reason: 'OWNERSHIP_TRANSFERRED' }, now)).toEqual({
      reason: null,
      toDate: now,
    });
  });
});

describe('the edit form says why a saved card is removed', () => {
  const personal = {
    firstName: 'سامي',
    middleName: 'علي',
    lastName: 'تجربة',
    motherName: 'ليلى',
    gender: 'MALE',
    isLebanese: true,
    civilRecordNumber: '12',
    residentStatus: 'VILLAGE_RESIDENT',
    nationality: 'LB',
  };
  const contact = {
    phone: '+96177000000',
    whatsappSameAsPhone: true,
    maritalStatus: 'MARRIED',
    actualHouseholdMembers: 3,
    totalRegisteredMembers: 3,
  };
  const id = '6a1f0d3e-2b0c-4a51-9d7e-3f1c2b4a5d6e';

  it('carries the answer through the submission', () => {
    const parsed = adminUpdateCitizenSubmissionSchema.parse({
      personal,
      contact,
      flags: [],
      properties: [],
      removals: [{ propertyId: id, reason: 'OWNERSHIP_TRANSFERRED', endedAt: '2026-09-20' }],
    });
    expect(parsed.removals).toEqual([
      { propertyId: id, reason: 'OWNERSHIP_TRANSFERRED', endedAt: new Date('2026-09-20') },
    ]);
  });

  it('refuses a reason that is not one of the two', () => {
    const result = adminUpdateCitizenSubmissionSchema.safeParse({
      personal,
      contact,
      flags: [],
      properties: [],
      removals: [{ propertyId: id, reason: 'MOVED_OUT' }],
    });
    expect(result.success).toBe(false);
  });

  it('sends nothing when nothing was answered, as older clients do', () => {
    const parsed = adminUpdateCitizenSubmissionSchema.parse({ personal, contact, flags: [], properties: [] });
    expect('removals' in parsed).toBe(false);
  });
});

describe('a passport number can be removed as well as replaced', () => {
  const foreigner = {
    firstName: 'Jean',
    middleName: 'Paul',
    lastName: 'Test',
    motherName: 'Marie',
    gender: 'MALE',
    isLebanese: false,
    nationality: 'FR',
    residentStatus: 'DISPLACED',
  };
  const contact = {
    phone: '+96177000000',
    whatsappSameAsPhone: true,
    maritalStatus: 'SINGLE',
    actualHouseholdMembers: 1,
    totalRegisteredMembers: 1,
  };
  const submit = (personal: Record<string, unknown>) =>
    adminUpdateCitizenSubmissionSchema.parse({ personal, contact, flags: [], properties: [] });

  it('clears a stored passport when its box comes back empty', () => {
    const columns = citizenColumnsForEdit(submit({ ...foreigner, identityDocNumber: '' }), {
      identityDocType: 'PASSPORT',
    });
    expect(columns).toMatchObject({ identityDocType: null, identityDocNumber: null });
  });

  it('keeps a document that was never in that box', () => {
    // A national ID on a record being corrected to non-Lebanese: the passport
    // box starts empty and says nothing about it.
    const columns = citizenColumnsForEdit(submit({ ...foreigner, identityDocNumber: '' }), {
      identityDocType: 'NATIONAL_ID',
    });
    expect(columns).not.toHaveProperty('identityDocNumber');
  });

  it('keeps it when the submission does not carry the field at all', () => {
    const columns = citizenColumnsForEdit(submit(foreigner), { identityDocType: 'PASSPORT' });
    expect(columns).not.toHaveProperty('identityDocNumber');
  });

  it('still writes a replacement', () => {
    const columns = citizenColumnsForEdit(submit({ ...foreigner, identityDocNumber: 'AB1234567' }), {
      identityDocType: 'PASSPORT',
    });
    expect(columns).toMatchObject({ identityDocType: 'PASSPORT', identityDocNumber: 'AB1234567' });
  });
});
