import { describe, expect, it } from 'vitest';
import { COMPRESS_ABOVE_BYTES, compressPaper, fitWithin, jpegName, PAPER_MAX_EDGE, shouldCompress } from './image-compression';

describe('a photographed paper, before it is sent', () => {
  it('scales the longer edge down to the limit and keeps the proportions', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: PAPER_MAX_EDGE, height: 1500 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1500, height: PAPER_MAX_EDGE });
  });

  it('never enlarges a photo that already fits', () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900 });
    expect(fitWithin(PAPER_MAX_EDGE, 10)).toEqual({ width: PAPER_MAX_EDGE, height: 10 });
  });

  it('keeps a sliver at least one pixel wide', () => {
    expect(fitWithin(40_000, 1)).toEqual({ width: PAPER_MAX_EDGE, height: 1 });
  });

  it('shrinks large photos only — never a PDF, never a small photo', () => {
    expect(shouldCompress({ type: 'image/jpeg', size: COMPRESS_ABOVE_BYTES + 1 })).toBe(true);
    expect(shouldCompress({ type: 'image/png', size: COMPRESS_ABOVE_BYTES + 1 })).toBe(true);
    expect(shouldCompress({ type: 'image/jpeg', size: COMPRESS_ABOVE_BYTES })).toBe(false);
    expect(shouldCompress({ type: 'application/pdf', size: COMPRESS_ABOVE_BYTES * 4 })).toBe(false);
  });

  it('names the copy as the JPEG it is', () => {
    expect(jpegName('هوية.png')).toBe('هوية.jpg');
    expect(jpegName('IMG_2041.HEIC.jpeg')).toBe('IMG_2041.HEIC.jpg');
    expect(jpegName('noextension')).toBe('noextension.jpg');
    expect(jpegName('.png')).toBe('paper.jpg');
  });

  it('sends the original where the browser cannot decode it', async () => {
    // The test runs in node: no `createImageBitmap`, no `document`.
    const file = new File([new Uint8Array(COMPRESS_ABOVE_BYTES + 10)], 'big.jpg', { type: 'image/jpeg' });
    await expect(compressPaper(file)).resolves.toBe(file);
  });
});
