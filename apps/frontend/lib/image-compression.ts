import { isCompressibleImage } from './request-attachments';

/**
 * A photographed paper, shrunk in the browser before it is sent.
 *
 * A phone photographs an identity card at 4000 pixels and four or five
 * megabytes: over a mobile connection in the south that is a minute's upload,
 * and close to the server's 5 MB limit. Two thousand pixels on the long edge
 * still reads a stamp and a signature. Only photos are touched — a PDF goes as
 * it is, and so does a photo already small enough.
 *
 * Best effort, never a gate: a browser that cannot decode the photo, or a
 * result no smaller than the original, sends the original, and the server's
 * own checks (`sniffAttachment`, the size cap) still decide.
 */

/** The longest edge a photographed paper keeps. */
export const PAPER_MAX_EDGE = 2000;

/** Below this a photo is sent as it was taken: shrinking it saves nothing worth the quality. */
export const COMPRESS_ABOVE_BYTES = 1_000_000;

/** JPEG quality for the shrunk copy: text stays sharp, the file drops to a few hundred kilobytes. */
const JPEG_QUALITY = 0.85;

/** The size that fits `maxEdge` on the longer side, the proportions kept; never enlarged. */
export function fitWithin(width: number, height: number, maxEdge: number = PAPER_MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether a picked file is a photo worth shrinking. */
export function shouldCompress(file: { type: string; size: number }): boolean {
  return isCompressibleImage(file.type) && file.size > COMPRESS_ABOVE_BYTES;
}

/** «scan.png» → «scan.jpg»: the copy is a JPEG whatever the photo was. */
export function jpegName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/, '');
  return `${stem || 'paper'}.jpg`;
}

/** The photo, shrunk to `PAPER_MAX_EDGE` as a JPEG, or the file itself when that would not help. */
export async function compressPaper(file: File): Promise<File> {
  if (!shouldCompress(file) || typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return file;
  }
  try {
    // `from-image` turns a phone photo the right way up, as its EXIF says.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return file;
    }
    // A PNG's transparent background would come out black in a JPEG.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
