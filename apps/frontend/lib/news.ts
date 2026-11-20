'use client';

import {
  MUNICIPAL_TIME_ZONE,
  NEWS_ARTICLES_PAGE_DEFAULT,
  NEWS_FIELD_ERROR_CODES,
  type NewsArticlePage,
  type NewsArticleStatus,
  type NewsArticleView,
  type NewsCategoryView,
  type NewsFieldError,
  type NewsLocalizedName,
  type NewsPublisherView,
} from '@mechanization/shared-schemas';
import { ApiRequestError, getNewsArticle, getNewsArticles, getNewsCategories, getNewsPublishers } from './api-client';
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

/**
 * The first page of the articles, newest edit first, for one status or all.
 * The pages after it are asked for by cursor (`getNewsArticles`) as the list
 * asks for them. Not a reference list: an article changes while people work.
 */
export function useNewsArticlesPage(
  tenant: string,
  base: string,
  token: string | null,
  options: { locale: string; status?: NewsArticleStatus; errorMessage: string },
) {
  return useStaffQuery<NewsArticlePage>({
    queryKey: ['news-articles', tenant, options.status ?? 'all'],
    queryFn: (accessToken, signal) =>
      getNewsArticles(
        tenant,
        accessToken,
        options.locale,
        { status: options.status, limit: NEWS_ARTICLES_PAGE_DEFAULT },
        signal,
      ),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: options.errorMessage,
  });
}

/** One article in full, read fresh each time the editor opens: it is about to be changed. */
export function useNewsArticle(
  tenant: string,
  base: string,
  token: string | null,
  id: string,
  options: { locale: string; errorMessage: string },
) {
  return useStaffQuery<NewsArticleView>({
    queryKey: ['news-article', tenant, id],
    queryFn: (accessToken, signal) => getNewsArticle(tenant, accessToken, options.locale, id, signal),
    tenant,
    base,
    token,
    fresh: true,
    errorMessage: options.errorMessage,
  });
}

/**
 * An instant as the municipality's clock reads it: `01/12/2026 · 08:00` for
 * `2026-12-01T06:00:00Z`. A scheduled time is chosen on that clock, so it is
 * shown on it, whatever zone the browser is in.
 */
export function formatMunicipalDateTime(value: string): string {
  const instant = new Date(value);
  const date = instant.toLocaleDateString('en-GB', {
    timeZone: MUNICIPAL_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const time = instant.toLocaleTimeString('en-GB', {
    timeZone: MUNICIPAL_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${date} · ${time}`;
}

/**
 * The day (`2026-12-01`) and time (`08:00`) an instant is on the municipality's
 * clock: what the schedule dialog opens with when an article is being moved.
 */
export function municipalDayTime(value: string): { day: string; time: string } {
  const instant = new Date(value);
  return {
    // en-CA writes a day as YYYY-MM-DD.
    day: instant.toLocaleDateString('en-CA', { timeZone: MUNICIPAL_TIME_ZONE }),
    time: instant.toLocaleTimeString('en-GB', {
      timeZone: MUNICIPAL_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
  };
}

/** The badge colour of a status. The word carries the state; the colour only repeats it (COL-3). */
export function newsStatusVariant(
  status: NewsArticleStatus,
): 'soft-muted' | 'soft-info' | 'soft-success' | 'soft-warning' {
  switch (status) {
    case 'draft':
      return 'soft-muted';
    case 'scheduled':
      return 'soft-info';
    case 'published':
      return 'soft-success';
    case 'archived':
      return 'soft-warning';
  }
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
