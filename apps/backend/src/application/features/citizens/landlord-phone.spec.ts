import {
  adminCreateCitizenSubmissionSchema,
  adminUpdateCitizenSubmissionSchema,
} from '@mechanization/shared-schemas';

/**
 * The landlord's phone on a tenancy card.
 *
 * A مستأجر must give it; a شاغل بتسامح need not — that asymmetry is why the two
 * are separate branches (`occupancyBranch`): the owner is often a relative who
 * is abroad, elderly or dead, and a required phone there produces an invented
 * one. The box is on screen and not flaggable on a free occupant's card, so a
 * number typed and then cleared left `''` in the draft, which was refused as
 * «رقم الهاتف غير صالح»: the only way past it was to type a number.
 *
 * Run through the whole submission schema rather than the card alone, because
 * what a strict pass accepts a second, shaping pass has to be able to parse
 * (`shapeSubmission`): relax one and not the other and a refused save becomes
 * a thrown error. Both the create and the edit schema, which build the card
 * differently (`identifiedPropertyEntrySchema` is an intersection).
 */

const household = () => ({
  personal: {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'نصرالله',
    motherName: 'فاطمة خليل',
    gender: 'MALE',
    civilRecordNumber: '7',
    nationality: 'لبناني',
    isLebanese: true,
    residentStatus: 'VILLAGE_RESIDENT',
  },
  contact: {
    maritalStatus: 'MARRIED',
    phone: '70123456',
    whatsappSameAsPhone: true,
    actualHouseholdMembers: '4',
  },
  flags: [] as Array<Record<string, unknown>>,
});

const STORED_CARD_ID = '3f1a0c6e-8b24-4d7a-9c15-2e6b0a91d4f7';

const card = (occupancyType: 'TENANT' | 'FREE_OCCUPANT', landlordPhone?: string) => ({
  occupancyType,
  landlordName: 'حسن جفال',
  ...(landlordPhone === undefined ? {} : { landlordPhone }),
  propertyType: 'LAND',
  propertyNumber: '7',
  landType: 'AGRICULTURAL',
  unitArea: '900',
});

/** What both submission schemas hand back, as far as this file reads it. */
type Parsed =
  | { success: true; data: { properties: Array<{ landlordPhone?: string }> } }
  | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };

const create = (properties: unknown[]): Parsed =>
  adminCreateCitizenSubmissionSchema.safeParse({ ...household(), properties });

/** An edit sends the stored card back by its id, so the edit schema's intersection is exercised. */
const edit = (properties: Array<Record<string, unknown>>): Parsed =>
  adminUpdateCitizenSubmissionSchema.safeParse({
    residence: 'RESIDENT',
    ...household(),
    properties: properties.map((property) => ({ id: STORED_CARD_ID, ...property })),
  });

const messages = (result: Parsed): string[] =>
  result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

const landlordPhoneOf = (result: Parsed) => {
  if (!result.success) throw new Error(JSON.stringify(messages(result)));
  return result.data.properties[0]!.landlordPhone;
};

describe('the landlord’s phone on a شاغل بتسامح card — optional', () => {
  it('saves with no number at all', () => {
    expect(messages(create([card('FREE_OCCUPANT')]))).toEqual([]);
  });

  it('saves with the box emptied after a number was typed, and stores no number', () => {
    const result = create([card('FREE_OCCUPANT', '')]);
    expect(messages(result)).toEqual([]);
    expect(landlordPhoneOf(result)).toBeUndefined();
  });

  it('reads a box holding only spaces as empty', () => {
    expect(landlordPhoneOf(create([card('FREE_OCCUPANT', '   ')]))).toBeUndefined();
  });

  it('normalises a number that is given', () => {
    expect(landlordPhoneOf(create([card('FREE_OCCUPANT', '03 111222')]))).toBe('+9613111222');
  });

  it('still refuses a malformed number, in Arabic, on its own path', () => {
    expect(messages(create([card('FREE_OCCUPANT', '12')]))).toEqual([
      'properties.0.landlordPhone: رقم الهاتف غير صالح',
    ]);
  });

  it('saves an edit of a stored card whose box was emptied, and sends no number to store', () => {
    /*
      On an edit an absent number is written as NULL, which is what clears the
      stored one (`citizens.service.ts`, `landlordPhone ?? null`). Sent as `''`
      it would have been refused, and the old number could not be cleared.
    */
    const result = edit([card('FREE_OCCUPANT', '')]);
    expect(messages(result)).toEqual([]);
    expect(landlordPhoneOf(result)).toBeUndefined();
  });

  it('parses an edit the same whether the box is emptied or the key is absent', () => {
    expect(landlordPhoneOf(edit([card('FREE_OCCUPANT')]))).toBe(
      landlordPhoneOf(edit([card('FREE_OCCUPANT', '')])),
    );
  });
});

describe('the landlord’s phone on a مستأجر card — still required', () => {
  const paths = (result: Parsed) => messages(result).map((entry) => entry.split(':')[0]);

  it('refuses an absent number', () => {
    expect(paths(create([card('TENANT')]))).toEqual(['properties.0.landlordPhone']);
  });

  it('refuses an emptied box: that is not an answer either', () => {
    expect(paths(create([card('TENANT', '')]))).toEqual(['properties.0.landlordPhone']);
  });

  it('refuses both on an edit too', () => {
    expect(paths(edit([card('TENANT')]))).toEqual(['properties.0.landlordPhone']);
    expect(paths(edit([card('TENANT', '')]))).toEqual(['properties.0.landlordPhone']);
  });

  it('accepts the number once it is given', () => {
    expect(landlordPhoneOf(create([card('TENANT', '03 111222')]))).toBe('+9613111222');
  });
});
