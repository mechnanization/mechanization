import {
  NEWS_ARTICLE_STATUS,
  NEWS_LANGUAGE,
  NEWS_MEDIA_KIND,
  NEWS_MEDIA_STATUS,
  NEWS_PUBLISHER_KIND,
  type NewsArticleListItem,
  type NewsArticlePage,
  type NewsArticleStatus,
  type NewsArticleTextView,
  type NewsArticleView,
  type NewsCategoryView,
  type NewsLanguage,
  type NewsLocalizedName,
  type NewsMediaView,
  type NewsPublisherKind,
  type NewsPublisherView,
} from '@mechanization/shared-schemas';

/**
 * Day3ati's answers, read into the views our screens take.
 *
 * Only the fields a screen uses are picked, so a field Day3ati adds later (a
 * publisher's `avatarUrl`, a signed link) never reaches a browser by accident.
 * An answer that is not what the contract says is `null`, and the caller turns
 * that into «News is unavailable»: a half-read list shown as the whole one is
 * worse than an error.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function localizedName(value: unknown): NewsLocalizedName | null {
  if (!isObject(value) || typeof value.ar !== 'string') return null;
  return {
    ar: value.ar,
    en: typeof value.en === 'string' ? value.en : null,
    fr: typeof value.fr === 'string' ? value.fr : null,
  };
}

/** Day3ati's int32 arrives as a number, or as a digit string (its schema allows both). */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

export function toCategoryView(raw: unknown): NewsCategoryView | null {
  if (!isObject(raw)) return null;
  const name = localizedName(raw.name);
  const sortOrder = wholeNumber(raw.sortOrder);
  if (
    typeof raw.id !== 'string' ||
    typeof raw.key !== 'string' ||
    !name ||
    sortOrder === null ||
    typeof raw.isActive !== 'boolean'
  ) {
    return null;
  }
  return {
    id: raw.id,
    key: raw.key,
    name,
    icon: typeof raw.icon === 'string' ? raw.icon : null,
    sortOrder,
    isActive: raw.isActive,
  };
}

export function toPublisherView(raw: unknown): NewsPublisherView | null {
  if (!isObject(raw)) return null;
  const name = localizedName(raw.name);
  if (
    typeof raw.id !== 'string' ||
    !name ||
    typeof raw.isActive !== 'boolean' ||
    !(NEWS_PUBLISHER_KIND as readonly unknown[]).includes(raw.kind)
  ) {
    return null;
  }
  return { id: raw.id, name, kind: raw.kind as NewsPublisherKind, isActive: raw.isActive };
}

/** Every item read, or `null` when the answer is not a list or any item is not what the contract says. */
export function readAll<T>(raw: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const items: T[] = [];
  for (const entry of raw) {
    const item = read(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

const isStatus = (value: unknown): value is NewsArticleStatus =>
  (NEWS_ARTICLE_STATUS as readonly unknown[]).includes(value);
const isLanguage = (value: unknown): value is NewsLanguage => (NEWS_LANGUAGE as readonly unknown[]).includes(value);

/** A date-time as Day3ati sends one, or `null` for none; `undefined` when it is neither (an unreadable answer). */
function instant(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function toArticleListItem(raw: unknown): NewsArticleListItem | null {
  if (!isObject(raw)) return null;
  const publishAt = instant(raw.publishAt);
  const publishedAt = instant(raw.publishedAt);
  const updatedAt = instant(raw.updatedAt);
  if (
    typeof raw.id !== 'string' ||
    !isStatus(raw.status) ||
    typeof raw.title !== 'string' ||
    typeof raw.categoryId !== 'string' ||
    publishAt === undefined ||
    publishedAt === undefined ||
    typeof updatedAt !== 'string' ||
    typeof raw.isPinned !== 'boolean' ||
    typeof raw.isFeatured !== 'boolean'
  ) {
    return null;
  }
  return {
    id: raw.id,
    status: raw.status,
    title: raw.title,
    categoryId: raw.categoryId,
    publishAt,
    publishedAt,
    isPinned: raw.isPinned,
    isFeatured: raw.isFeatured,
    updatedAt,
  };
}

/** One page of the article list: its items, and the cursor of the next page when there is one. */
export function toArticlePage(raw: unknown): NewsArticlePage | null {
  if (!isObject(raw)) return null;
  const items = readAll(raw.items, toArticleListItem);
  if (!items) return null;
  // Day3ati's page says there is no next one by `nextCursor: null` (or by leaving it out).
  if (raw.nextCursor !== undefined && raw.nextCursor !== null && typeof raw.nextCursor !== 'string') return null;
  return { items, nextCursor: typeof raw.nextCursor === 'string' && raw.nextCursor !== '' ? raw.nextCursor : null };
}

function toArticleText(raw: unknown): NewsArticleTextView | null {
  if (!isObject(raw) || !isLanguage(raw.language) || typeof raw.title !== 'string' || typeof raw.body !== 'string') {
    return null;
  }
  return {
    language: raw.language,
    title: raw.title,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    body: raw.body,
  };
}

/**
 * One article in full. The author (a Day3ati user id of theirs, not ours) is
 * left out. A photo or file that cannot be read makes the whole article
 * unreadable: a list of files shown short is a file the editor thinks is gone.
 */
export function toArticleView(raw: unknown): NewsArticleView | null {
  if (!isObject(raw)) return null;
  const texts = readAll(raw.texts, toArticleText);
  const media = readAll(raw.media, toMediaView);
  const placeLabel = raw.placeLabel === null || raw.placeLabel === undefined ? null : localizedName(raw.placeLabel);
  const publishAt = instant(raw.publishAt);
  const publishedAt = instant(raw.publishedAt);
  const featuredUntil = instant(raw.featuredUntil);
  const createdAt = instant(raw.createdAt);
  const updatedAt = instant(raw.updatedAt);
  const readingMinutes = wholeNumber(raw.readingMinutes);
  const viewCount = wholeNumber(raw.viewCount);
  const bookmarkCount = wholeNumber(raw.bookmarkCount);
  if (
    typeof raw.id !== 'string' ||
    !isStatus(raw.status) ||
    typeof raw.categoryId !== 'string' ||
    typeof raw.publisherId !== 'string' ||
    !isLanguage(raw.defaultLanguage) ||
    !texts ||
    !media ||
    (raw.placeLabel !== null && raw.placeLabel !== undefined && placeLabel === null) ||
    (raw.areaId !== null && raw.areaId !== undefined && typeof raw.areaId !== 'string') ||
    typeof raw.notifyResidents !== 'boolean' ||
    typeof raw.isPinned !== 'boolean' ||
    publishAt === undefined ||
    publishedAt === undefined ||
    featuredUntil === undefined ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    readingMinutes === null ||
    viewCount === null ||
    bookmarkCount === null
  ) {
    return null;
  }
  return {
    id: raw.id,
    status: raw.status,
    categoryId: raw.categoryId,
    publisherId: raw.publisherId,
    defaultLanguage: raw.defaultLanguage,
    texts,
    media,
    placeLabel,
    areaId: typeof raw.areaId === 'string' ? raw.areaId : null,
    notifyResidents: raw.notifyResidents,
    publishAt,
    publishedAt,
    isPinned: raw.isPinned,
    featuredUntil,
    readingMinutes,
    viewCount,
    bookmarkCount,
    createdAt,
    updatedAt,
  };
}

/**
 * One photo or PDF of an article. The address and the thumbnail are Day3ati's
 * and are passed on as sent (an editor opens them); the blurhash, a placeholder
 * for a decoder this portal does not have, is left out.
 */
export function toMediaView(raw: unknown): NewsMediaView | null {
  if (!isObject(raw)) return null;
  const caption = raw.caption === null || raw.caption === undefined ? null : localizedName(raw.caption);
  const sortOrder = wholeNumber(raw.sortOrder);
  const sizeBytes = wholeNumber(raw.sizeBytes);
  const dimension = (value: unknown): number | null | undefined =>
    value === null || value === undefined ? null : (wholeNumber(value) ?? undefined);
  const width = dimension(raw.width);
  const height = dimension(raw.height);
  if (
    typeof raw.id !== 'string' ||
    !(NEWS_MEDIA_KIND as readonly unknown[]).includes(raw.kind) ||
    !(NEWS_MEDIA_STATUS as readonly unknown[]).includes(raw.status) ||
    (raw.caption !== null && raw.caption !== undefined && caption === null) ||
    typeof raw.isCover !== 'boolean' ||
    sortOrder === null ||
    sizeBytes === null ||
    width === undefined ||
    height === undefined
  ) {
    return null;
  }
  return {
    id: raw.id,
    kind: raw.kind as NewsMediaView['kind'],
    status: raw.status as NewsMediaView['status'],
    url: typeof raw.url === 'string' ? raw.url : null,
    thumbnailUrl: typeof raw.thumbnailUrl === 'string' ? raw.thumbnailUrl : null,
    width,
    height,
    caption,
    isCover: raw.isCover,
    sortOrder,
    sizeBytes,
    failureCode: typeof raw.failureCode === 'string' ? raw.failureCode : null,
  };
}
