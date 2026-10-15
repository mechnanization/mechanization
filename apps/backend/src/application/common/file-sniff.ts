import type { RequestAttachmentMimeType } from '@mechanization/shared-schemas';

/**
 * What a file is, read from its first bytes — never from the name or the type
 * the browser declared, which the uploader controls (docs/security.md: uploads
 * "check the content rather than the client-declared MIME type").
 *
 * Only the four kinds a request's papers may be. Anything else, including an
 * empty file, a HEIC photo or a renamed executable, is `null`, and the caller
 * refuses it. The extension is chosen here too, from the sniffed kind, so an
 * object's key never carries a name the citizen typed.
 */
export interface SniffedFile {
  mimeType: RequestAttachmentMimeType;
  extension: '.jpg' | '.png' | '.webp' | '.pdf';
}

const startsWith = (bytes: Buffer, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // «RIFF»
const WEBP = [0x57, 0x45, 0x42, 0x50]; // «WEBP», at offset 8
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // «%PDF-»

export function sniffAttachment(bytes: Buffer): SniffedFile | null {
  if (startsWith(bytes, JPEG)) return { mimeType: 'image/jpeg', extension: '.jpg' };
  if (startsWith(bytes, PNG)) return { mimeType: 'image/png', extension: '.png' };
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return { mimeType: 'image/webp', extension: '.webp' };
  if (startsWith(bytes, PDF)) return { mimeType: 'application/pdf', extension: '.pdf' };
  return null;
}
