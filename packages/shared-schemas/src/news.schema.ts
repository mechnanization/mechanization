import { z } from 'zod';
import { newsPublisherKindSchema, type NewsPublisherKind } from './enums';

/**
 * News on Day3ati: the lists an article is filed under (categories) and
 * published as (publishers). Day3ati keeps the data; these are the shapes that
 * cross our API, which name Day3ati's own fields (its OpenAPI, 2026-11-20).
 *
 * The limits below are ours: Day3ati publishes none, and answers a value it
 * will not take with its own refusal, which reaches the form field by field.
 */

/** The key of News among a village's modules on Day3ati. */
export const NEWS_MODULE_KEY = 'news';

/** Why News is not available for a municipality, when it is not. */
export type NewsUnavailableReason = 'NOT_CONFIGURED' | 'NOT_LINKED' | 'MODULE_OFF';

/**
 * Whether News is on for the municipality: its Day3ati village lists the news
 * module. The screens are hidden from a municipality for which it is `false`.
 */
export interface NewsAvailability {
  enabled: boolean;
  reason: NewsUnavailableReason | null;
}

/** A name's longest: ours, so a paste of a page is refused before it travels. */
export const NEWS_NAME_MAX = 200;
/** A category key's longest. Day3ati's rule is «lowercase, e.g. water-power»; its own refusal is the authority. */
export const NEWS_CATEGORY_KEY_MAX = 64;
/** A category key: lowercase letters and digits in groups joined by single hyphens. */
export const NEWS_CATEGORY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An icon key's longest («a key from the app's icon set»; the set is Day3ati's). */
export const NEWS_ICON_MAX = 64;
/** Sort orders are Day3ati's int32; ours stay well inside it. */
export const NEWS_SORT_ORDER_MAX = 1_000_000;

/** The languages Day3ati speaks. Arabic is required on every name and is the fallback. */
export const NEWS_LANGUAGE = ['ar', 'en', 'fr'] as const;
export type NewsLanguage = (typeof NEWS_LANGUAGE)[number];

/** `?lang=` on the News routes: the language the answer's own messages are written in. */
export const newsLanguageQuerySchema = z.enum(NEWS_LANGUAGE);

const requiredName = z
  .string({ error: 'الاسم بالعربية مطلوب' })
  .trim()
  .min(1, 'الاسم بالعربية مطلوب')
  .max(NEWS_NAME_MAX, 'الاسم طويل جداً');

/** An optional name in another language: empty is no name. */
const optionalName = z
  .string()
  .trim()
  .max(NEWS_NAME_MAX, 'الاسم طويل جداً')
  .nullish()
  .transform((value) => (value ? value : null));

const sortOrder = z
  .number({ error: 'ترتيب العرض يجب أن يكون رقماً' })
  .int('ترتيب العرض يجب أن يكون عدداً صحيحاً')
  .min(-NEWS_SORT_ORDER_MAX)
  .max(NEWS_SORT_ORDER_MAX);

const icon = z
  .string()
  .trim()
  .max(NEWS_ICON_MAX, 'اسم الأيقونة طويل جداً')
  .nullish()
  .transform((value) => (value ? value : null));

/** A new category. The key is chosen here and never changes. */
export const createNewsCategorySchema = z.object({
  key: z
    .string({ error: 'المفتاح مطلوب' })
    .trim()
    .min(1, 'المفتاح مطلوب')
    .max(NEWS_CATEGORY_KEY_MAX, 'المفتاح طويل جداً')
    .regex(NEWS_CATEGORY_KEY_PATTERN, 'المفتاح أحرف إنكليزية صغيرة وأرقام تفصل بينها شرطة، مثل water-power'),
  nameAr: requiredName,
  nameEn: optionalName,
  nameFr: optionalName,
  icon,
  sortOrder,
});
export type CreateNewsCategoryInput = z.infer<typeof createNewsCategorySchema>;

/**
 * An edit, which replaces the whole category (Day3ati's \`PUT\`): every field
 * is sent, so a form holds the category as it was and changes what it changes.
 * The key is not here: it is fixed once created.
 */
export const updateNewsCategorySchema = z.object({
  nameAr: requiredName,
  nameEn: optionalName,
  nameFr: optionalName,
  icon,
  sortOrder,
  isActive: z.boolean({ error: 'الحالة مطلوبة' }),
});
export type UpdateNewsCategoryInput = z.infer<typeof updateNewsCategorySchema>;

export const createNewsPublisherSchema = z.object({
  nameAr: requiredName,
  nameEn: optionalName,
  nameFr: optionalName,
  kind: newsPublisherKindSchema,
});
export type CreateNewsPublisherInput = z.infer<typeof createNewsPublisherSchema>;

export const updateNewsPublisherSchema = createNewsPublisherSchema.extend({
  isActive: z.boolean({ error: 'الحالة مطلوبة' }),
});
export type UpdateNewsPublisherInput = z.infer<typeof updateNewsPublisherSchema>;

/** A name in the three languages; Arabic always, the others when someone wrote them. */
export interface NewsLocalizedName {
  ar: string;
  en: string | null;
  fr: string | null;
}

/** A category as the screens read it. */
export interface NewsCategoryView {
  id: string;
  key: string;
  name: NewsLocalizedName;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
}

/** A publisher as the screens read it. */
export interface NewsPublisherView {
  id: string;
  name: NewsLocalizedName;
  kind: NewsPublisherKind;
  isActive: boolean;
}

/**
 * The field a Day3ati refusal belongs to, for a refusal that names none (a
 * conflict carries only its code). The screens word each code and show it
 * under the field. Kept here, with the form's field names, so the server that
 * attaches a code to a field and the form that finds it agree.
 */
export const NEWS_FIELD_ERROR_CODES = {
  'news.invalid_category_key': 'key',
  'news.category_key_taken': 'key',
  'news.name_required': 'nameAr',
  // A photo or PDF the file box refuses (task «Photos and documents»).
  'news.unsupported_file': 'file',
  'news.file_too_large': 'file',
} as const;

export type NewsFieldErrorCode = keyof typeof NEWS_FIELD_ERROR_CODES;

/** One entry of a refused form's `details`. `code` is set for the refusals above. */
export interface NewsFieldError {
  path: string;
  message: string;
  code?: NewsFieldErrorCode;
}
