import { fileChanges, isEmptyChange, type EditableFileView } from './file-changes';

const file = (over: Partial<EditableFileView> = {}): EditableFileView => ({
  residence: 'HOUSEHOLD',
  notes: null,
  personal: {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'تجربة',
    civilRecordNumber: '123',
    identityDocNumber: '',
    residentStatus: 'VILLAGE_RESIDENT',
    nationality: 'لبناني',
  },
  contact: { phone: '+96171000001', whatsapp: '+96171000001', whatsappSameAsPhone: true, maritalStatus: 'MARRIED' },
  properties: [
    {
      id: 'card-1',
      occupancyType: 'OWNER',
      propertyType: 'BUILDING',
      propertyNumber: '45',
      unitArea: null,
      landlordPhone: null,
      units: [{ id: 'row-1', unitType: 'APARTMENT', floor: '0', unitArea: 100, unitId: 'u-1' }],
    },
  ],
  ...over,
});

describe('fileChanges', () => {
  it('records ordinary fields on both sides', () => {
    const before = file();
    const after = file({ personal: { ...before.personal, firstName: 'عليّ' }, contact: { ...before.contact, maritalStatus: 'SINGLE' } });
    const changes = fileChanges(before, after);
    expect(changes.before).toEqual({ firstName: 'علي', maritalStatus: 'MARRIED' });
    expect(changes.after).toEqual({ firstName: 'عليّ', maritalStatus: 'SINGLE' });
    expect(changes.changed).toEqual(['firstName', 'maritalStatus']);
  });

  it('names sensitive fields and never writes their values', () => {
    const before = file();
    const after = file({
      personal: { ...before.personal, civilRecordNumber: '999', residentStatus: 'REFUGEE' },
      contact: { ...before.contact, phone: '+96171000002', whatsapp: '+96171000002' },
    });
    const changes = fileChanges(before, after);
    expect(changes.changed.sort()).toEqual(['civilRecordNumber', 'phone', 'residentStatus', 'whatsapp']);
    expect(changes.before).toEqual({});
    expect(changes.after).toEqual({});
    expect(JSON.stringify(changes)).not.toMatch(/999|REFUGEE|000002/);
  });

  it('treats a blank and an absent value as the same answer', () => {
    const before = file();
    const after = file({ personal: { ...before.personal, identityDocNumber: null } });
    expect(isEmptyChange(fileChanges(before, after))).toBe(true);
  });

  it('matches cards by id and summarises what happened to each', () => {
    const before = file();
    const card = before.properties[0]!;
    const after = file({
      properties: [
        {
          ...card,
          unitArea: 120,
          landlordPhone: '+96170000000',
          units: [
            { ...card.units![0]!, unitArea: 110 },
            { id: 'row-2', unitType: 'SHOP', floor: '0', unitArea: 30, unitId: null },
          ],
        },
        { id: 'card-2', occupancyType: 'TENANT', propertyType: 'HOUSE', propertyNumber: '46', units: [] },
      ],
    });
    const changes = fileChanges(before, after);
    expect(changes.cards).toEqual([
      {
        cardId: 'card-1',
        kind: 'changed',
        propertyType: 'BUILDING',
        propertyNumber: '45',
        occupancyType: 'OWNER',
        fields: [{ field: 'unitArea', before: null, after: 120 }],
        sensitive: ['landlordPhone'],
        rows: { added: 1, removed: 0, changed: 1 },
      },
      { cardId: 'card-2', kind: 'added', propertyType: 'HOUSE', propertyNumber: '46', occupancyType: 'TENANT' },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/96170000000/);
  });

  it('reports a card that left the file', () => {
    const changes = fileChanges(file(), file({ properties: [] }));
    expect(changes.cards).toEqual([
      { cardId: 'card-1', kind: 'removed', propertyType: 'BUILDING', propertyNumber: '45', occupancyType: 'OWNER' },
    ]);
  });
});
