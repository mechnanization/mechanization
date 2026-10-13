import { sniffAttachment } from './file-sniff';

const bytes = (...values: number[]) => Buffer.from(values);
const text = (value: string) => Buffer.from(value, 'latin1');

describe('sniffAttachment', () => {
  it('reads the four kinds a paper may be from their first bytes', () => {
    expect(sniffAttachment(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00))).toEqual({ mimeType: 'image/jpeg', extension: '.jpg' });
    expect(sniffAttachment(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toEqual({
      mimeType: 'image/png',
      extension: '.png',
    });
    expect(sniffAttachment(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toEqual({ mimeType: 'image/webp', extension: '.webp' });
    expect(sniffAttachment(text('%PDF-1.7\n'))).toEqual({ mimeType: 'application/pdf', extension: '.pdf' });
  });

  it('refuses what the name or the declared type would have let through', () => {
    // An executable renamed «هوية.jpg», a script, a RIFF that is not WebP (a WAV), HEIC, and nothing at all.
    expect(sniffAttachment(text('MZ\u0090\u0000'))).toBeNull();
    expect(sniffAttachment(text('<script>alert(1)</script>'))).toBeNull();
    expect(sniffAttachment(text('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(sniffAttachment(text('\u0000\u0000\u0000\u0018ftypheic'))).toBeNull();
    expect(sniffAttachment(Buffer.alloc(0))).toBeNull();
  });

  it('refuses a file cut shorter than its signature', () => {
    expect(sniffAttachment(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffAttachment(text('RIFF\u0000\u0000\u0000\u0000WEB'))).toBeNull();
    expect(sniffAttachment(text('%PDF'))).toBeNull();
  });
});
