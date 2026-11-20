import { describe, expect, it } from 'vitest';
import type { NewsMediaView } from '@mechanization/shared-schemas';
import { httpsOrigin } from './https-origin';
import {
  anyProcessing,
  formatFileSize,
  inDisplayOrder,
  mayAddFile,
  openableUrl,
  thumbnailSrc,
} from './news-media';

const media = (over: Partial<NewsMediaView> = {}): NewsMediaView => ({
  id: '55555555-5555-4555-8555-555555555555',
  kind: 'image',
  status: 'ready',
  url: 'https://media.example.test/a.jpg',
  thumbnailUrl: 'https://media.example.test/a-t.jpg',
  width: 1200,
  height: 800,
  caption: null,
  isCover: false,
  sortOrder: 0,
  sizeBytes: 523_000,
  failureCode: null,
  ...over,
});

describe('httpsOrigin', () => {
  it('is the origin of an https address, and nothing of its path or query', () => {
    expect(httpsOrigin('https://media.example.test/path/a.jpg?token=abc')).toBe('https://media.example.test');
    expect(httpsOrigin('  https://media.example.test:8443/x ')).toBe('https://media.example.test:8443');
  });

  it('is empty for anything that would loosen a policy: plain http, a bare host, junk, nothing', () => {
    expect(httpsOrigin('http://media.example.test')).toBe('');
    expect(httpsOrigin('media.example.test')).toBe('');
    expect(httpsOrigin('javascript:alert(1)')).toBe('');
    expect(httpsOrigin('')).toBe('');
    expect(httpsOrigin(undefined)).toBe('');
    expect(httpsOrigin(null)).toBe('');
  });
});

describe('thumbnailSrc', () => {
  const allowed = 'https://media.example.test';

  it('is the address when it is on the host the page lets images in from', () => {
    expect(thumbnailSrc('https://media.example.test/a-t.jpg', allowed)).toBe('https://media.example.test/a-t.jpg');
  });

  it('is null for another host, which the policy would block, and for a look-alike', () => {
    expect(thumbnailSrc('https://elsewhere.example.test/a.jpg', allowed)).toBeNull();
    expect(thumbnailSrc('https://media.example.test.evil.test/a.jpg', allowed)).toBeNull();
    expect(thumbnailSrc('http://media.example.test/a.jpg', allowed)).toBeNull();
  });

  it('is null when no host is named, so no picture is drawn that the policy would refuse', () => {
    expect(thumbnailSrc('https://media.example.test/a.jpg', '')).toBeNull();
  });

  it('is null for no address and for one that is not an address', () => {
    expect(thumbnailSrc(null, allowed)).toBeNull();
    expect(thumbnailSrc('not a url', allowed)).toBeNull();
  });
});

describe('openableUrl', () => {
  it('opens an https address and nothing else', () => {
    expect(openableUrl('https://media.example.test/a.pdf')).toBe('https://media.example.test/a.pdf');
    expect(openableUrl('http://media.example.test/a.pdf')).toBeNull();
    expect(openableUrl('javascript:alert(1)')).toBeNull();
    expect(openableUrl(null)).toBeNull();
  });
});

describe('the article files', () => {
  it('says when a photo is still being prepared, so the article is read again', () => {
    expect(anyProcessing([media(), media({ status: 'processing' })])).toBe(true);
    expect(anyProcessing([media(), media({ status: 'failed' })])).toBe(false);
    expect(anyProcessing([])).toBe(false);
  });

  it('shows the files in their order', () => {
    const first = media({ id: 'a', sortOrder: 0 });
    const second = media({ id: 'b', sortOrder: 1 });
    expect(inDisplayOrder([second, first]).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('allows twenty files and no more', () => {
    const files = (count: number) => Array.from({ length: count }, (_, i) => media({ id: String(i) }));
    expect(mayAddFile(files(19))).toBe(true);
    expect(mayAddFile(files(20))).toBe(false);
  });

  it('writes a size in Latin digits', () => {
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(523_000)).toBe('511 KB');
    expect(formatFileSize(8_400_000)).toBe('8.0 MB');
  });
});
