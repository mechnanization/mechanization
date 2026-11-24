import { type CreateNewsCategoryInput, type CreateNewsPublisherInput, type NewsArticlePage, type NewsAvailability, type NewsArticleStatus, type NewsArticleView, type NewsCategoryView, type NewsMediaView, type NewsPlacementInput, type NewsPublisherView, type PublishNewsArticleInput, type SaveNewsArticleInput, type UpdateNewsCategoryInput, type UpdateNewsPublisherInput } from '@mechanization/shared-schemas';
import { ApiRequestError, apiFetch, API_URL, ANSWERED_401, exchangeStaffToken, type ApiError } from './core';

// ─────────────────────────────  «الأخبار» on Day3ati: categories and publishers  ─────────────────────────────

/**
 * The language Day3ati writes its own messages in (a refused form's field
 * errors): the page's, `ar` or `en`. The names themselves come in all of
 * their languages.
 */
const newsLang = (locale: string): string => `?lang=${locale === 'en' ? 'en' : 'ar'}`;

/** Every category, switched-off ones included (`GET news/categories`, `NEWS_EDITOR_ROLES`). */
export async function getNewsCategories(
  tenant: string,
  token: string,
  locale: string,
  signal?: AbortSignal,
): Promise<NewsCategoryView[]> {
  return apiFetch<NewsCategoryView[]>(tenant, `/news/categories${newsLang(locale)}`, { token, signal });
}

/** Adds a category, whose key is fixed from then on. */
export async function createNewsCategory(
  tenant: string,
  token: string,
  locale: string,
  input: CreateNewsCategoryInput,
  signal?: AbortSignal,
): Promise<NewsCategoryView> {
  return apiFetch<NewsCategoryView>(tenant, `/news/categories${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Edits a category. It replaces the whole record, so every field is sent. */
export async function updateNewsCategory(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: UpdateNewsCategoryInput,
  signal?: AbortSignal,
): Promise<NewsCategoryView> {
  return apiFetch<NewsCategoryView>(tenant, `/news/categories/${encodeURIComponent(id)}${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

/** Every publisher, switched-off ones included (`GET news/publishers`). */
export async function getNewsPublishers(
  tenant: string,
  token: string,
  locale: string,
  signal?: AbortSignal,
): Promise<NewsPublisherView[]> {
  return apiFetch<NewsPublisherView[]>(tenant, `/news/publishers${newsLang(locale)}`, { token, signal });
}

/** Adds a publisher: who an article is published as. */
export async function createNewsPublisher(
  tenant: string,
  token: string,
  locale: string,
  input: CreateNewsPublisherInput,
  signal?: AbortSignal,
): Promise<NewsPublisherView> {
  return apiFetch<NewsPublisherView>(tenant, `/news/publishers${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Edits a publisher. It replaces the whole record, so every field is sent. */
export async function updateNewsPublisher(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: UpdateNewsPublisherInput,
  signal?: AbortSignal,
): Promise<NewsPublisherView> {
  return apiFetch<NewsPublisherView>(tenant, `/news/publishers/${encodeURIComponent(id)}${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

// ─────────────────────────────  «الأخبار» on Day3ati: articles  ─────────────────────────────

const newsArticlePath = (id: string): string => `/news/articles/${encodeURIComponent(id)}`;

/**
 * One page of articles, newest edit first (`GET news/articles`). Day3ati pages
 * with a cursor: pass the last page's `nextCursor`; a page without one is the last.
 */
export async function getNewsArticles(
  tenant: string,
  token: string,
  locale: string,
  options: { status?: NewsArticleStatus; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<NewsArticlePage> {
  const query = new URLSearchParams({ lang: locale === 'en' ? 'en' : 'ar' });
  if (options.status) query.set('status', options.status);
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit) query.set('limit', String(options.limit));
  return apiFetch<NewsArticlePage>(tenant, `/news/articles?${query.toString()}`, { token, signal });
}

/**
 * One article in full. `background` marks a read the screen makes by itself (the
 * poll that follows a photo being processed), so it does not count as the staff
 * member being at the system.
 */
export async function getNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
  options: { background?: boolean } = {},
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}${newsLang(locale)}`, {
    token,
    signal,
    background: options.background,
  });
}

/** A new draft. */
export async function createNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  input: SaveNewsArticleInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `/news/articles${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Saves an article. It replaces the content, so a language left out is removed. */
export async function updateNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: SaveNewsArticleInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

/** Publishes now (`publishAt` null) or at a time. */
export async function publishNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: PublishNewsArticleInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/publish${newsLang(locale)}`, {
    token,
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

/** Out of the feed; it can be published again. */
export async function archiveNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/archive${newsLang(locale)}`, {
    token,
    method: 'POST',
    signal,
  });
}

/** Cancels a schedule: the article goes back to a draft. */
export async function cancelNewsArticleSchedule(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/draft${newsLang(locale)}`, {
    token,
    method: 'POST',
    signal,
  });
}

/** Deletes an article for good. */
export async function deleteNewsArticle(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch<void>(tenant, `${newsArticlePath(id)}${newsLang(locale)}`, { token, method: 'DELETE', signal });
}

/** Pins an article on top of the feed, and/or features it in the carousel until a time. */
export async function setNewsArticlePlacement(
  tenant: string,
  token: string,
  locale: string,
  id: string,
  input: NewsPlacementInput,
  signal?: AbortSignal,
): Promise<NewsArticleView> {
  return apiFetch<NewsArticleView>(tenant, `${newsArticlePath(id)}/placement${newsLang(locale)}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  });
}

// ─────────────────────────────  «الأخبار»: photos and PDFs of an article  ─────────────────────────────

/** The body of an upload that could not be read: the refusal a screen shows is the generic one. */
const UNREADABLE_REFUSAL = { code: 'UNKNOWN', message: 'تعذّر إتمام الطلب. حاول مرة أخرى.' } as const;

/**
 * Sends one photo or PDF of an article and reports how much of it has gone
 * (`onProgress`, 0 to 1). It is `XMLHttpRequest` and not `fetch` because `fetch`
 * cannot say how far an upload has got, and a ten-megabyte photo over a village
 * connection is a minute of nothing without it.
 *
 * It renews the session the way `apiFetch` does: a 401 that is not an answer
 * exchanges the token and sends the file once more with the new one. A form
 * can go twice. Photos are accepted at once and prepared in the background by
 * Day3ati: the answer says `processing`, and the article is read again until
 * the photo is `ready` or `failed`.
 *
 * `form` holds `file` and, optionally, `isCover`, `captionAr`, `captionEn`,
 * `captionFr` and `replacesMediaId` (the failed photo this one replaces).
 */
export function uploadNewsMedia(
  tenant: string,
  token: string,
  locale: string,
  articleId: string,
  form: FormData,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<NewsMediaView> {
  const url = `${API_URL}/t/${tenant}${newsArticlePath(articleId)}/media${newsLang(locale)}`;

  const attempt = (bearer: string, exchangesLeft: number): Promise<NewsMediaView> =>
    new Promise<NewsMediaView>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', url);
      request.setRequestHeader('Authorization', `Bearer ${bearer}`);
      request.responseType = 'text';

      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
      };
      request.onerror = () =>
        reject(new ApiRequestError(0, { code: 'NETWORK_ERROR', message: 'تعذّر الاتصال. تحقّق من الشبكة وحاول مرة أخرى.' }));
      request.onabort = () => reject(new DOMException('The upload was cancelled', 'AbortError'));
      request.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(request.responseText);
        } catch {
          body = undefined;
        }

        if (request.status >= 200 && request.status < 300) {
          resolve(body as NewsMediaView);
          return;
        }

        const refusal = (body as ApiError | undefined) ?? UNREADABLE_REFUSAL;
        if (request.status === 401 && exchangesLeft > 0 && !(refusal.code && ANSWERED_401.has(refusal.code))) {
          exchangeStaffToken(tenant, bearer).then(
            (fresh) =>
              fresh && fresh.token !== bearer
                ? resolve(attempt(fresh.token, 0))
                : reject(new ApiRequestError(request.status, refusal)),
            reject,
          );
          return;
        }
        reject(new ApiRequestError(request.status, refusal));
      };

      options.signal?.addEventListener('abort', () => request.abort(), { once: true });
      request.send(form);
    });

  return attempt(token, 1);
}

/** Makes a ready photo the cover of its article. */
export async function setNewsMediaCover(
  tenant: string,
  token: string,
  locale: string,
  articleId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<NewsMediaView> {
  return apiFetch<NewsMediaView>(
    tenant,
    `${newsArticlePath(articleId)}/media/${encodeURIComponent(mediaId)}/cover${newsLang(locale)}`,
    { token, method: 'PUT', signal },
  );
}

/** Removes a photo or PDF from its article. */
export async function deleteNewsMedia(
  tenant: string,
  token: string,
  locale: string,
  articleId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch<void>(
    tenant,
    `${newsArticlePath(articleId)}/media/${encodeURIComponent(mediaId)}${newsLang(locale)}`,
    { token, method: 'DELETE', signal },
  );
}

/**
 * Whether News is on for this municipality (`GET news/availability`): its Day3ati
 * village lists the news module. `NEWS_EDITOR_ROLES` only. What hides the News
 * screens from a municipality that has not got it.
 */
export async function getNewsAvailability(tenant: string, token: string, signal?: AbortSignal): Promise<NewsAvailability> {
  return apiFetch<NewsAvailability>(tenant, '/news/availability', { token, signal });
}
