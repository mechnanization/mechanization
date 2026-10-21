import {
  REQUEST_ATTACHMENT_MAX_BYTES,
  REQUEST_ATTACHMENT_MIME_TYPES,
  type RequestAttachmentMimeType,
} from '@mechanization/shared-schemas';

/**
 * The papers on a municipal request, before they leave the browser: the same
 * limits the server holds (`REQUEST_ATTACHMENT_MAX_BYTES`, the four types),
 * read from the shared package so the two never disagree. The server still
 * sniffs every file's bytes and caps its size: this only spares a citizen on a
 * phone an upload that would be refused.
 */

/** For `<input accept>`: the browser's dialog offers these first. */
export const REQUEST_ATTACHMENT_ACCEPT = REQUEST_ATTACHMENT_MIME_TYPES.join(',');

export type AttachmentProblem = 'TOO_LARGE' | 'UNSUPPORTED' | 'EMPTY';

/** Why a file would be refused, judged on its declared type and size; null when it may be sent. */
export function attachmentProblem(file: { type: string; size: number }): AttachmentProblem | null {
  if (file.size === 0) return 'EMPTY';
  if (!(REQUEST_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) return 'UNSUPPORTED';
  if (file.size > REQUEST_ATTACHMENT_MAX_BYTES) return 'TOO_LARGE';
  return null;
}

/** A photo that may be shrunk before it is sent; a PDF goes as it is. */
export function isCompressibleImage(type: string): type is Exclude<RequestAttachmentMimeType, 'application/pdf'> {
  return type === 'image/jpeg' || type === 'image/png' || type === 'image/webp';
}

/** The limit in whole megabytes, for the hint under a picker. */
export const REQUEST_ATTACHMENT_MAX_MB = Math.floor(REQUEST_ATTACHMENT_MAX_BYTES / (1024 * 1024));
