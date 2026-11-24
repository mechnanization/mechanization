import { describe, expect, it } from 'vitest';
import { PROPERTY_FIELD_MAP } from '@mechanization/shared-schemas';
import {
  askableFields,
  askablePaths,
  isBlank,
  reindexFlags,
  reindexRowFlags,
  valueAtPath,
} from '@/lib/citizen-form-askable';
import { toPayloadProperty, toSubmission } from '@/lib/citizen-form-payload';
import { submissionFieldErrors, validate } from '@/lib/citizen-form-validation';
import { emptyCitizen, type CitizenFormValues, type PropertyDraft } from '@/lib/citizen-form-values';
import { flagsToArray } from '@/lib/field-flags';

/*
  GOD-22, phase 1 (cleanup sprint, 2026-11-24): the citizen form's pure logic
  left `components/admin/citizen-form.tsx` for `lib`, text unchanged, and had no
  test of its own while it was there. These pin what it does today — which
  fields the form asks, how its flags are renumbered, what goes on the wire,
  and how the shared schema's complaints are keyed — so the second phase, which
  splits the component itself, has something to fail against.
*/

const record = (patch: Partial<CitizenFormValues> = {}): CitizenFormValues => ({ ...emptyCitizen(), ...patch });
const card = (patch: Record<string, unknown>): PropertyDraft => patch as PropertyDraft;
const paths = (values: CitizenFormValues): string[] => askableFields(values).map((entry) => entry.path);

describe('emptyCitizen', () => {
  it('is a household with no cards, Lebanese by default', () => {
    const empty = emptyCitizen();
    expect(empty.residence).toBe('RESIDENT');
    expect(empty.personal).toEqual({ isLebanese: true });
    expect(empty.contact).toEqual({ whatsappSameAsPhone: true, hasNoPhone: false });
    expect(empty.properties).toEqual([]);
  });

  it('hands every form its own Maps, so one officer’s flags cannot leak into the next blank form', () => {
    const first = emptyCitizen();
    const second = emptyCitizen();
    first.flags.set('personal.firstName', 'unknown');
    expect(second.flags.size).toBe(0);
    expect(first.flags).not.toBe(second.flags);
    expect(first.unverified).not.toBe(second.unverified);
    expect(first.properties).not.toBe(second.properties);
  });
});

describe('askableFields', () => {
  it('a Lebanese household is asked a civil record number and no identity document', () => {
    expect(paths(record())).toEqual([
      'personal.firstName',
      'personal.middleName',
      'personal.lastName',
      'personal.motherName',
      'personal.gender',
      'personal.residentStatus',
      'personal.civilRecordNumber',
      'contact.maritalStatus',
      'contact.totalRegisteredMembers',
      'contact.actualHouseholdMembers',
      'contact.phone',
    ]);
  });

  it('a non-Lebanese is asked nationality, identity document and residency instead', () => {
    const asked = paths(record({ personal: { isLebanese: false } }));
    expect(asked).toEqual(
      expect.arrayContaining(['personal.nationality', 'personal.identityDocNumber', 'personal.residencyNumber']),
    );
    expect(asked).not.toContain('personal.civilRecordNumber');
  });

  it('«لا يملك رقم هاتف» answers the phone question: neither number is asked', () => {
    const asked = paths(record({ contact: { hasNoPhone: true, whatsappSameAsPhone: false } }));
    expect(asked).not.toContain('contact.phone');
    expect(asked).not.toContain('contact.whatsapp');
  });

  it('a separate WhatsApp number is asked only when it is not the phone', () => {
    expect(paths(record())).not.toContain('contact.whatsapp');
    expect(paths(record({ contact: { whatsappSameAsPhone: false, hasNoPhone: false } }))).toContain('contact.whatsapp');
  });

  it('a non-resident owner is asked five things, and a sixth for a separate WhatsApp', () => {
    expect(paths(record({ residence: 'NON_RESIDENT_OWNER' }))).toEqual([
      'personal.firstName',
      'personal.middleName',
      'personal.lastName',
      'personal.residencePlace',
      'contact.phone',
    ]);
    expect(
      paths(record({ residence: 'NON_RESIDENT_OWNER', contact: { whatsappSameAsPhone: false } })),
    ).toContain('contact.whatsapp');
  });

  it('an estate is asked the deceased’s name, an institution only its own', () => {
    expect(paths(record({ residence: 'ESTATE' }))).toEqual(['personal.firstName', 'personal.middleName', 'personal.lastName']);
    expect(paths(record({ residence: 'INSTITUTION' }))).toEqual(['personal.firstName']);
  });

  it('carries the section, and the card and unit a field belongs to', () => {
    const owner = record({
      properties: [card({ propertyType: 'BUILDING', occupancyType: 'OWNER', units: [{}, {}] })],
    });
    const asked = askableFields(owner);
    const unit = asked.find((entry) => entry.path === 'properties.0.units.1.unitStatus');
    expect(unit).toEqual({
      path: 'properties.0.units.1.unitStatus',
      field: 'unitStatus',
      section: 'properties',
      propertyIndex: 0,
      unitIndex: 1,
    });
    expect(asked.find((entry) => entry.path === 'personal.firstName')?.section).toBe('personal');
    expect(asked.find((entry) => entry.path === 'contact.phone')?.section).toBe('contact');
  });

  describe('a property card', () => {
    const asked = (patch: Record<string, unknown>): string[] => paths(record({ properties: [card(patch)] })).filter((p) => p.startsWith('properties.'));

    it('asks the fields its type carries, never «اسم المبنى»', () => {
      for (const type of Object.keys(PROPERTY_FIELD_MAP) as Array<keyof typeof PROPERTY_FIELD_MAP>) {
        expect(asked({ propertyType: type, occupancyType: 'TENANT' }), type).not.toContain('properties.0.buildingName');
      }
    });

    it('asks a share only of an owner', () => {
      const withShares = (Object.keys(PROPERTY_FIELD_MAP) as Array<keyof typeof PROPERTY_FIELD_MAP>).find((type) =>
        (PROPERTY_FIELD_MAP[type] as readonly string[]).includes('shares'),
      );
      if (!withShares) return; // no type carries one: nothing to check
      expect(asked({ propertyType: withShares, occupancyType: 'OWNER' })).toContain('properties.0.shares');
      expect(asked({ propertyType: withShares, occupancyType: 'TENANT' })).not.toContain('properties.0.shares');
    });

    it('asks «حالة الوحدة» of an owner of a house, and of each flat of an owner’s building', () => {
      expect(asked({ propertyType: 'HOUSE', occupancyType: 'OWNER' })).toContain('properties.0.unitStatus');
      expect(asked({ propertyType: 'HOUSE', occupancyType: 'TENANT' })).not.toContain('properties.0.unitStatus');
      expect(asked({ propertyType: 'BUILDING', occupancyType: 'OWNER', units: [{}, {}, {}] })).toEqual(
        expect.arrayContaining([0, 1, 2].map((n) => `properties.0.units.${n}.unitStatus`)),
      );
      expect(asked({ propertyType: 'BUILDING', occupancyType: 'TENANT', units: [{}] })).not.toContain('properties.0.units.0.unitStatus');
    });

    it('asks a tenant for the landlord’s name and phone, a free occupant for the name only', () => {
      expect(asked({ propertyType: 'HOUSE', occupancyType: 'TENANT' })).toEqual(
        expect.arrayContaining(['properties.0.landlordName', 'properties.0.landlordPhone']),
      );
      const free = asked({ propertyType: 'HOUSE', occupancyType: 'FREE_OCCUPANT' });
      expect(free).toContain('properties.0.landlordName');
      expect(free).not.toContain('properties.0.landlordPhone');
      expect(asked({ propertyType: 'HOUSE', occupancyType: 'OWNER' })).not.toContain('properties.0.landlordName');
    });

    it('asks neither of a card whose owner the register established', () => {
      for (const link of [{ landlordLink: { citizenId: 'c1' } }, { landlordCitizenId: 'c1' }]) {
        const linked = asked({ propertyType: 'HOUSE', occupancyType: 'TENANT', ...link });
        expect(linked).not.toContain('properties.0.landlordName');
        expect(linked).not.toContain('properties.0.landlordPhone');
      }
    });

    it('numbers each card by its position', () => {
      const two = paths(
        record({ properties: [card({ propertyType: 'HOUSE', occupancyType: 'TENANT' }), card({ propertyType: 'HOUSE', occupancyType: 'TENANT' })] }),
      );
      expect(two).toContain('properties.0.landlordName');
      expect(two).toContain('properties.1.landlordName');
    });
  });
});

describe('askablePaths', () => {
  it('is askableFields as a set', () => {
    const values = record({ properties: [card({ propertyType: 'HOUSE', occupancyType: 'TENANT' })] });
    expect(askablePaths(values)).toEqual(new Set(paths(values)));
  });
});

describe('renumbering flags when a card or a row goes', () => {
  const flags = new Map([
    ['personal.firstName', 'a'],
    ['properties.0.neighborhood', 'b'],
    ['properties.1.neighborhood', 'c'],
    ['properties.2.units.1.unitStatus', 'd'],
    ['properties.2.propertyNumber', 'e'],
  ]);

  it('drops the removed card’s flags and moves the later cards down one', () => {
    expect(Object.fromEntries(reindexFlags(flags, 1))).toEqual({
      'personal.firstName': 'a',
      'properties.0.neighborhood': 'b',
      'properties.1.units.1.unitStatus': 'd',
      'properties.1.propertyNumber': 'e',
    });
  });

  it('leaves the flags of earlier cards and of the person alone, and does not mutate its input', () => {
    const before = [...flags];
    reindexFlags(flags, 2);
    expect([...flags]).toEqual(before);
    expect(reindexFlags(flags, 2).get('properties.0.neighborhood')).toBe('b');
    expect(reindexFlags(flags, 2).get('personal.firstName')).toBe('a');
  });

  it('removing a row drops that row’s flags and moves the later rows of that card up', () => {
    const rows = new Map([
      ['properties.0.units.0.unitStatus', 'r0'],
      ['properties.0.units.1.unitStatus', 'r1'],
      ['properties.0.units.2.unitStatus', 'r2'],
      ['properties.1.units.1.unitStatus', 'other card'],
      ['properties.0.neighborhood', 'card flag'],
    ]);
    expect(Object.fromEntries(reindexRowFlags(rows, 0, 1))).toEqual({
      'properties.0.units.0.unitStatus': 'r0',
      'properties.0.units.1.unitStatus': 'r2',
      'properties.1.units.1.unitStatus': 'other card',
      'properties.0.neighborhood': 'card flag',
    });
  });
});

describe('reading the draft by path', () => {
  const values = record({
    personal: { firstName: 'Amal' },
    contact: { phone: '71 123 456' },
    properties: [card({ neighborhood: 'Old Town', units: [{ floor: '1' }, { floor: '2' }] })],
  });

  it('reads the person, the contact, a card and a unit of a card', () => {
    expect(valueAtPath(values, 'personal.firstName')).toBe('Amal');
    expect(valueAtPath(values, 'contact.phone')).toBe('71 123 456');
    expect(valueAtPath(values, 'properties.0.neighborhood')).toBe('Old Town');
    expect(valueAtPath(values, 'properties.0.units.1.floor')).toBe('2');
  });

  it('reads nothing where there is no card or no unit', () => {
    expect(valueAtPath(values, 'properties.3.neighborhood')).toBeUndefined();
    expect(valueAtPath(values, 'properties.0.units.5.floor')).toBeUndefined();
  });

  it('calls a value blank the way the server does', () => {
    for (const blank of [undefined, null, '', '   ', []]) expect(isBlank(blank)).toBe(true);
    for (const filled of [0, false, 'x', [1]]) expect(isBlank(filled)).toBe(false);
  });
});

describe('what goes on the wire', () => {
  describe('a property card', () => {
    it('drops what describes work still to be done or what the form only displays', () => {
      const sent = toPayloadProperty(
        card({
          id: 'p1',
          buildingId: 'b1',
          pendingBuilding: { id: 'b1', parcelNumber: '12', structureType: 'RESIDENTIAL_BUILDING', acknowledgedDuplicates: false },
          landlordLink: { citizenId: 'c1', name: 'Owner', displayName: 'Owner', referenceNumber: null },
          landlordAgreedName: 'Owner',
          propertyType: 'HOUSE',
          occupancyType: 'OWNER',
        }),
      );
      expect(sent).not.toHaveProperty('pendingBuilding');
      expect(sent).not.toHaveProperty('landlordLink');
      expect(sent).not.toHaveProperty('landlordAgreedName');
      expect(sent).toMatchObject({ id: 'p1', buildingId: 'b1', propertyType: 'HOUSE', occupancyType: 'OWNER' });
    });

    it('omits an id and a building that are absent rather than sending them empty', () => {
      const sent = toPayloadProperty(card({ propertyType: 'HOUSE', occupancyType: 'OWNER' }));
      expect(sent).not.toHaveProperty('id');
      expect(sent).not.toHaveProperty('buildingId');
    });

    it('turns the numeric strings the inputs produce into numbers, and drops the empty ones', () => {
      expect(toPayloadProperty(card({ occupancyType: 'OWNER', unitArea: '120', shares: '3' }))).toMatchObject({ unitArea: 120, shares: 3 });
      const empty = toPayloadProperty(card({ occupancyType: 'OWNER', unitArea: '', shares: '' }));
      expect(empty).not.toHaveProperty('unitArea');
      expect(empty).not.toHaveProperty('shares');
    });

    it('sends a share of ownership only for an owner', () => {
      expect(toPayloadProperty(card({ occupancyType: 'TENANT', shares: '3' }))).not.toHaveProperty('shares');
      expect(toPayloadProperty(card({ occupancyType: 'OWNER', shares: '3' }))).toHaveProperty('shares', 3);
    });

    it('carries each unit with its identity and its area as a number', () => {
      const sent = toPayloadProperty(
        card({
          occupancyType: 'OWNER',
          units: [{ id: 'u1', unitId: 'census-1', unitType: 'APARTMENT', unitArea: '80', floor: '2' }, { unitType: 'SHOP', unitArea: '' }],
        }),
      );
      expect(sent.units).toEqual([
        { id: 'u1', unitId: 'census-1', unitType: 'APARTMENT', unitArea: 80, floor: '2' },
        { unitType: 'SHOP' },
      ]);
    });
  });

  describe('the submission', () => {
    it('is a household unless it says otherwise, and always says it asked «حالة الوحدة»', () => {
      const sent = toSubmission(record({ residence: undefined }));
      expect(sent.residence).toBe('RESIDENT');
      expect(sent.unitStatusAsked).toBe(true);
      expect(sent.properties).toEqual([]);
    });

    it('sends the flags as an array, in the order they were set, as «غير مؤكَّد»', () => {
      const flags = new Map([
        ['personal.firstName', 'not given'],
        ['contact.phone', 'no signal'],
      ]);
      expect(toSubmission(record({ flags })).flags).toEqual([
        { path: 'personal.firstName', reason: 'not given', kind: 'UNESTABLISHED' },
        { path: 'contact.phone', reason: 'no signal', kind: 'UNESTABLISHED' },
      ]);
      expect(flagsToArray(flags)).toEqual(toSubmission(record({ flags })).flags);
    });

    it('sends a note, a blanket reason, removals and a move only when there is one', () => {
      const bare = toSubmission(record());
      for (const key of ['notes', 'blanketFlagReason', 'removals', 'movedOn']) expect(bare, key).not.toHaveProperty(key);

      const full = toSubmission(
        record({
          notes: '  the stairs are broken  ',
          blanketFlagReason: 'no one home',
          removals: [{ propertyId: 'p1', reason: 'MISTAKE' } as never],
          residenceMove: { movedOn: '2026-11-01', reason: 'moved out' },
        }),
      );
      expect(full.notes).toBe('the stairs are broken');
      expect(full.blanketFlagReason).toBe('no one home');
      expect(full.removals).toHaveLength(1);
      expect(full.movedOn).toBe('2026-11-01');
      expect(toSubmission(record({ notes: '   ' }))).not.toHaveProperty('notes');
    });

    describe('the personal section, by kind of file', () => {
      const personal = {
        firstName: 'A',
        middleName: 'B',
        lastName: 'C',
        motherName: 'D',
        residencePlace: 'Beirut',
        identityDocType: 'PASSPORT',
        identityDocNumber: '123',
        residencyNumber: '456',
        nationality: 'X',
        isLebanese: true,
      };

      it('a Lebanese household sends no identity document', () => {
        const sent = toSubmission(record({ personal })).personal;
        expect(sent).not.toHaveProperty('identityDocType');
        expect(sent).not.toHaveProperty('identityDocNumber');
        expect(sent).not.toHaveProperty('residencyNumber');
        expect(sent).toMatchObject({ firstName: 'A', motherName: 'D', nationality: 'X' });
      });

      it('a non-Lebanese keeps it', () => {
        expect(toSubmission(record({ personal: { ...personal, isLebanese: false } })).personal).toMatchObject({
          identityDocNumber: '123',
          residencyNumber: '456',
        });
      });

      it('a non-resident owner sends the three names and the place; an estate the three names; an institution its name', () => {
        expect(toSubmission(record({ residence: 'NON_RESIDENT_OWNER', personal })).personal).toEqual({
          firstName: 'A',
          middleName: 'B',
          lastName: 'C',
          residencePlace: 'Beirut',
        });
        expect(toSubmission(record({ residence: 'ESTATE', personal })).personal).toEqual({ firstName: 'A', middleName: 'B', lastName: 'C' });
        expect(toSubmission(record({ residence: 'INSTITUTION', personal })).personal).toEqual({ firstName: 'A' });
      });
    });

    describe('the contact section, by kind of file', () => {
      it('a household sends its contact, without a WhatsApp number nobody is using', () => {
        const sent = toSubmission(
          record({ contact: { phone: '71', whatsapp: '72', whatsappSameAsPhone: true, hasNoPhone: false, maritalStatus: 'MARRIED' } }),
        ).contact;
        expect(sent).toEqual({ phone: '71', whatsappSameAsPhone: true, hasNoPhone: false, maritalStatus: 'MARRIED' });
        expect(
          toSubmission(record({ contact: { phone: '71', whatsapp: '72', whatsappSameAsPhone: false, hasNoPhone: false } })).contact,
        ).toMatchObject({ whatsapp: '72' });
      });

      it('an owner record sends a phone and somebody to reach, and nothing a household is asked', () => {
        const sent = toSubmission(
          record({
            residence: 'NON_RESIDENT_OWNER',
            contact: {
              phone: '71',
              whatsapp: '72',
              whatsappSameAsPhone: false,
              localContactName: 'Cousin',
              localContactPhone: '73',
              maritalStatus: 'MARRIED',
              totalRegisteredMembers: 4,
            },
          }),
        ).contact;
        expect(sent).toEqual({ phone: '71', whatsapp: '72', whatsappSameAsPhone: false, localContactName: 'Cousin', localContactPhone: '73' });
      });
    });
  });
});

describe('the schema’s complaints, keyed by the field they are about', () => {
  const failing = (issues: Array<{ path: PropertyKey[]; message: string }>) => ({
    safeParse: () => ({ success: false as const, error: { issues } }),
  });

  it('is empty when the schema is satisfied', () => {
    expect(submissionFieldErrors(record(), { safeParse: () => ({ success: true as const }) })).toEqual({});
  });

  it('keys an issue by its dot-path, and keeps the first of two on one field', () => {
    const errors = submissionFieldErrors(
      record(),
      failing([
        { path: ['personal', 'firstName'], message: 'required' },
        { path: ['personal', 'firstName'], message: 'too short' },
        { path: ['properties', 0, 'units', 1, 'floor'], message: 'bad floor' },
      ]),
    );
    expect(errors).toEqual({ 'personal.firstName': 'required', 'properties.0.units.1.floor': 'bad floor' });
  });

  it('puts a complaint about a flag on the field the flag excuses', () => {
    const flags = new Map([
      ['personal.firstName', ''],
      ['properties.0.propertyNumber', ''],
    ]);
    const errors = submissionFieldErrors(record({ flags }), failing([{ path: ['flags', 1, 'reason'], message: 'give a reason' }]));
    expect(errors).toEqual({ 'properties.0.propertyNumber': 'give a reason' });
  });

  it('judges what the form would send, by the create schema', () => {
    const errors = validate(record());
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    for (const key of Object.keys(errors)) expect(key).toMatch(/^(personal|contact|properties|flags|residence)\b/);
  });
});
