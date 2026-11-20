'use client';

import {
  NEWS_FIELD_ERROR_CODES,
  type NewsCategoryView,
  type NewsFieldError,
  type NewsLocalizedName,
  type NewsPublisherView,
} from '@mechanization/shared-schemas';
import { ApiRequestError, getNewsCategories, getNewsPublishers } from './api-client';
import { useStaffQuery } from './use-staff-query';

/**
 * A name in the page's language, and Arabic where nobody wrote that one: Arabic
 * is required on every name and is Day3ati's own fallback.
 */
export function newsName(name: NewsLocalizedName, locale: string): string {
  const own = locale === 'en' ? name.en : null;
  return own && own.trim() !== '' ? own : name.ar;
}

/** Categories, every one (switched-off ones too: this is the screen that switches them back on). */
export function useNewsCategories(
  tenant: string,
  base: string,
  token: string | null,
  options: { locale: string; errorMessage: string },
) {
  return useStaffQuery<NewsCategoryView[]>({
    queryKey: ['news-categories', tenant],
    queryFn: (accessToken, signal) => getNewsCategories(tenant, accessToken, options.locale, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: options.errorMessage,
  });
}

/** Publishers, every one. */
export function useNewsPublishers(
  tenant: string,
  base: string,
  token: string | null,
  options: { locale: string; errorMessage: string },
) {
  return useStaffQuery<NewsPublisherView[]>({
    queryKey: ['news-publishers', tenant],
    queryFn: (accessToken, signal) => getNewsPublishers(tenant, accessToken, options.locale, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: options.errorMessage,
  });
}

/** The words for the field refusals Day3ati names by code, in the page's language. */
export type NewsFieldWording = Readonly<Record<keyof typeof NEWS_FIELD_ERROR_CODES, string>>;

/**
 * What a refused News form says under each field: `{ key: '…', nameAr: '…' }`.
 *
 * A refusal Day3ati names by code (a key already taken) is worded by us, in the
 * page's language, so the screen reads as one. Any other field error is
 * Day3ati's own sentence, already written in the language the screen asked
 * for. A refusal with no field in it (the service is down, the role may not do
 * this) gives `{}` and is shown as the form's own alert.
 */
export function newsFieldErrors(caught: unknown, wording: NewsFieldWording): Record<string, string> {
  if (!(caught instanceof ApiRequestError)) return {};
  const details = caught.payload.details;
  if (!Array.isArray(details)) return {};

  const fields: Record<string, string> = {};
  for (const detail of details as NewsFieldError[]) {
    if (typeof detail?.path !== 'string' || detail.path in fields) continue;
    const worded = detail.code ? wording[detail.code] : undefined;
    fields[detail.path] = worded ?? detail.message;
  }
  return fields;
}
