import { describe, expect, it } from 'vitest';
import { publishNewsArticleSchema, saveNewsArticleSchema, type NewsArticleView } from '@mechanization/shared-schemas';
import {
  actionsFor,
  articleFormErrors,
  emptyArticleForm,
  formFingerprint,
  formFromView,
  scheduleInstant,
  toSaveInput,
  type ArticleForm,
} from './news-article-form';

const CATEGORY = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '22222222-2222-4222-8222-222222222222';

const filled = (patch: Partial<ArticleForm> = {}): ArticleForm => {
  const form = emptyArticleForm('ar');
  form.categoryId = CATEGORY;
  form.publisherId = PUBLISHER;
  form.texts.ar = { title: 'افتتاح المركز', summary: '', body: 'يُفتتح المركز غداً.' };
  return { ...form, ...patch };
};

const view = (patch: Partial<NewsArticleView> = {}): NewsArticleView => ({
  id: '3f2a9c1e-0b7d-4e55-9a31-5d6f7a8b9c0d',
  status: 'draft',
  categoryId: CATEGORY,
  publisherId: PUBLISHER,
  defaultLanguage: 'ar',
  texts: [
    { language: 'ar', title: 'عنوان', summary: 'ملخص', body: 'نص' },
    { language: 'en', title: 'Title', summary: '', body: 'Body' },
  ],
  media: [],
  placeLabel: { ar: 'الساحة', en: null, fr: null },
  areaId: '44444444-4444-4444-8444-444444444444',
  notifyResidents: true,
  publishAt: null,
  publishedAt: null,
  isPinned: false,
  featuredUntil: null,
  readingMinutes: 1,
  viewCount: 0,
  bookmarkCount: 0,
  createdAt: '2026-11-20T10:00:00Z',
  updatedAt: '2026-11-20T10:00:00Z',
  ...patch,
});

describe('the article form and what it sends', () => {
  it('sends the default language only, until another is written', () => {
    const parsed = saveNewsArticleSchema.parse(toSaveInput(filled()));
    expect(parsed.texts.map((text) => text.language)).toEqual(['ar']);
  });

  it('sends a language once anything is written in it', () => {
    const form = filled();
    form.texts.en = { title: 'Opening', summary: '', body: 'The centre opens tomorrow.' };
    const parsed = saveNewsArticleSchema.parse(toSaveInput(form));
    expect(parsed.texts.map((text) => text.language)).toEqual(['ar', 'en']);
  });

  it('keeps the default language even when it is not Arabic, and leaves out a blank Arabic', () => {
    const form = filled({ defaultLanguage: 'en' });
    form.texts.ar = { title: '', summary: '', body: '' };
    form.texts.en = { title: 'Opening', summary: '', body: 'Body' };
    const parsed = saveNewsArticleSchema.parse(toSaveInput(form));
    expect(parsed.texts.map((text) => text.language)).toEqual(['en']);
    expect(parsed.defaultLanguage).toBe('en');
  });

  it('reads an article on file back into the form, and leaves the quarter alone', () => {
    const form = formFromView(view());
    expect(form.texts.ar.title).toBe('عنوان');
    expect(form.texts.en.body).toBe('Body');
    expect(form.texts.fr).toEqual({ title: '', summary: '', body: '' });
    expect(form.placeLabel).toEqual({ ar: 'الساحة', en: '', fr: '' });
    expect(form.areaId).toBe('44444444-4444-4444-8444-444444444444');
    expect(saveNewsArticleSchema.parse(toSaveInput(form)).areaId).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('is unchanged by a round trip, so opening an article is not a change', () => {
    const form = formFromView(view());
    expect(formFingerprint(formFromView(view()))).toBe(formFingerprint(form));
  });

  it('is changed by an edit', () => {
    const form = formFromView(view());
    const edited = { ...form, texts: { ...form.texts, ar: { ...form.texts.ar, title: 'عنوان جديد' } } };
    expect(formFingerprint(edited)).not.toBe(formFingerprint(form));
  });
});

describe('articleFormErrors', () => {
  it('is empty for a form that can be sent', () => {
    expect(articleFormErrors(filled())).toEqual({});
  });

  it('asks for the category, the publisher, a title and a body', () => {
    const errors = articleFormErrors(emptyArticleForm('ar'));
    expect(errors.categoryId).toBe('required');
    expect(errors.publisherId).toBe('required');
    expect(errors['title.ar']).toBe('required');
    expect(errors['body.ar']).toBe('required');
  });

  it('puts a missing default language on that language, whichever it is', () => {
    const form = filled({ defaultLanguage: 'fr' });
    const errors = articleFormErrors(form);
    expect(errors['title.fr']).toBe('required');
    expect(errors['body.fr']).toBe('required');
  });

  it('says too long for what goes past a limit, under its own language', () => {
    const form = filled();
    form.texts.ar.title = 'ع'.repeat(201);
    form.texts.ar.summary = 'م'.repeat(401);
    form.texts.ar.body = 'ن'.repeat(20_001);
    form.placeLabel.en = 'x'.repeat(201);
    const errors = articleFormErrors(form);
    expect(errors['title.ar']).toBe('tooLong');
    expect(errors['summary.ar']).toBe('tooLong');
    expect(errors['body.ar']).toBe('tooLong');
    expect(errors['placeLabel.en']).toBe('tooLong');
  });

  it('refuses half a translation instead of saving it', () => {
    const form = filled();
    form.texts.en.title = 'Opening';
    const errors = articleFormErrors(form);
    expect(errors['body.en']).toBe('required');
    expect(errors['title.en']).toBeUndefined();
  });
});

describe('actionsFor', () => {
  it('lets an article not yet saved only be saved', () => {
    expect(actionsFor(null)).toEqual(['save']);
  });

  it('lets a draft be published, scheduled or deleted', () => {
    expect(actionsFor('draft')).toEqual(['save', 'publishNow', 'schedule', 'delete']);
  });

  it('lets a scheduled one be published now, moved, or sent back to a draft', () => {
    expect(actionsFor('scheduled')).toEqual(expect.arrayContaining(['publishNow', 'schedule', 'cancelSchedule']));
  });

  it('never offers to schedule a published article, which Day3ati refuses', () => {
    expect(actionsFor('published')).not.toContain('schedule');
    expect(actionsFor('published')).toEqual(expect.arrayContaining(['archive', 'placement']));
  });

  it('lets an archived one be published again, and nothing about the feed', () => {
    expect(actionsFor('archived')).toContain('publishAgain');
    expect(actionsFor('archived')).not.toContain('placement');
  });

  it('lets every status be saved and deleted', () => {
    for (const status of ['draft', 'scheduled', 'published', 'archived'] as const) {
      expect(actionsFor(status)).toEqual(expect.arrayContaining(['save', 'delete']));
    }
  });
});

describe('scheduleInstant', () => {
  const now = new Date('2026-11-20T10:00:00Z');

  it('turns a Beirut wall-clock time into the UTC instant Day3ati takes', () => {
    const result = scheduleInstant('2026-12-01', '08:00', now);
    expect(result).toEqual({ ok: true, iso: '2026-12-01T06:00:00.000Z' });
    if (result.ok) expect(publishNewsArticleSchema.safeParse({ publishAt: result.iso }).success).toBe(true);
  });

  it('refuses a time that is not far enough ahead', () => {
    // 11:59 Beirut on the 20th is 09:59 UTC, an hour before now.
    expect(scheduleInstant('2026-11-20', '11:59', now)).toEqual({ ok: false, reason: 'past' });
    // 12:00 Beirut is 10:00 UTC, which is now: not a schedule.
    expect(scheduleInstant('2026-11-20', '12:00', now)).toEqual({ ok: false, reason: 'past' });
    expect(scheduleInstant('2026-11-20', '12:02', now).ok).toBe(true);
  });

  it('asks for both a day and a time', () => {
    expect(scheduleInstant('', '08:00', now)).toEqual({ ok: false, reason: 'incomplete' });
    expect(scheduleInstant('2026-12-01', '', now)).toEqual({ ok: false, reason: 'incomplete' });
    expect(scheduleInstant('2026-12-01', '8:00', now)).toEqual({ ok: false, reason: 'incomplete' });
  });
});
