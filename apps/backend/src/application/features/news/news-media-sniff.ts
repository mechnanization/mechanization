import { NEWS_PDF_MAX_BYTES, NEWS_PHOTO_MAX_BYTES } from '@mechanization/shared-schemas';
import { sniffAttachment } from '../../common/file-sniff';

/**
 * What a file sent for a News article is, read from its first bytes: never from
 * its name or the type the browser declared, which the uploader controls
 * (docs/security.md, uploads).
 *
 * The kinds Day3ati takes for an article: JPEG, PNG, WebP and HEIC photos, and
 * PDFs. The first three and the PDF are read by `sniffAttachment`, the same
 * reader the municipal requests' papers use; HEIC, which phones produce and
 * that reader leaves out, is added here. Anything else, including an empty
 * file, is `null`. The extension is chosen from the sniffed kind, so the file
 * name Day3ati receives is ours and never the one the editor typed.
 */
export interface SniffedNewsMedia {
  kind: 'photo' | 'pdf';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/pdf';
  extension: '.jpg' | '.png' | '.webp' | '.heic' | '.pdf';
  /** The most this kind may weigh. */
  maxBytes: number;
}

/**
 * The ISO base media «brands» a HEIC or HEIF photo carries in its first box
 * (`ftyp`, at byte 4, then the major brand at byte 8). Photos from a phone
 * are `heic`, `heix`, or the multi-image `mif1`; the rest are the sequence and
 * HEVC variants of the same container.
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

export function sniffNewsMedia(bytes: Buffer): SniffedNewsMedia | null {
  const known = sniffAttachment(bytes);
  if (known?.mimeType === 'application/pdf') {
    return { kind: 'pdf', mimeType: known.mimeType, extension: '.pdf', maxBytes: NEWS_PDF_MAX_BYTES };
  }
  if (known) {
    return { kind: 'photo', mimeType: known.mimeType, extension: known.extension as '.jpg' | '.png' | '.webp', maxBytes: NEWS_PHOTO_MAX_BYTES };
  }

  const isIsoBox = bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp';
  if (isIsoBox && HEIC_BRANDS.has(bytes.subarray(8, 12).toString('latin1'))) {
    return { kind: 'photo', mimeType: 'image/heic', extension: '.heic', maxBytes: NEWS_PHOTO_MAX_BYTES };
  }
  return null;
}
