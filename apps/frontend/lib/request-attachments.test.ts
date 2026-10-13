import { describe, expect, it } from 'vitest';
import { REQUEST_ATTACHMENT_MAX_BYTES } from '@mechanization/shared-schemas';
import {
  attachmentProblem,
  isCompressibleImage,
  REQUEST_ATTACHMENT_ACCEPT,
  REQUEST_ATTACHMENT_MAX_MB,
} from './request-attachments';

describe('request attachments, before they are sent', () => {
  it('lets the four kinds through up to the server’s limit', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(attachmentProblem({ type, size: 1024 })).toBeNull();
    }
    expect(attachmentProblem({ type: 'application/pdf', size: REQUEST_ATTACHMENT_MAX_BYTES })).toBeNull();
  });

  it('names why a file would be refused', () => {
    expect(attachmentProblem({ type: 'application/pdf', size: REQUEST_ATTACHMENT_MAX_BYTES + 1 })).toBe('TOO_LARGE');
    expect(attachmentProblem({ type: 'image/heic', size: 1024 })).toBe('UNSUPPORTED');
    expect(attachmentProblem({ type: '', size: 1024 })).toBe('UNSUPPORTED');
    expect(attachmentProblem({ type: 'image/jpeg', size: 0 })).toBe('EMPTY');
  });

  it('shrinks photos, never a PDF', () => {
    expect(isCompressibleImage('image/jpeg')).toBe(true);
    expect(isCompressibleImage('image/webp')).toBe(true);
    expect(isCompressibleImage('application/pdf')).toBe(false);
  });

  it('offers the same list to the dialog, and says the limit in megabytes', () => {
    expect(REQUEST_ATTACHMENT_ACCEPT).toBe('image/jpeg,image/png,image/webp,application/pdf');
    expect(REQUEST_ATTACHMENT_MAX_MB).toBe(5);
  });
});
