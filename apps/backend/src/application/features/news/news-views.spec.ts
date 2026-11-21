import { readAll, toCategoryView, toPublisherView } from './news-views';

describe('toCategoryView', () => {
  const raw = {
    id: '3f2a9c1e-0b7d-4e55-9a31-5d6f7a8b9c0d',
    key: 'water-power',
    name: { ar: 'مياه وكهرباء', en: 'Water and power', fr: null },
    icon: 'bolt',
    sortOrder: 2,
    isActive: true,
  };

  it('reads what the contract says', () => {
    expect(toCategoryView(raw)).toEqual(raw);
  });

  it('takes a sort order sent as a digit string, as Day3ati may', () => {
    expect(toCategoryView({ ...raw, sortOrder: '-5' })?.sortOrder).toBe(-5);
  });

  it('keeps a missing icon and missing translations as null', () => {
    const view = toCategoryView({ ...raw, icon: null, name: { ar: 'مياه' } });
    expect(view?.icon).toBeNull();
    expect(view?.name).toEqual({ ar: 'مياه', en: null, fr: null });
  });

  it('passes on nothing Day3ati did not promise', () => {
    const view = toCategoryView({ ...raw, internalNote: 'secret', createdBy: 'someone' });
    expect(view).toEqual(raw);
    expect(Object.keys(view ?? {})).not.toContain('internalNote');
  });

  it.each([
    ['not an object', 'x'],
    ['no id', { ...raw, id: undefined }],
    ['no Arabic name', { ...raw, name: { en: 'Water' } }],
    ['a sort order that is not a whole number', { ...raw, sortOrder: 1.5 }],
    ['a switch that is not a boolean', { ...raw, isActive: 'yes' }],
  ])('refuses %s', (_name, value) => {
    expect(toCategoryView(value)).toBeNull();
  });
});

describe('toPublisherView', () => {
  const raw = {
    id: '3f2a9c1e-0b7d-4e55-9a31-5d6f7a8b9c0d',
    name: { ar: 'البلدية', en: 'Municipality', fr: 'Municipalité' },
    kind: 'municipality',
    avatarUrl: 'https://cdn.example.test/signed?token=abc',
    isActive: true,
  };

  it('reads what the contract says, and leaves the avatar link out', () => {
    expect(toPublisherView(raw)).toEqual({
      id: raw.id,
      name: raw.name,
      kind: 'municipality',
      isActive: true,
    });
  });

  it.each(['municipality', 'department', 'committee', 'organization'])('takes the kind %s', (kind) => {
    expect(toPublisherView({ ...raw, kind })?.kind).toBe(kind);
  });

  it('refuses a kind it does not know', () => {
    expect(toPublisherView({ ...raw, kind: 'ministry' })).toBeNull();
  });
});

describe('readAll', () => {
  it('reads every item', () => {
    expect(readAll([1, 2, 3], (n) => (typeof n === 'number' ? n * 2 : null))).toEqual([2, 4, 6]);
  });

  it('is null when the answer is not a list', () => {
    expect(readAll({ items: [] }, () => 1)).toBeNull();
  });

  it('is null when any one item is unreadable, never the readable half', () => {
    expect(readAll([1, 'x', 3], (n) => (typeof n === 'number' ? n : null))).toBeNull();
  });

  it('an empty list is an empty list', () => {
    expect(readAll([], () => 1)).toEqual([]);
  });
});
