import { z } from 'zod';
import type { NewsArticleStatus } from './enums';
import { NEWS_LANGUAGE, type NewsLanguage, type NewsLocalizedName } from './news.schema';
import { uuid } from './primitives';

/**
 * News articles on Day3ati: written, edited, published and scheduled from here,
 * as the signed-in user. Day3ati keeps them; these are the shapes that cross
 * our API, naming Day3ati's own fields (its OpenAPI, 2026-11-20).
 *
 * The three text limits are the task's («title ≤ 200, summary ≤ 400, body in
 * Markdown ≤ 20,000»); the rest are ours, and Day3ati's own refusal is the
 * authority on any of them.
 */

export const NEWS_TITLE_MAX = 200;
export const NEWS_SUMMARY_MAX = 400;
export const NEWS_BODY_MAX = 20_000;
/** A place label's longest («on the square, by the school»): ours. */
export const NEWS_PLACE_LABEL_MAX = 200;
/** A page of articles: the default and the most one request may ask for. Ours. */
export const NEWS_ARTICLES_PAGE_DEFAULT = 20;
export const NEWS_ARTICLES_PAGE_MAX = 50;
/** A page cursor is Day3ati's and opaque to us; this only bounds what a client may send back. */
export const NEWS_CURSOR_MAX = 512;

/** One language of an article. A language left out is a language the article does not have. */
export const newsArticleTextSchema = z.object({
  language: z.enum(NEWS_LANGUAGE),
  title: z
    .string({ error: 'العنوان مطلوب' })
    .trim()
    .min(1, 'العنوان مطلوب')
    .max(NEWS_TITLE_MAX, 'العنوان طويل جداً'),
  summary: z
    .string()
    .trim()
    .max(NEWS_SUMMARY_MAX, 'الملخص طويل جداً')
    .nullish()
    .transform((value) => (value ? value : null)),
  body: z
    .string({ error: 'نص الخبر مطلوب' })
    .trim()
    .min(1, 'نص الخبر مطلوب')
    .max(NEWS_BODY_MAX, 'نص الخبر طويل جداً'),
});
export type NewsArticleTextInput = z.infer<typeof newsArticleTextSchema>;

const placeLabel = z
  .string()
  .trim()
  .max(NEWS_PLACE_LABEL_MAX, 'اسم المكان طويل جداً')
  .nullish()
  .transform((value) => (value ? value : null));

/**
 * An article as written, for a new one and for an edit alike (Day3ati's `PUT`
 * replaces the content, so an edit sends all of it). The default language is
 * the one it was written in, and it must be there; a language that is not sent
 * is removed from the article.
 *
 * \`areaId\` is the optional quarter of the village. No screen here sets it, but
 * it is carried unchanged, so an edit made here does not erase what someone set
 * in the Day3ati dashboard.
 */
export const saveNewsArticleSchema = z
  .object({
    categoryId: uuid,
    publisherId: uuid,
    defaultLanguage: z.enum(NEWS_LANGUAGE),
    texts: z.array(newsArticleTextSchema).min(1, 'نص الخبر مطلوب').max(NEWS_LANGUAGE.length),
    placeLabelAr: placeLabel,
    placeLabelEn: placeLabel,
    placeLabelFr: placeLabel,
    areaId: uuid.nullish().transform((value) => value ?? null),
    notifyResidents: z.boolean({ error: 'الإشعار مطلوب' }),
  })
  .superRefine((article, context) => {
    const languages = article.texts.map((text) => text.language);
    if (new Set(languages).size !== languages.length) {
      context.addIssue({ code: 'custom', path: ['texts'], message: 'لغة مكررة' });
    }
    if (!languages.includes(article.defaultLanguage)) {
      context.addIssue({ code: 'custom', path: ['texts'], message: 'نص اللغة الأساسية مطلوب' });
    }
  });
export type SaveNewsArticleInput = z.infer<typeof saveNewsArticleSchema>;

/** A UTC or offset instant, as Day3ati takes one: \`2026-12-01T08:00:00Z\`. */
const instant = z.iso.datetime({ offset: true, error: 'الموعد غير صالح' });

/**
 * Publish now (\`publishAt\` empty) or at a time (\`publishAt\` an instant). Day3ati
 * decides whether a time is in the future, and refuses to schedule an article
 * that is already published (\`news.already_published\`).
 */
export const publishNewsArticleSchema = z.object({
  publishAt: instant.nullish().transform((value) => value ?? null),
});
export type PublishNewsArticleInput = z.infer<typeof publishNewsArticleSchema>;

/** Pinned on top of the feed, and/or featured in the carousel until a time (\`null\` removes it). */
export const newsPlacementSchema = z.object({
  isPinned: z.boolean({ error: 'التثبيت مطلوب' }),
  featuredUntil: instant.nullish().transform((value) => value ?? null),
});
export type NewsPlacementInput = z.infer<typeof newsPlacementSchema>;

/** One article of a list. */
export interface NewsArticleListItem {
  id: string;
  status: NewsArticleStatus;
  /** In the article's default language. */
  title: string;
  categoryId: string;
  publishAt: string | null;
  publishedAt: string | null;
  isPinned: boolean;
  isFeatured: boolean;
  updatedAt: string;
}

/** One page of the list, newest edit first; \`nextCursor\` is absent on the last. */
export interface NewsArticlePage {
  items: NewsArticleListItem[];
  nextCursor: string | null;
}

export interface NewsArticleTextView {
  language: NewsLanguage;
  title: string;
  summary: string;
  body: string;
}

/** One article, in full. */
export interface NewsArticleView {
  id: string;
  status: NewsArticleStatus;
  categoryId: string;
  publisherId: string;
  defaultLanguage: NewsLanguage;
  texts: NewsArticleTextView[];
  placeLabel: NewsLocalizedName | null;
  areaId: string | null;
  notifyResidents: boolean;
  publishAt: string | null;
  publishedAt: string | null;
  isPinned: boolean;
  featuredUntil: string | null;
  readingMinutes: number;
  viewCount: number;
  bookmarkCount: number;
  createdAt: string;
  updatedAt: string;
}

