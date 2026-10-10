import type { IncomeCategoryView } from '@mechanization/shared-schemas';

/**
 * An income category's name in the page's language.
 *
 * The seeded categories carry both names (migration 0080). One a municipality
 * adds in Arabic alone has no English name, and the English page shows the
 * Arabic rather than an invented translation — a wrong English name on a
 * financial register is worse than an untranslated one.
 */
export function incomeCategoryLabel(
  category: Pick<IncomeCategoryView, 'labelAr' | 'labelEn'>,
  locale: string,
): string {
  return locale === 'en' && category.labelEn ? category.labelEn : category.labelAr;
}
