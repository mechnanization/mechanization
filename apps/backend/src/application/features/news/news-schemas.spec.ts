import {
  createNewsCategorySchema,
  createNewsPublisherSchema,
  updateNewsCategorySchema,
  updateNewsPublisherSchema,
} from '@mechanization/shared-schemas';

/**
 * The bodies of the News routes. They are the shapes `ZodValidationPipe` checks
 * before a call is made to Day3ati; the rules Day3ati itself owns (a key already
 * taken) come back from it, field by field.
 */
describe('createNewsCategorySchema', () => {
  const valid = { key: 'water-power', nameAr: 'مياه وكهرباء', sortOrder: 1 };

  it('takes a key of lowercase words joined by hyphens, and fills what is optional with null', () => {
    expect(createNewsCategorySchema.parse(valid)).toEqual({
      key: 'water-power',
      nameAr: 'مياه وكهرباء',
      nameEn: null,
      nameFr: null,
      icon: null,
      sortOrder: 1,
    });
  });

  it.each(['Water-Power', 'water power', '-water', 'water-', 'water--power', 'ماء', 'a_b', ''])(
    'refuses the key %j',
    (key) => {
      expect(createNewsCategorySchema.safeParse({ ...valid, key }).success).toBe(false);
    },
  );

  it('trims the names and takes an empty translation as none', () => {
    const parsed = createNewsCategorySchema.parse({ ...valid, nameAr: '  مياه  ', nameEn: '   ', nameFr: 'Eau', icon: '' });
    expect(parsed).toMatchObject({ nameAr: 'مياه', nameEn: null, nameFr: 'Eau', icon: null });
  });

  it('requires the Arabic name', () => {
    expect(createNewsCategorySchema.safeParse({ ...valid, nameAr: '   ' }).success).toBe(false);
    expect(createNewsCategorySchema.safeParse({ key: 'a', sortOrder: 1 }).success).toBe(false);
  });

  it('wants a whole sort order, not a string or a fraction', () => {
    expect(createNewsCategorySchema.safeParse({ ...valid, sortOrder: '1' }).success).toBe(false);
    expect(createNewsCategorySchema.safeParse({ ...valid, sortOrder: 1.5 }).success).toBe(false);
    expect(createNewsCategorySchema.safeParse({ ...valid, sortOrder: -3 }).success).toBe(true);
  });

  it('refuses a name of a page', () => {
    expect(createNewsCategorySchema.safeParse({ ...valid, nameAr: 'س'.repeat(201) }).success).toBe(false);
  });
});

describe('updateNewsCategorySchema', () => {
  const valid = { nameAr: 'مياه', sortOrder: 1, isActive: true };

  it('is the whole record, with the switch and without a key', () => {
    expect(updateNewsCategorySchema.parse(valid)).toEqual({
      nameAr: 'مياه',
      nameEn: null,
      nameFr: null,
      icon: null,
      sortOrder: 1,
      isActive: true,
    });
  });

  it('does not let a client change the key: a key sent is dropped', () => {
    expect(updateNewsCategorySchema.parse({ ...valid, key: 'other' })).not.toHaveProperty('key');
  });

  it('needs the switch said out loud', () => {
    expect(updateNewsCategorySchema.safeParse({ nameAr: 'مياه', sortOrder: 1 }).success).toBe(false);
  });
});

describe('the publisher schemas', () => {
  it('takes one of the four kinds', () => {
    for (const kind of ['municipality', 'department', 'committee', 'organization']) {
      expect(createNewsPublisherSchema.safeParse({ nameAr: 'البلدية', kind }).success).toBe(true);
    }
    expect(createNewsPublisherSchema.safeParse({ nameAr: 'البلدية', kind: 'ministry' }).success).toBe(false);
  });

  it('an edit carries the switch too', () => {
    expect(updateNewsPublisherSchema.safeParse({ nameAr: 'البلدية', kind: 'department', isActive: false }).success).toBe(
      true,
    );
    expect(updateNewsPublisherSchema.safeParse({ nameAr: 'البلدية', kind: 'department' }).success).toBe(false);
  });
});
