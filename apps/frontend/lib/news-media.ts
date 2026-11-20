import { NEWS_MEDIA_MAX_PER_ARTICLE, type NewsMediaView } from '@mechanization/shared-schemas';
import { httpsOrigin } from './https-origin';

/**
 * The origin of Day3ati's media host, named by `NEXT_PUBLIC_DAY3ATI_MEDIA_ORIGIN`
 * and let through the page's `img-src` by the middleware. Unset, no thumbnail
 * is drawn: the Content-Security-Policy names every host an image may come from
 * and does not guess one. Inlined at build time like every `NEXT_PUBLIC_*`.
 */
export const DAY3ATI_MEDIA_ORIGIN = httpsOrigin(process.env.NEXT_PUBLIC_DAY3ATI_MEDIA_ORIGIN);

/**
 * The address to draw a thumbnail from: Day3ati's own, and only when it is on
 * the origin the page's policy lets images in from. Otherwise `null`, and the
 * screen draws an icon in its place rather than a broken picture.
 */
export function thumbnailSrc(url: string | null, allowedOrigin: string = DAY3ATI_MEDIA_ORIGIN): string | null {
  if (!url || !allowedOrigin) return null;
  try {
    return new URL(url).origin === allowedOrigin ? url : null;
  } catch {
    return null;
  }
}

/**
 * The address to open a file at, in a new tab: Day3ati's own, and https. A
 * navigation is not an image load, so the policy does not apply, but a link is
 * only offered for an address that is one we would send a person to.
 */
export function openableUrl(url: string | null): string | null {
  return httpsOrigin(url) === '' ? null : url;
}

/** Whether any photo is still being prepared by Day3ati, so the article should be read again soon. */
export function anyProcessing(media: readonly NewsMediaView[]): boolean {
  return media.some((item) => item.status === 'processing');
}

/** The files in the order the article shows them. */
export function inDisplayOrder(media: readonly NewsMediaView[]): NewsMediaView[] {
  return [...media].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** Whether another file may be added: an article holds twenty at most. */
export function mayAddFile(media: readonly NewsMediaView[]): boolean {
  return media.length < NEWS_MEDIA_MAX_PER_ARTICLE;
}

/** `523,000` bytes as `511 KB`, `8,400,000` as `8.0 MB`: Latin digits, one decimal from a megabyte. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
