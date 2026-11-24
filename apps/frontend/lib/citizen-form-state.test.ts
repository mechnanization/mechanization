import { describe, expect, it } from 'vitest';
import {
  collapsedAfterAdd,
  collapsedAfterRemoval,
  groupProperties,
  holdsDisallowedType,
  holdsUnaskableFlag,
  phoneNoteOf,
  withAddedProperty,
  withDisallowedTypesCleared,
  withEndedRowsRemoved,
  withFlag,
  withFlagsApplied,
  withoutFlag,
  withProperty,
  withRemovedProperty,
  withUnaskableFlagsDropped,
} from '@/lib/citizen-form-state';
import { emptyCitizen, type CitizenFormValues, type PropertyDraft } from '@/lib/citizen-form-values';

/*
  GOD-22, phase 2c (cleanup sprint, 2026-11-24): the citizen form's state
  transitions, which were bodies of `setValues` updaters inside `CitizenForm`
  until they were moved to `lib/citizen-form-state.ts` unchanged. The render
  test sees the form's first paint and nothing after a change; these are what
  the form does once somebody types, flags a field, adds a card or removes one.
*/

const card = (patch: Record<string, unknown> = {}): PropertyDraft => patch as PropertyDraft;
const record = (patch: Partial<CitizenFormValues> = {}): CitizenFormValues => ({ ...emptyCitizen(), ...patch });
const flags = (entries: Array<[string, string]>) => new Map(entries);

describe('flags: raising one empties the field it covers (withFlag)', () => {
  it('on a personal field, and leaves the others and the input alone', () => {
    const before = record({ personal: { firstName: 'Amal', motherName: 'Salma' } });
    const after = withFlag(before, 'personal.motherName', 'not known');
    expect(after.personal).toEqual({ firstName: 'Amal' });
    expect(after.flags.get('personal.motherName')).toBe('not known');
    // nothing mutated: the draft the parent holds is the one it passed in
    expect(before.personal).toEqual({ firstName: 'Amal', motherName: 'Salma' });
    expect(before.flags.size).toBe(0);
  });

  it('on a contact field', () => {
    const after = withFlag(record({ contact: { phone: '71123456' } }), 'contact.phone', 'refused');
    expect(after.contact.phone).toBeUndefined();
    expect(after.flags.get('contact.phone')).toBe('refused');
  });

  it('on one field of one card, by its index', () => {
    const before = record({ properties: [card({ neighborhood: 'A' }), card({ neighborhood: 'B', propertyNumber: '7' })] });
    const after = withFlag(before, 'properties.1.neighborhood', 'unsure');
    expect(after.properties[0]).toEqual({ neighborhood: 'A' });
    expect(after.properties[1]).toEqual({ propertyNumber: '7' });
    expect(after.flags.get('properties.1.neighborhood')).toBe('unsure');
  });

  it('amending a flag’s reason keeps the field empty and changes only the reason', () => {
    const once = withFlag(record({ personal: { motherName: 'Salma' } }), 'personal.motherName', 'a');
    const twice = withFlag(once, 'personal.motherName', 'a longer reason');
    expect(twice.personal.motherName).toBeUndefined();
    expect(twice.flags.get('personal.motherName')).toBe('a longer reason');
    expect(twice.flags.size).toBe(1);
  });

  it('withdrawing it leaves the field empty, where it was', () => {
    const flagged = withFlag(record({ personal: { motherName: 'Salma' } }), 'personal.motherName', 'a');
    const cleared = withoutFlag(flagged, 'personal.motherName');
    expect(cleared.flags.size).toBe(0);
    expect(cleared.personal.motherName).toBeUndefined();
  });

  it('the dialog’s saved flags empty every field they cover, in each section', () => {
    const before = record({
      personal: { firstName: 'Amal', motherName: 'Salma' },
      contact: { phone: '71123456' },
      properties: [card({ neighborhood: 'A', propertyNumber: '1' })],
    });
    const after = withFlagsApplied(
      before,
      flags([
        ['personal.motherName', 'x'],
        ['contact.phone', 'y'],
        ['properties.0.neighborhood', 'z'],
      ]),
    );
    expect(after.personal).toEqual({ firstName: 'Amal' });
    expect(after.contact.phone).toBeUndefined();
    expect(after.properties[0]).toEqual({ propertyNumber: '1' });
    expect(after.flags.size).toBe(3);
  });
});

describe('a card is updated from whatever it holds when the update runs (withProperty)', () => {
  it('changes one card, and two writes compose rather than the second reverting the first', () => {
    const start = record({ properties: [card({ neighborhood: 'A' }), card({ neighborhood: 'B' })] });
    const linked = withProperty(start, 0, (p) => ({ ...p, buildingId: 'b-1' }));
    const named = withProperty(linked, 0, (p) => ({ ...p, buildingName: 'Cedar' }));
    expect(named.properties[0]).toEqual({ neighborhood: 'A', buildingId: 'b-1', buildingName: 'Cedar' });
    expect(named.properties[1]).toBe(start.properties[1]);
  });
});

describe('a new card (withAddedProperty, collapsedAfterAdd)', () => {
  it('inherits the last card’s occupancy, and nothing else', () => {
    const after = withAddedProperty(record({ properties: [card({ occupancyType: 'TENANT', propertyNumber: '5' })] }));
    expect(after.properties).toHaveLength(2);
    expect(after.properties[1]).toEqual({ occupancyType: 'TENANT' });
  });

  it('on an estate is an owner’s, whatever the last one was', () => {
    const after = withAddedProperty(record({ residence: 'ESTATE', properties: [card({ occupancyType: 'TENANT' })] }));
    expect(after.properties[1]).toEqual({ occupancyType: 'OWNER' });
  });

  it('on the same parcel copies the number and الحي from that card', () => {
    const start = record({
      properties: [card({ occupancyType: 'OWNER', propertyNumber: '12', neighborhood: 'Old Town' }), card({ occupancyType: 'TENANT' })],
    });
    const after = withAddedProperty(start, 0);
    expect(after.properties[2]).toEqual({ occupancyType: 'OWNER', propertyNumber: '12', neighborhood: 'Old Town' });
  });

  it('folds every card but the new one', () => {
    expect([...collapsedAfterAdd([card(), card(), card()])]).toEqual([0, 1]);
    expect([...collapsedAfterAdd([card()])]).toEqual([]);
  });
});

describe('a removed card takes its flags and its fold with it (withRemovedProperty, collapsedAfterRemoval)', () => {
  const start = record({
    properties: [card({ id: 'p0' }), card({ id: 'p1' }), card({ id: 'p2' })],
    flags: flags([
      ['properties.0.neighborhood', 'a'],
      ['properties.1.neighborhood', 'b'],
      ['properties.2.neighborhood', 'c'],
      ['personal.motherName', 'd'],
    ]),
    unverified: flags([['properties.2.propertyNumber', 'not in the cadastre']]),
  });

  it('drops the card’s own flags and shifts the later ones down, and leaves the person’s flags', () => {
    const after = withRemovedProperty(start, 1);
    expect(after.properties.map((p) => p.id)).toEqual(['p0', 'p2']);
    expect([...after.flags.entries()]).toEqual([
      ['properties.0.neighborhood', 'a'],
      ['properties.1.neighborhood', 'c'],
      ['personal.motherName', 'd'],
    ]);
  });

  it('renumbers the server’s «بانتظار التحقق» notes the same way', () => {
    const after = withRemovedProperty(start, 0);
    expect([...after.unverified.keys()]).toEqual(['properties.1.propertyNumber']);
  });

  it('keeps the officer’s answer under the removed card’s id, replacing an earlier one for it', () => {
    const answered = withRemovedProperty(start, 1, { reason: 'SOLD' } as never);
    expect(answered.removals).toEqual([{ propertyId: 'p1', reason: 'SOLD' }]);
    const again = withRemovedProperty(
      { ...start, removals: [{ propertyId: 'p1', reason: 'OLD' } as never, { propertyId: 'p9', reason: 'KEEP' } as never] },
      1,
      { reason: 'SOLD' } as never,
    );
    expect(again.removals).toEqual([
      { propertyId: 'p9', reason: 'KEEP' },
      { propertyId: 'p1', reason: 'SOLD' },
    ]);
  });

  it('records no answer for a card that was never saved (no id), or when none is given', () => {
    const unsaved = record({ properties: [card({}), card({ id: 'p1' })] });
    expect(withRemovedProperty(unsaved, 0, { reason: 'SOLD' } as never).removals).toBeUndefined();
    expect(withRemovedProperty(start, 1).removals).toBeUndefined();
  });

  it('shifts the folded cards: those above the removed one move down, the removed one is gone', () => {
    expect([...collapsedAfterRemoval(new Set([0, 2, 3]), 1)].sort()).toEqual([0, 1, 2]);
    expect([...collapsedAfterRemoval(new Set([1]), 1)]).toEqual([]);
    expect([...collapsedAfterRemoval(new Set([0]), 2)]).toEqual([0]);
  });
});

describe('rows ended while the card stays (withEndedRowsRemoved)', () => {
  const start = record({
    properties: [card({ units: [{ id: 'u0' }, { id: 'u1' }, { id: 'u2' }] as never })],
    flags: flags([
      ['properties.0.units.0.unitType', 'a'],
      ['properties.0.units.1.unitType', 'b'],
      ['properties.0.units.2.unitType', 'c'],
    ]),
  });

  it('takes the ended rows out by id, and renumbers the flags of the rows after them', () => {
    const after = withEndedRowsRemoved(start, 0, ['u1']);
    expect(after.properties[0].units?.map((u) => u.id)).toEqual(['u0', 'u2']);
    expect([...after.flags.entries()]).toEqual([
      ['properties.0.units.0.unitType', 'a'],
      ['properties.0.units.1.unitType', 'c'],
    ]);
  });

  it('handles several ended rows at once', () => {
    const after = withEndedRowsRemoved(start, 0, ['u0', 'u2']);
    expect(after.properties[0].units?.map((u) => u.id)).toEqual(['u1']);
    expect([...after.flags.entries()]).toEqual([['properties.0.units.0.unitType', 'b']]);
  });

  it('returns the very object it was given when nothing matches, so React does not re-render', () => {
    expect(withEndedRowsRemoved(start, 0, ['nope'])).toBe(start);
    expect(withEndedRowsRemoved(start, 5, ['u0'])).toBe(start);
    expect(withEndedRowsRemoved(start, 0, [])).toBe(start);
  });
});

describe('property cards are grouped by رقم العقار (groupProperties)', () => {
  it('puts cards that share a number in one group, in the order they first appear', () => {
    const groups = groupProperties([
      card({ propertyNumber: '12' }),
      card({ propertyNumber: '40' }),
      card({ propertyNumber: ' 12 ' }),
    ]);
    expect(groups).toEqual([
      { propertyNumber: '12', indices: [0, 2] },
      { propertyNumber: '40', indices: [1] },
    ]);
  });

  it('gives every card with no number a group of its own', () => {
    const groups = groupProperties([card({}), card({ propertyNumber: '  ' }), card({ propertyNumber: '7' })]);
    expect(groups.map((g) => g.indices)).toEqual([[0], [1], [2]]);
    expect(groups.map((g) => g.propertyNumber)).toEqual([null, null, '7']);
  });
});

describe('what the form stops asking about is cleared (withDisallowedTypesCleared, withUnaskableFlagsDropped)', () => {
  it('clears a type the صفة الإقامة no longer permits, with its tent location, and keeps the rest', () => {
    const start = record({
      properties: [card({ propertyType: 'TENT', tentLocation: 'camp', neighborhood: 'A' }), card({ propertyType: 'HOUSE' }), card({})],
    });
    const permitted = new Set(['HOUSE', 'LAND']);
    expect(holdsDisallowedType(start.properties, permitted)).toBe(true);
    const after = withDisallowedTypesCleared(start, permitted);
    expect(after.properties[0]).toEqual({ propertyType: undefined, tentLocation: undefined, neighborhood: 'A' });
    expect(after.properties[1]).toBe(start.properties[1]);
    expect(holdsDisallowedType(after.properties, permitted)).toBe(false);
  });

  it('holds nothing disallowed when every card is blank or permitted', () => {
    expect(holdsDisallowedType([card({}), card({ propertyType: 'HOUSE' })], new Set(['HOUSE']))).toBe(false);
  });

  it('withdraws a flag on a field that is no longer asked, and keeps the others in order', () => {
    const start = flags([
      ['personal.motherName', 'a'],
      ['properties.0.tentLocation', 'b'],
      ['contact.phone', 'c'],
    ]);
    const askable = new Set(['personal.motherName', 'contact.phone']);
    expect(holdsUnaskableFlag(start, askable)).toBe(true);
    const after = withUnaskableFlagsDropped(record({ flags: start }), askable);
    expect([...after.flags.keys()]).toEqual(['personal.motherName', 'contact.phone']);
    expect(holdsUnaskableFlag(after.flags, askable)).toBe(false);
  });
});

describe('the note under the phone box (phoneNoteOf)', () => {
  const contact = (patch: Record<string, unknown>) => patch as CitizenFormValues['contact'];

  it('says nothing on a new filing, or when the number on a saved file is unchanged', () => {
    expect(phoneNoteOf('', contact({ phone: '71123456' }), 'RESIDENT', 'create')).toBeNull();
    expect(phoneNoteOf('71123456', contact({ phone: '71123456' }), 'RESIDENT', 'edit')).toBeNull();
  });

  it('compares numbers without spaces', () => {
    expect(phoneNoteOf('71 123 456', contact({ phone: '71123456' }), 'RESIDENT', 'edit')).toBeNull();
  });

  it('says the sign-in changes when a saved file’s number is changed, naming the old one', () => {
    expect(phoneNoteOf('71 123 456', contact({ phone: '03999999' }), 'RESIDENT', 'edit')).toEqual({
      kind: 'changed',
      oldNumber: '71123456',
    });
  });

  it('has its own note for «لا يملك رقم هاتف», naming the old number only on a saved file that had one', () => {
    expect(phoneNoteOf('71123456', contact({ phone: '71123456', hasNoPhone: true }), 'RESIDENT', 'edit')).toEqual({
      kind: 'noPhone',
      oldNumber: '71123456',
    });
    expect(phoneNoteOf('', contact({ hasNoPhone: true }), 'RESIDENT', 'edit')).toEqual({ kind: 'noPhone', oldNumber: null });
    expect(phoneNoteOf('71123456', contact({ hasNoPhone: true }), 'RESIDENT', 'create')).toEqual({
      kind: 'noPhone',
      oldNumber: null,
    });
  });

  it('never applies «لا يملك رقم هاتف» to an estate or an institution', () => {
    expect(phoneNoteOf('', contact({ hasNoPhone: true }), 'ESTATE', 'edit')).toBeNull();
    expect(phoneNoteOf('', contact({ hasNoPhone: true }), 'INSTITUTION', 'create')).toBeNull();
  });
});
