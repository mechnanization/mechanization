import { z } from 'zod';
import type { NewsLocalizedName } from './news.schema';
import { uuid } from './primitives';

/**
 * The photos and PDFs of a News article on Day3ati: what may be uploaded, and
 * what an uploaded file looks like to a screen. Day3ati keeps and processes the
 * files (a photo is re-encoded in the background); these are the shapes and
 * limits that cross our API.
 *
 * The limits are the task's («photos 10 MB: JPEG, PNG, WebP, HEIC; PDFs 15 MB;
 * 20 files per article»). They are counted in binary megabytes, the more
 * generous reading, so a file Day3ati would take is never refused here first;
 * Day3ati's own refusal is the authority and reaches the screen the same way.
 */

export const NEWS_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const NEWS_PDF_MAX_BYTES = 15 * 1024 * 1024;
export const NEWS_MEDIA_MAX_PER_ARTICLE = 20;
/** A caption's longest, per language: ours. */
export const NEWS_CAPTION_MAX = 200;

/** What the file dialog offers. The server checks the bytes regardless. */
export const NEWS_MEDIA_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf';

const PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const PHOTO_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

export const NEWS_MEDIA_KIND = ['image', 'pdf', 'audio'] as const;
export type NewsMediaKind = (typeof NEWS_MEDIA_KIND)[number];

/** A photo is `processing` for a moment after it is sent, then `ready`, or `failed` after two retries. */
export const NEWS_MEDIA_STATUS = ['processing', 'ready', 'failed'] as const;
export type NewsMediaStatus = (typeof NEWS_MEDIA_STATUS)[number];

/** Why a file the browser holds cannot be sent: not a kind Day3ati takes, or over its size. */
export type NewsFileProblem = 'unsupported' | 'tooLarge';

/**
 * What can be told about a file before it is sent, from what the browser knows
 * (its name, the type it declares and its size). A first check, to spare the
 * upload: the server reads the bytes and decides again, and a file with no
 * declared type (HEIC often has none) is judged by its extension.
 */
export function newsFileProblem(file: { name: string; type: string; size: number }): NewsFileProblem | null {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  const isPdf = file.type === 'application/pdf' || extension === 'pdf';
  const isPhoto = PHOTO_TYPES.includes(file.type) || PHOTO_EXTENSIONS.includes(extension);
  if ((!isPdf && !isPhoto) || file.size <= 0) return 'unsupported';
  return file.size > (isPdf ? NEWS_PDF_MAX_BYTES : NEWS_PHOTO_MAX_BYTES) ? 'tooLarge' : null;
}

const caption = z
  .string()
  .trim()
  .max(NEWS_CAPTION_MAX, 'الوصف طويل جداً')
  .optional()
  .transform((value) => (value ? value : null));

/**
 * The text fields sent with a file. They arrive as the strings a multipart form
 * carries, so the switch is the word `true` and an absent id is empty.
 */
export const uploadNewsMediaSchema = z.object({
  isCover: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  captionAr: caption,
  captionEn: caption,
  captionFr: caption,
  /** The failed photo this one replaces, when it is an «upload again». */
  replacesMediaId: z
    .union([uuid, z.literal('')])
    .optional()
    .transform((value) => value || null),
});
export type UploadNewsMediaInput = z.infer<typeof uploadNewsMediaSchema>;

/** One photo or PDF of an article, as a screen reads it. */
export interface NewsMediaView {
  id: string;
  kind: NewsMediaKind;
  status: NewsMediaStatus;
  /** Where the file is. Day3ati's address; never logged. */
  url: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  caption: NewsLocalizedName | null;
  isCover: boolean;
  sortOrder: number;
  sizeBytes: number;
  /** Why a photo failed, in Day3ati's own code. */
  failureCode: string | null;
}
