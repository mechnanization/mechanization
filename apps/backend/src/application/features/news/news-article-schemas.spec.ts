import {
  NEWS_BODY_MAX,
  NEWS_SUMMARY_MAX,
  NEWS_TITLE_MAX,
  municipalInstant,
  newsPlacementSchema,
  publishNewsArticleSchema,
  saveNewsArticleSchema,
} from '@mechanization/shared-schemas';

const CATEGORY = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '22222222-2222-4222-8222-222222222222';

describe('saveNewsArticleSchema', () => {
  const valid = {
    categoryId: CATEGORY,
    publisherId: PUBLISHER,
    defaultLanguage: 'ar',
    texts: [{ language: 'ar', title: 'عنوان', body: 'نص الخبر' }],
    notifyResidents: true,
  };

  it('takes an article with the default language only, and fills what is optional with null', () => {
    expect(saveNewsArticleSchema.parse(valid)).toEqual({
      categoryId: CATEGORY,
      publisherId: PUBLISHER,
      defaultLanguage: 'ar',
      texts: [{ language: 'ar', title: 'عنوان', summary: null, body: 'نص الخبر' }],
      placeLabelAr: null,
      placeLabelEn: null,
      placeLabelFr: null,
      areaId: null,
      notifyResidents: true,
    });
  });

  it('carries the quarter it was given, so an edit does not erase one set elsewhere', () => {
    const areaId = '44444444-4444-4444-8444-444444444444';
    expect(saveNewsArticleSchema.parse({ ...valid, areaId }).areaId).toBe(areaId);
  });

  it('needs the text of the default language', () => {
    expect(saveNewsArticleSchema.safeParse({ ...valid, defaultLanguage: 'en' }).success).toBe(false);
  });

  it('refuses a language sent twice, no text at all, and more languages than there are', () => {
    const text = { language: 'ar', title: 'عنوان', body: 'نص' };
    expect(saveNewsArticleSchema.safeParse({ ...valid, texts: [text, text] }).success).toBe(false);
    expect(saveNewsArticleSchema.safeParse({ ...valid, texts: [] }).success).toBe(false);
    expect(
      saveNewsArticleSchema.safeParse({
        ...valid,
        texts: [text, { ...text, language: 'en' }, { ...text, language: 'fr' }, { ...text, language: 'de' }],
      }).success,
    ).toBe(false);
  });

  it('keeps the limits of the task: title 200, summary 400, body 20,000', () => {
    const withText = (patch: Record<string, unknown>) => ({
      ...valid,
      texts: [{ language: 'ar', title: 'عنوان', summary: 'م', body: 'نص', ...patch }],
    });
    expect(saveNewsArticleSchema.safeParse(withText({ title: 'ع'.repeat(NEWS_TITLE_MAX) })).success).toBe(true);
    expect(saveNewsArticleSchema.safeParse(withText({ title: 'ع'.repeat(NEWS_TITLE_MAX + 1) })).success).toBe(false);
    expect(saveNewsArticleSchema.safeParse(withText({ summary: 'م'.repeat(NEWS_SUMMARY_MAX + 1) })).success).toBe(false);
    expect(saveNewsArticleSchema.safeParse(withText({ body: 'ن'.repeat(NEWS_BODY_MAX) })).success).toBe(true);
    expect(saveNewsArticleSchema.safeParse(withText({ body: 'ن'.repeat(NEWS_BODY_MAX + 1) })).success).toBe(false);
  });

  it('wants a title and a body, not blanks', () => {
    const withText = (patch: Record<string, unknown>) => ({
      ...valid,
      texts: [{ language: 'ar', title: 'عنوان', body: 'نص', ...patch }],
    });
    expect(saveNewsArticleSchema.safeParse(withText({ title: '   ' })).success).toBe(false);
    expect(saveNewsArticleSchema.safeParse(withText({ body: '' })).success).toBe(false);
  });

  it('refuses ids that are not ids', () => {
    expect(saveNewsArticleSchema.safeParse({ ...valid, categoryId: 'x' }).success).toBe(false);
    expect(saveNewsArticleSchema.safeParse({ ...valid, publisherId: undefined }).success).toBe(false);
  });
});

describe('publishNewsArticleSchema and newsPlacementSchema', () => {
  it('takes an empty time as now, and an instant as a schedule', () => {
    expect(publishNewsArticleSchema.parse({})).toEqual({ publishAt: null });
    expect(publishNewsArticleSchema.parse({ publishAt: null })).toEqual({ publishAt: null });
    expect(publishNewsArticleSchema.parse({ publishAt: '2026-12-01T06:00:00Z' })).toEqual({
      publishAt: '2026-12-01T06:00:00Z',
    });
    expect(publishNewsArticleSchema.parse({ publishAt: '2026-12-01T08:00:00+02:00' }).publishAt).toBe(
      '2026-12-01T08:00:00+02:00',
    );
  });

  it('refuses a time that is not an instant', () => {
    expect(publishNewsArticleSchema.safeParse({ publishAt: 'tomorrow' }).success).toBe(false);
    expect(publishNewsArticleSchema.safeParse({ publishAt: '2026-12-01' }).success).toBe(false);
  });

  it('placement is the pin and an optional featured-until instant', () => {
    expect(newsPlacementSchema.parse({ isPinned: true })).toEqual({ isPinned: true, featuredUntil: null });
    expect(newsPlacementSchema.parse({ isPinned: false, featuredUntil: '2026-12-05T10:00:00Z' }).featuredUntil).toBe(
      '2026-12-05T10:00:00Z',
    );
    expect(newsPlacementSchema.safeParse({ featuredUntil: null }).success).toBe(false);
  });
});

describe('municipalInstant', () => {
  it('reads a wall-clock time in Beirut, UTC+2 in winter', () => {
    expect(municipalInstant('2026-12-01', '08:00').toISOString()).toBe('2026-12-01T06:00:00.000Z');
  });

  it('and UTC+3 in summer', () => {
    expect(municipalInstant('2026-07-15', '08:00').toISOString()).toBe('2026-07-15T05:00:00.000Z');
  });

  it('reaches both ends of a day', () => {
    expect(municipalInstant('2026-12-01', '00:00').toISOString()).toBe('2026-11-30T22:00:00.000Z');
    expect(municipalInstant('2026-12-01', '23:59').toISOString()).toBe('2026-12-01T21:59:00.000Z');
  });
});
